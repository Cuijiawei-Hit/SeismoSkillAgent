"""Versioned metric contracts used by healthcare executions.

Historical profiles remain readable for provenance and low-level comparisons.
They are not silently promoted to this contract or accepted for new execution.
"""
from __future__ import annotations

from copy import deepcopy
import json
from typing import Any

import numpy as np
from pydantic import BaseModel, Field, model_validator


METRIC_STANDARD_ID = "healthcare_ms_72h_v1"
METRIC_STANDARD_60H_ID = "healthcare_ms_60h_v1"
OFFICIAL_MODEL_PROFILE = "constrained_v2"
DEFAULT_SEVERITY_WEIGHTS = (0.0, 0.375, 0.625)
TREATMENT_HORIZON_HOURS = 72
HEADLINE_METRIC_IDS = (
    "moderate_72h_treatment_start_coverage",
    "severe_72h_treatment_start_coverage",
)
SURVIVAL_METRIC_IDS = (
    "moderate_72h_survival_weighted_fulfillment",
    "severe_72h_survival_weighted_fulfillment",
)

_STANDARD = {
    "id": METRIC_STANDARD_ID,
    "model_profile": OFFICIAL_MODEL_PROFILE,
    "emergency_severity_scope": "moderate_severe",
    "emergency_severity_indices": [1, 2],
    "treatment_horizon_hours": TREATMENT_HORIZON_HOURS,
    "severity_weights": list(DEFAULT_SEVERITY_WEIGHTS),
    "headline_metric_ids": list(HEADLINE_METRIC_IDS),
    "secondary_metric_ids": list(SURVIVAL_METRIC_IDS),
    "coverage_numerator": "Casualties starting treatment within 72 hours after earthquake time zero",
    "coverage_denominator": "All source demand of the same severity, including unassigned and untreated demand",
    "aggregation": "Sum counts across Monte Carlo realizations, then divide; report each day/night period separately",
    "zero_demand": "not_applicable_null",
    "survival_numerator": "Treatment starts weighted by the survival curve at their post-earthquake care-start time",
    "survival_denominator": "The same severity-specific source demand; not the treated count",
    "recovery_function": "Population-weighted post/pre potential 2SFCA accessibility ratio using the same scenario OD",
    "resilience": "Integral of the recovery accessibility curve divided by its explicitly reported day horizon",
    "recovery_time_step_days": 1.0,
    "legacy_target_grading": "excluded_pending_verified_target_mapping",
}


_STANDARD_60H = {
    **_STANDARD,
    "id": METRIC_STANDARD_60H_ID,
    "treatment_horizon_hours": 60,
    "headline_metric_ids": [
        "moderate_60h_treatment_start_coverage",
        "severe_60h_treatment_start_coverage",
    ],
    "secondary_metric_ids": [
        "moderate_60h_survival_weighted_fulfillment",
        "severe_60h_survival_weighted_fulfillment",
    ],
    "coverage_numerator": "Casualties starting treatment during [0, 60) hours after earthquake time zero",
    "spatial_capacity_reference_hours": 72,
}

_STANDARDS = {72: _STANDARD, 60: _STANDARD_60H}


def metric_standard_record(horizon_hours: int = TREATMENT_HORIZON_HOURS) -> dict[str, Any]:
    try:
        return deepcopy(_STANDARDS[horizon_hours])
    except (KeyError, TypeError) as exc:
        raise ValueError("Healthcare treatment horizon must be 60 or 72 hours") from exc


def metric_horizon_hours(record: Any) -> int:
    if not is_official_metric_record(record):
        raise ValueError("The healthcare metric definition is missing or incompatible")
    return int(record.get("metric_standard", record)["treatment_horizon_hours"])


def ensure_sourced_survival_curve(parameters: Any, horizon_hours: int) -> None:
    if horizon_hours != 60:
        return
    if hasattr(parameters, "model_dump"):
        parameters = parameters.model_dump(mode="json")
    curves = parameters.get("survival_curve_probabilities") if isinstance(parameters, dict) else None
    evidence = parameters.get("survival_curve_evidence") if isinstance(parameters, dict) else None
    if (
        not isinstance(curves, list)
        or len(curves) != 3
        or any(not isinstance(row, list) or len(row) != 61 for row in curves)
        or not isinstance(evidence, str)
        or not evidence.strip()
    ):
        raise ValueError("healthcare_ms_60h_v1 requires explicit hourly survival curves from hour 0 through hour 60 and source evidence")


class MetricBoundOutput(BaseModel):
    """Explicit execution evidence; defaults must never upgrade old outputs."""

    metric_standard: dict[str, Any]
    dataset_fingerprint: str = Field(min_length=64, max_length=64)

    @model_validator(mode="after")
    def check_metric_standard(self):
        if not is_official_metric_record(self.metric_standard):
            raise ValueError("Output does not use the official healthcare metric standard")
        return self


def is_official_metric_record(record: Any) -> bool:
    if not isinstance(record, dict):
        return False
    candidate = record.get("metric_standard", record)
    if not isinstance(candidate, dict) or candidate not in _STANDARDS.values():
        return False
    if "metric_standard" in record:
        for key in ("model_profile", "emergency_severity_scope", "treatment_horizon_hours", "severity_weights"):
            if key in record and record[key] != candidate[key]:
                return False
    return True


