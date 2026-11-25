from __future__ import annotations

from pathlib import Path
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator
from engineering_skills.core.models import AssessmentMode, ArtifactRef


class PowerDatasetSource(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: Path
    format: Literal['power_city_v1', 'rescity_city_v1'] = 'power_city_v1'
    fragility_path: Path | None = None
    criteria_path: Path | None = None

    @model_validator(mode='after')
    def bind_parameter_sources(self):
        workspace = Path(__file__).resolve().parents[4]
        self.path = self.path.expanduser().resolve()
        self.fragility_path = (self.fragility_path or workspace/'data/parameters/电力系统组件地震易损性数据.xlsx').resolve()
        self.criteria_path = (self.criteria_path or workspace/'data/parameters/韧性指标目标值及韧性等级划分.xlsx').resolve()
        return self


class PowerScenarioParameters(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    assessment_mode: Literal[AssessmentMode.PREDICTIVE] = AssessmentMode.PREDICTIVE
    model_profile: Literal['power_dc_v1'] = 'power_dc_v1'
    pga_g: float = Field(default=0.4, ge=0, le=10)
    node_pga_g: list[float] | None = None
    power_damage_mode: Literal['most_likely', 'sampled'] = 'most_likely'
    seed: StrictInt = Field(default=0, ge=0, le=2**64-1)


class PowerRecoveryParameters(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    team_count: StrictInt = Field(default=1, ge=1, le=50)
    daily_work_hours: float = Field(default=24, ge=1, le=24)
    team_efficiency: float = Field(default=1, ge=0.1, le=10)
    repair_objective: Literal['function_loss_area', 'target_time'] = 'function_loss_area'
    target_function: float = Field(default=0.9, ge=0.01, le=1)
    ga_population: StrictInt = Field(default=16, ge=4, le=64)
    ga_generations: StrictInt = Field(default=20, ge=1, le=100)
    repair_constraints: dict[str, dict[str, Any]] = Field(default_factory=dict)


class PowerAnalysisContext(PowerScenarioParameters, PowerRecoveryParameters):
    dataset_source: PowerDatasetSource
    output_language: Literal['zh-CN', 'en-US'] = 'zh-CN'
    report_title: str = '奥克兰电力系统抗震韧性评估报告'
    presentation_instructions: str | None = None
    knowledge_evidence: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    decision_objective: str | None = None


class StageParameters(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    assessment_mode: Literal[AssessmentMode.PREDICTIVE] = AssessmentMode.PREDICTIVE
    model_profile: Literal['power_dc_v1'] = 'power_dc_v1'
    seed: StrictInt = Field(default=0, ge=0, le=2**64-1)


class InputRequest(StageParameters):
    dataset_source: PowerDatasetSource


class DamageRequest(PowerScenarioParameters):
    dataset_artifact: ArtifactRef


class FunctionRequest(StageParameters):
    dataset_artifact: ArtifactRef
    damage_artifact: ArtifactRef


class RecoveryRequest(StageParameters, PowerRecoveryParameters):
    dataset_artifact: ArtifactRef
    damage_artifact: ArtifactRef
    function_artifact: ArtifactRef


class BasicRecoveryRequest(FunctionRequest):
    function_artifact: ArtifactRef


class ResilienceRequest(StageParameters):
    function_artifact: ArtifactRef
    recovery_artifact: ArtifactRef
    basic_recovery_artifact: ArtifactRef


class ImpactRequest(StageParameters):
    dataset_artifact: ArtifactRef
    function_artifact: ArtifactRef
    recovery_artifact: ArtifactRef | None = None


class ReportRequest(StageParameters):
    dataset_artifact: ArtifactRef
    damage_artifact: ArtifactRef
    function_artifact: ArtifactRef
    recovery_artifact: ArtifactRef
    basic_recovery_artifact: ArtifactRef
    resilience_artifact: ArtifactRef
    impact_artifact: ArtifactRef
    output_language: Literal['zh-CN', 'en-US'] = 'zh-CN'
    report_title: str = '奥克兰电力系统抗震韧性评估报告'
    presentation_instructions: str | None = None
    knowledge_evidence: list[dict[str, Any]] = Field(default_factory=list)


class PowerStageOutput(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    summary: dict[str, Any]
    metric_standard: dict[str, Any]
    dataset_artifact: ArtifactRef | None = None
    damage_artifact: ArtifactRef | None = None
    function_artifact: ArtifactRef | None = None
    recovery_artifact: ArtifactRef | None = None
    basic_recovery_artifact: ArtifactRef | None = None
    resilience_artifact: ArtifactRef | None = None
    impact_artifact: ArtifactRef | None = None
    report_artifact: ArtifactRef | None = None
    inventory: dict[str, Any] | None = None
    damage: dict[str, Any] | None = None
    function: dict[str, Any] | None = None
    recovery: dict[str, Any] | None = None
    basic_recovery: dict[str, Any] | None = None
    resilience: dict[str, Any] | None = None
    impact: dict[str, Any] | None = None
