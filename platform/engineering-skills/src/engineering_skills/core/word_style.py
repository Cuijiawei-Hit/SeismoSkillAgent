from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from docx.image.image import Image as DocxImage


NAVY = "163E52"
TEAL = "0B7D77"
TEAL_DARK = "075F5B"
AMBER = "C77828"
CORAL = "B54A42"
GREEN = "28704D"
INK = "233940"
MUTED = "647982"
LINE = "CCDADD"
PALE = "F3F8F8"
PALE_TEAL = "E8F4F2"
PALE_AMBER = "FFF5E8"
WHITE = "FFFFFF"


def _rgb(hex_color: str) -> RGBColor:
    value = hex_color.lstrip("#")
    return RGBColor.from_string(value)


def set_cell_shading(cell: Any, color: str) -> None:
    properties = cell._tc.get_or_add_tcPr()
    shading = properties.find(qn("w:shd"))
    if shading is None:
        shading = OxmlElement("w:shd")
        properties.append(shading)
    shading.set(qn("w:fill"), color.lstrip("#"))


def _set_cell_margins(cell: Any, *, top: int = 80, start: int = 95, bottom: int = 80, end: int = 95) -> None:
    properties = cell._tc.get_or_add_tcPr()
    margins = properties.first_child_found_in("w:tcMar")
    if margins is None:
        margins = OxmlElement("w:tcMar")
        properties.append(margins)
    for name, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn(f"w:{name}"))
        if node is None:
            node = OxmlElement(f"w:{name}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def _set_paragraph_border(paragraph: Any, *, bottom: str | None = None, left: str | None = None) -> None:
    properties = paragraph._p.get_or_add_pPr()
    borders = properties.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        properties.append(borders)
    for edge, color in (("bottom", bottom), ("left", left)):
        if not color:
            continue
        node = borders.find(qn(f"w:{edge}"))
        if node is None:
            node = OxmlElement(f"w:{edge}")
            borders.append(node)
        node.set(qn("w:val"), "single")
        node.set(qn("w:sz"), "12" if edge == "left" else "6")
        node.set(qn("w:space"), "5")
        node.set(qn("w:color"), color)


def _keep_with_next(paragraph: Any) -> None:
    properties = paragraph._p.get_or_add_pPr()
    if properties.find(qn("w:keepNext")) is None:
        properties.append(OxmlElement("w:keepNext"))
    if properties.find(qn("w:keepLines")) is None:
        properties.append(OxmlElement("w:keepLines"))


def _set_repeat_header(row: Any) -> None:
    properties = row._tr.get_or_add_trPr()
    if properties.find(qn("w:tblHeader")) is None:
        repeat = OxmlElement("w:tblHeader")
        repeat.set(qn("w:val"), "true")
        properties.append(repeat)


def _prevent_row_split(row: Any) -> None:
    properties = row._tr.get_or_add_trPr()
    if properties.find(qn("w:cantSplit")) is None:
        properties.append(OxmlElement("w:cantSplit"))


def _page_field(paragraph: Any) -> None:
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instruction = OxmlElement("w:instrText")
    instruction.set(qn("xml:space"), "preserve")
    instruction.text = " PAGE "
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.extend([begin, instruction, separate, end])


def _font(run: Any, *, language: str, size: float, color: str = INK, bold: bool = False) -> None:
    run.font.name = "Arial"
    run._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    run.font.size = Pt(size)
    run.font.color.rgb = _rgb(color)
    run.font.bold = bold


def configure_report_document(
    document: Document,
    *,
    language: str,
    report_title: str,
    run_id: str = "",
    orientation: str = "landscape",
) -> None:
    section = document.sections[0]
    if orientation == "landscape":
        section.orientation = WD_ORIENT.LANDSCAPE
        section.page_width = Cm(29.7)
        section.page_height = Cm(21.0)
        horizontal_margin = 1.35
    else:
        section.orientation = WD_ORIENT.PORTRAIT
        section.page_width = Cm(21.0)
        section.page_height = Cm(29.7)
        horizontal_margin = 1.65
    section.top_margin = Cm(1.25)
    section.bottom_margin = Cm(1.2)
    section.left_margin = Cm(horizontal_margin)
    section.right_margin = Cm(horizontal_margin)
    section.header_distance = Cm(0.55)
    section.footer_distance = Cm(0.55)

    east_asia = "Microsoft YaHei"
    styles = document.styles
    normal = styles["Normal"]
    normal.font.name = "Arial"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), east_asia)
    normal.font.size = Pt(9.5)
    normal.font.color.rgb = _rgb(INK)
    normal.paragraph_format.space_after = Pt(5)
    normal.paragraph_format.line_spacing = 1.25

    style_specs = {
        "Title": (25, NAVY, True, 0, 10),
        "Heading 1": (15, NAVY, True, 14, 7),
        "Heading 2": (11.5, TEAL_DARK, True, 10, 5),
        "Heading 3": (10, INK, True, 8, 4),
    }
    for style_name, (size, color, bold, before, after) in style_specs.items():
        style = styles[style_name]
        style.font.name = "Arial"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), east_asia)
        style.font.size = Pt(size)
        style.font.color.rgb = _rgb(color)
        style.font.bold = bold
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    if "Report Kicker" not in styles:
        kicker = styles.add_style("Report Kicker", WD_STYLE_TYPE.PARAGRAPH)
    else:
        kicker = styles["Report Kicker"]
    kicker.font.name = "Arial"
    kicker._element.rPr.rFonts.set(qn("w:eastAsia"), east_asia)
    kicker.font.size = Pt(8.5)
    kicker.font.bold = True
    kicker.font.color.rgb = _rgb(TEAL)
    kicker.paragraph_format.space_after = Pt(4)

    if "Report Subtitle" not in styles:
        subtitle = styles.add_style("Report Subtitle", WD_STYLE_TYPE.PARAGRAPH)
    else:
        subtitle = styles["Report Subtitle"]
    subtitle.font.name = "Arial"
    subtitle._element.rPr.rFonts.set(qn("w:eastAsia"), east_asia)
    subtitle.font.size = Pt(11)
    subtitle.font.color.rgb = _rgb(MUTED)
    subtitle.paragraph_format.space_after = Pt(10)

    if "Report Caption" not in styles:
        caption = styles.add_style("Report Caption", WD_STYLE_TYPE.PARAGRAPH)
    else:
        caption = styles["Report Caption"]
    caption.font.name = "Arial"
    caption._element.rPr.rFonts.set(qn("w:eastAsia"), east_asia)
    caption.font.size = Pt(8.5)
    caption.font.color.rgb = _rgb(MUTED)
    caption.paragraph_format.space_before = Pt(3)
    caption.paragraph_format.space_after = Pt(8)
    caption.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    caption.paragraph_format.keep_with_next = False

    for section_item in document.sections:
        header = section_item.header
        header.is_linked_to_previous = False
        header_paragraph = header.paragraphs[0]
        header_paragraph.text = report_title
        header_paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
        _set_paragraph_border(header_paragraph, bottom=LINE)
        for run in header_paragraph.runs:
            _font(run, language=language, size=7.5, color=MUTED, bold=True)

        footer = section_item.footer
        footer.is_linked_to_previous = False
        footer_paragraph = footer.paragraphs[0]
        footer_paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        label = "运行标识" if language != "en-US" else "Run"
        if run_id:
            run = footer_paragraph.add_run(f"{label} {run_id}   |   ")
            _font(run, language=language, size=7.5, color=MUTED)
        page_label = "第 " if language != "en-US" else "Page "
        run = footer_paragraph.add_run(page_label)
        _font(run, language=language, size=7.5, color=MUTED)
        _page_field(footer_paragraph)


