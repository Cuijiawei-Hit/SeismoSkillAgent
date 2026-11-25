from __future__ import annotations

from pathlib import Path
from typing import Any

from .artifacts import hash_payload, sha256_file


def execution_fingerprint(skill_id: str, request: dict[str, Any]) -> str:
    root = Path(__file__).resolve().parents[1]
    code = {str(path.relative_to(root)): sha256_file(path)
            for pattern in ("*.py", "*.yaml") for path in sorted(root.rglob(pattern))
            if "__pycache__" not in path.parts}

    def canonical(value: Any, key: str = "") -> Any:
        if isinstance(value, dict):
            if "path" in value and "media_type" in value:
                path = Path(value["path"])
                return {"media_type": value["media_type"], "sha256": sha256_file(path)}
            return {name: canonical(item, name) for name, item in value.items()}
        if isinstance(value, list):
            return [canonical(item, key) for item in value]
        if isinstance(value, str) and (key == "path" or key.endswith("_path")):
            path = Path(value)
            if path.is_file():
                return {"source_path": str(path.resolve()), "sha256": sha256_file(path)}
            if path.is_dir():
                return {"source_path": str(path.resolve()), "files": {
                    str(item.relative_to(path)): sha256_file(item) for item in sorted(path.rglob("*"))
                    if item.is_file() and item.suffix.lower() in {".xlsx", ".xls", ".json", ".npz", ".csv"}
                }}
        return value

    return hash_payload({"component": skill_id, "code": code, "request": canonical(request)})
