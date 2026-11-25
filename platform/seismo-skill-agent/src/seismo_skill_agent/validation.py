from __future__ import annotations

import hashlib
import json
import math
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import AgentSettings
from .models import ExecutionPlan
from .skill_bridge import DYNAMIC_COMPOSITION_ID, SkillRegistryBridge


def _scientific_fingerprint(result: dict[str, Any]) -> str:
    selected = {}
    for stage, data in result.get("data", {}).get("node_results", {}).items():
        summary = data.get("summary", {})
        # Paths and file versions are proven separately; fingerprint computed quantities.
        selected[stage] = {key: value for key, value in summary.items()
                           if key not in {"dataset_artifact", "damage_artifact", "function_artifact", "recovery_artifact"}}
    return hashlib.sha256(json.dumps(selected, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


def _check(checks, name, passed, detail):
    checks.append({"name": name, "passed": bool(passed), "detail": detail})


def run_auckland_validation(settings: AgentSettings, *, preset_id: str = "quick", repeat: bool = False) -> dict[str, Any]:
    from .web import load_preset
    context = load_preset(preset_id)
    bridge = SkillRegistryBridge(settings.skill_run_root)
    target = "power_system.result_reporting"
    plan = bridge.compile_plan(ExecutionPlan(component_id=DYNAMIC_COMPOSITION_ID,
        selected_skill_ids=[target], target_skill_ids=[target], request_payload=context,
        rationale="奥克兰冻结电网案例完整工程链验收。"))
    validation = bridge.validate(plan)
    if not validation.valid or validation.normalized_input is None:
        raise ValueError("Auckland validation failed: " + "; ".join(x.message for x in validation.issues))
    plan = plan.model_copy(update={"request_payload": validation.normalized_input})
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_id = f"validation-auckland-{preset_id}-{timestamp}-{uuid.uuid4().hex[:8]}"
    started = time.perf_counter()
    result = bridge.execute(plan, run_id)
    duration = time.perf_counter() - started
    data = result.get("data", {})
    nodes = data.get("node_results", {})
    function = nodes.get("power_system.function_assessment", {}).get("function", {})
    recovery = nodes.get("power_system.recovery_optimization", {}).get("recovery", {})
    resilience = nodes.get("power_system.resilience_assessment", {}).get("resilience", {})
    inventory = nodes.get("power_system.input_preparation", {}).get("inventory", {})
    checks = []
    _check(checks, "registry_preflight", validation.valid, len(validation.issues))
    _check(checks, "compiled_electric_targets", all(x.startswith("power_system.") for x in plan.selected_skill_ids), plan.selected_skill_ids)
    _check(checks, "completed_eight_components", result.get("status") == "succeeded" and len(nodes) == 8, len(nodes))
    _check(checks, "frozen_auckland_inventory", inventory.get("node_count", 0) > 0 and inventory.get("branch_count", 0) > 0, inventory)
    pre, post = function.get("pre_supply_mw"), function.get("post_supply_mw")
    _check(checks, "supply_bounds", isinstance(pre, (int, float)) and isinstance(post, (int, float)) and 0 <= post <= pre and pre > 0,
           {"pre_mw": pre, "post_mw": post})
    diagnostic = function.get("diagnostics", {})
    _check(checks, "power_flow_constraints", diagnostic.get("max_equation_residual", math.inf) <= 1e-6 and diagnostic.get("max_capacity_excess_mw", math.inf) <= 1e-6, diagnostic)
    strategies = recovery.get("strategies", [])
    _check(checks, "repair_strategy_count", {x.get("id") for x in strategies} == {"id_order", "importance", "ga"}, [x.get("id") for x in strategies])
    _check(checks, "shared_initial_damage", bool(strategies) and all(abs(x["curve"][0]["function"] - function.get("function_ratio", -1)) <= 1e-10 for x in strategies),
           [x.get("curve", [{}])[0].get("function") for x in strategies])
    _check(checks, "continuous_resilience_bounds", bool(strategies) and all(0 <= x.get("resilience_index", -1) <= 1 and x.get("total_days", -1) >= 0 for x in strategies),
           [{k: x.get(k) for k in ("id", "resilience_index", "total_days")} for x in strategies])
    _check(checks, "independent_legacy_grading", resilience.get("legacy_grades", {}).get("basis") == "original_sequential_recovery", resilience.get("legacy_grades"))
    artifacts = result.get("artifacts", [])
    _check(checks, "artifact_integrity", bool(artifacts) and all(Path(x["path"]).is_file() and x.get("checksum_sha256") and x.get("size_bytes", 0) > 0 for x in artifacts), len(artifacts))
    fingerprints = [_scientific_fingerprint(result)]
    run_ids = [run_id]
    if repeat:
        repeated_id = run_id + "-repeat"
        repeated = bridge.execute(plan, repeated_id)
        fingerprints.append(_scientific_fingerprint(repeated)); run_ids.append(repeated_id)
        _check(checks, "fixed_seed_reproducibility", fingerprints[0] == fingerprints[1], fingerprints)
    report = {"schema_version": 1, "generated_at": datetime.now(timezone.utc).isoformat(), "preset_id": preset_id,
              "passed": all(x["passed"] for x in checks), "duration_seconds": duration, "run_ids": run_ids,
              "scientific_fingerprints": fingerprints, "checks": checks,
              "key_results": {"inventory": inventory, "function": function, "strategies": [{k: x.get(k) for k in ("id", "total_days", "target_time_days", "resilience_index")} for x in strategies]},
              "artifact_count": len(artifacts), "artifacts": artifacts}
    directory = settings.agent_run_root / "system-validation" / f"auckland-{preset_id}-{timestamp}"
    directory.mkdir(parents=True, exist_ok=True)
    report["report_directory"] = str(directory.resolve())
    (directory / "acceptance_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    text = ["# 奥克兰电力系统验收", "", f"总体：{'通过' if report['passed'] else '未通过'}", ""]
    text.extend(f"- {'通过' if x['passed'] else '未通过'}：{x['name']}" for x in checks)
    (directory / "acceptance_report.md").write_text("\n".join(text) + "\n", encoding="utf-8")
    return report


# Existing CLI integrations can migrate without importing the former medical validator.
run_shanghai_validation = run_auckland_validation
