from __future__ import annotations

from functools import lru_cache

from .core.registry import SkillRegistry


def create_registry(*, instance_store=None) -> SkillRegistry:
    """Create an independent registry; optional persistence is scoped by its caller."""
    registry = SkillRegistry(instance_store=instance_store)
    from .power.executor import skill_types as builtin_types
    from .power.executor import builtins

    for skill_type in builtin_types():
        registry.register_type(skill_type)
    for skill in builtins():
        registry.register(skill)
    return registry


@lru_cache(maxsize=1)
def get_registry() -> SkillRegistry:
    """Compatibility: process-wide, in-memory registry populated with built-in Skills."""
    return create_registry()