def add_cover_page(
    document: Document,
    *,
    language: str,
    kicker: str,
    title: str,
    subtitle: str,
    metadata: Sequence[tuple[str, Any]],
    metrics: Sequence[tuple[str, Any, str]],
    notice: str,
) -> None:
    band = document.add_table(rows=1, cols=2)
    band.alignment = WD_TABLE_ALIGNMENT.CENTER
    band.autofit = False
    band.columns[0].width = Cm(17.0)
    band.columns[1].width = Cm(9.6)
    for cell in band.rows[0].cells:
        set_cell_shading(cell, NAVY)
        _set_cell_margins(cell, top=95, bottom=95, start=140, end=140)
    left = band.cell(0, 0).paragraphs[0]
    left.alignment = WD_ALIGN_PARAGRAPH.LEFT
    left_run = left.add_run("SEISMOSKILL AGENT")
    _font(left_run, language=language, size=9, color=WHITE, bold=True)
    right = band.cell(0, 1).paragraphs[0]
    right.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    right_run = right.add_run(kicker.upper())
    _font(right_run, language=language, size=8.5, color="B7DBD7", bold=True)

    document.add_paragraph()
    kicker_paragraph = document.add_paragraph(kicker, style="Report Kicker")
    _keep_with_next(kicker_paragraph)
    heading = document.add_heading(title, 0)
    heading.alignment = WD_ALIGN_PARAGRAPH.LEFT
    _set_paragraph_border(heading, bottom=TEAL)
    subtitle_paragraph = document.add_paragraph(subtitle, style="Report Subtitle")
    subtitle_paragraph.paragraph_format.space_after = Pt(14)

    columns = min(3, max(1, len(metadata)))
    meta_table = document.add_table(rows=0, cols=columns)
    meta_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    meta_table.autofit = True
    for start in range(0, len(metadata), columns):
        cells = meta_table.add_row().cells
        for index, cell in enumerate(cells):
            item_index = start + index
            _set_cell_margins(cell, top=105, bottom=105, start=120, end=120)
            set_cell_shading(cell, PALE)
            if item_index >= len(metadata):
                continue
            label, value = metadata[item_index]
            label_paragraph = cell.paragraphs[0]
            label_run = label_paragraph.add_run(str(label))
            _font(label_run, language=language, size=7.5, color=MUTED, bold=True)
            value_paragraph = cell.add_paragraph(str(value or "—"))
            value_run = value_paragraph.runs[0]
            _font(value_run, language=language, size=9.5, color=NAVY, bold=True)

    document.add_paragraph()
    metric_table = document.add_table(rows=1, cols=max(1, len(metrics)))
    metric_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    metric_table.autofit = True
    for index, (label, value, detail) in enumerate(metrics):
        cell = metric_table.cell(0, index)
        _set_cell_margins(cell, top=140, bottom=140, start=130, end=130)
        set_cell_shading(cell, PALE_TEAL if index != len(metrics) - 1 else PALE_AMBER)
        label_paragraph = cell.paragraphs[0]
        label_run = label_paragraph.add_run(str(label))
        _font(label_run, language=language, size=7.5, color=MUTED, bold=True)
        value_paragraph = cell.add_paragraph(str(value or "—"))
        value_paragraph.paragraph_format.space_before = Pt(3)
        value_run = value_paragraph.runs[0]
        _font(value_run, language=language, size=17, color=NAVY if index != len(metrics) - 1 else CORAL, bold=True)
        if detail:
            detail_paragraph = cell.add_paragraph(str(detail))
            detail_run = detail_paragraph.runs[0]
            _font(detail_run, language=language, size=7.5, color=MUTED)

    document.add_paragraph()
    add_callout(document, notice, tone="review", language=language)
    document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def add_callout(document: Document, text: str, *, tone: str = "info", language: str = "zh-CN") -> None:
    tones = {
        "info": (TEAL, PALE_TEAL),
        "review": (AMBER, PALE_AMBER),
        "danger": (CORAL, "FCEDEC"),
        "success": (GREEN, "EAF5EE"),
    }
    accent, fill = tones.get(tone, tones["info"])
    table = document.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = table.cell(0, 0)
    set_cell_shading(cell, fill)
    _set_cell_margins(cell, top=105, bottom=105, start=145, end=145)
    paragraph = cell.paragraphs[0]
    _set_paragraph_border(paragraph, left=accent)
    run = paragraph.add_run(text)
    _font(run, language=language, size=8.8, color=INK, bold=False)


