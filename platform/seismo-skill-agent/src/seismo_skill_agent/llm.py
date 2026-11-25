from __future__ import annotations

import json
import re
import time
import uuid
import warnings
from contextvars import ContextVar
import httpx
from typing import Any, Protocol, TypeVar

from openai import OpenAI
from pydantic import BaseModel

from .config import AgentSettings
from .prompts import FOLLOW_UP_COMPLETION_MARKER
from .audit import AuditStore, public_endpoint, redact


ModelT = TypeVar("ModelT", bound=BaseModel)
_trace_context: ContextVar[dict | None] = ContextVar('seismo_llm_trace_context', default=None)


def _trace_event(event: str, **payload):
    context = _trace_context.get()
    if context is None:
        return
    try:
        context['store'].record_llm(context['session_id'], {
            **{k:v for k,v in context.items() if k not in {'store','secrets'}},
            'event':event, **payload}, secrets=context.get('secrets',()))
    except (OSError, ValueError, TypeError) as exc:
        # An unavailable audit destination must not fabricate a computation failure.
        warnings.warn(f'LLM audit write failed ({type(exc).__name__}); provenance is incomplete', RuntimeWarning)


def trace_llm_call(llm, method, messages, response_model=None, *, audit_store: AuditStore,
                   session_id: str, stage: str, iteration=0, run_id=None, message_id=None):
    """Trace logical calls for real/Fake providers; SDK attempts add actual metadata.

    Hidden provider defaults and model weight revisions remain unknown. This local
    archive may contain user/engineering material after credential redaction;
    it is not an automatically public or anonymized corpus.
    """
    settings = getattr(llm, '_settings', None)
    key = getattr(settings, 'deepseek_api_key', None)
    secrets = (key.get_secret_value(),) if key is not None else ()
    context = {'store':audit_store,'session_id':session_id,'stage':stage,'iteration':iteration,
               'run_id':run_id,'message_id':message_id,'call_id':uuid.uuid4().hex,'secrets':secrets}
    token = _trace_context.set(context)
    started = time.monotonic()
    try:
        _trace_event('call_started', method=method, requested_model=getattr(llm,'model_name','unknown'),
            messages=messages, response_schema=response_model.model_json_schema(mode='validation') if response_model else None,
            provider_response_metadata='unknown_until_response', historical_configuration=False)
        value = llm.structured(messages,response_model) if method=='structured' else llm.text(messages)
        _trace_event('call_succeeded', parsed_output=value.model_dump(mode='json') if isinstance(value,BaseModel) else value,
            duration_seconds=time.monotonic()-started)
        return value
    except Exception as exc:
        _trace_event('call_failed', error_type=type(exc).__name__, message=str(exc),
                     duration_seconds=time.monotonic()-started)
        raise
    finally:
        _trace_context.reset(token)


def _response_metadata(response):
    def value(name):
        result = getattr(response,name,None)
        return result if isinstance(result,(str,int,float,bool,dict,list)) else 'unknown'
    usage = getattr(response,'usage',None)
    if isinstance(usage, BaseModel):
        usage = usage.model_dump(mode='json')
    elif not isinstance(usage,dict):
        usage = {k:getattr(usage,k) for k in ('prompt_tokens','completion_tokens','total_tokens')
                 if isinstance(getattr(usage,k,None),(int,float))} if usage is not None else 'unknown'
    choices = getattr(response,'choices',[]) or []
    return {'response_model':value('model'),'response_id':value('id'),
            'request_id':value('_request_id'),'system_fingerprint':value('system_fingerprint'),
            'usage':usage or 'unknown','finish_reasons':[getattr(c,'finish_reason',None) or 'unknown' for c in choices]}


def _http_request_trace(request):
    """OpenAI SDK retries also traverse these hooks; do not copy auth headers."""
    request.extensions['seismo_trace_id'] = uuid.uuid4().hex
    _trace_event('http_request_started',http_attempt_id=request.extensions['seismo_trace_id'],
                 method=request.method,endpoint=public_endpoint(str(request.url)))


def _http_response_trace(response):
    _trace_event('http_response_received',http_attempt_id=response.request.extensions.get('seismo_trace_id','unknown'),
                 status_code=response.status_code,request_id=response.headers.get('x-request-id','unknown'))


