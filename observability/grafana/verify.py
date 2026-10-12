#!/usr/bin/env python3
"""Runs every panel query of the Software Factory dashboards through Grafana's /api/ds/query.

    python3 verify.py [--from now-6h] [--to now] [--json verify-results.json] [--dashboard UID ...]
                      [--var ticket=TLSSN-56 ...]
    python3 verify.py --offline

Online, it interpolates every target from the local JSON (the PR under test) unless
`--deployed` is set, then honours each panel's min interval and relative time
override, and prints one line per target: data, empty, or error. Exit 1 on any
error. A warning is printed when the deployed panel set differs from the local
file. Grafana older than GRAFANA_MIN is refused.

--offline needs no Grafana: it interpolates every target of the local JSON files and fails if any
`$` reference is left unresolved, including a leftover `$__auto` on a Prometheus target
(run by scripts/grafana-dashboards.test.mjs). When PROMTOOL is set, each interpolated PromQL
expression is also passed through `promtool promql format --experimental`.

GRAFANA_URL and GRAFANA_TOKEN / GRAFANA_TOKEN_FILE as in grafana_client.py; the token is never printed.
"""
import argparse
import calendar
import json
import math
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from dataclasses import dataclass

from grafana_client import Grafana, Request, TimeRange, frame_rows  # noqa: E402
from generate import (  # noqa: E402
    BUSINESS, DASHBOARD_FILES, GRAFANA_MIN, LONG_RANGE_S, OPS, PROM, PROM_RES_LONG,
    PROM_RES_SHORT, SMOOTH_LONG, SMOOTH_SHORT, iter_panels,
    no_dollar_dollar_findings,
)


@dataclass(frozen=True, kw_only=True)
class Interp:
    """Template variables and Grafana built-ins, so they are not adjacent dicts."""
    variables: dict
    built: dict


@dataclass(frozen=True, kw_only=True)
class Overrides:
    """--var replacements, so they are not an adjacent dict."""
    values: dict

MAX_DATA_POINTS = 1000
SCRAPE_S = 60
UNITS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800, "y": 31536000}
NICE = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600, 43200, 86400]


def seconds(text: str):
    """'15m' -> 900; '1h30m' -> 5400; '500ms' -> 0.5."""
    total, pos = 0.0, 0
    for mo in re.finditer(r"(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)", text):
        if mo.start() != pos:
            raise ValueError(f"bad duration {text!r}")
        total += float(mo.group(1)) * UNITS[mo.group(2)]
        pos = mo.end()
    if pos != len(text) or not text:
        raise ValueError(f"bad duration {text!r}")
    return total


def relative_seconds(expr: str):
    """'now-6h' -> 21600, 'now' -> 0, 'now/d' -> seconds since midnight UTC. Absolute epoch-ms strings are None.

    Grafana resolves now/d in the dashboard timezone (the browser's); UTC is only used for
    $__range here, never for the from/to Grafana itself queries."""
    if expr == "now":
        return 0.0
    if expr == "now/d":
        now = time.time()
        return now - calendar.timegm(time.gmtime(now)[:3] + (0, 0, 0))
    mo = re.fullmatch(r"now-(.+)", expr)
    return seconds(mo.group(1)) if mo else None


def hms(secs: float):
    secs = max(1, int(round(secs)))
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if secs % size == 0:
            return f"{secs // size}{unit}"
    return f"{secs}s"


def range_seconds(span: TimeRange):
    a, b = relative_seconds(span.frm), relative_seconds(span.to)
    if a is not None and b is not None:
        return a - b
    return (int(span.to) - int(span.frm)) / 1000.0


def variable_values(dash: dict, *, overrides: Overrides | None = None):
    """{name: (values, is_all, all_value, type)} from each template variable's default, or --var."""
    out = {}
    for v in dash.get("templating", {}).get("list", []):
        cur = v.get("current") or {}
        value = cur.get("value", v.get("query", ""))
        values = value if isinstance(value, list) else [value]
        is_all = "$__all" in values
        if v["type"] == "constant":
            values = [v.get("query", "")]
        out[v["name"]] = (["" if x is None else str(x) for x in values], is_all, v.get("allValue"), v["type"])
    for name, value in (overrides.values if overrides else {}).items():
        if name in out:
            out[name] = (value.split("|"), False, None, out[name][3])
    return out


