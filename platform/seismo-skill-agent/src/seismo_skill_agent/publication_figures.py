"""Reusable publication figures drawn solely from the delivered result bundle.

No solver, arbitrary artifact path, city draft or external source is read here.
Figure templates preserve zero values, withhold missing values, keep scenarios
separate, and paginate complete hospital/demand-node lists without truncation.
"""
from __future__ import annotations

from contextvars import ContextVar
import hashlib
import math
from pathlib import Path
import threading
from typing import Any

import matplotlib
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure
from matplotlib.text import Text
from matplotlib import colors as mcolors, font_manager, ticker
import numpy as np

TEMPLATE_VERSION = "healthcare-publication-20260908-v3"
PLOT_LOCK = threading.RLock()
_TEAL, _BLUE, _GREEN, _ORANGE = "#187f7b", "#315f79", "#4c8768", "#de7e24"
_INK, _MUTED, _GRID = "#1d3039", "#43525c", "#e1e6e8"
_COLORS = (_TEAL, _BLUE, _GREEN, _ORANGE)
_NODE_PAGE = 18
_HOSPITAL_PAGE = 12
_SCOPE: ContextVar[str] = ContextVar("publication_figure_scope", default="")


def _tr(en: bool, zh: str, english: str) -> str:
    return english if en else zh


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, np.number)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _value(row: dict, *keys: str) -> float | None:
    for key in keys:
        value = _number(row.get(key))
        if value is not None:
            return value
    return None


def _fmt(value: Any, *, percent=False) -> str:
    value = _number(value)
    if value is None:
        return "—"
    if percent:
        return f"{value:.1%}"
    if value == 0:
        return "0"
    if abs(value) < .01:
        return f"{value:.2g}"
    if abs(value) >= 1000:
        return f"{value:,.0f}"
    return f"{value:.3g}"


def _sid(row: dict) -> str:
    return str(row.get("scenario_id", row.get("scenario", "")))


def _pages(rows: list, size: int):
    for offset in range(0, len(rows), size):
        yield offset // size + 1, math.ceil(len(rows) / size), rows[offset:offset+size]


def _wrap(value: Any, width=19) -> str:
    # Chinese characters are wider; wrapping is based on approximate display
    # columns rather than truncation or changing the supplied hospital name.
    chunks, line, length = [], "", 0
    for char in str(value):
        units = 2 if ord(char) > 255 else 1
        if char == "\n" or (length + units > width and line):
            chunks.append(line)
            line, length = "", 0
        if char != "\n":
            line += char
            length += units
    if line:
        chunks.append(line)
    return "\n".join(chunks)


def _labels(rows: list[dict], names: dict[str, str], *, hospitals=True) -> list[str]:
    labels = []
    for row in rows:
        identifier = str(row.get("hospital_id", row.get("hospital", ""))) if hospitals else str(row.get("node_id", ""))
        name = str(row.get("hospital_name") or names.get(identifier) or identifier) if hospitals else identifier
        label = name if name.startswith(identifier) else f"{identifier}  {name}"
        labels.append(_wrap(label, 27))
    return labels


def _positions(labels: list[str]) -> tuple[np.ndarray, float]:
    heights = [max(1.0, .56 * (label.count("\n") + 1)) for label in labels]
    positions = np.cumsum(heights) - np.array(heights) / 2
    return positions, max(3.6, sum(heights) * .43 + 2.25)


def _figure(title: str, subtitle: str, caption: str, *, panels=2, height=6.3, width=13.2, left=.25, ratios=None):
    figure = Figure(figsize=(width, height), facecolor="white")
    FigureCanvasAgg(figure)
    axes = np.atleast_1d(figure.subplots(1, panels, gridspec_kw={"width_ratios": ratios} if ratios else None))
    figure.subplots_adjust(left=left, right=.965, top=1-1.35/height, bottom=1.05/height, wspace=.35)
    figure.text(.045, 1-.16/height, title, fontsize=18, color=_INK, va="top")
    figure.text(.046, 1-.55/height, subtitle, fontsize=10, color=_MUTED, va="top")
    figure.text(.046, .52/height, _wrap(caption, int(width*11)), fontsize=9.5, color=_MUTED, va="top", linespacing=1.4)
    for axis in axes:
        axis.set_facecolor("white")
        axis.tick_params(axis="both", labelsize=9, length=3, width=.6, colors=_INK)
        axis.spines[["top", "right"]].set_visible(False)
        for side in ("bottom", "left"):
            axis.spines[side].set_color("#9ba8ad")
            axis.spines[side].set_linewidth(.6)
        axis.set_axisbelow(True)
        axis.grid(axis="x", color=_GRID, linewidth=.6)
    return figure, axes


def _panel(axis, letter: str, title: str, xlabel: str):
    axis.set_title(f"({letter})  {title}", loc="left", fontsize=11.3, pad=17, color=_INK)
    axis.set_xlabel(xlabel, fontsize=9.4, labelpad=10, color=_INK)


def _row_axis(axis, positions: np.ndarray, labels: list[str] | None):
    axis.set_yticks(positions, labels if labels is not None else [""] * len(positions))
    axis.set_ylim(float(positions[-1]) + .7 if len(positions) else 1, -.3)
    axis.tick_params(axis="y", length=0, pad=9)


