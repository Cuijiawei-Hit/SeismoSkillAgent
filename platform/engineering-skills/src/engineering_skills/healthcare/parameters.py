from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


ModelProfile = Literal["legacy_v1", "legacy_ms_v1", "constrained_v2"]
EmergencySeverityScope = Literal["moderate_severe", "all_severities"]
RESOURCE_IDS = ["doctors", "nurses", "anesthetists", "radiologists", "imaging_rooms", "operating_rooms", "beds"]
SEVERITY_IDS = ["minor", "moderate", "severe"]
SEVERITY_LABELS_ZH = ["轻伤", "中伤", "重伤"]
EMERGENCY_SEVERITY_INDICES = (1, 2)


def uses_constrained_engineering(profile: ModelProfile) -> bool:
    """Return whether upstream and recovery models use the constrained-v2 kernels."""

    return profile == "constrained_v2"


def uses_shared_resource_treatment(profile: ModelProfile) -> bool:
    """Return whether casualty treatment uses the moderate/severe shared-resource scheduler."""

    return profile in {"legacy_ms_v1", "constrained_v2"}


def emergency_severity_indices(scope: EmergencySeverityScope) -> tuple[int, ...]:
    return EMERGENCY_SEVERITY_INDICES if scope == "moderate_severe" else (0, 1, 2)


def effective_severity_weights(
    values: list[float],
    scope: EmergencySeverityScope,
) -> list[float]:
    """Mask and renormalize weights over the declared emergency-treatment scope."""

    validate_severity_weights(values)
    active = set(emergency_severity_indices(scope))
    masked = [value if index in active else 0.0 for index, value in enumerate(values)]
    total = sum(masked)
    if total <= 0:
        raise ValueError("At least one included emergency severity must have a positive weight")
    return [value / total for value in masked]


class TreatmentParameters(BaseModel):
    """Explicit assumptions for resource-constrained cohort planning, not clinical guidance."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    time_unit: Literal["hour"] = "hour"
    parameter_version: str = "healthcare_resource_assumptions_v2"
    source: str = "Original healthcare model; pending local engineering and clinical calibration"
    verification_status: Literal["unverified", "expert_confirmed"] = "unverified"
    confirmed_by: str | None = None
    evidence_reference: str | None = None
    survival_curve_source: str = "Imported dataset survival curves; local clinical validation pending"
    survival_curve_verified: bool = False
    survival_curve_evidence: str | None = None
    survival_curve_probabilities: list[list[float]] | None = None
    survival_curve_policy: Literal["strict", "conservative_envelope"] = "conservative_envelope"
    emergency_severity_scope: EmergencySeverityScope = "moderate_severe"
    resource_requirements: list[list[float]] = Field(default_factory=lambda: [
        [1, 1, 0, 0, 0, 0, 0],
        [1, 2, 0, 1, 1, 0, 1],
        [2, 3, 1, 1, 1, 1, 1],
    ])
    occupancy_hours: list[list[float]] = Field(default_factory=lambda: [
        [.25, .25, 0, 0, 0, 0, 0],
        [.5, .5, 0, .25, .25, 0, 24],
        [3, 3, 3, .25, .25, 2.5, 72],
    ])
    time_step_hours: float = Field(default=1.0, ge=.25, le=6.0)
    integer_admissions: bool = True
    pre_transport_delay_hours: float = Field(default=0.0, ge=0, le=168)
    utility_weights: list[float] = Field(default_factory=lambda: [0.0, .375, .625])
    minimum_service_fractions: list[float] = Field(default_factory=lambda: [0., 0., 0.])
    solver_time_limit_seconds: float = Field(default=30.0, gt=0, le=300)
    source_note: str = "Moderate and severe casualties enter emergency hospital scheduling by default; minor casualties remain in source-demand provenance. Constant resources; occupancy rounded up to time slots."

    @model_validator(mode="after")
    def check_contract(self) -> "TreatmentParameters":
        for name in ("resource_requirements", "occupancy_hours"):
            matrix = getattr(self, name)
            if len(matrix) != 3 or any(len(row) != 7 for row in matrix):
                raise ValueError(f"{name} must have shape (3 severities, 7 resources)")
            if any(not math.isfinite(v) or v < 0 for row in matrix for v in row):
                raise ValueError(f"{name} must contain finite nonnegative values")
        for requirements, durations in zip(self.resource_requirements, self.occupancy_hours):
            if not any(requirements):
                raise ValueError("Each severity requires at least one resource")
            if any((r > 0) != (t > 0) for r, t in zip(requirements, durations)):
                raise ValueError("A resource requirement and its occupancy time must both be positive or both zero")
        if max(v for row in self.occupancy_hours for v in row) > 720:
            raise ValueError("Resource occupancy must not exceed 720 hours")
        validate_severity_weights(self.utility_weights)
        effective_severity_weights(self.utility_weights, self.emergency_severity_scope)
        if len(self.minimum_service_fractions) != 3 or any(
            not math.isfinite(v) or not 0 <= v <= 1 for v in self.minimum_service_fractions
        ):
            raise ValueError("minimum_service_fractions must contain three values in [0, 1]")
        inactive = set(range(3)) - set(emergency_severity_indices(self.emergency_severity_scope))
        if any(self.minimum_service_fractions[index] > 0 for index in inactive):
            raise ValueError("Excluded injury severities cannot have a minimum service fraction")
        if self.verification_status == "expert_confirmed" and not (self.confirmed_by and self.evidence_reference):
            raise ValueError("Expert-confirmed parameters require confirmed_by and evidence_reference")
        if self.survival_curve_verified and not self.survival_curve_evidence:
            raise ValueError("A verified survival curve requires an evidence reference")
        if self.survival_curve_probabilities is not None:
            curves = self.survival_curve_probabilities
            if len(curves) != 3 or not curves[0] or any(len(row) != len(curves[0]) for row in curves):
                raise ValueError("Survival curves require three equally sized hourly sequences starting at earthquake time zero")
            if any(not 0 <= value <= 1 for row in curves for value in row):
                raise ValueError("Survival probabilities must lie within [0, 1]")
            if self.survival_curve_policy == "strict" and any(right > left + 1e-9 for row in curves for left, right in zip(row, row[1:])):
                raise ValueError("Waiting-time survival curves must be nonincreasing")
        return self


def validate_severity_weights(values: list[float]) -> None:
    if len(values) != 3 or any(not math.isfinite(v) or v < 0 for v in values):
        raise ValueError("severity_weights must contain three finite nonnegative values")
    if abs(sum(values) - 1.0) > 1e-9:
        raise ValueError("severity_weights must sum to one")


class RecoveryPrecedence(BaseModel):
    """One hospital task must finish before another can begin."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    before_hospital_id: str = Field(min_length=1, max_length=128)
    after_hospital_id: str = Field(min_length=1, max_length=128)


