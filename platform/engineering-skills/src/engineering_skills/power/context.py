from pydantic import ValidationError
from engineering_skills.core.models import ValidationIssue, ValidationReport
from .schemas import PowerAnalysisContext
from .data import load_dataset
from .native.optimizer import parameters


def validate_power_analysis_context(payload):
    try:
        request = payload if isinstance(payload, PowerAnalysisContext) else PowerAnalysisContext.model_validate(payload)
    except ValidationError as exc:
        return ValidationReport(valid=False, issues=[ValidationIssue(code='schema_validation',
            field='.'.join(map(str, e['loc'])), message=e['msg']) for e in exc.errors()])
    normalized = request.model_dump(mode='json')
    issues = []
    try:
        dataset = load_dataset(request.dataset_source)
        if request.node_pga_g is not None:
            import numpy as np
            values = np.asarray(request.node_pga_g)
            if len(values) != len(dataset['bus']) or not np.isfinite(values).all() or (values < 0).any():
                raise ValueError('显式节点PGA须逐一覆盖本案例所有电网节点，单位g，且为非负有限数。')
        parameters(normalized)
        constraints = request.repair_constraints
        known = {'node:' + str(int(r[0])) for r in dataset['bus']} | {'pipe:' + str(int(r[0])) for r in dataset['branch']}
        if set(constraints) - known:
            raise ValueError('修复约束引用不存在的电网资产。')
        for key, row in constraints.items():
            if set(row.get('predecessors', [])) - known:
                raise ValueError('先后约束引用不存在的电网资产。')
        visiting = set(); visited = set()
        def visit(key):
            if key in visiting:
                raise ValueError('修复先后约束存在循环。')
            if key in visited:
                return
            visiting.add(key)
            for prior in constraints.get(key, {}).get('predecessors', []):
                visit(prior)
            visiting.remove(key); visited.add(key)
        for key in constraints:
            visit(key)
    except (ValueError, FileNotFoundError, KeyError) as exc:
        issues.append(ValidationIssue(code='power_context_validation', field='analysis_context', message=str(exc)))
    return ValidationReport(valid=not issues, issues=issues, normalized_input=normalized)