class DecisionLLM(Protocol):
    @property
    def model_name(self) -> str: ...

    def structured(self, messages: list[dict[str, str]], response_model: type[ModelT]) -> ModelT: ...

    def text(self, messages: list[dict[str, str]]) -> str: ...


def _extract_json(content: str) -> str:
    stripped = content.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        stripped = fenced.group(1).strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        return stripped
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start >= 0 and end > start:
        return stripped[start : end + 1]
    raise ValueError("LLM response does not contain a JSON object")


def _text_content(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for item in value:
        if isinstance(item, dict):
            text = item.get("text")
        else:
            text = getattr(item, "text", None)
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n".join(parts).strip()


def _merge_text(existing: str, continuation: str) -> str:
    left = existing.strip()
    right = continuation.strip()
    if not left:
        return right
    if not right or right in left:
        return left
    if right.startswith(left):
        return right
    overlap_limit = min(len(left), len(right), 1200)
    for size in range(overlap_limit, 0, -1):
        if left[-size:] == right[:size]:
            return f"{left}{right[size:]}".strip()
    return f"{left}\n\n{right}".strip()


def _strip_completion_marker(content: str) -> str:
    return content.replace(FOLLOW_UP_COMPLETION_MARKER, "").strip()


class DeepSeekDecisionLLM:
    def __init__(self, settings: AgentSettings) -> None:
        self._settings = settings
        self._client = OpenAI(
            api_key=settings.require_api_key(),
            base_url=settings.deepseek_base_url,
            timeout=settings.request_timeout_seconds,
            max_retries=2,
            http_client=httpx.Client(event_hooks={'request':[_http_request_trace], 'response':[_http_response_trace]}),
        )

    @property
    def model_name(self) -> str:
        return self._settings.deepseek_model

    def _safe_error(self, exc) -> str:
        return redact(str(exc), (self._settings.require_api_key(),))

    def _request(self, attempt: int, **request):
        started = time.monotonic()
        _trace_event('attempt_started', attempt=attempt, request=request,
            endpoint=public_endpoint(self._settings.deepseek_base_url),
            inference={'temperature':request.get('temperature','not_explicitly_set'),
                       'top_p':'not_explicitly_set','seed':'not_explicitly_set',
                       'max_tokens':request.get('max_tokens'),'timeout_seconds':self._settings.request_timeout_seconds,
                       'sdk_max_retries':2, 'sdk_internal_retry_visibility':'http request/response hooks; transport exceptions retained by request failure'})
        try:
            response = self._client.chat.completions.create(**request)
        except Exception as exc:
            _trace_event('attempt_request_failed',attempt=attempt,error_type=type(exc).__name__,message=str(exc),
                         request_id=getattr(exc,'request_id',None) or 'unknown',
                         duration_seconds=time.monotonic()-started)
            raise
        _trace_event('attempt_response_received',attempt=attempt,**_response_metadata(response),
            # Store returned final text; never archive hidden reasoning_content.
            content=[_text_content(getattr(getattr(c,'message',None),'content',None)) for c in (getattr(response,'choices',[]) or [])],
            duration_seconds=time.monotonic()-started)
        return response

    def structured(self, messages: list[dict[str, str]], response_model: type[ModelT]) -> ModelT:
        schema = response_model.model_json_schema(mode="validation")
        schema_instruction = {
            "role": "user",
            "content": (
                "仅返回一个JSON对象，不得使用Markdown代码块。JSON必须满足以下Schema：\n"
                + json.dumps(schema, ensure_ascii=False)
            ),
        }
        working_messages = [*messages, schema_instruction]
        last_error: Exception | None = None
        for attempt in range(1, self._settings.structured_response_attempts + 1):
            content = ""
            try:
                response = self._request(attempt,
                    model=self._settings.deepseek_model,
                    messages=working_messages,
                    response_format={"type": "json_object"},
                    temperature=0,
                    max_tokens=self._settings.max_output_tokens,
                )
                content = response.choices[0].message.content or ""
                if not content:
                    raise RuntimeError("DeepSeek returned an empty structured response")
                payload = json.loads(_extract_json(content))
                return response_model.model_validate(payload)
            except Exception as exc:
                _trace_event('attempt_validation_or_request_failed',attempt=attempt,
                             error_type=type(exc).__name__,message=str(exc))
                last_error = exc
                if attempt >= self._settings.structured_response_attempts:
                    break
                working_messages.extend(
                    [
                        {"role": "assistant", "content": content[:8000]},
                        {
                            "role": "user",
                            "content": (
                                "上一响应未通过JSON/Schema校验。请修正后仅返回完整JSON对象。"
                                f"校验错误：{type(exc).__name__}: {self._safe_error(exc)[:1200]}"
                            ),
                        },
                    ]
                )
        raise RuntimeError(
            f"DeepSeek structured response failed after "
            f"{self._settings.structured_response_attempts} attempts: {self._safe_error(last_error)}"
        ) from last_error

    def text(self, messages: list[dict[str, str]]) -> str:
        marker_required = any(
            FOLLOW_UP_COMPLETION_MARKER in str(message.get("content") or "")
            for message in messages
        )
        working_messages = [dict(message) for message in messages]
        combined = ""
        diagnostics: list[str] = []
        last_error: Exception | None = None

        for attempt in range(1, self._settings.text_response_attempts + 1):
            token_budget = min(
                self._settings.max_output_tokens * attempt,
                65536,
            )
            try:
                response = self._request(attempt,
                    model=self._settings.deepseek_model,
                    messages=working_messages,
                    temperature=0,
                    max_tokens=token_budget,
                )
                if not response.choices:
                    raise RuntimeError("DeepSeek returned no response choices")
                choice = response.choices[0]
                message = choice.message
                content = _text_content(getattr(message, "content", None))
                finish_reason = str(getattr(choice, "finish_reason", "") or "unknown")
                reasoning = _text_content(getattr(message, "reasoning_content", None))
                diagnostics.append(
                    f"attempt={attempt}, finish_reason={finish_reason}, "
                    f"content_chars={len(content)}, reasoning_chars={len(reasoning)}, "
                    f"max_tokens={token_budget}"
                )
                if content:
                    combined = _merge_text(combined, content)

                has_marker = FOLLOW_UP_COMPLETION_MARKER in combined
                was_truncated = finish_reason.lower() in {
                    "length",
                    "max_tokens",
                    "max_output_tokens",
                }
                if combined and not was_truncated and (has_marker or not marker_required):
                    return _strip_completion_marker(combined)

                _trace_event('attempt_incomplete',attempt=attempt,finish_reason=finish_reason,
                             completion_marker_present=has_marker,completion_marker_required=marker_required)

                if attempt >= self._settings.text_response_attempts:
                    break
                if content:
                    working_messages.extend(
                        [
                            {"role": "assistant", "content": content},
                            {
                                "role": "user",
                                "content": (
                                    "上一响应尚未完整结束。请从中断处继续，不要重复已有内容，"
                                    f"并在完整回答末尾单独输出{FOLLOW_UP_COMPLETION_MARKER}。"
                                ),
                            },
                        ]
                    )
                else:
                    working_messages.append(
                        {
                            "role": "user",
                            "content": (
                                "上一请求没有返回最终正文。请跳过内部推理展示，直接给出简洁、完整的最终回答，"
                                f"并在末尾单独输出{FOLLOW_UP_COMPLETION_MARKER}。"
                            ),
                        }
                    )
            except Exception as exc:
                _trace_event('attempt_validation_or_request_failed',attempt=attempt,
                             error_type=type(exc).__name__,message=str(exc))
                last_error = exc
                diagnostics.append(f"attempt={attempt}, error={type(exc).__name__}: {self._safe_error(exc)[:300]}")
                if attempt >= self._settings.text_response_attempts:
                    break

        detail = "; ".join(diagnostics)
        if combined:
            raise RuntimeError(
                "DeepSeek text response remained incomplete after "
                f"{self._settings.text_response_attempts} attempts ({detail})"
            ) from last_error
        raise RuntimeError(
            "DeepSeek returned no final text after "
            f"{self._settings.text_response_attempts} attempts ({detail})"
        ) from last_error
