from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from pathlib import Path
import re
import uuid
from typing import Any

from pydantic import BaseModel, Field

from .artifacts import write_json
from .exceptions import (
    SkillDAGCompilationError,
    SkillDAGExecutionError,
)
from .models import (
    ComponentKind,
    ContractBindingSource,
    ExecutionContext,
    SkillDAGEdge,
    SkillDAGNode,
    SkillDAGPlan,
    SkillDAGValidationReport,
    SkillInputBinding,
    SkillResult,
    ValidationIssue,
)
from .registry import SkillRegistry
from .contracts import contract_compatible, check_contract_value


class SkillDAGExecution(BaseModel):
    plan: SkillDAGPlan
    execution_order: list[str]
    node_results: dict[str, SkillResult]
    output_slots: dict[str, dict[str, Any]] = Field(default_factory=dict)


def _topological_order(
    selected: set[str],
    dependencies: dict[str, set[str]],
    priority: dict[str, int],
) -> list[str]:
    remaining = {node: set(dependencies.get(node, set())) for node in selected}
    order: list[str] = []
    while remaining:
        ready = sorted(
            (node for node, deps in remaining.items() if not deps),
            key=lambda item: (priority.get(item, 10**9), item),
        )
        if not ready:
            return []
        for node in ready:
            order.append(node)
            remaining.pop(node)
        for deps in remaining.values():
            deps.difference_update(ready)
    return order


def _report_flags(issues: list[ValidationIssue]) -> SkillDAGValidationReport:
    codes = {item.code for item in issues if item.severity == "error"}
    return SkillDAGValidationReport(
        valid=not codes,
        registered_ok=not any(code.startswith("registration_") for code in codes),
        type_ok=not any(code.startswith("contract_type_") for code in codes),
        schema_ok=not any(code.startswith("schema_") for code in codes),
        dependency_ok=not any(code.startswith("dependency_") for code in codes),
        dag_ok=not any(code.startswith("dag_") for code in codes),
        binding_ok=not any(code.startswith("binding_") for code in codes),
        issues=issues,
    )


