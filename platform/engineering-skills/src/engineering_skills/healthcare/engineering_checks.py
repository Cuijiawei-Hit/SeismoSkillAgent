from __future__ import annotations

from dataclasses import fields
import hashlib
import json
import numpy as np
from typing import Any
from engineering_skills.core.provenance import record_check
from engineering_skills.core.artifacts import sha256_file
from engineering_skills.core.exceptions import ResultConstraintError, ModelNotApplicableError, SolverOutcomeError
from .metric_standard import TREATMENT_HORIZON_HOURS, metric_standard_record, validate_artifact_metric_standard
from .units import EDP_UNITS


class EngineeringConstraintError(ResultConstraintError):
    """A failed physical invariant is a blocking error, never a display warning."""


def require(condition: bool, rule: str) -> None:
    record_check(rule, condition)
    if not condition:
        raise EngineeringConstraintError(rule)


class ModelApplicabilityError(ModelNotApplicableError, EngineeringConstraintError):
    pass


class TreatmentSolverError(SolverOutcomeError, EngineeringConstraintError):
    pass


def require_applicable(condition: bool, rule: str) -> None:
    record_check(rule, condition)
    if not condition:
        raise ModelApplicabilityError(rule)


def require_solver_success(solved, message: str) -> None:
    record_check('HiGHS treatment scheduling successful', bool(solved.success))
    if not solved.success:
        raise TreatmentSolverError(message, solver_status=int(solved.status),
            feasibility='proven_infeasible' if solved.status == 2 else 'undetermined',
            solver_scope='fixed_dispatch_single_hospital_treatment_problem')


def bounded(values: np.ndarray, name: str, lower: float = 0, upper: float | None = None, tolerance: float = 1e-7) -> None:
    array = np.asarray(values)
    require(bool(np.all(np.isfinite(array))), f"{name}: nonfinite output")
    require(bool(np.all(array >= lower - tolerance)), f"{name}: below lower bound {lower}")
    if upper is not None:
        require(bool(np.all(array <= upper + tolerance)), f"{name}: above upper bound {upper}")


def same_shape(values: np.ndarray, expected: tuple[int, ...], name: str) -> None:
    require(np.shape(values) == expected, f"{name}: expected shape {expected}, received {np.shape(values)}")


def artifact_link(reference: Any) -> np.ndarray:
    return np.asarray([sha256_file(reference.path)])


def require_artifact_link(arrays: dict, key: str, reference: Any) -> None:
    require(key in arrays and np.array_equal(arrays[key], artifact_link(reference)),
            f"Artifact lineage mismatch: {key}")


def dataset_fingerprint(dataset: Any) -> str:
    def canonical(value: Any) -> Any:
        if isinstance(value, np.ndarray):
            return {"shape": value.shape, "dtype": str(value.dtype), "sha256": hashlib.sha256(value.tobytes()).hexdigest()}
        if isinstance(value, dict):
            return {str(key): canonical(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [canonical(item) for item in value]
        return value
    values = {item.name: canonical(getattr(dataset, item.name)) for item in fields(dataset)
              if item.name not in {"source_dir", "source_files", "warnings"}}
    return hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=True).encode()).hexdigest()


def stamp_arrays(
    dataset: Any, profile: str, arrays: dict,
    *, horizon_hours: int = TREATMENT_HORIZON_HOURS,
) -> dict[str, np.ndarray]:
    metric = metric_standard_record(horizon_hours)
    return {
        **{key: value for key, value in arrays.items() if isinstance(value, np.ndarray)},
        "_hospital_ids": np.asarray(dataset.hospital_ids),
        "_scenario_ids": np.asarray(dataset.scenario_ids),
        "_model_profile": np.asarray([profile]),
        "_edp_units": np.asarray(EDP_UNITS),
        "_dataset_fingerprint": np.asarray([dataset_fingerprint(dataset)]),
        **({
            "_metric_standard_id": np.asarray([metric["id"]]),
            "_metric_standard_json": np.asarray([json.dumps(metric, sort_keys=True)]),
        } if profile == "constrained_v2" else {}),
    }


def load_bound_artifact(
    reference: Any, dataset: Any, profile: str,
    *, horizon_hours: int = TREATMENT_HORIZON_HOURS,
) -> dict[str, np.ndarray]:
    with np.load(reference.path, allow_pickle=False) as archive:
        arrays = {key: archive[key].copy() for key in archive.files}
    if profile == "constrained_v2":
        validate_artifact_metric_standard(arrays, horizon_hours)
    if profile != "legacy_v1" or "_model_profile" in arrays:
        for name, expected in (
            ("_hospital_ids", dataset.hospital_ids), ("_scenario_ids", dataset.scenario_ids),
            ("_model_profile", [profile]), ("_edp_units", EDP_UNITS),
            ("_dataset_fingerprint", [dataset_fingerprint(dataset)]),
        ):
            require(name in arrays and arrays[name].tolist() == expected, f"Artifact binding mismatch: {name}")
    return arrays