def _barh(axis, positions, values, *, color=_TEAL, percent=False, offset=0., height=.42, label=None, decimals=None):
    numeric = [(float(y) + offset, _number(value)) for y, value in zip(positions, values)]
    valid = [(y, value) for y, value in numeric if value is not None]
    if valid:
        axis.barh([v[0] for v in valid], [v[1] for v in valid], height=height, color=color, linewidth=0, label=label)
        max_value = max(abs(v[1]) for v in valid)
        pad = max(max_value * .025, .01 if percent else .000001)
        for y, value in valid:
            rendered = f"{value:.{decimals}f}" if decimals is not None else _fmt(value, percent=percent)
            axis.text(value + pad, y, rendered, va="center", fontsize=9.5, color=_INK)
        axis.set_xlim(0, max(max_value * 1.18, 1.08) if percent else max_value * 1.28 if max_value > 0 else 1)
    else:
        axis.set_xlim(0, 1)
    for y, value in numeric:
        if value is None:
            axis.text(.015, y, "—", transform=axis.get_yaxis_transform(), va="center", color=_MUTED, fontsize=9)
    if percent:
        axis.xaxis.set_major_formatter(ticker.PercentFormatter(xmax=1, decimals=0))


def _comparison(axis, positions, baseline, post, en: bool, *, prelabel=None, postlabel=None):
    _barh(axis, positions, baseline, color=_BLUE, offset=-.19, height=.30, label=prelabel or _tr(en, "基准", "Reference"))
    _barh(axis, positions, post, color=_TEAL, offset=.19, height=.30, label=postlabel or _tr(en, "震后均值", "Post-event mean"))
    values = [_number(value) for value in [*baseline, *post]]
    maximum = max([v for v in values if v is not None] or [1])
    axis.set_xlim(0, max(1e-8, maximum * 1.3) if maximum > 0 else 1)
    handles, labels = axis.get_legend_handles_labels()
    if handles:
        axis.legend(handles, labels, frameon=False, loc="lower right", bbox_to_anchor=(1.02, 1.01), fontsize=8, ncol=2, columnspacing=1.0)


def _tables(sections: list[dict], skill_id: str) -> dict[str, list]:
    result = {}
    for section in sections:
        if section.get("skill_id") == skill_id:
            for table in section.get("tables", []):
                result.setdefault(table.get("table_id", ""), []).extend(table.get("rows", []))
    return result


def _save(figure: Figure, directory: Path, *, template_id: str, title: str, caption: str, scenario_id: str, source_skill_id: str,
          page=1, page_count=1, variant="", status="available") -> dict:
    identity = f"{template_id}|{scenario_id}|{variant}"
    suffix = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
    figure_id = f"{template_id}-{suffix}-p{page:02d}"
    # Keep bars physically slender even in panels containing only one or two
    # values. Changing the chart height must not enlarge bars into solid blocks.
    for axis in figure.axes:
        panel_inches = figure.get_figheight() * axis.get_position().height
        span = abs(axis.get_ylim()[1] - axis.get_ylim()[0])
        limit = .18 * span / panel_inches if panel_inches else 0
        for bar in axis.patches:
            if not hasattr(bar, "get_height") or not hasattr(bar, "set_height"):
                continue
            height = bar.get_height()
            if abs(height) > limit > 0:
                middle = bar.get_y() + height/2
                height = math.copysign(limit, height)
                bar.set_height(height)
                bar.set_y(middle-height/2)
    for label in figure.findobj(Text):
        label.set_fontweight("bold")
        label.set_fontsize(max(9.5, label.get_fontsize()))
    filenames = {}
    for extension in ("png", "svg", "pdf"):
        filename = f"{figure_id}.{extension}"
        options = {"dpi": 300, "facecolor": "white"}
        figure.savefig(directory / filename, format=extension, **options)
        filenames[extension] = filename
    figure.clear()
    return {"figure_id": figure_id, "template_id": template_id, "title": title, "caption": caption, "scenario_id": scenario_id,
            "source_skill_id": source_skill_id, "page": page, "page_count": page_count, "filenames": filenames, "status": status}


def _sub(scenario: str, page=1, count=1, en=False):
    scope = _SCOPE.get()
    prefix = f"{scope}  ·  " if scope else ""
    return prefix + _tr(en, f"情景 {scenario}  ·  第 {page} / {count} 页", f"Scenario {scenario}  ·  Page {page} / {count}")


def _map_labels(figure, axis, hospitals):
    """Keep coordinate positions fixed; move only overlapping text labels."""
    if len(hospitals) > 70:
        return  # All points stay plotted; names remain in the paginated tables.
    figure.canvas.draw()
    renderer = figure.canvas.get_renderer()
    boxes = []
    for hospital in hospitals:
        annotation = axis.annotate(str(hospital["hospital_id"]), (hospital["longitude"], hospital["latitude"]), xytext=(8, 8),
                                   textcoords="offset points", fontsize=9.5, color=_INK, arrowprops={"arrowstyle": "-", "color": _MUTED, "linewidth": .45})
        for offset in ((8, 8), (8, -15), (-29, 8), (-29, -15), (18, 23), (18, -28), (-39, 23), (-39, -28)):
            annotation.set_position(offset)
            annotation.update_positions(renderer)
            box = Text.get_window_extent(annotation, renderer).expanded(1.03, 1.05)
            if not any(box.overlaps(other) for other in boxes):
                break
        boxes.append(box)


