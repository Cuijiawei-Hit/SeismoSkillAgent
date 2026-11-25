from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from engineering_skills.core.exceptions import DatasetValidationError
from engineering_skills.core.models import SkillWarning, WarningSeverity

from .data import HealthcareDataset
from .schemas import DatasetProfile, DatasetSource, EngineeringParameterSource
from .units import EDP_NAMES, normalize_edp_inputs


SCENARIO_PATTERN = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*g\s*$", re.IGNORECASE)
HOSPITAL_ID_PATTERN = re.compile(r"\bH\s*(\d+)\b", re.IGNORECASE)


def _resolve_path(path: Path) -> Path:
    path = Path(path).expanduser()
    return path.resolve() if path.is_absolute() else (Path.cwd() / path).resolve()


def _model_dir(path: Path) -> tuple[Path, Path]:
    path = _resolve_path(path)
    if path.name == "模型文件":
        return path.parent, path
    if (path / "模型文件").exists():
        return path, path / "模型文件"
    raise DatasetValidationError(f"Cannot find 模型文件 under {path}")


def detect_profile(model_dir: Path) -> DatasetProfile:
    if (model_dir / "0 地震动水准.xlsx").exists() and (model_dir / "3 其他.xlsx").exists():
        return DatasetProfile.MODULAR_V2
    if (model_dir / "1 医疗系统基础信息.xlsx").exists():
        return DatasetProfile.LEGACY_V1
    raise DatasetValidationError(f"Cannot detect healthcare dataset profile in {model_dir}")


def _hospital_id(value: Any, fallback: int | None = None) -> str:
    text = "" if value is None else str(value).strip()
    match = HOSPITAL_ID_PATTERN.search(text)
    if match:
        return f"H{int(match.group(1))}"
    if fallback is not None:
        return f"H{fallback + 1}"
    return text


