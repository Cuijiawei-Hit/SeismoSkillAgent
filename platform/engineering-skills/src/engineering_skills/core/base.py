from __future__ import annotations

import re
import json
import shutil
import time
import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar, TypeVar
from importlib import import_module

from pydantic import BaseModel, ValidationError

from .artifacts import hash_payload, sha256_file, write_json
from .exceptions import SkillValidationError, InstanceBindingError, InstanceStoreError, classify_failure
from .manifest import load_manifest
from .reuse import execution_fingerprint
from .contracts import applicability_issues, check_contract_value
from .provenance import input_sources, implementation_record, runtime_snapshot, capture_checks
from .rules import run_rules, declared_coverage
from .models import (
    ExecutionContext,
    SkillExecutionOutput,
    SkillBinding,
    SkillManifest,
    SkillProvenance,
    SkillResult,
    ArtifactRef,
    ComponentKind,
    ValidationIssue,
    ValidationReport,
)


RequestT = TypeVar("RequestT", bound=BaseModel)


class ExecutableComponent(ABC):
    manifest_file: ClassVar[Path]
    request_model: ClassVar[type[BaseModel]]
    output_model: ClassVar[type[BaseModel] | None] = None
    expected_kind: ClassVar[ComponentKind | None] = None

    def __init__(self) -> None:
        self._manifest = load_manifest(self.manifest_file)
        if self.expected_kind is not None and self._manifest.kind != self.expected_kind:
            raise ValueError(
                f"{self.__class__.__name__} requires kind={self.expected_kind.value}, "
                f"manifest declares {self._manifest.kind.value}"
            )

    def describe(self) -> SkillManifest:
        return self._manifest.model_copy(deep=True)

    def input_schema(self) -> dict:
        return self.request_model.model_json_schema(mode="validation")

    def resolved_output_model(self):
        if self.output_model is not None:
            return self.output_model
        # Existing adapters already declare typed Output classes beside their Requests.
        return getattr(import_module(self.request_model.__module__),
                       self.request_model.__name__.removesuffix('Request') + 'Output', None)

    def output_schema(self) -> dict | None:
        model = self.resolved_output_model()
        if model is not None and (not isinstance(model, type) or not issubclass(model, BaseModel)):
            raise ValueError('Output Schema must be a Pydantic model class')
        return model.model_json_schema(mode='validation') if model else None

    def registration_hash(self):
        template = getattr(self, '_template', None)
        return hash_payload({'manifest': self.describe().model_dump(mode='json'),
            'template': template.model_dump(mode='json') if template else None,
            'input_schema': self.input_schema(), 'output_schema': self.output_schema(),
            'implementation': implementation_record(self)})

    def bind(self, payload: dict | BaseModel, instance_id: str | None = None) -> SkillBinding:
        if self._manifest.skill_type_id is None:
            raise ValueError(f"{self._manifest.id} is not an Engineering Skill")
        report = self.validate(payload)
        if not report.valid or report.normalized_input is None:
            raise SkillValidationError(report)
        input_hash = hash_payload(report.normalized_input)
        sources = input_sources(report.normalized_input)
        registration = self.registration_hash()
        resolved_id = instance_id or f"{self._manifest.id}:{hash_payload([input_hash, sources, registration])[:20]}"
        template = getattr(self, '_template', None)
        return SkillBinding(
            instance_id=resolved_id,
            skill_type_id=self._manifest.skill_type_id,
            implementation_id=self._manifest.id,
            implementation_version=self._manifest.version,
            contract_version=self._manifest.contract_version,
            target_system=self._manifest.target_system or self._manifest.domain,
            verification_status=self._manifest.verification_status,
            input_hash=input_hash,
            model_versions=self._manifest.model_versions,
            skill_type_version=template.version if template else self._manifest.skill_type_version,
            template_contract_version=template.contract_version if template else None,
            model_profile=report.normalized_input.get('model_profile'),
            input_snapshot=report.normalized_input,
            input_sources=sources,
            registration_hash=registration,
        )

    def validate(self, payload: dict | BaseModel) -> ValidationReport:
        try:
            request = payload if isinstance(payload, self.request_model) else self.request_model.model_validate(payload)
        except ValidationError as exc:
            issues = [
                ValidationIssue(
                    code="schema_validation",
                    field=".".join(str(part) for part in error["loc"]),
                    message=error["msg"],
                )
                for error in exc.errors()
            ]
            return ValidationReport(valid=False, issues=issues)

        template = getattr(self, '_template', None)
        conditions = [*(template.applicability_conditions if template else []), *self._manifest.applicability_conditions]
        normalized = request.model_dump(mode='json')
        issues = applicability_issues(normalized, conditions, self._manifest.model_profiles)
        if hasattr(request, 'assessment_mode') and getattr(request, 'assessment_mode') not in self._manifest.assessment_modes:
            issues.append(ValidationIssue(code='model_mode_not_applicable', field='assessment_mode',
                message='Assessment mode is not supported by this implementation', category='model_not_applicable'))
        if not issues:
            try:
                issues.extend(self._validate_request(request))
            except Exception as exc:
                category = classify_failure(exc, 'input_validation').get('category')
                issues.append(ValidationIssue(code='request_engineering_validation', message=f'{type(exc).__name__}: {exc}',
                    category='model_not_applicable' if category == 'model_not_applicable' else 'input_invalid'))
        for contract in self._manifest.consumes:
            value = getattr(request, contract.name, None)
            if value is not None and (contract.field_types or contract.units):
                try: check_contract_value(value.model_dump(mode='json') if isinstance(value, BaseModel) else value, contract)
                except ValueError as exc:
                    issues.append(ValidationIssue(code='input_contract_invalid', field=contract.name, message=str(exc)))
        rule_events = []
        if not any(x.severity == 'error' for x in issues):
            rule_issues, rule_events = run_rules(self, 'input', normalized, normalized)
            issues.extend(rule_issues)
        return ValidationReport(
            valid=not any(issue.severity == "error" for issue in issues),
            issues=issues,
            normalized_input=request.model_dump(mode="json"),
            rule_results=rule_events,
        )

    def _validate_request(self, request: BaseModel) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []

        def inspect(value: object, field: str) -> None:
            if isinstance(value, ArtifactRef):
                if not value.path.exists():
                    issues.append(
                        ValidationIssue(
                            code="artifact_missing",
                            field=field,
                            message=f"Artifact does not exist: {value.path}",
                        )
                    )
                elif value.checksum_sha256 and sha256_file(value.path) != value.checksum_sha256:
                    issues.append(
                        ValidationIssue(
                            code="artifact_checksum_mismatch",
                            field=field,
                            message=f"Artifact checksum mismatch: {value.path}",
                        )
                    )
            elif isinstance(value, BaseModel):
                for child_name in value.__class__.model_fields:
                    inspect(getattr(value, child_name), f"{field}.{child_name}" if field else child_name)
            elif isinstance(value, (list, tuple)):
                for index, child in enumerate(value):
                    inspect(child, f"{field}.{index}")
            elif isinstance(value, dict):
                for child_name, child in value.items():
                    inspect(child, f"{field}.{child_name}")

        inspect(request, "")
        return issues

    def execute(
        self,
        payload: dict | BaseModel,
        context: ExecutionContext | dict | None = None,
    ) -> SkillResult:
        ctx = context if isinstance(context, ExecutionContext) else ExecutionContext.model_validate(context or {})
        run_id = ctx.run_id or self._new_run_id()
        if run_id in {'.','..'} or re.search(r'[\\/:]', run_id):
            raise ValueError('run_id must be a single directory name')
        ctx = ctx.model_copy(update={"run_id": run_id})
        skill_dir = ctx.run_root.resolve() / run_id / self._safe_name(self._manifest.id)
        if (skill_dir / 'result.json').exists() or (skill_dir / 'error.json').exists():
            raise InstanceStoreError('Execution evidence already exists; use a new run_id rather than overwrite historical results')
        skill_dir.mkdir(parents=True, exist_ok=True)
        started = datetime.now(timezone.utc)
        start_clock = time.perf_counter()
        input_hash, checks, request_payload = None, [], {}
        phase = 'input_validation'
        try:
            report = self.validate(payload)
            write_json(skill_dir / 'validation.json', report.model_dump(mode='json'))
            if not report.valid:
                raise SkillValidationError(report)
            request = payload if isinstance(payload, self.request_model) else self.request_model.model_validate(payload)
            request_payload = request.model_dump(mode='json')
            write_json(skill_dir / 'request.json', request_payload)
            input_hash = hash_payload(request_payload)
            phase = 'binding'
            fingerprint = execution_fingerprint(self._manifest.id, request_payload)
            binding = self.bind(request, ctx.skill_instance_id) if self._manifest.skill_type_id is not None else None
            frozen_sources = binding.input_sources if binding else input_sources(request_payload)
            phase = 'cache_lookup'
            reused = self._reuse_result(ctx, fingerprint, input_hash, binding, started)
            if reused is not None:
                if input_sources(request_payload) != frozen_sources:
                    raise InstanceBindingError('Input source contents changed during cached-result materialization')
                write_json(skill_dir / "output_validation.json", reused.output_validation)
                write_json(skill_dir / "result.json", reused.model_dump(mode="json"))
                return reused
            phase = 'engineering_execution'
            with capture_checks() as checks:
                output = self._execute(request, ctx, skill_dir)
            phase = 'output_validation'
            output_issues = self._validate_output(output)
            if input_sources(request_payload) != frozen_sources:
                raise InstanceBindingError('Input source contents changed during execution; no successful result will be recorded')
            rule_issues, output_rules = run_rules(self, 'output', output.data, request_payload)
            output_issues.extend(rule_issues)
            rule_events = [*report.rule_results, *output_rules]
            output_report = ValidationReport(valid=not any(issue.severity == 'error' for issue in output_issues),
                                            issues=output_issues, rule_results=rule_events)
            coverage = declared_coverage(self, rule_events)
            output_validation = {**output_report.model_dump(mode='json'),
                'scope':'Output Schema, declared executable rules, JSON structure, artifact integrity and recorded kernel checks',
                'executed_engineering_checks': checks, 'rule_coverage':coverage,
                'declared_rules':[{'rule':item['rule'], 'status':('declarative_only_not_automatically_executed'
                    if item['status']=='unbound_declaration' else item['status'])}
                    for item in coverage if item['scope']=='implementation']}
            write_json(skill_dir / 'output_validation.json', output_validation)
            if not output_report.valid:
                raise SkillValidationError(output_report)
            phase = 'provenance'
            finished = datetime.now(timezone.utc)
            provenance = SkillProvenance(
                run_id=run_id, skill_id=self._manifest.id, skill_version=self._manifest.version,
                component_kind=self._manifest.kind, skill_type_id=self._manifest.skill_type_id,
                skill_instance_id=binding.instance_id if binding else None,
                assessment_mode=getattr(request,'assessment_mode',None),
                model_versions={**self._manifest.model_versions, **output.model_versions},
                seed=getattr(request,'seed',ctx.seed), input_hash=input_hash,
                started_at=started, finished_at=finished, duration_seconds=time.perf_counter()-start_clock,
                source_files=output.source_files, execution_fingerprint=fingerprint,
                skill_type_version=binding.skill_type_version if binding else None,
                contract_version=self._manifest.contract_version,
                model_profile=request_payload.get('model_profile'), input_sources=input_sources(request_payload),
                implementation=implementation_record(self), model_source=self._manifest.model_source,
                runtime_snapshot=runtime_snapshot())
            result = SkillResult(skill_id=self._manifest.id, skill_version=self._manifest.version,
                run_id=run_id, component_kind=self._manifest.kind, binding=binding, data=output.data,
                artifacts=output.artifacts, warnings=output.warnings, assumptions=output.assumptions,
                provenance=provenance, output_validation=output_validation)
            phase = 'result_persistence'
            write_json(skill_dir / 'result.json', result.model_dump(mode='json'))
            return result
        except Exception as exc:
            if not getattr(exc, 'phase', None):
                exc.phase = phase
            write_json(
                skill_dir / "error.json",
                {
                    "skill_id": self._manifest.id,
                    "run_id": run_id,
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                    "input_hash": input_hash,
                    "phase": phase,
                    "classification": classify_failure(exc, phase),
                    "model_profile": request_payload.get('model_profile'),
                    "executed_engineering_checks": checks,
                    "rule_results": locals().get('rule_events', locals().get('report').rule_results if locals().get('report') else []),
                },
            )
            raise

    def _reuse_result(self, ctx, fingerprint, input_hash, binding, started) -> SkillResult | None:
        if not ctx.reuse_from_run_id or ctx.reuse_from_run_id == ctx.run_id:
            return None
        if self._manifest.id == "resilience_result_reporting":
            return None
        root = ctx.run_root.resolve()
        previous = (root / ctx.reuse_from_run_id / self._safe_name(self._manifest.id) / "result.json").resolve()
        if not previous.is_relative_to(root) or not previous.is_file():
            return None
        result = SkillResult.model_validate_json(previous.read_text(encoding="utf-8"))
        if (result.provenance.execution_fingerprint != fingerprint
                or not result.output_validation.get("valid") or result.provenance.seed is None):
            return None
        if any(not item.path.is_file() or not item.checksum_sha256
               or sha256_file(item.path) != item.checksum_sha256 for item in result.artifacts):
            return None
        # A historical cache must still satisfy today's explicit Output Schema.
        # Missing/changed metric contracts trigger recomputation, never relabelling.
        if self._validate_output(SkillExecutionOutput(data=result.data, artifacts=result.artifacts)):
            return None
        # Each run owns its artifacts; deleting a parent run must not break a revision.
        destination = root / str(ctx.run_id) / self._safe_name(self._manifest.id) / "artifacts" / "reused"
        destination.mkdir(parents=True, exist_ok=True)
        paths = {}
        for artifact in result.artifacts:
            source_path = artifact.path
            target = destination / f"{artifact.checksum_sha256[:12]}-{source_path.name}"
            shutil.copy2(source_path, target)
            if sha256_file(target) != artifact.checksum_sha256:
                raise ValueError("Cached artifact changed during materialization")
            paths[str(source_path)] = str(target)
            artifact.path = target

        def rebase(value):
            if isinstance(value, dict):
                return {key: rebase(item) for key, item in value.items()}
            if isinstance(value, list):
                return [rebase(item) for item in value]
            return paths.get(value, value) if isinstance(value, str) else value

        result.data = rebase(result.data)
        result.run_id = str(ctx.run_id)
        result.binding = binding
        result.provenance = result.provenance.model_copy(update={
            "run_id": str(ctx.run_id), "input_hash": input_hash,
            "reused_from_run_id": ctx.reuse_from_run_id, "started_at": started,
            "finished_at": datetime.now(timezone.utc), "duration_seconds": 0.0,
            "skill_instance_id": binding.instance_id if binding else None,
            "skill_type_version": binding.skill_type_version if binding else None,
            "input_sources": binding.input_sources if binding else result.provenance.input_sources,
            "runtime_snapshot": runtime_snapshot(),
        })
        result.output_validation = {**result.output_validation, "reuse_artifact_integrity_checked": True, "artifacts_materialized_in_current_run": True}
        return result

    def _validate_output(self, output: SkillExecutionOutput) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []
        model = self.resolved_output_model()
        if model is not None:
            try: model.model_validate(output.data)
            except ValidationError as exc:
                issues.append(ValidationIssue(code='output_schema_validation', field='data', message=str(exc), category='result_invalid'))
        for contract in self._manifest.produces:
            try:
                from .contracts import value_at
                check_contract_value(value_at(output.data, contract.source_field or contract.name), contract)
            except (KeyError, ValueError) as exc:
                issues.append(ValidationIssue(code='output_contract_invalid', field=contract.name, message=str(exc), category='result_invalid'))
        try:
            json.dumps(output.data, allow_nan=False)
        except (ValueError, TypeError) as exc:
            issues.append(ValidationIssue(code="invalid_output_json", field="data", message=str(exc)))
        for artifact in output.artifacts:
            if not artifact.path.is_file():
                issues.append(ValidationIssue(code="output_artifact_missing", field="artifacts", message=str(artifact.path)))
            elif artifact.checksum_sha256 and sha256_file(artifact.path) != artifact.checksum_sha256:
                issues.append(ValidationIssue(code="output_artifact_checksum", field="artifacts", message=str(artifact.path)))
        return [i.model_copy(update={'category':'result_invalid'}) for i in issues]

    @abstractmethod
    def _execute(
        self,
        request: BaseModel,
        context: ExecutionContext,
        skill_dir: Path,
    ) -> SkillExecutionOutput:
        raise NotImplementedError

    @staticmethod
    def _new_run_id() -> str:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"{stamp}-{uuid.uuid4().hex[:10]}"

    @staticmethod
    def _safe_name(value: str) -> str:
        return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


class EngineeringSkill(ExecutableComponent):
    expected_kind = ComponentKind.ENGINEERING_SKILL


class SupportComponent(ExecutableComponent):
    expected_kind = ComponentKind.SUPPORT_COMPONENT


class WorkflowComponent(ExecutableComponent):
    expected_kind = ComponentKind.WORKFLOW