def _damage_figures(sections, names, directory, en):
    rows = _tables(sections, "hospital_damage_assessment").get("damage", [])
    records = []
    for scenario in dict.fromkeys(_sid(r) for r in rows):
        selected = [r for r in rows if _sid(r) == scenario]
        for page, count, chunk in _pages(selected, _HOSPITAL_PAGE):
            labels = _labels(chunk, names)
            y, height = _positions(labels)
            title = _tr(en, "医院结构损伤与修复时间", "Hospital structural damage and repair time")
            caption = _tr(en, "损伤等级来自本次结构计算；修复时间为模拟样本均值，不代表施工承诺。缺失值留空，零值如实保留。", "Damage labels come from the structural calculation. Repair times are simulation means, not committed construction durations. Missing values remain blank and zeros are retained.")
            dynamic = any("probability_any_damage" in row for row in chunk)
            if dynamic:
                caption = _tr(en, "动态PGA参考筛查；(a) 至少轻微损伤的概率，标签为最可能等级；(b) 修复时间为模拟样本均值。该模型不计算层间位移角。", "Dynamic PGA screening: (a) probability of at least slight damage, labeled by the most likely state; (b) mean simulated repair time. Interstory drift is not computed.")
            fig, axes = _figure(title, _sub(scenario, page, count, en), caption, height=height)
            _panel(axes[0], "a", _tr(en, "结构损伤概率" if dynamic else "结构响应与损伤", "Structural damage probability" if dynamic else "Structural response and damage"), _tr(en, "发生损伤概率" if dynamic else "最大层间位移角 IDR", "Probability of damage" if dynamic else "Maximum interstory drift ratio"))
            _barh(axes[0], y, [_value(r, "probability_any_damage" if dynamic else "max_idr") for r in chunk], color=_BLUE, percent=dynamic)
            axes[0].set_xlim(0, axes[0].get_xlim()[1] * 1.25)
            if dynamic:
                # Keep room for state labels, but do not imply probability >100%.
                axes[0].set_xticks([0, .25, .5, .75, 1])
            for yi, row in zip(y, chunk):
                label = str(row.get("damage_state", row.get("modal_damage_label", "")))
                if en:
                    label = {"完好": "Undamaged", "轻微": "Slight", "中等": "Moderate", "严重": "Severe", "毁坏": "Complete"}.get(label, label)
                axes[0].text(.98, yi, label, transform=axes[0].get_yaxis_transform(), ha="right", va="center", fontsize=8, color=_MUTED)
            _panel(axes[1], "b", _tr(en, "平均修复时间", "Mean repair time"), _tr(en, "天", "Days"))
            _barh(axes[1], y, [_value(r, "mean_repair_days", "mean_repair_time_days") for r in chunk], color=_ORANGE, decimals=2)
            for i, axis in enumerate(axes):
                _row_axis(axis, y, labels if i == 0 else None)
            records.append(_save(fig, directory, template_id="hospital-damage-repair", title=title, caption=caption, scenario_id=scenario, source_skill_id="hospital_damage_assessment", page=page, page_count=count))
    return records


def _hospital_figures(sections, service, names, directory, en):
    records = []
    function_rows = _tables(sections, "hospital_function_degradation").get("hospital_function", [])
    scenarios = service.get("scenarios", [])
    scenario_map = {s["scenario_id"]: s for s in scenarios}
    for sid in dict.fromkeys([*scenario_map, *(_sid(r) for r in function_rows)]):
        original = [r for r in function_rows if _sid(r) == sid]
        ratios = {str(r.get("hospital", r.get("hospital_id", ""))): _value(r, "function_ratio", "mean_function_ratio") for r in original}
        hospitals = scenario_map.get(sid, {}).get("hospitals", []) or [dict(r, hospital_id=r.get("hospital", r.get("hospital_id")), weighted_pre_capacity=r.get("weighted_pre", r.get("weighted_pre_capacity")), weighted_post_capacity=r.get("weighted_post", r.get("weighted_post_capacity"))) for r in original]
        for page, count, chunk in _pages(hospitals, _HOSPITAL_PAGE):
            labels = _labels(chunk, names)
            y, height = _positions(labels)
            title = _tr(en, "医院功能与救治能力", "Hospital function and treatment capability")
            caption = _tr(en, "(a) 内核逐样本截断后取平均的功能比；(b) 72小时加权模型能力，不等同于实际收治人数。", "(a) Kernel function ratio: per-sample clipping followed by averaging. (b) Weighted 72-hour modeled capability, not actual patient admissions.")
            fig, axes = _figure(title, _sub(sid, page, count, en), caption, height=height)
            _panel(axes[0], "a", _tr(en, "平均功能保留", "Mean function retained"), _tr(en, "内核平均功能比", "Kernel mean function ratio"))
            _barh(axes[0], y, [ratios.get(str(h["hospital_id"])) for h in chunk], color=_GREEN, percent=True)
            _panel(axes[1], "b", _tr(en, "72小时加权能力", "72-hour weighted capability"), _tr(en, "模型能力指标", "Modeled capability index"))
            _comparison(axes[1], y, [h.get("weighted_pre_capacity") for h in chunk], [h.get("weighted_post_capacity") for h in chunk], en,
                        prelabel=_tr(en, "震前", "Pre-event"))
            for i, axis in enumerate(axes):
                _row_axis(axis, y, labels if i == 0 else None)
            records.append(_save(fig, directory, template_id="hospital-function-capacity", title=title, caption=caption, scenario_id=sid, source_skill_id="hospital_function_degradation", page=page, page_count=count))
        if any(h.get("capacity_by_severity") for h in hospitals):
            records.extend(_severity_figures(sid, hospitals, names, directory, en))
    return records


