from __future__ import annotations

import json
import re
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from engineering_skills.builtin import create_registry
from engineering_skills.core.artifacts import hash_payload, write_json
from engineering_skills.core.composition import SkillDAGCompiler, SkillDAGExecutor
from engineering_skills.core.models import (
    ArtifactRef,
    ComponentKind,
    ExecutionContext,
    SkillProvenance,
    SkillResult,
    SkillWarning,
    WarningSeverity,
)
from engineering_skills.power.context import validate_power_analysis_context
from engineering_skills.power.schemas import PowerAnalysisContext
from engineering_skills.power.metric_standard import metric_standard_record

from .models import ExecutionPlan, PlanValidation, ValidationIssueView
from .result_delivery import ResultDeliveryBuilder


PROTECTED_DATA_REFERENCES = ("dataset_source", "dataset_artifacts")
PROTECTED_FEEDBACK_FIELDS = (*PROTECTED_DATA_REFERENCES, "knowledge_evidence")
DYNAMIC_COMPOSITION_ID = "skill_registry_dynamic_composition"
POWER_CONTEXT_PROFILE_ID = "power_analysis_context"
# Import compatibility for existing callers; this profile is electrical only.
HEALTHCARE_CONTEXT_PROFILE_ID = POWER_CONTEXT_PROFILE_ID


def ensure_official_metric_inputs(payload: dict[str, Any]) -> None:
    """Reject incompatible fields rather than promoting a historical model silently."""
    PowerAnalysisContext.model_validate(payload)


def localize_assumptions(values, language):
    return list(values)


def localize_skill_warnings(values, language):
    return list(values)


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def _compact(value: Any, depth: int = 0) -> Any:
    if depth > 5:
        return "[truncated]"
    if isinstance(value, dict):
        items = list(value.items())
        compacted = {str(key): _compact(child, depth + 1) for key, child in items[:40]}
        if len(items) > 40:
            compacted["_truncated_keys"] = len(items) - 40
        return compacted
    if isinstance(value, list):
        compacted = [_compact(child, depth + 1) for child in value[:20]]
        if len(value) > 20:
            compacted.append({"_truncated_items": len(value) - 20})
        return compacted
    return value


