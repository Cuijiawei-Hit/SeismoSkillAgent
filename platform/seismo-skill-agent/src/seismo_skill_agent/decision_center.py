from __future__ import annotations

import json
import re
import sqlite3
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Literal

from langgraph.types import Command, interrupt
from engineering_skills.core.exceptions import SkillDAGCompilationError, classify_failure

from .audit import AuditStore, runtime_configuration_snapshot
from .config import AgentSettings
from .expert_memory import ExpertMemoryStore
from .knowledge import KnowledgeRetriever
from .evidence_usage import annotate_references, merge_evidence, verify_evidence_references
from .knowledge_index import HybridKnowledgeRetriever
from .reference_evidence import reference_evidence, refresh_reference_evidence
from .llm import DecisionLLM, trace_llm_call
from .models import (
    AgentStatus,
    ExpertFeedbackResolution,
    ExpertReviewDecision,
    ExecutionPlan,
    HumanDecision,
    KnowledgeReviewCheck,
    PlanValidation,
    RecoveryDecision,
    SeismoSkillAgentState,
    TaskAnalysis,
    ValidationIssueView,
)
from .prompts import (
    execution_plan_messages,
    expert_feedback_messages,
    interpretation_messages,
    knowledge_answer_messages,
    task_analysis_messages,
    normalize_output_language,
)
from .request_parsing import (
    explicitly_excludes_full_report,
    explicitly_requests_resilience_quantification,
    explicit_partial_target_skill_ids,
    extract_explicit_request_parameters,
    needs_comparison_scope,
    unsupported_request_details,
    requires_full_resilience_report,
)
from .skill_bridge import DYNAMIC_COMPOSITION_ID, SkillRegistryBridge
from .feedback_routing import (
    feedback_route, safe_format_repair, feedback_change_summary, normalize_recovery_patch,
    relaxes_recovery_constraints,
)
from .metric_policy import historical_result, HISTORICAL_NOTICE, comparison_status, result_comparison_basis