def _severity_figures(scenario, hospitals, names, directory, en):
    records = []
    for page, count, chunk in _pages(hospitals, _HOSPITAL_PAGE):
        labels = _labels(chunk, names)
        y, height = _positions(labels)
        title = _tr(en, "分伤情救治能力", "Treatment capability by injury severity")
        caption = _tr(en, "分别按三类伤情计算72小时模型能力。三类共享相同医疗资源，不可相加为实际收治总人数。", "72-hour modeled capability is calculated separately for each injury severity. These categories share the same resources and cannot be added into a total admission count.")
        fig, axes = _figure(title, _sub(scenario, page, count, en), caption, panels=3, height=height, width=15.2, left=.235)
        for k, (key, zh, english) in enumerate((("minor", "轻伤", "Minor"), ("moderate", "中伤", "Moderate"), ("severe", "重伤", "Severe"))):
            values = [next((s for s in h.get("capacity_by_severity", []) if s.get("severity") == key), {}) for h in chunk]
            _panel(axes[k], chr(97+k), _tr(en, zh, english), _tr(en, "72小时模型人数", "Modeled patients over 72 h"))
            _comparison(axes[k], y, [v.get("pre_capacity_72h") for v in values], [v.get("post_capacity_72h") for v in values], en,
                        prelabel=_tr(en, "震前", "Pre-event"))
            _row_axis(axes[k], y, labels if k == 0 else None)
        records.append(_save(fig, directory, template_id="severity-capacity", title=title, caption=caption, scenario_id=scenario, source_skill_id="hospital_function_degradation", page=page, page_count=count))
    return records


def _regional_figures(sections, service, directory, en):
    rows = _tables(sections, "medical_system_function").get("system_function", [])
    scenario_map = {s["scenario_id"]: s for s in service.get("scenarios", [])}
    records = []
    for sid in dict.fromkeys([*scenario_map, *(_sid(r) for r in rows)]):
        summary = scenario_map.get(sid, {}).get("summary", {})
        original = next((r for r in rows if _sid(r) == sid), {})
        system = _value(original, "function_ratio", "recovery_accessibility_function")
        if system is None:
            system = _value(summary, "system_function_ratio")
        if system is None and not summary:
            continue
        title = _tr(en, "区域医疗系统功能与服务覆盖", "Regional function and travel coverage")
        caption = _tr(en, "系统功能比采用内核逐样本截断均值；通行覆盖仅表示服务半径内存在医院，不保证收治容量。统计范围仅限输入人口片区。", "System function uses the kernel mean of clipped sample ratios. Travel coverage means a hospital lies within the radius, without guaranteeing treatment capacity. Scope is limited to input demand nodes.")
        fig, axes = _figure(title, _sub(sid, en=en), caption, height=3.8, width=12.4, left=.19)
        _panel(axes[0], "a", _tr(en, "系统功能", "System function"), _tr(en, "功能比", "Function ratio"))
        _barh(axes[0], [0, 1], [system, summary.get("retained_ratio")], color=_TEAL, percent=True)
        _row_axis(axes[0], np.array([0, 1]), [_tr(en, "内核平均功能比", "Kernel mean ratio"), _tr(en, "可达性均值/基准\n（未截断）", "Mean access / reference\n(unclipped)")])
        _panel(axes[1], "b", _tr(en, "服务半径内人口", "Population within radius"), _tr(en, "人口占比", "Population share"))
        _barh(axes[1], [0, 1], [summary.get("coverage_ratio"), summary.get("positive_capacity_coverage_ratio")], color=_BLUE, percent=True)
        _row_axis(axes[1], np.array([0, 1]), [_tr(en, "通行可达", "Travel access"), _tr(en, "可达医院平均能力>0", "Hospital mean capacity > 0")])
        fig.subplots_adjust(wspace=.7)
        records.append(_save(fig, directory, template_id="regional-function", title=title, caption=caption, scenario_id=sid, source_skill_id="medical_system_function"))
    return records


def _demand_figures(service, directory, en):
    records = []
    for scenario in service.get("scenarios", []):
        if scenario.get("accessibility_status") != "available":
            continue
        nodes = list(scenario.get("demand_nodes", []))
        nodes.sort(key=lambda n: (_number(n.get("post_accessibility")) is None, _number(n.get("post_accessibility")) or 0, -(_number(n.get("population")) or 0), str(n.get("node_id", ""))))
        radius = _number(scenario.get("service_radius_minutes"))
        for page, count, chunk in _pages(nodes, _NODE_PAGE):
            labels = _labels(chunk, {}, hospitals=False)
            y, height = _positions(labels)
            sid = scenario["scenario_id"]
            title = _tr(en, "居民片区医疗可达性", "Medical accessibility of demand nodes")
            caption = _tr(en, "按震后2SFCA由低到高排序，完整分页。基准采用同一情景到院时间与震前能力；最近医院可能无剩余能力。2SFCA不是人数或概率。", "All demand nodes are paginated in ascending post-event 2SFCA order. Reference uses the same scenario travel times with pre-event capacity. The nearest hospital may have zero capacity. 2SFCA is not a patient count or probability.")
            fig, axes = _figure(title, _sub(sid, page, count, en), caption, height=height, left=.17, ratios=[1.45, 1])
            _panel(axes[0], "a", _tr(en, "综合医疗可达性", "Integrated accessibility"), _tr(en, "高斯2SFCA指标", "Gaussian 2SFCA index"))
            _comparison(axes[0], y, [r.get("baseline_accessibility") for r in chunk], [r.get("post_accessibility") for r in chunk], en)
            _panel(axes[1], "b", _tr(en, "最近医院到院时间", "Travel time to nearest hospital"), _tr(en, "分钟", "Minutes"))
            values = [r.get("nearest_minutes") for r in chunk]
            _barh(axes[1], y, values, color=_ORANGE)
            if radius is not None:
                axes[1].axvline(radius, color=_MUTED, linestyle="--", linewidth=.8)
                maximum = max([_number(v) for v in values if _number(v) is not None] or [0])
                axes[1].set_xlim(0, max(radius * 1.17, maximum * 1.25, 1))
                axes[1].text(radius, 1.02, _tr(en, f"服务半径 {radius:g} min", f"Radius {radius:g} min"), transform=axes[1].get_xaxis_transform(), ha="center", va="bottom", fontsize=8, color=_MUTED)
            for i, axis in enumerate(axes):
                _row_axis(axis, y, labels if i == 0 else None)
            records.append(_save(fig, directory, template_id="demand-accessibility", title=title, caption=caption, scenario_id=sid, source_skill_id="medical_system_function", page=page, page_count=count))
    return records


