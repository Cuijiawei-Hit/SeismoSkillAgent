from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from .units import EDPInputUnits, EDP_NAMES, EDP_UNITS


ResourceName = Literal["doctors", "nurses", "anesthetists", "radiologists", "imaging_rooms", "operating_rooms", "beds"]


class FloorObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    floor: int = Field(ge=1)
    PFA: float | None = Field(default=None, ge=0)
    PFV: float | None = Field(default=None, ge=0)
    PFD: float | None = Field(default=None, ge=0)
    IDR: float | None = Field(default=None, ge=0, le=1)


class HospitalObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    hospital_id: str
    max_idr: float | None = Field(default=None, ge=0, le=1)
    available_resources: dict[ResourceName, float] = Field(default_factory=dict)
    floor_edp: list[FloorObservation] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_resources(self) -> "HospitalObservation":
        if any(value < 0 for value in self.available_resources.values()):
            raise ValueError("Observed resources must be nonnegative")
        floors = [item.floor for item in self.floor_edp]
        if len(set(floors)) != len(floors):
            raise ValueError("Observed floor identifiers must be unique")
        return self


class ObservedScenario(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    scenario_id: str = Field(min_length=1, max_length=100)
    pga_g: float = Field(ge=0, le=10)
    reference_scenario_id: str | None = None
    source: str = Field(min_length=3, max_length=1000)
    observed_at: datetime
    edp_units: EDPInputUnits = Field(
        default_factory=EDPInputUnits,
        description="观测包使用规范单位：PFA g、PFV m/s、PFD m、IDR ratio；非规范观测须先换算。",
    )
    hospitals: list[HospitalObservation] = Field(default_factory=list)
    travel_time_minutes: dict[str, dict[str, float | None]] = Field(default_factory=dict)
    casualty_day_counts: dict[str, list[int]] = Field(default_factory=dict)
    casualty_night_counts: dict[str, list[int]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_observation(self) -> "ObservedScenario":
        if self.edp_units.model_dump() != dict(zip(EDP_NAMES, EDP_UNITS)):
            raise ValueError("Observed EDP must use canonical g, m/s, m and ratio units; convert source observations before submission")
        if self.observed_at.tzinfo is None:
            raise ValueError("Observed timestamps must include a timezone")
        ids = [item.hospital_id for item in self.hospitals]
        if len(set(ids)) != len(ids):
            raise ValueError("Observed hospital identifiers must be unique")
        for row in self.travel_time_minutes.values():
            if any(value is not None and value < 0 for value in row.values()):
                raise ValueError("Observed travel times must be nonnegative or null for unreachable")
        for rows in (self.casualty_day_counts, self.casualty_night_counts):
            if any(len(row) != 3 or any(value < 0 for value in row) for row in rows.values()):
                raise ValueError("Observed casualty counts need three nonnegative severity counts")
        return self
