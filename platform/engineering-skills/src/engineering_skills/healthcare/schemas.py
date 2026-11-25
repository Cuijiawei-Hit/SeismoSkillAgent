from __future__ import annotations

from enum import Enum
import math
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from engineering_skills.core.models import ArtifactRef, AssessmentMode
from .parameters import (
    DecisionPreferences,
    ModelProfile,
    TreatmentParameters,
    uses_constrained_engineering,
)
from .observation_schema import ObservedScenario
from .metric_standard import OFFICIAL_MODEL_PROFILE, ensure_official_metric_inputs, ensure_sourced_survival_curve
from .units import EDPInputUnits


class DatasetProfile(str, Enum):
    AUTO = "auto"
    LEGACY_V1 = "legacy_v1"
    MODULAR_V2 = "modular_v2"
    CANONICAL = "canonical"


class EngineeringParameterSource(BaseModel):
    """Reusable engineering parameters bound independently from hospital identity."""

    repair_time_path: Path
    infrastructure_availability_path: Path
    profile_bindings: dict[str, str] = Field(default_factory=dict)


class DatasetSource(BaseModel):
    path: Path
    profile: DatasetProfile = DatasetProfile.AUTO
    engineering_parameter_source: EngineeringParameterSource | None = None
    hospital_mapping_path: Path | None = None
    allow_unverified_mapping: bool = False
    edp_input_units: EDPInputUnits | None = Field(
        default=None,
        description="原始EDP数值单位；只在工作簿适配入口转换一次。未声明时保留旧适配器数值约定并记录兼容假设。",
    )
    edp_unit_basis: str | None = Field(
        default=None, min_length=1, max_length=2000,
        description="EDP源数值单位解释依据；单位声明不等于原始结构响应生成或临床校准已核准。",
    )

    @model_validator(mode="after")
    def validate_unit_boundary(self) -> "DatasetSource":
        if self.edp_unit_basis is not None:
            self.edp_unit_basis = self.edp_unit_basis.strip()
            if not self.edp_unit_basis:
                raise ValueError("edp_unit_basis cannot be blank")
        if self.profile == DatasetProfile.CANONICAL and (
            self.edp_input_units is not None or self.edp_unit_basis is not None
        ):
            raise ValueError("Canonical datasets already contain normalized units; raw EDP declarations cannot be applied again")
        return self


class DatasetArtifacts(BaseModel):
    metadata: ArtifactRef
    arrays: ArtifactRef


