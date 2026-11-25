from __future__ import annotations

import math
import os
import re
import uuid
from collections.abc import Mapping, Sequence
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from docx import Document
from docx.document import Document as DocxDocument
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from .metric_policy import comparison_status


SESSION_REPORT_FILENAME = "multi_round_session_report.docx"
SESSION_REPORT_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

_PAGE_WIDTH_IN = 8.5
_PAGE_HEIGHT_IN = 11.0
_MARGIN_IN = 1.0
_HEADER_FOOTER_DISTANCE_IN = 0.492
_CONTENT_WIDTH_DXA = 9360
_TABLE_INDENT_DXA = 120
_TABLE_CELL_MARGINS_DXA = {"top": 80, "bottom": 80, "start": 120, "end": 120}

_BODY_FONT = "Calibri"
_CJK_FONT = "Microsoft YaHei"
_INK = "1F2937"
_MUTED = "5F6B7A"
_BLUE = "2E74B5"
_DARK_BLUE = "1F4D78"
_LIGHT_BLUE = "EAF2F8"
_LIGHT_GRAY = "F2F4F7"
_BORDER = "CBD5E1"
_CALLOUT = "F4F6F9"

_STATUS_ZH = {
    "received": "已接收",
    "analyzed": "已分析",
    "planned": "已规划",
    "needs_input": "等待补充信息",
    "awaiting_approval": "等待计划审批",
    "executing": "计算中",
    "awaiting_result_review": "等待结果审查",
    "processing_feedback": "处理专家反馈",
    "answering": "回答追问中",
    "succeeded": "已完成",
    "rejected": "已拒绝",
    "failed": "失败",
}

_STATUS_EN = {
    "received": "Received",
    "analyzed": "Analyzed",
    "planned": "Planned",
    "needs_input": "Needs input",
    "awaiting_approval": "Awaiting plan approval",
    "executing": "Computing",
    "awaiting_result_review": "Awaiting result review",
    "processing_feedback": "Processing expert feedback",
    "answering": "Answering follow-up",
    "succeeded": "Completed",
    "rejected": "Rejected",
    "failed": "Failed",
}


def _language(value: str | None) -> str:
    return "en-US" if str(value or "").lower().startswith("en") else "zh-CN"


def _text(language: str, zh: str, en: str) -> str:
    return en if language == "en-US" else zh


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    # Word rejects most C0 controls. Tabs and line breaks remain meaningful.
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text).strip()


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _sequence(value: Any) -> list[Any]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    return []


