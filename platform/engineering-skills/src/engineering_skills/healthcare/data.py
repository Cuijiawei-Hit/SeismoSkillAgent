from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np

from engineering_skills.core.artifacts import artifact_ref, read_json, write_json, write_npz
from engineering_skills.core.exceptions import DatasetValidationError
from engineering_skills.core.models import ArtifactRef, SkillWarning

from .schemas import DatasetArtifacts, EarthquakeScenarioSelection
from .units import EDP_NAMES, EDP_UNITS, UNIT_STANDARD_ID, canonical_units, validate_canonical_units


@dataclass(slots=True)
class HealthcareDataset:
    profile: str
    source_dir: Path
    scenario_ids: list[str]
    scenario_pga_g: list[float | None]
    event_pga_g: list[float]
    hospital_ids: list[str]
    hospital_names: list[str]
    hospital_coordinates: np.ndarray
    parameter_profile_ids: list[str]
    parameter_provenance: dict[str, Any]
    floor_counts: np.ndarray
    department_counts: np.ndarray
    department_distribution: np.ndarray
    staff_counts: np.ndarray
    node_population: np.ndarray
    node_coordinates: np.ndarray
    travel_time: dict[str, np.ndarray]
    edp: dict[str, np.ndarray]
    scenario_edp_source: dict[str, str]
    infrastructure_availability: dict[str, np.ndarray]
    repair_time_median: np.ndarray
    repair_time_std: np.ndarray
    staff_loss: dict[str, np.ndarray]
    casualty_day: dict[str, np.ndarray]
    casualty_night: dict[str, np.ndarray]
    survival_probability: np.ndarray
    fragility_records: list[dict[str, Any]]
    warnings: list[SkillWarning] = field(default_factory=list)
    source_files: list[str] = field(default_factory=list)
    observations: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def num_hospitals(self) -> int:
        return len(self.hospital_ids)

    @property
    def num_nodes(self) -> int:
        return int(self.node_population.size)

    @property
    def total_floors(self) -> int:
        return int(np.sum(self.floor_counts))

    @property
    def pre_resources(self) -> np.ndarray:
        rad_rooms = self.department_counts[:, 0] + self.department_counts[:, 1]
        return np.column_stack(
            [self.staff_counts[:, :4], rad_rooms, self.department_counts[:, 2], self.department_counts[:, 3]]
        )

    def resolve_scenario_selection(
        self,
        selection: EarthquakeScenarioSelection | None,
        *,
        tolerance_g: float = 1e-6,
    ) -> list[str]:
        """Resolve a strict selector without interpolating or extrapolating inputs."""

        if selection is None:
            return list(self.scenario_ids)

        available_by_id = {
            scenario_id: pga
            for scenario_id, pga in zip(self.scenario_ids, self.scenario_pga_g)
        }
        selector_groups: list[set[str]] = []

        if selection.scenario_ids:
            unavailable_ids = [
                scenario_id
                for scenario_id in selection.scenario_ids
                if scenario_id not in available_by_id
            ]
            if unavailable_ids:
                raise DatasetValidationError(
                    "请求的地震情景在当前数据集中不可用："
                    f"{', '.join(unavailable_ids)}。可用情景：{self._available_scenario_text()}。"
                    "系统禁止插值或外推，也不会改算其他情景。"
                )
            selector_groups.append(set(selection.scenario_ids))

        if selection.pga_values_g:
            matched: set[str] = set()
            unavailable_pga: list[float] = []
            for requested_pga in selection.pga_values_g:
                matches = {
                    scenario_id
                    for scenario_id, available_pga in available_by_id.items()
                    if available_pga is not None
                    and abs(float(available_pga) - requested_pga) <= tolerance_g
                }
                if not matches:
                    unavailable_pga.append(requested_pga)
                matched.update(matches)
            if unavailable_pga:
                requested_text = ", ".join(f"{value:g}g" for value in unavailable_pga)
                event_note = ""
                if any(
                    abs(event_pga - requested_pga) <= tolerance_g
                    for event_pga in self.event_pga_g
                    for requested_pga in unavailable_pga
                ):
                    event_note = (
                        "其中匹配值仅作为事件PGA元数据存在，缺少对应EDP、交通、"
                        "基础设施和伤员等完整计算输入。"
                    )
                raise DatasetValidationError(
                    f"请求的PGA={requested_text}在当前数据集中没有可计算情景。"
                    f"可用情景：{self._available_scenario_text()}。{event_note}"
                    "系统禁止插值或外推，也不会改算其他情景。"
                )
            selector_groups.append(matched)

        if selection.pga_range_g is not None:
            minimum, maximum = selection.pga_range_g
            available_numeric = [
                float(value) for value in self.scenario_pga_g if value is not None
            ]
            if not available_numeric:
                raise DatasetValidationError(
                    "当前数据集的情景没有PGA元数据，不能按PGA区间筛选。"
                )
            available_minimum = min(available_numeric)
            available_maximum = max(available_numeric)
            if (
                minimum < available_minimum - tolerance_g
                or maximum > available_maximum + tolerance_g
            ):
                raise DatasetValidationError(
                    f"请求的PGA区间[{minimum:g}g, {maximum:g}g]超出当前数据集"
                    f"可计算范围[{available_minimum:g}g, {available_maximum:g}g]。"
                    f"可用情景：{self._available_scenario_text()}。"
                    "系统禁止插值或外推，也不会改算范围内的部分情景。"
                )
            matched = {
                scenario_id
                for scenario_id, available_pga in available_by_id.items()
                if available_pga is not None
                and minimum - tolerance_g <= float(available_pga) <= maximum + tolerance_g
            }
            if not matched:
                raise DatasetValidationError(
                    f"请求的PGA区间[{minimum:g}g, {maximum:g}g]内没有数据集情景。"
                )
            selector_groups.append(matched)

        selected = selector_groups[0]
        for group in selector_groups[1:]:
            if group != selected:
                raise DatasetValidationError(
                    "scenario_ids、pga_values_g与pga_range_g指向的情景不一致；"
                    "请只保留一种选择方式或使多种选择方式完全一致。"
                )
        return [scenario_id for scenario_id in self.scenario_ids if scenario_id in selected]

    def select_scenarios(
        self,
        selection: EarthquakeScenarioSelection | None,
    ) -> "HealthcareDataset":
        selected_ids = self.resolve_scenario_selection(selection)
        selected_indices = [self.scenario_ids.index(item) for item in selected_ids]
        selection_trace = {
            "policy": "strict_existing_scenarios_no_interpolation_or_extrapolation",
            "requested": selection.model_dump(mode="json") if selection is not None else None,
            "available_scenario_ids": list(self.scenario_ids),
            "available_pga_g": list(self.scenario_pga_g),
            "selected_scenario_ids": selected_ids,
        }
        return replace(
            self,
            scenario_ids=selected_ids,
            scenario_pga_g=[self.scenario_pga_g[index] for index in selected_indices],
            travel_time={item: self.travel_time[item] for item in selected_ids},
            edp={item: self.edp[item] for item in selected_ids},
            scenario_edp_source={item: self.scenario_edp_source[item] for item in selected_ids},
            infrastructure_availability={
                item: self.infrastructure_availability[item] for item in selected_ids
            },
            staff_loss={item: self.staff_loss[item] for item in selected_ids if item in self.staff_loss},
            casualty_day={
                item: self.casualty_day[item] for item in selected_ids if item in self.casualty_day
            },
            casualty_night={
                item: self.casualty_night[item]
                for item in selected_ids
                if item in self.casualty_night
            },
            parameter_provenance={
                **self.parameter_provenance,
                "scenario_selection": selection_trace,
            },
            warnings=list(self.warnings),
            source_files=list(self.source_files),
            observations={key: value for key, value in self.observations.items() if key in selected_ids},
        )

    def _available_scenario_text(self) -> str:
        return ", ".join(
            (
                f"{scenario_id} (PGA={pga:g}g)"
                if pga is not None
                else f"{scenario_id} (PGA未提供)"
            )
            for scenario_id, pga in zip(self.scenario_ids, self.scenario_pga_g)
        )

    def validate(self) -> None:
        errors: list[str] = []
        n_hos = self.num_hospitals
        n_nodes = self.num_nodes
        if len(self.scenario_pga_g) != len(self.scenario_ids):
            errors.append("scenario_pga_g must align with scenario_ids")
        if len(set(self.hospital_ids)) != n_hos:
            errors.append("hospital_ids must be unique")
        if len(self.hospital_names) != n_hos:
            errors.append("hospital_names must align with hospital_ids")
        if self.hospital_coordinates.shape != (n_hos, 2):
            errors.append("hospital_coordinates must have shape (hospital, 2)")
        if len(self.parameter_profile_ids) != n_hos:
            errors.append("parameter_profile_ids must align with hospital_ids")
        if self.floor_counts.shape != (n_hos,) or np.any(self.floor_counts <= 0):
            errors.append("floor_counts must contain one positive value per hospital")
        if np.any(self.floor_counts != np.floor(self.floor_counts)):
            errors.append("floor_counts must contain integers")
        if self.department_counts.shape != (n_hos, 4):
            errors.append("department_counts must have shape (hospital, 4)")
        if self.staff_counts.shape != (n_hos, 4):
            errors.append("staff_counts must have shape (hospital, 4)")
        if self.repair_time_median.shape != (n_hos, 5):
            errors.append("repair_time_median must have shape (hospital, 5)")
        if self.repair_time_std.shape != (n_hos, 5):
            errors.append("repair_time_std must have shape (hospital, 5)")
        if self.department_distribution.ndim != 2 or self.department_distribution.shape[1] != 6:
            errors.append("department_distribution must have six columns")
        for scenario in self.scenario_ids:
            if scenario not in self.travel_time or self.travel_time[scenario].shape != (n_nodes, n_hos):
                errors.append(f"travel_time[{scenario}] must have shape ({n_nodes}, {n_hos})")
            elif np.any(np.isnan(self.travel_time[scenario]) | (self.travel_time[scenario] < 0)):
                errors.append(f"travel_time[{scenario}] must be nonnegative; use positive infinity for an unreachable link")
            if scenario not in self.edp:
                errors.append(f"missing EDP for scenario {scenario}")
            elif self.edp[scenario].ndim != 3 or self.edp[scenario].shape[1:] != (self.total_floors, 4):
                errors.append(f"edp[{scenario}] must have shape (samples, {self.total_floors}, 4)")
            elif np.any(~np.isfinite(self.edp[scenario])) or np.any(self.edp[scenario] < 0):
                errors.append(f"edp[{scenario}] must be finite and nonnegative")
            if scenario not in self.scenario_edp_source:
                errors.append(f"missing EDP source for scenario {scenario}")
            if scenario not in self.infrastructure_availability or self.infrastructure_availability[scenario].shape != (n_hos,):
                errors.append(f"infrastructure_availability[{scenario}] must have shape ({n_hos},)")
            elif np.any(~np.isfinite(self.infrastructure_availability[scenario])) or np.any((self.infrastructure_availability[scenario] < 0) | (self.infrastructure_availability[scenario] > 1)):
                errors.append(f"infrastructure_availability[{scenario}] must be in [0, 1]")
            for name, records in (("casualty_day", self.casualty_day), ("casualty_night", self.casualty_night)):
                if scenario in records and (records[scenario].shape != (n_nodes, 3, 2) or np.any(~np.isfinite(records[scenario])) or np.any(records[scenario] < 0)):
                    errors.append(f"{name}[{scenario}] must be a finite nonnegative node x severity x (mean, std) array")
        numeric_arrays = [
            self.floor_counts,
            self.department_counts,
            self.staff_counts,
            self.node_population,
            self.repair_time_median,
            self.repair_time_std,
        ]
        if any(np.any(~np.isfinite(array)) or np.any(np.asarray(array, dtype=float) < 0) for array in numeric_arrays):
            errors.append("canonical healthcare inputs must be finite and nonnegative")
        if self.survival_probability.ndim != 2 or self.survival_probability.shape[0] != 3 or self.survival_probability.shape[1] == 0:
            errors.append("survival_probability must contain three nonempty hourly curves")
        elif np.any(~np.isfinite(self.survival_probability)) or np.any((self.survival_probability < 0) | (self.survival_probability > 1)):
            errors.append("survival probabilities must be finite and within [0, 1]")
        if errors:
            raise DatasetValidationError("; ".join(errors))

    def save(self, directory: Path) -> DatasetArtifacts:
        self.validate()
        directory.mkdir(parents=True, exist_ok=True)
        metadata_path = directory / "canonical_dataset.json"
        arrays_path = directory / "canonical_dataset.npz"
        arrays: dict[str, np.ndarray] = {
            "floor_counts": self.floor_counts,
            "department_counts": self.department_counts,
            "department_distribution": self.department_distribution,
            "staff_counts": self.staff_counts,
            "hospital_coordinates": self.hospital_coordinates,
            "node_population": self.node_population,
            "node_coordinates": self.node_coordinates,
            "repair_time_median": self.repair_time_median,
            "repair_time_std": self.repair_time_std,
            "survival_probability": self.survival_probability,
            "event_pga_g": np.asarray(self.event_pga_g, dtype=float),
        }
        for index, scenario in enumerate(self.scenario_ids):
            arrays[f"travel_time_{index}"] = self.travel_time[scenario]
            arrays[f"edp_{index}"] = self.edp[scenario]
            arrays[f"infrastructure_{index}"] = self.infrastructure_availability[scenario]
            arrays[f"staff_loss_{index}"] = self.staff_loss.get(scenario, np.zeros((self.num_hospitals, 4)))
            arrays[f"casualty_day_{index}"] = self.casualty_day.get(
                scenario, np.zeros((self.num_nodes, 3, 2))
            )
            arrays[f"casualty_night_{index}"] = self.casualty_night.get(
                scenario, np.zeros((self.num_nodes, 3, 2))
            )
        write_npz(arrays_path, **arrays)
        write_json(
            metadata_path,
            {
                "profile": self.profile,
                "source_dir": str(self.source_dir.resolve()),
                "scenario_ids": self.scenario_ids,
                "scenario_pga_g": self.scenario_pga_g,
                "hospital_ids": self.hospital_ids,
                "hospital_names": self.hospital_names,
                "parameter_profile_ids": self.parameter_profile_ids,
                "parameter_provenance": self.parameter_provenance,
                "fragility_records": self.fragility_records,
                "scenario_edp_source": self.scenario_edp_source,
                "warnings": [warning.model_dump(mode="json") for warning in self.warnings],
                "source_files": self.source_files,
                "observations": self.observations,
                "unit_standard_id": UNIT_STANDARD_ID,
                "units": canonical_units(),
                "unit_contract": self.parameter_provenance.get("unit_contract", {}),
            },
        )
        return DatasetArtifacts(
            metadata=artifact_ref(metadata_path, "application/json", "Canonical healthcare dataset metadata"),
            arrays=artifact_ref(arrays_path, "application/x-npz", "Canonical healthcare dataset arrays"),
        )

    @classmethod
    def load(cls, artifacts: DatasetArtifacts) -> "HealthcareDataset":
        metadata = read_json(artifacts.metadata.path)
        validate_canonical_units(metadata.get("units"))
        if metadata.get("unit_standard_id", UNIT_STANDARD_ID) != UNIT_STANDARD_ID:
            raise DatasetValidationError("Unsupported canonical healthcare unit standard")
        if metadata.get("unit_standard_id") is not None and metadata.get("units") != canonical_units():
            raise DatasetValidationError("Versioned canonical metadata must declare the complete healthcare unit map")
        unit_contract = metadata.get("unit_contract", {})
        stored_contract = metadata.get("parameter_provenance", {}).get("unit_contract", {})
        for contract in (unit_contract, stored_contract):
            if not isinstance(contract, dict):
                raise DatasetValidationError("Canonical unit contract must be a mapping")
            if contract:
                if contract.get("standard_id") != UNIT_STANDARD_ID:
                    raise DatasetValidationError("Canonical unit provenance has an unsupported standard")
                validate_canonical_units(contract.get("canonical_units"))
                if contract.get("canonical_units") != canonical_units():
                    raise DatasetValidationError("Canonical unit provenance must declare the complete healthcare unit map")
        if unit_contract != stored_contract:
            raise DatasetValidationError("Canonical unit provenance differs from parameter provenance")
        legacy_unit_contract = None
        if not unit_contract and metadata.get("unit_standard_id") is None:
            # Only the in-memory interpretation is backfilled. Historical
            # metadata/arrays remain unchanged and are not represented as an
            # explicit physical-unit declaration. This participates in the new
            # dataset fingerprint before downstream artifact binding.
            legacy_unit_contract = {
                "standard_id": UNIT_STANDARD_ID,
                "canonical_units": canonical_units(),
                "input_edp_units": dict(zip(EDP_NAMES, EDP_UNITS)),
                "conversion_factors": {name: 1.0 for name in EDP_NAMES},
                "basis": "previous_canonical_adapter_numerical_convention",
                "declaration_mode": "legacy_canonical_compatibility_fallback",
                "input_metadata_units": metadata.get("units"),
                "normalization_boundary": "historical_canonical_no_numeric_conversion",
                "physical_source_verification": "not_established_by_unit_normalization",
            }
        with np.load(artifacts.arrays.path, allow_pickle=False) as raw:
            scenario_ids = list(metadata["scenario_ids"])
            travel_time = {scenario: raw[f"travel_time_{i}"].copy() for i, scenario in enumerate(scenario_ids)}
            edp = {scenario: raw[f"edp_{i}"].copy() for i, scenario in enumerate(scenario_ids)}
            infrastructure = {
                scenario: raw[f"infrastructure_{i}"].copy() for i, scenario in enumerate(scenario_ids)
            }
            staff_loss = {scenario: raw[f"staff_loss_{i}"].copy() for i, scenario in enumerate(scenario_ids)}
            casualty_day = {
                scenario: raw[f"casualty_day_{i}"].copy() for i, scenario in enumerate(scenario_ids)
            }
            casualty_night = {
                scenario: raw[f"casualty_night_{i}"].copy() for i, scenario in enumerate(scenario_ids)
            }
            dataset = cls(
                profile=metadata["profile"],
                source_dir=Path(metadata["source_dir"]),
                scenario_ids=scenario_ids,
                scenario_pga_g=list(metadata["scenario_pga_g"]),
                event_pga_g=raw["event_pga_g"].astype(float).tolist(),
                hospital_ids=list(metadata["hospital_ids"]),
                hospital_names=list(metadata["hospital_names"]),
                hospital_coordinates=(
                    raw["hospital_coordinates"].copy()
                    if "hospital_coordinates" in raw.files
                    else np.full((len(metadata["hospital_ids"]), 2), np.nan)
                ),
                parameter_profile_ids=list(metadata.get("parameter_profile_ids", metadata["hospital_ids"])),
                parameter_provenance=dict(
                    metadata.get(
                        "parameter_provenance",
                        {"kind": "legacy_embedded", "binding_method": "hospital_id"},
                    )
                ),
                floor_counts=raw["floor_counts"].copy(),
                department_counts=raw["department_counts"].copy(),
                department_distribution=raw["department_distribution"].copy(),
                staff_counts=raw["staff_counts"].copy(),
                node_population=raw["node_population"].copy(),
                node_coordinates=raw["node_coordinates"].copy(),
                travel_time=travel_time,
                edp=edp,
                scenario_edp_source=dict(
                    metadata.get(
                        "scenario_edp_source",
                        {scenario: "unspecified_legacy_artifact" for scenario in scenario_ids},
                    )
                ),
                infrastructure_availability=infrastructure,
                repair_time_median=raw["repair_time_median"].copy(),
                repair_time_std=raw["repair_time_std"].copy(),
                staff_loss=staff_loss,
                casualty_day=casualty_day,
                casualty_night=casualty_night,
                survival_probability=raw["survival_probability"].copy(),
                fragility_records=list(metadata["fragility_records"]),
                warnings=[SkillWarning.model_validate(item) for item in metadata.get("warnings", [])],
                source_files=list(metadata.get("source_files", [])),
                observations=dict(metadata.get("observations", {})),
            )
        if legacy_unit_contract is not None:
            dataset.parameter_provenance["unit_contract"] = legacy_unit_contract
        dataset.validate()
        return dataset


def load_dataset_reference(
    dataset_source: Any,
    dataset_artifacts: DatasetArtifacts | None,
) -> HealthcareDataset:
    if dataset_artifacts is not None:
        return HealthcareDataset.load(dataset_artifacts)
    from .adapters import load_healthcare_dataset

    return load_healthcare_dataset(dataset_source)
