from __future__ import annotations

from pathlib import Path

from engineering_skills.core.manifest import load_skill_type
from engineering_skills.core.models import SkillTypeDefinition


def builtins() -> list[SkillTypeDefinition]:
    root = Path(__file__).parent
    return [load_skill_type(path) for path in sorted(root.glob("*.yaml"))]


__all__ = ["builtins"]
