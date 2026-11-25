from __future__ import annotations

import json
from pathlib import Path

from .models import SkillManifest, SkillTypeDefinition


def _load_yaml_or_json(path: Path) -> object:
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore

        return yaml.safe_load(text)
    except ModuleNotFoundError:
        # JSON is valid YAML 1.2, allowing the core runtime to work without PyYAML.
        return json.loads(text)


def load_manifest(path: Path) -> SkillManifest:
    return SkillManifest.model_validate(_load_yaml_or_json(path))


def load_skill_type(path: Path) -> SkillTypeDefinition:
    return SkillTypeDefinition.model_validate(_load_yaml_or_json(path))