def format_value(var: tuple, *, fmt: str | None):
    values, is_all, all_value, _ = var
    if is_all and all_value is not None and fmt in (None, "pipe", "regex", "raw"):
        return all_value
    if fmt == "regex":
        # Grafana's :regex is lodash escapeRegExp: only ^ $ \ . * + ? ( ) [ ] { } |. Python's re.escape also
        # escapes `-`, which Loki's string lexer rejects ("invalid char escape" on factory\-desk).
        escaped = [re.sub(r"[\\^$.*+?()\[\]{}|]", lambda m: "\\" + m.group(0), x) for x in values]
        return escaped[0] if len(escaped) == 1 else "(" + "|".join(escaped) + ")"
    if fmt == "csv":
        return ",".join(values)
    if fmt in ("pipe", None):
        return "|".join(values)
    return ",".join(values)


def epoch_ms(expr: str, *, now_ms: int):
    """Grafana ${__from} / ${__to}: relative `now-6h` as epoch ms, or an absolute ms string."""
    rel = relative_seconds(expr)
    if rel is not None:
        return now_ms - int(rel * 1000)
    return int(expr)


def builtins(span: TimeRange, *, min_interval: float | None):
    rng = range_seconds(span)
    interval = max(min_interval or 0, rng / MAX_DATA_POINTS)
    interval = next((n for n in NICE if n >= interval), math.ceil(interval))
    rate = max(interval + SCRAPE_S, 4 * SCRAPE_S)
    now_ms = int(time.time() * 1000)
    return {
        "__range": hms(rng), "__range_s": str(int(rng)), "__range_ms": str(int(rng * 1000)),
        "__interval": hms(interval), "__interval_ms": str(int(interval * 1000)),
        "__rate_interval": hms(rate),
        "__from": str(epoch_ms(span.frm, now_ms=now_ms)),
        "__to": str(epoch_ms(span.to, now_ms=now_ms)),
    }, interval


REF = re.compile(r"\$\{(\w+)(?::([^}]+))?\}|\$(\w+)|\[\[(\w+)\]\]")


