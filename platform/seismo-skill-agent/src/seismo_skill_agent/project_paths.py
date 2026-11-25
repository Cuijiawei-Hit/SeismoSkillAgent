"""Locate external case inputs independently of source/editable/wheel installs."""
from __future__ import annotations

from dataclasses import dataclass
from copy import deepcopy
import os
from pathlib import Path


class WorkspaceConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class ProjectPaths:
    workspace_root: Path
    package_root: Path
    examples_root: Path


def project_paths(workspace_root: Path | str | None = None, *, validate=True, require_examples=False) -> ProjectPaths:
    configured = workspace_root if workspace_root is not None else os.getenv('POWER_WORKSPACE_ROOT')
    if configured is not None:
        if not str(configured).strip():
            raise WorkspaceConfigurationError('POWER_WORKSPACE_ROOT must name a nonempty project workspace directory')
        root = Path(configured).expanduser().resolve()
        package = root / 'seismo-skill-agent'
    else:
        # Preserve the existing source checkout layout. Installed wheels must use
        # an explicit external workspace; never guess a developer's H: checkout.
        package = Path(__file__).resolve().parents[2]
        root = package.parent
        if validate and not (package/'examples').is_dir():
            raise WorkspaceConfigurationError(
                'Installed runtime cannot locate external case examples. Set POWER_WORKSPACE_ROOT to the PowerSkillAgent workspace.')
    examples = package/'examples'
    if validate:
        if not root.is_dir():
            raise WorkspaceConfigurationError(f'POWER_WORKSPACE_ROOT directory does not exist: {root}')
        if not package.is_dir():
            raise WorkspaceConfigurationError(f'Workspace must contain a seismo-skill-agent directory: {root}')
        if require_examples and not examples.is_dir():
            raise WorkspaceConfigurationError(f'Workspace example directory does not exist: {examples}')
    return ProjectPaths(root,package,examples)


def absolute_data_paths(context: dict, package_root: Path) -> dict:
    """Preserve the existing preset-relative convention independently of cwd."""
    copied=deepcopy(context)
    source=copied.get('dataset_source')
    if not isinstance(source,dict):
        return copied
    def resolve(container,key):
        raw=container.get(key)
        if isinstance(raw,str) and raw:
            path=Path(raw)
            container[key]=str((path if path.is_absolute() else package_root/path).resolve())
    for name in ('path', 'fragility_path', 'criteria_path'):
        resolve(source,name)
    return copied