def _spatial_figures(service, directory, en):
    records = []
    for scenario in service.get("scenarios", []):
        hospitals, nodes = scenario.get("hospitals", []), scenario.get("demand_nodes", [])
        if not hospitals and not nodes:
            continue
        valid = lambda r: _number(r.get("longitude")) is not None and _number(r.get("latitude")) is not None and -180 <= r["longitude"] <= 180 and -90 <= r["latitude"] <= 90
        hs, ns = [h for h in hospitals if valid(h)], [n for n in nodes if valid(n)]
        crs = service.get("basis", {}).get("coordinate_system")
        if crs != "WGS84":
            hs, ns = [], []
        sid = scenario["scenario_id"]
        title = _tr(en, "医疗服务空间分布", "Spatial distribution of medical services")
        caption = _tr(en, f"医院有效坐标 {len(hs)}/{len(hospitals)}，人口片区有效坐标 {len(ns)}/{len(nodes)}。仅绘制原数据坐标，不估算位置，不添加虚构道路或行政边界。", f"Valid coordinates: hospitals {len(hs)}/{len(hospitals)}, demand nodes {len(ns)}/{len(nodes)}. Only source coordinates are plotted, without inferred locations, roads or administrative boundaries.")
        fig, axes = _figure(title, _sub(sid, en=en), caption, panels=1, height=6.4, width=10.6, left=.12)
        axis = axes[0]
        _panel(axis, "a", _tr(en, "真实坐标示意 · WGS84", "Source-coordinate view · WGS84"), _tr(en, "经度（°）", "Longitude (°)"))
        status = "available"
        if hs or ns:
            value_nodes = [n for n in ns if _number(n.get("post_accessibility")) is not None]
            unknown_nodes = [n for n in ns if _number(n.get("post_accessibility")) is None]
            if value_nodes:
                scatter = axis.scatter([n["longitude"] for n in value_nodes], [n["latitude"] for n in value_nodes], c=[n["post_accessibility"] for n in value_nodes],
                                       cmap=mcolors.LinearSegmentedColormap.from_list("medical-teal", ["#deefec", _TEAL]), s=45, linewidth=.45, edgecolors="white", zorder=3)
                colorbar = fig.colorbar(scatter, ax=axis, fraction=.035, pad=.03)
                colorbar.set_label(_tr(en, "震后2SFCA均值", "Mean post-event 2SFCA"), fontsize=9)
                colorbar.ax.tick_params(labelsize=8)
            if unknown_nodes:
                axis.scatter([n["longitude"] for n in unknown_nodes], [n["latitude"] for n in unknown_nodes], marker="o", s=36, facecolors="none", edgecolors=_MUTED, label=_tr(en, "片区（缺可达性）", "Node (access unavailable)"))
            if hs:
                axis.scatter([h["longitude"] for h in hs], [h["latitude"] for h in hs], marker="P", s=85, color=_ORANGE, edgecolors="white", linewidth=.6, label=_tr(en, "医院", "Hospital"), zorder=4)
            axis.set_ylabel(_tr(en, "纬度（°）", "Latitude (°)"), fontsize=9)
            all_latitudes = [r["latitude"] for r in [*hs, *ns]]
            axis.set_aspect(1 / max(.2, math.cos(math.radians(float(np.mean(all_latitudes))))))
            axis.grid(True, color=_GRID, linewidth=.6)
            axis.ticklabel_format(useOffset=False)
            if axis.get_legend_handles_labels()[0]:
                axis.legend(frameon=False, fontsize=8, loc="upper right")
            _map_labels(fig, axis, hs)
        else:
            status = "missing_coordinates"
            axis.set_axis_off()
            axis.text(.5, .61, _tr(en, "当前数据尚不能绘制空间位置", "Spatial positions are not available"), transform=axis.transAxes, ha="center", fontsize=17, color=_INK)
            axis.text(.5, .43, _tr(en, "请在城市数据中补齐医院和人口片区的经纬度，并确认 WGS84 坐标系。", "Provide hospital and demand-node coordinates with a declared WGS84 reference."), transform=axis.transAxes, ha="center", fontsize=10, color=_MUTED)
            axis.text(.5, .28, _tr(en, "医院能力、片区排序与到院时间结果仍可查看；缺坐标不会被替换成猜测位置。", "Capability, node rankings and travel results remain available. Missing positions are never guessed."), transform=axis.transAxes, ha="center", fontsize=9, color=_MUTED)
        records.append(_save(fig, directory, template_id="spatial-distribution", title=title, caption=caption, scenario_id=sid, source_skill_id="medical_system_function", status=status))
    return records


def _strategy(value: Any, en: bool):
    return {"importance": _tr(en, "重要度策略", "Importance"), "ga": _tr(en, "遗传算法策略", "Genetic algorithm"), "robust_ga": _tr(en, "稳健遗传算法", "Robust GA")}.get(str(value), str(value))


