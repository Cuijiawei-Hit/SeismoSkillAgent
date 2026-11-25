"""Read the bundled Auckland example without a model account or a workflow run."""
from copy import deepcopy
import json
from pathlib import Path
import re

SESSION_ID = "demo-auckland"


class BuiltinDemo:
    def __init__(self, workspace: Path):
        if workspace is None:
            from .project_paths import project_paths
            workspace = project_paths(validate=False).workspace_root
        self.root = Path(workspace) / "seismo-skill-agent" / "demo" / "auckland"

    @property
    def available(self):
        return (self.root / "session.en.json").is_file() and (self.root / "scene.json").is_file()

    def view(self, language=None):
        filename = "session.zh.json" if language == "zh-CN" else "session.en.json"
        path = self.root / filename
        if not self.available or not path.is_file():
            raise KeyError("The bundled Auckland example is not installed")
        return json.loads(path.read_text(encoding="utf-8"))

    def listing(self, language=None):
        view = self.view(language)
        return {key: deepcopy(view[key]) for key in
                ("session_id", "user_message", "preset_id", "output_language", "status", "created_at", "updated_at", "is_demo")}

    def scene(self, iteration=None):
        if iteration not in (None, 1):
            raise KeyError("The example contains one saved calculation round")
        if not self.available:
            raise KeyError("The bundled Auckland example is not installed")
        return json.loads((self.root / "scene.json").read_text(encoding="utf-8"))

    def artifact(self, name):
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name.startswith('.'):
            raise ValueError("Invalid example asset name")
        path = (self.root / name).resolve()
        if not path.is_relative_to(self.root.resolve()) or not path.is_file():
            raise KeyError("Example asset not found")
        return path
