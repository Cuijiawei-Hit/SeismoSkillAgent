from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field, SecretStr, field_validator
from .project_paths import project_paths, WorkspaceConfigurationError

_PROJECT_PATHS = project_paths(validate=False)
PACKAGE_ROOT = _PROJECT_PATHS.package_root
PROJECT_ROOT = _PROJECT_PATHS.workspace_root


class AgentConfigurationError(RuntimeError):
    pass


class AgentSettings(BaseModel):
    deepseek_api_key: SecretStr | None = Field(default=None, repr=False)
    deepseek_base_url: str = "https://api.deepseek.com/v1"
    deepseek_model: str = "deepseek-v4-pro"
    request_timeout_seconds: float = Field(default=120.0, gt=0, le=600)
    max_output_tokens: int = Field(default=8192, ge=256, le=65536)
    max_feedback_iterations: int = Field(default=5, ge=1, le=20)
    max_execution_attempts: int = Field(default=3, ge=1, le=10)
    structured_response_attempts: int = Field(default=2, ge=1, le=4)
    text_response_attempts: int = Field(default=3, ge=1, le=5)
    agent_run_root: Path = Path("agent-runs")
    skill_run_root: Path = Path("../engineering-skills/runs-agent")
    knowledge_root: Path = Path("../knowledge-base")
    knowledge_auto_build: bool = False
    workspace_root: Path | None = None

    @field_validator("deepseek_base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        normalized = value.rstrip("/")
        if not normalized.startswith("https://"):
            raise ValueError("DeepSeek base URL must use HTTPS")
        return normalized

    @classmethod
    def from_env(cls, require_api_key: bool = True) -> "AgentSettings":
        key = os.getenv("DEEPSEEK_API_KEY")
        if require_api_key and not key:
            raise AgentConfigurationError(
                "DEEPSEEK_API_KEY is not set. Configure it in the shell environment; do not store it in files."
            )
        try:
            paths = project_paths()
        except WorkspaceConfigurationError as exc:
            raise AgentConfigurationError(str(exc)) from exc
        return cls(
            workspace_root=paths.workspace_root,
            deepseek_api_key=SecretStr(key) if key else None,
            deepseek_base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
            deepseek_model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-pro"),
            request_timeout_seconds=float(os.getenv("DEEPSEEK_TIMEOUT_SECONDS", "120")),
            max_output_tokens=int(os.getenv("DEEPSEEK_MAX_OUTPUT_TOKENS", "8192")),
            max_feedback_iterations=int(os.getenv("POWER_MAX_FEEDBACK_ITERATIONS", "5")),
            max_execution_attempts=int(os.getenv("POWER_MAX_EXECUTION_ATTEMPTS", "3")),
            structured_response_attempts=int(
                os.getenv("POWER_STRUCTURED_RESPONSE_ATTEMPTS", "2")
            ),
            text_response_attempts=int(os.getenv("POWER_TEXT_RESPONSE_ATTEMPTS", "3")),
            agent_run_root=Path(os.getenv("POWER_AGENT_RUN_ROOT", str(paths.workspace_root / "runtime" / "agent-runs"))),
            skill_run_root=Path(
                os.getenv("POWER_SKILL_RUN_ROOT", str(paths.workspace_root / "runtime" / "skill-runs"))
            ),
            knowledge_root=Path(os.getenv("POWER_KNOWLEDGE_ROOT", str(paths.workspace_root / "knowledge-base"))),
            knowledge_auto_build=os.getenv("POWER_KNOWLEDGE_AUTO_BUILD", "false").lower()
            in {"1", "true", "yes", "on"},
        )

    def require_api_key(self) -> str:
        if self.deepseek_api_key is None:
            raise AgentConfigurationError("DEEPSEEK_API_KEY is required for a live LLM call")
        return self.deepseek_api_key.get_secret_value()