def interpolate(text: str, *, ctx: Interp):
    unresolved = []

    def sub(mo: re.Match):
        name = mo.group(1) or mo.group(3) or mo.group(4)
        fmt = mo.group(2)
        if name in ctx.built:
            raw = ctx.built[name]
            if fmt == "date:seconds":
                return str(int(raw) // 1000)
            if fmt:
                unresolved.append(mo.group(0))
                return mo.group(0)
            return raw
        if name in ctx.variables:
            return format_value(ctx.variables[name], fmt=fmt)
        unresolved.append(mo.group(0))
        return mo.group(0)

    # No $$ handling: Grafana has no $$ escape and sends $$ through verbatim
    # (the r14 "$1" kind-family bug), so verify must send exactly what Grafana
    # sends; generate.py --check forbids $$ in any expr. A label_replace
    # capture ref like $1 passes through unchanged, as in Grafana (no variable
    # can be named with digits), and is not reported as unresolved.
    out = REF.sub(sub, text)
    unresolved[:] = [u for u in unresolved if not re.fullmatch(r"\$\d+", u)]
    return out, unresolved


def panel_window(panel: dict, *, span: TimeRange, variables: dict):
    """(from, to, min interval seconds) for one panel: relative time override and min interval."""
    frm, to = span.frm, span.to
    if panel.get("timeFrom"):
        # "15m" is now-15m; "now/d" (today so far) is already a from.
        shift = panel["timeFrom"]
        frm = shift if str(shift).startswith("now") else "now-" + shift
        to = "now"
    raw = panel.get("interval") or ""
    min_interval = None
    if raw:
        resolved, missing = interpolate(raw, ctx=Interp(variables=variables, built={}))
        if missing:
            raise ValueError(f"panel interval {raw!r} has unresolved {missing}")
        min_interval = seconds(resolved.lstrip(">"))
    return frm, to, min_interval


def prepared_targets(dash: dict, *, span: TimeRange, overrides: Overrides | None = None):
    """Yields (panel, target, query_to_send, from, to, unresolved) for every target of every panel."""
    variables = variable_values(dash, overrides=overrides)
    for panel in iter_panels(dash):
        if panel["type"] == "text":
            continue
        pfrm, pto, min_interval = panel_window(panel, span=span, variables=variables)
        for target in panel.get("targets", []):
            q = dict(target)
            if "datasource" not in q or q["datasource"].get("uid") == "-- Mixed --":
                q["datasource"] = panel.get("datasource")
            ds_type = (q.get("datasource") or {}).get("type")
            # Interpolate step first: Grafana's Loki $__auto is the target's step when one is set.
            built, interval = builtins(TimeRange(frm=pfrm, to=pto), min_interval=min_interval)
            missing = []
            if isinstance(q.get("step"), str):
                q["step"], gaps = interpolate(q["step"], ctx=Interp(variables=variables, built=built))
                missing += gaps
                leftover = re.findall(r"\$__\w+", q["step"])
                missing += leftover
            if ds_type == "loki":
                built["__auto"] = q["step"] if q.get("step") else hms(interval)
            for key in ("expr", "query", "interval"):
                if isinstance(q.get(key), str):
                    q[key], gaps = interpolate(q[key], ctx=Interp(variables=variables, built=built))
                    missing += gaps
                    leftover = re.findall(r"\$__\w+", q[key])
                    missing += leftover
            q["intervalMs"] = int(interval * 1000)
            q["maxDataPoints"] = MAX_DATA_POINTS
            yield panel, target, q, pfrm, pto, missing


def promql_format_error(expr: str):
    """None if PROMTOOL is unset or the expr formats; otherwise promtool's message."""
    tool = os.environ.get("PROMTOOL")
    if not tool:
        return None
    run = subprocess.run([tool, "promql", "format", "--experimental", expr],
                         capture_output=True, text=True)
    if run.returncode == 0:
        return None
    return (run.stderr or run.stdout).strip() or f"{tool} promql format exited {run.returncode}"


def offline():
    bad = 0
    for uid, filename in DASHBOARD_FILES.items():
        with open(os.path.join(HERE, filename), encoding="utf-8") as f:
            dash = json.load(f)
        n = 0
        for panel, target, q, _, _, missing in prepared_targets(dash, span=TimeRange(frm="now-24h", to="now")):
            n += 1
            ds = (q.get("datasource") or {}).get("type")
            if missing:
                bad += 1
                print(f"{filename}: {panel['title']} ({target['refId']}): unresolved {sorted(set(missing))}", file=sys.stderr)
            elif ds == "prometheus" and isinstance(q.get("expr"), str):
                err = promql_format_error(q["expr"])
                if err:
                    bad += 1
                    print(f"{filename}: {panel['title']} ({target['refId']}): promql format: {err}", file=sys.stderr)
        print(f"{filename}: {n} targets interpolate")
        for row in no_dollar_dollar_findings(dash):
            bad += 1
            print(f"{filename}: dollar-dollar: {row}", file=sys.stderr)
        try:
            panel_window({"timeFrom": "now/d", "interval": ""},
                         span=TimeRange(frm="now-24h", to="now"), variables={})
            builtins(TimeRange(frm="now/d", to="now"), min_interval=None)
        except (ValueError, TypeError) as e:
            bad += 1
            print(f"{filename}: now/d panel window failed: {e}", file=sys.stderr)
        for v in dash.get("templating", {}).get("list", []):
            if v.get("type") != "query":
                continue
            raw = v.get("query")
            expr = raw.get("query") if isinstance(raw, dict) else raw
            if isinstance(expr, str) and expr.startswith("label_values("):
                if not LABEL_VALUES_RE.match(expr.strip()):
                    bad += 1
                    print(f"{filename}: {v['name']}: label_values query is not "
                          f"label_values(metric, label)", file=sys.stderr)
        for row in tempo_count_wording(dash):
            bad += 1
            print(f"{filename}: {row}", file=sys.stderr)
        if uid in (BUSINESS, OPS):
            thirty = TimeRange(frm="now-30d", to="now")
            thirty_over = Overrides(values=query_result_overrides(span=thirty))
            saw_5m = False
            for _panel, _target, q30, *_ in prepared_targets(
                    dash, span=thirty, overrides=thirty_over):
                if "[5m]" in str(q30.get("expr") or ""):
                    saw_5m = True
                    break
            if not saw_5m:
                bad += 1
                print(f"{filename}: 30d interpolated query has no [5m]", file=sys.stderr)
        if uid == OPS:
            for panel in iter_panels(dash):
                title = panel.get("title") or ""
                if "newest" not in title.lower() and "ticket journey" not in title.lower():
                    continue
                if (panel.get("datasource") or {}).get("type") != "tempo":
                    continue
                for target in panel.get("targets") or []:
                    query = target.get("query") or ""
                    if query and "with(most_recent=true)" not in query:
                        bad += 1
                        print(f"{filename}: {title}: TraceQL missing with(most_recent=true)",
                              file=sys.stderr)
        for v in dash.get("templating", {}).get("list", []):
            if v.get("type") != "query":
                continue
            raw = v.get("query")
            expr = raw.get("query") if isinstance(raw, dict) else raw
            if v["name"] == "prom_res" or (isinstance(expr, str) and "vector(" in expr):
                if not (isinstance(expr, str) and expr.startswith("query_result(")):
                    bad += 1
                    print(f"{filename}: {v['name']}: query must be query_result(...)", file=sys.stderr)
                if not str(v.get("definition") or "").startswith("query_result("):
                    bad += 1
                    print(f"{filename}: {v['name']}: definition must be query_result(...)", file=sys.stderr)
    ids = subprocess.run([sys.executable, os.path.join(HERE, "tools", "grafana_ids.py")],
                         capture_output=True, text=True)
    if ids.returncode != 0:
        bad += 1
        print(ids.stderr or ids.stdout, file=sys.stderr)
    else:
        print((ids.stdout or "").strip())
    # Range-total snapping: a delivery 2 minutes before now must land inside
    # both snapped windows or neither, for any now (incl. just after a step).
    for now_s in (1_760_000_000, 1_760_000_299, 1_760_000_300, 1_760_000_301):
        to = snapped_range_to(now_s)
        event = now_s - 120
        in_24h = to - 24 * 3600 < event <= to
        in_30d = to - 30 * 86400 < event <= to
        if in_24h != in_30d:
            bad += 1
            print(f"range-total snap: event at now-2m in 24h={in_24h} 30d={in_30d} (now={now_s})",
                  file=sys.stderr)
        if to > now_s or now_s - to >= seconds(PROM_RES_LONG):
            bad += 1
            print(f"range-total snap: to={to} not the last whole step before now={now_s}",
                  file=sys.stderr)
    print("range-total snapping: both legs share one snapped end")
    layout = subprocess.run([sys.executable, os.path.join(HERE, "tools", "layout_check.py")],
                            capture_output=True, text=True)
    if layout.returncode != 0:
        bad += 1
        print(layout.stderr or layout.stdout, file=sys.stderr)
    else:
        print((layout.stdout or "").strip())
    return 1 if bad else 0


QUERY_RESULT_RE = re.compile(r"^query_result\((.*)\)\s*$", re.S)
LABEL_VALUES_RE = re.compile(r"^label_values\((.+),\s*(\w+)\)$")


def variable_promql(expr: str):
    """Inner PromQL Grafana would run for a query variable (query_result or label_values)."""
    mo = QUERY_RESULT_RE.match(expr.strip())
    if mo:
        return mo.group(1)
    mo = LABEL_VALUES_RE.match(expr.strip())
    if mo:
        metric, label = mo.group(1), mo.group(2)
        # Grafana lists label values from series in the whole range, not the
        # last 5 minutes of samples an instant selector would see.
        return f"count by ({label}) (last_over_time({metric}[$__range]))"
    return expr


def evaluate_query_variables(*, g: Grafana, dash: dict, spans: list):
    """Run every type=query variable through /api/ds/query at each span.

    Grafana's variable path for query_result is an instant PromQL query, not
    /api/v1/series?match[]=. A non-empty option list is required.
    """
    errors = []
    for label, frm, to in spans:
        built, _ = builtins(TimeRange(frm=frm, to=to), min_interval=None)
        variables = variable_values(dash)
        for v in dash.get("templating", {}).get("list", []):
            if v.get("type") != "query":
                continue
            raw = v.get("query")
            expr = raw.get("query") if isinstance(raw, dict) else raw
            name = v.get("name", "?")
            if not isinstance(expr, str):
                errors.append(f"{name} @{label}: missing query")
                continue
            inner = variable_promql(expr)
            resolved, missing = interpolate(inner, ctx=Interp(variables=variables, built=built))
            if missing:
                errors.append(f"{name} @{label}: unresolved {sorted(set(missing))}")
                continue
            q = {"refId": "Var", "datasource": v.get("datasource") or PROM,
                 "expr": resolved, "instant": True, "range": False}
            code, res = g.ds_query(q, span=TimeRange(frm=frm, to=to))
            result = (res.get("results") or {}).get("Var", {})
            err = result.get("error") or (res.get("message") if code >= 400 or code == 0 else None)
            rows = frame_rows(result) if not err else 0
            if err or rows < 1:
                errors.append(f"{name} @{label}: {err or 'empty option list'}")
            else:
                print(f"  [var  ] {name} @{label}: {rows} options")
    return errors


EPOCH_MS_MIN = 1e11  # 1973+ as milliseconds; factory counts never reach this


def frame_value(result: dict):
    """Numeric value from an instant /api/ds/query result.

    Grafana puts Time first. Skip type=time, Time/timestamp names, and
    epoch-ms values so a missing type does not return the timestamp.
    Prefer a field named Value.
    """
    for fr in result.get("frames", []) or []:
        fields = (fr.get("schema") or {}).get("fields") or []
        cols = (fr.get("data") or {}).get("values") or []
        preferred, others = [], []
        for i, col in enumerate(cols):
            field = fields[i] if i < len(fields) else {}
            name = str((field or {}).get("name") or "")
            ftype = str((field or {}).get("type") or "").lower()
            if ftype == "time" or name.lower() in ("time", "timestamp"):
                continue
            (preferred if name.lower().startswith("value") else others).append(col)
        for col in preferred or others:
            for v in col:
                if isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < EPOCH_MS_MIN:
                    return float(v)
    return None


def query_result_overrides(*, span: TimeRange) -> dict:
    """prom_res / smooth for this span. /api/ds/query does not run query_result."""
    long = range_seconds(span) >= LONG_RANGE_S
    return {
        "prom_res": PROM_RES_LONG if long else PROM_RES_SHORT,
        "smooth": SMOOTH_LONG if long else SMOOTH_SHORT,
    }


# Each lookback (seconds) with the range-dependent variables query_result would give it.
RANGE_TOTAL_SPANS = (
    ("24h", 24 * 3600, {"prom_res": PROM_RES_SHORT, "smooth": SMOOTH_SHORT}),
    ("30d", 30 * 86400, {"prom_res": PROM_RES_LONG, "smooth": SMOOTH_LONG}),
)


def snapped_range_to(now_s: float) -> int:
    """Range end for compare_range_totals: the last whole coarse prom_res step.

    The bars and range stats stop at the last whole ${prom_res} step at or
    before $__to. With a live `to = now`, an event after the last whole 5m
    step is inside the 24h total (1m grid) but not the 30d one (5m grid), so
    the monotonic check failed on correct data. Snapping both legs' `to` to
    the 5m grid (every multiple of 300 is also a multiple of 60) makes both
    windows end at the same instant, so an event is in both or in neither.
    """
    step = int(seconds(PROM_RES_LONG))
    return int(now_s // step) * step


def tempo_count_wording(dash: dict) -> list[str]:
    """Tempo count_over_time must not say 'in range' unless the target is instant."""
    errors = []
    for panel in iter_panels(dash):
        desc = panel.get("description") or ""
        if not re.search(r"\bin range\b", desc, re.I):
            continue
        for target in panel.get("targets") or []:
            query = target.get("query") or ""
            if "count_over_time" not in query:
                continue
            ds = (target.get("datasource") or panel.get("datasource") or {})
            if ds.get("type") != "tempo":
                continue
            if target.get("metricsQueryType") == "instant":
                continue
            errors.append(
                f"{panel['title']}: Tempo count_over_time says 'in range' but is not instant")
    return errors


def compare_range_totals(*, g: Grafana, dash: dict, extra: Overrides) -> list[str]:
    """B1: every in-range _total stat at 30d must be at least the 24h value.

    Each lookback uses its own prom_res/smooth. Pass only leftover
    --var here (not query_result_overrides from the outer span) so
    the 30d leg stays on [5m]. Both legs end at the same snapped
    instant (see snapped_range_to) so a delivery seconds before now
    cannot fail the comparison.
    Per-unit stats (a / b) are skipped: they are not monotonic totals.
    """
    errors = []
    values = {}
    titles = {}
    to_ms = snapped_range_to(time.time()) * 1000
    for label, lookback_s, range_vars in RANGE_TOTAL_SPANS:
        span_overrides = Overrides(values={**range_vars, **extra.values})
        print(f"  [range ] {label}: prom_res={span_overrides.values.get('prom_res')} "
              f"smooth={span_overrides.values.get('smooth')} to={to_ms}")
        for panel, target, q, pfrm, pto, missing in prepared_targets(
                dash, span=TimeRange(frm=str(to_ms - lookback_s * 1000), to=str(to_ms)),
                overrides=span_overrides):
            if panel.get("type") != "stat" or panel.get("timeFrom"):
                continue
            if target is not (panel.get("targets") or [None])[0]:
                continue
            expr = target.get("expr") or ""
            if "_total" not in expr:
                continue
            if re.search(r"\)\s*/\s*\(", expr):
                continue
            titles[id(panel)] = panel["title"]
            if missing:
                errors.append(f"{panel['title']} @{label}: unresolved {sorted(set(missing))}")
                continue
            q = dict(q)
            q.setdefault("datasource", panel.get("datasource") or PROM)
            q["instant"] = True
            q["range"] = False
            code, res = g.ds_query(q, span=TimeRange(frm=pfrm, to=pto))
            result = (res.get("results") or {}).get(q.get("refId") or "A", {})
            err = result.get("error") or (res.get("message") if code >= 400 or code == 0 else None)
            if err:
                errors.append(f"{panel['title']} @{label}: {err}")
                continue
            values[(id(panel), label)] = frame_value(result)
    for key, title in titles.items():
        a, b = values.get((key, "24h")), values.get((key, "30d"))
        if a is None or b is None:
            continue
        if b + 0.5 < a:
            errors.append(f"{title}: 30d {b:g} < 24h {a:g} (smoothing window shorter than prom_res?)")
        else:
            print(f"  [range ] {title}: 24h={a:g} 30d={b:g}")
    return errors


def probe_tempo_long(*, g: Grafana, dash: dict) -> list[str]:
    """M1: Tempo queries at 7d must not 400 (stats are capped; tables must still run)."""
    errors = []
    for panel, target, q, pfrm, pto, missing in prepared_targets(
            dash, span=TimeRange(frm="now-7d", to="now")):
        if (q.get("datasource") or {}).get("type") != "tempo":
            continue
        if missing:
            errors.append(f"{panel['title']} @7d: unresolved {sorted(set(missing))}")
            continue
        code, res = g.ds_query(q, span=TimeRange(frm=pfrm, to=pto))
        result = (res.get("results") or {}).get(q.get("refId") or "A", {})
        err = result.get("error") or (res.get("message") if code >= 400 or code == 0 else None)
        if err or (result.get("status") or 200) >= 400:
            errors.append(f"{panel['title']} @7d: {err or f'HTTP {code}'}")
        else:
            print(f"  [tempo ] {panel['title']} @7d ({pfrm}): ok")
    return errors


def is_expression(q: dict):
    ds = q.get("datasource") or {}
    return ds.get("uid") == "__expr__" or ds.get("type") == "__expr__"


def non_finite(result: dict):
    """Inf / -Inf / NaN in a result's frames: Grafana's frame JSON lists them under data.entities."""
    found = set()
    for fr in result.get("frames", []) or []:
        for ent in (fr.get("data") or {}).get("entities") or []:
            for kind in ("Inf", "NegInf", "NaN"):
                if ent and ent.get(kind):
                    found.add(kind)
    return sorted(found)


def panel_batches(dash: dict, *, span: TimeRange, overrides: Overrides):
    """(panel, [(target, q, from, to, missing)]) per panel, in order. A panel with a server-side expression sends all
    its targets in one /api/ds/query call: alone, an __expr__ target fails with sse.missingDependentNode."""
    batches = []
    for panel, target, q, pfrm, pto, missing in prepared_targets(dash, span=span, overrides=overrides):
        if batches and batches[-1][0] is panel:
            batches[-1][1].append((target, q, pfrm, pto, missing))
        else:
            batches.append((panel, [(target, q, pfrm, pto, missing)]))
    return batches


def run_batch(g: Grafana, *, rows: list):
    """Runs one panel's targets: together when one is an expression, else one call each. Yields (row, code, res)."""
    if any(is_expression(q) for _, q, _, _, _ in rows):
        _, _, pfrm, pto, _ = rows[0]
        code, res = g.call(Request(method="POST", path="/api/ds/query"),
                           body={"queries": [q for _, q, _, _, _ in rows], "from": pfrm, "to": pto})
        for row in rows:
            yield row, code, res
        return
    for row in rows:
        _, q, pfrm, pto, _ = row
        code, res = g.ds_query(q, span=TimeRange(frm=pfrm, to=pto))
        yield row, code, res


def grafana_version_ok(version: str) -> bool:
    parts = []
    for bit in str(version).split("."):
        if not bit.isdigit():
            break
        parts.append(int(bit))
    return tuple(parts[:2]) >= GRAFANA_MIN[:2]


def online(args: argparse.Namespace):
    g = Grafana()
    health_code, health = g.call(Request(method="GET", path="/api/health"))
    version = str((health or {}).get("version") or "")
    if health_code != 200 or not grafana_version_ok(version):
        print(f"Grafana {version or health_code} is below "
              f"{GRAFANA_MIN[0]}.{GRAFANA_MIN[1]} (filterFields floor)")
        return 1
    uids = args.dashboard or list(DASHBOARD_FILES)
    report, errors, warnings = {}, 0, 0
    for uid in uids:
        code, body = g.call(Request(method="GET", path=f"/api/dashboards/uid/{uid}"))
        if code != 200:
            print(f"\n== {uid}: GET failed (HTTP {code}) {body.get('message', '')}")
            errors += 1
            continue
        dash, meta = body["dashboard"], body.get("meta", {})
        print(f"\n== {dash['title']} ({uid}) version {dash.get('version')} folder={meta.get('folderTitle')} {g.url}{meta.get('url', '')}")
        local_path = os.path.join(HERE, DASHBOARD_FILES.get(uid, ""))
        local_dash = dash
        if local_path and os.path.isfile(local_path):
            with open(local_path, encoding="utf-8") as f:
                local_dash = json.load(f)
        query_dash = dash if args.deployed or local_dash is dash else local_dash
        if query_dash is local_dash and local_dash is not dash:
            local_titles = {p.get("title") for p in iter_panels(local_dash)}
            remote_titles = {p.get("title") for p in iter_panels(dash)}
            if local_titles != remote_titles:
                extra = sorted(remote_titles - local_titles)
                missing = sorted(local_titles - remote_titles)
                print(f"  [warn] deployed panel set differs from local JSON "
                      f"(+{extra} -{missing}); using local queries")
        sys.path.insert(0, os.path.join(HERE, "tools"))
        import grafana_ids
        id_findings = grafana_ids.findings([local_dash])
        for row in id_findings:
            print(f"  [error] grafana-id {row}")
            errors += 1
        var_errors = evaluate_query_variables(
            g=g, dash=local_dash, spans=[("24h", "now-24h", "now"), ("30d", "now-30d", "now")])
        for row in var_errors:
            print(f"  [error] {row}")
            errors += 1
        counts = {"data": 0, "empty": 0, "error": 0}
        entries = []
        span = TimeRange(frm=args.frm, to=args.to)
        overrides = Overrides(values={**query_result_overrides(span=span), **args.var})
        for panel, rows in panel_batches(query_dash, span=span, overrides=overrides):
            ready = [row for row in rows if not row[4]]
            results = {id(row): (code, res) for row, code, res in run_batch(g, rows=ready)} if ready else {}
            for row in rows:
                target, q, pfrm, pto, missing = row
                ds = (q.get("datasource") or {}).get("type", "?")
                warn = ""
                if missing:
                    status, detail = "error", f"unresolved variables {sorted(set(missing))}"
                else:
                    code, res = results[id(row)]
                    result = (res.get("results") or {}).get(q["refId"], {})
                    err = result.get("error") or (res.get("message") if code >= 400 or code == 0 else None)
                    if err or (result.get("status") or 200) >= 400:
                        status, detail = "error", str(err or json.dumps(res)[:300])
                    else:
                        n = frame_rows(result)
                        status, detail = ("data" if n else "empty"), f"{n} rows"
                        bad = non_finite(result)
                        if bad:
                            warn = f" WARNING non-finite values {bad} (a stat would show them)"
                            warnings += 1
                counts[status] += 1
                entries.append({"panel": panel["title"], "type": panel["type"], "refId": target["refId"], "datasource": ds,
                                "from": pfrm, "to": pto, "status": status, "detail": detail + warn})
                print(f"  [{status:5}] {panel['title']} ({target['refId']}, {ds}) {detail}{warn}")
        errors += counts["error"]
        print(f"   {uid}: {counts['data']} data, {counts['empty']} empty, {counts['error']} error")
        if uid in (BUSINESS, OPS):
            extra = compare_range_totals(g=g, dash=local_dash, extra=Overrides(values=args.var))
            for row in extra:
                print(f"  [error] {row}")
            errors += len(extra)
        if uid == OPS:
            extra = probe_tempo_long(g=g, dash=local_dash)
            for row in extra:
                print(f"  [error] {row}")
            errors += len(extra)
        report[uid] = {"title": dash["title"], "version": dash.get("version"), "folder": meta.get("folderTitle"),
                       "counts": counts, "targets": entries}
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"from": args.frm, "to": args.to, "url": g.url, "dashboards": report}, f, indent=2, sort_keys=True)
            f.write("\n")
        print(f"\nwrote {args.json}")
    print(f"\nerrors: {errors}  warnings: {warnings}")
    return 1 if errors else 0


