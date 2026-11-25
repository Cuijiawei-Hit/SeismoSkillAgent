"""Explicit healthcare units and input normalization, separate from calibration.

EDP values are normalized once at the workbook adapter boundary. A source's
declared numerical convention takes precedence over legacy display headers;
both remain in provenance. No conversion is inferred from magnitude or from a
header alone, and declaring units does not establish their scientific origin.
"""
from __future__ import annotations

from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict

from engineering_skills.core.exceptions import DatasetValidationError


UNIT_STANDARD_ID = "healthcare_units_v1"
EDP_NAMES = ["PFA", "PFV", "PFD", "IDR"]
EDP_UNITS = ["g", "m/s", "m", "ratio"]
STANDARD_GRAVITY_M_S2 = 9.80665


def canonical_units() -> dict[str, str]:
    """Return the sole internal representation, with each time scale explicit."""
    return {
        "PGA": "g", "PFA": "g", "PFV": "m/s", "PFD": "m", "IDR": "ratio",
        "travel_time": "minute", "treatment_time": "hour", "resource_occupancy": "hour",
        "repair_time": "day", "recovery_time": "day", "population": "person",
        "probability": "ratio", "fragility_beta": "dimensionless",
    }


class EDPInputUnits(BaseModel):
    """Units of raw EDP numbers, before one adapter-boundary conversion."""

    model_config = ConfigDict(extra="forbid")

    PFA: Literal["g", "m/s^2"] = "g"
    PFV: Literal["m/s", "cm/s"] = "m/s"
    PFD: Literal["m", "cm", "mm"] = "m"
    IDR: Literal["ratio", "percent"] = "ratio"


def validate_canonical_units(units: dict[str, Any] | None) -> None:
    """Reject explicit noncanonical metadata; missing legacy keys remain visible.

    Compatibility with an old metadata map is not proof of the physical input
    units. The caller retains the corresponding legacy-interpretation record.
    """
    if units is None:
        return
    if not isinstance(units, dict):
        raise DatasetValidationError("Canonical healthcare units must be a mapping")
    for key, expected in canonical_units().items():
        if key in units and units[key] != expected:
            raise DatasetValidationError(
                f"Canonical healthcare unit mismatch for {key}: expected {expected!r}, "
                f"received {units[key]!r}; normalize raw inputs at the adapter boundary"
            )


def _header_unit(name: str, header: str) -> str | None:
    """Recognize labels only for discrepancy reporting, never for conversion."""
    text = header.lower().replace(" ", "").replace("²", "^2")
    if name == "IDR":
        if "%" in text or "percent" in text:
            return "percent"
        if "ratio" in text or "dimensionless" in text:
            return "ratio"
    elif name == "PFA":
        if "m/s^2" in text or "m/s2" in text:
            return "m/s^2"
        if "/g" in text or "(g)" in text:
            return "g"
    elif name == "PFV":
        if "cm/s" in text:
            return "cm/s"
        if "m/s" in text:
            return "m/s"
    elif name == "PFD":
        for unit in ("mm", "cm", "m"):
            if f"/{unit}" in text or f"({unit})" in text:
                return unit
    return None


def normalize_edp_inputs(
    edp: dict[str, np.ndarray],
    input_units: EDPInputUnits | dict[str, str] | None = None,
    *,
    basis: str | None = None,
    raw_headers: dict[str, list[str]] | None = None,
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    """Normalize raw EDPs without modifying inputs or guessing their units.

    A missing declaration preserves the prior adapter's numeric convention and
    records that compatibility assumption. Formal requests declare all units
    explicitly. Fragility medians remain in their existing canonical demand
    units; this declaration concerns EDP source numbers only.
    """
    explicit = input_units is not None
    units = input_units if isinstance(input_units, EDPInputUnits) else EDPInputUnits.model_validate(input_units or {})
    declared = units.model_dump()
    factors = {
        "PFA": 1.0 if units.PFA == "g" else 1.0 / STANDARD_GRAVITY_M_S2,
        "PFV": 1.0 if units.PFV == "m/s" else 0.01,
        "PFD": {"m": 1.0, "cm": 0.01, "mm": 0.001}[units.PFD],
        "IDR": 1.0 if units.IDR == "ratio" else 0.01,
    }
    normalized: dict[str, np.ndarray] = {}
    multiplier = np.asarray([factors[name] for name in EDP_NAMES], dtype=float)
    for scenario, values in edp.items():
        array = np.asarray(values, dtype=float)
        if array.ndim != 3 or array.shape[-1] != 4:
            raise DatasetValidationError("EDP normalization requires samples x floor x 4 arrays")
        if np.any(~np.isfinite(array)) or np.any(array < 0):
            raise DatasetValidationError("EDP source values must be finite and nonnegative")
        normalized[scenario] = array * multiplier

    headers = {name: list(values) for name, values in (raw_headers or {}).items()}
    conflicts = []
    for name in EDP_NAMES:
        for index, header in enumerate(headers.get(name, [])):
            labelled = _header_unit(name, str(header))
            if labelled is not None and labelled != declared[name]:
                conflicts.append({
                    "quantity": name, "block_index": index, "raw_header": str(header),
                    "header_unit": labelled, "input_unit": declared[name],
                    "resolution": (
                        "explicit_input_declaration_overrides_legacy_label" if explicit
                        else "legacy_adapter_fallback_preserves_numeric_convention"
                    ),
                })
    return normalized, {
        "standard_id": UNIT_STANDARD_ID,
        "canonical_units": canonical_units(),
        "input_edp_units": declared,
        "conversion_factors": factors,
        "basis": basis or ("explicit_dataset_source_declaration" if explicit else "legacy_adapter_numerical_convention"),
        "declaration_mode": "explicit" if explicit else "legacy_compatibility_fallback",
        "raw_headers": headers,
        "header_conflicts": conflicts,
        "normalization_boundary": "raw_workbook_edp_to_canonical_dataset_once",
        "physical_source_verification": "not_established_by_unit_normalization",
        "fragility_parameter_units": "Existing medians use canonical demand units; beta is dimensionless log dispersion",
    }
