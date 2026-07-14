#!/usr/bin/env python3
"""
Generate an HTML click replay report from MTurk metrics exported as .xlsx.

This script is intentionally standalone. It uses only Python standard-library
modules and does not import code from the MTurk study app.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import mimetypes
import os
import re
import sys
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "officeRel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


REQUIRED_COLUMNS = [
    "session_id",
    "participant_id",
    "workerId",
    "screen_name",
    "question_asked",
    "final_answer",
    "all_clicked_elements",
    "click_count",
    "is_correct",
    "time_spent_ms",
]


def column_index(cell_ref: str) -> int:
    letters = "".join(ch for ch in cell_ref if ch.isalpha()).upper()
    index = 0
    for ch in letters:
        index = index * 26 + (ord(ch) - ord("A") + 1)
    return index - 1


def read_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        raw = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []

    root = ET.fromstring(raw)
    strings: list[str] = []
    for si in root.findall("main:si", NS):
        text_parts = [node.text or "" for node in si.findall(".//main:t", NS)]
        strings.append("".join(text_parts))
    return strings


def first_sheet_path(archive: zipfile.ZipFile) -> str:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    first_sheet = workbook.find("main:sheets/main:sheet", NS)
    if first_sheet is None:
        raise ValueError("Workbook does not contain any sheets.")

    rel_id = first_sheet.attrib.get(f"{{{NS['officeRel']}}}id")
    if not rel_id:
        return "xl/worksheets/sheet1.xml"

    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    for rel in rels.findall("rel:Relationship", NS):
        if rel.attrib.get("Id") == rel_id:
            target = rel.attrib["Target"].lstrip("/")
            return target if target.startswith("xl/") else f"xl/{target}"

    return "xl/worksheets/sheet1.xml"


def cell_text(cell: ET.Element, shared_strings: list[str]) -> str:
    cell_type = cell.attrib.get("t", "")

    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//main:t", NS))

    value = cell.find("main:v", NS)
    if value is None or value.text is None:
        return ""

    raw_value = value.text
    if cell_type == "s":
        try:
            return shared_strings[int(raw_value)]
        except (ValueError, IndexError):
            return ""
    if cell_type == "b":
        return "TRUE" if raw_value == "1" else "FALSE"
    return raw_value


def read_xlsx_rows(path: Path) -> list[dict[str, str]]:
    if path.suffix.lower() != ".xlsx":
        raise ValueError("Expected a .xlsx file.")

    with zipfile.ZipFile(path) as archive:
        shared_strings = read_shared_strings(archive)
        sheet_path = first_sheet_path(archive)
        sheet = ET.fromstring(archive.read(sheet_path))

    rows: list[list[str]] = []
    for row in sheet.findall(".//main:sheetData/main:row", NS):
        values: dict[int, str] = {}
        for cell in row.findall("main:c", NS):
            ref = cell.attrib.get("r", "")
            if not ref:
                continue
            values[column_index(ref)] = cell_text(cell, shared_strings)
        if values:
            max_index = max(values)
            rows.append([values.get(index, "") for index in range(max_index + 1)])

    if not rows:
        return []

    headers = [header.strip() for header in rows[0]]
    records: list[dict[str, str]] = []
    for row in rows[1:]:
        record = {headers[index]: row[index] if index < len(row) else "" for index in range(len(headers))}
        records.append(record)
    return records


def parse_clicks(value: str) -> list[dict[str, Any]]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []

    clicks = []
    for item in parsed:
        if isinstance(item, dict):
            clicks.append(item)
    clicks.sort(key=lambda click: str(click.get("timestamp", "")))
    return clicks


def image_to_data_uri(path: Path | None) -> str:
    if not path:
        return ""
    if not path.exists():
        raise FileNotFoundError(f"Dashboard image not found: {path}")

    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def clean_record(record: dict[str, str]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in record.items():
        cleaned[key] = value
    cleaned["clicks"] = parse_clicks(record.get("all_clicked_elements", ""))
    return cleaned


def build_report(
    records: list[dict[str, str]],
    dashboard_image_uri: str,
    title: str,
    dashboard_origin_x: float,
    dashboard_origin_y: float,
    dashboard_width: float | None,
    dashboard_height: float | None,
) -> str:
    missing = [column for column in REQUIRED_COLUMNS if column not in (records[0].keys() if records else [])]
    report_data = [clean_record(record) for record in records]
    payload = json.dumps(report_data, ensure_ascii=False)
    escaped_title = html.escape(title)
    missing_html = ""
    if missing:
        missing_html = (
            "<div class=\"warning\">Missing expected column(s): "
            + html.escape(", ".join(missing))
            + "</div>"
        )

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{escaped_title}</title>
  <style>
    :root {{
      font-family: Arial, sans-serif;
      color: #172033;
      background: #eef2f7;
    }}
    body {{
      margin: 0;
      min-height: 100vh;
    }}
    .app {{
      display: grid;
      grid-template-columns: 22rem minmax(0, 1fr);
      gap: 1rem;
      padding: 1rem;
    }}
    .panel, .viewer {{
      border: 1px solid #c4ccd8;
      border-radius: 0.75rem;
      background: #ffffff;
      box-shadow: 0 0.75rem 2rem rgba(12, 18, 28, 0.12);
    }}
    .panel {{
      padding: 1rem;
      display: grid;
      gap: 0.75rem;
      align-content: start;
    }}
    h1 {{
      margin: 0;
      font-size: 1.35rem;
    }}
    label {{
      display: grid;
      gap: 0.3rem;
      font-weight: 700;
    }}
    select, button {{
      min-height: 2.5rem;
      border: 1px solid #98a4b5;
      border-radius: 0.45rem;
      padding: 0.35rem 0.65rem;
      font: inherit;
    }}
    button {{
      background: #286da8;
      color: #ffffff;
      cursor: pointer;
      font-weight: 700;
    }}
    .nav {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.5rem;
    }}
    .meta {{
      display: grid;
      gap: 0.35rem;
      font-size: 0.95rem;
      line-height: 1.35;
    }}
    .meta strong {{
      color: #0f3052;
    }}
    .warning {{
      padding: 0.75rem;
      border: 1px solid #d97706;
      border-radius: 0.5rem;
      background: #fff7ed;
      color: #7c2d12;
      font-weight: 700;
    }}
    .viewer {{
      padding: 1rem;
      min-width: 0;
    }}
    .question {{
      margin: 0 0 0.8rem;
      font-size: 1.25rem;
      line-height: 1.3;
    }}
    .canvas-wrap {{
      position: relative;
      width: 100%;
      max-height: calc(100vh - 10rem);
      aspect-ratio: 16 / 9;
      border: 2px solid #111827;
      border-radius: 0.55rem;
      background: #222936;
      overflow: hidden;
    }}
    .dashboard-image {{
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #111827;
    }}
    .placeholder {{
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #ffffff;
      font-size: 1.4rem;
      background:
        linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px),
        linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px),
        #222936;
      background-size: 4rem 4rem;
    }}
    .target-rect {{
      position: absolute;
      border: 3px solid rgba(41, 182, 246, 0.9);
      border-radius: 0.45rem;
      background: rgba(41, 182, 246, 0.16);
      box-shadow: 0 0 0.9rem rgba(41, 182, 246, 0.55);
      pointer-events: none;
    }}
    .target-rect-label {{
      position: absolute;
      left: 0.25rem;
      top: 0.2rem;
      max-width: calc(100% - 0.5rem);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0.12rem 0.35rem;
      border-radius: 0.25rem;
      background: rgba(2, 6, 23, 0.82);
      color: #ffffff;
      font-size: 0.78rem;
      font-weight: 800;
    }}
    .marker {{
      position: absolute;
      transform: translate(-50%, -50%);
      display: grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      border: 3px solid #111827;
      border-radius: 50%;
      background: #ffeb3b;
      color: #111827;
      font-weight: 900;
      box-shadow: 0 0 0 3px rgba(255,255,255,.9), 0 0.5rem 1rem rgba(0,0,0,.35);
    }}
    .click-list {{
      margin-top: 0.8rem;
      display: grid;
      gap: 0.3rem;
      font-size: 0.95rem;
    }}
    .click-list code {{
      background: #f1f5f9;
      padding: 0.1rem 0.25rem;
      border-radius: 0.25rem;
    }}
  </style>
</head>
<body>
  <main class="app">
    <aside class="panel">
      <h1>{escaped_title}</h1>
      {missing_html}
      <label>
        Participant
        <select id="participantSelect"></select>
      </label>
      <label>
        Question / Screen
        <select id="rowSelect"></select>
      </label>
      <div class="nav">
        <button id="prevButton" type="button">Previous</button>
        <button id="nextButton" type="button">Next</button>
      </div>
      <div class="meta" id="meta"></div>
    </aside>
    <section class="viewer">
      <h2 class="question" id="question"></h2>
      <div class="canvas-wrap" id="canvasWrap">
        {"<img class=\"dashboard-image\" src=\"" + dashboard_image_uri + "\" alt=\"Dashboard screenshot\" />" if dashboard_image_uri else "<div class=\"placeholder\">No dashboard screenshot provided</div>"}
      </div>
      <div class="click-list" id="clickList"></div>
    </section>
  </main>
  <script>
    const records = {payload};
    const dashboardOrigin = {{
      x: {dashboard_origin_x},
      y: {dashboard_origin_y},
      width: {json.dumps(dashboard_width)},
      height: {json.dumps(dashboard_height)},
    }};
    const participantSelect = document.getElementById('participantSelect');
    const rowSelect = document.getElementById('rowSelect');
    const prevButton = document.getElementById('prevButton');
    const nextButton = document.getElementById('nextButton');
    const meta = document.getElementById('meta');
    const question = document.getElementById('question');
    const canvasWrap = document.getElementById('canvasWrap');
    const clickList = document.getElementById('clickList');

    const participantKey = (record) => record.participant_id || record.workerId || record.session_id || 'unknown';
    const participants = [...new Set(records.map(participantKey))];
    let currentParticipant = participants[0] || '';
    let currentIndex = 0;

    function participantRows() {{
      return records.filter((record) => participantKey(record) === currentParticipant);
    }}

    function setOptions() {{
      participantSelect.innerHTML = participants.map((id) => `<option value="${{escapeAttr(id)}}">${{escapeHtml(id)}}</option>`).join('');
      participantSelect.value = currentParticipant;
      const rows = participantRows();
      rowSelect.innerHTML = rows.map((record, index) => {{
        const label = `${{index + 1}}. ${{record.screen_name || 'Screen'}} - ${{record.question_asked || ''}}`;
        return `<option value="${{index}}">${{escapeHtml(label)}}</option>`;
      }}).join('');
      currentIndex = Math.max(0, Math.min(currentIndex, rows.length - 1));
      rowSelect.value = String(currentIndex);
    }}

    function escapeHtml(value) {{
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({{
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }}[ch]));
    }}

    function escapeAttr(value) {{
      return escapeHtml(value).replace(/`/g, '&#96;');
    }}

    function asNumber(value) {{
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }}

    function getViewportSize(record) {{
      return {{
        width: asNumber(clickValue(record, 'viewport_width')) || asNumber(record.screen_width) || 1920,
        height: asNumber(clickValue(record, 'viewport_height')) || asNumber(record.screen_height) || 1080,
      }};
    }}

    function clickValue(record, key) {{
      for (const click of record.clicks || []) {{
        if (click[key] !== undefined && click[key] !== '') return click[key];
      }}
      return '';
    }}

    function rectCenter(rect) {{
      if (!rect) return null;
      const left = asNumber(rect.left);
      const top = asNumber(rect.top);
      const width = asNumber(rect.width);
      const height = asNumber(rect.height);
      if (left === null || top === null || width === null || height === null) return null;
      return {{ x: left + width / 2, y: top + height / 2 }};
    }}

    function pointToPercent(point, record) {{
      const viewport = getViewportSize(record);
      return {{
        left: `${{Math.max(0, Math.min(100, (point.x / viewport.width) * 100))}}%`,
        top: `${{Math.max(0, Math.min(100, (point.y / viewport.height) * 100))}}%`,
      }};
    }}

    function markerPosition(click, record) {{
      const clientX = asNumber(click.client_x);
      const clientY = asNumber(click.client_y);
      if (clientX !== null && clientY !== null) {{
        return pointToPercent({{ x: clientX, y: clientY }}, record);
      }}

      const targetCenter = rectCenter(click.target_rect);
      if (targetCenter) {{
        return pointToPercent(targetCenter, record);
      }}

      const x = asNumber(click.x);
      const y = asNumber(click.y);
      if (x === null || y === null) return null;

      const sourceWidth = dashboardOrigin.width || asNumber(record.screen_width);
      const sourceHeight = dashboardOrigin.height || asNumber(record.screen_height);
      if (sourceWidth && sourceHeight) {{
        return {{
          left: `${{Math.max(0, Math.min(100, ((dashboardOrigin.x + x) / sourceWidth) * 100))}}%`,
          top: `${{Math.max(0, Math.min(100, ((dashboardOrigin.y + y) / sourceHeight) * 100))}}%`,
        }};
      }}

      return {{ left: `${{dashboardOrigin.x + x}}px`, top: `${{dashboardOrigin.y + y}}px` }};
    }}

    function rectPosition(rect, record) {{
      if (!rect) return null;
      const viewport = getViewportSize(record);
      const left = asNumber(rect.left);
      const top = asNumber(rect.top);
      const width = asNumber(rect.width);
      const height = asNumber(rect.height);
      if (left === null || top === null || width === null || height === null) return null;
      return {{
        left: `${{(left / viewport.width) * 100}}%`,
        top: `${{(top / viewport.height) * 100}}%`,
        width: `${{(width / viewport.width) * 100}}%`,
        height: `${{(height / viewport.height) * 100}}%`,
      }};
    }}

    function renderTargetRects(record, clicks) {{
      const seen = new Set();
      clicks.forEach((click) => {{
        const rect = rectPosition(click.target_rect, record);
        if (!rect) return;
        const key = `${{click.element_clicked}}:${{rect.left}}:${{rect.top}}:${{rect.width}}:${{rect.height}}`;
        if (seen.has(key)) return;
        seen.add(key);
        const node = document.createElement('div');
        node.className = 'target-rect';
        node.style.left = rect.left;
        node.style.top = rect.top;
        node.style.width = rect.width;
        node.style.height = rect.height;
        const label = document.createElement('span');
        label.className = 'target-rect-label';
        label.textContent = click.element_clicked || 'clicked element';
        node.appendChild(label);
        canvasWrap.appendChild(node);
      }});
    }}

    function render() {{
      setOptions();
      const rows = participantRows();
      const record = rows[currentIndex];
      canvasWrap.querySelectorAll('.marker').forEach((node) => node.remove());
      canvasWrap.querySelectorAll('.target-rect').forEach((node) => node.remove());
      if (!record) {{
        question.textContent = 'No records found.';
        meta.innerHTML = '';
        clickList.innerHTML = '';
        return;
      }}

      const viewport = getViewportSize(record);
      canvasWrap.style.aspectRatio = `${{viewport.width}} / ${{viewport.height}}`;
      question.textContent = record.question_asked || record.screen_name || 'Screen';
      meta.innerHTML = `
        <div><strong>Session:</strong> ${{escapeHtml(record.session_id)}}</div>
        <div><strong>Participant:</strong> ${{escapeHtml(participantKey(record))}}</div>
        <div><strong>Screen:</strong> ${{escapeHtml(record.screen_name)}}</div>
        <div><strong>Final answer:</strong> ${{escapeHtml(record.final_answer)}}</div>
        <div><strong>Correct:</strong> ${{escapeHtml(record.is_correct)}}</div>
        <div><strong>Time spent:</strong> ${{escapeHtml(record.time_spent_ms)}} ms</div>
        <div><strong>Click count:</strong> ${{escapeHtml(record.click_count ?? record.clicks?.length ?? 0)}}</div>
      `;

      const clicks = [...(record.clicks || [])].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
      renderTargetRects(record, clicks);
      const validClicks = [];
      clicks.forEach((click, index) => {{
        const position = markerPosition(click, record);
        if (!position) return;
        const marker = document.createElement('div');
        marker.className = 'marker';
        marker.textContent = String(index + 1);
        marker.title = `${{index + 1}}. ${{click.element_clicked || ''}} ${{click.timestamp || ''}}`;
        marker.style.left = position.left;
        marker.style.top = position.top;
        canvasWrap.appendChild(marker);
        validClicks.push(click);
      }});

      clickList.innerHTML = clicks.length
        ? clicks.map((click, index) => `
          <div>
            <strong>${{index + 1}}.</strong>
            <code>${{escapeHtml(click.element_clicked || '')}}</code>
            ${{escapeHtml(click.timestamp || '')}}
            ${{click.x !== undefined && click.y !== undefined ? `(${{escapeHtml(click.x)}}, ${{escapeHtml(click.y)}})` : '(no coordinates)'}}
          </div>
        `).join('')
        : '<div>No clicks recorded for this row.</div>';
    }}

    participantSelect.addEventListener('change', () => {{
      currentParticipant = participantSelect.value;
      currentIndex = 0;
      render();
    }});
    rowSelect.addEventListener('change', () => {{
      currentIndex = Number(rowSelect.value) || 0;
      render();
    }});
    prevButton.addEventListener('click', () => {{
      currentIndex = Math.max(0, currentIndex - 1);
      render();
    }});
    nextButton.addEventListener('click', () => {{
      currentIndex = Math.min(participantRows().length - 1, currentIndex + 1);
      render();
    }});

    render();
  </script>
</body>
</html>"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a visual click replay HTML report from MTurk metrics .xlsx.")
    parser.add_argument("--excel", required=True, help="Path to mturk_metrics.xlsx")
    parser.add_argument("--dashboard-image", default="", help="Optional dashboard screenshot to place markers on")
    parser.add_argument("--dashboard-origin-x", type=float, default=0, help="X offset where the dashboard/tablet starts inside the screenshot")
    parser.add_argument("--dashboard-origin-y", type=float, default=0, help="Y offset where the dashboard/tablet starts inside the screenshot")
    parser.add_argument("--dashboard-width", type=float, default=None, help="Width of the screenshot coordinate space. Defaults to recorded screen_width.")
    parser.add_argument("--dashboard-height", type=float, default=None, help="Height of the screenshot coordinate space. Defaults to recorded screen_height.")
    parser.add_argument("--out", default="click_replay_report.html", help="Output HTML file")
    parser.add_argument("--title", default="MTurk Click Replay", help="Report title")
    args = parser.parse_args()

    excel_path = Path(args.excel)
    dashboard_path = Path(args.dashboard_image) if args.dashboard_image else None
    out_path = Path(args.out)

    records = read_xlsx_rows(excel_path)
    image_uri = image_to_data_uri(dashboard_path)
    html_report = build_report(
        records,
        image_uri,
        args.title,
        args.dashboard_origin_x,
        args.dashboard_origin_y,
        args.dashboard_width,
        args.dashboard_height,
    )
    out_path.write_text(html_report, encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"Loaded {len(records)} row(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