class SkillRegistryBridge:
    def __init__(self, skill_run_root: Path) -> None:
        self.skill_run_root = Path(skill_run_root)
        self.registry = create_registry(instance_store=self.skill_run_root / '_registry/instances.sqlite3')
        self.dag_compiler = SkillDAGCompiler(self.registry)
        self.dag_executor = SkillDAGExecutor(self.registry)
        self.result_delivery = ResultDeliveryBuilder()

    def component_catalog(
        self,
        *,
        targetable_only: bool = False,
        context: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        return [
            {
                "id": manifest.id,
                "version": manifest.version,
                "skill_type_id": manifest.skill_type_id,
                "skill_type_version": manifest.skill_type_version,
                "contract_version": manifest.contract_version,
                "model_profiles": manifest.model_profiles,
                "applicability_conditions": [x.model_dump(mode='json') for x in manifest.applicability_conditions],
                "kind": manifest.kind.value,
                "name": manifest.name,
                "description": manifest.description,
                "domain": manifest.domain,
                "target_system": manifest.target_system,
                "capability": manifest.capability,
                "stage": manifest.stage,
                "assessment_modes": [mode.value for mode in manifest.assessment_modes],
                "inputs": manifest.inputs,
                "outputs": manifest.outputs,
                "dependencies": manifest.dependencies,
                "consumes": [
                    item.model_dump(mode="json") for item in manifest.consumes
                ],
                "produces": [
                    item.model_dump(mode="json") for item in manifest.produces
                ],
                "default_targets": manifest.default_targets,
                "applicability": manifest.applicability,
                "limitations": manifest.limitations,
                "verification_status": manifest.verification_status.value,
            }
            for manifest in self.registry.latest_components()
            if not targetable_only or manifest.kind != ComponentKind.WORKFLOW
            if context is None or not self.registry.applicability(manifest.id, context, manifest.version)
        ]

    def target_catalog(self, context: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Return only components the LLM may select as execution targets."""

        return self.component_catalog(targetable_only=True, context=context)

    def available_target_skill_ids(
        self,
        *,
        domain: str | None = None,
        target_system: str | None = None,
    ) -> list[str]:
        return [
            item["id"]
            for item in self.target_catalog()
            if (domain is None or item.get("domain") == domain)
            and (
                target_system is None
                or item.get("target_system") == target_system
                or item.get("target_system") == "urban_engineering_system"
            )
        ]

    def constrain_component_id(
        self,
        proposed_component_id: str,
        proposed_skill_ids: list[str] | None = None,
        *,
        domain: str | None = None,
        target_system: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        targets, target_trace = self.constrain_target_skill_ids(
            DYNAMIC_COMPOSITION_ID,
            [proposed_component_id, *(proposed_skill_ids or [])],
            domain=domain,
            target_system=target_system,
        )
        return DYNAMIC_COMPOSITION_ID, {
            "proposed_component_id": proposed_component_id,
            "proposed_skill_ids": proposed_skill_ids or [],
            "selected_component_id": DYNAMIC_COMPOSITION_ID,
            "selected_target_skill_ids": targets,
            "reason": "global_registry_target_selection",
            "registry_size": len(self.target_catalog()),
            "domain": domain,
            "target_system": target_system,
            "target_selection": target_trace,
        }

    def describe(self, component_id: str) -> dict[str, Any]:
        return self.registry.describe(component_id).model_dump(mode="json")

    def input_schema(self, component_id: str) -> dict[str, Any]:
        return self.registry.input_schema(component_id)

    def execution_chain(self, component_id: str) -> list[str]:
        if component_id == DYNAMIC_COMPOSITION_ID:
            return [item["id"] for item in self.target_catalog()]
        component = self.registry.describe(component_id)
        if component.kind.value == "workflow":
            return list(component.dependencies)
        return [component.id]

    def default_targets(self, component_id: str) -> list[str]:
        if component_id == DYNAMIC_COMPOSITION_ID:
            return ["power_system.result_reporting"]
        component = self.registry.describe(component_id)
        if component.kind == ComponentKind.WORKFLOW:
            return list(component.default_targets)
        return [component.id]

    def constrain_target_skill_ids(
        self,
        component_id: str,
        proposed_skill_ids: list[str] | None,
        *,
        domain: str | None = None,
        target_system: str | None = None,
        delivery_targets: list[str] | None = None,
    ) -> tuple[list[str], dict[str, Any]]:
        proposed = list(dict.fromkeys(proposed_skill_ids or []))
        catalog = {item["id"]: item for item in self.component_catalog()}
        targetable = {
            component_id
            for component_id, item in catalog.items()
            if item["kind"] != ComponentKind.WORKFLOW.value
            and (domain is None or item.get("domain") == domain)
            and (
                target_system is None
                or item.get("target_system") == target_system
                or item.get("target_system") == "urban_engineering_system"
            )
        }
        expanded: list[str] = []
        legacy_workflow_aliases: list[str] = []
        for item in proposed:
            manifest = catalog.get(item)
            if manifest and manifest["kind"] == ComponentKind.WORKFLOW.value:
                legacy_workflow_aliases.append(item)
                expanded.extend(manifest.get("default_targets", []))
            else:
                expanded.append(item)
        if component_id in catalog and catalog[component_id]["kind"] != ComponentKind.WORKFLOW.value:
            expanded.insert(0, component_id)
        selected = list(
            dict.fromkeys(item for item in expanded if item in targetable)
        )
        removed = [item for item in proposed if item not in targetable]
        if not selected:
            raise ValueError(
                "The LLM did not select a registered executable Skill for this task"
            )

        manifests = {
            item: self.registry.describe(item)
            for item in targetable
        }

        def ancestors(selected_id: str) -> set[str]:
            output: set[str] = set()
            pending = list(manifests[selected_id].dependencies)
            while pending:
                dependency = pending.pop()
                if dependency in output or dependency not in manifests:
                    continue
                output.add(dependency)
                pending.extend(manifests[dependency].dependencies)
            return output

        redundant = {
            candidate
            for target in selected
            for candidate in ancestors(target)
            if candidate in selected
            and candidate not in (delivery_targets or [])
        }
        selected = [item for item in selected if item not in redundant]
        return selected, {
            "proposed_target_skill_ids": proposed,
            "selected_target_skill_ids": selected,
            "removed_target_skill_ids": removed,
            "legacy_workflow_aliases_expanded": legacy_workflow_aliases,
            "preserved_delivery_target_ids": [item for item in selected if item in (delivery_targets or [])],
            "redundant_dependency_targets_removed": sorted(
                set(proposed) - set(selected) - set(removed)
            ),
            "reason": "registered_global_targets_retained",
        }

    def explicit_delivery_targets(self, output_names: list[str], capability_ids: list[str]) -> list[str]:
        """Resolve named deliverables through the Registry, not from DAG ancestry."""
        owners: dict[str, list[str]] = {}
        for entry in self.target_catalog():
            for output in entry["outputs"]:
                owners.setdefault(output.casefold(), []).append(entry["id"])
        resolved = []
        for name in output_names:
            matches = owners.get(name.strip().casefold(), [])
            if len(matches) == 1:
                resolved.extend(matches)
            else:
                resolved.extend(item for item in matches if item in capability_ids)
        return list(dict.fromkeys(resolved))

    def compile_plan(
        self,
        plan: ExecutionPlan,
        *,
        target_skill_ids: list[str] | None = None,
    ) -> ExecutionPlan:
        requested_targets = list(
            dict.fromkeys(
                target_skill_ids
                if target_skill_ids is not None
                else plan.target_skill_ids or plan.selected_skill_ids
            )
        )
        if not requested_targets:
            raise ValueError("At least one target Skill is required")

        profile_id = self.input_profile_id(requested_targets, plan.request_payload)
        if profile_id != HEALTHCARE_CONTEXT_PROFILE_ID:
            component = self.registry.describe(profile_id)
            return plan.model_copy(
                update={
                    "selected_skill_ids": [component.id],
                    "target_skill_ids": [component.id],
                    "composition_mode": "single",
                    "dag": None,
                    "component_id": component.id,
                    "input_profile_id": component.id,
                }
            )

        assessment_mode = plan.request_payload.get("assessment_mode")
        dag = self.dag_compiler.compile_targets(
            requested_targets,
            assessment_mode=str(assessment_mode) if assessment_mode is not None else None,
            root_input_fields=set(plan.request_payload),
        )
        return plan.model_copy(
            update={
                "selected_skill_ids": dag.execution_order,
                "target_skill_ids": dag.target_component_ids,
                "composition_mode": "registry_dag",
                "dag": dag,
                "component_id": DYNAMIC_COMPOSITION_ID,
                "input_profile_id": HEALTHCARE_CONTEXT_PROFILE_ID,
            }
        )

    def recompose_plan(
        self,
        plan: ExecutionPlan,
        target_skill_ids: list[str],
    ) -> ExecutionPlan:
        return self.compile_plan(plan, target_skill_ids=target_skill_ids)

    def input_profile_id(
        self,
        target_skill_ids: list[str],
        payload: dict[str, Any] | None = None,
    ) -> str:
        """Choose an input contract for this target set, never a workflow template."""

        targets = list(dict.fromkeys(target_skill_ids))
        manifests = [self.registry.describe(item) for item in targets]
        candidate_payload = payload or {}
        if len(manifests) == 1 and "dataset_source" not in candidate_payload:
            return manifests[0].id
        if manifests and all(
            item.domain == "urban_power_resilience" for item in manifests
        ):
            return HEALTHCARE_CONTEXT_PROFILE_ID
        if len(manifests) == 1:
            return manifests[0].id
        raise ValueError(
            "No shared input profile is registered for the selected cross-domain Skills"
        )

    def input_schema_for_targets(
        self,
        target_skill_ids: list[str],
        request_context: dict[str, Any] | None = None,
    ) -> tuple[str, dict[str, Any]]:
        profile_id = self.input_profile_id(target_skill_ids, request_context)
        if profile_id == HEALTHCARE_CONTEXT_PROFILE_ID:
            return profile_id, PowerAnalysisContext.model_json_schema(
                mode="validation"
            )
        return profile_id, self.registry.input_schema(profile_id)

    def mutable_input_fields_for_plan(self, plan: ExecutionPlan) -> dict[str, Any]:
        profile_id = plan.input_profile_id or self.input_profile_id(
            plan.target_skill_ids,
            plan.request_payload,
        )
        if profile_id == HEALTHCARE_CONTEXT_PROFILE_ID:
            schema = PowerAnalysisContext.model_json_schema(mode="validation")
        else:
            schema = self.registry.input_schema(profile_id)
        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            return {}
        return {
            key: deepcopy(value)
            for key, value in properties.items()
            if key not in PROTECTED_FEEDBACK_FIELDS
        }

    def sanitize_plan_payload_patch(
        self,
        plan: ExecutionPlan,
        payload_patch: dict[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(payload_patch, dict):
            raise ValueError("payload_patch must be a JSON object")
        protected = sorted(set(payload_patch) & set(PROTECTED_FEEDBACK_FIELDS))
        if protected:
            raise ValueError(f"Protected data references cannot be changed: {protected}")
        allowed = set(self.mutable_input_fields_for_plan(plan))
        unknown = sorted(set(payload_patch) - allowed)
        if unknown:
            raise ValueError(
                f"Fields are not declared by the active input profile: {unknown}"
            )
        if plan.input_profile_id == HEALTHCARE_CONTEXT_PROFILE_ID or "dataset_source" in plan.request_payload:
            ensure_official_metric_inputs(_deep_merge(plan.request_payload, payload_patch))
        return deepcopy(payload_patch)

    def mutable_input_fields(self, component_id: str) -> dict[str, Any]:
        schema = self.input_schema(component_id)
        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            return {}
        return {
            key: deepcopy(value)
            for key, value in properties.items()
            if key not in PROTECTED_DATA_REFERENCES
        }

    def sanitize_payload_patch(
        self,
        component_id: str,
        payload_patch: dict[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(payload_patch, dict):
            raise ValueError("payload_patch must be a JSON object")
        protected = sorted(set(payload_patch) & set(PROTECTED_DATA_REFERENCES))
        if protected:
            raise ValueError(f"Protected data references cannot be changed: {protected}")
        allowed = set(self.mutable_input_fields(component_id))
        unknown = sorted(set(payload_patch) - allowed)
        if unknown:
            raise ValueError(
                f"Fields are not declared by the {component_id} input schema: {unknown}"
            )
        return deepcopy(payload_patch)

    def compile_payload(
        self,
        request_context: dict[str, Any],
        proposed_payload: dict[str, Any],
    ) -> dict[str, Any]:
        merged = _deep_merge(request_context, proposed_payload)
        for key in PROTECTED_DATA_REFERENCES:
            if key in request_context:
                merged[key] = deepcopy(request_context[key])
        return merged

    def validate(self, plan: ExecutionPlan) -> PlanValidation:
        allowed_component_ids = {item["id"] for item in self.target_catalog()}
        unknown_skills = sorted(set(plan.selected_skill_ids) - allowed_component_ids)
        issues: list[ValidationIssueView] = []
        registered_ok = True
        type_ok = True
        schema_ok = True
        dependency_ok = True
        dag_ok = True
        binding_ok = True
        if unknown_skills:
            registered_ok = False
            issues.append(
                ValidationIssueView(
                    code="unknown_selected_skill",
                    field="selected_skill_ids",
                    message=f"Components are not registered executable Skills: {unknown_skills}",
                    severity="error",
                )
            )
        try:
            profile_id = plan.input_profile_id or self.input_profile_id(
                plan.target_skill_ids,
                plan.request_payload,
            )
            if profile_id == HEALTHCARE_CONTEXT_PROFILE_ID or "dataset_source" in plan.request_payload:
                ensure_official_metric_inputs(plan.request_payload)
            report = (
                validate_power_analysis_context(plan.request_payload)
                if profile_id == HEALTHCARE_CONTEXT_PROFILE_ID
                else self.registry.validate(profile_id, plan.request_payload)
            )
        except Exception as exc:
            schema_ok = False
            issues.append(
                ValidationIssueView(
                    code="component_validation_error",
                    field="component_id",
                    message=str(exc),
                    severity="error",
                )
            )
            return PlanValidation(
                valid=False,
                issues=issues,
                registered_ok=registered_ok,
                schema_ok=False,
            )
        issues.extend(
            ValidationIssueView(
                code=item.code,
                field=item.field,
                message=item.message,
                severity=item.severity,
                    category=item.category,
            )
            for item in report.issues
        )
        if not report.valid:
            schema_ok = False

        if plan.composition_mode == "registry_dag":
            if plan.dag is None:
                dependency_ok = False
                dag_ok = False
                issues.append(
                    ValidationIssueView(
                        code="dag_plan_missing",
                        field="dag",
                        message=(
                            "Multi-Skill plans must be compiled into a registry-controlled DAG "
                            "before execution"
                        ),
                        severity="error",
                    )
                )
            else:
                normalized = report.normalized_input or plan.request_payload
                compiled, dag_report = self.dag_compiler.try_compile_targets(
                    plan.target_skill_ids,
                    assessment_mode=str(normalized.get("assessment_mode"))
                    if normalized.get("assessment_mode") is not None
                    else None,
                    root_input_fields=set(normalized),
                )
                registered_ok = registered_ok and dag_report.registered_ok
                type_ok = dag_report.type_ok
                schema_ok = schema_ok and dag_report.schema_ok
                dependency_ok = dag_report.dependency_ok
                dag_ok = dag_report.dag_ok
                binding_ok = dag_report.binding_ok
                issues.extend(
                    ValidationIssueView(
                        code=item.code,
                        field=item.field or "dag",
                        message=item.message,
                        severity=item.severity,
                    )
                    for item in dag_report.issues
                )
                if (
                    compiled is not None
                    and compiled.model_dump(mode="json")
                    != plan.dag.model_dump(mode="json")
                ):
                    dependency_ok = False
                    binding_ok = False
                    issues.append(
                        ValidationIssueView(
                            code="dag_plan_stale",
                            field="dag",
                            message=(
                                "The submitted DAG does not match the plan compiled from "
                                "the current global Registry contracts and request"
                            ),
                            severity="error",
                        )
                    )
                if plan.dag.execution_order != plan.selected_skill_ids:
                    dag_ok = False
                    issues.append(
                        ValidationIssueView(
                            code="dag_execution_order_mismatch",
                            field="selected_skill_ids",
                            message=(
                                "selected_skill_ids must equal the compiled DAG execution order"
                            ),
                            severity="error",
                        )
                    )

        elif plan.composition_mode == "single":
            if (
                len(plan.target_skill_ids) != 1
                or plan.selected_skill_ids != plan.target_skill_ids
                or plan.component_id != plan.target_skill_ids[0]
            ):
                dag_ok = False
                issues.append(
                    ValidationIssueView(
                        code="single_skill_plan_mismatch",
                        field="target_skill_ids",
                        message="A single-Skill plan must contain exactly its registered component",
                        severity="error",
                    )
                )

        valid = report.valid and not any(item.severity == "error" for item in issues)
        return PlanValidation(
            valid=valid,
            normalized_input=report.normalized_input,
            issues=issues,
            registered_ok=registered_ok,
            type_ok=type_ok,
            schema_ok=schema_ok,
            dependency_ok=dependency_ok,
            dag_ok=dag_ok,
            binding_ok=binding_ok,
        )

    def execute(self, plan: ExecutionPlan, run_id: str) -> dict[str, Any]:
        # Public SDK calls receive the same preflight as agent calls.
        validation = self.validate(plan)
        if not validation.valid:
            from engineering_skills.core.exceptions import SkillValidationError
            from engineering_skills.core.models import ValidationReport, ValidationIssue
            raise SkillValidationError(ValidationReport(valid=False, issues=[
                ValidationIssue(code=x.code, field=x.field, message=x.message, severity=x.severity, category=x.category)
                for x in validation.issues]))
        if plan.composition_mode == "registry_dag":
            return self._execute_composed(plan, run_id)
        result = self.registry.execute(
            plan.component_id,
            plan.request_payload,
            ExecutionContext(run_root=self.skill_run_root, run_id=run_id, reuse_from_run_id=plan.reuse_from_run_id),
        )
        result = self._attach_delivery(
            result,
            plan,
            run_id,
            [result],
        )
        return result.model_dump(mode="json")

    def regenerate_presentation(
        self,
        result: dict[str, Any],
        plan: ExecutionPlan,
        *,
        previous_plan: ExecutionPlan,
    ) -> dict[str, Any]:
        """Rebuild delivery files from frozen outputs, without entering the engineering DAG.

        The original computation and files remain immutable. Presentation revisions
        have their own directories and audit metadata within the same numerical run.
        """
        from .feedback_routing import PRESENTATION_FIELDS

        if plan.feedback_route != "presentation_only":
            raise ValueError("A delivery revision requires the presentation-only route")
        if (plan.target_skill_ids != previous_plan.target_skill_ids
                or plan.selected_skill_ids != previous_plan.selected_skill_ids):
            raise ValueError("Presentation revisions cannot change engineering targets")
        engineering = lambda payload: {key: value for key, value in payload.items() if key not in PRESENTATION_FIELDS}
        if hash_payload(engineering(plan.request_payload)) != hash_payload(engineering(previous_plan.request_payload)):
            raise ValueError("Presentation revisions cannot change numerical inputs or constraints")
        run_id = result.get("run_id")
        if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", run_id):
            raise ValueError("An existing safe engineering run ID is required")
        run_directory = (self.skill_run_root.resolve() / run_id).resolve()
        data = result.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("node_results"), dict) or not data["node_results"]:
            raise ValueError("Saved engineering node outputs are required to rebuild presentation")
        stored_directory = data.get("run_directory")
        if stored_directory and Path(stored_directory).resolve() != run_directory:
            raise ValueError("Saved run directory does not match the independent run root")
        if not run_directory.is_dir():
            raise ValueError("The engineering run directory no longer exists")

        nodes = deepcopy(data["node_results"])
        numerical_fingerprint = hash_payload(nodes)
        old_bundle = data.get("delivery_bundle") or {}
        revision_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex[:8]
        revision_directory = run_directory / "presentation-revisions" / revision_id
        requested = list(data.get("requested_skill_ids") or plan.requested_skill_ids or plan.target_skill_ids)
        bundle, refs = self.result_delivery.build(
            run_directory=revision_directory,
            run_id=run_id,
            objective=plan.task_objective or plan.rationale,
            assessment_mode=str(plan.request_payload.get("assessment_mode", "predictive")),
            output_language=str(plan.request_payload.get("output_language") or "zh-CN"),
            requested_skill_ids=requested,
            execution_target_skill_ids=list(plan.target_skill_ids),
            executed_components=list(data.get("executed_components") or nodes),
            node_results=nodes,
            node_trace=deepcopy(old_bundle.get("execution_trace") or data.get("node_trace") or []),
            source_artifacts=deepcopy(result.get("artifacts", [])),
            warnings=deepcopy(result.get("warnings", [])),
            assumptions=deepcopy(result.get("assumptions", [])),
            report_title=plan.request_payload.get("report_title"),
            presentation_instructions=plan.request_payload.get("presentation_instructions"),
        )
        if numerical_fingerprint != hash_payload(nodes):
            raise ValueError("The delivery builder changed frozen engineering node outputs")
        metadata = {
            "schema_version": "power_presentation_revision_v1",
            "revision_id": revision_id,
            "parent_revision_id": data.get("presentation_revision_id"),
            "run_id": run_id,
            "revision_directory": str(revision_directory),
            "source_engineering_input_hash": result.get("provenance", {}).get("input_hash"),
            "source_node_results_hash": numerical_fingerprint,
            "engineering_recomputed": False,
            "presentation": {key: deepcopy(plan.request_payload[key]) for key in PRESENTATION_FIELDS if key in plan.request_payload},
            "artifacts": [ref.model_dump(mode="json") for ref in refs],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        write_json(revision_directory / "revision.json", metadata)
        revised = deepcopy(result)
        revised_data = revised["data"]
        revised_data["delivery_bundle"] = bundle
        revised_data["presentation_revision_id"] = revision_id
        revised_data["presentation_revisions"] = [*revised_data.get("presentation_revisions", []), metadata]
        summary = revised_data.get("power_summary")
        if isinstance(summary, dict):
            for key in PRESENTATION_FIELDS:
                if key in plan.request_payload:
                    summary[key] = deepcopy(plan.request_payload[key])
        artifacts = [ref.model_dump(mode="json") for ref in refs]
        seen = {str(Path(item["path"]).resolve()) for item in artifacts}
        for item in revised.get("artifacts", []):
            path = str(Path(item["path"]).resolve())
            if path not in seen:
                artifacts.append(item)
                seen.add(path)
        revised["artifacts"] = artifacts
        return revised

    @staticmethod
    def _node_trace(results: list[SkillResult]) -> list[dict[str, Any]]:
        return [
            {
                "skill_id": result.skill_id,
                "skill_version": result.skill_version,
                "component_kind": result.component_kind.value,
                "status": result.status,
                "execution_status": "reused" if result.provenance.reused_from_run_id else "executed",
                "reused_from_run_id": result.provenance.reused_from_run_id,
                "output_validation": result.output_validation,
                "duration_seconds": result.provenance.duration_seconds,
                "assessment_mode": result.provenance.assessment_mode,
                "seed": result.provenance.seed,
                "input_hash": result.provenance.input_hash,
                "model_versions": result.provenance.model_versions,
                "started_at": result.provenance.started_at.isoformat(),
                "finished_at": result.provenance.finished_at.isoformat(),
                "warning_count": len(result.warnings),
                "assumption_count": len(result.assumptions),
                "artifacts": [item.model_dump(mode="json") for item in result.artifacts],
            }
            for result in results
        ]

    def _attach_delivery(
        self,
        result: SkillResult,
        plan: ExecutionPlan,
        run_id: str,
        node_results: list[SkillResult],
    ) -> SkillResult:
        data = deepcopy(result.data)
        node_data = data.get("node_results")
        if not isinstance(node_data, dict):
            node_data = {item.skill_id: item.data for item in node_results}
            data["node_results"] = node_data
        requested_skill_ids = list(
            dict.fromkeys(plan.requested_skill_ids or plan.target_skill_ids)
        )
        executed_components = [item.skill_id for item in node_results]
        node_trace = self._node_trace(node_results)
        data["requested_skill_ids"] = requested_skill_ids
        data["execution_target_skill_ids"] = list(plan.target_skill_ids)
        data["executed_components"] = executed_components
        data["node_trace"] = node_trace
        power_summary: dict[str, Any] = {}
        for stage_data in node_data.values():
            if isinstance(stage_data, dict):
                stage_summary = stage_data.get("summary", {})
                if isinstance(stage_summary, dict):
                    power_summary.update(deepcopy(stage_summary))
        data["power_summary"] = power_summary
        for key, value in power_summary.items():
            data.setdefault(key, value)
        if plan.input_profile_id == HEALTHCARE_CONTEXT_PROFILE_ID or "dataset_source" in plan.request_payload:
            data["metric_standard"] = metric_standard_record()
            data["model_profile"] = "power_dc_v1"
            power_summary["metric_standard"] = metric_standard_record()
            power_summary["model_profile"] = "power_dc_v1"
            for field in ("power_damage_mode", "pga_g", "seed", "team_count", "daily_work_hours", "target_function"):
                if field in plan.request_payload:
                    data[field] = plan.request_payload[field]
                    power_summary.setdefault(field, plan.request_payload[field])
            data["dataset_fingerprint"] = power_summary.get("dataset_fingerprint") or next((item.get("dataset_fingerprint") for item in node_data.values()
                if isinstance(item, dict) and item.get("dataset_fingerprint")), None)
        all_artifacts = self._deduplicate_artifacts(
            [
                *[
                    item
                    for target_id in plan.target_skill_ids
                    for item in node_results
                    if item.skill_id == target_id
                ],
                *node_results,
            ]
        )
        warnings = list(result.warnings)
        try:
            bundle, generated_artifacts = self.result_delivery.build(
                run_directory=self.skill_run_root.resolve() / run_id,
                run_id=run_id,
                objective=plan.task_objective or plan.rationale,
                assessment_mode=(
                    str(plan.request_payload.get("assessment_mode"))
                    if plan.request_payload.get("assessment_mode") is not None
                    else None
                ),
                output_language=str(plan.request_payload.get("output_language") or "zh-CN"),
                requested_skill_ids=requested_skill_ids,
                execution_target_skill_ids=list(plan.target_skill_ids),
                executed_components=executed_components,
                node_results=node_data,
                node_trace=node_trace,
                source_artifacts=[item.model_dump(mode="json") for item in all_artifacts],
                warnings=[item.model_dump(mode="json") for item in warnings],
                assumptions=list(result.assumptions),
                report_title=plan.request_payload.get("report_title"),
                presentation_instructions=plan.request_payload.get("presentation_instructions"),
            )
        except Exception as exc:
            warnings.append(
                SkillWarning(
                    code="result_delivery_failed",
                    severity=WarningSeverity.HIGH,
                    message=f"工程计算已完成，但结果交付包生成失败：{type(exc).__name__}: {exc}",
                    details={"exception_type": type(exc).__name__},
                )
            )
            data["delivery_bundle"] = {
                "schema_version": "1.0",
                "status": "failed",
                "requested_skill_ids": requested_skill_ids,
                "execution_target_skill_ids": list(plan.target_skill_ids),
                "executed_components": executed_components,
                "execution_trace": node_trace,
                "error": f"{type(exc).__name__}: {exc}",
            }
            return result.model_copy(
                update={
                    "data": data,
                    "artifacts": all_artifacts,
                    "warnings": warnings,
                }
            )
        data["delivery_bundle"] = bundle
        return result.model_copy(
            update={
                "data": data,
                "artifacts": self._deduplicate_artifacts(
                    [
                        result.model_copy(update={"artifacts": all_artifacts}),
                        result.model_copy(update={"artifacts": generated_artifacts}),
                    ]
                ),
                "warnings": warnings,
            }
        )

    @staticmethod
    def _deduplicate_warnings(results: list[SkillResult]) -> list[SkillWarning]:
        output: list[SkillWarning] = []
        seen: set[tuple[str, str, str]] = set()
        for result in results:
            for warning in result.warnings:
                key = (warning.code, warning.severity.value, warning.message)
                if key not in seen:
                    seen.add(key)
                    output.append(warning)
        return output

    @staticmethod
    def _deduplicate_artifacts(results: list[SkillResult]) -> list[ArtifactRef]:
        output: list[ArtifactRef] = []
        seen: set[str] = set()
        for result in results:
            for artifact in result.artifacts:
                key = str(artifact.path.resolve())
                if key not in seen:
                    seen.add(key)
                    output.append(artifact)
        return output

    @staticmethod
    def _summary_from_slots(output_slots: dict[str, dict[str, Any]]) -> dict[str, Any]:
        candidates: list[dict[str, Any]] = []
        for slots in output_slots.values():
            for name, value in slots.items():
                if name.endswith("summary_artifact") and isinstance(value, dict):
                    candidates.append(value)
        for artifact in reversed(candidates):
            path = Path(str(artifact.get("path") or ""))
            if path.suffix.lower() != ".json" or not path.is_file():
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                return payload
        return {}

    def _execute_composed(self, plan: ExecutionPlan, run_id: str) -> dict[str, Any]:
        if plan.dag is None:
            raise ValueError("Compiled DAG is required for registry_dag execution")
        started = datetime.now(timezone.utc)
        started_clock = time.perf_counter()
        execution = self.dag_executor.execute(
            plan.dag,
            plan.request_payload,
            ExecutionContext(
                run_root=self.skill_run_root,
                run_id=run_id,
                seed=plan.request_payload.get("seed"),
                reuse_from_run_id=plan.reuse_from_run_id,
            ),
        )
        ordered_results = [
            execution.node_results[node_id] for node_id in execution.execution_order
        ]
        target_results = [
            execution.node_results[node_id]
            for node_id in plan.target_skill_ids
            if node_id in execution.node_results
        ]
        artifact_results = [*target_results, *ordered_results]
        artifacts = self._deduplicate_artifacts(artifact_results)
        warnings = self._deduplicate_warnings(ordered_results)
        assumptions = list(
            dict.fromkeys(
                [
                    "执行DAG由Skill Registry依据声明依赖和类型化数据契约编译",
                    "LLM只提出目标能力和参数，不得改写已编译的数据绑定与执行顺序",
                    *[
                        item
                        for result in ordered_results
                        for item in result.assumptions
                    ],
                ]
            )
        )
        output_language = str(plan.request_payload.get("output_language") or "zh-CN")
        warnings = localize_skill_warnings(warnings, output_language)
        assumptions = localize_assumptions(assumptions, output_language)
        domain_summary = self._summary_from_slots(execution.output_slots)
        run_directory = self.skill_run_root.resolve() / run_id
        data: dict[str, Any] = {
            "composition_mode": "registry_dag",
            "composition_source": "skill_registry",
            "input_profile_id": plan.input_profile_id,
            "requested_skill_ids": list(
                dict.fromkeys(plan.requested_skill_ids or plan.target_skill_ids)
            ),
            "target_skill_ids": plan.target_skill_ids,
            "knowledge_evidence_ids": plan.evidence_ids,
            "executed_components": execution.execution_order,
            "executed_skills": [
                result.skill_id
                for result in ordered_results
                if result.component_kind == ComponentKind.ENGINEERING_SKILL
            ],
            "executed_support_components": [
                result.skill_id
                for result in ordered_results
                if result.component_kind == ComponentKind.SUPPORT_COMPONENT
            ],
            "dag": plan.dag.model_dump(mode="json"),
            "run_directory": str(run_directory),
            "child_result_files": {
                result.skill_id: str(
                    run_directory / result.skill_id / "result.json"
                )
                for result in ordered_results
            },
            "node_results": {
                result.skill_id: result.data for result in ordered_results
            },
            "node_trace": self._node_trace(ordered_results),
            "domain_summary": domain_summary,
        }
        for key, value in domain_summary.items():
            data.setdefault(key, value)
        for result in target_results:
            for key, value in result.data.items():
                data.setdefault(key, value)

        finished = datetime.now(timezone.utc)
        source_files = list(
            dict.fromkeys(
                file
                for result in ordered_results
                for file in result.provenance.source_files
            )
        )
        provenance = SkillProvenance(
            run_id=run_id,
            skill_id=DYNAMIC_COMPOSITION_ID,
            skill_version="1.0.0",
            component_kind=ComponentKind.COMPOSITION,
            assessment_mode=str(plan.request_payload.get("assessment_mode"))
            if plan.request_payload.get("assessment_mode") is not None
            else None,
            model_versions={
                "composition": "global_registry_contract_dag_v2",
                "components": {
                    result.skill_id: result.provenance.model_versions
                    for result in ordered_results
                },
            },
            seed=plan.request_payload.get("seed"),
            input_hash=hash_payload(plan.request_payload),
            started_at=started,
            finished_at=finished,
            duration_seconds=time.perf_counter() - started_clock,
            source_files=source_files,
        )
        result = SkillResult(
            skill_id=DYNAMIC_COMPOSITION_ID,
            skill_version="1.0.0",
            run_id=run_id,
            component_kind=ComponentKind.COMPOSITION,
            data=data,
            artifacts=artifacts,
            warnings=warnings,
            assumptions=assumptions,
            provenance=provenance,
            output_validation={"valid": all(item.output_validation.get("valid", False) for item in ordered_results),
                               "node_count": len(ordered_results)},
        )
        result = self._attach_delivery(result, plan, run_id, ordered_results)
        result_directory = run_directory / DYNAMIC_COMPOSITION_ID
        result_directory.mkdir(parents=True, exist_ok=True)
        write_json(
            result_directory / "request.json",
            plan.request_payload,
        )
        write_json(
            result_directory / "dag_plan.json",
            plan.dag.model_dump(mode="json"),
        )
        write_json(
            result_directory / "result.json",
            result.model_dump(mode="json"),
        )
        return result.model_dump(mode="json")

    @staticmethod
    def summarize_result(result: dict[str, Any]) -> dict[str, Any]:
        data = result.get("data", {})
        delivery = data.get("delivery_bundle") if isinstance(data, dict) else None
        if isinstance(delivery, dict) and isinstance(
            delivery.get("interpretation_payload"), dict
        ):
            return {
                "status": result.get("status"),
                "metric_standard": data.get("metric_standard"),
                "dataset_fingerprint": data.get("dataset_fingerprint"),
                "skill_id": result.get("skill_id"),
                "run_id": result.get("run_id"),
                "data": delivery["interpretation_payload"],
                "execution_trace": [
                    {
                        key: node.get(key)
                        for key in (
                            "skill_id",
                            "skill_version",
                            "status",
                            "duration_seconds",
                            "seed",
                            "input_hash",
                            "warning_count",
                            "artifacts",
                        )
                    }
                    for node in delivery.get("execution_trace", [])
                    if isinstance(node, dict)
                ],
                "warnings": result.get("warnings", []),
                "assumptions": result.get("assumptions", [])[:10],
                "artifacts": [
                    {
                        "path": item.get("path"),
                        "media_type": item.get("media_type"),
                        "description": item.get("description"),
                    }
                    for item in result.get("artifacts", [])
                    if isinstance(item, dict)
                    and Path(str(item.get("path") or "")).suffix.lower()
                    in {".json", ".xlsx", ".docx", ".png"}
                ][:20],
                "provenance": result.get("provenance", {}),
            }
        return _compact(
            {
                "status": result.get("status"),
                "skill_id": result.get("skill_id"),
                "run_id": result.get("run_id"),
                "data": result.get("data", {}),
                "warnings": result.get("warnings", []),
                "assumptions": result.get("assumptions", []),
                "artifacts": result.get("artifacts", []),
                "provenance": result.get("provenance", {}),
            }
        )