def _numeric(value: Any) -> float | None:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return None
    if isinstance(value, (int, float, np.number)):
        return float(value)
    text = str(value).strip()
    if not text or text == "-":
        return None
    match = re.search(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", text)
    return float(match.group(0)) if match else None


def _parse_fragility(frame: pd.DataFrame) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for row in frame.iloc[2:, :].itertuples(index=False, name=None):
        values = list(row)
        offset = 1 if len(values) > 2 and _numeric(values[0]) is not None else 0
        if len(values) < offset + 9:
            continue
        component = values[offset]
        demand_type = values[offset + 1]
        if component is None or demand_type not in {"PFA", "PFV", "PFD", "IDR"}:
            continue
        medians = [_numeric(value) for value in values[offset + 3 : offset + 6]]
        betas = [_numeric(value) for value in values[offset + 6 : offset + 9]]
        pairs = [
            {"median": median, "beta": beta}
            for median, beta in zip(medians, betas)
            if median is not None and beta is not None and median > 0 and beta > 0
        ]
        records.append(
            {
                "component": str(component),
                "demand_type": str(demand_type),
                "group": "" if values[offset + 2] is None else str(values[offset + 2]),
                "states": pairs,
            }
        )
    return records


def _normalize_dataset_edp(dataset: HealthcareDataset, frame: pd.DataFrame, source: DatasetSource) -> None:
    """Normalize one raw workbook boundary and retain every original label."""
    block_count = max(0, (frame.shape[1] - 2) // 4)
    headers = {
        name: [str(frame.iloc[1, 2 + block * 4 + index]) for block in range(block_count)]
        for index, name in enumerate(EDP_NAMES)
    }
    dataset.edp, contract = normalize_edp_inputs(
        dataset.edp, source.edp_input_units, basis=source.edp_unit_basis, raw_headers=headers,
    )
    dataset.parameter_provenance = {**dataset.parameter_provenance, "unit_contract": contract}
    if source.edp_input_units is None:
        dataset.warnings.append(SkillWarning(
            code="edp_legacy_unit_convention", severity=WarningSeverity.INFO,
            message="EDP未显式声明源单位；按旧工程程序的g、m/s、m、ratio数值约定读取，兼容假设已记录。",
            details={"standard_id": contract["standard_id"], "basis": contract["basis"]},
        ))
    elif contract["header_conflicts"]:
        dataset.warnings.append(SkillWarning(
            code="edp_header_unit_override", severity=WarningSeverity.INFO,
            message="EDP按请求显式声明的数值单位规范化；旧表标签差异及采用依据已保留在unit_contract。",
            details={"standard_id": contract["standard_id"], "basis": contract["basis"],
                     "header_conflicts": contract["header_conflicts"]},
        ))


def _scenario_id(value: Any) -> str | None:
    if value is None:
        return None
    match = SCENARIO_PATTERN.match(str(value))
    return f"{float(match.group(1)):g}g" if match else None


def _scenario_pga(scenario: str) -> float | None:
    match = SCENARIO_PATTERN.match(scenario)
    return float(match.group(1)) if match else None


def _align_rows(frame: pd.DataFrame, hospital_ids: list[str], label: str) -> pd.DataFrame:
    row_by_id: dict[str, int] = {}
    for index, value in enumerate(frame.iloc[:, 0].tolist()):
        identifier = _hospital_id(value)
        if identifier in hospital_ids:
            row_by_id[identifier] = index
    missing = [identifier for identifier in hospital_ids if identifier not in row_by_id]
    if missing:
        raise DatasetValidationError(f"{label} missing hospital IDs: {missing}")
    return frame.iloc[[row_by_id[identifier] for identifier in hospital_ids], :].reset_index(drop=True)


def _department_distribution(frame: pd.DataFrame, hospital_ids: list[str]) -> np.ndarray:
    index_by_id = {identifier: index for index, identifier in enumerate(hospital_ids)}
    rows: list[list[float]] = []
    for row in frame.itertuples(index=False, name=None):
        identifier = _hospital_id(row[0])
        if identifier not in index_by_id:
            continue
        rows.append(
            [
                index_by_id[identifier],
                float(row[2]),
                float(row[3]),
                float(row[4]),
                float(row[5]),
                float(row[6]),
            ]
        )
    return np.asarray(rows, dtype=float)


def _load_mapping(source: DatasetSource) -> tuple[dict[str, int] | None, list[SkillWarning]]:
    if source.hospital_mapping_path is None:
        return None, []
    path = _resolve_path(source.hospital_mapping_path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    verified = bool(raw.get("verified", False))
    if not verified and not source.allow_unverified_mapping:
        raise DatasetValidationError(
            "Parameter-row binding is marked unverified; set allow_unverified_mapping=true to use it explicitly"
        )
    mapping = {str(key): int(value) for key, value in raw.get("hospital_rows", {}).items()}
    warnings = []
    if not verified:
        warnings.append(
            SkillWarning(
                code="unverified_parameter_binding",
                severity=WarningSeverity.HIGH,
                message="通用工程参数按未经核验的行位置绑定，结果不得作为正式工程结论。",
                details={"mapping_file": str(path), "description": raw.get("description", "")},
            )
        )
    return mapping, warnings


def _select_external_rows(
    names: list[str],
    values: np.ndarray,
    hospital_ids: list[str],
    hospital_names: list[str],
    mapping: dict[str, int] | None,
    label: str,
) -> tuple[np.ndarray, list[str]]:
    normalized = {str(name).strip(): index for index, name in enumerate(names)}
    indices: list[int] = []
    for identifier, display_name in zip(hospital_ids, hospital_names):
        if mapping is not None and identifier in mapping:
            indices.append(mapping[identifier])
        elif identifier in normalized:
            indices.append(normalized[identifier])
        elif display_name in normalized:
            indices.append(normalized[display_name])
        else:
            raise DatasetValidationError(
                f"{label} cannot map hospital {identifier} ({display_name}); provide an explicit mapping"
            )
    if any(index < 0 or index >= len(names) for index in indices):
        raise DatasetValidationError(f"{label} mapping row is outside the available range")
    return values[np.asarray(indices, dtype=int), :], [str(names[index]).strip() for index in indices]


def _select_parameter_profiles(
    frame: pd.DataFrame,
    hospital_ids: list[str],
    bindings: dict[str, str],
    label: str,
) -> tuple[pd.DataFrame, list[str]]:
    normalized_bindings = {
        _hospital_id(hospital_id): _hospital_id(profile_id)
        for hospital_id, profile_id in bindings.items()
    }
    unknown_hospitals = sorted(set(normalized_bindings) - set(hospital_ids))
    if unknown_hospitals:
        raise DatasetValidationError(f"{label} bindings contain unknown hospital IDs: {unknown_hospitals}")
    profile_ids = [normalized_bindings.get(identifier, identifier) for identifier in hospital_ids]
    row_by_profile: dict[str, int] = {}
    for index, value in enumerate(frame.iloc[:, 0].tolist()):
        profile_id = _hospital_id(value)
        if profile_id in row_by_profile:
            raise DatasetValidationError(f"{label} contains duplicate parameter profile {profile_id}")
        row_by_profile[profile_id] = index
    missing = [profile_id for profile_id in profile_ids if profile_id not in row_by_profile]
    if missing:
        raise DatasetValidationError(f"{label} missing parameter profiles: {missing}")
    selected = frame.iloc[[row_by_profile[profile_id] for profile_id in profile_ids], :].reset_index(drop=True)
    return selected, profile_ids


def _load_engineering_parameters(
    parameter_source: EngineeringParameterSource,
    hospital_ids: list[str],
    scenario_ids: list[str],
) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray], list[str], dict[str, Any], list[str]]:
    repair_path = _resolve_path(parameter_source.repair_time_path)
    infrastructure_path = _resolve_path(parameter_source.infrastructure_availability_path)
    repair = pd.read_excel(repair_path, sheet_name="医院修复时间").dropna(how="all")
    repair, profile_ids = _select_parameter_profiles(
        repair,
        hospital_ids,
        parameter_source.profile_bindings,
        "repair time parameter library",
    )
    if repair.shape[1] < 6:
        raise DatasetValidationError("Generic repair-time table must contain five damage-state columns")
    repair_median = repair.iloc[:, 1:6].to_numpy(dtype=float)
    repair_std = np.zeros_like(repair_median)

    infrastructure = pd.read_excel(
        infrastructure_path,
        sheet_name="区域基础设施可用性",
    ).dropna(how="all")
    infrastructure, infrastructure_profiles = _select_parameter_profiles(
        infrastructure,
        hospital_ids,
        parameter_source.profile_bindings,
        "infrastructure parameter library",
    )
    if infrastructure_profiles != profile_ids:
        raise DatasetValidationError("Repair-time and infrastructure parameter profiles are inconsistent")
    availability_values = infrastructure.iloc[:, 1:].to_numpy(dtype=float)
    if availability_values.shape[1] == 1:
        infrastructure_scenario_binding = "single_generic_column_broadcast_to_all_scenarios"
        availability_values = np.repeat(availability_values, len(scenario_ids), axis=1)
    elif availability_values.shape[1] < len(scenario_ids):
        raise DatasetValidationError(
            "Infrastructure parameter table must contain one reusable column or one column per scenario"
        )
    else:
        infrastructure_scenario_binding = "scenario_columns_in_dataset_order"
    availability = {
        scenario: np.clip(availability_values[:, index], 0.0, 1.0)
        for index, scenario in enumerate(scenario_ids)
    }
    binding_method = "explicit_profile_binding" if parameter_source.profile_bindings else "hospital_id"
    provenance = {
        "kind": "generic_engineering_parameter_library",
        "binding_method": binding_method,
        "bindings": [
            {"hospital_id": hospital_id, "parameter_profile_id": profile_id}
            for hospital_id, profile_id in zip(hospital_ids, profile_ids)
        ],
        "repair_time_file": str(repair_path),
        "infrastructure_availability_file": str(infrastructure_path),
        "infrastructure_scenario_binding": infrastructure_scenario_binding,
    }
    return (
        repair_median,
        repair_std,
        availability,
        profile_ids,
        provenance,
        [str(repair_path), str(infrastructure_path)],
    )


def _load_legacy(data_dir: Path, model_dir: Path, source: DatasetSource) -> HealthcareDataset:
    base_file = model_dir / "1 医疗系统基础信息.xlsx"
    repair_file = model_dir / "2 震后医院修复时间.xlsx"
    infra_file = model_dir / "3 其他输入数据.xlsx"
    fragility_file = data_dir.parent / "code" / "构件易损性参数.xlsx"
    if not fragility_file.exists():
        fragility_file = model_dir.parent.parent / "code" / "构件易损性参数.xlsx"

    hospital_info = pd.read_excel(base_file, sheet_name="区域医疗医院基本信息").dropna(how="all")
    hospital_ids = [_hospital_id(value, i) for i, value in enumerate(hospital_info.iloc[:, 0])]
    hospital_names = [str(value) for value in hospital_info.iloc[:, 0]]
    hospital_coordinates = hospital_info.iloc[:, 2:4].to_numpy(dtype=float)
    floor_counts = hospital_info.iloc[:, 4].to_numpy(dtype=int)
    departments = _align_rows(
        pd.read_excel(base_file, sheet_name="区域医疗医疗科室数量").dropna(how="all"),
        hospital_ids,
        "department counts",
    )
    staff = _align_rows(
        pd.read_excel(base_file, sheet_name="区域医疗医务人员数量").dropna(how="all"),
        hospital_ids,
        "staff counts",
    )
    distribution = pd.read_excel(base_file, sheet_name="区域医疗医院科室分布").dropna(how="all")
    population_frame = pd.read_excel(base_file, sheet_name="人口数据").dropna(how="all")
    node_population = population_frame.iloc[:, 3].to_numpy(dtype=float)
    node_coordinates = population_frame.iloc[:, 1:3].to_numpy(dtype=float)

    travel_raw = pd.read_excel(base_file, sheet_name="区域医院通行距离（时间）").dropna(how="all")
    expected_rows = len(node_population) * len(hospital_ids)
    if len(travel_raw) != expected_rows:
        raise DatasetValidationError(f"Legacy travel rows must equal node_count * hospital_count ({expected_rows})")
    travel = travel_raw.iloc[:, 2].to_numpy(dtype=float).reshape(len(node_population), len(hospital_ids))

    edp_frame = pd.read_excel(base_file, sheet_name="区域医疗医院楼层工程需求参数", header=None)
    edp_values = edp_frame.iloc[2:, 2:].to_numpy(dtype=float)
    if edp_values.shape[0] != int(np.sum(floor_counts)) or edp_values.shape[1] % 4 != 0:
        raise DatasetValidationError("Legacy EDP dimensions do not match hospital floor counts")
    edp_samples = np.stack([edp_values[:, offset : offset + 4] for offset in range(0, edp_values.shape[1], 4)])
    scenario = "legacy_ensemble"
    if source.engineering_parameter_source is not None:
        (
            repair_median,
            repair_std,
            infrastructure,
            parameter_profile_ids,
            parameter_provenance,
            parameter_source_files,
        ) = _load_engineering_parameters(
            source.engineering_parameter_source,
            hospital_ids,
            [scenario],
        )
        infra = infrastructure[scenario]
    else:
        infra_frame = pd.read_excel(infra_file, sheet_name="区域基础设施可用性").dropna(how="all")
        infra_frame = _align_rows(infra_frame, hospital_ids, "infrastructure availability")
        infra = np.clip(infra_frame.iloc[:, 1].to_numpy(dtype=float), 0.0, 1.0)
        repair = pd.read_excel(repair_file, sheet_name="医院修复时间").dropna(how="all")
        repair = _align_rows(repair, hospital_ids, "repair time")
        repair_median = repair.iloc[:, 1:6].to_numpy(dtype=float)
        repair_std = np.zeros_like(repair_median)
        parameter_profile_ids = list(hospital_ids)
        parameter_provenance = {
            "kind": "generic_engineering_parameter_library",
            "binding_method": "hospital_id",
            "bindings": [
                {"hospital_id": identifier, "parameter_profile_id": identifier}
                for identifier in hospital_ids
            ],
            "repair_time_file": str(repair_file.resolve()),
            "infrastructure_availability_file": str(infra_file.resolve()),
        }
        parameter_source_files = [str(repair_file.resolve()), str(infra_file.resolve())]

    fragility = _parse_fragility(pd.read_excel(fragility_file, sheet_name="Sheet4", header=None))
    warnings = [
        SkillWarning(
            code="legacy_missing_emergency_demand",
            severity=WarningSeverity.INFO,
            message="旧模板不包含伤员需求和生存曲线，应急救治 Skill 将返回零需求。",
        )
    ]
    source_files = [str(base_file.resolve()), str(fragility_file.resolve()), *parameter_source_files]
    dataset = HealthcareDataset(
        profile=DatasetProfile.LEGACY_V1.value,
        source_dir=data_dir,
        scenario_ids=[scenario],
        scenario_pga_g=[None],
        event_pga_g=[],
        hospital_ids=hospital_ids,
        hospital_names=hospital_names,
        hospital_coordinates=hospital_coordinates,
        parameter_profile_ids=parameter_profile_ids,
        parameter_provenance=parameter_provenance,
        floor_counts=floor_counts,
        department_counts=departments.iloc[:, 1:5].to_numpy(dtype=float),
        department_distribution=_department_distribution(distribution, hospital_ids),
        staff_counts=staff.iloc[:, 1:5].to_numpy(dtype=float),
        node_population=node_population,
        node_coordinates=node_coordinates,
        travel_time={scenario: travel},
        edp={scenario: edp_samples},
        scenario_edp_source={scenario: "predictive_simulation_ensemble"},
        infrastructure_availability={scenario: infra},
        repair_time_median=repair_median,
        repair_time_std=repair_std,
        staff_loss={scenario: np.zeros((len(hospital_ids), 4))},
        casualty_day={scenario: np.zeros((len(node_population), 3, 2))},
        casualty_night={scenario: np.zeros((len(node_population), 3, 2))},
        survival_probability=np.ones((3, 72)),
        fragility_records=fragility,
        warnings=warnings,
        source_files=source_files,
    )
    _normalize_dataset_edp(dataset, edp_frame, source)
    dataset.validate()
    return dataset


def _parse_modular_scenarios(other_file: Path) -> list[str]:
    frame = pd.read_excel(other_file, sheet_name="区域医疗医院楼层工程需求参数", header=None)
    scenarios = [_scenario_id(value) for value in frame.iloc[0, 2:].tolist()]
    scenarios = [value for value in scenarios if value is not None]
    if not scenarios:
        raise DatasetValidationError("No scenario labels found in modular EDP sheet")
    return scenarios


def _parse_casualties(other_file: Path, sheet: str, scenario_ids: list[str], num_nodes: int) -> dict[str, np.ndarray]:
    frame = pd.read_excel(other_file, sheet_name=sheet, header=None)
    values = frame.iloc[3:, :].dropna(how="all")
    if len(values) != num_nodes:
        raise DatasetValidationError(f"{sheet} row count does not match population nodes")
    output: dict[str, np.ndarray] = {}
    for scenario_idx, scenario in enumerate(scenario_ids):
        start = 3 + scenario_idx * 6
        block = values.iloc[:, start : start + 6].to_numpy(dtype=float).reshape(num_nodes, 3, 2)
        output[scenario] = np.nan_to_num(block, nan=0.0)
    return output


def _load_modular(data_dir: Path, model_dir: Path, source: DatasetSource) -> HealthcareDataset:
    pga_file = model_dir / "0 地震动水准.xlsx"
    base_file = model_dir / "1 医院基本信息.xlsx"
    repair_file = model_dir / "2 震后建筑修复时间.xlsx"
    other_file = model_dir / "3 其他.xlsx"
    if source.engineering_parameter_source is None:
        mapping, mapping_warnings = _load_mapping(source)
    else:
        mapping, mapping_warnings = None, []

    hospital_info = pd.read_excel(base_file, sheet_name="区域医疗医院基本信息").dropna(how="all")
    hospital_ids = [_hospital_id(value, i) for i, value in enumerate(hospital_info.iloc[:, 0])]
    hospital_names = [str(value) for value in hospital_info.iloc[:, 0]]
    hospital_coordinates = hospital_info.iloc[:, 2:4].to_numpy(dtype=float)
    floor_counts = hospital_info.iloc[:, 4].to_numpy(dtype=int)
    departments = _align_rows(
        pd.read_excel(base_file, sheet_name="区域医疗医疗科室数量").dropna(how="all"),
        hospital_ids,
        "department counts",
    )
    staff = _align_rows(
        pd.read_excel(base_file, sheet_name="区域医疗医务人员数量").dropna(how="all"),
        hospital_ids,
        "staff counts",
    )
    distribution = pd.read_excel(base_file, sheet_name="区域医疗医院科室分布").dropna(how="all")

    scenario_ids = _parse_modular_scenarios(other_file)
    scenario_pga = [_scenario_pga(value) for value in scenario_ids]
    event_values = pd.read_excel(pga_file).to_numpy(dtype=float).reshape(-1)
    event_pga = [float(value) for value in event_values if np.isfinite(value)]
    warnings = list(mapping_warnings)
    if event_pga and not any(np.isclose(event_pga[0], value) for value in scenario_pga if value is not None):
        warnings.append(
            SkillWarning(
                code="event_pga_not_in_prediction_scenarios",
                severity=WarningSeverity.WARNING,
                message="0 地震动水准.xlsx 中的实测PGA不属于0.1g至0.4g预测情景，作为快速评估事件元数据保留。",
                details={"event_pga_g": event_pga, "predictive_scenarios": scenario_ids},
            )
        )

    population_frame = pd.read_excel(other_file, sheet_name="人口数据").dropna(how="all")
    node_population = population_frame.iloc[:, 3].to_numpy(dtype=float)
    node_coordinates = population_frame.iloc[:, 1:3].to_numpy(dtype=float)
    travel_frame = pd.read_excel(other_file, sheet_name="区域医院通行距离", header=None).iloc[2:, :]
    expected_rows = len(node_population) * len(hospital_ids)
    if len(travel_frame) != expected_rows:
        raise DatasetValidationError(f"Modular travel rows must equal node_count * hospital_count ({expected_rows})")
    travel_time = {
        scenario: travel_frame.iloc[:, 2 + index].to_numpy(dtype=float).reshape(
            len(node_population), len(hospital_ids)
        )
        for index, scenario in enumerate(scenario_ids)
    }

    edp_frame = pd.read_excel(other_file, sheet_name="区域医疗医院楼层工程需求参数", header=None)
    edp_values = edp_frame.iloc[2:, :]
    if len(edp_values) != int(np.sum(floor_counts)):
        raise DatasetValidationError("Modular EDP rows do not match hospital floor counts")
    edp: dict[str, np.ndarray] = {}
    for index, scenario in enumerate(scenario_ids):
        block = edp_values.iloc[:, 2 + index * 4 : 6 + index * 4].to_numpy(dtype=float)
        edp[scenario] = block[np.newaxis, :, :]

    if source.engineering_parameter_source is not None:
        (
            repair_median,
            repair_std,
            infrastructure,
            parameter_profile_ids,
            parameter_provenance,
            parameter_source_files,
        ) = _load_engineering_parameters(
            source.engineering_parameter_source,
            hospital_ids,
            scenario_ids,
        )
    else:
        repair_raw = pd.read_excel(repair_file, header=None).iloc[2:, :].dropna(how="all")
        repair_names = repair_raw.iloc[:, 0].astype(str).tolist()
        repair_values = repair_raw.iloc[:, 1:11].to_numpy(dtype=float)
        repair_selected, parameter_profile_ids = _select_external_rows(
            repair_names, repair_values, hospital_ids, hospital_names, mapping, "repair time"
        )
        repair_median = repair_selected[:, 0:10:2]
        repair_std = repair_selected[:, 1:10:2]

        infra_raw = pd.read_excel(
            other_file,
            sheet_name="区域基础设施可用性",
            header=None,
        ).iloc[2:, :].dropna(how="all")
        infra_names = infra_raw.iloc[:, 0].astype(str).tolist()
        infra_values = infra_raw.iloc[:, 1 : 1 + len(scenario_ids)].to_numpy(dtype=float)
        infra_selected, infrastructure_profiles = _select_external_rows(
            infra_names, infra_values, hospital_ids, hospital_names, mapping, "infrastructure availability"
        )
        if infrastructure_profiles != parameter_profile_ids:
            raise DatasetValidationError("Repair-time and infrastructure parameter-row bindings are inconsistent")
        infrastructure = {
            scenario: np.clip(infra_selected[:, index], 0.0, 1.0)
            for index, scenario in enumerate(scenario_ids)
        }
        parameter_provenance = {
            "kind": "embedded_engineering_parameter_rows",
            "binding_method": "explicit_row_binding" if mapping is not None else "hospital_id_or_name",
            "bindings": [
                {"hospital_id": hospital_id, "parameter_profile_id": profile_id}
                for hospital_id, profile_id in zip(hospital_ids, parameter_profile_ids)
            ],
            "repair_time_file": str(repair_file.resolve()),
            "infrastructure_availability_file": str(other_file.resolve()),
        }
        parameter_source_files = [str(repair_file.resolve())]

    staff_loss_frame = pd.read_excel(other_file, sheet_name="区域医疗医务人员伤亡率", header=2).dropna(how="all")
    if len(staff_loss_frame) < len(hospital_ids):
        raise DatasetValidationError("Staff loss table has fewer rows than hospitals")
    staff_loss_values = staff_loss_frame.iloc[: len(hospital_ids), 1:].to_numpy(dtype=float)
    staff_loss = {
        scenario: np.nan_to_num(staff_loss_values[:, index * 4 : index * 4 + 4], nan=0.0)
        for index, scenario in enumerate(scenario_ids)
    }

    casualty_day = _parse_casualties(other_file, "地震伤员数量-白天", scenario_ids, len(node_population))
    casualty_night = _parse_casualties(other_file, "地震伤员数量-夜晚", scenario_ids, len(node_population))
    survival_frame = pd.read_excel(other_file, sheet_name="伤员生存概率", header=None)
    survival = survival_frame.iloc[1:4, 2:74].to_numpy(dtype=float)
    if np.nanmax(survival) > 1.0:
        survival = survival / 100.0
    survival = np.clip(np.nan_to_num(survival, nan=0.0), 0.0, 1.0)
    fragility = _parse_fragility(pd.read_excel(other_file, sheet_name="构件易损性参数4", header=None))

    source_files = [str(path.resolve()) for path in [pga_file, base_file, other_file]] + parameter_source_files
    if source.engineering_parameter_source is None and source.hospital_mapping_path is not None:
        source_files.append(str(_resolve_path(source.hospital_mapping_path)))
    dataset = HealthcareDataset(
        profile=DatasetProfile.MODULAR_V2.value,
        source_dir=data_dir,
        scenario_ids=scenario_ids,
        scenario_pga_g=scenario_pga,
        event_pga_g=event_pga,
        hospital_ids=hospital_ids,
        hospital_names=hospital_names,
        hospital_coordinates=hospital_coordinates,
        parameter_profile_ids=parameter_profile_ids,
        parameter_provenance=parameter_provenance,
        floor_counts=floor_counts,
        department_counts=departments.iloc[:, 1:5].to_numpy(dtype=float),
        department_distribution=_department_distribution(distribution, hospital_ids),
        staff_counts=staff.iloc[:, 1:5].to_numpy(dtype=float),
        node_population=node_population,
        node_coordinates=node_coordinates,
        travel_time=travel_time,
        edp=edp,
        scenario_edp_source={scenario: "predictive_scenario_edp" for scenario in scenario_ids},
        infrastructure_availability=infrastructure,
        repair_time_median=repair_median,
        repair_time_std=repair_std,
        staff_loss=staff_loss,
        casualty_day=casualty_day,
        casualty_night=casualty_night,
        survival_probability=survival,
        fragility_records=fragility,
        warnings=warnings,
        source_files=source_files,
    )
    _normalize_dataset_edp(dataset, edp_frame, source)
    dataset.validate()
    return dataset


def load_healthcare_dataset(source: DatasetSource | dict[str, Any]) -> HealthcareDataset:
    source = source if isinstance(source, DatasetSource) else DatasetSource.model_validate(source)
    if source.profile == DatasetProfile.CANONICAL:
        from engineering_skills.core.artifacts import artifact_ref
        from .schemas import DatasetArtifacts
        directory = _resolve_path(source.path)
        if not all((directory/name).is_file() for name in ['canonical_dataset.json','canonical_dataset.npz']):
            raise DatasetValidationError('Canonical source requires canonical_dataset.json and canonical_dataset.npz')
        artifacts = DatasetArtifacts(
            metadata=artifact_ref(directory/'canonical_dataset.json','application/json','Explicit canonical metadata'),
            arrays=artifact_ref(directory/'canonical_dataset.npz','application/x-npz','Explicit canonical arrays'))
        dataset = HealthcareDataset.load(artifacts)
        dataset.source_files = [str(artifacts.metadata.path),str(artifacts.arrays.path)]
        return dataset
    data_dir, model_dir = _model_dir(source.path)
    profile = detect_profile(model_dir) if source.profile == DatasetProfile.AUTO else source.profile
    if profile == DatasetProfile.LEGACY_V1:
        return _load_legacy(data_dir, model_dir, source)
    if profile == DatasetProfile.MODULAR_V2:
        return _load_modular(data_dir, model_dir, source)
    raise DatasetValidationError(f"Unsupported healthcare dataset profile: {profile}")
