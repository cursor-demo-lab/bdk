#!/usr/bin/env python3
"""Fail when a stat title or table header cannot fit at 1280 / 1600 / 1920.

    python3 tools/layout_check.py
    python3 tools/layout_check.py --renders /opt/cursor/artifacts/renders

Title fit uses a conservative 9 px/char at the 12 px stat title size.
Table headers fail when a fixed/min width is narrower than the header text
or the expected cell content (Service, Path, PR, …).
When --renders is a directory of PNG screenshots, any file whose name contains
`error-icon` or whose companion `.errors.json` lists a panel is a failure.
A whole-dashboard Grafana crash ("An unexpected error happened") does not
produce a per-panel error icon: also fail on `*.crash.json`, `*.page.json`
with ok=false / error, filenames that mark a page crash, and any sidecar
that contains that Grafana Cloud (13.1+; verified on 13.3.0) banner
(`GRAFANA_BANNER`).
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from generate import (  # noqa: E402
    DASHBOARD_FILES, GRAFANA_BANNER, WIDTH_BUDGET_1280, check_column_width_budgets,
    iter_panels, palette_alarm_findings,
)

VIEWPORTS = (1280, 1600, 1920)
# 9 px/char at the 14 px stat title size.
CHAR_PX = 9
TITLE_PAD = 24
# A stat header loses ~101 px to the info icon and its padding (measured in
# r14: 96 px of text in a 197 px w=4 header), and another 24 px per link
# icon. ~8.5 px/char at the 14 px title ⇒ about 11 chars at w=4 (8 with a
# link), which is why the Now stats carry no "· 15m" suffix.
STAT_TITLE_CHROME = 101
LINK_ICON_PX = 24
STAT_CHAR_PX = 8.5
# Table headers are ~13 px; 8 px/char plus 12 px pad still fails a "Co…" Count.
HEADER_CHAR_PX = 8.0
HEADER_PAD = 12
# Cell content (not the header) that layout_check used to miss: Service 70
# passed while factory-security-reviewer clipped.
CONTENT_CHAR_PX = 7.0
CONTENT_PAD = 12
CONTENT_CHARS = {
    "Service": 24,
    "Path": 28,
    "Route": 30,
    "PR": 22,
    "Kind": 26,
    "Span": 22,
    "Trace": 19,
    "Cloud agent": 39,
    "Slug": 20,
    "Event type": 31,
    "Start time": 19,
    "Time": 19,
}
# Every column of a table needs custom.width or a custom.minWidth floor, and
# the fixed + floor sum must fit WIDTH_BUDGET_1280 or a trailing column clips.
# The variable bar must stay one line at 1280 (r14: Logs wrapped once a
# service was selected). Approximate: each visible chip is padding + label +
# its longest value; controls (time picker, refresh, links) take the rest.
VAR_CONTROLS_PX = 420
VAR_CHIP_PAD = 64
VAR_CHAR_PX = 8
TEXTBOX_INPUT_PX = 160
PAGE_CRASH = re.compile(
    r"an unexpected error happened|dashboard failed to load|page crashed|"
    r"panel error|error icon",
    re.I,
)
PAGE_CRASH_NAME = ("error-icon", "dashboard-crash", "page-error", "unexpected-error",
                   "panel-error")
# Grafana panel-error icon (rgb 209,14,92). Render harness should write
# *.errors.json or a filename containing error-icon / panel-error, then
# re-render once before treating a lone hit as a failure.


def panel_px(spec: tuple) -> int:
    cols, viewport = spec
    return (viewport * cols) // 24 - 16


def title_need(title: str) -> float:
    return len(title) * CHAR_PX + TITLE_PAD


def stat_title_need(panel: dict) -> float:
    chrome = STAT_TITLE_CHROME + (LINK_ICON_PX if panel.get("links") else 0)
    return len(panel.get("title") or "") * STAT_CHAR_PX + chrome


def variable_bar_need(dash: dict) -> float:
    need = 0.0
    for v in dash.get("templating", {}).get("list", []):
        if v.get("hide", 0) != 0:
            continue
        label = v.get("label") or v.get("name") or ""
        if v.get("type") == "textbox":
            value_px = TEXTBOX_INPUT_PX
        else:
            texts = [o.get("text") for o in v.get("options") or []
                     if isinstance(o.get("text"), str)]
            cur = (v.get("current") or {}).get("text") or ""
            longest = max((len(t) for t in texts), default=0)
            longest = max(longest, len(str(cur)))
            value_px = longest * VAR_CHAR_PX
        need += VAR_CHIP_PAD + len(label) * VAR_CHAR_PX + value_px
    for link in dash.get("links") or []:
        need += 40 + len(str(link.get("title") or "")) * VAR_CHAR_PX
    return need


def header_need(name: str) -> float:
    return len(name) * HEADER_CHAR_PX + HEADER_PAD


def content_need(name: str) -> float:
    chars = CONTENT_CHARS.get(name)
    if not chars:
        return 0.0
    return chars * CONTENT_CHAR_PX + CONTENT_PAD


def load_dashboards() -> list:
    out = []
    for uid, name in DASHBOARD_FILES.items():
        path = os.path.join(ROOT, name)
        with open(path, encoding="utf-8") as f:
            out.append((uid, json.load(f)))
    return out


def override_width(panel: dict, *, spec: tuple) -> int | None:
    field, prop_id = spec
    for o in panel.get("fieldConfig", {}).get("overrides", []):
        if o.get("matcher", {}).get("options") != field:
            continue
        for prop in o.get("properties") or []:
            if prop.get("id") == prop_id:
                return prop.get("value")
    return None


def organize_headers(panel: dict) -> list[str]:
    names = []
    hidden = set()
    for o in panel.get("fieldConfig", {}).get("overrides", []):
        if any(p.get("id") == "custom.hidden" and p.get("value") is True for p in o.get("properties") or []):
            opt = o.get("matcher", {}).get("options")
            if opt:
                hidden.add(opt)
    for t in panel.get("transformations") or []:
        if t.get("id") != "organize":
            continue
        rename = (t.get("options") or {}).get("renameByName") or {}
        order = (t.get("options") or {}).get("indexByName") or {}
        exclude = {k for k, v in ((t.get("options") or {}).get("excludeByName") or {}).items() if v}
        keys = sorted(order, key=lambda k: order[k]) if order else list(rename)
        for key in keys:
            if key in exclude:
                continue
            display = rename.get(key, key)
            if display in hidden or key in hidden:
                continue
            names.append(display)
    return names


def check_json() -> list[str]:
    bad = []
    with open(os.path.join(ROOT, "README.md"), encoding="utf-8") as f:
        readme = f.read()
    if GRAFANA_BANNER not in readme:
        bad.append(f"README.md: missing {GRAFANA_BANNER}")
    for uid, dash in load_dashboards():
        bar = variable_bar_need(dash)
        if bar + VAR_CONTROLS_PX > 1280:
            bad.append(f"{uid}: variable bar ~{bar:.0f}px + {VAR_CONTROLS_PX}px controls "
                       f"wraps at 1280 (hide a variable or shorten labels)")
        for p in iter_panels(dash):
            cols = (p.get("gridPos") or {}).get("w") or 24
            title = p.get("title") or ""
            is_stat = p.get("type") == "stat"
            is_cost = "cost" in title.lower() or (
                (p.get("fieldConfig") or {}).get("defaults") or {}).get("unit") == "currencyUSD"
            if is_stat or is_cost:
                for viewport in VIEWPORTS:
                    room = panel_px((cols, viewport))
                    need = stat_title_need(p) if is_stat else title_need(title)
                    if need > room:
                        kind = "stat title" if is_stat else "cost title"
                        bad.append(f"{uid} / {title}: {kind} {need:.0f}px > {cols}-col panel "
                                   f"{room}px at {viewport}")
            if p.get("type") == "table":
                default_min = ((p.get("fieldConfig") or {}).get("defaults") or {}).get("custom", {}).get("minWidth") or 0
                floors = 0
                for name in organize_headers(p):
                    fixed = override_width(p, spec=(name, "custom.width"))
                    floor = override_width(p, spec=(name, "custom.minWidth"))
                    cap = fixed if fixed is not None else floor
                    if cap is None:
                        cap = default_min or None
                    if cap is None:
                        continue
                    floors += cap
                    need = max(header_need(name), content_need(name))
                    if need > cap:
                        kind = "content" if content_need(name) >= header_need(name) else "header"
                        bad.append(f"{uid} / {p.get('title')}: {kind} {name!r} needs {need:.0f}px, "
                                   f"column is {cap}px")
                room = panel_px((cols, 1280))
                if floors > room:
                    bad.append(f"{uid} / {p.get('title')}: column floors {floors}px > "
                               f"{cols}-col panel {room}px at 1280")
                # Fixed-or-floor: a minWidth column may grow into spare space
                # (the r14 elastic first columns); only a column with neither
                # can push a trailing one off at 1280.
                unsized = []
                for name in organize_headers(p):
                    if (override_width(p, spec=(name, "custom.width")) is None
                            and override_width(p, spec=(name, "custom.minWidth")) is None):
                        unsized.append(name)
                if cols <= 12 and unsized:
                    bad.append(f"{uid} / {p.get('title')}: w={cols} table columns without "
                               f"custom.width or custom.minWidth: {', '.join(unsized)}")
            for o in (p.get("fieldConfig") or {}).get("overrides") or []:
                matcher = o.get("matcher") or {}
                if matcher.get("id") != "byRegexp":
                    continue
                pat = matcher.get("options") or ""
                slashed = len(pat) >= 2 and pat.startswith("/") and pat.endswith("/")
                full = pat in (".*", "^.*$") or (pat.startswith("^") and pat.endswith("$"))
                if not slashed and not full:
                    bad.append(f"{uid} / {p.get('title')}: byRegexp {pat!r} must be /…/ "
                               f"or a full-name ^…$ match (Grafana 13.3 anchors the rest)")
        bad.extend(check_column_width_budgets(dash))
        for p in iter_panels(dash):
            bad.extend(palette_alarm_findings(
                overrides=(p.get("fieldConfig") or {}).get("overrides") or [],
                palette={}))
    bad.extend(palette_alarm_findings())
    return bad


def check_renders(folder: str) -> list[str]:
    """Panel-error sidecars plus a whole-dashboard crash.

    Grafana Cloud (13.1+; verified on 13.3.0) throws in applyFieldConfig
    on an unknown colour mode and the page is only "An unexpected error
    happened" — no per-panel icon.
    """
    bad = []
    if not os.path.isdir(folder):
        bad.append(f"renders directory missing: {folder}")
        return bad
    for name in os.listdir(folder):
        lower = name.lower()
        if any(tok in lower for tok in PAGE_CRASH_NAME):
            bad.append(f"render named as page/panel error: {name}")
        path = os.path.join(folder, name)
        if name.endswith(".errors.json"):
            with open(path, encoding="utf-8") as f:
                rows = json.load(f)
            if rows:
                bad.append(f"{name}: {rows}")
            continue
        if name.endswith(".crash.json") or name.endswith(".page.json"):
            try:
                with open(path, encoding="utf-8") as f:
                    payload = json.load(f)
            except (OSError, json.JSONDecodeError) as err:
                bad.append(f"{name}: unreadable ({err})")
                continue
            if isinstance(payload, dict) and (
                payload.get("ok") is False or payload.get("error") or payload.get("crash")
            ):
                bad.append(f"{name}: whole-dashboard crash {payload}")
            elif isinstance(payload, dict) and PAGE_CRASH.search(json.dumps(payload)):
                bad.append(f"{name}: {payload}")
            continue
        if name.endswith((".txt", ".html", ".log")):
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    body = f.read()
            except OSError:
                continue
            if PAGE_CRASH.search(body):
                bad.append(f"{name}: whole-dashboard crash text")
    return bad


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Stat-title and table-header fit at 1280/1600/1920.")
    ap.add_argument("--renders", help="optional directory of PNG screenshots / *.errors.json")
    args = ap.parse_args(argv)
    bad = check_json()
    if args.renders:
        bad += check_renders(args.renders)
    for row in bad:
        print(row, file=sys.stderr)
    if bad:
        print(f"layout_check: {len(bad)} failure(s)", file=sys.stderr)
        return 1
    print("layout_check: titles and headers fit 1280/1600/1920")
    return 0


if __name__ == "__main__":
    sys.exit(main())