def _recovery_figures(sections, service, names, directory, en):
    tables = _tables(sections, "recovery_optimization")
    recovery, schedule = tables.get("recovery", []), tables.get("schedule", [])
    curves = list(service.get("recovery_curves", []))
    if not curves:
        for section in sections:
            if section.get("skill_id") != "recovery_optimization":
                continue
            for series in section.get("chart", {}).get("series", []):
                match = next((r for r in recovery if str(series.get("label")) == f"{_sid(r)} {r.get('strategy')}"), None)
                if match:
                    curves.append({"scenario_id": _sid(match), "strategy": match.get("strategy"), "days": series.get("x", []), "mean_function_ratio": series.get("y", [])})
    records = []
    for sid in dict.fromkeys([*(_sid(r) for r in recovery), *(_sid(c) for c in curves)]):
        rows, lines = [r for r in recovery if _sid(r) == sid], [c for c in curves if _sid(c) == sid]
        title = _tr(en, "恢复过程与策略收益", "Recovery trajectories and strategy outcomes")
        caption = _tr(en, "曲线与R均来自已保存计算结果；R遵循原模型积分口径，总恢复时间可能超过曲线控制期。收益和工期需同时比较，不能据单个指标宣布最优。", "Curves and R are saved model results. R follows the original integration convention; total recovery may exceed the plotted control horizon. Compare resilience and completion time together.")
        curve_days = [_number(day) for line in lines for day in line.get("days", []) if _number(day) is not None]
        if curve_days:
            caption = _tr(en, f"曲线最后记录日：{max(curve_days):g}天。", f"Last recorded curve day: {max(curve_days):g}. ") + caption
        fig, axes = _figure(title, _sub(sid, en=en), caption, panels=3, height=5.8, width=12.8, left=.075, ratios=[1.9, 1, 1])
        _panel(axes[0], "a", _tr(en, "系统功能恢复曲线", "System function recovery"), _tr(en, "时间（天）", "Time (days)"))
        for i, curve in enumerate(lines):
            xs, ys = curve.get("days", []), curve.get("mean_function_ratio", [])
            if len(xs) != len(ys):
                continue
            pairs = [(_number(x), _number(y)) for x, y in zip(xs, ys)]
            x = [a if a is not None else np.nan for a, b in pairs]
            y = [b if b is not None else np.nan for a, b in pairs]
            axes[0].plot(x, y, color=_COLORS[i % 4], linewidth=2, linestyle="-" if i % 2 == 0 else "--", label=_strategy(curve.get("strategy"), en))
            valid = [(a, b) for a, b in pairs if a is not None and b is not None]
            if valid:
                axes[0].annotate(_fmt(valid[-1][1], percent=True), valid[-1], xytext=(5, 8 if i % 2 == 0 else -12), textcoords="offset points", color=_COLORS[i % 4], fontsize=8)
        axes[0].set_ylabel(_tr(en, "平均系统功能比", "Mean system function ratio"), fontsize=9)
        axes[0].set_ylim(bottom=0)
        axes[0].grid(True, color=_GRID, linewidth=.6)
        if lines:
            axes[0].legend(frameon=False, fontsize=8, loc="upper left")
        else:
            axes[0].text(.5, .5, _tr(en, "无已保存恢复曲线", "No saved recovery curve"), transform=axes[0].transAxes, ha="center", color=_MUTED)
        labels = [_wrap(_strategy(r.get("strategy"), en), 16) for r in rows]
        y = np.arange(len(rows))
        _panel(axes[1], "b", _tr(en, "平均韧性指标R", "Mean resilience R"), _tr(en, "韧性指标", "Resilience index"))
        _barh(axes[1], y, [_value(r, "resilience", "mean_resilience", "mean_resilience_index") for r in rows], color=_GREEN, decimals=4)
        _row_axis(axes[1], y, labels)
        _panel(axes[2], "c", _tr(en, "平均总恢复时间", "Mean total recovery time"), _tr(en, "天", "Days"))
        _barh(axes[2], y, [_value(r, "total_recovery_days", "mean_total_recovery_time") for r in rows], color=_ORANGE, decimals=2)
        _row_axis(axes[2], y, labels)
        # A full-height trajectory on the left, two compact metric panels on
        # the right. Sparse comparisons no longer inherit the curve's height.
        axes[0].set_position([.08, .23, .40, .53])
        axes[1].set_position([.69, .57, .265, .19])
        axes[2].set_position([.69, .23, .265, .19])
        records.append(_save(fig, directory, template_id="recovery-comparison", title=title, caption=caption, scenario_id=sid, source_skill_id="recovery_optimization"))
    for sid, strategy in dict.fromkeys((_sid(r), str(r.get("strategy", ""))) for r in schedule):
        rows = sorted([r for r in schedule if _sid(r) == sid and str(r.get("strategy", "")) == strategy], key=lambda r: _value(r, "rank") or 0)
        for page, count, chunk in _pages(rows, _HOSPITAL_PAGE):
            labels = _labels(chunk, names)
            y, height = _positions(labels)
            title = _tr(en, "第一模拟样本修复排程", "Repair schedule of the first simulation sample")
            caption = _tr(en, "此图仅为第一模拟样本的排程示例，不是跨样本统一施工方案。条形起止日使用保存值；队伍编号决定颜色。", "This is only the first simulation sample, not one construction plan shared across simulations. Bar endpoints use saved days; colors identify repair teams.")
            fig, axes = _figure(title, _sub(sid, page, count, en) + "  ·  " + _strategy(strategy, en), caption, panels=1, height=height, left=.28)
            axis = axes[0]
            _panel(axis, "a", _tr(en, "按实施顺序排列", "Ordered by implementation rank"), _tr(en, "计算起点后的天数", "Days from the model origin"))
            seen, maximum = set(), 0.
            for yi, row in zip(y, chunk):
                start, finish = _value(row, "start_day"), _value(row, "finish_day")
                if start is None or finish is None or finish < start:
                    axis.text(.02, yi, "—", transform=axis.get_yaxis_transform(), va="center", color=_MUTED)
                    continue
                team = int(_value(row, "team") or 0)
                color = _COLORS[(max(team, 1) - 1) % 4]
                label = _tr(en, f"队伍 {team}", f"Team {team}") if team not in seen else None
                axis.barh(yi, finish-start, left=start, height=.52, color=color, label=label)
                axis.text(finish + max(finish*.012, .01), yi, f"{start:.2f}–{finish:.2f}", va="center", fontsize=9.5, color=_INK)
                seen.add(team)
                maximum = max(maximum, finish)
            _row_axis(axis, y, labels)
            axis.set_xlim(0, max(maximum * 1.18, 1))
            if seen:
                axis.legend(frameon=False, fontsize=8, loc="lower right", bbox_to_anchor=(1.0, 1.015), ncol=min(len(seen), 5))
            records.append(_save(fig, directory, template_id="sample-schedule", title=title, caption=caption, scenario_id=sid, source_skill_id="recovery_optimization", page=page, page_count=count, variant=strategy))
    return records