def _iteration_number(value: Any, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return number if number >= 1 else fallback


def _parse_timestamp(value: Any) -> datetime | None:
    text = _clean_text(value)
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iteration_completed_at(iteration: Mapping[str, Any]) -> str:
    completed_at = _clean_text(iteration.get("completed_at"))
    if completed_at:
        return completed_at
    result = _mapping(iteration.get("result"))
    provenance = _mapping(result.get("provenance"))
    return _clean_text(provenance.get("finished_at"))


def _ordered_iterations(iterations: Any) -> list[Mapping[str, Any]]:
    records = [item for item in _sequence(iterations) if isinstance(item, Mapping)]
    decorated = [
        (_iteration_number(item.get("iteration"), index + 1), index, item)
        for index, item in enumerate(records)
    ]
    decorated.sort(key=lambda entry: (entry[0], entry[1]))
    return [item for _, _, item in decorated]


def collect_session_rounds(
    iterations: Any,
    follow_ups: Any,
    limit: int = 4,
) -> list[dict[str, Any]]:
    """Merge computation iterations and follow-ups into a stable session timeline.

    ``completed_at`` and ``asked_at`` are the authoritative timestamps when all
    computation iterations have them. Legacy iterations without timestamps keep
    their iteration order; follow-ups are then appended, with untimed follow-ups
    last. A recomputation triggered by a previous ``revise`` decision is labelled
    ``expert_revision_result`` and carries that prior decision as ``trigger_decision``.

    Returned mappings are detached copies and are deliberately presentation-neutral
    so callers can test or render them in either language.
    """

    try:
        requested_limit = int(limit)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer") from exc
    if requested_limit <= 0:
        return []

    ordered_iterations = _ordered_iterations(iterations)
    calculation_events: list[dict[str, Any]] = []
    previous: Mapping[str, Any] | None = None
    for index, iteration in enumerate(ordered_iterations):
        iteration_number = _iteration_number(iteration.get("iteration"), index + 1)
        result = _mapping(iteration.get("result"))
        run_id = _clean_text(iteration.get("run_id") or result.get("run_id"))
        completed_at = _iteration_completed_at(iteration)
        trigger_decision: dict[str, Any] | None = None
        kind = "calculation"
        if previous is not None:
            prior_decision = _mapping(previous.get("expert_decision"))
            if _clean_text(prior_decision.get("action")).lower() == "revise":
                kind = "expert_revision_result"
                trigger_decision = deepcopy(dict(prior_decision))

        event = {
            "kind": kind,
            "iteration": iteration_number,
            "run_id": run_id,
            "timestamp": completed_at or None,
            "completed_at": completed_at or None,
            "report_summary": deepcopy(dict(_mapping(iteration.get("report_summary")))),
            "expert_decision": deepcopy(dict(_mapping(iteration.get("expert_decision")))),
            "trigger_decision": trigger_decision,
            "_timestamp": _parse_timestamp(completed_at),
            "_logical_order": index,
            "_source_order": index,
        }
        calculation_events.append(event)
        previous = iteration

    follow_up_events: list[dict[str, Any]] = []
    latest_run_id = calculation_events[-1]["run_id"] if calculation_events else ""
    timed_calculations = [
        item for item in calculation_events if item.get("_timestamp") is not None
    ]
    for index, item in enumerate(_sequence(follow_ups)):
        if not isinstance(item, Mapping):
            continue
        asked_at = _clean_text(item.get("asked_at"))
        asked_time = _parse_timestamp(asked_at)
        run_id = _clean_text(item.get("run_id"))
        if not run_id and asked_time is not None and timed_calculations:
            eligible = [
                event
                for event in timed_calculations
                if event["_timestamp"] <= asked_time
            ]
            if eligible:
                run_id = eligible[-1]["run_id"]
        if not run_id:
            run_id = latest_run_id
        follow_up_events.append(
            {
                "kind": "follow_up",
                "iteration": None,
                "run_id": run_id,
                "timestamp": asked_at or None,
                "asked_at": asked_at or None,
                "answered_at": _clean_text(item.get("answered_at")) or None,
                "question": _clean_text(item.get("question")),
                "answer": _clean_text(item.get("answer")),
                "status": _clean_text(item.get("status")),
                "actor": _clean_text(item.get("actor")),
                "actor_role": _clean_text(item.get("actor_role")),
                "message_id": _clean_text(item.get("message_id")),
                "_timestamp": asked_time,
                "_logical_order": len(calculation_events) + index,
                "_source_order": index,
            }
        )

    all_calculations_timed = bool(calculation_events) and all(
        event.get("_timestamp") is not None for event in calculation_events
    )
    if all_calculations_timed:
        timed_events = [
            event
            for event in [*calculation_events, *follow_up_events]
            if event.get("_timestamp") is not None
        ]
        timed_events.sort(
            key=lambda event: (
                event["_timestamp"],
                0 if event["kind"] != "follow_up" else 1,
                event["_logical_order"],
            )
        )
        untimed_follow_ups = [
            event for event in follow_up_events if event.get("_timestamp") is None
        ]
        untimed_follow_ups.sort(key=lambda event: event["_source_order"])
        timeline = [*timed_events, *untimed_follow_ups]
    elif calculation_events:
        timed_follow_ups = [
            event for event in follow_up_events if event.get("_timestamp") is not None
        ]
        timed_follow_ups.sort(key=lambda event: (event["_timestamp"], event["_source_order"]))
        untimed_follow_ups = [
            event for event in follow_up_events if event.get("_timestamp") is None
        ]
        untimed_follow_ups.sort(key=lambda event: event["_source_order"])
        timeline = [*calculation_events, *timed_follow_ups, *untimed_follow_ups]
    else:
        timed_follow_ups = [
            event for event in follow_up_events if event.get("_timestamp") is not None
        ]
        timed_follow_ups.sort(key=lambda event: (event["_timestamp"], event["_source_order"]))
        untimed_follow_ups = [
            event for event in follow_up_events if event.get("_timestamp") is None
        ]
        untimed_follow_ups.sort(key=lambda event: event["_source_order"])
        timeline = [*timed_follow_ups, *untimed_follow_ups]

    public_timeline: list[dict[str, Any]] = []
    for round_number, event in enumerate(timeline, 1):
        clean = {
            key: deepcopy(value)
            for key, value in event.items()
            if not key.startswith("_")
        }
        clean["round_number"] = round_number
        public_timeline.append(clean)
    return public_timeline[-requested_limit:]


def _finite_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(float(value)) else None


def _first_value(containers: Sequence[Mapping[str, Any]], keys: Sequence[str]) -> Any:
    for container in containers:
        for key in keys:
            if key in container and container[key] not in (None, ""):
                return container[key]
    return None


def _metric_values_from_sections(summary: Mapping[str, Any]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for section in _sequence(summary.get("sections")):
        if not isinstance(section, Mapping):
            continue
        for metric in _sequence(section.get("metrics")):
            if not isinstance(metric, Mapping):
                continue
            key = _clean_text(metric.get("key"))
            if key and key not in values:
                values[key] = metric.get("value")
    return values


def _quantitative_snapshot(report_summary: Any) -> dict[str, Any]:
    """Extract the comparison snapshot exclusively from ``report_summary``."""

    summary = _mapping(report_summary)
    if summary.get("target_system") == "power_system":
        recovery = _mapping(summary.get("recovery"))
        strategies = [s for s in _sequence(recovery.get("strategies")) if isinstance(s, Mapping)]
        chosen = next((s for s in strategies if s.get("id") == recovery.get("recommended_strategy")), strategies[0] if strategies else {})
        return {"team_count": _mapping(recovery.get("parameters")).get("team_count"), "primary_strategy": chosen.get("id"),
            "resilience": chosen.get("resilience_index"), "functionality_loss_area": chosen.get("loss_area_days"),
            "recovery_duration_days": chosen.get("total_days"), "scenario_id": f"{summary.get('pga_g')}g"}
    scenario_rows = [
        item
        for item in _sequence(summary.get("scenario_summary"))
        if isinstance(item, Mapping)
    ]
    primary_strategy = _clean_text(summary.get("primary_strategy"))
    selected_scenario: Mapping[str, Any] = {}
    if primary_strategy:
        selected_scenario = next(
            (
                item
                for item in scenario_rows
                if _clean_text(item.get("strategy")) == primary_strategy
            ),
            {},
        )
    if not selected_scenario and scenario_rows:
        selected_scenario = scenario_rows[0]

    section_values = _metric_values_from_sections(summary)
    containers = [summary, selected_scenario, section_values]
    strategy = _clean_text(
        _first_value(containers, ("primary_strategy", "strategy"))
    )
    return {
        "team_count": _finite_number(_first_value(containers, ("team_count",))),
        "primary_strategy": strategy or None,
        "resilience": _finite_number(
            _first_value(
                containers,
                (
                    "mean_resilience_index",
                    "mean_resilience",
                    "resilience_index",
                    "resilience",
                ),
            )
        ),
        "functionality_loss_area": _finite_number(
            _first_value(
                containers,
                ("mean_functionality_loss_area", "functionality_loss_area"),
            )
        ),
        "recovery_duration_days": _finite_number(
            _first_value(
                containers,
                (
                    "mean_recovery_time_days",
                    "recovery_duration_days",
                ),
            )
        ),
        "scenario_id": _clean_text(
            _first_value(containers, ("scenario_id", "id"))
        )
        or None,
    }


def _format_number(value: Any, *, decimals: int = 3) -> str:
    number = _finite_number(value)
    if number is None:
        return "—"
    numeric = float(number)
    if numeric.is_integer():
        return str(int(numeric))
    return f"{numeric:.{decimals}f}".rstrip("0").rstrip(".")


def _format_timestamp(value: Any) -> str:
    text = _clean_text(value)
    if not text:
        return "—"
    parsed = _parse_timestamp(text)
    if parsed is None:
        return text
    return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")


def _set_run_font(
    run: Any,
    *,
    size: float | None = None,
    color: str | None = None,
    bold: bool | None = None,
    italic: bool | None = None,
) -> None:
    run.font.name = _BODY_FONT
    run_properties = run._element.get_or_add_rPr()
    fonts = run_properties.rFonts
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        run_properties.insert(0, fonts)
    fonts.set(qn("w:ascii"), _BODY_FONT)
    fonts.set(qn("w:hAnsi"), _BODY_FONT)
    fonts.set(qn("w:eastAsia"), _CJK_FONT)
    if size is not None:
        run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic


def _set_style_font(
    style: Any,
    *,
    size: float,
    color: str,
    bold: bool | None = None,
) -> None:
    style.font.name = _BODY_FONT
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        style.font.bold = bold
    run_properties = style._element.get_or_add_rPr()
    fonts = run_properties.rFonts
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        run_properties.insert(0, fonts)
    fonts.set(qn("w:ascii"), _BODY_FONT)
    fonts.set(qn("w:hAnsi"), _BODY_FONT)
    fonts.set(qn("w:eastAsia"), _CJK_FONT)


def _configure_styles(document: DocxDocument) -> None:
    normal = document.styles["Normal"]
    _set_style_font(normal, size=11, color=_INK)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.10

    title = document.styles["Title"]
    _set_style_font(title, size=23, color="000000", bold=True)
    title.paragraph_format.space_before = Pt(0)
    title.paragraph_format.space_after = Pt(4)
    title.paragraph_format.keep_with_next = True

    subtitle = document.styles["Subtitle"]
    _set_style_font(subtitle, size=14, color="374151")
    subtitle.paragraph_format.space_before = Pt(0)
    subtitle.paragraph_format.space_after = Pt(16)
    subtitle.paragraph_format.keep_with_next = True

    heading_tokens = {
        "Heading 1": (16, _BLUE, 16, 8),
        "Heading 2": (13, _BLUE, 12, 6),
        "Heading 3": (12, _DARK_BLUE, 8, 4),
    }
    for name, (size, color, before, after) in heading_tokens.items():
        style = document.styles[name]
        _set_style_font(style, size=size, color=color, bold=True)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True


def _configure_page(document: DocxDocument) -> None:
    section = document.sections[0]
    section.page_width = Inches(_PAGE_WIDTH_IN)
    section.page_height = Inches(_PAGE_HEIGHT_IN)
    section.top_margin = Inches(_MARGIN_IN)
    section.right_margin = Inches(_MARGIN_IN)
    section.bottom_margin = Inches(_MARGIN_IN)
    section.left_margin = Inches(_MARGIN_IN)
    section.header_distance = Inches(_HEADER_FOOTER_DISTANCE_IN)
    section.footer_distance = Inches(_HEADER_FOOTER_DISTANCE_IN)


def _add_page_field(paragraph: Any) -> None:
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instruction = OxmlElement("w:instrText")
    instruction.set(qn("xml:space"), "preserve")
    instruction.text = " PAGE "
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    placeholder = OxmlElement("w:t")
    placeholder.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run = paragraph.add_run()
    run._r.extend([begin, instruction, separate, placeholder, end])
    _set_run_font(run, size=9, color=_MUTED)


def _configure_header_footer(
    document: DocxDocument,
    session_id: str,
    language: str,
) -> None:
    section = document.sections[0]
    header = section.header
    header_paragraph = header.paragraphs[0]
    header_paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
    header_paragraph.paragraph_format.space_after = Pt(0)
    header_paragraph.paragraph_format.tab_stops.add_tab_stop(
        Inches(6.5), WD_TAB_ALIGNMENT.RIGHT
    )
    left = header_paragraph.add_run(
        _text(language, "PowerSkillAgent | 多轮会话报告", "PowerSkillAgent | Multi-round session report")
    )
    _set_run_font(left, size=9, color=_MUTED, bold=True)
    tab = header_paragraph.add_run("\t")
    _set_run_font(tab, size=9, color=_MUTED)
    right = header_paragraph.add_run(session_id or "—")
    _set_run_font(right, size=9, color=_MUTED)

    footer = section.footer
    footer_paragraph = footer.paragraphs[0]
    footer_paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    footer_paragraph.paragraph_format.space_before = Pt(0)
    footer_paragraph.paragraph_format.space_after = Pt(0)
    label = footer_paragraph.add_run(_text(language, "页码 ", "Page "))
    _set_run_font(label, size=9, color=_MUTED)
    _add_page_field(footer_paragraph)


def _set_paragraph_bottom_border(
    paragraph: Any,
    *,
    color: str = _BLUE,
    size: int = 12,
    space: int = 5,
) -> None:
    paragraph_properties = paragraph._p.get_or_add_pPr()
    borders = paragraph_properties.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        paragraph_properties.append(borders)
    bottom = borders.find(qn("w:bottom"))
    if bottom is None:
        bottom = OxmlElement("w:bottom")
        borders.append(bottom)
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(size))
    bottom.set(qn("w:space"), str(space))
    bottom.set(qn("w:color"), color)


def _shade_paragraph(paragraph: Any, fill: str, border_color: str | None = None) -> None:
    paragraph_properties = paragraph._p.get_or_add_pPr()
    shading = paragraph_properties.find(qn("w:shd"))
    if shading is None:
        shading = OxmlElement("w:shd")
        paragraph_properties.append(shading)
    shading.set(qn("w:val"), "clear")
    shading.set(qn("w:fill"), fill)
    if border_color:
        borders = paragraph_properties.find(qn("w:pBdr"))
        if borders is None:
            borders = OxmlElement("w:pBdr")
            paragraph_properties.append(borders)
        left = borders.find(qn("w:left"))
        if left is None:
            left = OxmlElement("w:left")
            borders.append(left)
        left.set(qn("w:val"), "single")
        left.set(qn("w:sz"), "20")
        left.set(qn("w:space"), "8")
        left.set(qn("w:color"), border_color)


def _add_metadata_line(document: DocxDocument, label: str, value: str) -> None:
    paragraph = document.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(0)
    paragraph.paragraph_format.space_after = Pt(2)
    paragraph.paragraph_format.line_spacing = 1.0
    label_run = paragraph.add_run(f"{label}: ")
    _set_run_font(label_run, size=10.5, color="000000", bold=True)
    value_run = paragraph.add_run(value or "—")
    _set_run_font(value_run, size=10.5, color="000000")


def _add_memo_masthead(
    document: DocxDocument,
    *,
    session_id: str,
    user_message: str,
    status: str,
    language: str,
) -> None:
    kicker = document.add_paragraph()
    kicker.paragraph_format.space_before = Pt(8)
    kicker.paragraph_format.space_after = Pt(4)
    kicker_run = kicker.add_run(
        _text(language, "工程韧性决策备忘录", "ENGINEERING RESILIENCE DECISION MEMO")
    )
    _set_run_font(kicker_run, size=9.5, color=_BLUE, bold=True)

    title = document.add_paragraph(style="Title")
    title.add_run(
        _text(language, "多轮会话综合报告", "Multi-round Session Report")
    )
    subtitle = document.add_paragraph(style="Subtitle")
    subtitle.add_run(
        _text(
            language,
            "计算迭代、专家修订与追问答复的会话级归档",
            "Session-level record of computations, expert revisions, and follow-up answers",
        )
    )

    status_label = (_STATUS_EN if language == "en-US" else _STATUS_ZH).get(
        status, status or "—"
    )
    metadata = (
        (
            _text(language, "会话ID", "Session ID"),
            session_id or "—",
        ),
        (_text(language, "状态", "Status"), status_label),
        (
            _text(language, "用户任务", "User request"),
            user_message or "—",
        ),
        (
            _text(language, "生成时间", "Generated"),
            datetime.now().astimezone().isoformat(timespec="seconds"),
        ),
    )
    for label, value in metadata:
        _add_metadata_line(document, label, value)
    rule = document.add_paragraph()
    rule.paragraph_format.space_before = Pt(6)
    rule.paragraph_format.space_after = Pt(10)
    _set_paragraph_bottom_border(rule)


def _add_callout(
    document: DocxDocument,
    label: str,
    text: str,
) -> None:
    paragraph = document.add_paragraph()
    paragraph.paragraph_format.left_indent = Inches(0.14)
    paragraph.paragraph_format.right_indent = Inches(0.10)
    paragraph.paragraph_format.space_before = Pt(4)
    paragraph.paragraph_format.space_after = Pt(10)
    paragraph.paragraph_format.line_spacing = 1.10
    _shade_paragraph(paragraph, _CALLOUT, _BLUE)
    label_run = paragraph.add_run(f"{label}  ")
    _set_run_font(label_run, size=11, color=_DARK_BLUE, bold=True)
    text_run = paragraph.add_run(text or "—")
    _set_run_font(text_run, size=11, color=_INK)


def _table_element(parent: Any, tag: str) -> Any:
    element = parent.find(qn(tag))
    if element is None:
        element = OxmlElement(tag)
        parent.append(element)
    return element


def _set_table_geometry(table: Any, widths_dxa: Sequence[int]) -> None:
    if sum(widths_dxa) != _CONTENT_WIDTH_DXA:
        raise ValueError("table column widths must sum to 9360 DXA")
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.autofit = False
    table_properties = table._tbl.tblPr
    table_width = _table_element(table_properties, "w:tblW")
    table_width.set(qn("w:type"), "dxa")
    table_width.set(qn("w:w"), str(_CONTENT_WIDTH_DXA))
    table_indent = _table_element(table_properties, "w:tblInd")
    table_indent.set(qn("w:type"), "dxa")
    table_indent.set(qn("w:w"), str(_TABLE_INDENT_DXA))
    layout = _table_element(table_properties, "w:tblLayout")
    layout.set(qn("w:type"), "fixed")

    borders = _table_element(table_properties, "w:tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        border = borders.find(qn(f"w:{side}"))
        if border is None:
            border = OxmlElement(f"w:{side}")
            borders.append(border)
        border.set(qn("w:val"), "single")
        border.set(qn("w:sz"), "4")
        border.set(qn("w:space"), "0")
        border.set(qn("w:color"), _BORDER)

    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths_dxa:
        column = OxmlElement("w:gridCol")
        column.set(qn("w:w"), str(width))
        grid.append(column)

    for row in table.rows:
        for index, cell in enumerate(row.cells):
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            properties = cell._tc.get_or_add_tcPr()
            cell_width = _table_element(properties, "w:tcW")
            cell_width.set(qn("w:type"), "dxa")
            cell_width.set(qn("w:w"), str(widths_dxa[index]))
            margins = _table_element(properties, "w:tcMar")
            for side, width in _TABLE_CELL_MARGINS_DXA.items():
                margin = margins.find(qn(f"w:{side}"))
                if margin is None:
                    margin = OxmlElement(f"w:{side}")
                    margins.append(margin)
                margin.set(qn("w:w"), str(width))
                margin.set(qn("w:type"), "dxa")


def _set_repeat_header(row: Any) -> None:
    properties = row._tr.get_or_add_trPr()
    header = properties.find(qn("w:tblHeader"))
    if header is None:
        header = OxmlElement("w:tblHeader")
        properties.append(header)
    header.set(qn("w:val"), "true")


def _shade_cell(cell: Any, fill: str) -> None:
    properties = cell._tc.get_or_add_tcPr()
    shading = _table_element(properties, "w:shd")
    shading.set(qn("w:val"), "clear")
    shading.set(qn("w:fill"), fill)


def _format_table_cell(cell: Any, *, header: bool = False) -> None:
    if header:
        _shade_cell(cell, _LIGHT_GRAY)
    for paragraph in cell.paragraphs:
        paragraph.paragraph_format.space_before = Pt(0)
        paragraph.paragraph_format.space_after = Pt(2)
        paragraph.paragraph_format.line_spacing = 1.0
        paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
        for run in paragraph.runs:
            _set_run_font(
                run,
                size=9.5,
                color=_DARK_BLUE if header else _INK,
                bold=True if header else None,
            )


def _comparison_rows(iterations: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    ordered = _ordered_iterations(iterations)
    current_summary = ordered[-1].get("report_summary") if ordered else {}
    for index, iteration in enumerate(ordered):
        result = _mapping(iteration.get("result"))
        snapshot = _quantitative_snapshot(iteration.get("report_summary"))
        compatibility = comparison_status(current_summary, iteration.get("report_summary"))
        if _mapping(iteration.get("report_summary")).get("target_system") != "power_system" and snapshot.get("scenario_id") not in compatibility.get("common_scenario_ids", []):
            compatibility = {"comparable": False, "reason": "different_selected_scenario", "paired": False}
        if not compatibility["comparable"]:
            snapshot.update(resilience=None, functionality_loss_area=None, recovery_duration_days=None)
        rows.append(
            {
                "iteration": _iteration_number(iteration.get("iteration"), index + 1),
                "run_id": _clean_text(iteration.get("run_id") or result.get("run_id")) or "—",
                **snapshot,
                "comparison_status": compatibility,
            }
        )
    return rows


def _add_comparison_table(
    document: DocxDocument,
    iterations: Any,
    language: str,
) -> None:
    rows = _comparison_rows(iterations)
    if not rows:
        paragraph = document.add_paragraph(
            _text(language, "当前会话没有可比较的计算轮次。", "No computation rounds are available for comparison.")
        )
        paragraph.paragraph_format.space_after = Pt(8)
        return

    headers = [
        _text(language, "轮次", "Round"),
        _text(language, "运行ID", "Run ID"),
        _text(language, "队伍数", "Teams"),
        _text(language, "主策略", "Primary strategy"),
        _text(language, "韧性指标", "Resilience"),
        _text(language, "恢复时长/天", "Recovery / days"),
        _text(language, "可比性", "Comparability"),
    ]
    table = document.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    widths = [600, 2100, 600, 1500, 1200, 1200, 2160]
    for index, text in enumerate(headers):
        table.rows[0].cells[index].text = text

    for row in rows:
        cells = table.add_row().cells
        values = [
            str(row["iteration"]),
            row["run_id"],
            _format_number(row.get("team_count"), decimals=0),
            row.get("primary_strategy") or "—",
            _format_number(row.get("resilience")),
            _format_number(row.get("recovery_duration_days"), decimals=2),
            ((_text(language, "同口径配对", "Same metric, paired")) if row["comparison_status"].get("paired") else _text(language, "同口径，非严格配对", "Same metric, unpaired"))
            if row["comparison_status"]["comparable"] else row["comparison_status"]["reason"],
        ]
        for index, value in enumerate(values):
            cells[index].text = _clean_text(value) or "—"

    _set_table_geometry(table, widths)
    _set_repeat_header(table.rows[0])
    for row_index, row in enumerate(table.rows):
        for cell in row.cells:
            _format_table_cell(cell, header=row_index == 0)

    note = document.add_paragraph()
    note.paragraph_format.space_before = Pt(4)
    note.paragraph_format.space_after = Pt(8)
    note_run = note.add_run(
        _text(
            language,
            "注：数据版本、PGA、损伤情景和指标口径须一致。共同评价期不同，连续韧性指数不作净改善比较；原轮结果继续保留。全部完工时间与目标供电达标时间分别报告。",
            "Note: data version, PGA, damage scenario and metric definitions must match. Continuous resilience indices from different comparison horizons are not treated as net improvements. All historical rounds remain retained. Repair completion and target supply time are reported separately.",
        )
    )
    _set_run_font(note_run, size=9, color=_MUTED, italic=True)


def _event_title(event: Mapping[str, Any], language: str) -> str:
    kind = event.get("kind")
    labels = {
        "calculation": _text(language, "计算轮", "Computation round"),
        "expert_revision_result": _text(language, "专家修订结果", "Expert revision result"),
        "follow_up": _text(language, "追问回答", "Follow-up answer"),
    }
    return labels.get(kind, _text(language, "会话轮次", "Session round"))


def _add_labelled_paragraph(
    document: DocxDocument,
    label: str,
    value: str,
    *,
    compact: bool = False,
) -> Any:
    paragraph = document.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(0)
    paragraph.paragraph_format.space_after = Pt(3 if compact else 6)
    paragraph.paragraph_format.line_spacing = 1.08
    label_run = paragraph.add_run(f"{label}: ")
    _set_run_font(label_run, size=10.5, color=_DARK_BLUE, bold=True)
    value_run = paragraph.add_run(value or "—")
    _set_run_font(value_run, size=10.5, color=_INK)
    return paragraph


def _keep_interaction_block_together(paragraphs: Sequence[Any]) -> None:
    """Keep one interaction readable instead of orphaning its final field."""

    for index, paragraph in enumerate(paragraphs):
        paragraph.paragraph_format.keep_together = True
        if index < len(paragraphs) - 1:
            paragraph.paragraph_format.keep_with_next = True


def _snapshot_sentence(summary: Any, language: str) -> str:
    snapshot = _quantitative_snapshot(summary)
    parts: list[str] = []
    if snapshot.get("team_count") is not None:
        parts.append(
            _text(language, "工程队伍", "teams")
            + "="
            + _format_number(snapshot["team_count"], decimals=0)
        )
    if snapshot.get("primary_strategy"):
        parts.append(
            _text(language, "主策略", "primary strategy")
            + "="
            + str(snapshot["primary_strategy"])
        )
    if snapshot.get("resilience") is not None:
        parts.append(
            _text(language, "韧性指标", "resilience")
            + "="
            + _format_number(snapshot["resilience"])
        )
    if snapshot.get("functionality_loss_area") is not None:
        parts.append(
            _text(language, "功能损失面积", "functional loss area")
            + "="
            + _format_number(snapshot["functionality_loss_area"])
        )
    if snapshot.get("recovery_duration_days") is not None:
        duration = _format_number(snapshot["recovery_duration_days"], decimals=2)
        parts.append(
            _text(language, "恢复时长", "recovery duration")
            + "="
            + duration
            + _text(language, "天", " days")
        )
    return _text(
        language,
        "；".join(parts) if parts else "本轮 report_summary 未提供上述对比指标。",
        "; ".join(parts) if parts else "The round's report_summary did not provide the comparison metrics above.",
    )


def _add_recent_interactions(
    document: DocxDocument,
    rounds: Sequence[Mapping[str, Any]],
    language: str,
) -> None:
    if not rounds:
        document.add_paragraph(
            _text(language, "当前会话没有可归档的交互轮次。", "No session interactions are available for the brief.")
        )
        return

    for event in rounds:
        block_start = len(document.paragraphs)
        heading = document.add_paragraph(style="Heading 2")
        heading.add_run(
            f"{_text(language, '第', 'Round ')}{event.get('round_number', '—')}"
            + ("轮 | " if language == "zh-CN" else " | ")
            + _event_title(event, language)
        )
        _add_labelled_paragraph(
            document,
            _text(language, "运行ID", "Run ID"),
            _clean_text(event.get("run_id")) or "—",
            compact=True,
        )
        _add_labelled_paragraph(
            document,
            _text(language, "时间", "Time"),
            _format_timestamp(event.get("timestamp")),
            compact=True,
        )

        if event.get("kind") == "follow_up":
            _add_labelled_paragraph(
                document,
                _text(language, "追问", "Question"),
                _clean_text(event.get("question")) or "—",
            )
            _add_labelled_paragraph(
                document,
                _text(language, "回答", "Answer"),
                _clean_text(event.get("answer"))
                or _text(language, "尚未形成回答。", "No answer was recorded."),
            )
            _keep_interaction_block_together(document.paragraphs[block_start:])
            continue

        trigger = _mapping(event.get("trigger_decision"))
        if trigger:
            _add_labelled_paragraph(
                document,
                _text(language, "修订触发", "Revision trigger"),
                _clean_text(trigger.get("feedback"))
                or _clean_text(trigger.get("action"))
                or "—",
            )
        _add_labelled_paragraph(
            document,
            _text(language, "本轮定量摘要", "Quantitative snapshot"),
            _snapshot_sentence(event.get("report_summary"), language),
        )
        review = _mapping(event.get("expert_decision"))
        if review:
            review_parts = [
                part
                for part in (
                    _clean_text(review.get("action")),
                    _clean_text(review.get("feedback")),
                )
                if part
            ]
            _add_labelled_paragraph(
                document,
                _text(language, "专家审查", "Expert review"),
                " | ".join(review_parts) or "—",
            )
        _keep_interaction_block_together(document.paragraphs[block_start:])


def _resolve_output_path(output_path: str | Path) -> Path:
    candidate = Path(output_path).expanduser()
    if candidate.name == SESSION_REPORT_FILENAME:
        target = candidate
    elif candidate.suffix.lower() == ".docx":
        target = candidate.with_name(SESSION_REPORT_FILENAME)
    elif candidate.exists() and candidate.is_file():
        target = candidate.parent / SESSION_REPORT_FILENAME
    else:
        target = candidate / SESSION_REPORT_FILENAME
    return target.resolve()


class SessionReportBuilder:
    """Build a session-level DOCX without re-running engineering calculations."""

    def build(
        self,
        *,
        session_id: str,
        user_message: str,
        status: str,
        iterations: Any,
        follow_ups: Any,
        final_answer: str | None,
        output_language: str = "zh-CN",
        output_path: str | Path,
    ) -> Path:
        language = _language(output_language)
        target = _resolve_output_path(output_path)
        target.parent.mkdir(parents=True, exist_ok=True)

        document = Document()
        _configure_page(document)
        _configure_styles(document)
        _configure_header_footer(document, _clean_text(session_id), language)
        document.core_properties.title = _text(
            language, "多轮会话综合报告", "Multi-round Session Report"
        )
        document.core_properties.subject = _text(
            language,
            "计算迭代、专家修订和追问答复的会话级归档",
            "Session-level archive of computations, expert revisions, and follow-up answers",
        )
        document.core_properties.author = "PowerSkillAgent"

        _add_memo_masthead(
            document,
            session_id=_clean_text(session_id),
            user_message=_clean_text(user_message),
            status=_clean_text(status),
            language=language,
        )

        ordered_iterations = _ordered_iterations(iterations)
        follow_up_items = [
            item for item in _sequence(follow_ups) if isinstance(item, Mapping)
        ]
        answered_follow_ups = sum(
            1
            for item in follow_up_items
            if _clean_text(item.get("status")).lower() == "answered"
            and _clean_text(item.get("answer"))
        )
        latest_run_id = "—"
        if ordered_iterations:
            latest = ordered_iterations[-1]
            latest_run_id = _clean_text(
                latest.get("run_id") or _mapping(latest.get("result")).get("run_id")
            ) or "—"

        document.add_heading(
            _text(language, "1. 会话摘要", "1. Session summary"), level=1
        )
        summary_text = _text(
            language,
            f"本会话共保留 {len(ordered_iterations)} 个计算轮次、{answered_follow_ups} 个已回答追问；当前结果运行ID为 {latest_run_id}。",
            f"This session retains {len(ordered_iterations)} computation round(s) and {answered_follow_ups} answered follow-up(s). The current result run ID is {latest_run_id}.",
        )
        _add_callout(
            document,
            _text(language, "归档范围", "Archive scope"),
            summary_text,
        )
        _add_labelled_paragraph(
            document,
            _text(language, "最终答复", "Final answer"),
            _clean_text(final_answer)
            or _text(language, "尚未形成最终答复。", "No final answer has been recorded."),
        )

        document.add_heading(
            _text(language, "2. 全部计算轮次对比", "2. All computation rounds"),
            level=1,
        )
        _add_comparison_table(document, ordered_iterations, language)

        document.add_heading(
            _text(language, "3. 最近四轮交互", "3. Four most recent interactions"),
            level=1,
        )
        recent_rounds = collect_session_rounds(
            ordered_iterations,
            follow_up_items,
            limit=4,
        )
        _add_recent_interactions(document, recent_rounds, language)

        document.add_heading(
            _text(language, "4. 可追溯性与使用边界", "4. Traceability and scope"),
            level=1,
        )
        scope = document.add_paragraph(
            _text(
                language,
                "本文件是会话级归档，不执行新的 Engineering Skill 计算。计算对比表及各计算轮的定量摘要仅读取已有 report_summary；专家意见、追问及最终答复按会话记录原文归档。所有工程决策仍应回查相应 run_id 的源报告、警告、假设和执行溯源。",
                "This document is a session-level archive and does not execute new Engineering Skills. The comparison table and quantitative snapshots read only existing report_summary data; expert comments, follow-ups, and the final answer are archived from the session record. Engineering decisions should still be verified against the source report, warnings, assumptions, and execution trace for each run ID.",
            )
        )
        scope.paragraph_format.space_after = Pt(6)

        temporary = target.parent / (
            f".{SESSION_REPORT_FILENAME}.{uuid.uuid4().hex}.tmp.docx"
        )
        try:
            document.save(temporary)
            if not temporary.is_file() or temporary.stat().st_size <= 0:
                raise OSError("session report was not written")
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                temporary.unlink()
        return target


def build_session_report(
    *,
    session_id: str,
    user_message: str,
    status: str,
    iterations: Any,
    follow_ups: Any,
    final_answer: str | None,
    output_language: str = "zh-CN",
    output_path: str | Path,
) -> Path:
    return SessionReportBuilder().build(
        session_id=session_id,
        user_message=user_message,
        status=status,
        iterations=iterations,
        follow_ups=follow_ups,
        final_answer=final_answer,
        output_language=output_language,
        output_path=output_path,
    )


__all__ = [
    "SESSION_REPORT_FILENAME",
    "SESSION_REPORT_MEDIA_TYPE",
    "SessionReportBuilder",
    "build_session_report",
    "collect_session_rounds",
]
