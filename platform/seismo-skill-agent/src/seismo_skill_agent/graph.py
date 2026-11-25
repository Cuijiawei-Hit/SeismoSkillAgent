from __future__ import annotations

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph

from .decision_center import SeismoSkillDecisionCenter
from .models import SeismoSkillAgentState


def build_agent_graph(
    decision_center: SeismoSkillDecisionCenter,
    checkpointer: BaseCheckpointSaver | None = None,
):
    builder = StateGraph(SeismoSkillAgentState)
    builder.add_node("understand_task", decision_center.understand_task)
    builder.add_node("retrieve_knowledge", decision_center.retrieve_knowledge)
    builder.add_node("answer_knowledge", decision_center.answer_knowledge)
    builder.add_node("plan_execution", decision_center.plan_execution)
    builder.add_node("validate_plan", decision_center.validate_plan)
    builder.add_node("request_revision", decision_center.request_revision)
    builder.add_node("human_review", decision_center.human_review)
    builder.add_node("execute", decision_center.execute)
    builder.add_node("execution_recovery", decision_center.execution_recovery)
    builder.add_node("interpret", decision_center.interpret)
    builder.add_node("result_review", decision_center.result_review)
    builder.add_node("process_expert_feedback", decision_center.process_expert_feedback)
    builder.add_node("feedback_clarification", decision_center.feedback_clarification)
    builder.add_node("finalize", decision_center.finalize)
    builder.add_node("cancel", decision_center.cancel)

    builder.add_edge(START, "understand_task")
    builder.add_edge("understand_task", "retrieve_knowledge")
    builder.add_conditional_edges(
        "retrieve_knowledge",
        decision_center.route_after_knowledge_retrieval,
        {
            "answer_knowledge": "answer_knowledge",
            "plan_execution": "plan_execution",
        },
    )
    builder.add_edge("answer_knowledge", END)
    builder.add_edge("plan_execution", "validate_plan")
    builder.add_conditional_edges(
        "validate_plan",
        decision_center.route_after_validation,
        {
            "human_review": "human_review",
            "request_revision": "request_revision",
        },
    )
    builder.add_edge("interpret", "result_review")
    builder.add_edge("finalize", END)
    builder.add_edge("cancel", END)
    return builder.compile(checkpointer=checkpointer or InMemorySaver())
