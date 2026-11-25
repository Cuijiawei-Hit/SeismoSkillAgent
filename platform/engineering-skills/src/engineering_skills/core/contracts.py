"""Small deterministic interface and applicability checks, independent of healthcare."""
from __future__ import annotations

import math
from packaging.version import Version, InvalidVersion
from .models import ValidationIssue


def version_key(value: str) -> Version:
    try:
        return Version(value)
    except InvalidVersion as exc:
        raise ValueError(f'Invalid implementation/contract version: {value}') from exc


def latest_version(versions):
    versions = list(versions)
    stable = [v for v in versions if not version_key(v).is_prerelease]
    return max(stable or list(versions), key=version_key)


def value_at(value, field):
    if field == '$':
        return value
    for part in field.split('.'):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(field)
        value = value[part]
    return value


def applicability_issues(payload, conditions, profiles=()):
    issues = []
    if profiles and payload.get('model_profile') not in profiles:
        issues.append(ValidationIssue(code='model_profile_not_applicable', field='model_profile',
            message=f'Model profile must be one of {list(profiles)}', category='model_not_applicable'))
    for condition in conditions:
        try:
            v = value_at(payload, condition.field)
            e = condition.expected
            passed = {'eq': lambda: v == e, 'in': lambda: v in e,
                'ge': lambda: v >= e, 'le': lambda: v <= e,
                'present': lambda: v is not None}[condition.operator]()
        except (KeyError, TypeError, ValueError):
            passed = False
        if not passed:
            issues.append(ValidationIssue(code='model_condition_not_applicable', field=condition.field,
                message=condition.description or f'{condition.field}: {condition.operator} {condition.expected}',
                category='model_not_applicable'))
    return issues


def contract_compatible(producer, consumer):
    if producer.type_id != consumer.type_id or producer.contract_version != consumer.contract_version:
        return False
    return (all(producer.units.get(k) == v for k, v in consumer.units.items())
            and all(producer.field_types.get(k) == v for k, v in consumer.field_types.items()))


def template_contract_compatible(implementation, template):
    """Allow an explicit domain specialization only at Template registration.

    Data edges still use strict contract_compatible; this is not a unit or type cast.
    """
    if implementation.type_id != template.type_id and implementation.semantic_type_id != template.type_id:
        return False
    specialized = implementation.model_copy(update={'type_id': template.type_id})
    return contract_compatible(specialized, template)


def check_contract_value(value, contract):
    """Check declared paths/types and an explicit units map; no unit conversion."""
    tests = {'number': lambda v: isinstance(v, (int,float)) and not isinstance(v,bool) and math.isfinite(v),
             'integer': lambda v: isinstance(v,int) and not isinstance(v,bool),
             'string': lambda v: isinstance(v,str), 'array': lambda v: isinstance(v,list),
             'object': lambda v: isinstance(v,dict), 'boolean': lambda v: isinstance(v,bool)}
    for field, kind in contract.field_types.items():
        try:
            valid = tests[kind](value_at(value, field))
        except (KeyError, TypeError, ValueError, OverflowError):
            valid = False
        if not valid:
            raise ValueError(f'Contract {contract.name}: {field} must be {kind}')
    for field, unit in contract.units.items():
        units = value.get('units') if isinstance(value, dict) else None
        if not isinstance(units, dict) or units.get(field) != unit:
            raise ValueError(f'Contract {contract.name}: missing or incompatible unit for {field}: expected {unit}')