def ensure_official_metric_inputs(payload: Any) -> None:
    """Validate supplied fields; request Schemas supply omitted defaults.

    This also accepts historical objects for inspection: callers choose when
    execution is attempted. No mutation or implicit migration is performed.
    """
    if hasattr(payload, "model_dump"):
        payload = payload.model_dump(mode="json")
    if not isinstance(payload, dict):
        raise ValueError("Healthcare metric inputs must be an object")
    selected = metric_standard_record(payload.get("treatment_horizon_hours", TREATMENT_HORIZON_HOURS))
    standard_id = selected["id"]
    requirements = {
        "model_profile": OFFICIAL_MODEL_PROFILE,
        "time_step_days": 1.0,
        "grading_model": "none",
        "emergency_severity_scope": "moderate_severe",
    }
    for name, expected in requirements.items():
        if name in payload and payload[name] != expected:
            raise ValueError(f"{standard_id} requires {name}={expected!r}; historical or alternative metrics are read-only")
    if "severity_weights" in payload:
        values = np.asarray(payload["severity_weights"], dtype=float)
        if values.shape != (3,) or not np.array_equal(values, np.asarray(DEFAULT_SEVERITY_WEIGHTS)):
            raise ValueError(f"{standard_id} requires severity_weights={list(DEFAULT_SEVERITY_WEIGHTS)}")
    parameters = payload.get("treatment_parameters")
    if hasattr(parameters, "model_dump"):
        parameters = parameters.model_dump(mode="json")
    if isinstance(parameters, dict):
        if parameters.get("emergency_severity_scope", "moderate_severe") != "moderate_severe":
            raise ValueError(f"{standard_id} requires treatment_parameters.emergency_severity_scope='moderate_severe'")
    if "metric_standard" in payload and not is_official_metric_record(payload):
        raise ValueError("The metric standard record is missing, altered, or incompatible")


def validate_artifact_metric_standard(
    arrays: dict[str, np.ndarray], horizon_hours: int | None = None,
) -> dict[str, Any]:
    """Reject unversioned historical artifacts instead of relabelling them."""
    ids = arrays.get("_metric_standard_id", np.asarray([])).tolist()
    if ids not in [[METRIC_STANDARD_ID], [METRIC_STANDARD_60H_ID]]:
        raise ValueError("Artifact metric standard is missing or incompatible; recompute from source inputs")
    try:
        record = json.loads(str(arrays["_metric_standard_json"][0]))
    except (KeyError, IndexError, ValueError, TypeError) as exc:
        raise ValueError("Artifact metric definition record is missing or invalid") from exc
    if not is_official_metric_record(record) or ids != [record["id"]]:
        raise ValueError("Artifact metric definition record differs from the official standard")
    selected_horizon = record["treatment_horizon_hours"]
    if horizon_hours is not None and selected_horizon != horizon_hours:
        raise ValueError(f"Artifact metric standard differs from the requested {horizon_hours}-hour window")
    if "emergency_severity_indices" in arrays and arrays["emergency_severity_indices"].tolist() != [1, 2]:
        raise ValueError("Artifact injury scope differs from the official moderate/severe scope")
    if "_treatment_horizon_hours" in arrays and arrays["_treatment_horizon_hours"].tolist() != [selected_horizon]:
        raise ValueError("Artifact treatment horizon differs from its declared metric standard")
    return record


def severity_coverage_record(
    demand: Any, treated: Any, survival: Any, period: str | None = None,
    *, horizon_hours: int = TREATMENT_HORIZON_HOURS,
) -> dict[str, Any]:
    """Aggregate source counts, never percentages, over MC for one period.

    Arrays have severity as their last dimension. Callers first aggregate
    source nodes or hospitals so the remaining dimensions describe MC samples.
    """
    values = [np.asarray(item, dtype=float) for item in (demand, treated, survival)]
    if any(item.ndim < 1 or item.shape[-1] != 3 for item in values):
        raise ValueError("Coverage counts require a final minor/moderate/severe dimension of size 3")
    if any(item.shape != values[0].shape for item in values):
        raise ValueError("Coverage count arrays must have matching Monte Carlo/severity shapes")
    if any(not np.all(np.isfinite(item)) or np.any(item < -1e-8) for item in values):
        raise ValueError("Coverage counts must be finite and nonnegative")
    totals = [item.reshape(-1, 3).sum(axis=0) for item in values]
    source, starts, weighted = totals
    if np.any(starts > source + 1e-6) or np.any(weighted > starts + 1e-6):
        raise ValueError("Coverage or survival-weighted counts exceed their denominator")
    result: dict[str, Any] = {}
    if period is not None:
        result["period"] = period
    standard = metric_standard_record(horizon_hours)
    for index, coverage_key, survival_key in zip(
        (1, 2), standard["headline_metric_ids"], standard["secondary_metric_ids"],
    ):
        denominator = float(source[index])
        result[coverage_key] = float(starts[index] / denominator) if denominator > 0 else None
        result[survival_key] = float(weighted[index] / denominator) if denominator > 0 else None
    return result