class EarthquakeScenarioSelection(BaseModel):
    """Strictly select scenarios that already exist in the engineering dataset."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    scenario_ids: list[str] = Field(
        default_factory=list,
        max_length=100,
        description="需要计算的数据集情景标识，例如 ['0.4g']。",
    )
    pga_values_g: list[float] = Field(
        default_factory=list,
        max_length=100,
        description="需要严格匹配的离散PGA值，单位为g，例如 [0.4]。",
    )
    pga_range_g: tuple[float, float] | None = Field(
        default=None,
        description="按数据集已有情景筛选的PGA闭区间[min, max]，单位为g。",
    )

    @model_validator(mode="after")
    def validate_selection(self) -> "EarthquakeScenarioSelection":
        self.scenario_ids = [item.strip() for item in self.scenario_ids]
        if any(not item for item in self.scenario_ids):
            raise ValueError("scenario_ids cannot contain empty values")
        if len(set(self.scenario_ids)) != len(self.scenario_ids):
            raise ValueError("scenario_ids must be unique")
        if len(set(self.pga_values_g)) != len(self.pga_values_g):
            raise ValueError("pga_values_g must be unique")
        numeric_values = [*self.pga_values_g]
        if self.pga_range_g is not None:
            numeric_values.extend(self.pga_range_g)
            if self.pga_range_g[0] > self.pga_range_g[1]:
                raise ValueError("pga_range_g must be ordered as [minimum, maximum]")
        if any(not math.isfinite(value) or value < 0 for value in numeric_values):
            raise ValueError("PGA values must be finite and non-negative")
        if not self.scenario_ids and not self.pga_values_g and self.pga_range_g is None:
            raise ValueError("At least one scenario selector must be provided")
        return self


def validate_rapid_only_resource_loss(values: list[float]) -> list[float]:
    if any(right < left for left, right in zip(values, values[1:])):
        raise ValueError("rapid_only_resource_loss must be nondecreasing with damage state")
    return values


RapidOnlyResourceLoss = Annotated[
    list[Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]],
    Field(min_length=5, max_length=5),
    AfterValidator(validate_rapid_only_resource_loss),
]


class HealthcareAnalysisContext(BaseModel):
    """Domain input profile shared by dynamically composed healthcare Skills."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    dataset_source: DatasetSource
    assessment_mode: AssessmentMode
    model_profile: ModelProfile = OFFICIAL_MODEL_PROFILE
    treatment_parameters: TreatmentParameters = Field(default_factory=TreatmentParameters)
    decision_preferences: DecisionPreferences = Field(default_factory=DecisionPreferences)
    observations: list[ObservedScenario] = Field(default_factory=list, max_length=20)
    scenario_selection: EarthquakeScenarioSelection | None = Field(
        default=None,
        description=(
            "显式选择当前数据集已有的地震情景；未设置时计算数据集全部情景。"
            "不允许通过该字段插值或外推新情景。"
        ),
    )
    mcs: int = Field(default=1000, ge=1, le=100000)
    seed: int | None = 0
    team_count: int | None = Field(default=None, ge=1, le=100)
    control_time_days: int | None = Field(default=None, ge=2, le=5000)
    service_radius_minutes: float | None = Field(default=None, gt=0, le=240)
    casualty_period: Literal["day", "night", "both"] = "both"
    treatment_horizon_hours: int = Field(default=72, ge=1, le=720)
    strategies: list[Literal["importance", "ga_legacy", "robust_ga"]] = [
        "importance",
        "robust_ga",
    ]
    fragility_aggregation: Literal["legacy_minimum", "first_state"] = (
        "legacy_minimum"
    )
    severity_weights: list[float] = [0.0, 0.375, 0.625]
    rapid_resource_loss: list[float] = [0.0, 0.08, 0.25, 0.55, 0.9]
    rapid_only_resource_loss: RapidOnlyResourceLoss | None = Field(
        default=None,
        description="Optional damage-state loss fractions for rapid mode only. Hybrid and predictive use the existing model.",
    )
    ga_population: int = Field(default=16, ge=4, le=500)
    ga_generations: int = Field(default=20, ge=1, le=10000)
    ga_crossover_rate: float = Field(default=0.85, ge=0.0, le=1.0)
    ga_mutation_rate: float = Field(default=0.2, ge=0.0, le=1.0)
    ga_elite_count: int = Field(default=2, ge=1, le=100)
    optimization_sample_size: int = Field(default=100, ge=1, le=10000)
    primary_strategy: Literal["importance", "ga_legacy", "robust_ga"] | None = None
    time_step_days: float = Field(default=1.0, gt=0)
    recovery_threshold: float = Field(default=0.9, gt=0, le=1)
    require_monotonic: bool = True
    grading_model: Literal["none", "legacy_healthcare"] = "none"
    output_language: Literal["zh-CN", "en-US"] = Field(
        default="zh-CN",
        description="界面解释、报告和图表使用的输出语言。",
    )
    report_title: str = "医疗系统抗震韧性评价报告"
    presentation_instructions: str | None = Field(default=None, max_length=3000)
    knowledge_evidence: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    decision_objective: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def validate_configuration(self) -> "HealthcareAnalysisContext":
        ensure_sourced_survival_curve(self.treatment_parameters, self.treatment_horizon_hours)
        if "severity_weights" not in self.model_fields_set and not uses_constrained_engineering(self.model_profile):
            self.severity_weights = [0.2, 0.3, 0.5]
        if not self.strategies or len(set(self.strategies)) != len(self.strategies):
            raise ValueError("strategies must contain unique values and cannot be empty")
        if self.ga_elite_count >= self.ga_population:
            raise ValueError("ga_elite_count must be smaller than ga_population")
        if len(self.severity_weights) != 3 or any(value < 0 for value in self.severity_weights):
            raise ValueError("severity_weights must contain three nonnegative values")
        if abs(sum(self.severity_weights) - 1.0) > 1e-9:
            raise ValueError("severity_weights must sum to 1")
        if len(self.rapid_resource_loss) != 5:
            raise ValueError("rapid_resource_loss must contain five values")
        if any(value < 0 or value > 1 for value in self.rapid_resource_loss):
            raise ValueError("rapid_resource_loss values must be within [0, 1]")
        if any(
            right < left
            for left, right in zip(
                self.rapid_resource_loss,
                self.rapid_resource_loss[1:],
            )
        ):
            raise ValueError("rapid_resource_loss must be nondecreasing with damage state")
        if self.primary_strategy is not None and self.primary_strategy not in self.strategies:
            raise ValueError("primary_strategy must be included in strategies")
        return self


class DatasetBackedRequest(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def bind_proven_artifact_units(cls, value):
        from .validation_rules import restore_proven_units
        return restore_proven_units(value)

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    model_profile: ModelProfile = OFFICIAL_MODEL_PROFILE
    dataset_source: DatasetSource | None = None
    dataset_artifacts: DatasetArtifacts | None = None
    treatment_horizon_hours: int = Field(default=72, ge=1, le=720)

    @model_validator(mode="after")
    def validate_dataset_reference(self) -> "DatasetBackedRequest":
        ensure_official_metric_inputs(self)
        if (self.dataset_source is None) == (self.dataset_artifacts is None):
            raise ValueError("Exactly one of dataset_source or dataset_artifacts must be provided")
        return self


class CommonAssessmentRequest(DatasetBackedRequest):
    assessment_mode: AssessmentMode
    mcs: int = Field(default=1000, ge=1, le=100000)
    seed: int | None = 0
