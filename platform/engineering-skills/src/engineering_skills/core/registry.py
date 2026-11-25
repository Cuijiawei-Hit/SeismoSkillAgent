from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Iterable

from pydantic import BaseModel

from .base import ExecutableComponent
from .contracts import latest_version, version_key, template_contract_compatible, applicability_issues
from .exceptions import (SkillNotFoundError, SkillRegistrationError, InstanceBindingError, classify_failure)
from .instances import InstanceStore
from .rules import component_rules, resolve_validator, declared_coverage
from .models import (
    ComponentKind,
    ExecutionContext,
    SkillBinding,
    SkillManifest,
    SkillResult,
    SkillTypeDefinition,
    ValidationReport,
)


class SkillRegistry:
    def __init__(self, skills: Iterable[ExecutableComponent] | None = None, *, instance_store: Path | None = None) -> None:
        self._skills: dict[str, dict[str, ExecutableComponent]] = defaultdict(dict)
        self._skill_types: dict[str, dict[str, SkillTypeDefinition]] = defaultdict(dict)
        self._instances: dict[str, SkillBinding] = {}
        self.instance_store = InstanceStore(instance_store) if instance_store is not None else None
        for skill in skills or []:
            self.register(skill)

    def register_type(self, skill_type: SkillTypeDefinition) -> None:
        try:
            self._register_type(skill_type)
        except (ValueError, TypeError, ImportError, AttributeError) as exc:
            raise SkillRegistrationError(str(exc)) from exc

    def _register_type(self, skill_type: SkillTypeDefinition) -> None:
        version_key(skill_type.version)
        version_key(skill_type.contract_version)
        for contract in [*skill_type.consumes, *skill_type.produces]:
            version_key(contract.contract_version)
        if skill_type.version in self._skill_types[skill_type.id]:
            raise ValueError(f"Skill Type already registered: {skill_type.id}@{skill_type.version}")
        self._skill_types[skill_type.id][skill_type.version] = skill_type.model_copy(deep=True)

    def register(self, skill: ExecutableComponent) -> None:
        try:
            self._register(skill)
        except (ValueError, TypeError, ImportError, AttributeError) as exc:
            raise SkillRegistrationError(str(exc)) from exc

    def _register(self, skill: ExecutableComponent) -> None:
        manifest = skill.describe()
        version_key(manifest.version)
        version_key(manifest.contract_version)
        if not isinstance(skill.request_model, type) or not issubclass(skill.request_model, BaseModel):
            raise ValueError('Registered implementation must provide a Pydantic Request Schema')
        schema = skill.input_schema()
        output_schema = skill.output_schema()
        if manifest.kind == ComponentKind.ENGINEERING_SKILL and not output_schema:
            raise ValueError('Registered Engineering Skill must provide a Pydantic Output Schema')
        for contract in [*manifest.consumes, *manifest.produces]:
            version_key(contract.contract_version)
        for contract in manifest.consumes:
            if contract.name not in schema.get('properties', {}):
                raise ValueError(f'Contract input {contract.name} is absent from the Request Schema')
        if output_schema:
            for contract in manifest.produces:
                first_field = (contract.source_field or contract.name).split('.')[0]
                if first_field not in output_schema.get('properties', {}):
                    raise ValueError(f'Contract output {first_field} is absent from the Output Schema')
        if manifest.kind == ComponentKind.ENGINEERING_SKILL and manifest.skill_type_id not in self._skill_types:
            raise ValueError(f"Unknown Skill Type for {manifest.id}: {manifest.skill_type_id}")
        if manifest.version in self._skills[manifest.id]:
            raise ValueError(f"Skill already registered: {manifest.id}@{manifest.version}")
        if manifest.kind == ComponentKind.ENGINEERING_SKILL:
            template = self.describe_type(manifest.skill_type_id, manifest.skill_type_version)
            for required, offered, direction in ((template.consumes, manifest.consumes, 'input'), (template.produces, manifest.produces, 'output')):
                for requirement in required:
                    if not any(x.name == requirement.name and template_contract_compatible(x, requirement) for x in offered):
                        raise ValueError(f'Implementation {manifest.id} violates Template {direction} contract {requirement.name}')
            skill._template = template
            skill._manifest.skill_type_version = template.version
        for rule in component_rules(skill):
            if rule.status == 'executable':
                resolve_validator(rule.validator)
        skill._manifest.rule_coverage = declared_coverage(skill)
        self._skills[manifest.id][manifest.version] = skill

    def latest_components(self):
        return [self.describe(k) for k in sorted(self._skills)]

    def list_skills(
        self,
        domain: str | None = None,
        capability: str | None = None,
        stage: str | None = None,
        assessment_mode: str | None = None,
    ) -> list[SkillManifest]:
        manifests = [skill.describe() for versions in self._skills.values() for skill in versions.values()]
        manifests = [item for item in manifests if item.kind == ComponentKind.ENGINEERING_SKILL]
        if domain is not None:
            manifests = [item for item in manifests if item.domain == domain]
        if capability is not None:
            manifests = [item for item in manifests if item.capability == capability]
        if stage is not None:
            manifests = [item for item in manifests if item.stage == stage]
        if assessment_mode is not None:
            manifests = [item for item in manifests if assessment_mode in {mode.value for mode in item.assessment_modes}]
        return sorted(manifests, key=lambda item: (item.domain, item.stage, item.id, item.version))

    def list_components(self, kind: ComponentKind | str | None = None) -> list[SkillManifest]:
        manifests = [skill.describe() for versions in self._skills.values() for skill in versions.values()]
        if kind is not None:
            selected = kind if isinstance(kind, ComponentKind) else ComponentKind(kind)
            manifests = [item for item in manifests if item.kind == selected]
        return sorted(manifests, key=lambda item: (item.kind.value, item.domain, item.stage, item.id, item.version))

    def list_skill_types(self, domain: str | None = None) -> list[SkillTypeDefinition]:
        items = [item for versions in self._skill_types.values() for item in versions.values()]
        if domain is not None:
            items = [item for item in items if item.domain == domain]
        return sorted(items, key=lambda item: (item.domain, item.id, item.version))

    def describe_type(self, type_id: str, version: str | None = None) -> SkillTypeDefinition:
        versions = self._skill_types.get(type_id)
        if not versions:
            raise SkillNotFoundError(f"Unknown Skill Type: {type_id}")
        selected = version or latest_version(versions)
        try:
            return versions[selected].model_copy(deep=True)
        except KeyError as exc:
            raise SkillNotFoundError(f"Unknown Skill Type version: {type_id}@{selected}") from exc

    def list_instances(self, type_id: str) -> list[SkillManifest]:
        """Compatibility alias for list_implementations; not runtime bindings."""
        return self.list_implementations(type_id)

    def list_implementations(self, type_id: str, context: dict | None = None) -> list[SkillManifest]:
        self.describe_type(type_id)
        values = [item for item in self.list_skills() if item.skill_type_id == type_id]
        if context is not None:
            values = [item for item in values if not self.applicability(item.id, context, item.version)]
        return values

    def applicability(self, skill_id: str, context: dict, version: str | None = None):
        skill = self._get(skill_id, version)
        template = getattr(skill, '_template', None)
        context = dict(context)
        for name, field in skill.input_schema().get('properties', {}).items():
            if name not in context and 'default' in field:
                context[name] = field['default']
        issues = applicability_issues(context, [*(template.applicability_conditions if template else []),
                      *skill.describe().applicability_conditions], skill.describe().model_profiles)
        mode = context.get('assessment_mode')
        if mode is not None and mode not in {x.value for x in skill.describe().assessment_modes}:
            from .models import ValidationIssue
            issues.append(ValidationIssue(code='model_mode_not_applicable', field='assessment_mode',
                message='Unsupported assessment mode', category='model_not_applicable'))
        return issues

    def describe(self, skill_id: str, version: str | None = None) -> SkillManifest:
        return self._get(skill_id, version).describe()

    def input_schema(self, skill_id: str, version: str | None = None) -> dict:
        return self._get(skill_id, version).input_schema()

    def output_schema(self, skill_id: str, version: str | None = None) -> dict | None:
        return self._get(skill_id, version).output_schema()

    def validate(self, skill_id: str, payload: dict | BaseModel, version: str | None = None) -> ValidationReport:
        return self._get(skill_id, version).validate(payload)

    def bind(
        self,
        skill_id: str,
        payload: dict | BaseModel,
        instance_id: str | None = None,
        version: str | None = None,
    ) -> SkillBinding:
        binding = self._get(skill_id, version).bind(payload, instance_id)
        if binding.instance_id in self._instances and self._instances[binding.instance_id] != binding:
            raise InstanceBindingError('Instance ID is already bound to different inputs or implementation')
        if self.instance_store is not None:
            self.instance_store.save(binding)
        self._instances[binding.instance_id] = binding.model_copy(deep=True)
        return binding

    def list_bound_instances(self):
        values = {x.instance_id:x for x in self.instance_store.list_bindings()} if self.instance_store is not None else {}
        values.update(self._instances)
        return [values[key].model_copy(deep=True) for key in sorted(values)]

    def load_instance(self, instance_id: str) -> SkillBinding:
        binding = self._instances.get(instance_id)
        if binding is None and self.instance_store is not None:
            binding = self.instance_store.load(instance_id)
        if binding is None:
            raise SkillNotFoundError(f'Unknown runtime instance: {instance_id}')
        self._instances[instance_id] = binding.model_copy(deep=True)
        return binding.model_copy(deep=True)

    def instance_executions(self, instance_id: str):
        return self.instance_store.executions(instance_id) if self.instance_store is not None else []

    def execute_instance(self, binding: SkillBinding, context: ExecutionContext | dict | None = None):
        from .provenance import input_sources
        from .artifacts import hash_payload
        skill = self._get(binding.implementation_id, binding.implementation_version)
        expected = skill.bind(binding.input_snapshot, binding.instance_id)
        if (binding != expected
            or (binding.instance_id in self._instances and self._instances[binding.instance_id] != binding)
            or binding.registration_hash != skill.registration_hash()
            or binding.skill_type_id != skill.describe().skill_type_id
            or binding.skill_type_version != skill.describe().skill_type_version
            or binding.input_hash != hash_payload(binding.input_snapshot)
            or binding.input_sources != input_sources(binding.input_snapshot)):
            raise InstanceBindingError('Instance binding no longer matches Template, implementation or input contents')
        ctx = context if isinstance(context, ExecutionContext) else ExecutionContext.model_validate(context or {})
        return self.execute(binding.implementation_id, binding.input_snapshot,
            ctx.model_copy(update={'skill_instance_id': binding.instance_id}), version=binding.implementation_version)

    def execute(
        self,
        skill_id: str,
        payload: dict | BaseModel,
        context: ExecutionContext | dict | None = None,
        version: str | None = None,
    ) -> SkillResult:
        skill = self._get(skill_id, version)
        ctx = context if isinstance(context, ExecutionContext) else ExecutionContext.model_validate(context or {})
        ctx = ctx.model_copy(update={'run_id':ctx.run_id or skill._new_run_id()})
        binding = None
        if (self.instance_store is not None or ctx.skill_instance_id is not None) and skill.describe().kind == ComponentKind.ENGINEERING_SKILL:
            binding = self.bind(skill_id, payload, ctx.skill_instance_id, version)
        try:
            result = skill.execute(payload, ctx)
        except Exception as exc:
            if binding is not None and self.instance_store is not None:
                self.instance_store.record_execution(binding, {'run_id':ctx.run_id,'status':'failed',
                    'classification':classify_failure(exc), 'error_type':type(exc).__name__,
                    'evidence_file':str(ctx.run_root.resolve()/ctx.run_id/skill._safe_name(skill_id)/'error.json')})
            raise
        if result.binding:
            self._instances[result.binding.instance_id] = result.binding.model_copy(deep=True)
            if self.instance_store is not None:
                self.instance_store.record_execution(result.binding, {'run_id':result.run_id,'status':'succeeded',
                    'evidence_file':str(ctx.run_root.resolve()/result.run_id/skill._safe_name(skill_id)/'result.json'),
                    'input_hash':result.provenance.input_hash,
                    'execution_fingerprint':result.provenance.execution_fingerprint})
        return result

    def _get(self, skill_id: str, version: str | None) -> ExecutableComponent:
        versions = self._skills.get(skill_id)
        if not versions:
            raise SkillNotFoundError(f"Unknown skill: {skill_id}")
        selected = version or latest_version(versions)
        try:
            return versions[selected]
        except KeyError as exc:
            raise SkillNotFoundError(f"Unknown skill version: {skill_id}@{selected}") from exc
