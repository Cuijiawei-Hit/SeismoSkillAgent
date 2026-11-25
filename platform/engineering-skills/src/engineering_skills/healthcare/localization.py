from __future__ import annotations

import re
from typing import Any, Iterable

from engineering_skills.core.models import SkillWarning


_ENGLISH_WARNING_MESSAGES = {
    "edp_legacy_unit_convention": "No explicit source-unit declaration was supplied for EDPs. The legacy engineering convention g, m/s, m and ratio is applied and retained as a compatibility assumption.",
    "edp_header_unit_override": "EDPs are normalized using the explicitly declared numerical units. Differences from legacy workbook labels and the adoption basis are retained in unit_contract.",
    "minor_casualties_outside_emergency_scope": "Minor-casualty data are retained for input conservation and provenance but excluded from emergency hospital dispatch, shared-resource scheduling, and casualty-coverage calculations.",
    "treatment_parameters_uncalibrated": "Treatment resource requirements, occupancy times, and survival curves are not locally validated. Results are conditional model estimates, not observed survival rates.",
    "survival_curve_conservative_envelope": "The supplied survival curve increases during some waiting-time intervals. The explicit conservative-envelope policy removes these increases; supplied and processed curves are both retained. This is not clinical calibration.",
    "observed_event_reference_inputs": "Observed values override fields by hospital. Unobserved inputs come from the explicitly selected reference scenario and are not field observations.",
    "unverified_parameter_binding": (
        "Generic engineering parameters are bound by unverified row positions; "
        "the results must not be used as formal engineering conclusions."
    ),
    "legacy_missing_emergency_demand": (
        "The legacy template contains no casualty demand or survival curves; "
        "the emergency-treatment Skill will return zero demand."
    ),
    "event_pga_not_in_prediction_scenarios": (
        "The observed PGA in 0 Earthquake Intensity.xlsx is outside the 0.1g-0.4g "
        "prediction scenarios and is retained as rapid-assessment event metadata."
    ),
    "rapid_event_pga_missing": (
        "No independent event PGA was provided for rapid assessment; scenario EDP "
        "will be used for the rapid damage assessment."
    ),
    "component_fragility_not_used": (
        "Rapid mode uses the IDR damage rule only; component fragility probabilities "
        "are not included in the calculation."
    ),
    "nonmonotonic_system_fragility": (
        "System failure probability is nonmonotonic with PGA; review the scenario "
        "samples and fragility parameters."
    ),
    "hybrid_observed_edp_missing": (
        "No observed EDP was found in hybrid mode. Predicted EDP is used to fill the "
        "gap, with its source retained in the result."
    ),
    "casualty_demand_missing_or_zero": (
        "The input template contains no nonzero casualty demand; dispatch and treatment "
        "results are therefore zero."
    ),
    "dispatch_conservation_error": "Casualty dispatch does not satisfy demand conservation.",
    "population_outside_service_radius": (
        "Some population demand nodes cannot reach any hospital within the specified "
        "service radius."
    ),
    "emergency_function_not_evaluated": (
        "No casualty-dispatch artifact was provided; only recovery-period accessibility "
        "functionality was calculated."
    ),
    "legacy_ga_perfect_information": (
        "ga_legacy optimizes each random realization separately. It is retained for "
        "reproduction and theoretical comparison and is not a single implementable plan."
    ),
    "robust_ga_below_baseline": (
        "The robust GA objective is below the criticality-ranking baseline on the "
        "training samples."
    ),
    "optimizer_resilience_mismatch": (
        "The recovery optimizer objective is inconsistent with the independently "
        "quantified resilience result."
    ),
    "nonmonotonic_recovery_curve": "The recovery curve contains time steps with decreasing functionality.",
}

_ENGLISH_DAMAGE_LABELS = {
    "完好": "None",
    "轻微": "Slight",
    "中等": "Moderate",
    "严重": "Severe",
    "毁坏": "Complete",
}

_ENGLISH_HOSPITAL_NAMES = {
    "H1": "Eastern Hepatobiliary Surgery Hospital",
    "H2": "Kongjiang Hospital",
    "H3": "Shanghai Pulmonary Hospital",
    "H4": "Shidong Hospital",
    "H5": "Xinhua Hospital, Shanghai Jiao Tong University School of Medicine",
    "H6": "Changhai Hospital",
    "H7": "Yangpu District Central Hospital",
}

