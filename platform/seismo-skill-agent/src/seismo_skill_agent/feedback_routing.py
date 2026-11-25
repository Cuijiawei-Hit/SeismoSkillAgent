from __future__ import annotations

from copy import deepcopy
import math
import re
from typing import Any


PRESENTATION_FIELDS = {"output_language", "report_title", "presentation_instructions"}
RECOVERY_FIELDS = {"team_count", "daily_work_hours", "team_efficiency", "repair_objective", "target_function",
                   "ga_population", "ga_generations", "repair_constraints", "available_team_count", "completion_deadline_days"}


def feedback_route(patch: dict, targets_changed: bool = False) -> str:
    keys = set(patch)
    if targets_changed:
        return "dependency_recomposition"
    if keys and keys <= PRESENTATION_FIELDS:
        return "presentation_only"
    if keys and keys <= RECOVERY_FIELDS | PRESENTATION_FIELDS:
        return "recovery_and_downstream"
    return "dependency_aware_recomputation"


def feedback_change_summary(before: dict, after: dict) -> dict:
    result = {"hard_constraints": [], "preferences": [], "engineering_parameters": [], "presentation": [],
              "automatic_constraint_relaxation": False}
    hard = {"team_count", "available_team_count", "completion_deadline_days"}

    def compare(left, right, prefix=""):
        for key in sorted(left.keys() | right.keys()):
            path = f"{prefix}.{key}" if prefix else key
            old, new = left.get(key), right.get(key)
            if isinstance(old, dict) and isinstance(new, dict):
                compare(old, new, path)
            elif old != new:
                kind = ("hard_constraints" if path in hard or path.startswith("repair_constraints.")
                        else "presentation" if path in PRESENTATION_FIELDS
                        else "preferences" if path == "repair_objective" else "engineering_parameters")
                result[kind].append({"field": path, "before": old, "after": new})
    compare(before, after)
    return result


def relaxes_recovery_constraints(previous: dict, revised: dict) -> bool:
    """Do not remove predecessors, release times or crew restrictions via free text."""
    for field in ("available_team_count", "completion_deadline_days"):
        old, new = previous.get(field), revised.get(field)
        if old is not None and (not isinstance(new, (int, float)) or isinstance(new, bool) or new > old):
            return True
    before = previous.get("repair_constraints") or {}
    after = revised.get("repair_constraints") or {}
    if not isinstance(before, dict) or not isinstance(after, dict):
        return bool(before)
    for key, rule in before.items():
        if not isinstance(rule, dict):
            return True
        new = after.get(key, {})
        if not isinstance(new, dict):
            return True
        if set(rule.get("predecessors") or []) - set(new.get("predecessors") or []):
            return True
        if new.get("release_day", 0) < rule.get("release_day", 0):
            return True
        allowed = rule.get("allowed_teams")
        if allowed is not None:
            new_allowed = new.get("allowed_teams")
            if new_allowed is None or not set(new_allowed).issubset(set(allowed)):
                return True
    return False


def normalize_recovery_patch(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict]]:
    """Accept canonical native task constraints; never infer asset IDs or precedence."""
    if "repair_constraints" not in payload:
        return payload, []
    constraints = payload["repair_constraints"]
    if not isinstance(constraints, dict):
        raise ValueError("repair_constraints must map node:id or pipe:id to constraint objects")
    for key, rule in constraints.items():
        if not isinstance(key, str) or not re.fullmatch(r"(?:node|pipe):[1-9]\d*", key):
            raise ValueError("Repair constraint keys must use native node:id or pipe:id identifiers")
        if not isinstance(rule, dict) or set(rule) - {"predecessors", "release_day", "allowed_teams"}:
            raise ValueError("Repair constraints support predecessors, release_day and allowed_teams only")
        predecessors = rule.get("predecessors", [])
        if not isinstance(predecessors, list) or any(not isinstance(x, str) or not re.fullmatch(r"(?:node|pipe):[1-9]\d*", x) for x in predecessors):
            raise ValueError("Repair predecessors must be explicit node:id or pipe:id identifiers")
        release = rule.get("release_day", 0)
        if isinstance(release, bool) or not isinstance(release, (int, float)) or not math.isfinite(release) or release < 0:
            raise ValueError("release_day must be a nonnegative finite number of days")
        allowed = rule.get("allowed_teams")
        if allowed is not None and (not isinstance(allowed, list) or not allowed or any(type(x) is not int or x < 1 for x in allowed)):
            raise ValueError("allowed_teams must contain positive integer crew IDs")
    return payload, []


def safe_format_repair(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict]]:
    """Normalize explicit numeric representation, preserving the physical request."""
    repaired = deepcopy(payload)
    trace = []
    units = {
        "team_count": r"(?:crews?|teams?|支)?", "seed": "", "ga_population": "", "ga_generations": r"(?:代)?",
        "pga_g": r"(?:g)?", "daily_work_hours": r"(?:h|hours?|小时)?", "team_efficiency": "",
        "target_function": "", "available_team_count": r"(?:crews?|teams?|支)?",
        "completion_deadline_days": r"(?:d|days?|天)?",
    }
    integers = {"team_count", "seed", "ga_population", "ga_generations", "available_team_count"}
    for key, unit in units.items():
        value = payload.get(key)
        if not isinstance(value, str):
            continue
        match = re.fullmatch(r"\s*([+]?\d+(?:\.\d+)?)\s*" + unit + r"\s*", value, re.I)
        if not match:
            continue
        numeric = float(match.group(1))
        if key in integers and not numeric.is_integer():
            continue
        repaired[key] = int(numeric) if key in integers else numeric
        trace.append({"field": key, "before": value, "after": repaired[key], "rule": "explicit_numeric_value_in_declared_units"})
    for key, allowed in {"assessment_mode": {"predictive"}, "power_damage_mode": {"most_likely", "sampled"},
                         "repair_objective": {"function_loss_area", "target_time"}}.items():
        value = payload.get(key)
        if isinstance(value, str) and value.strip().lower() in allowed and value != value.strip().lower():
            repaired[key] = value.strip().lower()
            trace.append({"field": key, "before": value, "after": repaired[key], "rule": "canonical_enum_whitespace_and_case"})
    return repaired, trace