class SkillDAGCompiler:
    """Compile registered components into a contract-checked deterministic DAG."""

    def __init__(self, registry: SkillRegistry) -> None:
        self.registry = registry

    def try_compile(
        self,
        template_id: str | None,
        *,
        target_component_ids: list[str] | None = None,
        assessment_mode: str | None = None,
        root_input_fields: set[str] | None = None,
        component_versions: dict[str, str] | None = None,
    ) -> tuple[SkillDAGPlan | None, SkillDAGValidationReport]:
        root_fields = set(root_input_fields or set())
        catalog = {item.id: item for item in self.registry.latest_components()}
        for key, version in (component_versions or {}).items():
            catalog[key] = self.registry.describe(key, version)
        issues: list[ValidationIssue] = []
        template = catalog.get(template_id) if template_id is not None else None
        if template_id is not None and template is None:
            issues.append(
                ValidationIssue(
                    code="registration_template_missing",
                    field="template_id",
                    message=f"Workflow template is not registered: {template_id}",
                )
            )
            return None, _report_flags(issues)

        if template is None:
            allowed = {
                component_id
                for component_id, manifest in catalog.items()
                if manifest.kind != ComponentKind.WORKFLOW
            }
            requested = [item for item in (target_component_ids or []) if item]
        elif template.kind == ComponentKind.WORKFLOW:
            allowed = set(template.dependencies)
            requested = [
                item
                for item in (target_component_ids or [])
                if item and item != template_id
            ]
            if not requested:
                requested = list(template.default_targets)
            if not requested:
                depended_on = {
                    dependency
                    for component_id in allowed
                    if component_id in catalog
                    for dependency in catalog[component_id].dependencies
                    if dependency in allowed
                }
                requested = sorted(allowed - depended_on)
        else:
            allowed = {template_id}
            requested = [template_id]

        targets: list[str] = []
        for component_id in requested:
            if component_id not in catalog:
                issues.append(
                    ValidationIssue(
                        code="registration_target_missing",
                        field="target_component_ids",
                        message=f"Target component is not registered: {component_id}",
                    )
                )
                continue
            if component_id not in allowed:
                issues.append(
                    ValidationIssue(
                        code="dependency_target_outside_template",
                        field="target_component_ids",
                        message=(
                            f"{component_id} is not declared by workflow template "
                            f"{template_id}"
                        ),
                    )
                )
                continue
            if component_id not in targets:
                targets.append(component_id)

        if not targets:
            issues.append(
                ValidationIssue(
                    code="dependency_target_missing",
                    field="target_component_ids",
                    message="No executable target component remains after registry checks",
                )
            )
            return None, _report_flags(issues)

        selected: set[str] = set()
        visiting: list[str] = []
        declared_dependencies: dict[str, set[str]] = defaultdict(set)

        def include(component_id: str) -> None:
            if component_id in visiting:
                cycle = " -> ".join([*visiting, component_id])
                issues.append(
                    ValidationIssue(
                        code="dag_cycle",
                        field="dependencies",
                        message=f"Declared dependency cycle detected: {cycle}",
                    )
                )
                return
            if component_id in selected:
                return
            manifest = catalog.get(component_id)
            if manifest is None:
                issues.append(
                    ValidationIssue(
                        code="registration_dependency_missing",
                        field="dependencies",
                        message=f"Dependency is not registered: {component_id}",
                    )
                )
                return
            if (
                template is not None
                and template.kind == ComponentKind.WORKFLOW
                and component_id not in allowed
            ):
                issues.append(
                    ValidationIssue(
                        code="dependency_outside_template",
                        field="dependencies",
                        message=(
                            f"{component_id} is required by the selected plan but is not "
                            f"declared by workflow template {template_id}"
                        ),
                    )
                )
                return
            visiting.append(component_id)
            for dependency in manifest.dependencies:
                declared_dependencies[component_id].add(dependency)
                include(dependency)
            visiting.pop()
            selected.add(component_id)

        for target in targets:
            include(target)

        for component_id in selected:
            manifest = catalog[component_id]
            if manifest.skill_type_id:
                definition = self.registry.describe_type(manifest.skill_type_id, manifest.skill_type_version)
                dependencies = {catalog[d].skill_type_id for d in manifest.dependencies if d in catalog}
                for required_type in definition.dependency_type_ids:
                    if required_type not in dependencies:
                        issues.append(ValidationIssue(code='dependency_template_missing', field=component_id,
                            message=f'Template requires dependency type {required_type}'))

        if assessment_mode is not None:
            for component_id in selected:
                supported = {
                    mode.value for mode in catalog[component_id].assessment_modes
                }
                if assessment_mode not in supported:
                    issues.append(
                        ValidationIssue(
                            code="dependency_assessment_mode",
                            field=component_id,
                            message=(
                                f"{component_id} does not support assessment mode "
                                f"{assessment_mode}"
                            ),
                        )
                    )

        priority_ids = (
            [
                manifest.id
                for manifest in self.registry.list_components()
                if manifest.kind != ComponentKind.WORKFLOW
            ]
            if template is None
            else (
                template.dependencies
                if template.kind == ComponentKind.WORKFLOW
                else [template_id]
            )
        )
        priority = {
            component_id: index for index, component_id in enumerate(priority_ids)
        }
        order = _topological_order(selected, declared_dependencies, priority)
        if selected and not order:
            issues.append(
                ValidationIssue(
                    code="dag_cycle",
                    field="dependencies",
                    message="Selected components cannot be topologically ordered",
                )
            )
            return None, _report_flags(issues)

        produced: dict[str, list[tuple[str, Any]]] = defaultdict(list)
        nodes: list[SkillDAGNode] = []
        edges: list[SkillDAGEdge] = []
        edge_keys: set[tuple[str, str, str, str | None]] = set()

        def add_edge(edge: SkillDAGEdge) -> None:
            key = (edge.source, edge.target, edge.relation, edge.contract_name)
            if key not in edge_keys:
                edge_keys.add(key)
                edges.append(edge)

        for component_id in order:
            manifest = catalog[component_id]
            schema = self.registry.input_schema(component_id, manifest.version)
            properties = schema.get("properties", {})
            required_fields = set(schema.get("required", []))
            bindings: list[SkillInputBinding] = []
            node_dependencies = {
                item
                for item in declared_dependencies.get(component_id, set())
                if item in selected
            }
            for dependency in sorted(node_dependencies, key=lambda item: order.index(item)):
                add_edge(
                    SkillDAGEdge(
                        source=dependency,
                        target=component_id,
                        relation="declared_dependency",
                    )
                )

            for contract in manifest.consumes:
                if contract.name not in properties:
                    issues.append(
                        ValidationIssue(
                            code="schema_contract_field_missing",
                            field=f"{component_id}.{contract.name}",
                            message=(
                                f"Input contract {contract.name} is not declared by the "
                                f"Pydantic input schema of {component_id}"
                            ),
                        )
                    )
                    continue
                candidates = produced.get(contract.name, [])
                compatible = [
                    item for item in candidates if contract_compatible(item[1], contract)
                ]
                direct = [
                    item for item in compatible if item[0] in node_dependencies
                ]
                chosen: tuple[str, Any] | None = None
                if len(direct) == 1:
                    chosen = direct[0]
                elif len(direct) > 1:
                    issues.append(
                        ValidationIssue(
                            code="binding_ambiguous",
                            field=f"{component_id}.{contract.name}",
                            message=(
                                f"Multiple direct dependencies produce {contract.name}: "
                                f"{[item[0] for item in direct]}"
                            ),
                        )
                    )
                elif len(compatible) == 1:
                    chosen = compatible[0]
                elif len(compatible) > 1:
                    issues.append(
                        ValidationIssue(
                            code="binding_ambiguous",
                            field=f"{component_id}.{contract.name}",
                            message=(
                                f"Multiple upstream components produce {contract.name}: "
                                f"{[item[0] for item in compatible]}"
                            ),
                        )
                    )
                elif candidates:
                    issues.append(
                        ValidationIssue(
                            code="contract_type_mismatch",
                            field=f"{component_id}.{contract.name}",
                            message=(
                                f"{component_id} consumes {contract.name} as "
                                f"{contract.type_id}, but available producers provide "
                                f"{sorted({item[1].type_id for item in candidates})}"
                            ),
                        )
                    )
                elif contract.name in root_fields:
                    bindings.append(
                        SkillInputBinding(
                            target_field=contract.name,
                            type_id=contract.type_id,
                            source=ContractBindingSource.REQUEST,
                            source_field=contract.name,
                            excludes=contract.excludes,
                        )
                    )
                elif contract.required:
                    issues.append(
                        ValidationIssue(
                            code="binding_input_missing",
                            field=f"{component_id}.{contract.name}",
                            message=(
                                f"No request field or upstream output supplies required "
                                f"contract {contract.name} ({contract.type_id})"
                            ),
                        )
                    )

                if chosen is not None:
                    source_id, output_contract = chosen
                    bindings.append(
                        SkillInputBinding(
                            target_field=contract.name,
                            type_id=contract.type_id,
                            source=ContractBindingSource.NODE,
                            source_field=output_contract.name,
                            source_node_id=source_id,
                            excludes=contract.excludes,
                        )
                    )
                    node_dependencies.add(source_id)
                    add_edge(
                        SkillDAGEdge(
                            source=source_id,
                            target=component_id,
                            relation="data_contract",
                            contract_name=contract.name,
                            type_id=contract.type_id,
                        )
                    )

            bound_fields = {item.target_field for item in bindings}
            for field in sorted(required_fields):
                if field not in bound_fields and field not in root_fields:
                    issues.append(
                        ValidationIssue(
                            code="schema_required_input_missing",
                            field=f"{component_id}.{field}",
                            message=(
                                f"Required Pydantic field {field} is not available from "
                                "the request or an upstream data contract"
                            ),
                        )
                    )

            nodes.append(
                SkillDAGNode(
                    node_id=component_id,
                    component_id=component_id,
                    component_kind=manifest.kind,
                    stage=manifest.stage,
                    depends_on=sorted(
                        node_dependencies,
                        key=lambda item: order.index(item),
                    ),
                    input_bindings=bindings,
                    produces=manifest.produces,
                    implementation_version=manifest.version,
                    skill_type_version=manifest.skill_type_version,
                    contract_version=manifest.contract_version,
                    registration_hash=self.registry._get(component_id, manifest.version).registration_hash(),
                )
            )
            for contract in manifest.produces:
                produced[contract.name].append((component_id, contract))

        report = _report_flags(issues)
        if not report.valid:
            return None, report
        plan = SkillDAGPlan(
            composition_source=(
                "skill_registry" if template is None else "workflow_template"
            ),
            template_id=template_id,
            assessment_mode=assessment_mode,
            target_component_ids=targets,
            execution_order=order,
            nodes=nodes,
            edges=edges,
        )
        return plan, report

    def compile(
        self,
        template_id: str | None,
        *,
        target_component_ids: list[str] | None = None,
        assessment_mode: str | None = None,
        root_input_fields: set[str] | None = None,
        component_versions: dict[str, str] | None = None,
    ) -> SkillDAGPlan:
        plan, report = self.try_compile(
            template_id,
            target_component_ids=target_component_ids,
            assessment_mode=assessment_mode,
            root_input_fields=root_input_fields,
            component_versions=component_versions,
        )
        if plan is None or not report.valid:
            raise SkillDAGCompilationError(report)
        return plan

    def try_compile_targets(
        self,
        target_component_ids: list[str],
        *,
        assessment_mode: str | None = None,
        root_input_fields: set[str] | None = None,
    ) -> tuple[SkillDAGPlan | None, SkillDAGValidationReport]:
        """Compile targets directly from the global Registry without a workflow template."""

        return self.try_compile(
            None,
            target_component_ids=target_component_ids,
            assessment_mode=assessment_mode,
            root_input_fields=root_input_fields,
        )

    def compile_targets(
        self,
        target_component_ids: list[str],
        *,
        assessment_mode: str | None = None,
        root_input_fields: set[str] | None = None,
    ) -> SkillDAGPlan:
        """Compile a deterministic DAG from LLM-selected target Skills."""

        return self.compile(
            None,
            target_component_ids=target_component_ids,
            assessment_mode=assessment_mode,
            root_input_fields=root_input_fields,
        )


