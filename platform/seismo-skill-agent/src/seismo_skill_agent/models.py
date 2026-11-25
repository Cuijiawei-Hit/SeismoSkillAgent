from __future__ import annotations

from enum import Enum
from typing import Any, Literal, TypedDict

from engineering_skills.core.models import SkillDAGPlan
from pydantic import BaseModel, Field, model_validator

from .expert_memory import FeedbackMemoryDraft


AssessmentModeValue = Literal["predictive"]
ReviewerRoleValue = Literal["engineer", "domain_expert", "emergency_manager"]
OutputLanguageValue = Literal["zh-CN", "en-US"]


class AgentStatus(str, Enum):
    RECEIVED = "received"
    ANALYZED = "analyzed"
    PLANNED = "planned"
    NEEDS_INPUT = "needs_input"
    AWAITING_APPROVAL = "awaiting_approval"
    EXECUTING = "executing"
    AWAITING_RESULT_REVIEW = "awaiting_result_review"
    PROCESSING_FEEDBACK = "processing_feedback"
    AWAITING_RECOVERY = "awaiting_recovery"
    ANSWERING = "answering"
    SUCCEEDED = "succeeded"
    REJECTED = "rejected"
    FAILED = "failed"


class TaskAnalysis(BaseModel):
    task_type: Literal["engineering_computation", "knowledge_query"] = (
        "engineering_computation"
    )
    objective: str
    assessment_mode: AssessmentModeValue | None = None
    recommended_component_id: str | None = None
    selected_skill_ids: list[str] = Field(default_factory=list)
    domain: str | None = "urban_power_resilience"
    target_system: str | None = "power_system"
    requested_capabilities: list[str] = Field(default_factory=list)
    extracted_parameters: dict[str, Any] = Field(default_factory=dict)
    requested_outputs: list[str] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)
    knowledge_queries: list[str] = Field(default_factory=list)
    engineering_scope: str


class KnowledgeEvidence(BaseModel):
    evidence_id: str
    title: str
    source_path: str
    section: str | None = None
    content: str
    score: float = Field(default=0.0, ge=0.0)
    source_type: str | None = None
    source_url: str | None = None
    locator: str | None = None
    citation: str | None = None
    retrieval_scores: dict[str, float] = Field(default_factory=dict)
    evidence_use: Literal["advisory_only"] = "advisory_only"
    index_revision: str | None = None
    source_sha256: str | None = None
    document_version: str | None = None
    document_status: Literal["current", "superseded", "withdrawn", "historical", "unknown"] = "unknown"
    document_status_text: str | None = None
    effective_from: str | None = None
    effective_until: str | None = None
    time_validity: Literal["within_declared_bounds", "not_yet_effective", "expired", "unknown"] = "unknown"
    applicability: str | None = None


class KnowledgeReviewCheck(BaseModel):
    evidence_id: str
    use: Literal["check_applicability", "verify_primary_source"] = "check_applicability"
    source_excerpt: str = Field(min_length=12, max_length=500)
    review_question: str = Field(min_length=1, max_length=500)


class ExecutionPlan(BaseModel):
    component_id: str
    input_profile_id: str | None = None
    task_objective: str | None = None
    requested_skill_ids: list[str] = Field(default_factory=list)
    selected_skill_ids: list[str] = Field(default_factory=list)
    target_skill_ids: list[str] = Field(default_factory=list)
    composition_mode: Literal["single", "registry_dag", "workflow_component"] = "single"
    dag: SkillDAGPlan | None = None
    request_payload: dict[str, Any]
    rationale: str
    assumptions: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)
    knowledge_checks: list[KnowledgeReviewCheck] = Field(default_factory=list, max_length=6)
    requires_human_approval: bool = True
    reuse_from_run_id: str | None = None
    feedback_route: str | None = None
    feedback_changes: dict[str, Any] = Field(default_factory=dict)

class ValidationIssueView(BaseModel):
    code: str
    field: str
    message: str
    severity: str
    category: str = 'input_invalid'


class PlanValidation(BaseModel):
    valid: bool
    normalized_input: dict[str, Any] | None = None
    issues: list[ValidationIssueView] = Field(default_factory=list)
    registered_ok: bool = True
    type_ok: bool = True
    schema_ok: bool = True
    dependency_ok: bool = True
    dag_ok: bool = True
    binding_ok: bool = True


class HumanDecision(BaseModel):
    action: Literal["approve", "edit", "reject"]
    payload_patch: dict[str, Any] = Field(default_factory=dict)
    target_skill_ids: list[str] | None = None
    feedback: str | None = None
    reviewer: str = "local-user"
    reviewer_role: ReviewerRoleValue = "engineer"

    @model_validator(mode="after")
    def validate_edit(self) -> "HumanDecision":
        if self.action == "edit" and not self.payload_patch and self.target_skill_ids is None:
            raise ValueError(
                "payload_patch or target_skill_ids is required when action=edit"
            )
        return self


