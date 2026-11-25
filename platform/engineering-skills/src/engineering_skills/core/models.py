from __future__ import annotations

from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AssessmentMode(str, Enum):
    PREDICTIVE = "predictive"
    RAPID = "rapid"
    HYBRID = "hybrid"


class ComponentKind(str, Enum):
    ENGINEERING_SKILL = "engineering_skill"
    SUPPORT_COMPONENT = "support_component"
    WORKFLOW = "workflow"
    COMPOSITION = "composition"


class VerificationStatus(str, Enum):
    RESEARCH_PROTOTYPE = "research_prototype"
    BENCHMARKED = "benchmarked"
    VERIFIED = "verified"


class WarningSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    HIGH = "high"


class SkillWarning(BaseModel):
    code: str
    severity: WarningSeverity = WarningSeverity.WARNING
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ValidationIssue(BaseModel):
    code: str
    message: str
    field: str | None = None
    severity: Literal["error", "warning"] = "error"
    category: Literal["input_invalid", "model_not_applicable", "result_invalid"] = "input_invalid"


class ValidationReport(BaseModel):
    valid: bool
    issues: list[ValidationIssue] = Field(default_factory=list)
    normalized_input: dict[str, Any] | None = None
    rule_results: list[dict[str, Any]] = Field(default_factory=list)


class ArtifactRef(BaseModel):
    path: Path
    media_type: str
    description: str
    checksum_sha256: str | None = None
    size_bytes: int | None = None
    units: dict[str, str] = Field(default_factory=dict)
    units_source: str | None = None


class SkillRuleDefinition(BaseModel):
    """An explicit Python validator binding, never an interpreted prose rule."""

    rule_id: str = Field(min_length=1)
    phase: Literal['input', 'output'] = 'output'
    validator: str | None = None
    description: str = ''
    covers: list[str] = Field(default_factory=list)
    profiles: list[str] = Field(default_factory=list)
    tests: list[str] = Field(default_factory=list)
    status: Literal['executable', 'unimplemented'] = 'executable'
    reason: str = ''

    @model_validator(mode='after')
    def validate_binding(self):
        if self.status == 'executable' and (not self.validator or ':' not in self.validator):
            raise ValueError('An executable rule requires module:callable validator')
        if self.status == 'unimplemented' and not self.reason:
            raise ValueError('An unimplemented rule requires an explicit reason')
        return self


class ApplicabilityCondition(BaseModel):
    """A declarative, explicitly evaluated condition; never interpreted by an LLM."""

    field: str
    operator: Literal["eq", "in", "ge", "le", "present"]
    expected: Any = None
    description: str = ""


class SkillTypeDefinition(BaseModel):
    id: str
    version: str
    name: str
    description: str
    domain: str
    task: str
    input_semantics: list[str]
    output_semantics: list[str]
    invariant_rules: list[str] = Field(default_factory=list)
    applicability: list[str] = Field(default_factory=list)
    non_goals: list[str] = Field(default_factory=list)
    contract_version: str = "1.0.0"
    consumes: list[SkillDataContract] = Field(default_factory=list)
    produces: list[SkillDataContract] = Field(default_factory=list)
    dependency_type_ids: list[str] = Field(default_factory=list)
    applicability_conditions: list[ApplicabilityCondition] = Field(default_factory=list)
    executable_rules: list[SkillRuleDefinition] = Field(default_factory=list)

    @model_validator(mode='after')
    def validate_unique_bindings(self):
        ids = [r.rule_id for r in self.executable_rules]
        if len(ids) != len(set(ids)):
            raise ValueError('Template executable rule IDs must be unique')
        for contracts in (self.consumes, self.produces):
            names = [c.name for c in contracts]
            if len(names) != len(set(names)):
                raise ValueError('Template contract names must be unique per direction')
        return self


class SkillDataContract(BaseModel):
    """Machine-readable semantic contract used to compose registered components."""

    name: str = Field(min_length=1)
    type_id: str = Field(min_length=1)
    description: str = ""
    required: bool = True
    source_field: str | None = None
    excludes: list[str] = Field(default_factory=list)
    contract_version: str = "1.0.0"
    field_types: dict[str, Literal["number", "integer", "string", "array", "object", "boolean"]] = Field(default_factory=dict)
    units: dict[str, str] = Field(default_factory=dict)
    semantic_type_id: str | None = None


class SkillManifest(BaseModel):
    id: str
    version: str
    name: str
    description: str
    kind: ComponentKind
    skill_type_id: str | None = None
    skill_type_version: str | None = None
    contract_version: str = "1.0.0"
    target_system: str | None = None
    instance_scope: str = "runtime_bound"
    verification_status: VerificationStatus = VerificationStatus.RESEARCH_PROTOTYPE
    domain: str
    capability: str
    stage: str
    assessment_modes: list[AssessmentMode]
    inputs: list[str]
    outputs: list[str]
    dependencies: list[str] = Field(default_factory=list)
    consumes: list[SkillDataContract] = Field(default_factory=list)
    produces: list[SkillDataContract] = Field(default_factory=list)
    default_targets: list[str] = Field(default_factory=list)
    applicability: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    model_versions: dict[str, str] = Field(default_factory=dict)
    validation_rules: list[str] = Field(default_factory=list)
    references: list[str] = Field(default_factory=list)
    long_running: bool = False
    model_profiles: list[str] = Field(default_factory=list)
    applicability_conditions: list[ApplicabilityCondition] = Field(default_factory=list)
    model_source: dict[str, Any] = Field(default_factory=lambda: {
        "status": "pending_author_confirmation", "references": [],
        "note": "Original model attribution is not inferred from wrapper authorship."})
    rule_coverage: list[dict[str, str]] = Field(default_factory=list)
    executable_rules: list[SkillRuleDefinition] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_classification(self) -> "SkillManifest":
        rule_ids = [r.rule_id for r in self.executable_rules]
        if len(rule_ids) != len(set(rule_ids)):
            raise ValueError('Implementation executable rule IDs must be unique')
        if self.kind == ComponentKind.ENGINEERING_SKILL and not self.skill_type_id:
            raise ValueError("Engineering Skill manifests must declare skill_type_id")
        for label, contracts in (
            ("consumes", self.consumes),
            ("produces", self.produces),
        ):
            names = [item.name for item in contracts]
            if len(names) != len(set(names)):
                raise ValueError(f"{label} contract names must be unique")
        if self.kind != ComponentKind.WORKFLOW and self.default_targets:
            raise ValueError("Only workflow manifests may declare default_targets")
        return self