def add_report_table(
    document: Document,
    headers: Sequence[str],
    rows: Iterable[Sequence[Any]],
    *,
    language: str = "zh-CN",
    widths: Sequence[float] | None = None,
    align_center: bool = True,
    header_color: str = NAVY,
) -> Any:
    materialized_rows = list(rows)
    keep_short_table = len(materialized_rows) <= 8 and sum(
        len(str(value)) for row in materialized_rows for value in row
    ) <= 1600
    table = document.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.style = "Table Grid"
    if widths:
        table.autofit = False
        layout = OxmlElement("w:tblLayout")
        layout.set(qn("w:type"), "fixed")
        table._tbl.tblPr.append(layout)
    font_size = 7.8 if len(headers) >= 8 else 8.3 if len(headers) >= 6 else 8.8
    header_row = table.rows[0]
    _set_repeat_header(header_row)
    _prevent_row_split(header_row)
    for index, label in enumerate(headers):
        cell = header_row.cells[index]
        cell.text = str(label)
        set_cell_shading(cell, header_color)
        _set_cell_margins(cell, top=80, bottom=80)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        for paragraph in cell.paragraphs:
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            paragraph.paragraph_format.keep_with_next = True
            for run in paragraph.runs:
                _font(run, language=language, size=font_size, color=WHITE, bold=True)
    for row_index, row in enumerate(materialized_rows):
        cells = table.add_row().cells
        _prevent_row_split(table.rows[-1])
        for index, value in enumerate(row):
            cells[index].text = "—" if value is None or value == "" else str(value)
            cells[index].vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            _set_cell_margins(cells[index], top=72, bottom=72)
            if row_index % 2 == 1:
                set_cell_shading(cells[index], PALE)
            for paragraph in cells[index].paragraphs:
                paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER if align_center else WD_ALIGN_PARAGRAPH.LEFT
                paragraph.paragraph_format.space_after = Pt(0)
                paragraph.paragraph_format.line_spacing = 1.1
                paragraph.paragraph_format.keep_with_next = keep_short_table and row_index < len(materialized_rows) - 1
                for run in paragraph.runs:
                    _font(run, language=language, size=font_size, color=INK)
    if widths:
        for index, width in enumerate(widths):
            table.columns[index].width = Cm(width)
        for table_row in table.rows:
            for index, width in enumerate(widths):
                table_row.cells[index].width = Cm(width)
    return table


