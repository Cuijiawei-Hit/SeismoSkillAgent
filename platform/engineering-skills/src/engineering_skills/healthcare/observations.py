from __future__ import annotations

from copy import deepcopy

import numpy as np

from engineering_skills.core.models import AssessmentMode, SkillWarning, WarningSeverity
from .data import HealthcareDataset
from .engineering_checks import require
from .observation_schema import ObservedScenario
from .parameters import ModelProfile, RESOURCE_IDS, uses_constrained_engineering


def apply_observations(dataset: HealthcareDataset, observations: list[ObservedScenario]) -> HealthcareDataset:
    if not observations:
        return dataset
    result = deepcopy(dataset)
    require(len({item.scenario_id for item in observations}) == len(observations), "Observed scenario IDs must be unique")
    for observation in observations:
        scenario = observation.scenario_id
        reference = observation.reference_scenario_id
        if scenario not in result.scenario_ids:
            require(reference in dataset.scenario_ids, "A new observed event requires an explicit available reference_scenario_id for missing engineering inputs")
            result.scenario_ids.append(scenario)
            result.scenario_pga_g.append(observation.pga_g)
            for name in ("travel_time", "edp", "infrastructure_availability", "staff_loss", "casualty_day", "casualty_night"):
                mapping = getattr(result, name)
                mapping[scenario] = getattr(dataset, name)[reference].copy()
            result.scenario_edp_source[scenario] = "explicit_reference_scenario_edp"
        else:
            index = result.scenario_ids.index(scenario)
            existing_pga = result.scenario_pga_g[index]
            require(existing_pga is None or abs(existing_pga - observation.pga_g) < 1e-6, "Measured PGA differs from this scenario; provide a new event ID and explicit reference scenario")
        if observation.pga_g not in result.event_pga_g:
            result.event_pga_g.append(observation.pga_g)
        hospitals = {}
        for hospital in observation.hospitals:
            require(hospital.hospital_id in result.hospital_ids, f"Unknown observed hospital: {hospital.hospital_id}")
            h = result.hospital_ids.index(hospital.hospital_id)
            for row in hospital.floor_edp:
                require(row.floor <= result.floor_counts[h], "Observed floor is outside the hospital inventory")
                if hospital.max_idr is not None and row.IDR is not None:
                    require(row.IDR <= hospital.max_idr + 1e-10, "Observed floor IDR exceeds the declared hospital maximum IDR")
            for resource, count in hospital.available_resources.items():
                require(count <= result.pre_resources[h, RESOURCE_IDS.index(resource)], "Observed retained resources exceed the baseline; surge resources require a separate inventory version")
            hospitals[hospital.hospital_id] = hospital.model_dump(mode="json", exclude_none=True)
        for node, destinations in observation.travel_time_minutes.items():
            require(node.startswith("N") and node[1:].isdigit() and 1 <= int(node[1:]) <= result.num_nodes, f"Unknown observed demand node: {node}")
            for hospital, minutes in destinations.items():
                require(hospital in result.hospital_ids, f"Unknown observed hospital: {hospital}")
                result.travel_time[scenario][int(node[1:]) - 1, result.hospital_ids.index(hospital)] = np.inf if minutes is None else minutes
        for name in ("day", "night"):
            for node, counts in getattr(observation, f"casualty_{name}_counts").items():
                require(node.startswith("N") and node[1:].isdigit() and 1 <= int(node[1:]) <= result.num_nodes, f"Unknown observed demand node: {node}")
                row = getattr(result, f"casualty_{name}")[scenario][int(node[1:]) - 1]
                row[:, 0] = counts
                row[:, 1] = 0
        trace = observation.model_dump(mode="json", exclude_none=True)
        trace["hospitals"] = hospitals
        trace["missing_value_policy"] = "Explicit reference scenario supplies unobserved fields; no interpolation or inferred observations"
        result.observations[scenario] = trace
        result.warnings.append(SkillWarning(
            code="observed_event_reference_inputs", severity=WarningSeverity.WARNING,
            message="观测值按医院和字段覆盖；未观测输入来自明确指定的参考情景，不代表现场实测。",
            details={"scenario_id": scenario, "reference_scenario_id": reference or scenario, "source": observation.source, "observed_at": observation.observed_at.isoformat()},
        ))
    result.parameter_provenance["observations"] = result.observations
    result.validate()
    return result


def validate_observation_mode(dataset: HealthcareDataset, mode: AssessmentMode, profile: ModelProfile) -> None:
    from .engineering_checks import require_applicable
    if not uses_constrained_engineering(profile):
        return
    if mode == AssessmentMode.PREDICTIVE:
        require_applicable(not dataset.observations, "Observed inputs require hybrid or rapid mode")
    if mode == AssessmentMode.RAPID:
        for scenario in dataset.scenario_ids:
            observed = dataset.observations.get(scenario)
            require_applicable(observed is not None, f"Rapid mode requires observed PGA and hospital IDR for {scenario}; a mode switch is not an observation")
            for h, hospital_id in enumerate(dataset.hospital_ids):
                item = observed["hospitals"].get(hospital_id, {})
                floor_idr = [row for row in item.get("floor_edp", []) if row.get("IDR") is not None]
                require_applicable(item.get("max_idr") is not None or len(floor_idr) == int(dataset.floor_counts[h]), f"Rapid mode requires observed maximum IDR or all floor IDRs for {hospital_id}")