def _preparation_figures(sections, service, directory, en):
    rows = [r for s in sections if s.get("skill_id") == "earthquake_scenario_interpretation" for t in s.get("tables", []) for r in t.get("rows", []) if _value(r, "pga_g") is not None]
    records = []
    summaries = [s for s in service.get("scenarios", []) if isinstance(s.get("summary"), dict) and any(_value(s["summary"], key) is not None for key in ("hospital_count", "demand_node_count", "population"))] if service.get("status") == "available" else []
    for scenario in summaries:
        sid, summary = scenario["scenario_id"], scenario["summary"]
        title = _tr(en, "评估输入与地震情景", "Assessment inputs and earthquake scenario")
        caption = _tr(en, "输入规模来自本次任务的数据范围，不代表全市数据完整。仅展示明确记录的PGA，不从情景名称推断强度或楼层响应。", "Input counts describe this assessment's scope, not whole-city completeness. PGA is shown only when explicitly recorded, never inferred from scenario names or used to invent floor responses.")
        fig, axes = _figure(title, _sub(sid, en=en), caption, panels=2, height=5.6, width=12.3, left=.09, ratios=[1.05, 1])
        _panel(axes[0], "a", _tr(en, "本次评估输入范围", "Assessment input scope"), "")
        _panel(axes[1], "b", _tr(en, "情景与服务参数", "Scenario and service parameters"), "")
        for axis in axes:
            axis.set_axis_off()
        entries = [(_tr(en, "医院数量", "Hospitals"), _fmt(_value(summary, "hospital_count")), _tr(en, "家", "hospitals")),
                   (_tr(en, "人口片区数量", "Demand nodes"), _fmt(_value(summary, "demand_node_count")), _tr(en, "个", "nodes")),
                   (_tr(en, "输入范围人口", "Input population"), _fmt(_value(summary, "population")), _tr(en, "人", "people"))]
        for i, (label, value, unit) in enumerate(entries):
            y = .78 - i*.25
            axes[0].text(.02, y, label, transform=axes[0].transAxes, fontsize=11, color=_INK)
            axes[0].text(.77, y, value, transform=axes[0].transAxes, fontsize=18, ha="right", color=_TEAL)
            axes[0].text(.80, y, unit, transform=axes[0].transAxes, fontsize=9, color=_MUTED)
            axes[0].plot([.02, .98], [y-.07, y-.07], transform=axes[0].transAxes, color=_GRID, linewidth=.7)
        axes[1].text(.02, .80, _tr(en, "情景", "Scenario"), transform=axes[1].transAxes, fontsize=10, color=_MUTED)
        axes[1].text(.02, .63, _wrap(str(scenario.get("scenario_name") or sid), 42), transform=axes[1].transAxes, fontsize=15, color=_BLUE)
        radius = _value(scenario, "service_radius_minutes")
        axes[1].text(.02, .40, _tr(en, "服务半径", "Service radius"), transform=axes[1].transAxes, fontsize=10, color=_MUTED)
        axes[1].text(.02, .23, _fmt(radius) + _tr(en, " 分钟", " min"), transform=axes[1].transAxes, fontsize=18, color=_ORANGE)
        pga = next((_value(r, "pga_g") for r in rows if _sid(r) == sid), None)
        if pga is not None:
            axes[1].text(.57, .40, "PGA", transform=axes[1].transAxes, fontsize=10, color=_MUTED)
            axes[1].text(.57, .23, _fmt(pga) + " g", transform=axes[1].transAxes, fontsize=18, color=_BLUE)
        records.append(_save(fig, directory, template_id="earthquake-preparation", title=title, caption=caption, scenario_id=sid, source_skill_id="earthquake_scenario_interpretation"))
    represented = {s["scenario_id"] for s in summaries}
    for row in rows:
        sid = _sid(row)
        if sid in represented:
            continue
        title = _tr(en, "地震情景输入", "Earthquake scenario input")
        caption = _tr(en, "PGA为该情景已记录的输入值；不由情景名称猜测，不据此推导未提供的楼层响应。", "PGA is the recorded scenario input. It is not inferred from a scenario name or used to invent missing floor responses.")
        fig, axes = _figure(title, _sub(sid, en=en), caption, panels=1, height=3.4, width=9.8, left=.18)
        _panel(axes[0], "a", _tr(en, "峰值地面加速度", "Peak ground acceleration"), "g")
        _barh(axes[0], [0], [row["pga_g"]], color=_BLUE)
        _row_axis(axes[0], np.array([0]), [sid])
        records.append(_save(fig, directory, template_id="earthquake-preparation", title=title, caption=caption, scenario_id=sid, source_skill_id="earthquake_scenario_interpretation"))
    return records