_ENGLISH_ASSUMPTIONS = {
    "三类伤情权重用于计算加权72小时潜在救治能力；该潜在能力不能当作三类伤情同时可实施的排程。": "Severity weights define a 72-hour treatment-potential proxy; the independent potentials are not a simultaneously feasible schedule across injury severities.",
    "constrained_v2不使用旧模型的轻伤能力除以20系数；资源参数仍需本地校准。": "constrained_v2 removes the legacy minor-injury capacity divisor of 20; resource assumptions still require local calibration.",
    "资源占用按时间步长向上取整，并检查窗口之后的占用尾段；可用资源在该期间保持不变。": "Resource occupancy is rounded up to time slots and checked beyond the initiation horizon; available resources remain constant throughout.",
    "先按可达性权重分派，再在医院内共享资源排程；未求解跨医院全局最优转运。": "Accessible gravity dispatch precedes shared-resource scheduling within hospitals; globally optimal inter-hospital transfers are not solved.",
    "生存修正人数是模型期望值；不等于实际获救人数。": "Survival-adjusted counts are model expectations, not observed rescued persons.",
    "风险指标为低分位样本的功能损失均值；成本仅指全部工程队保留至完工的费用，不含材料和医疗成本。": "Risk is the mean functionality loss in the lower resilience tail. Cost covers retained repair teams through completion, excluding materials and healthcare costs.",
    "P05-P95是样本分位区间；mean_resilience_ci95是Monte Carlo均值的近似95%区间，不是实地预测准确性保证。": "P05-P95 is a sample quantile interval. mean_resilience_ci95 is an approximate 95% Monte Carlo mean interval, not a guarantee of field predictive accuracy.",
    "执行DAG由Skill Registry依据声明依赖和类型化数据契约编译": (
        "The execution DAG is compiled by the Skill Registry from declared dependencies and typed data contracts."
    ),
    "LLM只提出目标能力和参数，不得改写已编译的数据绑定与执行顺序": (
        "The LLM proposes target capabilities and parameters only; it cannot rewrite compiled data bindings or execution order."
    ),
    "实测EDP优先，预测情景补全缺失量": (
        "Observed EDP takes precedence, and predictive scenarios fill missing values."
    ),
    "hospital_id/hospital_name表示城市医院实体，parameter_profile_id表示通用工程参数配置": (
        "hospital_id and hospital_name identify city hospital entities, while parameter_profile_id identifies the generic engineering-parameter profile."
    ),
    "仅计算数据集中严格匹配的地震情景，不对PGA或工程需求参数进行插值和外推": (
        "Only earthquake scenarios that strictly match the dataset are calculated; PGA and engineering demand parameters are not interpolated or extrapolated."
    ),
    "单列通用基础设施可用性参数应用于全部地震情景": (
        "The single generic infrastructure-availability column is applied to all earthquake scenarios."
    ),
    "多样本EDP采用相关对数正态模型扩样": (
        "Multiple-sample EDP is expanded using a correlated lognormal model."
    ),
    "该Skill分析给定情景与EDP，不执行区域PSHA或场地反应分析": (
        "This Skill analyzes the supplied scenarios and EDP; it does not perform regional PSHA or site-response analysis."
    ),
    "IDR以比值而非百分数参与阈值判定": (
        "IDR is evaluated as a ratio rather than a percentage in threshold checks."
    ),
    "三类伤情权重用于计算加权72小时救治能力": (
        "The three injury-severity weights are used to calculate weighted 72-hour treatment capacity."
    ),
    "可达性基于输入OD通行时间，不反演道路物理损伤": (
        "Accessibility is calculated from the input OD travel times and does not infer physical road damage."
    ),
    "韧性指数为评价时间窗内功能曲线面积除以时间窗长度": (
        "The resilience index is the area under the functionality curve divided by the assessment-window duration."
    ),
    "所有定量工程结果由上游已注册Engineering Skills计算并经Pydantic/Registry校验。": (
        "All quantitative engineering results are computed by registered upstream Engineering Skills and validated through Pydantic and the Skill Registry."
    ),
    "知识证据仅用于结果解释和决策支持，不参与数值计算。": (
        "Knowledge evidence supports result interpretation and decision support only; it does not participate in numerical computation."
    ),
    "稳健GA策略仅优化医院级进场次序，构件修复包工期与资源需现场数据后再优化。": (
        "The robust GA optimizes hospital-level mobilization order only; component work-package durations and resources require field data before further optimization."
    ),
    "报告中的定量结果仅来自上游Engineering Skills已经计算并校验的输出": (
        "All quantitative report results come only from validated upstream Engineering Skills outputs."
    ),
    "知识库证据仅用于形成工程建议、适用条件和解释，不参与数值计算": (
        "Knowledge-base evidence supports recommendations, applicability, and interpretation only; it does not participate in numerical computation."
    ),
}