def main():
    ap = argparse.ArgumentParser(description="Run every Software Factory dashboard query through Grafana.")
    ap.add_argument("--from", dest="frm", default="now-6h")
    ap.add_argument("--to", default="now")
    ap.add_argument("--json", help="write the per-target results here (verify-results*.json is gitignored)")
    ap.add_argument("--dashboard", action="append", help="dashboard uid; repeatable; default both")
    ap.add_argument("--var", action="append", default=[], metavar="NAME=VALUE",
                    help="override a variable's default (multi values joined with |); repeatable")
    ap.add_argument("--offline", action="store_true", help="interpolate the local JSON only; no Grafana")
    ap.add_argument("--deployed", action="store_true",
                    help="run online queries from the deployed JSON (default: the local file)")
    ap.add_argument("--ranges", help="comma-separated lookbacks (e.g. 6h,24h,7d,30d): run online once per "
                    "range, each as --from now-<range> --to now; exit 1 if any range has an error")
    args = ap.parse_args()
    try:
        args.var = dict(item.split("=", 1) for item in args.var)
    except ValueError:
        ap.error("--var takes NAME=VALUE")
    if args.offline:
        return offline()
    if not args.ranges:
        return online(args)
    rc = 0
    for lookback in args.ranges.split(","):
        print(f"\n######## range now-{lookback} .. now")
        json_out = None
        if args.json:
            root, ext = os.path.splitext(args.json)
            json_out = f"{root}-{lookback}{ext or '.json'}"
        rc |= online(argparse.Namespace(**{**vars(args), "frm": f"now-{lookback}", "to": "now",
                                           "json": json_out}))
    return rc


if __name__ == "__main__":
    sys.exit(main())