def build_publication_figures(bundle: dict, directory: Path, language="zh-CN") -> list[dict]:
    """Render all supported, available result steps as PNG 300 dpi, SVG and PDF.

    Returned filenames are safe basenames within ``directory``. The caller owns
    content-addressed caching and URLs. Matplotlib's process-global rc settings
    are protected by the shared reentrant lock, including legacy renderers.
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    en = str(language).lower().startswith("en")
    sections = [s for s in bundle.get("sections", []) if isinstance(s, dict)]
    service = bundle.get("medical_service") or {}
    names = {str(h.get("hospital_id", h.get("id", ""))): str(h.get("hospital_name", h.get("name", ""))) for h in [*bundle.get("hospitals", []), *bundle.get("hospital_entities", [])] if isinstance(h, dict)}
    for scenario in service.get("scenarios", []):
        for hospital in scenario.get("hospitals", []):
            names[str(hospital.get("hospital_id", ""))] = str(hospital.get("hospital_name", ""))
    with PLOT_LOCK, publication_style():
        region = bundle.get("region") or service.get("basis", {}).get("region") or {}
        scope = " / ".join(dict.fromkeys(str(region.get(key)) for key in ("city_name", "region_name") if region.get(key))) if isinstance(region, dict) else str(region)
        token = _SCOPE.set(scope)
        try:
            records = []
            records.extend(_preparation_figures(sections, service, directory, en))
            records.extend(_damage_figures(sections, names, directory, en))
            records.extend(_hospital_figures(sections, service, names, directory, en))
            records.extend(_regional_figures(sections, service, directory, en))
            records.extend(_demand_figures(service, directory, en))
            records.extend(_spatial_figures(service, directory, en))
            records.extend(_recovery_figures(sections, service, names, directory, en))
        finally:
            _SCOPE.reset(token)
    return records


def render_engineering_figure(chart: dict, directory: Path) -> dict:
    """Adapt recorded non-medical data to the medical publication templates.

    No interpolation, invented baseline or hospital-specific metric is applied.
    The caller paginates object lists; recovery panels retain every saved point.
    """
    with PLOT_LOCK, publication_style():
        points = chart['points']
        title = chart['title']
        en = str(chart.get('language', 'zh-CN')).startswith('en')
        page, count = chart.get('page', 1), chart.get('page_count', 1)
        subtitle = (f"Saved calculation results · {len(points)} data points · Page {page} / {count}" if en
                    else f"已保存计算结果 · {len(points)} 个数据点 · 第 {page} / {count} 页")
        caption = chart.get('note') or '图中数值来自本轮保存结果；单位与原模型一致，未插值或补造基准。'
        if chart['kind'] == 'line':
            xs, ys = [p['x'] for p in points], [p['y'] for p in points]
            last = len(points) - 1
            while last > 1 and ys[last-1] == ys[-1]:
                last -= 1
            detail = last < len(points) - 2
            fig, axes = _figure(title, subtitle, caption, panels=2 if detail else 1,
                               width=12.8, height=5.8, left=.085)
            for index, axis in enumerate(axes):
                end = min(len(points), last + 2) if detail and index == 0 else len(points)
                panel_title = ('Recovery transition' if detail and index == 0 else 'Full recorded period') if en else ('恢复变化阶段' if detail and index == 0 else '完整记录时间范围')
                _panel(axis, chr(97+index), panel_title, chart['x_label'])
                axis.plot(xs[:end], ys[:end], color=_TEAL, linewidth=2, label=chart['y_label'])
                if end <= 20:
                    axis.scatter(xs[:end], ys[:end], color=_TEAL, s=16, zorder=3)
                axis.set_ylabel(chart['y_label'], fontsize=9.4)
                axis.set_ylim(bottom=min(0, min(ys)))
                axis.margins(x=.06, y=.15)
                axis.grid(True, color=_GRID, linewidth=.6)
                axis.annotate(_fmt(ys[end-1]), (xs[end-1], ys[end-1]), xytext=(-6, 10),
                              textcoords='offset points', ha='right', color=_TEAL, fontsize=9.5)
                axis.legend(frameon=False, loc='lower right', fontsize=8)
        else:
            labels = [_wrap(p['x'], 27) for p in points]
            positions, height = _positions(labels)
            fig, axes = _figure(title, subtitle, caption, panels=1, height=max(4.7, height), left=.25)
            axis = axes[0]
            _panel(axis, 'a', chart['x_label'], chart['y_label'])
            values = [p['y'] for p in points]
            _barh(axis, positions, values, color=_BLUE)
            if min(values) < 0:
                axis.set_xlim(min(values)*1.3, max(max(values), 0)*1.3 or 1)
            _row_axis(axis, positions, labels)
        return _save(fig, directory, template_id='engineering-'+chart['id'], title=title,
                     caption=caption, scenario_id='', source_skill_id=chart['source'], page=page, page_count=count)


def publication_style():
    """One typography/export style for medical and other engineering figures."""
    available_fonts = {font.name for font in font_manager.fontManager.ttflist}
    cjk = next((font for font in ("Microsoft YaHei", "Noto Sans CJK SC", "Noto Serif CJK SC", "SimHei", "SimSun") if font in available_fonts), None)
    serif = [font for font in ("Times New Roman", cjk, "DejaVu Serif") if font in available_fonts]
    return matplotlib.rc_context({"font.family": serif or ["DejaVu Serif"], "font.size": 9,
                "axes.unicode_minus": False, "figure.facecolor": "white", "savefig.facecolor": "white", "savefig.bbox": None,
                "svg.fonttype": "path", "pdf.fonttype": 42, "ps.fonttype": 42, "hatch.linewidth": .6,
                "font.weight": "bold", "axes.titleweight": "bold", "axes.labelweight": "bold", "axes.labelcolor": _INK, "text.color": _INK})