def _first_count(message: str) -> str | None:
    match = re.search(r"\d+", message)
    return match.group(0) if match else None


def english_warning_message(code: str, message: str, details: dict[str, Any] | None = None) -> str:
    if code == "unsupported_fragility_components":
        count = _first_count(message)
        prefix = f"{count} components" if count else "Some components"
        return f"{prefix} lack valid fragility states; the detailed functionality model will apply the configured fallback."
    if code == "rapid_function_fallback_used":
        count = _first_count(message)
        prefix = f"{count} department evaluations" if count else "Some department evaluations"
        return f"{prefix} use rapid damage-state reduction because component probabilities are missing."
    return _ENGLISH_WARNING_MESSAGES.get(code, message)


def localize_warning_dicts(warnings: Iterable[dict[str, Any]], output_language: str) -> list[dict[str, Any]]:
    localized = [dict(warning) for warning in warnings]
    if output_language != "en-US":
        return localized
    for warning in localized:
        warning["message"] = english_warning_message(
            str(warning.get("code", "")),
            str(warning.get("message", "")),
            warning.get("details") if isinstance(warning.get("details"), dict) else {},
        )
    return localized


def localize_skill_warnings(warnings: Iterable[SkillWarning], output_language: str) -> list[SkillWarning]:
    warnings = list(warnings)
    if output_language != "en-US":
        return warnings
    return [
        warning.model_copy(
            update={
                "message": english_warning_message(
                    warning.code,
                    warning.message,
                    warning.details,
                )
            }
        )
        for warning in warnings
    ]


def localize_damage_label(label: str, output_language: str) -> str:
    if output_language != "en-US":
        return label
    return _ENGLISH_DAMAGE_LABELS.get(label, label)


def localize_hospital_name(hospital_id: str, name: str, output_language: str) -> str:
    if output_language != "en-US":
        return name
    return _ENGLISH_HOSPITAL_NAMES.get(hospital_id, name)


def english_assumption_message(message: str) -> str:
    if message in _ENGLISH_ASSUMPTIONS:
        return _ENGLISH_ASSUMPTIONS[message]
    dynamic_patterns = (
        (r"^应急救治启动窗口为震后\s*([0-9.]+)\s*小时；生存概率按救治启动时间计算。$", "The treatment-initiation window is {0} hours after the earthquake; survival probability is evaluated at care-start time."),
        (r"^([0-9.]+g)地震情景已存在于输入数据集中，且scenario_selection严格匹配该离散情景。$", "The {0} earthquake scenario exists in the input dataset, and scenario_selection strictly matches this discrete scenario."),
        (r"^应急救治时间窗为\s*([0-9.]+)\s*小时$", "The emergency-treatment horizon is {0} hours."),
        (r"^医院服务半径为\s*([0-9.]+)\s*分钟$", "The hospital service radius is {0} minutes."),
        (r"^服务半径为\s*([0-9.]+)\s*分钟$", "The service radius is {0} minutes."),
        (r"^工程队数量为\s*([0-9.]+)$", "The number of repair teams is {0}."),
        (r"^韧性积分控制期为\s*([0-9.]+)\s*天$", "The resilience integration horizon is {0} days."),
        (r"^稳健GA训练样本不超过\s*([0-9.]+)\s*个MCS实现$", "The robust GA training set contains at most {0} MCS realizations."),
        (r"^恢复阈值为\s*([0-9.]+)$", "The recovery threshold is {0}."),
    )
    for pattern, template in dynamic_patterns:
        match = re.match(pattern, message)
        if match:
            return template.format(*match.groups())
    return message


def localize_assumptions(assumptions: Iterable[str], output_language: str) -> list[str]:
    items = [str(item) for item in assumptions]
    if output_language != "en-US":
        return items
    return [english_assumption_message(item) for item in items]
