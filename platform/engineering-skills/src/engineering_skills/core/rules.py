"""Registered, inspectable Python rule bindings and per-run execution evidence."""
from __future__ import annotations

import importlib
import inspect
from pathlib import Path

from .artifacts import sha256_file
from .models import ValidationIssue


def resolve_validator(identifier):
    module, name = identifier.split(':', 1)
    value = importlib.import_module(module)
    for part in name.split('.'):
        value = getattr(value, part)
    if not callable(value):
        raise ValueError(f'Rule validator is not callable: {identifier}')
    inspect.signature(value).bind({}, None, {})
    return value


def component_rules(component):
    template = getattr(component, '_template', None)
    definitions = [*(template.executable_rules if template else []),
                   *component.describe().executable_rules]
    rules = {}
    for rule in definitions:
        if rule.rule_id in rules and rule != rules[rule.rule_id]:
            raise ValueError(f'Conflicting rule binding: {rule.rule_id}')
        rules[rule.rule_id] = rule
    return list(rules.values())


def validator_record(rule):
    if rule.status != 'executable':
        return {'validator': rule.validator, 'status': rule.status, 'reason': rule.reason}
    function = resolve_validator(rule.validator)
    source = inspect.getsourcefile(function)
    return {'validator': rule.validator,
            'source_file': str(Path(source).resolve()) if source else None,
            'source_sha256': sha256_file(Path(source)) if source and Path(source).is_file() else None,
            'source_line': inspect.getsourcelines(function)[1] if source else None,
            'tests': rule.tests}


def declared_coverage(component, results=()):
    template = getattr(component, '_template', None)
    rules = component_rules(component)
    events = {x['rule_id']: x for x in results}
    coverage = []
    for scope, declarations in [('implementation', component.describe().validation_rules),
                                ('template', template.invariant_rules if template else [])]:
        for text in declarations:
            bound = [r for r in rules if text in r.covers]
            executed = [events[r.rule_id] for r in bound if r.rule_id in events]
            status = ('failed' if any(e['status'] == 'failed' for e in executed)
                      else 'passed' if executed and all(e['status'] == 'passed' for e in executed)
                           and len(executed) == len(bound)
                      else 'bound_not_executed' if any(r.status == 'executable' for r in bound)
                      else 'unimplemented' if bound else 'unbound_declaration')
            coverage.append({'rule': text, 'scope': scope, 'status': status,
                             'rule_ids': ','.join(r.rule_id for r in bound),
                             'meaning': 'Only recorded validator execution can establish a pass'})
    return coverage


def run_rules(component, phase, value, request):
    issues, events = [], []
    for rule in component_rules(component):
        if rule.phase != phase:
            continue
        event = {'rule_id':rule.rule_id, 'phase':phase, 'covers':rule.covers,
                 **validator_record(rule)}
        if rule.status != 'executable':
            events.append({**event, 'status':'unimplemented', 'reason':rule.reason})
            continue
        if rule.profiles and request.get('model_profile') not in rule.profiles:
            events.append({**event, 'status':'skipped_profile', 'profile':request.get('model_profile')})
            continue
        try:
            returned = resolve_validator(rule.validator)(value, component, request)
            if not isinstance(returned, list):
                raise TypeError('Rule validators must return a list of ValidationIssue objects')
            found = [x if isinstance(x, ValidationIssue) else ValidationIssue.model_validate(x) for x in returned]
        except Exception as exc:
            found = [ValidationIssue(code='rule_validator_failed', field=rule.rule_id,
                message=f'{type(exc).__name__}: {exc}',
                category='input_invalid' if phase == 'input' else 'result_invalid')]
        if phase == 'output':
            found = [x.model_copy(update={'category':'result_invalid'}) for x in found]
        issues.extend(found)
        events.append({**event, 'status':'failed' if any(x.severity=='error' for x in found) else 'passed',
                       'issues':[x.model_dump(mode='json') for x in found]})
    return issues, events