def add_report_figure(
    document: Document,
    path: Any,
    caption: str,
    *,
    width_inches: float = 9.4,
) -> None:
    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.paragraph_format.keep_with_next = True
    paragraph.paragraph_format.space_before = Pt(4)
    paragraph.paragraph_format.space_after = Pt(0)
    paragraph.paragraph_format.line_spacing = 1
    run = paragraph.add_run()
    section = document.sections[-1]
    available_width = section.page_width - section.left_margin - section.right_margin
    available_height = section.page_height - section.top_margin - section.bottom_margin
    bitmap = DocxImage.from_file(str(path))
    aspect = bitmap.px_width / bitmap.px_height
    height = min(available_height * .68, Cm(11.7), min(available_width, Cm(width_inches * 2.54)) / aspect)
    run.add_picture(str(path), width=int(height * aspect), height=int(height))
    caption_paragraph = document.add_paragraph(caption, style="Report Caption")
    caption_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    caption_paragraph.paragraph_format.keep_with_next = False


def add_section_heading(document: Document, number: str, title: str, *, level: int = 1) -> Any:
    paragraph = document.add_heading(f"{number}  {title}", level=level)
    if level == 1:
        _set_paragraph_border(paragraph, bottom=LINE)
    _keep_with_next(paragraph)
    return paragraph
