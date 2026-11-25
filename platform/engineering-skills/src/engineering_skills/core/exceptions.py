from __future__ import annotations

from .models import SkillDAGValidationReport, ValidationReport


class EngineeringSkillError(RuntimeError):
    """Base error for the Engineering Skills runtime."""


class SkillNotFoundError(EngineeringSkillError):
    pass


class SkillValidationError(EngineeringSkillError):
    def __init__(self, report: ValidationReport):
        self.report = report
        details = "; ".join(issue.message for issue in report.issues)
        super().__init__(details or "Skill request validation failed")


class DatasetValidationError(EngineeringSkillError):
    pass


class SkillDAGCompilationError(EngineeringSkillError):
    def __init__(self, report: SkillDAGValidationReport):
        self.report = report
        details = "; ".join(issue.message for issue in report.issues)
        super().__init__(details or "Engineering Skill DAG compilation failed")


class SkillDAGExecutionError(EngineeringSkillError):
    def __init__(self, message, *, phase='preflight', report=None):
        super().__init__(message)
        self.phase = phase
        self.report = report


class SkillRegistrationError(ValueError):
    """Invalid registration, compatible with existing ValueError callers."""


class InstanceBindingError(ValueError):
    """A frozen runtime binding conflicts with code, inputs or stored identity."""


class InstanceStoreError(RuntimeError):
    """The independent instance evidence store could not be read or written."""


class ModelNotApplicableError(ValueError):
    pass


class ResultConstraintError(ValueError):
    pass


class SolverOutcomeError(ValueError):
    def __init__(self, message, *, solver_status=None, feasibility='undetermined', solver_scope=None,
                 reason_code=None, details=None):
        super().__init__(message)
        self.solver_status = solver_status
        self.feasibility = feasibility
        self.solver_scope = solver_scope
        self.reason_code = reason_code
        self.details = details


def classify_failure(exc, phase=None):
    from pydantic import ValidationError
    stage = phase or getattr(exc, 'phase', None)
    if isinstance(exc, SkillRegistrationError):
        return {'category':'registration_invalid', 'feasibility':'not_evaluated'}
    if isinstance(exc, InstanceBindingError):
        return {'category':'binding_invalid', 'feasibility':'not_evaluated'}
    if isinstance(exc, InstanceStoreError):
        return {'category':'storage_error', 'feasibility':'not_evaluated'}
    if isinstance(exc, SolverOutcomeError):
        result = {'category': 'optimization_infeasible' if exc.feasibility == 'proven_infeasible' else 'optimization_not_solved',
                'feasibility': exc.feasibility, 'solver_status': exc.solver_status,
                'solver_scope': exc.solver_scope,
                'may_relax_constraints_automatically': False}
        if exc.reason_code is not None:
            result['reason_code'] = exc.reason_code
        if exc.details is not None:
            result['details'] = exc.details
        return result
    if isinstance(exc, ModelNotApplicableError):
        return {'category': 'model_not_applicable', 'feasibility': 'not_evaluated'}
    if isinstance(exc, ResultConstraintError):
        return {'category': 'result_invalid', 'feasibility': 'undetermined'}
    if isinstance(exc, (SkillValidationError, DatasetValidationError, ValidationError, SkillDAGCompilationError)):
        if isinstance(exc, SkillValidationError) and any(x.category == 'model_not_applicable' for x in exc.report.issues):
            return {'category': 'model_not_applicable', 'feasibility': 'not_evaluated'}
        if isinstance(exc, SkillValidationError) and any(x.category == 'result_invalid' for x in exc.report.issues):
            return {'category': 'result_invalid', 'feasibility': 'undetermined'}
        return {'category': 'input_invalid', 'feasibility': 'not_evaluated'}
    if isinstance(exc, SkillDAGExecutionError):
        if exc.report is not None:
            return classify_failure(SkillValidationError(exc.report), stage)
        return {'category': 'result_invalid' if stage in {'output_validation','output_binding'} else 'input_invalid',
                'feasibility':'not_evaluated'}
    if isinstance(exc, SkillNotFoundError):
        return {'category':'registration_invalid', 'feasibility':'not_evaluated'}
    if isinstance(exc, (ValueError, TypeError, KeyError)) and stage in {'input_validation','binding','preflight','context'}:
        return {'category':'input_invalid', 'feasibility':'not_evaluated'}
    if isinstance(exc, (ValueError, TypeError, KeyError)) and stage in {'output_validation','output_binding'}:
        return {'category':'result_invalid','feasibility':'undetermined'}
    if isinstance(exc, OSError):
        return {'category':'storage_error','feasibility':'undetermined'}
    return {'category': 'execution_failed', 'feasibility': 'undetermined'}
