from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from langgraph.types import Command

from .config import AgentConfigurationError, AgentSettings
from .decision_center import SeismoSkillDecisionCenter
from .graph import build_agent_graph
from .knowledge_index import HybridKnowledgeRetriever, KnowledgeIndexBuilder
from .llm import DeepSeekDecisionLLM, trace_llm_call
from .audit import AuditStore, public_endpoint
from .project_paths import project_paths, absolute_data_paths
from .skill_bridge import SkillRegistryBridge
from .validation import run_auckland_validation as run_shanghai_validation


def _read_json(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _interrupt_payload(result: dict[str, Any]) -> dict[str, Any] | None:
    interrupts = result.get("__interrupt__", [])
    if not interrupts:
        return None
    value = getattr(interrupts[0], "value", interrupts[0])
    return value if isinstance(value, dict) else {"message": str(value)}


def _ask_human(payload: dict[str, Any]) -> dict[str, Any]:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    allowed = payload.get("allowed_actions") or ["approve", "edit", "reject"]
    while True:
        action = input(f"请选择 {' / '.join(allowed)}: ").strip().lower()
        if action in {"approve", "accept"} and action in allowed:
            feedback = input("审查意见（可空）: ").strip()
            return {"action": action, "feedback": feedback or None}
        if action == "retry" and action in allowed:
            feedback = input("重试说明（可空）: ").strip()
            return {"action": "retry", "feedback": feedback or None}
        if action == "reject":
            feedback = input("拒绝原因（可空）: ").strip()
            return {"action": "reject", "feedback": feedback or None}
        if action == "edit" and action in allowed:
            raw = input("请输入request_payload补丁JSON: ").strip()
            try:
                patch = json.loads(raw)
            except json.JSONDecodeError as exc:
                print(f"JSON格式错误: {exc}")
                continue
            if not isinstance(patch, dict):
                print("补丁必须是JSON对象。")
                continue
            feedback = input("修改说明（可空）: ").strip()
            return {"action": "edit", "payload_patch": patch, "feedback": feedback or None}
        if action == "revise" and action in allowed:
            feedback = input("修订要求: ").strip()
            raw = input("可选request_payload补丁JSON（留空则由LLM解析修订要求）: ").strip()
            patch: dict[str, Any] = {}
            if raw:
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError as exc:
                    print(f"JSON格式错误: {exc}")
                    continue
                if not isinstance(parsed, dict):
                    print("补丁必须是JSON对象。")
                    continue
                patch = parsed
            return {"action": "revise", "payload_patch": patch, "feedback": feedback or None}
        print("无效操作。")


def _run(args: argparse.Namespace) -> int:
    settings = AgentSettings.from_env(require_api_key=True)
    context = absolute_data_paths(_read_json(args.context),project_paths(settings.workspace_root).package_root)
    llm = DeepSeekDecisionLLM(settings)
    center = SeismoSkillDecisionCenter(settings, llm)
    graph = build_agent_graph(center)
    session_id = args.session_id or f"session-{uuid.uuid4().hex[:12]}"
    config = {"configurable": {"thread_id": session_id}}
    state = {
        "session_id": session_id,
        "user_message": args.task,
        "request_context": context,
        "status": "received",
        "errors": [],
    }
    result = graph.invoke(state, config=config)
    while (payload := _interrupt_payload(result)) is not None:
        if args.auto_approve and payload.get("type") == "human_review":
            decision = {"action": "approve"}
        elif args.auto_approve and payload.get("type") == "result_review":
            decision = {"action": "accept"}
        elif args.auto_approve:
            raise RuntimeError("Plan validation failed; automatic approval cannot supply missing information")
        else:
            decision = _ask_human(payload)
        result = graph.invoke(Command(resume=decision), config=config)
    output = {
        "session_id": session_id,
        "status": result.get("status"),
        "final_answer": result.get("final_answer"),
        "plan": result.get("plan"),
        "skill_result": result.get("skill_result"),
        "iteration_history": result.get("iteration_history", []),
        "errors": result.get("errors", []),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if result.get("status") == "succeeded" else 1


def _catalog(args: argparse.Namespace) -> int:
    settings = AgentSettings.from_env(require_api_key=False)
    bridge = SkillRegistryBridge(settings.skill_run_root)
    print(json.dumps(bridge.target_catalog(), ensure_ascii=False, indent=2))
    return 0


def _schema(args: argparse.Namespace) -> int:
    settings = AgentSettings.from_env(require_api_key=False)
    bridge = SkillRegistryBridge(settings.skill_run_root)
    print(json.dumps(bridge.input_schema(args.component_id), ensure_ascii=False, indent=2))
    return 0


def _check_config(args: argparse.Namespace) -> int:
    settings = AgentSettings.from_env(require_api_key=False)
    payload = {
        "api_key_configured": settings.deepseek_api_key is not None,
        "base_url": public_endpoint(settings.deepseek_base_url),
        "model": settings.deepseek_model,
        "agent_run_root": str(settings.agent_run_root),
        "skill_run_root": str(settings.skill_run_root),
        "knowledge_root": str(settings.knowledge_root),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _smoke_llm(args: argparse.Namespace) -> int:
    settings = AgentSettings.from_env(require_api_key=True)
    llm = DeepSeekDecisionLLM(settings)
    audit_session_id = f'smoke-{uuid.uuid4().hex[:12]}'
    response = trace_llm_call(llm, 'text',
        [
            {
                "role": "system",
                "content": "你是连接测试端点。只回复：连接正常",
            },
            {"role": "user", "content": "执行连接测试。"},
        ], audit_store=AuditStore(settings.agent_run_root),
        session_id=audit_session_id,stage='cli_smoke',iteration=0,
    )
    print(
        json.dumps(
            {
                "status": "ok",
                "base_url": public_endpoint(settings.deepseek_base_url),
                "model": settings.deepseek_model,
                "response": response,
                "audit_session_id": audit_session_id,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _knowledge_index(args: argparse.Namespace) -> int:
    settings = AgentSettings.from_env(require_api_key=False)
    from .semantic_knowledge import SemanticKnowledgeIndex
    builder = KnowledgeIndexBuilder(settings.knowledge_root) if args.legacy else SemanticKnowledgeIndex(settings.knowledge_root)
    status = builder.build(force=args.force)
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0


def _knowledge_status(args: argparse.Namespace) -> int:
    settings = AgentSettings.from_env(require_api_key=False)
    status = HybridKnowledgeRetriever(settings.knowledge_root).status()
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0 if status.get("ready") else 1


def _knowledge_search(args: argparse.Namespace) -> int:
    settings = AgentSettings.from_env(require_api_key=False)
    retriever = HybridKnowledgeRetriever(settings.knowledge_root)
    results = retriever.retrieve(args.query, limit=args.limit)
    print(
        json.dumps(
            [item.model_dump(mode="json") for item in results],
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _validate_shanghai(args: argparse.Namespace) -> int:
    settings = AgentSettings.from_env(require_api_key=False)
    report = run_shanghai_validation(
        settings,
        preset_id=args.preset,
        repeat=args.repeat,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    return 0 if report.get("passed") else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="power-skill-agent")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Run the single decision-center workflow")
    run_parser.add_argument("--task", required=True)
    run_parser.add_argument("--context", type=Path)
    run_parser.add_argument("--session-id")
    run_parser.add_argument("--output", type=Path)
    run_parser.add_argument("--auto-approve", action="store_true")
    run_parser.set_defaults(handler=_run)

    catalog_parser = subparsers.add_parser("catalog", help="List callable components")
    catalog_parser.set_defaults(handler=_catalog)

    schema_parser = subparsers.add_parser("schema", help="Show a component input schema")
    schema_parser.add_argument("component_id")
    schema_parser.set_defaults(handler=_schema)

    config_parser = subparsers.add_parser("check-config", help="Show non-secret runtime configuration")
    config_parser.set_defaults(handler=_check_config)

    smoke_parser = subparsers.add_parser("smoke-llm", help="Make one minimal DeepSeek API call")
    smoke_parser.set_defaults(handler=_smoke_llm)

    index_parser = subparsers.add_parser("knowledge-index", help="Build the persistent hybrid knowledge index")
    index_parser.add_argument("--force", action="store_true")
    index_parser.add_argument("--legacy", action="store_true", help="Build the explicitly labelled legacy hashing index")
    index_parser.set_defaults(handler=_knowledge_index)

    status_parser = subparsers.add_parser("knowledge-status", help="Show knowledge index status")
    status_parser.set_defaults(handler=_knowledge_status)

    search_parser = subparsers.add_parser("knowledge-search", help="Search indexed knowledge evidence")
    search_parser.add_argument("--query", action="append", required=True)
    search_parser.add_argument("--limit", type=int, default=6)
    search_parser.set_defaults(handler=_knowledge_search)

    validation_parser = subparsers.add_parser(
        "validate-auckland",
        help="Run the Auckland power-network acceptance case",
    )
    validation_parser.add_argument("--preset", choices=sorted(["quick", "formal"]), default="quick")
    validation_parser.add_argument(
        "--repeat",
        action="store_true",
        help="Execute twice and compare fixed-seed scientific fingerprints",
    )
    validation_parser.set_defaults(handler=_validate_shanghai)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except (AgentConfigurationError, FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
