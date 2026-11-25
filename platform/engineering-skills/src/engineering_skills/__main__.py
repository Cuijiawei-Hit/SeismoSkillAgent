from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from .builtin import get_registry
from .core.artifacts import json_default
from .core.composition import SkillDAGCompiler, SkillDAGExecutor
from .core.models import ExecutionContext


def _read_request(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _print(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=json_default))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Engineering Skills and component runtime")
    sub = parser.add_subparsers(dest="command", required=True)

    list_cmd = sub.add_parser("list", help="List registered Skills")
    list_cmd.add_argument("--domain")
    list_cmd.add_argument("--capability")
    list_cmd.add_argument("--stage")
    list_cmd.add_argument("--assessment-mode", choices=["predictive", "rapid", "hybrid"])

    component_cmd = sub.add_parser("list-components", help="List all executable components")
    component_cmd.add_argument("--kind", choices=["engineering_skill", "support_component", "workflow"])

    type_list_cmd = sub.add_parser("list-types", help="List Engineering Skill Types")
    type_list_cmd.add_argument("--domain")

    type_describe_cmd = sub.add_parser("describe-type", help="Describe an Engineering Skill Type")
    type_describe_cmd.add_argument("type_id")
    type_describe_cmd.add_argument("--version")

    instances_cmd = sub.add_parser("list-instances", help="List executable implementations of a Skill Type")
    instances_cmd.add_argument("type_id")

    describe_cmd = sub.add_parser("describe", help="Describe a Skill or executable component")
    describe_cmd.add_argument("skill_id")
    describe_cmd.add_argument("--version")

    validate_cmd = sub.add_parser("validate", help="Validate a Skill or component request")
    validate_cmd.add_argument("skill_id")
    validate_cmd.add_argument("--request", required=True)
    validate_cmd.add_argument("--version")

    bind_cmd = sub.add_parser("bind", help="Create a deterministic runtime Skill Instance descriptor")
    bind_cmd.add_argument("skill_id")
    bind_cmd.add_argument("--request", required=True)
    bind_cmd.add_argument("--instance-id")
    bind_cmd.add_argument("--version")

    run_cmd = sub.add_parser("run", help="Execute a Skill or component")
    run_cmd.add_argument("skill_id")
    run_cmd.add_argument("--request", required=True)
    run_cmd.add_argument("--version")
    run_cmd.add_argument("--run-root", default="runs")
    run_cmd.add_argument("--run-id")

    plan_cmd = sub.add_parser(
        "plan",
        help="Compile target components into a Registry-validated DAG",
    )
    plan_cmd.add_argument("workflow_id")
    plan_cmd.add_argument("--request", required=True)
    plan_cmd.add_argument("--target", action="append", dest="targets")
    plan_cmd.add_argument(
        "--assessment-mode",
        choices=["predictive", "rapid", "hybrid"],
    )

    run_dag_cmd = sub.add_parser(
        "run-dag",
        help="Compile and execute a target-oriented Engineering Skill DAG",
    )
    run_dag_cmd.add_argument("workflow_id")
    run_dag_cmd.add_argument("--request", required=True)
    run_dag_cmd.add_argument("--target", action="append", dest="targets")
    run_dag_cmd.add_argument(
        "--assessment-mode",
        choices=["predictive", "rapid", "hybrid"],
    )
    run_dag_cmd.add_argument("--run-root", default="runs")
    run_dag_cmd.add_argument("--run-id")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    registry = get_registry()
    if args.command == "list":
        result = registry.list_skills(args.domain, args.capability, args.stage, args.assessment_mode)
        _print([item.model_dump(mode="json") for item in result])
    elif args.command == "list-components":
        result = registry.list_components(args.kind)
        _print([item.model_dump(mode="json") for item in result])
    elif args.command == "list-types":
        _print([item.model_dump(mode="json") for item in registry.list_skill_types(args.domain)])
    elif args.command == "describe-type":
        _print(registry.describe_type(args.type_id, args.version).model_dump(mode="json"))
    elif args.command == "list-instances":
        _print([item.model_dump(mode="json") for item in registry.list_instances(args.type_id)])
    elif args.command == "describe":
        _print(registry.describe(args.skill_id, args.version).model_dump(mode="json"))
    elif args.command == "validate":
        _print(registry.validate(args.skill_id, _read_request(args.request), args.version).model_dump(mode="json"))
    elif args.command == "bind":
        _print(
            registry.bind(
                args.skill_id,
                _read_request(args.request),
                args.instance_id,
                args.version,
            ).model_dump(mode="json")
        )
    elif args.command == "run":
        context = ExecutionContext(run_root=Path(args.run_root), run_id=args.run_id)
        _print(registry.execute(args.skill_id, _read_request(args.request), context, args.version).model_dump(mode="json"))
    elif args.command in {"plan", "run-dag"}:
        payload = _read_request(args.request)
        assessment_mode = args.assessment_mode or payload.get("assessment_mode")
        plan = SkillDAGCompiler(registry).compile(
            args.workflow_id,
            target_component_ids=args.targets,
            assessment_mode=assessment_mode,
            root_input_fields=set(payload),
        )
        if args.command == "plan":
            _print(plan.model_dump(mode="json"))
        else:
            run_id = args.run_id or (
                "dag-" + datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
            )
            context = ExecutionContext(
                run_root=Path(args.run_root),
                run_id=run_id,
            )
            _print(
                SkillDAGExecutor(registry)
                .execute(plan, payload, context)
                .model_dump(mode="json")
            )


if __name__ == "__main__":
    main()
