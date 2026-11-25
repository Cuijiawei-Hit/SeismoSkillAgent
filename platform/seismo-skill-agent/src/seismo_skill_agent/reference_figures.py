"""Repaint a selected saved power result with the ResCity renderer and bilingual labels.

No engine, model account, workbook, city source or numerical run is opened here.
The input is SessionManager.session_view(); only the chosen round's immutable
summary is projected. Presentation files live in a separate content-addressed
cache and never replace the saved engineering artifacts.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
from hashlib import sha256
import json
import math
from pathlib import Path
import re
import threading
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

from . import publication_figures


CACHE_VERSION = "rescity-recorded-power-figures-v2-language"
RENDERER_SHA256 = sha256(Path(publication_figures.__file__).read_bytes()).hexdigest()
FORMATS = {"png", "svg", "pdf"}
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,180}$")
_LOCK = threading.RLock()
_STATES = {"1": "基本完好", "2": "轻微破坏", "3": "中等破坏", "4": "严重破坏", "5": "完全破坏"}
_STRATEGIES = {"id_order": "编号顺序基准", "importance": "系统功能增益排序", "ga": "遗传算法搜索"}
_STATES_EN = {"1": "Undamaged", "2": "Slight damage", "3": "Moderate damage", "4": "Extensive damage", "5": "Complete damage"}
_STRATEGIES_EN = {"id_order": "ID-order baseline", "importance": "Function-gain order", "ga": "Genetic algorithm"}


def _language(view):
    return "en-US" if str(view.get("display_language") or view.get("output_language") or "zh-CN").startswith("en") else "zh-CN"


def _rows(value):
    return value if isinstance(value, list) else []


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _round(view: dict, iteration: int | None):
    number = view.get("iteration", 1) if iteration is None else iteration
    if isinstance(number, bool) or not re.fullmatch(r"[1-9][0-9]*", str(number)):
        raise ValueError("A positive saved iteration is required")
    number = int(number)
    rounds = _rows(view.get("iterations"))
    selected = next((row for row in rounds if row.get("iteration") == number), None)
    if selected is None:
        # Old compact views may have only the top-level completed result.
        if rounds or int(view.get("iteration", 1)) != number:
            raise KeyError("The requested saved result iteration does not exist")
        selected = {"iteration": number, "report_summary": view.get("report_summary"),
                    "run_id": (view.get("skill_result") or {}).get("run_id"),
                    "result_delivery": view.get("result_delivery")}
    summary = selected.get("report_summary")
    if not isinstance(summary, dict) or not summary:
        raise KeyError("The chosen iteration has no saved engineering summary")
    if summary.get("target_system") != "power_system":
        raise ValueError("Reference power figures require a saved power-system result")
    return number, selected, summary


def charts(view: dict, iteration: int | None = None) -> list[dict]:
    """Project exactly the six chart types used by reference-results.js.

    Event curves receive their explicit horizontal-before-vertical step points,
    matching the original engineering_recovery_views presentation projection.
    This adds no time samples or numerical values: each y is a saved event y.
    """
    _, _, summary = _round(view, iteration)
    english = _language(view) == "en-US"
    def t(zh, en):
        return en if english else zh
    damage, power = summary.get("damage") or {}, summary.get("function") or {}
    output = []
    for group, label in (("nodes", "节点"), ("branches", "支路")):
        values = _rows(damage.get(group))
        if not values:
            continue
        counts = Counter(json.dumps(row.get("state"), ensure_ascii=False, sort_keys=True) for row in values)
        def order(key):
            state = json.loads(key)
            return (0, float(state)) if _finite(state) else (1, str(state))
        points = []
        for key in sorted(counts, key=order):
            state = json.loads(key)
            state_key = str(int(state)) if _finite(state) and float(state).is_integer() else str(state)
            points.append({"x": (_STATES_EN if english else _STATES).get(state_key, t("未记录", "Not recorded") if state is None else str(state)), "y": counts[key]})
        english_label = "Node" if group == "nodes" else "Branch"
        output.append({"id": "power-damage-" + group, "title": t(label + "损伤状态分布", english_label + " damage-state distribution"), "kind": "bar",
            "points": points, "x_label": t("本轮保存的原模型损伤状态", "Saved model damage state"), "y_label": t(label + "数量（个）", english_label + " count"),
            "source": "power_system.damage_assessment",
            "note": t("按本轮保存的组件状态分组计数；原始状态码、组件功能及对象编号保留在明细中。", "Counts use saved component damage states. Original state codes, functionality and asset IDs are available in the details.")})
    supply = [{"x": label, "y": power.get(key)} for key, label in
              (("pre_supply_mw", t("震前供电", "Pre-earthquake supply")), ("post_supply_mw", t("震后供电", "Post-earthquake supply"))) if _finite(power.get(key))]
    if supply:
        output.append({"id": "power-supply", "title": t("震前与震后供电功率", "Pre- and post-earthquake power supply"), "kind": "bar", "points": supply,
            "x_label": t("保存情景", "Saved scenario"), "y_label": t("供电功率（MW）", "Power supply (MW)"), "source": "power_system.function_assessment",
            "note": t("MW为保存的供电功率；原模型为稀疏直流供电评估，不能替代实际运行调度。", "Power supply is recorded in MW using the sparse DC model.")})
    for strategy in _rows((summary.get("recovery") or {}).get("strategies")):
        curve = _rows(strategy.get("curve"))
        if not curve:
            continue
        strategy_id = str(strategy.get("id", ""))
        if not _SAFE_ID.fullmatch(strategy_id) or len(strategy_id) > 80:
            raise ValueError("Saved strategy identifier is not valid for a figure")
        raw = [{"x": row.get("time", row.get("time_day")),
                "y": row.get("function", row.get("function_ratio"))} for row in curve]
        if not all(_finite(point["x"]) and _finite(point["y"]) for point in raw):
            # Do not bridge an unknown part of a curve or invent a missing value.
            continue
        points = []
        for index, point in enumerate(raw):
            if index:
                points.append({"x": point["x"], "y": raw[index - 1]["y"]})
            points.append(dict(point))
        name = _STRATEGIES_EN.get(strategy_id, strategy.get("name") or strategy_id) if english else strategy.get("name") or _STRATEGIES.get(strategy_id, strategy_id)
        output.append({"id": "power-recovery-" + strategy_id, "title": str(name) + t(" · 有限队伍恢复曲线", " · Limited-crew recovery curve"),
            "kind": "line", "points": points, "x_label": t("震后时间（天）", "Time after earthquake (days)"), "y_label": t("相对震前供电功能", "Supply relative to the pre-earthquake baseline"),
            "source": "power_system.recovery_optimization",
            "note": t("本轮已批准资源下逐事件回算；阶梯点对应保存时刻，不插值。目标达标、全部完工和累计功能损失分别比较，搜索结果不等于全局最优。", "Step points follow saved repair events and approved crew resources. Target recovery, completion time and cumulative function loss are reported separately.")})
    if english:
        for chart in output:
            chart["language"] = "en-US"
    return output


def _identity(view, iteration):
    number, selected, summary = _round(view, iteration)
    projected = charts(view, number)
    binding = {"cache_version": CACHE_VERSION, "renderer_sha256": RENDERER_SHA256,
        "session_id": view.get("session_id"), "iteration": number, "run_id": selected.get("run_id"),
        "dataset_fingerprint": summary.get("dataset_fingerprint"), "language": _language(view), "charts": projected}
    key = sha256(json.dumps(binding, sort_keys=True, ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
    return key, binding


def _inside(root: Path, child: Path) -> Path:
    resolved = child.resolve()
    if not resolved.is_relative_to(root):
        raise PermissionError("Reference figure cache path leaves its presentation directory")
    return resolved


def _valid_cache(folder, key):
    path = _inside(folder, folder / "manifest.json")
    if not path.is_file():
        return None
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if cached.get("revision") != key or cached.get("cache_version") != CACHE_VERSION:
            return None
        for entry in cached["figures"]:
            if not _SAFE_ID.fullmatch(entry["figure_id"]):
                return None
            for fmt in FORMATS:
                record = entry["files"][fmt]
                file = _inside(folder, folder / record["name"])
                if not file.is_file() or sha256(file.read_bytes()).hexdigest() != record["sha256"]:
                    return None
        return cached
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _cached(view, iteration, cache_root):
    key, binding = _identity(view, iteration)
    root = Path(cache_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    folder = _inside(root, root / key)
    with _LOCK:
        folder.mkdir(exist_ok=True)
        cached = _valid_cache(folder, key)
        if cached is not None:
            return folder, cached
        figures = []
        for chart in binding["charts"]:
            entry = publication_figures.render_engineering_figure(chart, folder)
            filenames = entry.pop("filenames")
            entry["chart_id"] = chart["id"]
            entry["files"] = {}
            for fmt in sorted(FORMATS):
                file = _inside(folder, folder / filenames[fmt])
                entry["files"][fmt] = {"name": file.name, "sha256": sha256(file.read_bytes()).hexdigest()}
            figures.append(entry)
        cached = {"cache_version": CACHE_VERSION, "revision": key, "session_id": binding["session_id"],
            "iteration": binding["iteration"], "source_run_id": binding["run_id"],
            "language": binding["language"],
            "dataset_fingerprint": binding["dataset_fingerprint"], "renderer_sha256": RENDERER_SHA256,
            "figures": figures}
        temporary = _inside(folder, folder / ("manifest-" + uuid4().hex + ".tmp"))
        temporary.write_text(json.dumps(cached, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        temporary.replace(_inside(folder, folder / "manifest.json"))
        return folder, cached


def manifest(view: dict, iteration: int | None, cache_root: Path | str, base_url: str) -> dict:
    """Return a PublicationGallery manifest using same-origin, round-bound URLs."""
    parsed = urlsplit(base_url)
    if (parsed.scheme or parsed.netloc or not parsed.path.startswith("/") or parsed.query or parsed.fragment
            or "\\" in base_url or re.search(r"[\x00-\x20]", base_url)):
        raise ValueError("The figure base URL must be a same-origin absolute path")
    _, cached = _cached(view, iteration, cache_root)
    query = urlencode({"iteration": cached["iteration"], "revision": cached["revision"], "language": cached["language"]})
    figures = []
    for item in cached["figures"]:
        entry = {key: deepcopy(value) for key, value in item.items() if key != "files"}
        entry["formats"] = {fmt: base_url.rstrip("/") + "/" + item["figure_id"] + "." + fmt + "?" + query for fmt in sorted(FORMATS)}
        figures.append(entry)
    return {"schema_version": "power.reference-figures.v1", "template_version": publication_figures.TEMPLATE_VERSION,
        "session_id": cached["session_id"], "iteration": cached["iteration"], "source_run_id": cached["source_run_id"],
        "result_revision": cached["revision"], "figures": figures,
        "provenance": {"renderer_sha256": RENDERER_SHA256, "source": "selected_saved_report_summary",
                       "engineering_recomputed": False}}


def artifact(view: dict, iteration: int | None, figure_id: str, fmt: str, cache_root: Path | str,
             revision: str | None = None) -> Path:
    """Locate only a registered format from this selected immutable presentation."""
    if not isinstance(figure_id, str) or not _SAFE_ID.fullmatch(figure_id) or fmt not in FORMATS:
        raise ValueError("Unsupported reference figure or format")
    folder, cached = _cached(view, iteration, cache_root)
    if revision is not None and revision != cached["revision"]:
        raise KeyError("This figure URL belongs to a different saved presentation")
    entry = next((item for item in cached["figures"] if item["figure_id"] == figure_id), None)
    if entry is None:
        raise KeyError("The requested figure is not part of the selected saved result")
    return _inside(folder, folder / entry["files"][fmt]["name"])