class ContractBindingSource(str, Enum):
    REQUEST = "request"
    NODE = "node"


class SkillInputBinding(BaseModel):
    target_field: str
    type_id: str
    source: ContractBindingSource
    source_field: str
    source_node_id: str | None = None
    excludes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_source(self) -> "SkillInputBinding":
        if self.source == ContractBindingSource.NODE and not self.source_node_id:
            raise ValueError("Node bindings must declare source_node_id")
        if self.source == ContractBindingSource.REQUEST and self.source_node_id is not None:
            raise ValueError("Request bindings cannot declare source_node_id")
        return self


class SkillDAGEdge(BaseModel):
    source: str
    target: str
    relation: Literal["declared_dependency", "data_contract"]
    contract_name: str | None = None
    type_id: str | None = None


class SkillDAGNode(BaseModel):
    node_id: str
    component_id: str
    component_kind: ComponentKind
    stage: str
    depends_on: list[str] = Field(default_factory=list)
    input_bindings: list[SkillInputBinding] = Field(default_factory=list)
    produces: list[SkillDataContract] = Field(default_factory=list)
    implementation_version: str | None = None
    skill_type_version: str | None = None
    contract_version: str | None = None
    registration_hash: str | None = None


class SkillDAGPlan(BaseModel):
    schema_version: str = "1.1"
    composition_source: Literal["workflow_template", "skill_registry"] = (
        "workflow_template"
    )
    template_id: str | None = None
    assessment_mode: str | None = None
    target_component_ids: list[str]
    execution_order: list[str]
    nodes: list[SkillDAGNode]
    edges: list[SkillDAGEdge] = Field(default_factory=list)


class SkillDAGValidationReport(BaseModel):
    valid: bool
    registered_ok: bool = True
    type_ok: bool = True
    schema_ok: bool = True
    dependency_ok: bool = True
    dag_ok: bool = True
    binding_ok: bool = True
    issues: list[ValidationIssue] = Field(default_factory=list)


class SkillBinding(BaseModel):
    instance_id: str
    skill_type_id: str
    implementation_id: str
    implementation_version: str
    contract_version: str
    target_system: str
    verification_status: VerificationStatus
    input_hash: str
    model_versions: dict[str, str] = Field(default_factory=dict)
    skill_type_version: str | None = None
    template_contract_version: str | None = None
    model_profile: str | None = None
    input_snapshot: dict[str, Any] = Field(default_factory=dict)
    input_sources: dict[str, str] = Field(default_factory=dict)
    registration_hash: str | None = None


class ExecutionContext(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    run_root: Path = Path("runs")
    run_id: str | None = None
    parent_run_id: str | None = None
    skill_instance_id: str | None = None
    seed: int | None = None
    reuse_from_run_id: str | None = None


class SkillProvenance(BaseModel):
    run_id: str
    skill_id: str
    skill_version: str
    component_kind: ComponentKind
    skill_type_id: str | None = None
    skill_instance_id: str | None = None
    assessment_mode: str | None = None
    model_versions: dict[str, Any] = Field(default_factory=dict)
    seed: int | None = None
    input_hash: str
    started_at: datetime
    finished_at: datetime
    duration_seconds: float
    source_files: list[str] = Field(default_factory=list)
    reused_from_run_id: str | None = None
    execution_fingerprint: str | None = None
    skill_type_version: str | None = None
    contract_version: str | None = None
    model_profile: str | None = None
    input_sources: dict[str, str] = Field(default_factory=dict)
    implementation: dict[str, Any] = Field(default_factory=dict)
    model_source: dict[str, Any] = Field(default_factory=dict)
    runtime_snapshot: dict[str, Any] = Field(default_factory=dict)


class SkillExecutionOutput(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[ArtifactRef] = Field(default_factory=list)
    warnings: list[SkillWarning] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    model_versions: dict[str, Any] = Field(default_factory=dict)
    source_files: list[str] = Field(default_factory=list)


class SkillResult(BaseModel):
    status: Literal["succeeded"] = "succeeded"
    skill_id: str
    skill_version: str
    run_id: str
    component_kind: ComponentKind
    binding: SkillBinding | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[ArtifactRef] = Field(default_factory=list)
    warnings: list[SkillWarning] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    provenance: SkillProvenance
    output_validation: dict[str, Any] = Field(default_factory=dict)


SkillTypeDefinition.model_rebuild()