class ExpertReviewDecision(BaseModel):
    action: Literal["accept", "revise", "reject"]
    payload_patch: dict[str, Any] = Field(default_factory=dict)
    target_skill_ids: list[str] | None = None
    feedback: str | None = None
    reviewer: str = "local-user"
    reviewer_role: ReviewerRoleValue = "domain_expert"

    @model_validator(mode="after")
    def validate_revision(self) -> "ExpertReviewDecision":
        if (
            self.action == "revise"
            and not self.payload_patch
            and self.target_skill_ids is None
            and not self.feedback
        ):
            raise ValueError(
                "feedback, payload_patch or target_skill_ids is required when action=revise"
            )
        return self


class RecoveryDecision(BaseModel):
    action: Literal["retry", "edit", "reject"]
    payload_patch: dict[str, Any] = Field(default_factory=dict)
    feedback: str | None = None
    reviewer: str = "local-user"
    reviewer_role: ReviewerRoleValue = "engineer"

    @model_validator(mode="after")
    def validate_edit(self) -> "RecoveryDecision":
        if self.action == "edit" and not self.payload_patch:
            raise ValueError("payload_patch is required when action=edit")
        return self


class ExpertFeedbackResolution(BaseModel):
    feedback_summary: str
    can_execute: bool = True
    payload_patch: dict[str, Any] = Field(default_factory=dict)
    target_skill_ids: list[str] | None = None
    knowledge_queries: list[str] = Field(default_factory=list)
    comparison_focus: list[str] = Field(default_factory=list)
    rationale: str
    clarification_question: str | None = None
    feedback_kind: Literal["engineering_revision", "presentation_only", "memory_only"] = "engineering_revision"
    presentation_instructions: str | None = Field(default=None, max_length=3000)
    feedback_items: list[FeedbackMemoryDraft] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def validate_payload_patch(self) -> "ExpertFeedbackResolution":
        if self.feedback_kind == "memory_only":
            if self.can_execute or self.payload_patch or self.target_skill_ids is not None or self.presentation_instructions:
                raise ValueError("Memory-only feedback cannot change a plan or start a run")
            if not self.feedback_items:
                raise ValueError("Memory-only feedback requires at least one source-linked item")
            return self
        if self.feedback_kind == "presentation_only":
            from .feedback_routing import PRESENTATION_FIELDS
            if self.target_skill_ids is not None or set(self.payload_patch) - PRESENTATION_FIELDS:
                raise ValueError("Presentation-only feedback cannot alter numerical inputs or target Skills")
            if not self.presentation_instructions and not self.payload_patch:
                raise ValueError("Presentation-only feedback needs explicit presentation instructions")
        if self.can_execute and not self.payload_patch and self.target_skill_ids is None and self.feedback_kind != "presentation_only":
            raise ValueError(
                "Executable expert feedback must contain a payload patch or target Skills"
            )
        if not self.can_execute and not self.clarification_question:
            raise ValueError("clarification_question is required when can_execute=false")
        return self


class IterationRecord(BaseModel):
    iteration: int = Field(ge=1)
    run_id: str
    plan: ExecutionPlan
    skill_result: dict[str, Any]
    interpretation: str
    expert_decision: ExpertReviewDecision | None = None
    completed_at: str | None = None
    reviewed_at: str | None = None


class AgentOutcome(BaseModel):
    session_id: str
    status: AgentStatus
    final_answer: str
    plan: ExecutionPlan | None = None
    skill_result: dict[str, Any] | None = None
    iteration_history: list[IterationRecord] = Field(default_factory=list)
    knowledge_evidence: list[KnowledgeEvidence] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class FollowUpRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    actor: str = Field(default="local-user", min_length=1, max_length=120)
    actor_role: ReviewerRoleValue = "engineer"


class SeismoSkillAgentState(TypedDict, total=False):
    session_id: str
    user_message: str
    request_context: dict[str, Any]
    output_language: OutputLanguageValue
    status: str
    task_analysis: dict[str, Any]
    selection_trace: dict[str, Any]
    knowledge_evidence: list[dict[str, Any]]
    expert_memory_scope: dict[str, str]
    retrieved_experiences: list[dict[str, Any]]
    plan: dict[str, Any]
    validation: dict[str, Any]
    human_decision: dict[str, Any]
    approved_plan_hash: str
    result_review_decision: dict[str, Any]
    feedback_resolution: dict[str, Any]
    recovery_decision: dict[str, Any]
    skill_error: dict[str, Any]
    skill_result: dict[str, Any]
    current_interpretation: str
    iteration: int
    iteration_history: list[dict[str, Any]]
    execution_attempt: int
    final_answer: str
    errors: list[str]
    validation_repair_attempts: int
    scope_clarification_required: bool
