"""Content snapshots with a credential-free environment allowlist."""
from __future__ import annotations

from contextvars import ContextVar
from contextlib import contextmanager
import importlib.metadata
import inspect
from pathlib import Path
import platform
import sys

from .artifacts import sha256_file

_checks: ContextVar[list | None] = ContextVar('engineering_checks', default=None)


@contextmanager
def capture_checks():
    events = []
    token = _checks.set(events)
    try:
        yield events
    finally:
        _checks.reset(token)


def record_check(rule, passed):
    events = _checks.get()
    event = {'rule': rule, 'passed': bool(passed)}
    if events is not None and event not in events:
        events.append(event)


def input_sources(payload):
    result = {}
    def walk(value, key=''):
        if isinstance(value, dict):
            for k,v in value.items(): walk(v,k)
        elif isinstance(value, list):
            for v in value: walk(v,key)
        elif isinstance(value, str) and (key == 'path' or key.endswith('_path')):
            p = Path(value)
            candidates = [p] if p.is_file() else (sorted(p.rglob('*')) if p.is_dir() else [])
            for f in candidates:
                if f.is_file() and f.suffix.lower() in {'.json','.npz','.xlsx','.xls','.csv','.txt'}:
                    result[str(f.resolve())] = sha256_file(f)
    walk(payload)
    return result


def implementation_record(component):
    records = {}
    for cls in type(component).__mro__:
        if cls.__module__ == 'builtins': continue
        source = inspect.getsourcefile(cls)
        if source and Path(source).is_file(): records[str(Path(source).resolve())] = sha256_file(Path(source))
    from .rules import component_rules, validator_record
    return {'entrypoint': f'{type(component).__module__}:{type(component).__qualname__}._execute',
            'request_schema': f'{component.request_model.__module__}:{component.request_model.__name__}',
            'output_schema': (f'{component.resolved_output_model().__module__}:{component.resolved_output_model().__name__}'
                              if component.resolved_output_model() else None),
            'source_files': records,
            'rule_validators': {r.rule_id:validator_record(r) for r in component_rules(component)}}


def runtime_snapshot():
    names = ['engineering-skills','seismo-skill-agent','pydantic','numpy','scipy','pandas','packaging',
             'langgraph','langgraph-checkpoint-sqlite','openai','llama-index-core','faiss-cpu','fastembed']
    versions = {}
    for name in names:
        try: versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError: versions[name] = None
    root = Path(__file__).resolve().parents[1]
    return {'python': sys.version, 'platform': platform.platform(), 'packages': versions,
            'code_sha256': {str(p.relative_to(root)): sha256_file(p) for p in sorted(root.rglob('*'))
                            if p.suffix in {'.py','.yaml'} and '__pycache__' not in p.parts},
            'historical_environment': False}
