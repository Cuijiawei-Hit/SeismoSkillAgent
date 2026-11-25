"""Versioned electricity metrics and explicit comparability of saved results."""
from __future__ import annotations

from copy import deepcopy
from typing import Any


HISTORICAL_NOTICE = "该历史电力结果缺少当前指标合同或数据依据，保留只读查阅；口径核对前不作净改善比较。"


def _data(value: Any) -> dict:
    if not isinstance(value, dict):
        return {}
    data = value.get("data", value)
    if not isinstance(data, dict):
        return {}
    summary = data.get("power_summary")
    return {**summary, **data} if isinstance(summary, dict) else data


def power_record(data: Any) -> bool:
    data = _data(data)
    components = [*data.get("node_results", {}), *data.get("executed_components", []), *data.get("requested_skill_ids", [])]
    standard = data.get("metric_standard")
    return bool(data.get("model_profile") == "power_dc_v1" or isinstance(standard, dict) and standard.get("system") == "power_system"
                or any(str(item).startswith("power_system.") for item in components))


def clinical_record(data: Any) -> bool:
    """Compatibility name for the platform's domain-record check."""
    return power_record(data)


def official_result(result: Any) -> bool:
    data = _data(result)
    standard = data.get("metric_standard")
    return isinstance(standard, dict) and standard.get("id") == "power_dc_v1" and standard.get("system") == "power_system"


def historical_result(result: Any) -> bool:
    return power_record(result) and not official_result(result)


def treatment_window(data: dict[str, Any]) -> int:
    """Compatibility hook. Electrical results do not have a treatment window."""
    return 0


def period_metric_fields(hours: int) -> tuple[str, ...]:
    return ()


def summary_with_metric_status(summary: Any) -> Any:
    if not isinstance(summary, dict):
        return summary
    output = deepcopy(summary)
    current = official_result(output)
    output["metric_standard_status"] = "official" if current else "historical_unverified" if power_record(output) else "independent"
    output["historical_read_only"] = power_record(output) and not current
    if output["historical_read_only"]:
        output["metric_standard_notice"] = HISTORICAL_NOTICE
    return output


def comparison_status(left: Any, right: Any) -> dict[str, Any]:
    left, right = _data(left), _data(right)
    if not left or not right:
        return {"comparable": False, "reason": "missing_summary", "paired": False}
    if not official_result(left) or not official_result(right) or left.get("metric_standard") != right.get("metric_standard"):
        return {"comparable": False, "reason": "historical_or_different_metric_standard", "paired": False}
    for key in ("dataset_fingerprint", "pga_g", "power_damage_mode"):
        if left.get(key) is None or right.get(key) is None or left[key] != right[key]:
            return {"comparable": False, "reason": f"different_or_unknown_{key}", "paired": False}
    # Different crew counts are valid interventions; identical damage is the paired basis.
    damage_key = "damage_scenario_fingerprint"
    left_damage, right_damage = left.get(damage_key), right.get(damage_key)
    paired = (left_damage == right_damage) if left_damage is not None and right_damage is not None else (
        left.get("seed") is not None and left.get("seed") == right.get("seed"))
    if left_damage is not None and right_damage is not None and left_damage != right_damage:
        return {"comparable": False, "reason": "different_damage_scenario", "paired": False}
    left_horizon, right_horizon = left.get("comparison_horizon_days"), right.get("comparison_horizon_days")
    same_horizon = left_horizon is not None and left_horizon == right_horizon
    return {"comparable": True, "reason": "same_power_metric_data_and_scenario", "paired": paired,
            "resilience_index_comparable": same_horizon,
            "resilience_comparison_reason": "same_explicit_horizon" if same_horizon else "different_or_unknown_comparison_horizon"}


def result_comparison_basis(result: Any) -> dict[str, Any]:
    data = _data(result)
    fields = ("metric_standard", "model_profile", "dataset_fingerprint", "pga_g", "power_damage_mode", "seed",
              "damage_scenario_fingerprint", "comparison_horizon_days")
    basis = {key: data.get(key) for key in fields}
    if basis["comparison_horizon_days"] is None:
        recovery = data.get("node_results", {}).get("power_system.recovery_optimization", {})
        recovery = recovery.get("recovery", recovery.get("summary", {})) if isinstance(recovery, dict) else {}
        strategies = recovery.get("strategies", []) if isinstance(recovery, dict) else []
        horizons = {row.get("comparison_horizon_days") for row in strategies if isinstance(row, dict)}
        if len(horizons) == 1 and None not in horizons:
            basis["comparison_horizon_days"] = horizons.pop()
    return basis
