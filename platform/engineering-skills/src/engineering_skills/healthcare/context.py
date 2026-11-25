from __future__ import annotations

from pydantic import BaseModel, ValidationError

from engineering_skills.core.exceptions import DatasetValidationError
from engineering_skills.core.exceptions import ModelNotApplicableError
from engineering_skills.core.models import ValidationIssue, ValidationReport
from engineering_skills.healthcare.adapters import load_healthcare_dataset
from engineering_skills.healthcare.localization import english_warning_message
from engineering_skills.healthcare.schemas import HealthcareAnalysisContext
from engineering_skills.healthcare.observations import apply_observations, validate_observation_mode
from engineering_skills.healthcare.parameters import uses_shared_resource_treatment
from engineering_skills.healthcare.metric_standard import ensure_official_metric_inputs
from engineering_skills.healthcare.skills.recovery_optimization.constraints import RecoveryConstraintInputError, bind_constraints


def validate_healthcare_analysis_context(
    payload: dict | BaseModel,
) -> ValidationReport:
    """Validate the shared healthcare case context without invoking a workflow."""

    try:
        request = (
            payload
            if isinstance(payload, HealthcareAnalysisContext)
            else HealthcareAnalysisContext.model_validate(payload)
        )
    except ValidationError as exc:
        return ValidationReport(
            valid=False,
            issues=[
                ValidationIssue(
                    code="schema_validation",
                    field=".".join(str(part) for part in error["loc"]),
                    message=error["msg"],
                )
                for error in exc.errors()
            ],
        )

    issues: list[ValidationIssue] = []
    try:
        ensure_official_metric_inputs(request)
    except ValueError as exc:
        return ValidationReport(valid=False, issues=[ValidationIssue(
            code="metric_standard_mismatch", field="model_profile", message=str(exc),
            category="model_not_applicable",
        )], normalized_input=request.model_dump(mode="json", exclude_none=True))
    try:
        dataset = load_healthcare_dataset(request.dataset_source)
        dataset = apply_observations(dataset, request.observations).select_scenarios(request.scenario_selection)
        validate_observation_mode(dataset, request.assessment_mode, request.model_profile)
        hard = bind_constraints(request.decision_preferences, dataset.hospital_ids, request.team_count)
        if hard is not None and "ga_legacy" in request.strategies:
            issues.append(ValidationIssue(
                code="recovery_strategy_unsupported", field="strategies", category="model_not_applicable",
                message="Hard recovery constraints require importance or robust_ga.",
            ))
        if uses_shared_resource_treatment(request.model_profile):
            curve_length = len(request.treatment_parameters.survival_curve_probabilities[0]) if request.treatment_parameters.survival_curve_probabilities else dataset.survival_probability.shape[1]
            if request.treatment_horizon_hours > curve_length:
                raise ValueError("Treatment initiation horizon exceeds the available survival curve")
            if request.treatment_horizon_hours / request.treatment_parameters.time_step_hours > 288:
                raise ValueError("Treatment scheduling supports at most 288 time slots; revise the explicit horizon or time step")
    except RecoveryConstraintInputError as exc:
        issues.append(ValidationIssue(code=exc.reason_code, message=str(exc), field="decision_preferences.recovery_constraints"))
    except (DatasetValidationError, FileNotFoundError, ValueError) as exc:
        issues.append(
            ValidationIssue(
                code=(
                    "scenario_availability"
                    if request.scenario_selection is not None
                    else "dataset_validation"
                ),
                field=(
                    "scenario_selection"
                    if request.scenario_selection is not None
                    else "dataset_source"
                ),
                message=str(exc),
                category='model_not_applicable' if isinstance(exc, ModelNotApplicableError) else 'input_invalid',
            )
        )
    else:
        issues.extend(
            ValidationIssue(
                code=warning.code,
                field="dataset_source",
                message=(
                    english_warning_message(
                        warning.code,
                        warning.message,
                        warning.details,
                    )
                    if request.output_language == "en-US"
                    else warning.message
                ),
                severity="warning",
            )
            for warning in dataset.warnings
        )

    return ValidationReport(
        valid=not any(issue.severity == "error" for issue in issues),
        issues=issues,
        normalized_input=request.model_dump(mode="json", exclude_none=True),
    )