class SkillDAGExecutor:
    """Execute a compiled DAG without allowing the LLM to alter data bindings."""

    def __init__(self, registry: SkillRegistry) -> None:
        self.registry = registry

    @staticmethod
    def _value_at(data: dict[str, Any], source_field: str) -> Any:
        value: Any = data
        for part in source_field.split("."):
            if not isinstance(value, dict) or part not in value:
                raise KeyError(source_field)
            value = value[part]
        return deepcopy(value)

    def execute(
        self,
        plan: SkillDAGPlan,
        root_payload: dict[str, Any],
        context: ExecutionContext | dict,
    ) -> SkillDAGExecution:
        ctx = context if isinstance(context, ExecutionContext) else ExecutionContext.model_validate(context)
        progress = {'phase':'preflight', 'failed_node':None, 'completed_nodes':[]}
        try:
            return self._execute_graph(plan, root_payload, ctx, progress)
        except Exception as exc:
            from .exceptions import classify_failure
            record = {**progress, 'run_id':ctx.run_id, 'error_type':type(exc).__name__,
                'classification':classify_failure(exc, progress['phase']), 'message':str(exc)}
            # A separate attempt journal also covers rejected graphs, without
            # writing into an untrusted run_id or replacing historical evidence.
            destination = ctx.run_root.resolve() / '_failures' / f'dag-{uuid.uuid4().hex}.json'
            write_json(destination, record)
            if progress.get('composition_created'):
                write_json(ctx.run_root.resolve()/ctx.run_id/'_composition/dag_failure.json', record)
            raise

    def _execute_graph(self, plan, root_payload, context, progress):
        ctx = (
            context
            if isinstance(context, ExecutionContext)
            else ExecutionContext.model_validate(context)
        )
        if not ctx.run_id:
            raise SkillDAGExecutionError("A shared run_id is required for DAG execution")
        if ctx.run_id in {'.', '..'} or re.search(r'[\\/:]', ctx.run_id):
            raise SkillDAGExecutionError('run_id must be a single directory name')
        nodes = {item.node_id: item for item in plan.nodes}
        if set(nodes) != set(plan.execution_order):
            raise SkillDAGExecutionError(
                "DAG execution_order and node identifiers are inconsistent"
            )

        # Treat the submitted graph as untrusted, even outside the agent bridge.
        if len(nodes) != len(plan.execution_order) or any(not n.implementation_version or not n.registration_hash for n in plan.nodes):
            raise SkillDAGExecutionError('Unpinned or duplicated DAG; recompile with the Registry before execution')
        pinned = {n.component_id: n.implementation_version for n in plan.nodes}
        try:
            expected = SkillDAGCompiler(self.registry).compile(plan.template_id,
                target_component_ids=plan.target_component_ids, assessment_mode=plan.assessment_mode,
                root_input_fields=set(root_payload), component_versions=pinned)
        except (ValueError, RuntimeError) as exc:
            raise SkillDAGExecutionError(f'DAG revalidation failed: {exc}') from exc
        if expected.model_dump(mode='json') != plan.model_dump(mode='json'):
            raise SkillDAGExecutionError('DAG differs from the Registry-compiled dependencies, contracts or version snapshot')
        if plan.assessment_mode is not None and root_payload.get('assessment_mode') != plan.assessment_mode:
            raise SkillDAGExecutionError('DAG assessment mode differs from request')
        for node in plan.nodes:
            issues = self.registry.applicability(node.component_id, root_payload, node.implementation_version)
            if issues:
                from .exceptions import ModelNotApplicableError
                raise ModelNotApplicableError('; '.join(i.message for i in issues))

        composition_dir = (
            ctx.run_root.resolve() / str(ctx.run_id) / "_composition"
        )
        if (composition_dir / 'dag_plan.json').exists():
            from .exceptions import InstanceStoreError
            raise InstanceStoreError('DAG execution evidence already exists; use a new run_id')
        composition_dir.mkdir(parents=True, exist_ok=True)
        progress['composition_created'] = True
        write_json(composition_dir / "dag_plan.json", plan.model_dump(mode="json"))

        results: dict[str, SkillResult] = {}
        output_slots: dict[str, dict[str, Any]] = {}
        for node_id in plan.execution_order:
            progress.update(phase='input_binding', failed_node=node_id, completed_nodes=list(results))
            node = nodes[node_id]
            schema = self.registry.input_schema(node.component_id, node.implementation_version)
            properties = set(schema.get("properties", {}))
            payload = {
                key: deepcopy(value)
                for key, value in root_payload.items()
                if key in properties and value is not None
            }
            for binding in node.input_bindings:
                if binding.source == ContractBindingSource.REQUEST:
                    if binding.source_field not in root_payload:
                        raise SkillDAGExecutionError(
                            f"Missing request binding {binding.source_field} for {node_id}"
                        )
                    value = deepcopy(root_payload[binding.source_field])
                else:
                    source_slots = output_slots.get(binding.source_node_id or "", {})
                    if binding.source_field not in source_slots:
                        raise SkillDAGExecutionError(
                            f"Missing output contract {binding.source_field} from "
                            f"{binding.source_node_id} for {node_id}"
                        )
                    value = deepcopy(source_slots[binding.source_field])
                payload[binding.target_field] = value
                for excluded in binding.excludes:
                    payload.pop(excluded, None)

            if "upstream_warnings" in properties:
                warning_payloads: list[dict[str, Any]] = []
                warning_keys: set[tuple[str, str, str]] = set()
                for result in results.values():
                    for warning in result.warnings:
                        key = (
                            warning.code,
                            warning.severity.value,
                            warning.message,
                        )
                        if key not in warning_keys:
                            warning_keys.add(key)
                            warning_payloads.append(warning.model_dump(mode="json"))
                payload["upstream_warnings"] = warning_payloads
            if "upstream_provenance" in properties:
                payload["upstream_provenance"] = [
                    result.provenance.model_dump(mode="json")
                    for result in results.values()
                ]

            progress['phase'] = 'input_validation'
            report = self.registry.validate(node.component_id, payload, node.implementation_version)
            if not report.valid or report.normalized_input is None:
                detail = "; ".join(
                    f"{item.field or '<root>'}: {item.message}"
                    for item in report.issues
                )
                raise SkillDAGExecutionError(
                    f"Runtime request for {node.component_id} failed validation: {detail}",
                    phase='input_validation', report=report,
                )
            write_json(
                composition_dir / f"{node_id}.request.json",
                report.normalized_input,
            )
            progress['phase'] = 'engineering_execution'
            result = self.registry.execute(
                    node.component_id,
                    report.normalized_input,
                    ctx.model_copy(update={"parent_run_id": ctx.run_id}),
                    version=node.implementation_version,
                )
            results[node_id] = result
            progress['phase'] = 'output_binding'
            node_slots: dict[str, Any] = {}
            for contract in node.produces:
                source_field = contract.source_field or contract.name
                try:
                    node_slots[contract.name] = self._value_at(
                        result.data,
                        source_field,
                    )
                    check_contract_value(node_slots[contract.name], contract)
                except (KeyError, ValueError) as exc:
                    raise SkillDAGExecutionError(
                        f"{node.component_id} did not produce declared contract "
                        f"{contract.name} from data field {source_field}: {exc}", phase='output_binding',
                    ) from exc
            output_slots[node_id] = node_slots
            progress['completed_nodes'] = list(results)

        progress.update(phase='result_persistence', failed_node=None)
        write_json(
            composition_dir / "dag_execution.json",
            {
                "composition_source": plan.composition_source,
                "template_id": plan.template_id,
                "targets": plan.target_component_ids,
                "execution_order": plan.execution_order,
                "node_execution": {
                    node_id: {"status": "reused" if result.provenance.reused_from_run_id else "executed",
                              "reused_from_run_id": result.provenance.reused_from_run_id,
                              "fingerprint": result.provenance.execution_fingerprint,
                              "output_validation": result.output_validation}
                    for node_id, result in results.items()
                },
                "node_result_files": {
                    node_id: str(
                        Path(ctx.run_root).resolve()
                        / str(ctx.run_id)
                        / node_id
                        / "result.json"
                    )
                    for node_id in plan.execution_order
                },
            },
        )
        return SkillDAGExecution(
            plan=plan,
            execution_order=plan.execution_order,
            node_results=results,
            output_slots=output_slots,
        )
