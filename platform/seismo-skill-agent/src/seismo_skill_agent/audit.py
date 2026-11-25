from __future__ import annotations

import json
import re
import threading
from urllib.parse import urlsplit, urlunsplit
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SENSITIVE_PARTS = ("api_key", "token", "secret", "password", "authorization")


def public_endpoint(value: str) -> str:
    """Retain the actual host/port/path, omit userinfo and query credentials."""
    endpoint = urlsplit(value)
    host = endpoint.hostname or ''
    if ':' in host:
        host = f'[{host}]'
    if endpoint.port is not None:
        host += f':{endpoint.port}'
    return urlunsplit((endpoint.scheme, host, endpoint.path, '', ''))


def _sensitive_key(key: str) -> bool:
    name = key.lower().replace('-', '_')
    # Usage counts and explicitly set sampling budgets must remain reproducible.
    return name in {'token','secret','password','authorization','credential','credentials'} or any(
        name.endswith(part) for part in ('api_key','access_token','refresh_token','auth_token','password','client_secret'))


def _redact_text(value: str, secrets: tuple[str, ...] = ()) -> str:
    for secret in secrets:
        if secret:
            value = value.replace(secret, '[REDACTED]')
    value = re.sub(r'(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*', 'Bearer [REDACTED]', value)
    value = re.sub(r'''(?ix)(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|client[_-]?secret|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,\[{}\]"';]+)''',
                   lambda match: match.group(1)+'"[REDACTED]"', value)
    def sanitize_url(match):
        try:
            return public_endpoint(match.group(0))
        except ValueError:
            return '[REDACTED_URL]'
    return re.sub(r'''https?://[^\s<>"']+''', sanitize_url, value)


def _redact_schema(value: Any, secrets: tuple[str, ...] = ()) -> Any:
    """Keep Schema property names/types; redact credential examples/defaults."""
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            if key == 'properties' and isinstance(child,dict):
                properties = {}
                for name, definition in child.items():
                    clean = _redact_schema(definition,secrets)
                    if _sensitive_key(str(name)) and isinstance(clean,dict):
                        for item in ('default','example','examples','const','enum'):
                            if item in clean:
                                clean[item] = '[REDACTED]'
                    properties[name] = clean
                result[key] = properties
            else:
                result[key] = _redact_schema(child,secrets)
        return result
    if isinstance(value,list):
        return [_redact_schema(x,secrets) for x in value]
    return _redact_text(value,secrets) if isinstance(value,str) else value


def redact(value: Any, secrets: tuple[str, ...] = ()) -> Any:
    if isinstance(value, dict):
        return {
            str(key): ("[REDACTED]" if _sensitive_key(str(key)) else
                       _redact_schema(child,secrets) if key=='response_schema' else redact(child, secrets))
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, tuple):
        return [redact(item, secrets) for item in value]
    if isinstance(value, str):
        return _redact_text(value, secrets)
    return value


class AuditStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._lock = threading.RLock()

    def record(self, session_id: str, stage: str, payload: dict[str, Any]) -> Path:
        safe_session = re.sub(r"[^A-Za-z0-9_.-]+", "_", session_id)
        directory = self.root.resolve() / safe_session
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "events.jsonl"
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "stage": stage,
            "payload": redact(payload),
        }
        with self._lock:
            with path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
        return path

    def record_llm(self, session_id: str, payload: dict[str, Any], *, secrets=()) -> Path:
        """Prompt records are local research provenance, not a public-data export."""
        safe_session = re.sub(r"[^A-Za-z0-9_.-]+", "_", session_id)
        directory = self.root.resolve() / safe_session
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / 'llm_calls.jsonl'
        event = {'schema_version':'1.0.0','timestamp':datetime.now(timezone.utc).isoformat(),
                 **redact(payload, tuple(secrets))}
        with self._lock:
            with path.open('a',encoding='utf-8') as stream:
                stream.write(json.dumps(event,ensure_ascii=False,default=str)+'\n')
        return path

    def write_final(self, session_id: str, payload: dict[str, Any]) -> Path:
        safe_session = re.sub(r"[^A-Za-z0-9_.-]+", "_", session_id)
        directory = self.root.resolve() / safe_session
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "final_state.json"
        path.write_text(
            json.dumps(redact(payload), ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
        return path


def runtime_configuration_snapshot(settings):
    """Explicit public configuration only: no credential or environment dumping."""
    from engineering_skills.core.artifacts import sha256_file
    root = Path(__file__).resolve().parent
    config = {name: getattr(settings, name) for name in (
        'deepseek_model','request_timeout_seconds','max_output_tokens','max_feedback_iterations',
        'max_execution_attempts','structured_response_attempts','text_response_attempts','knowledge_auto_build')}
    config['deepseek_base_url'] = public_endpoint(settings.deepseek_base_url)
    config['inference'] = {'temperature':0,'top_p':'not_explicitly_set','seed':'not_explicitly_set',
                           'response_format':'json_object for structured requests', 'sdk_max_retries':2}
    config['source_sha256'] = {p.name:sha256_file(p) for p in sorted(root.glob('*.py'))}
    pointer = settings.knowledge_root / 'index/semantic-active.json'
    try:
        if pointer.is_file():
            value = json.loads(pointer.read_text(encoding='utf-8'))
            index_root = (settings.knowledge_root / 'index').resolve()
            manifest = (index_root / value['directory'] / 'manifest.json').resolve()
            if not manifest.is_relative_to(index_root):
                raise ValueError('Knowledge manifest points outside index root')
            data = json.loads(manifest.read_text(encoding='utf-8'))
            config['knowledge_index'] = {k:data.get(k) for k in ('schema_version','built_at','embedding_model','model_repository','vector_sha256','document_count','chunk_count','vector_count')}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        config['snapshot_warnings'] = [f'Knowledge metadata unavailable: {type(exc).__name__}']
    config['historical_configuration'] = False
    config['workspace_root'] = str(settings.workspace_root) if settings.workspace_root is not None else None
    return config