class RecoveryConstraints(BaseModel):
    """Case-supplied hard constraints for the current identical-crew model."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    available_team_count: int | None = Field(
        default=None, ge=0, le=100, strict=True,
        description="Case-declared available crew cap. Does not verify the field inventory.",
    )
    precedence: list[RecoveryPrecedence] = Field(default_factory=list, max_length=100)
    completion_deadline_days: float | None = Field(
        default=None, gt=0, le=5000, strict=True,
        description="Latest permitted repair makespan in every supplied realization. Independent of the resilience evaluation window.",
    )

    @property
    def active(self) -> bool:
        return self.available_team_count is not None or bool(self.precedence) or self.completion_deadline_days is not None


class DecisionPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    mode: Literal["resilience_first", "weighted"] = "resilience_first"
    resilience_weight: float = Field(default=1, ge=0, le=1)
    duration_weight: float = Field(default=0, ge=0, le=1)
    cost_weight: float = Field(default=0, ge=0, le=1)
    risk_weight: float = Field(default=0, ge=0, le=1)
    duration_reference_days: float = Field(default=365, gt=0)
    cost_reference: float | None = Field(default=None, gt=0)
    team_daily_cost: float | None = Field(default=None, ge=0)
    cost_unit: str | None = None
    cost_source: str | None = None
    risk_quantile: float = Field(default=.1, gt=0, lt=1)
    required_first_hospital_id: str | None = None
    recovery_constraints: RecoveryConstraints | None = None

    @model_validator(mode="after")
    def check_weights(self) -> "DecisionPreferences":
        weights = (self.resilience_weight, self.duration_weight, self.cost_weight, self.risk_weight)
        if abs(sum(weights) - 1) > 1e-9:
            raise ValueError("Decision evaluation weights must sum to one")
        if self.mode == "resilience_first" and weights != (1, 0, 0, 0):
            raise ValueError("Non-default evaluation weights require weighted mode")
        if self.cost_weight and not (
            self.team_daily_cost is not None and self.cost_reference and self.cost_source and self.cost_unit
        ):
            raise ValueError("Cost evaluation requires a reference, team daily cost, unit, and source")
        return self