def review_memory_context(
    store: ExpertMemoryStore | None, state: SeismoSkillAgentState,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Project current reviewed memory for interpretation and human review."""
    if store is None or not state.get("session_id"):
        return [], []
    notes: list[dict[str, Any]] = []
    experiences: list[dict[str, Any]] = []
    try:
        scope = state.get("expert_memory_scope", {})
        confirmed = store.notes(state["session_id"], confirmed_only=True)
        if scope:
            confirmed = [note for note in confirmed if not note.get("domain") or (
                note["domain"] == scope["domain"] and note.get("target_system") == scope["target_system"]
            )]
        for note in confirmed[-12:]:
            notes.append({
                "id": note["note_id"], "iteration": note["iteration"],
                "kind": note["kind"], "text": note["text"],
                "use": "pending_check" if note["kind"] == "open_question" else "review_context",
            })
        ids = [entry["item_id"] for entry in state.get("retrieved_experiences", []) if entry.get("item_id")]
        if scope and ids:
            experiences = store.current_experiences(scope["domain"], scope["target_system"], ids)
    except (sqlite3.Error, OSError):
        # The optional advisory store cannot become a dependency of engineering execution.
        return [], []
    return notes, experiences


class SeismoSkillDecisionCenter:
    """The single LLM decision center shown in the research architecture."""

    def __init__(
        self,
        settings: AgentSettings,
        llm: DecisionLLM,
        retriever: KnowledgeRetriever | None = None,
        skill_bridge: SkillRegistryBridge | None = None,
        audit_store: AuditStore | None = None,
        expert_memory: ExpertMemoryStore | None = None,
    ) -> None:
        self.settings = settings
        self.llm = llm
        self.retriever = retriever if retriever is not None else HybridKnowledgeRetriever(
            settings.knowledge_root,
            auto_build=settings.knowledge_auto_build,
        )
        self.skills = skill_bridge or SkillRegistryBridge(settings.skill_run_root)
        self.audit = audit_store or AuditStore(settings.agent_run_root)
        self.expert_memory = expert_memory

    def _experience_scope(self, plan: ExecutionPlan) -> dict[str, str]:
        pairs = set()
        for skill_id in plan.selected_skill_ids:
            descriptor = self.skills.describe(skill_id)
            domain, system = descriptor.get("domain"), descriptor.get("target_system")
            if domain and system and system != "urban_engineering_system":
                pairs.add((domain, system))
        if len(pairs) != 1:
            return {}
        domain, system = pairs.pop()
        return {"domain": domain, "target_system": system}

    def _select_experience(self, state: SeismoSkillAgentState, plan: ExecutionPlan) -> dict[str, Any]:
        if self.expert_memory is None:
            return {}
        scope = self._experience_scope(plan)
        if not scope:
            return {"expert_memory_scope": {}, "retrieved_experiences": []}
        # The index receives the original task, never a model-produced plan or patch.
        try:
            suggestions = self.expert_memory.retrieve(state.get("user_message", ""), scope["domain"], scope["target_system"])
        except (sqlite3.Error, OSError):
            self.audit.record(state["session_id"], "expert_memory_unavailable", {"operation": "retrieve"})
            suggestions = []
        selection = [{"item_id": suggestion["item_id"], "version": suggestion.get("version", 1)} for suggestion in suggestions]
        if selection:
            self.audit.record(state["session_id"], "expert_experience_retrieved", {**scope, "advisory_items": selection})
        return {"expert_memory_scope": scope, "retrieved_experiences": selection}

    def _call_llm(self, state, stage, method, messages, response_model=None):
        result = state.get('skill_result', {})
        return trace_llm_call(self.llm,method,messages,response_model,audit_store=self.audit,
            session_id=state['session_id'],stage=stage,iteration=int(state.get('iteration',0)),
            run_id=result.get('run_id') if isinstance(result,dict) else None)

    @staticmethod
    def _approval_hash(plan: ExecutionPlan) -> str:
        from engineering_skills.core.artifacts import hash_payload
        from .feedback_routing import PRESENTATION_FIELDS
        # The already-approved engineering computation survives pure wording edits.
        payload = {k:v for k,v in plan.request_payload.items()
                   if k not in PRESENTATION_FIELDS | {'knowledge_evidence','decision_objective'}}
        return hash_payload({'component_id':plan.component_id,'target_skill_ids':plan.target_skill_ids,
                             'dag':plan.dag.model_dump(mode='json') if plan.dag else None,'request':payload})

    @staticmethod
    def _language(state: SeismoSkillAgentState) -> str:
        return normalize_output_language(
            state.get("output_language")
            or state.get("request_context", {}).get("output_language")
        )

    def _current_evidence(self, state: SeismoSkillAgentState) -> list[dict[str, Any]]:
        evidence = list(state.get("knowledge_evidence", []))
        curated = [item for item in evidence if str(item.get("evidence_id", "")).startswith("ref-")]
        indexed = [item for item in evidence if item not in curated]
        refresh = getattr(self.retriever, "current_evidence", None)
        return [
            *refresh_reference_evidence(curated),
            *(refresh(indexed) if indexed and callable(refresh) else indexed),
        ]

    @classmethod
    def _text(cls, state: SeismoSkillAgentState, zh: str, en: str) -> str:
        return en if cls._language(state) == "en-US" else zh

    def _iteration_summaries(self, state: SeismoSkillAgentState) -> list[dict[str, Any]]:
        summaries: list[dict[str, Any]] = []
        current_basis = result_comparison_basis(state.get("skill_result"))
        for record in state.get("iteration_history", []):
            compatibility = comparison_status(current_basis, result_comparison_basis(record.get("skill_result")))
            if historical_result(record.get("skill_result")) or not compatibility["comparable"]:
                summaries.append({"iteration": record.get("iteration"), "run_id": record.get("run_id"),
                    "comparison_status": compatibility,
                    "notice": "指标合同、数据、情景PGA或R评价窗不同/待确认；不向结果解释提供跨口径数值。"})
                continue
            summaries.append(
                {
                    "iteration": record.get("iteration"),
                    "run_id": record.get("run_id"),
                    "comparison_status": compatibility,
                    "plan": record.get("plan"),
                    "result": self.skills.summarize_result(record.get("skill_result", {})),
                    "interpretation": record.get("interpretation"),
                    "expert_decision": record.get("expert_decision"),
                    "completed_at": record.get("completed_at"),
                    "reviewed_at": record.get("reviewed_at"),
                }
            )
        return summaries

    def _revise_plan(
        self,
        state: SeismoSkillAgentState,
        plan: ExecutionPlan,
        *,
        payload_patch: dict[str, Any] | None = None,
        target_skill_ids: list[str] | None = None,
        rationale_suffix: str | None = None,
    ) -> ExecutionPlan:
        patch = self.skills.sanitize_plan_payload_patch(plan, payload_patch or {})
        revised_payload = self.skills.compile_payload(plan.request_payload, patch)
        payload = self.skills.compile_payload(
            state.get("request_context", {}),
            revised_payload,
        )
        revised = plan.model_copy(
            update={
                "request_payload": payload,
                "feedback_changes": feedback_change_summary(plan.request_payload, payload),
                "requested_skill_ids": (
                    list(dict.fromkeys(target_skill_ids))
                    if target_skill_ids is not None
                    else plan.requested_skill_ids
                ),
                "rationale": (
                    f"{plan.rationale} {rationale_suffix}".strip()
                    if rationale_suffix
                    else plan.rationale
                ),
            }
        )
        targets = (
            target_skill_ids
            if target_skill_ids is not None
            else plan.target_skill_ids
        )
        selected_targets, _ = self.skills.constrain_target_skill_ids(
            DYNAMIC_COMPOSITION_ID,
            targets,
        )
        return self.skills.compile_plan(
            revised,
            target_skill_ids=selected_targets,
        )

    def understand_task(self, state: SeismoSkillAgentState) -> dict[str, Any]:
        context = state.get("request_context", {})
        explicit = extract_explicit_request_parameters(state["user_message"])
        analysis_context = self.skills.compile_payload(context, explicit)
        if "scenario_selection" in explicit:
            analysis_context["scenario_selection"] = explicit["scenario_selection"]
        analysis = self._call_llm(state, 'understand_task', 'structured',
            task_analysis_messages(
                state["user_message"],
                analysis_context,
                self.skills.target_catalog(context=context or None),
                self._language(state),
            ),
            TaskAnalysis,
        )
        if analysis.task_type == "knowledge_query":
            analysis = analysis.model_copy(
                update={
                    "recommended_component_id": None,
                    "selected_skill_ids": [],
                }
            )
            selection_trace = {
                "reason": "knowledge_query_requires_no_engineering_execution",
                "selected_target_skill_ids": [],
            }
            update = {
                "status": AgentStatus.ANALYZED.value,
                "task_analysis": analysis.model_dump(mode="json"),
                "selection_trace": selection_trace,
            }
            self.audit.record(state["session_id"], "task_analysis", update)
            self.audit.record(
                state["session_id"], "skill_selection_guard", selection_trace
            )
            return update

        scope_pending = needs_comparison_scope(state["user_message"], explicit)
        requested = self.skills.compile_payload(analysis.extracted_parameters, explicit)
        if "scenario_selection" in explicit:
            requested["scenario_selection"] = explicit["scenario_selection"]
        analysis = analysis.model_copy(update={
            "assessment_mode": explicit.get("assessment_mode", analysis.assessment_mode),
            "extracted_parameters": requested,
            "missing_information": [
                *analysis.missing_information,
                *unsupported_request_details(state["user_message"]),
                *([self._text(state, "请明确要比较的指标或工程分析范围。", "Specify the engineering result or metric to compare.")] if scope_pending else []),
            ],
        })
        if scope_pending and not (analysis.selected_skill_ids or analysis.recommended_component_id):
            update = {"status": AgentStatus.ANALYZED.value, "task_analysis": analysis.model_dump(mode="json"),
                      "scope_clarification_required": True}
            self.audit.record(state["session_id"], "task_analysis", update)
            return update
        explicit_partial_targets = explicit_partial_target_skill_ids(
            state["user_message"]
        )
        proposed_component_id = analysis.recommended_component_id
        registered_target_ids = {
            item["id"] for item in self.skills.target_catalog()
        }
        declared_capability_targets = [
            item
            for item in analysis.requested_capabilities
            if item in registered_target_ids
        ]
        claimed_outputs = self.skills.explicit_delivery_targets(
            analysis.requested_outputs, declared_capability_targets,
        )
        proposed_targets = list(dict.fromkeys([
            *([proposed_component_id] if proposed_component_id else []),
            *analysis.selected_skill_ids, *declared_capability_targets,
        ]))
        if explicitly_excludes_full_report(state["user_message"]):
            reporting = "power_system.result_reporting"
            proposed_targets = [item for item in proposed_targets if item != reporting]
            claimed_outputs = [item for item in claimed_outputs if item != reporting]
            if not proposed_targets and "power_system.resilience_assessment" in claimed_outputs:
                proposed_targets = ["power_system.resilience_assessment"]
        if (
            not explicit_partial_targets
            and "power_system.recovery_optimization" in proposed_targets
            and "power_system.result_reporting" not in proposed_targets
            and "power_system.resilience_assessment" in registered_target_ids
            and explicitly_requests_resilience_quantification(state["user_message"])
            and "power_system.resilience_assessment" not in proposed_targets
        ):
            proposed_targets.append("power_system.resilience_assessment")
        protected_targets = explicit_partial_targets or [
            item for item in claimed_outputs if item in proposed_targets
        ]
        selected_targets, target_trace = self.skills.constrain_target_skill_ids(
            DYNAMIC_COMPOSITION_ID,
            explicit_partial_targets or proposed_targets,
            domain=analysis.domain,
            target_system=analysis.target_system,
            delivery_targets=protected_targets,
        )
        analysis = analysis.model_copy(
            update={
                "recommended_component_id": selected_targets[0],
                "selected_skill_ids": selected_targets,
                "assessment_mode": (
                    analysis.assessment_mode
                    or state.get("request_context", {}).get("assessment_mode")
                ),
            }
        )
        selection_trace = {
            "proposed_component_id": proposed_component_id,
            "selected_component_id": DYNAMIC_COMPOSITION_ID,
            "reason": "llm_targets_constrained_by_global_registry",
            "target_selection": target_trace,
            "explicit_partial_scope_override": explicit_partial_targets,
            "registered_requested_capabilities": declared_capability_targets,
        }
        update = {
            "status": AgentStatus.ANALYZED.value,
            "task_analysis": analysis.model_dump(mode="json"),
            "selection_trace": selection_trace,
            "scope_clarification_required": scope_pending,
        }
        self.audit.record(state["session_id"], "task_analysis", update)
        self.audit.record(state["session_id"], "skill_selection_guard", selection_trace)
        return update

    def retrieve_knowledge(self, state: SeismoSkillAgentState) -> dict[str, Any]:
        analysis = TaskAnalysis.model_validate(state["task_analysis"])
        queries = list(dict.fromkeys([*analysis.knowledge_queries, state["user_message"]]))
        evidence = self.retriever.retrieve(queries)
        if analysis.task_type == "knowledge_query":
            trusted = reference_evidence(state["user_message"])
            evidence = [*trusted, *evidence[:max(0, 6-len(trusted))]]
        update = {"knowledge_evidence": [item.model_dump(mode="json") for item in evidence]}
        self.audit.record(state["session_id"], "knowledge_retrieval", update)
        return update

    @staticmethod
    def route_after_knowledge_retrieval(state: SeismoSkillAgentState) -> str:
        analysis = TaskAnalysis.model_validate(state["task_analysis"])
        return (
            "answer_knowledge"
            if analysis.task_type == "knowledge_query"
            else "plan_execution"
        )

    def answer_knowledge(self, state: SeismoSkillAgentState) -> dict[str, Any]:
        analysis = TaskAnalysis.model_validate(state["task_analysis"])
        evidence = self._current_evidence(state)
        try:
            answer = self._call_llm(state, 'answer_knowledge', 'text',
                knowledge_answer_messages(
                    state["user_message"],
                    analysis.model_dump(mode="json"),
                    evidence,
                    self._language(state),
                )
            )
            errors = state.get("errors", [])
        except Exception as exc:
            answer = self._text(
                state,
                "知识检索已完成，但语言模型未能生成回答，请查看检索证据。",
                "Knowledge retrieval completed, but the language model could not generate an answer. Please inspect the retrieved evidence.",
            )
            errors = [
                *state.get("errors", []),
                f"knowledge_answer_error: {type(exc).__name__}: {exc}",
            ]
        usage = verify_evidence_references("answer", evidence, text=answer)
        update = {
            "status": AgentStatus.SUCCEEDED.value,
            "final_answer": annotate_references(answer, usage, self._language(state)),
            "errors": errors,
        }
        self.audit.record(state["session_id"], "knowledge_usage", usage)
        self.audit.record(state["session_id"], "knowledge_answer", update)
        self.audit.write_final(state["session_id"], {**state, **update})
        return update

    def plan_execution(self, state: SeismoSkillAgentState) -> dict[str, Any]:
        analysis = TaskAnalysis.model_validate(state["task_analysis"])
        context = state.get("request_context", {})
        explicit = extract_explicit_request_parameters(state["user_message"])
        if not analysis.selected_skill_ids:
            if state.get("scope_clarification_required"):
                plan = ExecutionPlan(component_id=DYNAMIC_COMPOSITION_ID,
                                     request_payload=self.skills.compile_payload(context, explicit),
                                     rationale=analysis.missing_information[-1])
                return {"status": AgentStatus.PLANNED.value, "plan": plan.model_dump(mode="json")}
            raise ValueError("Engineering computation requires at least one target Skill")
        profile_id, schema = self.skills.input_schema_for_targets(
            analysis.selected_skill_ids,
            state.get("request_context", {}),
        )
        selected_components = [
            self.skills.describe(item) for item in analysis.selected_skill_ids
        ]
        evidence = self._current_evidence(state)
        planning_context = self.skills.compile_payload(context, explicit)
        if "scenario_selection" in explicit:
            planning_context["scenario_selection"] = explicit["scenario_selection"]
        plan = self._call_llm(state, 'plan_execution', 'structured',
            execution_plan_messages(
                state["user_message"],
                analysis.model_dump(mode="json"),
                planning_context,
                {
                    "composition_source": "skill_registry",
                    "target_components": selected_components,
                    "input_profile_id": profile_id,
                },
                schema,
                evidence,
                self._language(state),
            ),
            ExecutionPlan,
        )
        evidence_usage = verify_evidence_references(
            "plan", evidence, checks=plan.knowledge_checks, reported_ids=plan.evidence_ids,
            output_language=self._language(state),
        )
        checks = evidence_usage["review_checks"]
        plan = plan.model_copy(update={
            "knowledge_checks": [KnowledgeReviewCheck.model_validate(item) for item in checks],
            "evidence_ids": list(dict.fromkeys(check["evidence_id"] for check in checks)),
        })
        proposed = plan.request_payload
        schema_properties = set(schema.get("properties", {}))
        # An output declaration belongs to TaskAnalysis, not to engineering input.
        proposed = {key: value for key, value in proposed.items() if key != "requested_outputs"}
        if "observations" in schema_properties:
            # The language model cannot create a source observation or calibrate a survival curve.
            protected = {"observations", "treatment_parameters"}
            proposed = {key: val for key, val in proposed.items() if key not in protected}
        compiled_payload = self.skills.compile_payload(context, proposed)
        if analysis.assessment_mode is not None:
            compiled_payload.setdefault("assessment_mode", analysis.assessment_mode)
        explicit = {key: value for key, value in explicit.items() if key in schema_properties}
        compiled_payload = self.skills.compile_payload(compiled_payload, explicit)
        scenario_selection_source = "not_applicable"
        if "scenario_selection" in schema_properties:
            context_selection = context.get("scenario_selection")
            if "scenario_selection" in explicit:
                compiled_payload["scenario_selection"] = explicit["scenario_selection"]
                scenario_selection_source = "deterministic_natural_language_extraction"
            elif context_selection is not None:
                compiled_payload["scenario_selection"] = deepcopy(context_selection)
                scenario_selection_source = "structured_request_context"
            elif compiled_payload.get("scenario_selection") is not None:
                scenario_selection_source = "llm_schema_payload"
            else:
                scenario_selection_source = "all_dataset_scenarios"

        # Task analysis defines computational scope. Output format words must not
        # silently replace a partial target with the full resilience report DAG.
        proposed_targets = (
            analysis.selected_skill_ids
            or plan.target_skill_ids
            or plan.selected_skill_ids
        )
        registered_targets = set(
            self.skills.available_target_skill_ids(
                domain=analysis.domain,
                target_system=analysis.target_system,
            )
        )
        requested_skill_ids = [
            skill_id
            for skill_id in analysis.requested_capabilities
            if skill_id in registered_targets
        ]
        requested_skill_ids = list(dict.fromkeys([*requested_skill_ids, *proposed_targets]))
        required_output_targets: list[str] = []
        if requires_full_resilience_report(
            state["user_message"],
            analysis.requested_outputs,
            proposed_targets,
        ):
            required_output_targets = ["power_system.result_reporting"]
            proposed_targets = list(
                dict.fromkeys([*proposed_targets, *required_output_targets])
            )
            requested_skill_ids = list(
                dict.fromkeys([*requested_skill_ids, *required_output_targets])
            )
        selected_targets, target_trace = self.skills.constrain_target_skill_ids(
            DYNAMIC_COMPOSITION_ID,
            proposed_targets,
            domain=analysis.domain,
            target_system=analysis.target_system,
            delivery_targets=list(proposed_targets),
        )
        plan = self.skills.compile_plan(
            plan.model_copy(
                update={
                    "component_id": DYNAMIC_COMPOSITION_ID,
                    "input_profile_id": profile_id,
                    "task_objective": analysis.objective,
                    "requested_skill_ids": list(dict.fromkeys(requested_skill_ids)),
                    "target_skill_ids": selected_targets,
                    "request_payload": compiled_payload,
                    "requires_human_approval": True,
                }
            ),
            target_skill_ids=selected_targets,
        )
        dependency_nodes = [
            item
            for item in plan.selected_skill_ids
            if item not in set(plan.target_skill_ids)
        ]
        if self._language(state) == "en-US":
            rationale = (
                f"Task objective: {analysis.objective}. "
                f"Targets selected by the LLM and retained by the Registry: {plan.target_skill_ids}; "
                f"required dependencies added automatically: {dependency_nodes}; "
                f"deterministic execution order: {plan.selected_skill_ids}. "
                f"Target constraint result: {target_trace['reason']}. "
                f"Input contract: {plan.input_profile_id}. "
                f"Earthquake scenario source: {scenario_selection_source}. "
                + (
                    f"Full resilience reporting contract retained: {required_output_targets}."
                    if required_output_targets
                    else "Presentation is limited to the current targets and does not expand the computational scope."
                )
            )
        else:
            rationale = (
                f"任务目标：{analysis.objective}。"
                f"LLM选择并经Registry保留的目标Skills：{plan.target_skill_ids}；"
                f"自动补全必要依赖：{dependency_nodes}；"
                f"确定性执行顺序：{plan.selected_skill_ids}。"
                f"目标约束结果：{target_trace['reason']}。"
                f"输入契约：{plan.input_profile_id}。"
                f"地震情景参数来源：{scenario_selection_source}。"
                + (
                    f"完整韧性报告契约强制保留：{required_output_targets}。"
                    if required_output_targets
                    else "结果呈现由当前局部目标结果和解释层完成，不扩展计算范围。"
                )
            )
        plan = plan.model_copy(
            update={
                "rationale": rationale,
            }
        )
        update = {
            "status": AgentStatus.PLANNED.value,
            "plan": plan.model_dump(mode="json"),
            **self._select_experience(state, plan),
        }
        self.audit.record(state["session_id"], "knowledge_usage", {
            "iteration": int(state.get("iteration", 1)), **evidence_usage,
        })
        self.audit.record(state["session_id"], "execution_plan", update)
        return update

    def validate_plan(self, state: SeismoSkillAgentState) -> dict[str, Any]:
        plan = ExecutionPlan.model_validate(state["plan"])
        validation = self.skills.validate(plan)
        repair_attempts = int(state.get("validation_repair_attempts", 0))
        if not validation.valid and repair_attempts < 2:
            repaired, repair_trace = safe_format_repair(plan.request_payload)
            try:
                repaired, constraint_trace = normalize_recovery_patch(repaired)
                repair_trace.extend(constraint_trace)
            except ValueError:
                pass  # Unknown/conflicting meanings remain invalid.
            if repair_trace:
                repair_attempts += 1
                plan = plan.model_copy(update={"request_payload": repaired})
                validation = self.skills.validate(plan)
                self.audit.record(state["session_id"], "automatic_schema_repair", {
                    "attempt": repair_attempts, "changes": repair_trace,
                    "valid_after_repair": validation.valid,
                    "boundary": "Explicit formatting only; missing data and engineering conflicts require human input",
                })
        analysis = TaskAnalysis.model_validate(state["task_analysis"])
        unsupported = [item for item in unsupported_request_details(state["user_message"])
                       if item in analysis.missing_information]
        if unsupported:
            validation = validation.model_copy(update={
                "valid": False,
                "issues": [*validation.issues, ValidationIssueView(
                    code="unsupported_power_request", field="user_input",
                    message="；".join(unsupported), severity="error", category="model_not_applicable",
                )],
            })
        if state.get("scope_clarification_required"):
            validation = validation.model_copy(update={
                "valid": False,
                "issues": [*validation.issues, ValidationIssueView(
                    code="analysis_scope_requires_clarification", field="user_input",
                    message=self._text(state, "需要明确比较的工程指标或分析范围。", "Specify the engineering scope or metric to compare."),
                    severity="error",
                )],
            })
        if analysis.missing_information:
            missing_severity = "warning" if validation.valid else "error"
            validation = validation.model_copy(
                update={
                    "issues": [
                        *validation.issues,
                        ValidationIssueView(
                            code="missing_task_information",
                            field="user_input",
                            message="；".join(analysis.missing_information),
                            severity=missing_severity,
                        ),
                    ]
                }
            )
        if validation.valid and validation.normalized_input is not None:
            plan = plan.model_copy(update={"request_payload": validation.normalized_input})
        update = {
            "status": (
                AgentStatus.AWAITING_APPROVAL.value
                if validation.valid
                else AgentStatus.NEEDS_INPUT.value
            ),
            "plan": plan.model_dump(mode="json"),
            "validation": validation.model_dump(mode="json"),
            "validation_repair_attempts": repair_attempts,
        }
        if self.expert_memory is not None and state.get("expert_memory_scope") != self._experience_scope(plan):
            update.update(self._select_experience(state, plan))
        self.audit.record(state["session_id"], "plan_validation", update)
        return update

    @staticmethod
    def route_after_validation(state: SeismoSkillAgentState) -> str:
        validation = PlanValidation.model_validate(state["validation"])
        return "human_review" if validation.valid else "request_revision"

    def request_revision(
        self,
        state: SeismoSkillAgentState,
    ) -> Command[Literal["validate_plan", "cancel"]]:
        response = interrupt(
            {
                "type": "request_revision",
                "message": self._text(
                    state,
                    "当前Skill请求未通过校验，请补充或修改参数。",
                    "The Skill request failed validation. Please complete or revise the parameters.",
                ),
                "plan": state["plan"],
                "validation": state["validation"],
                "allowed_actions": ["edit", "reject"],
                "allowed_target_skill_ids": self.skills.available_target_skill_ids(),
                "task_missing_information": state.get("task_analysis", {}).get(
                    "missing_information", []
                ),
            }
        )
        decision = HumanDecision.model_validate(response)
        self.audit.record(
            state["session_id"],
            "human_revision",
            decision.model_dump(mode="json"),
        )
        if decision.action == "reject":
            return Command(
                goto="cancel",
                update={"human_decision": decision.model_dump(mode="json")},
            )
        if decision.action != "edit":
            raise ValueError("Invalid plans can only be edited or rejected")
        if state.get("scope_clarification_required") and not decision.target_skill_ids:
            return Command(goto="request_revision")
        plan = ExecutionPlan.model_validate(state["plan"])
        plan = self._revise_plan(
            state,
            plan,
            payload_patch=decision.payload_patch,
            target_skill_ids=decision.target_skill_ids,
        )
        analysis = TaskAnalysis.model_validate(state["task_analysis"]).model_copy(
            update={"missing_information": []}
        )
        return Command(
            goto="validate_plan",
            update={
                "human_decision": decision.model_dump(mode="json"),
                "plan": plan.model_dump(mode="json"),
                "task_analysis": analysis.model_dump(mode="json"),
                "scope_clarification_required": False,
            },
        )

    def human_review(
        self,
        state: SeismoSkillAgentState,
    ) -> Command[Literal["execute", "validate_plan", "cancel"]]:
        evidence = self._current_evidence(state)
        plan = ExecutionPlan.model_validate(state["plan"])
        review_checks = verify_evidence_references(
            "plan", evidence, checks=plan.knowledge_checks,
            output_language=self._language(state),
        )["review_checks"]
        response = interrupt(
            {
                "type": "human_review",
                "message": self._text(
                    state,
                    "请审核Engineering Skills执行计划。",
                    "Please review the Engineering Skills execution plan.",
                ),
                "plan": state["plan"],
                "validation": state["validation"],
                "knowledge_evidence": evidence,
                "knowledge_checks": review_checks,
                "constraint_changes": state["plan"].get('feedback_changes',{}),
                "allowed_actions": ["approve", "edit", "reject"],
                "allowed_target_skill_ids": self.skills.available_target_skill_ids(),
            }
        )
        decision = HumanDecision.model_validate(response)
        self.audit.record(
            state["session_id"],
            "human_review",
            decision.model_dump(mode="json"),
        )
        if decision.action == "reject":
            return Command(
                goto="cancel",
                update={"human_decision": decision.model_dump(mode="json")},
            )
        if decision.action == "edit":
            plan = ExecutionPlan.model_validate(state["plan"])
            plan = self._revise_plan(
                state,
                plan,
                payload_patch=decision.payload_patch,
                target_skill_ids=decision.target_skill_ids,
            )
            return Command(
                goto="validate_plan",
                update={
                    "human_decision": decision.model_dump(mode="json"),
                    "plan": plan.model_dump(mode="json"),
                },
            )
        return Command(
            goto="execute",
            update={"human_decision": decision.model_dump(mode="json"),
                    "approved_plan_hash":self._approval_hash(ExecutionPlan.model_validate(state['plan']))},
        )

    def execute(
        self,
        state: SeismoSkillAgentState,
    ) -> Command[Literal["interpret", "execution_recovery", "validate_plan"]]:
        plan = ExecutionPlan.model_validate(state["plan"])
        if state.get('approved_plan_hash') != self._approval_hash(plan):
            self.audit.record(state['session_id'],'execution_requires_renewed_approval',{
                'reason':'No approval for this exact engineering plan; revalidate and request review'})
            return Command(goto='validate_plan',update={'status':AgentStatus.PLANNED.value})
        iteration = int(state.get("iteration", 0)) + 1
        attempt = int(state.get("execution_attempt", 0)) + 1
        safe_session = re.sub(r"[^A-Za-z0-9_.-]+", "_", state["session_id"])
        run_id = f"agent-{safe_session}-i{iteration}-a{attempt}-{uuid.uuid4().hex[:8]}"
        self.audit.record(
            state["session_id"],
            "skill_execution_started",
            {
                "component_id": plan.component_id,
                "composition_mode": plan.composition_mode,
                "target_skill_ids": plan.target_skill_ids,
                "selected_skill_ids": plan.selected_skill_ids,
                "run_id": run_id,
                "iteration": iteration,
                "attempt": attempt,
            },
        )
        try:
            execution_payload = deepcopy(plan.request_payload)
            if "power_system.result_reporting" in plan.selected_skill_ids:
                execution_payload["knowledge_evidence"] = self._current_evidence(state)[:20]
                execution_payload["decision_objective"] = str(
                    state.get("task_analysis", {}).get("objective")
                    or state.get("user_message", "")
                )[:1000]
            execution_plan = plan.model_copy(
                update={"request_payload": execution_payload}
            )
            from engineering_skills.core.artifacts import write_json
            snapshot_warnings = []
            try:
                write_json(self.settings.skill_run_root.resolve() / run_id / '_agent_snapshot.json',
                           runtime_configuration_snapshot(self.settings))
            except (OSError, ValueError, TypeError) as snapshot_error:
                snapshot_warnings.append(f'agent_snapshot_unavailable: {type(snapshot_error).__name__}')
                self.audit.record(state['session_id'],'agent_snapshot_warning',{
                    'run_id':run_id,'warning':snapshot_warnings[-1], 'scope':'Provenance only; engineering execution continues'})
            result = self.skills.execute(execution_plan, run_id)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            update = {
                "status": AgentStatus.AWAITING_RECOVERY.value,
                "execution_attempt": attempt,
                "skill_error": {
                    "component_id": plan.component_id,
                    "run_id": run_id,
                    "iteration": iteration,
                    "attempt": attempt,
                    "message": error,
                    "classification": classify_failure(exc),
                },
                "errors": [*state.get("errors", []), f"skill_execution_error: {error}"],
            }
            self.audit.record(state["session_id"], "skill_execution_failed", update)
            return Command(goto="execution_recovery", update=update)
        update = {
            "status": AgentStatus.EXECUTING.value,
            "skill_result": result,
            "iteration": iteration,
            "execution_attempt": 0,
            "skill_error": {},
            "errors": [*state.get('errors',[]), *snapshot_warnings],
        }
        self.audit.record(
            state["session_id"],
            "skill_execution_finished",
            {
                "iteration": iteration,
                **self.skills.summarize_result(result),
            },
        )
        return Command(goto="interpret", update=update)

    def execution_recovery(
        self,
        state: SeismoSkillAgentState,
    ) -> Command[Literal["execute", "validate_plan", "cancel"]]:
        attempt = int(state.get("execution_attempt", 1))
        failure = state.get("skill_error", {}).get("classification", {})
        infeasible = failure.get("feasibility") == "proven_infeasible"
        unsolved = failure.get("category") == "optimization_not_solved"
        may_retry = attempt < self.settings.max_execution_attempts and not infeasible
        allowed_actions = ["edit", "reject"]
        if may_retry:
            allowed_actions.insert(0, "retry")
        if infeasible:
            message = self._text(
                state,
                "当前约束下已证实所报告范围内无可行方案。请审查冲突并明确提交修订，或终止本轮。",
                "Infeasibility was established within the reported scope. Review the conflict and explicitly submit a revision, or cancel this round.",
            )
        elif unsolved:
            message = self._text(
                state,
                "本次求解未确定满足约束的方案，可行性仍待判定。请核对诊断后决定后续操作。",
                "This solve did not establish a plan satisfying the constraints. Feasibility remains undetermined. Review the diagnostics before deciding how to proceed.",
            )
        else:
            message = self._text(
                state,
                "Engineering Skill执行失败。请核对错误信息后选择下方操作。",
                "Engineering Skill execution failed. Review the reported error and choose an available action below.",
            )
        response = interrupt(
            {
                "type": "execution_recovery",
                "message": message,
                "error": state.get("skill_error", {}),
                "attempt": attempt,
                "max_attempts": self.settings.max_execution_attempts,
                "allowed_actions": allowed_actions,
                "plan": state["plan"],
                "mutable_fields": self.skills.mutable_input_fields_for_plan(
                    ExecutionPlan.model_validate(state["plan"])
                ),
            }
        )
        decision = RecoveryDecision.model_validate(response)
        if decision.action == "retry" and not may_retry:
            if infeasible:
                raise ValueError("Proven infeasibility requires an explicit revision or cancellation")
            raise ValueError(
                f"Maximum execution attempts reached ({self.settings.max_execution_attempts})"
            )
        self.audit.record(
            state["session_id"],
            "execution_recovery_decision",
            {"attempt": attempt, **decision.model_dump(mode="json")},
        )
        update = {"recovery_decision": decision.model_dump(mode="json")}
        if decision.action == "reject":
            return Command(goto="cancel", update=update)
        if decision.action == "retry":
            return Command(
                goto="execute",
                update={**update, "status": AgentStatus.EXECUTING.value},
            )
        plan = ExecutionPlan.model_validate(state["plan"])
        revised_plan = self._revise_plan(
            state,
            plan,
            payload_patch=decision.payload_patch,
        )
        return Command(
            goto="validate_plan",
            update={
                **update,
                "status": AgentStatus.PROCESSING_FEEDBACK.value,
                "plan": revised_plan.model_dump(mode="json"),
                "execution_attempt": 0,
            },
        )

    def _fallback_interpretation(
        self,
        state: SeismoSkillAgentState,
        plan: ExecutionPlan,
    ) -> str:
        result = state.get("skill_result", {})
        data = result.get("data", {}) if isinstance(result, dict) else {}
        delivery = data.get("delivery_bundle", {}) if isinstance(data, dict) else {}
        narrative = delivery.get("narrative") if isinstance(delivery, dict) else None
        if isinstance(narrative, str) and narrative.strip():
            return narrative.strip()
        run_id = result.get("run_id", "unknown") if isinstance(result, dict) else "unknown"
        targets = ", ".join(plan.target_skill_ids)
        return self._text(
            state,
            f"电力工程计算已完成（运行ID：{run_id}；目标：{targets}）。语言模型解释暂不可用，请依据结构化供电、损伤、恢复指标及来源进行结果审查。",
            f"Power-system computation completed (run ID: {run_id}; targets: {targets}). The language-model explanation is unavailable; review the saved engineering indicators, warnings and provenance.",
        )
    def interpret(self, state: SeismoSkillAgentState) -> dict[str, Any]:
        plan = ExecutionPlan.model_validate(state["plan"])
        result_summary = self.skills.summarize_result(state["skill_result"])
        prior_iterations = self._iteration_summaries(state)
        case_memory, experience_memory = review_memory_context(self.expert_memory, state)
        evidence = self._current_evidence(state)
        try:
            answer = self._call_llm(state, 'interpret', 'text',
                interpretation_messages(
                    state["user_message"],
                    plan.model_dump(mode="json"),
                    result_summary,
                    evidence,
                    prior_iterations,
                    self._language(state),
                    case_memory=case_memory,
                    experience_memory=experience_memory,
                )
            )
            if not answer or not answer.strip():
                raise ValueError("The language model returned an empty interpretation")
            errors = state.get("errors", [])
        except Exception as exc:
            answer = self._fallback_interpretation(state, plan)
            errors = [*state.get("errors", []), f"interpretation_error: {exc}"]
        usage = verify_evidence_references("interpretation", evidence, text=answer)
        answer = annotate_references(answer, usage, self._language(state))
        record = {
            "iteration": int(state.get("iteration", 1)),
            "run_id": str(state["skill_result"].get("run_id", "unknown")),
            "plan": plan.model_dump(mode="json"),
            "skill_result": deepcopy(state["skill_result"]),
            "interpretation": answer,
            "expert_decision": None,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "reviewed_at": None,
        }
        history = deepcopy(state.get("iteration_history", []))
        if plan.feedback_route == "presentation_only":
            matching_record = next(
                (
                    prior for prior in reversed(history)
                    if str(prior.get("run_id") or prior.get("skill_result", {}).get("run_id", ""))
                    == record["run_id"]
                ),
                None,
            )
            if matching_record is None:
                raise ValueError("Presentation revision requires the existing engineering iteration history")
            presentation_history = matching_record.setdefault("presentation_history", [])
            presentation_history.append({
                "presentation_revision_id": matching_record.get("skill_result", {}).get("data", {}).get("presentation_revision_id"),
                "plan": deepcopy(matching_record.get("plan")),
                "delivery_bundle": deepcopy(matching_record.get("skill_result", {}).get("data", {}).get("delivery_bundle")),
                "artifacts": deepcopy(matching_record.get("skill_result", {}).get("artifacts", [])),
                "interpretation": matching_record.get("interpretation"),
                "expert_decision": deepcopy(matching_record.get("expert_decision")),
                "reviewed_at": matching_record.get("reviewed_at"),
                "superseded_at": record["completed_at"],
            })
            matching_record.update({
                "plan": record["plan"],
                "skill_result": record["skill_result"],
                "interpretation": answer,
                "expert_decision": None,
                "reviewed_at": None,
                "presentation_updated_at": record["completed_at"],
            })
        else:
            history.append(record)
        update = {
            "status": AgentStatus.AWAITING_RESULT_REVIEW.value,
            "current_interpretation": answer,
            "iteration_history": history,
            "result_review_decision": {},
            "errors": errors,
        }
        self.audit.record(state["session_id"], "knowledge_usage", {
            "iteration": record["iteration"], "run_id": record["run_id"],
            **usage,
        })
        self.audit.record(
            state["session_id"],
            "iteration_interpretation",
            {"iteration": record["iteration"], "run_id": record["run_id"], **update},
        )
        return update

    def result_review(
        self,
        state: SeismoSkillAgentState,
    ) -> Command[Literal["finalize", "process_expert_feedback", "cancel"]]:
        iteration = int(state.get("iteration", 1))
        may_revise = iteration < self.settings.max_feedback_iterations
        allowed_actions = ["accept", "reject"]
        if may_revise:
            allowed_actions.insert(1, "revise")
        memory_recorded = state.get("feedback_resolution", {}).get("feedback_kind") == "memory_only"
        response = interrupt(
            {
                "type": "result_review",
                "message": self._text(
                    state,
                    "已提取意见要点，可在专家反馈记忆中逐条核对。本轮工程结果仍可继续审查。"
                    if memory_recorded else "请审查本轮计算结果，可接受、提交专家意见或拒绝。",
                    "Feedback notes are ready for review in Expert feedback memory. You can continue reviewing this engineering result."
                    if memory_recorded else "Review the computed result, submit expert feedback, or accept or reject the result.",
                ),
                "iteration": iteration,
                "max_iterations": self.settings.max_feedback_iterations,
                "allowed_actions": allowed_actions,
                "plan": state["plan"],
                "result": self.skills.summarize_result(state["skill_result"]),
                "interpretation": state.get("current_interpretation", ""),
                "iteration_history": self._iteration_summaries(state),
                "mutable_fields": self.skills.mutable_input_fields_for_plan(
                    ExecutionPlan.model_validate(state["plan"])
                ),
            }
        )
        decision = ExpertReviewDecision.model_validate(response)
        if decision.reviewer_role not in {"domain_expert", "emergency_manager"}:
            raise ValueError("Result review requires domain_expert or emergency_manager role")
        if decision.action == "revise" and not may_revise:
            raise ValueError(
                f"Maximum feedback iterations reached ({self.settings.max_feedback_iterations})"
            )
        history = deepcopy(state.get("iteration_history", []))
        run_id = str(state.get("skill_result", {}).get("run_id", ""))
        review_record = next(
            (
                record for record in reversed(history)
                if str(record.get("run_id") or record.get("skill_result", {}).get("run_id", "")) == run_id
            ),
            None,
        )
        if review_record is not None:
            review_record["expert_decision"] = decision.model_dump(mode="json")
            review_record["reviewed_at"] = datetime.now(timezone.utc).isoformat()
        self.audit.record(
            state["session_id"],
            "result_review",
            {"iteration": iteration, **decision.model_dump(mode="json")},
        )
        update = {
            "result_review_decision": decision.model_dump(mode="json"),
            "iteration_history": history,
        }
        if decision.action == "accept":
            return Command(goto="finalize", update=update)
        if decision.action == "reject":
            return Command(goto="cancel", update=update)
        return Command(
            goto="process_expert_feedback",
            update={**update, "status": AgentStatus.PROCESSING_FEEDBACK.value},
        )

    def process_expert_feedback(
        self,
        state: SeismoSkillAgentState,
    ) -> Command[Literal["validate_plan", "feedback_clarification", "interpret", "result_review"]]:
        decision = ExpertReviewDecision.model_validate(state["result_review_decision"])
        plan = ExecutionPlan.model_validate(state["plan"])
        state_errors = state.get("errors", [])
        if decision.payload_patch or decision.target_skill_ids is not None:
            resolution = ExpertFeedbackResolution(
                feedback_summary=decision.feedback or self._text(
                    state,
                    "专家提供了显式参数修订。",
                    "The expert provided an explicit parameter revision.",
                ),
                can_execute=True,
                payload_patch=decision.payload_patch,
                target_skill_ids=decision.target_skill_ids,
                knowledge_queries=[],
                comparison_focus=[],
                rationale=self._text(
                    state,
                    "采用专家确认的参数补丁或目标Skills重新编译执行计划。",
                    "Recompile the execution plan using the expert-confirmed parameter patch or target Skills.",
                ),
            )
        else:
            case_memory, _ = review_memory_context(self.expert_memory, state)
            try:
                resolution = self._call_llm(state, 'process_expert_feedback', 'structured',
                    expert_feedback_messages(
                        decision.feedback or "",
                        plan.model_dump(mode="json"),
                        self.skills.summarize_result(state["skill_result"]),
                        self.skills.mutable_input_fields_for_plan(plan),
                        self.skills.available_target_skill_ids(),
                        self._iteration_summaries(state),
                        self._language(state),
                        case_memory=case_memory,
                        capture_memory=self.expert_memory is not None,
                    ),
                    ExpertFeedbackResolution,
                )
            except Exception as exc:
                resolution = ExpertFeedbackResolution(
                    feedback_summary=decision.feedback or self._text(
                        state, "专家反馈解析失败。", "Expert feedback could not be parsed."
                    ),
                    can_execute=False,
                    payload_patch={},
                    target_skill_ids=None,
                    knowledge_queries=[],
                    comparison_focus=[],
                    rationale=self._text(
                        state,
                        "反馈未能可靠映射到Engineering Skill输入Schema。",
                        "The feedback could not be mapped reliably to the Engineering Skill input schema.",
                    ),
                    clarification_question=self._text(
                        state,
                        "未能把该意见可靠转换为计算参数。请明确要修改的参数名称和目标值，或直接在参数表中修改。",
                        "The request could not be converted reliably into computation parameters. Specify the parameter name and target value, or edit the parameter form directly.",
                    ),
                )
                state_errors = [
                    *state.get("errors", []),
                    f"expert_feedback_resolution_error: {type(exc).__name__}: {exc}",
                ]
            else:
                state_errors = state.get("errors", [])
        if resolution.feedback_kind == "presentation_only" and resolution.presentation_instructions:
            resolution.payload_patch["presentation_instructions"] = resolution.presentation_instructions
        if not decision.payload_patch:
            try:
                normalized, normalization_trace = normalize_recovery_patch(resolution.payload_patch)
            except ValueError as exc:
                return self._hold_feedback(state, resolution, "invalid_recovery_constraint_encoding", str(exc))
            if normalization_trace:
                resolution = resolution.model_copy(update={"payload_patch": normalized})
                self.audit.record(state["session_id"], "feedback_constraint_normalization", {"changes": normalization_trace})
        resolution_payload = resolution.model_dump(mode="json")
        self.audit.record(
            state["session_id"],
            "expert_feedback_resolution",
            {"iteration": state.get("iteration", 1), **resolution_payload},
        )
        notes = []
        if self.expert_memory is not None and decision.feedback and resolution.feedback_items:
            try:
                notes = self.expert_memory.propose(
                    state["session_id"], int(state.get("iteration", 1)),
                    decision.feedback, resolution.feedback_items,
                    **self._experience_scope(plan),
                )
            except (sqlite3.Error, OSError):
                self.audit.record(state["session_id"], "expert_memory_unavailable", {"operation": "propose"})
            if notes:
                self.audit.record(state["session_id"], "expert_memory_draft_proposed", {
                    "iteration": state.get("iteration", 1), "note_ids": [note["note_id"] for note in notes],
                })
        if resolution.feedback_kind == "memory_only" and notes:
            return Command(goto="result_review", update={
                "status": AgentStatus.AWAITING_RESULT_REVIEW.value,
                "feedback_resolution": resolution_payload,
            })
        if resolution.feedback_kind == "memory_only":
            return self._hold_feedback(
                state, resolution, "feedback_memory_could_not_be_recorded",
                self._text(state, "请重述需要记录的内容，并核对专家批注面板。", "Restate the item to be recorded and check the expert notes panel."),
            )
        presentation_only = feedback_route(resolution.payload_patch, resolution.target_skill_ids is not None) == "presentation_only"
        if not resolution.can_execute and not (presentation_only and resolution.feedback_kind == "presentation_only"):
            return Command(
                goto="feedback_clarification",
                update={
                    "feedback_resolution": resolution_payload,
                    "errors": state_errors,
                },
            )

        # Natural-language proposals cannot manufacture sourced electrical inputs or
        # calibration or evidence records. An explicit form/API edit of scientific
        # inputs is reviewed separately through the normal engineering gate.
        structured = bool(decision.payload_patch) or decision.target_skill_ids is not None
        if not structured and set(resolution.payload_patch) & {
            "node_pga_g", "model_profile", "power_impact",
        }:
            return self._hold_feedback(
                state, resolution, "scientific_input_requires_explicit_edit",
                self._text(
                    state,
                    "请通过参数表和来源记录明确提交拟修改的工程数据及来源，再审核计算计划。",
                    "Submit the engineering values and their sources through a structured edit with source evidence, then review the plan.",
                ),
            )
        if resolution.target_skill_ids is not None and (
            not resolution.target_skill_ids
            or set(resolution.target_skill_ids) - set(self.skills.available_target_skill_ids())
        ):
            return self._hold_feedback(
                state, resolution, "invalid_feedback_targets",
                self._text(state, "请选择至少一个已注册的工程目标。", "Select at least one registered engineering target."),
            )
        try:
            if presentation_only:
                patch = self.skills.sanitize_plan_payload_patch(plan, resolution.payload_patch)
                revised_plan = plan.model_copy(update={
                    "request_payload": self.skills.compile_payload(plan.request_payload, patch),
                    "feedback_changes": feedback_change_summary(plan.request_payload, {**plan.request_payload, **patch}),
                })
            else:
                revised_plan = self._revise_plan(
                    state, plan, payload_patch=resolution.payload_patch, target_skill_ids=resolution.target_skill_ids,
                    rationale_suffix=self._text(state, f"专家反馈修订：{resolution.rationale}", f"Expert feedback revision: {resolution.rationale}"),
                )
        except (ValueError, SkillDAGCompilationError) as exc:
            return self._hold_feedback(
                state, resolution, "feedback_revision_rejected",
                self._text(
                    state,
                    f"这项修订未通过校验。请核对可修改字段及工程约束。{exc}",
                    f"The revision was rejected. Check the editable fields and engineering constraints. {exc}",
                ),
            )
        if not structured and relaxes_recovery_constraints(plan.request_payload, revised_plan.request_payload):
            return self._hold_feedback(
                state, resolution, "existing_hard_constraint_requires_explicit_edit",
                self._text(
                    state,
                    "拟议修改放松了已批准的恢复硬约束。请核实依据后，通过参数表提交明确修订。",
                    "The proposal weakens an approved hard recovery constraint. Verify the basis and submit an explicit structured revision.",
                ),
            )

        previous_evidence = self._current_evidence(state)
        retrieved = (
            self.retriever.retrieve(resolution.knowledge_queries)
            if resolution.knowledge_queries else []
        )
        evidence = merge_evidence(retrieved, previous_evidence, limit=12)
        trace = verify_evidence_references("feedback", evidence)
        self.audit.record(state["session_id"], "knowledge_usage", {
            "iteration": int(state.get("iteration", 1)), **trace,
        })
        revised_plan = revised_plan.model_copy(
            update={
                "evidence_ids": [],
                "knowledge_checks": [],
                "reuse_from_run_id": state.get("skill_result", {}).get("run_id"),
                "feedback_route": feedback_route(resolution.payload_patch, resolution.target_skill_ids is not None),
            }
        )
        route = revised_plan.feedback_route
        revised_plan.feedback_changes['authorization'] = {
            'source':'explicit_expert_patch' if decision.payload_patch else 'llm_interpretation_of_expert_feedback',
            'status':'requires_plan_approval' if route != 'presentation_only' else 'engineering_inputs_unchanged',
            'automatic_constraint_relaxation':False}
        self.audit.record(state["session_id"], "feedback_execution_route", {
            "route": route, "reuse_from_run_id": revised_plan.reuse_from_run_id,
            "changed_fields": sorted(resolution.payload_patch),
            "policy": "Recompute only nodes whose input, implementation, or artifact fingerprints changed",
        })
        if presentation_only and not state.get("skill_result", {}).get("run_id"):
            return self._hold_feedback(state, resolution, "presentation_requires_result",
                                       self._text(state, "请先完成工程计算，再修订结果呈现。", "Complete engineering computation before revising its presentation."))
        presentation_update = {}
        if presentation_only:
            try:
                rebuilt = self.skills.regenerate_presentation(
                    state["skill_result"], revised_plan, previous_plan=plan,
                )
            except Exception as exc:
                self.audit.record(state["session_id"], "presentation_regeneration_failed", {
                    "run_id": state["skill_result"].get("run_id"), "error": f"{type(exc).__name__}: {exc}",
                    "original_artifacts_retained": True,
                })
                return self._hold_feedback(
                    state, resolution, "presentation_regeneration_failed",
                    self._text(state, f"呈现文件重建未完成，原报告保留。请核对要求后重试。{exc}",
                               f"Delivery regeneration failed; the original report is retained. Check the request and retry. {exc}"),
                )
            presentation_update["skill_result"] = rebuilt
            self.audit.record(state["session_id"], "presentation_regenerated", {
                "run_id": rebuilt["run_id"], "revision_id": rebuilt["data"]["presentation_revision_id"],
                "engineering_recomputed": False,
                "changed_fields": sorted(resolution.payload_patch),
            })
        return Command(
            goto="interpret" if presentation_only else "validate_plan",
            update={
                "status": AgentStatus.PROCESSING_FEEDBACK.value,
                "feedback_resolution": resolution_payload,
                "plan": revised_plan.model_dump(mode="json"),
                "knowledge_evidence": evidence,
                "execution_attempt": 0,
                "errors": state_errors,
                **presentation_update,
                **({"output_language": resolution.payload_patch["output_language"]} if presentation_only and "output_language" in resolution.payload_patch else {}),
                **(self._select_experience(state, revised_plan) if resolution.target_skill_ids is not None else {}),
            },
        )

    def _hold_feedback(
        self,
        state: SeismoSkillAgentState,
        resolution: ExpertFeedbackResolution,
        reason: str,
        message: str,
    ) -> Command[Literal["feedback_clarification"]]:
        self.audit.record(state["session_id"], "feedback_revision_held", {
            "reason_code": reason,
            "iteration": state.get("iteration", 1),
            "retained_run_id": state.get("skill_result", {}).get("run_id"),
        })
        blocked = ExpertFeedbackResolution(
            feedback_summary=resolution.feedback_summary,
            can_execute=False,
            rationale=message,
            clarification_question=message,
        )
        return Command(goto="feedback_clarification", update={
            "feedback_resolution": {**blocked.model_dump(mode="json"), "reason_code": reason},
        })

    def feedback_clarification(
        self,
        state: SeismoSkillAgentState,
    ) -> Command[Literal["process_expert_feedback", "cancel"]]:
        resolution = ExpertFeedbackResolution.model_validate(state["feedback_resolution"])
        plan = ExecutionPlan.model_validate(state["plan"])
        response = interrupt(
            {
                "type": "feedback_clarification",
                "message": resolution.clarification_question,
                "reason_code": state["feedback_resolution"].get("reason_code", "missing_feedback_information"),
                "allowed_actions": ["revise", "reject"],
                "plan": state["plan"],
                "mutable_fields": self.skills.mutable_input_fields_for_plan(plan),
                "allowed_target_skill_ids": self.skills.available_target_skill_ids(),
            }
        )
        decision = ExpertReviewDecision.model_validate(response)
        if decision.reviewer_role not in {"domain_expert", "emergency_manager"}:
            raise ValueError("Feedback clarification requires an expert reviewer role")
        if decision.action == "reject":
            return Command(
                goto="cancel",
                update={"result_review_decision": decision.model_dump(mode="json")},
            )
        if decision.action != "revise":
            raise ValueError("Feedback clarification can only be revised or rejected")
        self.audit.record(
            state["session_id"],
            "feedback_clarification",
            decision.model_dump(mode="json"),
        )
        return Command(
            goto="process_expert_feedback",
            update={"result_review_decision": decision.model_dump(mode="json")},
        )

    def finalize(self, state: SeismoSkillAgentState) -> dict[str, Any]:
        review = ExpertReviewDecision.model_validate(state["result_review_decision"])
        answer = state.get(
            "current_interpretation",
            self._text(
                state,
                "Engineering Skills计算已完成。",
                "Engineering Skills computation is complete.",
            ),
        )
        if review.feedback:
            answer = self._text(
                state,
                f"{answer}\n\n专家审查意见：{review.feedback}",
                f"{answer}\n\nExpert review comment: {review.feedback}",
            )
        update = {
            "status": AgentStatus.SUCCEEDED.value,
            "final_answer": answer,
        }
        self.audit.record(
            state["session_id"],
            "final_acceptance",
            {
                "iteration": state.get("iteration", 1),
                "run_id": state.get("skill_result", {}).get("run_id"),
                "review": review.model_dump(mode="json"),
            },
        )
        self.audit.write_final(state["session_id"], {**state, **update})
        return update

    def cancel(self, state: SeismoSkillAgentState) -> dict[str, Any]:
        recovery = state.get("recovery_decision", {})
        result_review = state.get("result_review_decision", {})
        plan_review = state.get("human_decision", {})
        if recovery.get("action") == "reject":
            feedback = recovery.get("feedback") or self._text(
                state,
                "本轮执行尝试已终止。请参照恢复诊断。",
                "The execution attempt was cancelled. See the recovery diagnostics.",
            )
        else:
            rejected = result_review if result_review.get("action") == "reject" else plan_review
            feedback = rejected.get("feedback") or self._text(
                state,
                "用户未批准执行计划或计算结果。",
                "The user did not approve the execution plan or computed result.",
            )
        update = {
            "status": AgentStatus.REJECTED.value,
            "final_answer": feedback,
        }
        self.audit.record(state["session_id"], "execution_rejected", update)
        self.audit.write_final(state["session_id"], {**state, **update})
        return update
