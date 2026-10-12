#!/usr/bin/env python3
"""Generates the Software Factory Grafana dashboards. This file is the single source of truth.

    python3 generate.py           write factory-business.json and factory-ops.json next to this file
    python3 generate.py --check   exit 1 if a committed JSON differs from what this file would write,
                                  or if any file in this folder holds something shaped like a secret

Python 3 standard library only. Output is deterministic: keys sorted, panel ids assigned in layout
order, two-space indent, trailing newline. Telemetry names and the reasoning behind each query are in
README.md next to this file; the factory side is docs/factory-deployment.md section 11.
"""
import argparse
import json
import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass

HERE = os.path.dirname(os.path.abspath(__file__))

FOLDER_UID = "software-factory"
PROM = {"type": "prometheus", "uid": "grafanacloud-prom"}
LOKI = {"type": "loki", "uid": "grafanacloud-logs"}
TEMPO = {"type": "tempo", "uid": "grafanacloud-traces"}
JIRA_BROWSE = "https://example.atlassian.net/browse/"
PRICES_URL = "https://cursor.com/docs/models-and-pricing"
PRICES_DATE = "2026-10-03"
JULY_COST_NOTE = ("July 0.2.20 dropped cursor.cost.usage; 0.2.22 emits no USD cost metric and no model label "
                  "on turn.completed. Spend here is always tokens × the price variables, not an invoice and not "
                  "July's old cost counter.")
BUSINESS_ESTIMATE = ("Spend is a list-price estimate from token counts, not the invoice. Method on Factory ops.")

BUSINESS, OPS = "factory-business", "factory-ops"
DASHBOARD_FILES = {
    BUSINESS: "factory-business.json",
    OPS: "factory-ops.json",
}
# The four dashboards these two replaced (v4). apply.sh deletes exactly these uids after a successful upsert.
RETIRED_UIDS = ("factory-overview", "factory-traces", "factory-logs", "factory-cost-tokens")
# filterFields (empty-frame guard) is a hidden transformer from 13.1.0.
# Grafana Cloud is on 13.3.0; 12.2–13.0 render every guarded table blank.
GRAFANA_MIN = (13, 1)
GRAFANA_VERIFIED = (13, 3, 0)
GRAFANA_BANNER = "Grafana Cloud (13.1+; verified on 13.3.0)"

# ------------------------------------------------------------------------------------------------
# Prometheus. Grafana Cloud's OTLP translation puts resource service.name / service.namespace on
# every series as service_name / service_namespace, so legends, columns and $service use the slug
# directly and never the job label ("software-factory/<slug>").
# ------------------------------------------------------------------------------------------------
NS = 'service_namespace="software-factory"'
SVC = 'service_name=~"${service:pipe}"'

DELIVERY = "apj_factory_delivery_total"
DELIVERY_DURATION = "apj_factory_delivery_duration_milliseconds"
HTTP_DURATION = "agent_sdk_http_duration_milliseconds"
# The doubled unit is real: July names the histogram agent_sdk.hosted_execution.duration_ms with unit ms.
EXEC_DURATION = "agent_sdk_hosted_execution_duration_ms_milliseconds"
EXECUTIONS = "agent_sdk_hosted_execution_visible_reply_total"
REMINDERS = "agent_sdk_reminder_fire_outcome_total"
SESSIONS = "agent_sdk_session_count_total"
TURNS = "agent_sdk_turn_count_total"
TOOLS = "cursor_tool_calls_total"
TOKEN_USAGE = "cursor_token_usage_total"
KV_FAILURES = "apj_factory_kv_failure_total"

# factory.outcome values, read from the factory code: traceFactory's default (ok) and throw (error),
# describeResponse / describeDispatch in agent/lib/factory-otel.ts, and the describe/noteFactory
# callers in every host (desk channels/jira.ts, reminders/hop_watch.ts, schedules/hop-watch.ts;
# worker lib/launch.ts and reminders; planner and triage webhook/queue/plan routes and
# lib/jev-first.ts describeWake; fixer channels/github.ts, lib/start-drive.ts, lib/merge-watch.ts;
# reviewer lib/debug-events.ts). PromQL, LogQL and TraceQL regexes are fully anchored.
# Until #215 an unsampled factory span never read notes or describe(), so the counter only saw
# "ok" or "error". #215 records each factory.* span as its own sampled root, so the other
# outcomes appear on the metric too.
OUTCOME_ERRORS = [
    "error", "http_5..", "bad_args", "failed", ".*_failed", "threw", ".*_threw", "config_error",
    "launch_timeout", "unauthorized", ".*_unreadable", "unavailable", "claim_unavailable", "gave_up",
]
OUTCOME_NOOPS = [
    "http_4..", "ignored", "ignored_comment", "duplicate", "deduped", "skipped", "skip", "stop",
    "action_skipped", "none", "idle",
    "not_launched", "not_started", "not_posted", "not_armed", "not_moved", "not_watched", "refused",
    "staging_refused", "superseded", "in_flight", "no_run", "no_brief", "no_branch",
]
# Explicit success only. Missing factory_outcome or an unlisted value (timeout, …) is "other".
OUTCOME_OK = ["ok", "success", "completed", "written", "posted", "launched", "done"]
# In-flight / handoff states from describeDispatch, describeResponse, and the
# hop-watch / implement-pr / approve paths. Not success and not a no-op.
OUTCOME_HANDOFF = [
    "task", "turn", "dispatched", "launching", "started", "accepted",
    "opened", "reused", "swept", "cleared", "armed", "throttled",
    "approved", "announced", "redelivered", "sent_to_planner",
    "jev_only", "already_approved",
]
ERR_RE = "|".join(OUTCOME_ERRORS)
NOOP_RE = "|".join(OUTCOME_NOOPS)
OK_RE = "|".join(OUTCOME_OK)
HANDOFF_RE = "|".join(OUTCOME_HANDOFF)

# Token convention (July 0.2.14 and 0.2.18, @cursor/sdk 1.0.32 and 1.0.35), checked against live agent_sdk.turn
# spans on 2026-10-03 and the TLSSN-59/60 series on 2026-10-04: input comes in TWO SHAPES (uncached_input() below).
# A host/local turn reports it GROSS (cache reads included; every live host turn had cache_read <= input, up to
# 94% of it); a cloud turn (planner since #227, worker since #229) reports it NET of cache reads (cache_read >
# input). July's turn-cost.js toCatalogDisjointUsage (0.2.14 :11-37, 0.2.18 :11-38) tells them apart the same way
# before pricing: input < cache is already disjoint, else subtract. Reasoning is a subset of output (@cursor/sdk
# usage-types.d.ts:41, "totalTokens excludes reasoningTokens (a subset of output)"). So total tokens = input +
# output (gross prompt on a host turn, net-of-cache prompt on a cloud turn), uncached input is decided per series
# (input - cache_read where cache_read <= input, else input), and reasoning is never added.
TOTAL_TYPES = "input|output"
TURN_FAILED = 'agent_sdk_turn_status="failed"'
TOOL_FAILED = 'cursor_tool_status="failure"'
FAILED_OR_NOOP = f'factory_outcome=~"{ERR_RE}|{NOOP_RE}"'
# Platform plumbing routes (health, guest network, manifest) that are not factory work.
PLATFORM_PATHS = ".*/(health|healthz|ready|readyz|live|livez|guest-network|manifest)"

# Counters on hosted v2 are one short-lived series per VM. Every signal carries service.instance.id
# (the Prometheus instance label), drawn per hosted VM, and VMs are short-lived: on 2026-10-03 one
# hour had 45 apj_factory_delivery_total series for 52 deliveries. A cumulative series that is born
# at N is invisible to increase() and rate(), which read 7.5 deliveries that hour. counter_inc counts
# a series born inside the window from zero: its max in the window minus its last value before the
# window, or the max alone when it had none. It is correct over any window, overlapping or not.
# Edge: a series whose last sample before the window is older than LOOKBACK is counted from zero
# (over-counts); only a VM idle for longer than LOOKBACK and then active again would hit that.
# Temporality is CUMULATIVE (the factory's own global MeterProvider, OTLPMetricExporter
# temporalityPreference CUMULATIVE; July's DELTA provider is never used). If a host ever exports DELTA,
# its samples are increments: count them with sum_over_time(selector[window]) instead of counter_inc.
# Aggregate only after counter_inc (sum by (service_name, ...) (inc(...))), never before.
# #215 draws service.instance.id once per life after a restore, so a restored life no longer rewrites the earlier
# life's series; but its new series starts at the snapshot's totals (factory-otel.ts wakeInstanceId), and the
# "or max alone" branch counts a series born inside the window from zero. Each restored life is then overstated by
# the snapshot's totals, and PromQL cannot tell it from a fresh VM first exported at N (COUNT_CAVEAT).
# A host that kept one service.instance.id across processes would see a restart
# reset a long-lived counter inside the window. Such a _total series (resets() > 0, or
# min_over_time below the baseline: a restart on the first sample of the window, which
# resets() misses because (t, t+w] excludes the pre-restart value) is counted with
# max_over_time when that is the only drop, else increase(), which is approximate
# (extrapolation, roughly +-10-20%). A restart whose first export is above the
# last pre-restart value shows no drop and is undetectable. Several writers on one
# series can flip the value and look like resets. For _total metrics the subquery
# inner expression is max_over_time(s[${smooth}]): flips shorter than ${smooth}
# become a stable high-water mark, and a real restart still shows as a drop
# after ${smooth}. The baseline
# uses the same ${smooth} high-water (or last_over_time over LOOKBACK when that
# window is empty). A/C/D at 1m/${smooth}=2m have range = bar sum = true.
# Writer flips longer than ${smooth} are read as restarts; bars and range
# can then both read several times high (3-minute-flip fixture at 1m/2m).
# restart+flip takes increase() leftover (range ≠ bar sum ≠ true). A first-sample
# restart is still taken as max of the raw window (resets() = 0 there); the
# smooth lookback would otherwise leak the pre-restart high-water into the first
# inner points and look like a mid-window reset. Histogram parts (_bucket,
# _sum, _count) keep the exact branch only: their non-monotonic series are two
# writers on one restored series, not restarts (audit 3.2), and increase()
# would count every drop as a reset.
LOOKBACK = "1d"
# Running-max window: at least the subquery step, so a 5m grid cannot skip
# a short-lived VM. 2m below 7d (hides flips shorter than 2m); 5m at 7d+.
SMOOTH = "${smooth}"
SMOOTH_SHORT = "2m"
SMOOTH_LONG = "5m"
# Every Time / Start time / Since column (v2: one format across the dashboards).
TIME_FMT = "time:YYYY-MM-DD HH:mm:ss"


@dataclass(frozen=True, kw_only=True)
class Window:
    """A PromQL/LogQL range: `span` is the duration, `ahead` looks one step forward.

    `res` is the PromQL subquery step for this window. None inherits the
    dashboard `${prom_res}` (1m below 7d, 5m at 7d+). The Now · 15m stats
    pass 1m so a 7d+ dashboard range still counts all 15 minutes.
    """
    span: str
    ahead: bool = False
    res: str | None = None
    # cap=False skips bounded() and the ${prom_res} subquery: plain range
    # selectors for queries meant to be pasted into Explore (the README's
    # per-ticket cost recipes), where dashboard variables do not resolve.
    cap: bool = True


@dataclass(frozen=True, kw_only=True)
class ResetWindow:
    """Spanned samples and their baseline, so those strings are not adjacent."""
    spanned: str
    baseline: str


@dataclass(frozen=True, kw_only=True)
class Copy:
    """Panel title and description as one value so they are not adjacent strings."""
    title: str
    desc: str


@dataclass(frozen=True, kw_only=True)
class Query:
    """Datasource and target as one value so they are not adjacent dicts."""
    ds: dict
    expr: dict


@dataclass(frozen=True, kw_only=True)
class TokenFields:
    """Per-turn usage attribute names for the uncached-input transforms."""
    input: str
    cache_read: str


@dataclass(frozen=True, kw_only=True)
class PromQL:
    """A Prometheus expression, so it is not an adjacent string."""
    expr: str


@dataclass(frozen=True, kw_only=True)
class LogQL:
    """A Loki expression, so it is not an adjacent string."""
    expr: str


@dataclass(frozen=True, kw_only=True)
class TraceQL:
    """A Tempo query, so it is not an adjacent string."""
    query: str


@dataclass(frozen=True, kw_only=True)
class Size:
    """Panel grid size, so width and height are not adjacent ints."""
    w: int
    h: int


@dataclass(frozen=True, kw_only=True)
class Href:
    """A data or dashboard link, so title and url are not adjacent strings."""
    title: str
    url: str


@dataclass(frozen=True, kw_only=True)
class DashMeta:
    """Dashboard identity, so uid/title/description are not adjacent strings."""
    uid: str
    title: str
    description: str


@dataclass(frozen=True, kw_only=True)
class VarSpec:
    """Template variable identity and copy, so those strings are not adjacent."""
    name: str
    label: str
    default: str
    desc: str


@dataclass(frozen=True, kw_only=True)
class Reduce:
    """Stat reduceOptions. calcs and fields would be adjacent str on stat()."""
    calc: str = "lastNotNull"
    fields: str = ""


@dataclass(frozen=True, kw_only=True)
class RangePick:
    """query_result pair for a duration that switches at 7d."""
    label: str
    long: str
    short: str


@dataclass(frozen=True, kw_only=True)
class Capture:
    """A regex capture, so it is not an adjacent string to a query."""
    pattern: str


@dataclass(frozen=True, kw_only=True)
class Fraction:
    """Numerator and denominator as one value so they are not adjacent strings."""
    num: str
    den: str


@dataclass(frozen=True, kw_only=True)
class Color:
    """A named colour, so it is not an adjacent string."""
    name: str


# Colour-blind-safe hues. Services never use alarm red or orange. Channels
# are a disjoint Paul Tol set. Severity: calm is theme text; good is the
# Okabe-Ito bluish green (#009E73, same as factory-worker — not palette-classic
# green); warn/bad are orange/red. http channel/kind stay non-green so
# red/orange/green keep meaning severity.
PALETTE = {
    "service": {
        "factory-desk": "#0072B2",
        "factory-planner": "#CC79A7",
        "factory-worker": "#009E73",
        "factory-pr-autofixer": "#B8A400",
        "factory-security-reviewer": "#56B4E9",
        "factory-triage-jira": "#8F3BB8",
    },
    "channel": {
        "slack": "#6699CC",
        "github": "#44AA99",
        "http": "#7777AA",
        "webhook": "#AA4499",
        "schedule": "#999933",
        "cursor": "#DDCC77",
    },
    "outcome": {
        "ok": "#0072B2",
        "handoff": "#88CCEE",
        "noop": "#767676",
        # Mid grey: #bdbdbd was near-invisible on the light theme.
        "other": "#969696",
        "error": "red",
    },
    "severity": {
        "calm": "text",
        "good": "#009E73",
        "warn": "orange",
        "bad": "red",
    },
    "token": {
        # Three lightness levels on indigo (hue 228; no service uses it), cache read grey (v2).
        "uncached input": "#1F2D6B",
        "cache read": "#BDBDBD",
        "output": "#6A7FD1",
        "reasoning": "#bdd7ee",
        "Estimated cost": "#2171b5",
        "Cumulative estimated cost": "#2171b5",
    },
    "level": {
        "error": "red",
        "warn": "orange",
        "warning": "orange",
        "fatal": "red",
        "critical": "red",
        "info": "#6baed6",
        "debug": "#9ecae1",
        "unknown": "#767676",
    },
    "turn": {
        "completed": "#0072B2",
        "failed": "red",
    },
    # July session events that show up as legend series. action.result is
    # the high-volume healthy series — never palette-classic green.
    "event": {
        "turn.completed": "#0072B2",
        "session.started": "#56B4E9",
        "session.ended": "#88CCEE",
        "message.received": "#08519c",
        "action.requested": "#6baed6",
        "action.result": "#9ecae1",
        "turn.failed": "red",
        "session.failed": "red",
        "action.result": "#9ecae1",
        "message.sent": "#bdd7ee",
        "session.stopped": "#88CCEE",
    },
    # factory.* span names on the latency p95 chart. No alarm red/orange/green.
    # reminder is purple, not #88CCEE: at line/point size it was
    # indistinguishable from factory.background's #56B4E9.
    "span": {
        "factory.delivery": "#0072B2",
        "factory.background": "#56B4E9",
        "factory.github.task": "#44AA99",
        "factory.reminder": "#AA4499",
        "factory.schedule": "#999933",
        "factory.cloud_agent.launch": "#CC79A7",
    },
    # HTTP status class: a 200 is never red, a 500 never green.
    "http_class": {
        "2": "#0072B2",
        "3": "#bdbdbd",
        "4": "orange",
        "5": "red",
    },
    # Categorical, not an outcome. No alarm red/orange. Prefixes cover
    # hop_watch.backstop_sweep, github.workflow_run, reminder.hop_watch, …
    "kind": {
        "slack": "#6699CC",
        "github": "#44AA99",
        "jira": "#8F3BB8",
        "http": "#7777AA",
        "webhook": "#AA4499",
        "schedule": "#999933",
        "cursor": "#DDCC77",
        "cloud_agent": "#0072B2",
        "hop_watch": "#56B4E9",
        "reminder": "#88CCEE",
    },
}

# The six factory slugs. The $service variable and every per-service panel
# always list all of them, idle ones as 0 (owner request, r14).
SERVICES = tuple(PALETTE["service"])


def all_services(expr: str) -> str:
    """Union expr with a 0 series per factory slug so idle slugs stay listed.

    The zeros are tagged pick="yes" only where the slug matches
    ${service:regex} (so a narrowed $service never resurrects other slugs),
    filtered on that tag, then re-aggregated so the pick label is gone and
    `or` dedupes against real series — a slug with data is never counted
    twice. Valid LogQL too (label_replace, vector and `and on` all exist).
    """
    by = "service_name"
    zeros = " or ".join(f'label_replace(vector(0), "{by}", "{s}", "", "")' for s in SERVICES)
    picked = (f'label_replace(({zeros}), "pick", "yes", "{by}", "${{service:regex}}")'
              f' and on(pick) label_replace(vector(1), "pick", "yes", "", "")')
    return f"(({expr}) or sum by ({by}) ({picked}))"

# Table grid interior at a 1280 px viewport, measured in Chrome: the panel is
# (1280 * w / 24) − 16 px but TableNG's grid inside it is narrower (w=12 is
# 557 px; 555 leaves the right padding). Fixed custom.width plus minWidth
# floors of the visible columns must fit these.
WIDTH_BUDGET_1280 = {8: 362, 12: 555, 24: 1140}

# Warn/error hues may only live in severity, level, and error-outcome
# groups. Category series (service, kind, token, channel, span) stay calm.
# Classified by hue, not a string lookup: red/orange is hue 0–45 or 340–360
# at saturation > 0.5; a "healthy" green is hue 90–150 at saturation > 0.35
# (#73BF69, Grafana's green, is S 0.40). #009E73 is the agreed Okabe-Ito
# bluish green (hue 164, outside the band) and explicitly allowed.
GRAFANA_NAMED_HEX = {
    "red": "#F2495C", "dark-red": "#C4162A", "semi-dark-red": "#E02F44",
    "light-red": "#FF7383", "super-light-red": "#FFA6B0",
    "orange": "#FF9830", "dark-orange": "#FA6400", "semi-dark-orange": "#FF780A",
    "light-orange": "#FFB357", "super-light-orange": "#FFCB7D",
    "green": "#73BF69", "dark-green": "#37872D", "semi-dark-green": "#56A64B",
    "light-green": "#96D98D", "super-light-green": "#C8F2C2",
    "yellow": "#FADE2A", "dark-yellow": "#E0B400", "semi-dark-yellow": "#F2CC0C",
    "blue": "#3274D9", "dark-blue": "#1F60C4", "semi-dark-blue": "#3274D9",
    "purple": "#A352CC", "dark-purple": "#7C2EA3",
}
CATEGORY_HUE_ALLOWED = frozenset({"#009e73"})
ALARM_GROUP_KEYS = {
    "severity": None,
    "level": frozenset({"error", "warn", "warning", "fatal", "critical"}),
    "outcome": frozenset({"error"}),
    "turn": frozenset({"failed"}),
    "event": frozenset({"turn.failed", "session.failed"}),
    # 4xx/5xx are genuine error classes: same carve-out alarm_override_allowed makes for status matchers.
    "http_class": frozenset({"4", "5"}),
}


def colour_hs(color: str) -> tuple[float, float] | None:
    """(hue degrees, saturation 0..1) of a hex or Grafana named colour, else None."""
    raw = str(color).strip().lower()
    raw = GRAFANA_NAMED_HEX.get(raw, raw)
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", raw):
        return None
    r, g, b = (int(raw[i:i + 2], 16) / 255.0 for i in (1, 3, 5))
    hi, lo = max(r, g, b), min(r, g, b)
    delta = hi - lo
    if delta == 0:
        return (0.0, 0.0)
    if hi == r:
        hue = 60 * (((g - b) / delta) % 6)
    elif hi == g:
        hue = 60 * (((b - r) / delta) + 2)
    else:
        hue = 60 * (((r - g) / delta) + 4)
    lightness = (hi + lo) / 2
    sat = delta / (1 - abs(2 * lightness - 1))
    return (hue, sat)


def is_alarm_hue(color: str) -> bool:
    """Red/orange band, the hues reserved for warn/error."""
    hs = colour_hs(color)
    if hs is None:
        return False
    hue, sat = hs
    return (hue <= 45 or hue >= 340) and sat > 0.5


def is_health_green(color: str) -> bool:
    """Saturated green, reserved so healthy is never green."""
    if str(color).strip().lower() in CATEGORY_HUE_ALLOWED:
        return False
    hs = colour_hs(color)
    if hs is None:
        return False
    hue, sat = hs
    return 90 <= hue <= 150 and sat > 0.35


def alarm_key_allowed(key: tuple[str, str]) -> bool:
    group, name = key
    if group not in ALARM_GROUP_KEYS:
        return False
    allowed = ALARM_GROUP_KEYS[group]
    return allowed is None or name in allowed


# Per-bucket window. $__auto is Loki-only (Grafana's Prometheus backend does not replace it and
# PromQL then fails with "unexpected character in duration"). Prometheus uses $__interval.
RANGE = Window(span="$__range")
# The README per-ticket recipes: Explore has no ${prom_res}/${smooth}/caps.
RANGE_UNCAPPED = Window(span="$__range", cap=False)
PROM_BUCKET = Window(span="$__interval")
PROM_AHEAD = Window(span="$__interval", ahead=True)
LOKI_BUCKET = Window(span="$__auto")
LOKI_AHEAD = Window(span="$__auto", ahead=True)


# Grafana built-ins as unix seconds. `${__to}` alone is milliseconds; `:date:seconds`
# is the PromQL-usable form. `@ ${__to}` on a range query pins every point, so it is
# not a cap; the ${prom_res} subquery below is.
FROM_CAP = "${__from:date:seconds}"
TO_CAP = "${__to:date:seconds}"
# Subquery step. 1m below 7d matches the 60s scrape (verify.SCRAPE_S) and the
# promtool fixture; 5m at 7d+ (prom_res_var) is for latency and query-cost
# (negative-offset subqueries are uncached), not Mimir's 50M max-samples.
# Measured on 20 token series (Fable r11): 7d 1m 0.79s / 2.2M samples → 5m
# 0.21s / 0.51M; 30d 1m 3.28s / 9.16M (peakSamples 475k) → 5m 0.88s / 1.9M
# (peak 95k). Peak stays two orders below 50M. Finer than scrape only
# re-evaluates the same sample.
PROM_RES = "${prom_res}"
PROM_RES_SHORT = "1m"
PROM_RES_LONG = "5m"
LONG_RANGE_S = 7 * 24 * 3600
# Now · 15m panels override timeFrom but inherit the dashboard ${prom_res}
# unless they pass their own step. 1m matches scrape so a 7d+ view does not
# drop up to 5 of those 15 minutes.
NOW = Window(span="$__range", res=PROM_RES_SHORT)


def rng(window: Window):
    """`[span]`, or `[span] offset -span` so a point at t covers (t, t+span].

    Grafana AlignTimeRange stamps points at step boundaries. Without the negative
    offset each selector covers (t-step, t] and the in-progress bucket is missing.
    Offset must sit on the selector (Prometheus rejects it on aggregations). Grafana
    Cloud Mimir accepts negative offsets (Prometheus ≥ 2.33). Loki 3.5 accepts them
    on LogQL range aggregations. PromQL range selectors have a fixed duration, so a
    point at t always covers (t, t+step]. Loki uses this form as-is: LogQL has no
    subqueries, so a Loki bar cannot be capped at $__to. Prometheus look-ahead goes
    through look_ahead(): a ${prom_res} subquery drops samples outside [$__from, $__to],
    so the last bar on a range that ends before now stops at the last whole
    ${prom_res} step at or before $__to, and the first bar can start one step
    before $__from while counting only samples at or after $__from. On a live
    range (to = now) the last bar is the in-progress bucket.
    On a range that ends before now, a Loki bar covers its whole bucket and can
    include up to one step after the range end. The first Loki bar starts at the
    first step boundary at or after the range start.
    """
    return f"[{window.span}] offset -{window.span}" if window.ahead else f"[{window.span}]"


def bounded(selector: str):
    """S restricted to [$__from, $__to], for the ${prom_res} subquery."""
    return (f"({selector} and on() (vector(time()) >= {FROM_CAP}) "
            f"and on() (vector(time()) <= {TO_CAP}))")


def is_total_metric(selector: str):
    """_total counters get the ${smooth} running max; histogram parts stay exact-only."""
    return selector.split("{", 1)[0].endswith("_total")


def running_max(selector: str, *, extra: object = ""):
    """High-water mark over ${smooth}. extra is ' offset …' or ' @ …'."""
    return f"max_over_time({selector}[{SMOOTH}]{extra})"


def subquery_step(window: Window):
    """Inner step for this window, or the dashboard ${prom_res}."""
    return window.res or PROM_RES


def look_ahead(selector: str, *, window: Window, smooth: bool = False):
    """Prometheus look-ahead range vector. Samples outside [$__from, $__to] are dropped."""
    inner = running_max(selector) if smooth else selector
    return f"{bounded(inner)}[{window.span}:{subquery_step(window)}] offset -{window.span}"


def range_span(selector: str, *, window: Window, smooth: bool = False):
    """Time-bounded subquery ending at $__to. Same reset window as the bars."""
    inner = running_max(selector) if smooth else selector
    return f"{bounded(inner)}[{window.span}:{subquery_step(window)}]"


def lookback(selector: str, *, smooth: bool = False, offset: str = "", at: object = None):
    """Last sample over LOOKBACK, or the ${smooth} high-water when smoothing _total."""
    extra = f" offset {offset}" if offset else (f" @ {at}" if at else "")
    last = f"last_over_time({selector}[{LOOKBACK}]{extra})"
    if not smooth:
        return last
    return f"({running_max(selector, extra=extra)} or {last})"


def baseline(selector: str, *, window: Window, smooth: bool = False):
    """Last value at t, or at $__from when the bar straddles the range start.

    For _total, the ${smooth} high-water (or last_over_time over LOOKBACK when
    that window is empty) so a flip that lands on the stamp is not the baseline.
    """
    if not window.ahead:
        return lookback(selector, offset=window.span, smooth=smooth)
    at_t = lookback(selector, smooth=smooth)
    at_from = lookback(selector, at=FROM_CAP, smooth=smooth)
    # at_from only when the bar stamp is before $__from. An empty lookback at
    # t >= from stays empty so the series is counted from zero (idle > LOOKBACK).
    after = f"({at_t}) and on() (vector(time()) >= {FROM_CAP})"
    before = f"({at_from}) and on() (vector(time()) < {FROM_CAP})"
    return f"(({after}) or ({before}))"


def sel(metric: str, *, where: tuple = (), factory_wide: bool = False):
    """A selector in the factory namespace; factory_wide drops the $service filter (v2's all-slug panels)."""
    return metric + "{" + ", ".join((NS,) + (() if factory_wide else (SVC,)) + tuple(where)) + "}"


def reset_or_increase(exact: str, *, pair: ResetWindow):
    """Exact unless the smoothed window dropped, then increase().

    resets() on the ${smooth}-resampled series is a real drop: a restart, or
    a flip longer than ${smooth}. last<max is not the gate — a restart whose
    new life passes the old maximum still dropped, and last==max would miss
    it. The first-sample raw override in inc() still covers a restart on the
    first inner point (resets=0 there).
    """
    spanned = pair.spanned
    restarted = f"(resets({spanned}) > 0)"
    return f"(({exact}) unless {restarted} or increase({spanned}))"


def inc(selector: str, *, window: Window, cap: bool = True):
    cap = cap and window.cap
    # clamp_min floors a negative exact at 0; a first-sample restart is recovered
    # by min_over_time < baseline on the raw window, which takes max_over_time
    # (not this floor). _total uses a ${smooth} running max as the subquery
    # inner so flips shorter than that window do not look like resets.
    smooth = is_total_metric(selector)
    if cap:
        spanned = (look_ahead(selector, window=window, smooth=smooth) if window.ahead
                   else range_span(selector, window=window, smooth=smooth))
        raw_spanned = (look_ahead(selector, window=window) if window.ahead
                       else range_span(selector, window=window)) if smooth else spanned
        base = baseline(selector, window=window, smooth=smooth)
        base_raw = baseline(selector, window=window) if smooth else base
        exact = (f"clamp_min(max_over_time({spanned}) - {base}"
                 f" or max_over_time({spanned}), 0)")
    else:
        spanned = f"{selector}{rng(window)}"
        before = (f"{selector}[{LOOKBACK}]" if window.ahead
                  else f"{selector}[{LOOKBACK}] offset {window.span}")
        base = f"last_over_time({before})"
        exact = (f"clamp_min(max_over_time({spanned}) - {base}"
                 f" or max_over_time({spanned}), 0)")
        if not smooth:
            return f"({exact})"
        return reset_or_increase(exact, pair=ResetWindow(spanned=spanned, baseline=base))
    if not smooth:
        return f"({exact})"
    # First-sample restart: the raw window is already the new life (resets=0,
    # min < baseline). The ${smooth} lookback would otherwise leak the pre-restart
    # high-water into the first inner points and look like a mid-window reset.
    # The drop test joins on the series' own labels (plain `and`, never
    # `and on()`): one restarting series must not switch every other series
    # in the sum onto the raw-max branch (r14 HIGH-2).
    drop_below = f"(min_over_time({raw_spanned}) < ({base_raw}))"
    first = (f"(max_over_time({raw_spanned}) unless resets({raw_spanned}) > 0)"
             f" and {drop_below}")
    rest = reset_or_increase(exact, pair=ResetWindow(spanned=spanned, baseline=base))
    if window.ahead:
        return f"(({first}) or {rest})"
    # Left-edge restart on a window no longer than ~${smooth} + one step: the
    # smoothed series keeps the pre-restart high-water at every inner point
    # (resets on it read 0) and exact reads 0 while the raw window saw one
    # reset below the baseline. Take increase() on the raw subquery then.
    # Gated to exactly one raw reset with nothing counted, so multi-writer
    # flips over a busy range never reach it; a single flip across an
    # otherwise idle range is read as a restart (documented in
    # BUCKET_VS_RANGE). r14 queries MEDIUM-1.
    edge = (f"(((increase({raw_spanned}) and (resets({raw_spanned}) == 1))"
            f" and {drop_below})"
            f" unless (resets({spanned}) > 0) unless (({exact}) > 0))")
    return f"(({first}) or ({edge}) or {rest})"


def total(metric: str, *, window: Window = RANGE, where: tuple = (), by: str | None = None, factory_wide: bool = False):
    grouping = f" by ({by})" if by else ""
    return f"sum{grouping} ({inc(sel(metric, where=where, factory_wide=factory_wide), window=window)})"


def quantile(q: float, *, histogram: str, window: Window = RANGE, where: tuple = (),
             by: str | None = None, cap: bool | None = None):
    """A histogram quantile with no result where nothing was observed: buckets present in range that never
    incremented count 0, histogram_quantile of all-zero buckets is NaN, and the comparison drops NaN.
    Per-bucket p95 bars have no range stat to match, so they skip the $__to subquery cap."""
    use_cap = (not window.ahead) if cap is None else cap
    labels = "le" + (f", {by}" if by else "")
    buckets = inc(sel(histogram + "_bucket", where=where), window=window, cap=use_cap)
    return f"(histogram_quantile({q}, sum by ({labels}) ({buckets}))) >= 0"


def as_seconds(expr: str):
    """PromQL milliseconds → seconds for latency line axes."""
    return f"({expr}) / 1000"


def outcome_class(*, window: Window = RANGE, where: tuple = ()):
    """Deliveries labelled error / noop / ok / handoff / other from factory_outcome.

    ok is only the explicit success values in OUTCOME_OK. Handoff is the
    in-flight states in OUTCOME_HANDOFF (task, dispatched, swept, …).
    A missing factory_outcome or an unlisted value (timeout, …) is other.
    `where` narrows the deliveries (Ops passes NOT_HOP_WATCH).
    """
    raw = total(DELIVERY, window=window, where=where, by="factory_outcome")
    err = f'label_replace(({raw}), "class", "error", "factory_outcome", "^(?:{ERR_RE})$")'
    noop = f'label_replace({err}, "class", "noop", "factory_outcome", "^(?:{NOOP_RE})$")'
    ok = f'label_replace({noop}, "class", "ok", "factory_outcome", "^(?:{OK_RE})$")'
    handoff = f'label_replace({ok}, "class", "handoff", "factory_outcome", "^(?:{HANDOFF_RE})$")'
    other = f'label_replace({handoff}, "class", "other", "class", "^$")'
    return f"sum by (class) ({other})"


def delivery_by_kind_family(*, window: Window = RANGE):
    """One series per PALETTE kind family (github, jira, slack, …).

    The replacement must be "$1", never "$$1": Grafana has no $$ escape, so
    "$$1" reaches Prometheus unchanged and Go's Expand writes the literal
    text $1 into the label (r14 HIGH). Grafana leaves the unknown variable
    $1 untouched; no_dollar_dollar_findings() and the node tests gate it.
    """
    raw = total(DELIVERY, window=window, by="factory_delivery_kind")
    fam = (f'label_replace(({raw}), "family", "$1", "factory_delivery_kind", '
           r'"^([A-Za-z0-9_]+).*")')
    return f"sum by (family) ({fam})"


def per_unit(frac: Fraction):
    """num / den, with no result where den is 0: a series present in range that never incremented counts 0, and
    0 / 0 (NaN) or x / 0 (+Inf) would show instead of the panel's no-traffic text."""
    return f"({frac.num}) / ({frac.den} > 0)"


def ratio(metric: str, *, bad: tuple, window: Window = RANGE, where: tuple = ()):
    return per_unit(Fraction(num=f"{total(metric, window=window, where=(*bad, *where))} or vector(0)", den=total(metric, window=window, where=where)))


def token_type(kind: str, *, window: Window = RANGE, by: str | None = None, where: tuple[str, ...] = (),
               factory_wide: bool = False):
    return total(TOKEN_USAGE, window=window, where=(f'cursor_token_type="{kind}"', *where), by=by,
                 factory_wide=factory_wide)


def token_series(kind: str, *, window: Window = RANGE, where: tuple[str, ...] = (), factory_wide: bool = False):
    """One `kind` series per (host, instance, ticket, ...): inc() per series, with only cursor_token_type dropped,
    so an input series and the cache_read series of the same labels line up one-to-one for uncached_input()."""
    one = inc(sel(TOKEN_USAGE, where=(f'cursor_token_type="{kind}"', *where), factory_wide=factory_wide), window=window)
    return f"sum without (cursor_token_type) ({one})"


# Two input shapes on one metric (README, "Two input shapes"). A host/local turn (desk, triage, the planner before
# #227) reports provider-gross input: cache reads are inside it (TLSSN-59 planner: input 1,575,134, cache_read
# 1,355,648; TLSSN-60 desk: input 41,977, cache_read 39,296). A cloud turn (the planner since #227, the worker's
# July cloud turn since #229) reports input net of cache reads (TLSSN-60 planner, one cloud turn: input 187,541,
# cache_read 1,191,168, output 29,543; July billed it 1.127171 USD). The metric carries no runtime label and
# July's metrics are not ours to change, so the shape is read from the numbers, per series, before any sum:
# cache_read <= input is gross (uncached = input - cache_read); cache_read > input is net (uncached = input);
# no cache_read series is uncached = input. July prices its own turns by the same test (dist/internal/turn-cost.js
# toCatalogDisjointUsage: inputTokens < cacheRead + cacheWrite is already disjoint, otherwise subtract). Summing
# first and subtracting after (the form before this) priced a cloud series' input at 0 and netted a gross desk
# series against a net planner series on the same ticket. Residual risk: a cloud series whose input happens to be
# >= its cache reads is read as gross and undercounted by its cache reads; one (pod, ticket) series that mixes
# local and cloud turns is classified as a whole. Still an estimate, priced with the $price_* variables.
def uncached_input(*, window: Window = RANGE, by: str | None = None, where: tuple[str, ...] = (),
                   factory_wide: bool = False):
    """Uncached input summed by `by` (or in total), decided per series: input - cache_read where cache_read <= input
    (gross shape), the whole input where cache_read > input (net shape: input already excludes cache reads) or where
    there is no cache_read series. `(cached <= gross)` keeps cached only on gross-shaped series; the `or 0 * gross`
    arm covers the other two. Never below 0 by construction, so no clamp."""
    gross = token_series("input", window=window, where=where, factory_wide=factory_wide)
    cached = token_series("cache_read", window=window, where=where, factory_wide=factory_wide)
    grouping = f" by ({by})" if by else ""
    return f"sum{grouping} ({gross} - (({cached} <= {gross}) or 0 * {gross}))"


def cache_share(*, window: Window = RANGE):
    """Share of the prompt served from cache: cache_read / (uncached_input() + cache_read), decided per series like
    every priced panel, so a gross host series (cache inside input) and a net cloud series (cache beside input) both
    read right. cache_read / input was the old form: a cloud turn reports input net of cache reads, so it passed 100%
    (435% live on 2026-10-05). 0..1 by construction (uncached >= 0); clamp_max is a belt for a rounding artefact."""
    cached = f"({token_type('cache_read', window=window)} or vector(0))"
    prompt = f"(({uncached_input(window=window)}) or vector(0)) + {cached}"
    return f"clamp_max({per_unit(Fraction(num=cached, den=prompt))}, 1)"


def estimate(window: Window, *, by: str | None = None, where: tuple[str, ...] = (), factory_wide: bool = False):
    """USD at list price per 1M tokens: uncached_input() x input + cache_read x cache + output x output
    (+ reasoning x reasoning, default 0: reasoning is inside output), uncached input decided per series (the two
    input shapes above) before the sum. Each term carries its own `part` label so
    `or` unions them and a missing type drops only its own term. `by` groups per slug (service_name, the default
    panels) or per ticket (TICKET_KEY, cost_per_ticket)."""
    terms = [(uncached_input(window=window, by=by, where=where, factory_wide=factory_wide),
              "$price_input", "uncached_input")] + [
        (token_type(kind, window=window, by=by, where=where, factory_wide=factory_wide), f"$price_{kind}", kind)
        for kind in ("cache_read", "output", "reasoning")]
    parts = " or ".join(f'label_replace({expr} * {price}, "part", "{name}", "", "")' for expr, price, name in terms)
    grouping = f" by ({by})" if by else ""
    return f"sum{grouping} ({parts}) / 1e6"


# Cost per ticket (README "Cost per ticket (estimate)"). July's cursor_token_usage_total
# and agent_sdk_turn_count_total carry factory_ticket_key (on each host that runs model turns, desk, planner,
# triage, fixer and reviewer, hooks/ticket-key.ts tags the session through July's host.otel.setAttributes; the
# factory's View keeps the label on those two and on apj_factory_ticket_merged_total, the worker's one count per
# ticket moved to Done on a merged PR, the worker's only part in this, and drops it everywhere else). No
# dashboard panel reads these yet (#219 and #221 own the dashboards); the README quotes
# them and scripts/grafana-dashboards.test.mjs checks it does so verbatim, and tools/promtool_ticket_check.py
# proves them under promtool.
TICKET_MERGED = "apj_factory_ticket_merged_total"
TICKET_KEY = "factory_ticket_key"
# A Jira key only: not `none` (a turn with no ticket), not `other` (a pin that is not a key), and not an
# unlabelled row (a sample from before the label existed; `|` at the end of the alternation matches the empty label).
KEYED = f'{TICKET_KEY}!~"none|other|"'


def cost_per_ticket(window: Window = RANGE_UNCAPPED, *, where: tuple[str, ...] = ()):
    """estimate() grouped by ticket instead of slug: one row per factory_ticket_key in range, USD, summed over
    every host that tagged the ticket (factory-wide: the $service filter never applies to per-ticket cost)."""
    return estimate(window, by=TICKET_KEY, where=where, factory_wide=True)


def merged_tickets(window: Window = RANGE_UNCAPPED):
    """One row, valued exactly 1, per Jira key the worker moved to Done on a merged PR in the window; a key merged
    before the window has no row, and `none`, `other` and the unlabelled row never do. All hosts (factory-wide).

    A key counts as merged when EITHER its counter increased in the window OR its series first appeared in it.
    The second arm is load-bearing: every ticket key is a new series, created at 1 on its first increment, and
    increase()/rate() cannot see the jump from "no series" to 1 on a series' first sample (there is no earlier
    point to diff against), so the increase() arm alone is empty for a ticket's first merge. "First appeared" is
    last_over_time over the window `unless` the series also existed in the LOOKBACK (1d) just before the window.

    `* 0 + 1` pins each surviving row at 1, so it is a ticket, not an increment, that is counted (the worker can
    double-count when its `ticket-merged/<KEY>` marker cannot be read, or it loses a read-then-put race):
    dividing by it leaves that ticket's cost whole, and summing it counts tickets."""
    m = sel(TICKET_MERGED, where=(KEYED,), factory_wide=True)
    grew = f"max by ({TICKET_KEY}) (increase({m}[{window.span}])) > 0"
    appeared = (f"max by ({TICKET_KEY}) (last_over_time({m}[{window.span}])) "
                f"unless max by ({TICKET_KEY}) (last_over_time({m}[{LOOKBACK}] offset {window.span}))")
    return f"((({grew}) or ({appeared})) * 0 + 1)"


def cost_per_merged_ticket(window: Window = RANGE_UNCAPPED, *, cost_window: str | None = None):
    """Each merged ticket's own cost: cost_per_ticket() over cost_window (a duration like "7d"; default: the
    merge window itself), divided, key by key, by merged_tickets(window) (always 1, so a double-counted merge
    cannot halve the ticket's cost). cost_window widens the cost lookback past the merge window so work done
    days before the merge is counted in full; it is a plain uncapped selector (Explore-safe). A ticket not
    merged in the window, `none`, `other` and the unlabelled row have no denominator row and drop out."""
    cost = Window(span=cost_window, cap=False) if cost_window else window
    return f"({cost_per_ticket(cost)}) / on ({TICKET_KEY}) ({merged_tickets(window)})"


def mean_cost_per_merged_ticket(window: Window = RANGE_UNCAPPED, *, cost_window: str | None = None):
    """The true mean over the tickets merged in the window: avg of each one's own cost (over cost_window
    when given, so a 24h merge window can carry a 7d cost lookback)."""
    return f"avg({cost_per_merged_ticket(window, cost_window=cost_window)})"


def keyed_cost_per_merged_ticket(window: Window = RANGE_UNCAPPED):
    """Every keyed ticket's cost in range (merged or not; never `none`, `other` or unlabelled) over the number
    of tickets merged in range (merged_tickets() rows, each 1, so a double-counted merge is still one ticket).
    Not a mean: unmerged tickets' cost is in the numerator."""
    return per_unit(Fraction(num=f"sum({cost_per_ticket(window, where=(KEYED,))})", den=f"sum({merged_tickets(window)})"))


# Loki and Tempo selectors. Loki stream labels: service_name, service_namespace. July's session events
# (turn.completed, action.result, ...) carry their agent_sdk_* / cursor_* attributes as structured metadata.
LSEL = '{service_namespace="software-factory", service_name=~"${service:pipe}"}'

# The factory's own fields come in two shapes, and every factory-field query reads both:
# - raw util.format bodies (current, since #217): a JSON line ({"desk":"intake_root","issueKey":...})
#   or a tagged line ("[bdk] hosted admission received deliveryId=... eventType=..."), with no
#   factory attributes. The console bridge exports the formatted body as-is and does not parse it
#   into attributes.
# - structured metadata on older records exported before #217, still parsed.
# FACTORY_FIELDS parses the body (json for JSON lines, regexp for key=value) into j_* / r_* labels, which can
# never collide with structured metadata, drops the JSON parse error that every other line gets, and sets
# one f_* label per field from the first source that has it.
FACTORY_EVENT_KEYS = ["worker", "desk", "fixer", "planner", "triage", "factoryDebug", "kv", "step", "ops", "otel"]
# `why` is the reason code on many factory JSON lines (intake_root's filed_in_slack_unbound, threw, timeout);
# `error` / `message` carry exception text, not a code, and stay in the body.
JSON_FIELDS = ["issueKey", "factoryKey", "outcome", "reason", "why", "via", "wake", "pr", "deliveryId", "eventType"]


def kv_field(key: str):
    """A regexp stage for `key=value` in a tagged line. The value may contain ':' (jira:issue_updated); a ':' or
    ',' that ends it ("deliveryId=abc: boom") is July's message punctuation, not part of the value."""
    return f'| regexp `{key}=(?P<r_{key}>[^\\s"]+?)[,:]?(?:\\s|$)`'


FIELD_SOURCES = {
    "f_event": ["factory_event"] + [f"j_{k}" for k in FACTORY_EVENT_KEYS],
    "f_ticket": ["issueKey", "factoryKey", "j_issueKey", "j_factoryKey"],
    "f_outcome": ["outcome", "j_outcome"],
    "f_reason": ["reason", "j_reason", "j_why"],
    "f_via": ["via", "j_via"],
    "f_wake": ["wake", "j_wake"],
    "f_pr": ["pr", "j_pr"],
    "f_delivery": ["deliveryId", "j_deliveryId", "r_deliveryId"],
    "f_event_type": ["eventType", "j_eventType", "r_eventType"],
}
FACTORY_FIELDS = (
    "| json " + ", ".join(f'j_{k}="{k}"' for k in FACTORY_EVENT_KEYS + JSON_FIELDS)
    + f" {kv_field('deliveryId')} {kv_field('eventType')}"
    + " | drop __error__, __error_details__"
    + " | label_format " + ", ".join(
        f"{name}=`{{{{ or {' '.join('.' + src for src in sources)} }}}}`" for name, sources in FIELD_SOURCES.items()))


LOG_SHAPES_NOTE = ("Factory fields are read from structured metadata on older records, else "
                   "parsed from the raw util.format body (a JSON line, or a [tag] line's key=value pairs). "
                   "The console bridge exports lines as raw util.format bodies and does not parse them into attributes.")


def drop_before_range():
    """Loki only. Keep points with t ≥ $__from. Grafana stamps the bucket that
    straddles an unaligned range start before $__from; LogQL cannot count only
    the in-range lines of that bucket, so this filter drops it. The first bar starts at the first
    step boundary at or after the range start; events between the range start and
    that boundary (up to one step) are in the range stats but in no bar. Quote
    the range stats. Prometheus keeps that bar and caps samples at $__from."""
    return {"id": "filterByValue", "options": {
        "type": "include", "match": "all",
        "filters": [{"fieldName": "Time", "config": {"id": "greaterOrEqual", "options": {"value": "${__from}"}}}]}}


def whole(expr: str):
    """Whole-number count for bar legends. Rounding each bucket makes the legend a
    whole number; it can still differ from the range stat (see BUCKET_VS_RANGE)."""
    return f"round({expr})"


# Distinct deliveryId values (July's [bdk] admission lines and factory lines carry one): a log-side delivery count.
def delivery_ids(by: str = "", *, window: Window = RANGE, event_type: bool = False):
    """Distinct deliveryId values; with event_type, only lines that name one (one per delivery)."""
    grouping = f" by ({by})" if by else ""
    inner = "service_name, f_event_type, f_delivery" if event_type else "service_name, f_delivery"
    lines = '| f_delivery != "" | f_event_type != ""' if event_type else '| f_delivery != ""'
    return f"count{grouping} (sum by ({inner}) (count_over_time({LSEL} {FACTORY_FIELDS} {lines} [{window.span}])))"
# Case-insensitive: Loki takes detected_level from severity_text where a record has one, keeping its case, so
# the factory console bridge's WARN / ERROR lines read upper case (Loki 3.5); July's session events carry only a
# severity number and read lower case.
LEVELS_BAD = 'detected_level=~"(?i)error|warn|warning|fatal|critical"'
# Slack Bolt WebClient: a pair of expected lines per desk turn. July warns
# on the Slack Stop button (agent_session_stopped / unsupported event);
# the factory has no Stop channel, so this is noise, not a factory error.
# One regex both ways so a line cannot fall in neither panel: WebClient plus the warning code
# or the companion "Subscribe to the agent_session_stopped event" line. Not every Slack line.
# Loki 3.5's line-filter optimiser mishandles `literal.*(?:A|B)` and matches nothing; `[^\n]*`
# is the same on these single-line bodies and works. Do not put `.*` back (see the tests).
SLACK_SDK_WARN_CODE = "missing_agent_session_stopped_event_subscription"
SLACK_SDK_SUBSCRIBE = "Subscribe to the agent_session_stopped event"
SLACK_SDK_RE = f"web-api:WebClient[^\\n]*(?:{SLACK_SDK_WARN_CODE}|{SLACK_SDK_SUBSCRIBE})"
SLACK_SDK_WARN = f"|~ `{SLACK_SDK_RE}`"
NOT_SLACK_SDK_WARN = f"!~ `{SLACK_SDK_RE}`"
# Label filter: the logs panel highlights |~ matches, so the Slack SDK
# panel (expected noise) would be a full-width yellow wash. `=~ ".+"`
# requires the capture; equivalent to `!= ""` for an absent label
# (Loki 3.5 compares a missing label as ""), kept for readability.
SLACK_SDK_LABEL = f'| regexp `(?P<slack_pair>{SLACK_SDK_RE})` | slack_pair =~ ".+"'
SLACK_PAIR = "the Slack WebClient session-stopped pair"
# Loki keeps severity_text case (WARN / warning / warn). One series, one hue.
LEVEL = '| label_format level=`{{ regexReplaceAll "^warning$" (lower .detected_level) "warn" }}`'
# July and factory span names. The hosted runtime's context-tracer spans (rpc.run, hydratePromptMessages, ...)
# are about 80% of stored spans and are left out of every generic (error, slow) table.
OWN_SPANS = 'name =~ "agent_sdk[.].*|factory[.].*|tools/(call|list)"'
TSEL = 'resource.service.namespace = "software-factory" && resource.service.name =~ "${service:pipe}"'

# ------------------------------------------------------------------------------------------------
# Targets
# ------------------------------------------------------------------------------------------------


def prom(expr: PromQL, *, ref: str = "A", instant: bool = False, legend: str = "__auto", table: bool = False):
    t = {"refId": ref, "datasource": PROM, "expr": expr.expr, "editorMode": "code", "legendFormat": legend,
         "range": not instant, "instant": instant}
    if table:
        t["format"] = "table"
    return t


def loki(expr: LogQL, *, ref: str = "A", instant: bool = False, legend: str = "",
         max_lines: int | None = None, step: str | None = None):
    t = {"refId": ref, "datasource": LOKI, "expr": expr.expr, "editorMode": "code", "legendFormat": legend,
         "queryType": "instant" if instant else "range"}
    if max_lines:
        t["maxLines"] = max_lines
    if step:
        t["step"] = step
    return t


def traceql(query: TraceQL, *, ref: str = "A", limit: int = 50):
    return {"refId": ref, "datasource": TEMPO, "queryType": "traceql", "query": query.query, "limit": limit,
            "spss": 10, "tableType": "spans", "filters": []}


# ------------------------------------------------------------------------------------------------
# Links
# ------------------------------------------------------------------------------------------------


def dashboard_links():
    # One dropdown so the variable bar stays one line at 1280. type=dashboards
    # lists every dashboard tagged software-factory (the two factory uids).
    return [{"title": "Factory", "type": "dashboards", "icon": "dashboard", "keepTime": True,
             "includeVars": True, "targetBlank": False, "asDropdown": True,
             "tags": ["software-factory"], "tooltip": "Business, Ops"}]


def link(href: Href, *, blank: bool = False):
    return {"title": href.title, "url": href.url, "targetBlank": blank}


JIRA_LINK = link(Href(title="Open ${__value.raw} in Jira", url=JIRA_BROWSE + "${__value.raw}"), blank=True)
# Every ticket and service drill-down lands on Factory ops (v4): the ticket panels and the Debug rows live there.
TICKET_OPS = link(Href(title="Ticket on Factory ops", url=f"/d/{OPS}?var-ticket=${{__value.raw}}&${{__url_time_range}}"))
SERVICE_OPS = link(Href(title="${__value.raw} on Factory ops", url=f"/d/{OPS}?var-service=${{__value.raw}}&${{__url_time_range}}"))
OPS_SEARCH = f"/d/{OPS}?var-search="
TRACE_LINK = {"title": "Open trace", "url": "", "internal": {
    "datasourceUid": TEMPO["uid"], "datasourceName": "Tempo",
    "query": {"queryType": "traceql", "query": "${__value.raw}", "refId": "A"}}}
# Tempo's built-in Span ID link reads ${__data.fields.traceIdHidden}. When
# Span ID is hidden to fit 1280, the same handle sits on Span.
SPAN_TRACE_LINK = {"title": "Open trace", "url": "", "internal": {
    "datasourceUid": TEMPO["uid"], "datasourceName": "Tempo",
    "query": {"queryType": "traceql", "query": "${__data.fields.traceIdHidden}", "refId": "A"}}}


def links_on(name: str, *, links: list):
    return {"matcher": {"id": "byName", "options": name}, "properties": [{"id": "links", "value": list(links)}]}


def links_on_nonempty(name: str, *, links: list):
    """Data links only look like links when the cell has a value. Empty, nil and '-' stay blank."""
    return {"matcher": {"id": "byName", "options": name}, "properties": [
        {"id": "links", "value": list(links)},
        {"id": "noValue", "value": ""},
        {"id": "mappings", "value": [
            {"type": "special", "options": {"match": "null", "result": {"text": "", "index": 0}}},
            {"type": "special", "options": {"match": "empty", "result": {"text": "", "index": 1}}},
            {"type": "value", "options": {"nil": {"text": "", "index": 2}, "-": {"text": "", "index": 3}}},
        ]},
    ]}


def hide(name: str):
    return {"matcher": {"id": "byName", "options": name}, "properties": [{"id": "custom.hidden", "value": True}]}


def width(name: str, *, px: int):
    return {"matcher": {"id": "byName", "options": name}, "properties": [{"id": "custom.width", "value": px}]}


def min_width(name: str, *, px: int):
    """Floor for one column this query returns. Size floors so they plus the other columns'
    rendered widths fit the panel at a 1280 px viewport; Grafana will not shrink a minWidth."""
    return {"matcher": {"id": "byName", "options": name}, "properties": [{"id": "custom.minWidth", "value": px}]}


def colour(name: str, *, color: Color):
    return {"matcher": {"id": "byName", "options": name},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": color.name}}]}


def colours_from(mapping: dict):
    return tuple(colour(name, color=Color(name=c)) for name, c in mapping.items())


def field_unit(spec: tuple):
    """spec is (column name, unit)."""
    name, unit = spec
    return {"matcher": {"id": "byName", "options": name}, "properties": [{"id": "unit", "value": unit}]}


def regexp_option(pattern: str) -> str:
    """Grafana 13.3 anchors a non-slash byRegexp as ^…$. Partial patterns
    must be /…/; a full-name match (^…$ or .*) may stay unslashed."""
    if len(pattern) >= 2 and pattern.startswith("/") and pattern.endswith("/"):
        return pattern
    return f"/{pattern}/"


def service_status_colours():
    """`{{service_name}} {{status}}` legends and Prom field names.

    Grafana 13.3 sometimes colours by the series name (`factory-desk 200`)
    and sometimes by the raw frame field (`{service_name="factory-desk",
    http_response_status_code="200"}`). Both have to match.
    """
    out = []
    for name, hex_c in PALETTE["service"].items():
        out.append({"matcher": {"id": "byRegexp",
                    "options": regexp_option(rf'(^|[="]){re.escape(name)}([ "\],]|$)')},
                    "properties": [{"id": "color",
                                    "value": {"mode": "fixed", "fixedColor": hex_c}}]})
    out.append({"matcher": {"id": "byRegexp",
                "options": regexp_option(r'( 5\d\d$|status_code="5\d\d")')},
                "properties": [{"id": "color",
                                "value": {"mode": "fixed", "fixedColor": "red"}}]})
    out.append({"matcher": {"id": "byRegexp",
                "options": regexp_option(r'( 4\d\d$|status_code="4\d\d")')},
                "properties": [{"id": "color",
                                "value": {"mode": "fixed", "fixedColor": "orange"}}]})
    # 4xx stays in the legend text but takes a 50% mix of the slug colour
    # so factory-desk 405 and factory-triage-jira 405 are not the same orange.
    # The slug boundary is a lookahead: a consuming group ate the space that
    # ` 4\d\d$` needs, so the override never matched "factory-desk 405" (r14).
    for name, hex_c in PALETTE["service"].items():
        out.append({"matcher": {"id": "byRegexp",
                    "options": regexp_option(
                        rf'(^|[="]){re.escape(name)}(?=[ "\],]|$).*( 4\d\d$|status_code="4\d\d")')},
                    "properties": [{"id": "color",
                                    "value": {"mode": "fixed",
                                              "fixedColor": lighten_hex(hex_c)}}]})
    return tuple(out)


def label_colours(mapping: dict):
    """Exact label values, matched as the whole legend or as a quoted label value (Grafana anchors the pattern)."""
    return tuple({"matcher": {"id": "byRegexp", "options": rf'/(^|="){re.escape(name)}("|$)/'},
                  "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": hex_c}}]}
                 for name, hex_c in mapping.items())


def lighten_hex(hex_c: str, *, frac: float = 0.5) -> str:
    h = hex_c.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    r = int(r + (255 - r) * frac)
    g = int(g + (255 - g) * frac)
    b = int(b + (255 - b) * frac)
    return f"#{r:02x}{g:02x}{b:02x}"


# Kind is categorical, not an outcome. Grafana 13.3 anchors a non-slash
# byRegexp as ^…$, so prefix patterns must be /…/. The pattern also has
# to hit Prometheus field names `{factory_delivery_kind="…"}`.
# reminder is last so reminder.hop_watch stays the reminder colour.
KIND_PREFIX_COLOURS = tuple(
    (regexp_option(rf'(^|[="]){re.escape(name)}'), hex_c) for name, hex_c in PALETTE["kind"].items()
)


def kind_colours():
    return tuple(
        {"matcher": {"id": "byRegexp", "options": pattern},
         "properties": [{"id": "color",
                         "value": {"mode": "fixed", "fixedColor": hex_c}}]}
        for pattern, hex_c in KIND_PREFIX_COLOURS
    )


# timeseries() legends that must resolve to a PALETTE group. A new
# {{label}} without a branch falls back to fixed grey, not palette-classic.
TEMPLATE_PALETTE = {
    "{{service_name}}": "service",
    "{{factory_delivery_kind}}": "kind",
    "{{family}}": "kind",
    "{{factory_span}}": "span",
    "{{agent_sdk_channel}}": "channel",
    "{{class}}": "outcome",
    "{{level}}": "level",
    "{{agent_sdk_turn_status}}": "turn",
    "{{agent_sdk_event}}": "event",
    "{{service_name}} {{http_response_status_code}}": "service+status",
}


def palette_overrides(targets: list):
    """Fixed colours from PALETTE, keyed off each target's legend format."""
    legends = [t.get("legendFormat") or "" for t in targets]
    joined = " ".join(legends)
    out = []
    if "{{http_response_status_code}}" in joined and "{{service_name}}" in joined:
        out.extend(service_status_colours())
    elif "{{service_name}}" in joined:
        out.extend(colours_from(PALETTE["service"]))
    if "{{factory_delivery_kind}}" in joined or "{{family}}" in joined:
        out.extend(kind_colours())
    if "{{factory_span}}" in joined:
        out.extend(label_colours(PALETTE["span"]))
    if "{{agent_sdk_channel}}" in joined:
        out.extend(colours_from(PALETTE["channel"]))
    if "{{class}}" in joined:
        out.extend(colours_from(PALETTE["outcome"]))
    if "{{level}}" in joined:
        out.extend(colours_from(PALETTE["level"]))
    if "{{agent_sdk_turn_status}}" in joined:
        out.extend(colours_from(PALETTE["turn"]))
    if "{{agent_sdk_event}}" in joined:
        out.extend(colours_from(PALETTE["event"]))
    for name, hex_c in PALETTE["token"].items():
        if name in legends or (name == "Cumulative estimated cost" and "Estimated cost" in legends):
            out.append(colour(name, color=Color(name=hex_c)))
    return tuple(out)


def named_colour(overrides: tuple | list, *, name: str) -> bool:
    for o in overrides:
        if o.get("matcher", {}).get("id") != "byName" or o.get("matcher", {}).get("options") != name:
            continue
        if any(p.get("id") == "color" for p in o.get("properties") or []):
            return True
    return False


def require_palette(targets: list, *, overrides: tuple | list):
    """Every timeseries legend is a PALETTE group or a named colour override."""
    for t in targets:
        legend = t.get("legendFormat") or ""
        if legend in ("", "__auto"):
            continue
        if "{{" in legend:
            if legend not in TEMPLATE_PALETTE:
                raise ValueError(f"timeseries legend {legend!r} has no PALETTE group")
            continue
        if named_colour(overrides, name=legend):
            continue
        if any(isinstance(group, dict) and legend in group for group in PALETTE.values()):
            continue
        raise ValueError(f"timeseries legend {legend!r} has no PALETTE colour")
    for row in palette_alarm_findings(overrides=overrides):
        raise ValueError(row)


def palette_alarm_findings(*, overrides: tuple | list | None = None,
                           palette: dict | None = None) -> list[str]:
    """Warn/error hues may only sit on severity, level, or error-outcome keys;
    saturated green never marks a category or a healthy state."""
    bad = []
    for group, mapping in (palette or PALETTE).items():
        if not isinstance(mapping, dict):
            continue
        for name, color in mapping.items():
            if is_alarm_hue(str(color)) and not alarm_key_allowed((group, name)):
                bad.append(f"PALETTE[{group!r}][{name!r}] = {color!r} is a warn/error hue")
            elif is_health_green(str(color)):
                bad.append(f"PALETTE[{group!r}][{name!r}] = {color!r} is a saturated green")
    for o in overrides or ():
        matcher = o.get("matcher") or {}
        opt = str(matcher.get("options") or "")
        for prop in o.get("properties") or []:
            if prop.get("id") != "color":
                continue
            color = (prop.get("value") or {}).get("fixedColor")
            if not color:
                continue
            if is_health_green(str(color)):
                bad.append(f"override {opt!r} uses saturated green {color!r}")
                continue
            if not is_alarm_hue(str(color)):
                continue
            if alarm_override_allowed(matcher=matcher):
                continue
            bad.append(f"override {opt!r} uses warn/error hue {color!r}")
    return bad


def alarm_override_allowed(*, matcher: dict) -> bool:
    """HTTP 4xx/5xx and named error-outcome series may use alarm hues."""
    matcher_id = matcher.get("id")
    options = str(matcher.get("options") or "")
    # Any 4xx/5xx status matcher shape: `4\d\d`, `4dd`, `4[0-9]{2}`, `4..`,
    # or a status_code label. The old r"4\\d\\d" needed a literal backslash-d.
    if matcher_id == "byRegexp" and (
            "status_code" in options or re.search(r"[45](?:\\?d\\?d|\[0-9\]|\.\.)", options)):
        return True
    for group, mapping in PALETTE.items():
        if not isinstance(mapping, dict) or options not in mapping:
            continue
        if is_alarm_hue(str(mapping[options])) and alarm_key_allowed((group, options)):
            return True
    if options in ("failure", "error", "failed", "fatal", "critical", "warn", "warning"):
        return True
    return False


def hidden_column_names(panel: dict) -> set:
    hidden = set()
    for o in (panel.get("fieldConfig") or {}).get("overrides") or []:
        if any(prop.get("id") == "custom.hidden" and prop.get("value") is True
               for prop in o.get("properties") or []):
            opt = (o.get("matcher") or {}).get("options")
            if opt:
                hidden.add(opt)
    return hidden


def visible_table_columns(panel: dict) -> list[str]:
    """Display names the last organize transform leaves visible, hidden ones removed."""
    org = None
    for t in panel.get("transformations") or []:
        if t.get("id") == "organize":
            org = t
    if org is None:
        return []
    options = org.get("options") or {}
    exclude = {k for k, v in (options.get("excludeByName") or {}).items() if v}
    rename = options.get("renameByName") or {}
    order = sorted((options.get("indexByName") or {}),
                   key=(options.get("indexByName") or {}).get)
    hidden = hidden_column_names(panel)
    out = []
    for key in order:
        display = rename.get(key, key)
        if key in exclude or key in hidden or display in hidden:
            continue
        out.append(display)
    return out


def check_column_width_budgets(dash: dict) -> list[str]:
    """Fixed custom.width plus minWidth floors of the visible columns must fit
    the 1280 table grid (WIDTH_BUDGET_1280). Columns with neither count at the
    table default minWidth, so an auto column cannot push a trailing one off."""
    bad = []
    uid = dash.get("uid", "?")
    for p in iter_panels(dash):
        if p.get("type") != "table":
            continue
        cols = (p.get("gridPos") or {}).get("w") or 24
        hidden = hidden_column_names(p)
        widths = {}
        for o in (p.get("fieldConfig") or {}).get("overrides") or []:
            name = (o.get("matcher") or {}).get("options")
            if not name or name in hidden:
                continue
            for prop in o.get("properties") or []:
                if prop.get("id") in ("custom.width", "custom.minWidth") and isinstance(prop.get("value"), int):
                    widths.setdefault(name, prop["value"])
        default_min = (((p.get("fieldConfig") or {}).get("defaults") or {})
                       .get("custom", {}).get("minWidth")) or 70
        visible = visible_table_columns(p)
        # span_table sets floors for every column it may show; count only the
        # columns this query leaves visible. Without organize, count overrides.
        if visible:
            counted = {name: widths.get(name, default_min) for name in visible}
        else:
            counted = dict(widths)
        total = sum(counted.values())
        budget = WIDTH_BUDGET_1280.get(cols)
        if budget is None:
            budget = (1280 * cols) // 24 - 16
        if total > budget:
            detail = " + ".join(f"{n}={v}" for n, v in counted.items())
            bad.append(f"{uid} / {p.get('title')}: column widths {total}px "
                       f"({detail}) > {budget}px budget at w={cols}")
    return bad


def no_dollar_dollar_findings(dash: dict) -> list[str]:
    """No target expression may contain $$: Grafana has no $$ escape, so it
    reaches the datasource as literal text (r14 HIGH, the $1 kind panel)."""
    bad = []
    uid = dash.get("uid", "?")
    for p in iter_panels(dash):
        for t in p.get("targets") or []:
            for key in ("expr", "query"):
                if isinstance(t.get(key), str) and "$$" in t[key]:
                    bad.append(f"{uid} / {p.get('title')} ({t.get('refId')}): {key} contains $$")
    return bad


# Transforms that reduce whole columns through reduceField() and so read a calc cached on the field
# by an earlier byValue filterFields (groupBy is the one replayed; reduce is kept out of the chain too).
REDUCER_TRANSFORMS = frozenset({"groupBy", "reduce"})


def is_value_filter(transform: dict) -> bool:
    """A filterFields step driven by a byValue reducer (EMPTY_FRAME_GUARD's shape)."""
    if transform.get("id") != "filterFields":
        return False
    options = transform.get("options") or {}
    return any((options.get(side) or {}).get("id") == "byValue" for side in ("include", "exclude"))


def guard_before_reducer_findings(dash: dict) -> list[str]:
    """No byValue filterFields may precede a groupBy / reduce in the same chain (EMPTY_FRAME_GUARD)."""
    bad = []
    uid = dash.get("uid", "?")
    for p in iter_panels(dash):
        xf = p.get("transformations") or []
        first_guard = next((i for i, t in enumerate(xf) if is_value_filter(t)), None)
        if first_guard is None:
            continue
        for t in xf[first_guard + 1:]:
            if t.get("id") in REDUCER_TRANSFORMS:
                bad.append(f"{uid} / {p.get('title')}: filterFields byValue at step {first_guard} precedes "
                           f"{t.get('id')} (cached calcs are reused per group)")
                break
    return bad


def align_right(name: str):
    return {"matcher": {"id": "byName", "options": name}, "properties": [{"id": "custom.align", "value": "right"}]}


def hide_empty_series(*, zeros: bool = False):
    """Hide a series whose remaining points are all null. Prometheus also hides a
    series whose legend sum is 0 (byValue / sum / eq). Loki error charts fill 0
    on purpose when a slug logged but had no error, so they keep those series."""
    hidden = (
        {"matcher": {"id": "byValue", "options": {"reducer": "allIsNull", "op": "eq", "value": 1}},
         "properties": [{"id": "custom.hideFrom", "value": {"legend": True, "tooltip": True, "viz": True}}]},
    )
    if zeros:
        hidden += (
            {"matcher": {"id": "byValue", "options": {"reducer": "sum", "op": "eq", "value": 0}},
             "properties": [{"id": "custom.hideFrom", "value": {"legend": True, "tooltip": True, "viz": True}}]},
        )
    return hidden


def bump_mapping_index(mapping: dict, *, by: int = 1) -> dict:
    out = dict(mapping)
    options = dict(mapping.get("options") or {})
    if mapping.get("type") == "value":
        options = {k: {**v, "index": v.get("index", 0) + by} if isinstance(v, dict) else v
                   for k, v in options.items()}
    elif isinstance(options.get("result"), dict) and "index" in options["result"]:
        options = {**options, "result": {**options["result"], "index": options["result"]["index"] + by}}
    out["options"] = options
    return out


def with_nil_blank(mappings: list) -> list:
    """Tempo writes the string nil for a missing attribute. Map it to blank
    on the field itself so a catch-all byRegexp .* cannot wipe colours."""
    return [{"type": "value", "options": {"nil": {"text": "", "index": 0}}},
            *(bump_mapping_index(m) for m in mappings)]


def value_colours(name: str, *, mapping: list):
    """Colours a table cell's text by its value (e.g. failure red). mapping is [(value, color)].
    Unmapped values stay the theme text colour — Grafana's default 80-red would paint '200' red."""
    return {"matcher": {"id": "byName", "options": name}, "properties": [
        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
        {"id": "color", "value": {"mode": "thresholds"}},
        {"id": "thresholds", "value": steps([(None, "text")])},
        {"id": "mappings", "value": with_nil_blank([{"type": "value", "options": {
            v: {"color": c, "index": i} for i, (v, c) in enumerate(mapping)}}])},
    ]}


def http_status_colours(name: str):
    """HTTP status: 5xx red, 4xx orange, everything else the theme text."""
    return {"matcher": {"id": "byName", "options": name}, "properties": [
        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
        {"id": "color", "value": {"mode": "thresholds"}},
        {"id": "thresholds", "value": steps([(None, "text")])},
        {"id": "mappings", "value": with_nil_blank([
            {"type": "regex", "options": {"pattern": "^5..$", "result": {"color": "red", "index": 0}}},
            {"type": "regex", "options": {"pattern": "^4..$", "result": {"color": "orange", "index": 1}}},
        ])},
    ]}


def outcome_cell_colours(name: str):
    """Status / Outcome text: errors red, no-ops grey, ok/success the theme text."""
    return {"matcher": {"id": "byName", "options": name}, "properties": [
        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
        {"id": "color", "value": {"mode": "thresholds"}},
        {"id": "thresholds", "value": steps([(None, "text")])},
        {"id": "mappings", "value": with_nil_blank([
            {"type": "regex", "options": {"pattern": f"^(?:{ERR_RE})$",
                                          "result": {"color": PALETTE["outcome"]["error"], "index": 0}}},
            {"type": "regex", "options": {"pattern": f"^(?:{NOOP_RE}|.*_skipped|.*_ignored)$",
                                          "result": {"color": PALETTE["outcome"]["noop"], "index": 1}}},
            # Named "blue", not PALETTE's #88CCEE: as cell text the pale cyan
            # is unreadable on the light theme, and named colours resolve
            # per theme (bars/legends still use the palette hex).
            {"type": "regex", "options": {"pattern": f"^(?:{HANDOFF_RE})$",
                                          "result": {"color": "blue", "index": 2}}},
            {"type": "regex", "options": {"pattern": "^(ok|success|completed)$",
                                          "result": {"color": PALETTE["severity"]["calm"], "index": 3}}},
            {"type": "regex", "options": {"pattern": "^(error|failed|failure)$",
                                          "result": {"color": PALETTE["outcome"]["error"], "index": 4}}},
        ])},
    ]}


def organize_display_names(transforms: tuple):
    names = []
    for t in transforms:
        if t.get("id") == "organize":
            names.extend((t.get("options") or {}).get("renameByName", {}).values())
    return names


# ------------------------------------------------------------------------------------------------
# Panels
# ------------------------------------------------------------------------------------------------
NEUTRAL = "text"


def steps(pairs: list):
    return {"mode": "absolute", "steps": [{"color": c, "value": v} for v, c in pairs]}


def severity_steps(bounds: tuple):
    """bounds is ((value, 'calm'|'good'|'warn'|'bad'), ...). good is Okabe-Ito #009E73."""
    return steps([(value, PALETTE["severity"][kind]) for value, kind in bounds])


def neutral_colour():
    return {"color": {"mode": "fixed", "fixedColor": NEUTRAL}, "thresholds": steps([(None, NEUTRAL)])}


def base(ptype: str, *, copy: Copy, ds: dict | None, targets: list | None):
    p = {"type": ptype, "title": copy.title, "description": copy.desc, "fieldConfig": {"defaults": {}, "overrides": []},
         "options": {}}
    if ds is not None:
        p["datasource"] = ds
        p["targets"] = targets
    return p


def stat(copy: Copy, *, query: Query, unit: str | None = None, thresholds: dict | None = None,
         kind: str = "volume", decimals: int | None = None, no_value: str | None = None,
         links: list | None = None, time_from: str | None = None, text: dict | None = None,
         text_mode: str = "value", reduce: Reduce | None = None, calcs: list | None = None,
         pin_title: bool = False, color_mode: str | None = None, sparkline: bool = False,
         fixed_color: str | None = None, delta: bool = False):
    """kind: volume, tokens, good_bad, ratio or latency.

    sparkline: area under the value (needs a range query). delta: % vs the previous period.
    color_mode: Grafana stat colorMode (value, background, background_solid, none).
    fixed_color: paints volume/tokens tiles a non-grey fixed colour (with threshold mode).
    calcs overrides Reduce.calc (Prometheus lastNotNull; Tempo/Loki count stats want sum)."""
    p = base("stat", copy=copy, ds=query.ds, targets=[query.expr])
    d = p["fieldConfig"]["defaults"]
    # Volume counts use locale integers (1,472), not the short 2 K / 4 K scale.
    if unit is None:
        unit = "locale" if kind in ("volume", "good_bad", "tokens") else "short"
    d["unit"] = unit
    if decimals is None and unit in ("short", "none", "locale") and kind in ("volume", "good_bad", "tokens"):
        decimals = 0
    if kind in ("volume", "tokens"):
        if fixed_color:
            d["color"] = {"mode": "thresholds"}
            d["thresholds"] = steps([(None, fixed_color)])
        else:
            d.update(neutral_colour())
        d["noValue"] = "0" if no_value is None else no_value
    else:
        d["color"] = {"mode": "thresholds"}
        th = thresholds or severity_steps(((None, "calm"),))
        if th["steps"][0]["color"] != PALETTE["severity"]["calm"]:
            th = {"mode": "absolute", "steps": [{"color": PALETTE["severity"]["calm"], "value": None},
                                               {**th["steps"][0], "value": 0}] + th["steps"][1:]}
        d["thresholds"] = th
        d["noValue"] = no_value or "none"
    if decimals is not None:
        d["decimals"] = decimals
    red = reduce or Reduce()
    used = calcs if calcs is not None else [red.calc]
    mode = color_mode or ("background" if (sparkline or fixed_color) else "value")
    if mode == "background" and "thresholds" in d:
        # Calm must stay unfilled on a background tile (see background()). Copy steps so
        # severity_steps() literals shared across panels are not mutated in place.
        steps_out = [{**s} for s in (d["thresholds"].get("steps") or [])]
        for step in steps_out:
            if step.get("color") == PALETTE["severity"]["calm"]:
                step["color"] = "transparent"
        d["thresholds"] = {**d["thresholds"], "steps": steps_out}
    p["options"] = {"reduceOptions": {"calcs": used, "fields": red.fields, "values": False},
                    "colorMode": mode, "graphMode": "area" if sparkline else "none",
                    "textMode": text_mode, "justifyMode": "auto",
                    "orientation": "auto", "wideLayout": True, "showPercentChange": delta}
    sizes = text or {"title": 14, "value": 32}
    p["options"]["text"] = {"titleSize": sizes["title"], "valueSize": sizes["value"]}
    if time_from:
        p["timeFrom"] = time_from
        # The time-override badge eats the w=4/w=6 title at 1280, so hide it.
        # The window lives in the row title ("Now · last 15m"); pin_title
        # keeps the old per-title suffix for stats outside such a row.
        p["hideTimeOverride"] = True
        if pin_title and f"· {time_from}" not in p["title"]:
            p["title"] = f"{p['title']} · {time_from}"
    if links:
        p["links"] = links
    return p


def timeseries(copy: Copy, *, log_y: bool = False, ds: dict, targets: list, unit: str = "none",
               bars: bool = True, interval: str = "$bucket", overrides: tuple = (),
               calcs: list | None = None, keep_zeros: bool = False, no_value: str | None = None,
               decimals: int | None = None, count: bool | None = None, legend: dict | None = None,
               percent: bool = False, color: dict | None = None, points: bool = False,
               links: list | None = None):
    p = base("timeseries", copy=copy, ds=ds, targets=targets)
    d = p["fieldConfig"]["defaults"]
    d["unit"] = unit
    if links:
        d["links"] = links
    d["color"] = color or {"mode": "fixed", "fixedColor": PALETTE["outcome"]["other"]}
    if count is None:
        count = unit in ("short", "none") and bars and not percent
    if decimals is None and count:
        decimals = 0
    if decimals is not None:
        d["decimals"] = decimals
    d["noValue"] = no_value or empty_state(EmptyState(missing="No data in range", action="Widen the time range"))
    stack = "percent" if percent else ("normal" if bars else "none")
    if bars:
        d["custom"] = {"drawStyle": "bars", "barAlignment": 1, "fillOpacity": 80, "lineWidth": 1,
                       "showPoints": "never", "spanNulls": False, "stacking": {"mode": stack, "group": "A"},
                       "axisSoftMin": 0}
    else:
        d["custom"] = {"drawStyle": "line", "lineWidth": 1, "fillOpacity": 0,
                       "showPoints": "always" if points else "never",
                       "spanNulls": False, "stacking": {"mode": stack, "group": "A"},
                       "axisSoftMin": 0}
        if points:
            d["custom"]["pointSize"] = 4
    if log_y:
        d["custom"].pop("axisSoftMin", None)
        d["custom"]["scaleDistribution"] = {"type": "log", "log": 10}
    if count:
        d["custom"]["axisSoftMax"] = 1
    # keep_zeros: zero-filled per-service panels list idle slugs at 0.
    p["fieldConfig"]["overrides"] = [*hide_empty_series(zeros=ds is PROM and not keep_zeros),
                                     *palette_overrides(targets), *overrides]
    require_palette(targets, overrides=p["fieldConfig"]["overrides"])
    lg = legend or {}
    legend_opts = {"displayMode": lg.get("display", "list"), "placement": lg.get("placement", "bottom"),
                   "showLegend": True,
                   "calcs": calcs if calcs is not None else []}
    for key in ("width", "sortBy", "sortDesc"):
        if key in lg:
            legend_opts[key] = lg[key]
    p["options"] = {"legend": legend_opts, "tooltip": {"mode": "multi", "sort": "desc"}}
    if interval:
        p["interval"] = interval
    # Prometheus keeps the bar that straddles $__from (samples are capped in PromQL).
    # Loki cannot, so it still drops Time < $__from.
    p["transformations"] = [drop_before_range()] if ds is LOKI else []
    return p


def table(copy: Copy, *, ds: dict, targets: list, transforms: tuple = (),
          unit: str | None = None, overrides: tuple = (), footer: list | None = None,
          no_value: str | None = None, sort: tuple | None = None, decimals: int | None = None):
    p = base("table", copy=copy, ds=ds, targets=targets)
    d = p["fieldConfig"]["defaults"]
    if unit:
        d["unit"] = unit
    if decimals is not None:
        d["decimals"] = decimals
    if no_value:
        d["noValue"] = no_value
    d["custom"] = {"align": "auto", "cellOptions": {"type": "auto"}, "filterable": False, "minWidth": 70}
    auto = []
    for name in organize_display_names(transforms):
        if name in ("Outcome", "Status"):
            auto.append(outcome_cell_colours(name))
    linked = any(o.get("matcher", {}).get("options") == "Service" and any(x["id"] == "links" for x in o["properties"])
                 for o in overrides)
    if "Service" in organize_display_names(transforms) and not linked:
        auto.append(links_on("Service", links=[SERVICE_OPS]))
    p["fieldConfig"]["overrides"] = [*auto, *overrides]
    if no_value:
        # defaults.noValue is the panel's empty-state text; without this it would also fill every blank cell.
        # Blank cells stay blank (not a grey "-") so Ticket/PR stay unlinked and Tempo nil can map to "".
        p["fieldConfig"]["overrides"].append({"matcher": {"id": "byRegexp", "options": "/.*/"},
                                              "properties": [{"id": "noValue", "value": ""}]})
    p["options"] = {"showHeader": True, "cellHeight": "sm",
                    "footer": {"show": bool(footer), "reducer": ["sum"], "countRows": False,
                               "fields": footer or "", "enablePagination": False}}
    if sort:
        p["options"]["sortBy"] = [{"displayName": sort[0], "desc": sort[1]}]
    xf = list(transforms) if transforms else []
    xf.append(EMPTY_FRAME_GUARD)
    p["transformations"] = xf
    return p


def logs(copy: Copy, *, target: dict, no_value: str | None = None, wrap: bool = True):
    note = ' Grafana\'s logs panel shows "No data" when there are no lines.'
    if "No data" not in copy.desc:
        copy = Copy(title=copy.title, desc=copy.desc + note)
    p = base("logs", copy=copy, ds=LOKI, targets=[target])
    if no_value:
        p["fieldConfig"]["defaults"]["noValue"] = no_value
    p["options"] = {"showTime": True, "showLabels": False, "showCommonLabels": False, "wrapLogMessage": wrap,
                    "prettifyLogMessage": False, "enableLogDetails": True, "enableInfiniteScrolling": False,
                    "dedupStrategy": "none", "sortOrder": "Descending"}
    return p


def text(copy: Copy, *, content: str):
    p = base("text", copy=copy, ds=None, targets=None)
    p["options"] = {"mode": "markdown", "content": content, "code": {"language": "plaintext",
                                                                      "showLineNumbers": False,
                                                                      "showMiniMap": False}}
    return p


def bar_gauge(copy: Copy, *, query: Query, unit: str = "currencyUSD", decimals: int = 2,
              no_value: str | None = None):
    """Horizontal bars in service colours. Empty ranges show no_value over a hairline."""
    p = base("bargauge", copy=copy, ds=query.ds, targets=[query.expr])
    d = p["fieldConfig"]["defaults"]
    d["unit"] = unit
    d["decimals"] = decimals
    d["min"] = 0
    d["noValue"] = no_value or "none"
    d.update(neutral_colour())
    p["fieldConfig"]["overrides"] = list(palette_overrides([query.expr]))
    # Name beside the bar and manual 22–28 px bars: six name-above-bar pairs
    # at valueSize 24 overflowed the panel and were unreadable at 1280 (r14 H2).
    p["options"] = {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "orientation": "horizontal", "displayMode": "basic", "showUnfilled": False,
                    "valueMode": "color", "namePlacement": "left", "sizing": "manual",
                    "minVizWidth": 0, "minVizHeight": 22, "maxVizHeight": 28,
                    "text": {"titleSize": 12, "valueSize": 16}}
    return p


def status_history(copy: Copy, *, target: dict, interval: str):
    p = base("status-history", copy=copy, ds=PROM, targets=[target])
    d = p["fieldConfig"]["defaults"]
    d["unit"] = "none"
    d["decimals"] = 0
    # Thresholds, not continuous-blues: a continuous scheme hid 1–3
    # deliveries (planner, triage) as the same near-white as empty.
    d["color"] = {"mode": "thresholds"}
    d["min"] = 0
    d["thresholds"] = steps([
        (None, "transparent"),
        (1, "#9ecae1"),
        (3, "#6baed6"),
        (10, "#3182bd"),
        (25, "#08519c"),
    ])
    d["mappings"] = [{"type": "value", "options": {
        "0": {"text": "", "color": "transparent", "index": 0}}}]
    d["custom"] = {"fillOpacity": 100, "lineWidth": 0}
    d["noValue"] = "No activity"
    p["options"] = {"showValue": "never", "rowHeight": 0.85, "colWidth": 0.85,
                    "legend": {"showLegend": False, "displayMode": "list", "placement": "bottom"},
                    "tooltip": {"mode": "single", "sort": "none"}}
    p["interval"] = interval
    # Status history refuses ~1000 cells; on long ranges Grafana widens the bucket instead.
    p["maxDataPoints"] = 200
    p["transformations"] = [EMPTY_FRAME_GUARD]
    return p


# TablePanel (13.1+) shows defaults.noValue only when there are
# no frames or no fields (!count || !hasFields). A zero-row Tempo/Loki
# frame still has a schema, so merge + calculateField leave a header-only
# table. filterFields include-by-count>0 (hidden transformer from 13.1)
# keeps fields that have values and omits a frame with no matching fields
# (filter.ts), so PanelDataErrorView renders noValue. count, not
# allIsNull: Grafana's allIsNull stays true on string fields even when
# they have values. On 12.2–13.0 the registry throws and the table is blank.
#
# Placement: this guard is a byValue field matcher, and reduceField() caches
# the whole-column calcs it computes in field.state.calcs. groupBy later
# reduces a copy of each field that still carries that cache, so every group
# reads the whole column's max / last (replayed on @grafana/data 13.2.3: all
# tickets showed the newest span's stage and time). sortBy, merge,
# filterFieldsByName and limit do not clear the cache. So the guard never
# sits before a groupBy or reduce in a chain (table() appends it at the end,
# after any grouping); guard_before_reducer_findings() and the node tests
# gate it. An early guard ahead of non-reducing steps (span tables, the
# stage timeline's partitionByValues) is harmless.
# calculateField reduceRow reduces a synthetic row field and is unaffected.
EMPTY_FRAME_GUARD = {
    "id": "filterFields",
    "options": {
        "include": {
            "id": "byValue",
            "options": {"reducer": "count", "op": "gt", "value": 0},
        }
    },
}
# Tempo's search-progress frame (State, Elapsed Time, …) has rows, so
# filterFields(count>0) keeps it and TablePanel draws that instead of
# noValue. Drop those fields first; an empty search then has no fields.
TEMPO_PROGRESS_DROP = {
    "id": "filterFieldsByName",
    "options": {"exclude": {"names": [
        "State", "Elapsed Time", "Total Blocks", "Completed Jobs", "Total Jobs", "Progress",
    ]}},
}


def organize(rename: dict, *, order: list, exclude: tuple = ()):
    return {"id": "organize", "options": {"excludeByName": {k: True for k in exclude},
                                          "indexByName": {k: i for i, k in enumerate(order)},
                                          "renameByName": rename, "includeByName": {}}}


def keep_fields(names: list):
    return {"id": "filterFieldsByName", "options": {"include": {"names": list(names)}}}


def decimals_on(name: str, *, n: int):
    return {"matcher": {"id": "byName", "options": name}, "properties": [{"id": "decimals", "value": n}]}


# Grafana's binary calculateField propagates a missing operand as NaN (the two factory-desk turns
# with no cache-read attribute). reduceRow sum of one field with null-as-zero yields 0, then subtract.
# A second helper (input * 0) and reduceRow max floor the difference at 0. This is the gross rule only:
# Grafana's transforms have no per-row conditional, so a cloud turn's row (input net of cache reads, cache read
# > input) floors to 0 where uncached_input() in PromQL would keep the whole input. The Traces table says so;
# every priced panel is PromQL and takes the per-series rule.
CACHE_READ_OR_0 = "cache_read_or_0"
UNCACHED_RAW = "uncached_raw"
ZERO_FIELD = "zero"
UNCACHED_HELPERS = (CACHE_READ_OR_0, UNCACHED_RAW, ZERO_FIELD)


def uncached_input_transforms(fields: TokenFields, *, alias: str = "Uncached"):
    return [
        {"id": "calculateField", "options": {
            "mode": "reduceRow", "alias": CACHE_READ_OR_0,
            "reduce": {"include": [fields.cache_read], "reducer": "sum", "nullValueMode": "null as zero"}}},
        {"id": "calculateField", "options": {
            "mode": "binary", "alias": UNCACHED_RAW,
            "binary": {"left": fields.input, "operator": "-", "right": CACHE_READ_OR_0}}},
        {"id": "calculateField", "options": {
            "mode": "binary", "alias": ZERO_FIELD,
            "binary": {"left": fields.input, "operator": "*", "right": "0"}}},
        {"id": "calculateField", "options": {
            "mode": "reduceRow", "alias": alias,
            "reduce": {"include": [UNCACHED_RAW, ZERO_FIELD], "reducer": "max", "nullValueMode": "null as zero"}}},
    ]


# ------------------------------------------------------------------------------------------------
# Layout: panels flow left to right inside a row; ids follow layout order, so they are stable.
# ------------------------------------------------------------------------------------------------
class Dashboard:
    def __init__(self, meta: DashMeta, *, variables: list, nav_link: bool = True):
        self.uid, self.title, self.description, self.variables = meta.uid, meta.title, meta.description, variables
        self.nav_link = nav_link
        self.panels, self.next_id = [], 1
        self.x = self.y = self.line_h = 0
        self.current_row = None

    def _newline(self):
        self.y += self.line_h
        self.x = self.line_h = 0

    def row(self, title: str, *, collapsed: bool = False):
        self._newline()
        if self.current_row is not None and self.current_row["collapsed"]:
            self.y = self.current_row["gridPos"]["y"] + 1
        r = {"type": "row", "title": title, "collapsed": collapsed, "panels": [], "id": self.next_id,
             "gridPos": {"h": 1, "w": 24, "x": 0, "y": self.y}}
        self.next_id += 1
        self.panels.append(r)
        self.current_row = r
        self.y += 1

    def add(self, panel: dict, *, size: Size):
        if self.x + size.w > 24:
            self._newline()
        panel["id"] = self.next_id
        self.next_id += 1
        panel["gridPos"] = {"h": size.h, "w": size.w, "x": self.x, "y": self.y}
        self.x += size.w
        self.line_h = max(self.line_h, size.h)
        if self.current_row is not None and self.current_row["collapsed"]:
            self.current_row["panels"].append(panel)
        else:
            self.panels.append(panel)

    def json(self):
        return {
            "uid": self.uid, "title": self.title, "description": self.description,
            "tags": ["software-factory", "otel"], "timezone": "browser", "editable": True, "graphTooltip": 1,
            "refresh": "5m", "schemaVersion": 41, "fiscalYearStartMonth": 0, "liveNow": False, "weekStart": "",
            "time": {"from": "now-24h", "to": "now"},
            "timepicker": {"refresh_intervals": ["1m", "5m", "15m", "30m", "1h"]},
            "links": dashboard_links() if self.nav_link else [], "annotations": {"list": []},
            "templating": {"list": self.variables}, "panels": self.panels,
        }


def custom_var(spec: VarSpec, *, options: list, hide: int = 0):
    """options: [(text, value)]."""
    return {"name": spec.name, "label": spec.label, "type": "custom", "hide": hide, "description": spec.desc,
            "query": ", ".join(t if t == v else f"{t} : {v}" for t, v in options),
            "options": [{"text": t, "value": v, "selected": v == spec.default} for t, v in options],
            "current": {"text": next(t for t, v in options if v == spec.default), "value": spec.default},
            "includeAll": False, "multi": False}


def textbox_var(spec: VarSpec, *, hide: int = 0):
    return {"name": spec.name, "label": spec.label, "type": "textbox", "query": spec.default, "hide": hide,
            "description": spec.desc,
            "current": {"text": spec.default, "value": spec.default},
            "options": [{"text": spec.default, "value": spec.default, "selected": True}]}


def query_var(spec: VarSpec, *, expr: PromQL, capture: Capture, hide: int = 2):
    """A Prometheus query_result variable. refresh=2 re-runs when the time range changes.

    Classic form (qryType 5, query_result(...)): Grafana Cloud (13.1+;
    verified on 13.3.0) with qryType 3 and a bare expression sends
    GET /api/v1/series?match[]= , Prometheus answers 400, and the
    variable set fails the whole dashboard. The UI saves
    query_result(<expr>) in both query.query and definition.
    Proven at 24h → 1m and 30d → 5m (411ab7a).
    """
    wrapped = f"query_result({expr.expr})"
    return {"name": spec.name, "label": spec.label, "type": "query", "datasource": PROM,
            "query": {"qryType": 5, "query": wrapped, "refId": "PrometheusVariableQueryEditor-VariableQuery"},
            "definition": wrapped, "refresh": 2, "regex": capture.pattern, "sort": 0, "hide": hide,
            "includeAll": False, "multi": False, "options": [],
            "current": {"text": spec.default, "value": spec.default},
            "description": spec.desc}


def _range_pick(*, pick: RangePick):
    span = f"{TO_CAP} - {FROM_CAP}"
    return (f'(label_replace(vector(1), "{pick.label}", "{pick.long}", "", "") and on() (vector({span}) >= {LONG_RANGE_S}))'
            f' or (label_replace(vector(1), "{pick.label}", "{pick.short}", "", "")'
            f' and on() (vector({span}) < {LONG_RANGE_S}))')


def prom_res_var():
    # 1m when range < 7d, 5m at 7d+. Use to−from seconds (not $__range_s): Grafana
    # substitutes those built-ins on query_result variables. Only one series
    # matches, so the variable is a single duration.
    return query_var(VarSpec(name="prom_res", label="Prom subquery step", default=PROM_RES_SHORT, desc="Inner step of the Prometheus look-ahead and range subqueries. 1m below 7d "
                     "(matches scrape); 5m at 7d+ for latency and query-cost (negative-offset "
                     "subqueries are uncached). Measured on 20 token series: 30d 1m was 3.28s / "
                     "9.16M samples (peakSamples 475k) and 5m is 0.88s / 1.9M (peak 95k). Hidden; "
                     "if the query fails Grafana keeps the JSON default 1m."),
                     expr=PromQL(expr=_range_pick(pick=RangePick(label="step", long=PROM_RES_LONG, short=PROM_RES_SHORT))),
                     capture=Capture(pattern='/step="([^"]+)"/'))


def smooth_var():
    # At least the subquery step: 2m below 7d, 5m at 7d+. A 2m window on a
    # 5m grid never reads 3 minutes of every 5, so a short-lived VM vanishes.
    return query_var(VarSpec(name="smooth", label="Counter smooth", default=SMOOTH_SHORT, desc="Running-max window inside the Prometheus subquery for _total counters. "
                     "2m below 7d (hides multi-writer flips shorter than 2m); 5m at 7d+ "
                     "so every ${prom_res} step sees the samples in that step. Hidden."),
                     expr=PromQL(expr=_range_pick(pick=RangePick(label="smooth", long=SMOOTH_LONG, short=SMOOTH_SHORT))),
                     capture=Capture(pattern='/smooth="([^"]+)"/'))


def bucket_var(*, hide: int = 0):
    return custom_var(VarSpec(name="bucket", label="Bucket", default="15m", desc="Width of each bar in the per-bucket panels. Prometheus widens the step on long "
                      "ranges; Loki stays on this value. On a live range (to = now) the last bar is "
                      "the in-progress bucket. Prometheus stops the last bar at the last whole "
                      "${prom_res} step at or before $__to (1m below 7d, 5m at 7d+) and keeps the "
                      "bar that straddles $__from. A range end off that grid leaves up to one "
                      "${prom_res} step out of both the bars and the range stats; the two still agree. On a range that ends before now, a "
                      "Loki last bar covers its whole bucket and can include up to one step after "
                      "the range end. The first Loki bar starts at the first step boundary at or "
                      "after the range start, so the left edge can show a gap."),
                      options=[(v, v) for v in ("5m", "15m", "30m", "1h")], hide=hide)


def ticket_var():
    return textbox_var(VarSpec(name="ticket", label="Ticket", default="", desc="A Jira key such as TLSSN-56. Empty means no ticket is selected: the ticket panels stay empty and every other panel is unfiltered."))


PRICE_DESC = (f"USD per 1M tokens, Cursor list price ({PRICES_URL}, retrieved {PRICES_DATE}). Default: Grok 4.6 Fast, "
              "the desk's and triage's model.")


def price_vars(hide: int = 0):
    return [
        textbox_var(VarSpec(name="price_input", label="Input $/1M", default="4", desc=PRICE_DESC + " Input: $4."), hide=hide),
        textbox_var(VarSpec(name="price_cache_read", label="Cache read $/1M", default="1", desc=PRICE_DESC + " Cache read: $1."), hide=hide),
        textbox_var(VarSpec(name="price_output", label="Output $/1M", default="12", desc=PRICE_DESC + " Output: $12."), hide=hide),
        textbox_var(VarSpec(name="price_reasoning", label="Reasoning $/1M", default="0", desc="Reasoning tokens are counted inside output by the providers involved, so the default is $0. Set it to the output price only if your provider bills reasoning on top of output."),
                    hide=hide),
    ]


# ------------------------------------------------------------------------------------------------
# Shared descriptions
# ------------------------------------------------------------------------------------------------
COUNT_CAVEAT = ("Counter totals can read high after a host changes instance id; Loki/Tempo are the reference.")
COUNTER_NOTE = ("Counted with counter_inc (see the folder README): hosted VMs are short-lived and each is its own "
                "series, which increase() and rate() would undercount. " + COUNT_CAVEAT)
TWO_WRITERS = ("Some of these histogram series have two writers (a restored VM rewriting its series), so the "
               "quantile is noisy, and no panel uses the _sum/_count mean, which those series make unreliable.")
BUCKET_VS_RANGE = ("The range stats and tables are the totals for the whole window. They use "
                   "the same ${prom_res} subquery and reset rule as the bars. For _total, the "
                   "subquery inner is max_over_time(s[${smooth}]) (${smooth} is 2m below 7d, "
                   "5m at 7d+, always at least ${prom_res}). increase() runs when that "
                   "smoothed window dropped (resets>0), including a restart whose new life "
                   "passes the old maximum; on a range no longer than about ${smooth} plus "
                   "one step, a single restart near the range start is also counted from the "
                   "raw samples. Flips shorter than ${smooth} become a stable "
                   "high-water mark. Flips longer than ${smooth} can make a bar take "
                   "increase() leftover. Writer flips longer than ${smooth} are read as "
                   "restarts; bars and range can then both read many times high — each flip "
                   "re-counts up to the counter's full lifetime value — and Loki/Tempo are "
                   "the reference. Otherwise, after a plain "
                   "restart the range and the bars are both increase() estimates (±10–20%). "
                   "Per-bucket Prometheus legends match the range within "
                   "that leftover, rounding on count bars, and up to one ${prom_res} step "
                   "when $__to is not on the subquery grid (bars and range stats then both "
                   "omit it). A Loki bar chart can include the last bar past a range that "
                   "ends before now and can miss up to one step at the range start. Quote "
                   "the range stats; treat bars after a restart as estimates.")
BUCKET_NOTE = ("Each bar is the count in the bucket starting at it (bucket = $bucket): the "
               "point at t covers (t, t+step]. Prometheus uses $__interval, a one-step "
               "negative offset, and a ${prom_res} subquery (1m below 7d, 5m at 7d+) that "
               "keeps only samples with from ≤ time() ≤ to. The last bar on a range that "
               "ends before now stops at the last whole ${prom_res} step at or before "
               "$__to (the subquery grid); a range end that is not on that grid leaves "
               "up to one ${prom_res} step of events out of both the bars and the range stats "
               "(the two still agree). The first "
               "bar can start one step before $__from while counting only samples at or "
               "after $__from. The step is $bucket; Prometheus widens it on long ranges. "
               "On a live range (to = now) the last bar is the in-progress bucket. "
               ) + BUCKET_VS_RANGE + " " + COUNTER_NOTE
LOKI_BUCKET_NOTE = ("Each bar is the count of matching log lines in the bucket starting at it "
                    "(bucket = $bucket): the point at t covers (t, t+step]. Loki uses $__auto "
                    "with step=$bucket and a one-step negative offset so the in-progress bucket "
                    "is included (a 5m bucket over more than about 38 days exceeds Loki's "
                    "11,000-point limit). On a live range (to = now) the last bar is the in-progress bucket. "
                    "On a range that ends before now, the last bar covers its whole bucket and can include "
                    "up to one step after the range end. LogQL has no subqueries, so a Loki bar cannot "
                    "be capped at $__to. The first bar starts at the first "
                    "step boundary at or after the range start, so events between the range start and that "
                    "boundary (up to one step) are in the range stats but in no bar, and the left edge can "
                    "show a gap. Quote the range stats.")
ALL_SERVICES_NOTE = "All six factory slugs are always listed; an idle slug shows 0."
TURNS_CAVEAT = ("Only factory-desk, factory-planner and factory-security-reviewer run model "
                "turns; the other slugs show 0.")
NOW_NOTE = ("These 15-minute stats use a 1m subquery step, not the dashboard "
            "${prom_res}, so a 7d+ view still counts all 15 minutes. On a live "
            "range the newest scrape can sit after the last whole 1m step "
            "(≤ one scrape of lag versus Loki).")
QUANTILE_NOTE = ("Quantiles interpolate inside histogram buckets, so at low volume p95 reads as the upper edge of the "
                 "bucket it falls in (\"≤ that edge\"), not an exact value.")
FACTORY_SPANS_NOTE = ("Each factory.* span is a sampled root of its own trace (on every slug), with a span "
                      "link to the inbound agent_sdk.http context, so this panel searches factory spans directly "
                      "(never as children of agent_sdk.http) and Span ID opens the span's own trace. Empty when "
                      "no matching factory span is in range (no traffic, or none for the selected slug). July's "
                      "agent_sdk.http is still recorded only when Cursor's backend sampled the inbound request.")
NO_FACTORY_SPANS = "Nothing in range"
NONE_GOOD = "✓ None — good"
TWO_SHAPES_NOTE = ("Input has two shapes on this metric and no label tells them apart: a host turn (desk, triage, the "
                   "planner before #227) reports it gross (cache reads inside it), a cloud turn (the planner since #227, "
                   "the worker since #229) reports it net of cache reads. Uncached input is decided per series before "
                   "any sum, as July's own turn-cost.js toCatalogDisjointUsage does: input - cache_read where cache_read "
                   "<= input (gross), the whole input where cache_read > input (net) or where there is no cache_read "
                   "series. A cloud series whose input happens to reach its cache reads is read as gross and undercounted "
                   "by them; one pod+ticket series that mixes local and cloud turns is classified as a whole.")
ESTIMATE_NOTE = (f"ESTIMATE, not billing: tokens × the price variables (USD per 1M tokens, Cursor list prices from "
                 f"{PRICES_URL}, retrieved {PRICES_DATE}; default Grok 4.6 Fast: $4 input, $1 cache read, $12 output, "
                 "reasoning $0 because it is inside output). Uncached input is priced at the input price and cache reads "
                 "once at the cache price. " + TWO_SHAPES_NOTE + " " + JULY_COST_NOTE + " So one "
                 "price set is applied to every slug. Hosts on Cursor Auto bill at the list price of whatever model "
                 "each request was routed to (Grok 4.6 $2/$0.5/$6, Claude Opus 5.5 $4/$0.20/$20); neither Auto "
                 "routing nor the Cursor Token Rate for third-party models is modelled. Built from token counters, so it "
                 "is approximate like them. " + COUNT_CAVEAT + " "
                 "Set var-price_input (and the other price_* variables) in the URL "
                 "or Settings → Variables.")


# ------------------------------------------------------------------------------------------------
# v2: ticket stages. Jira is the bus: the desk announces every status a ticket enters into the ticket's
# Slack thread, in a factory.background span `jira.announce.<status>` tagged factory.ticket.key
# (factory-desk channels/jira.ts, lib/status-event.ts). Every stage is the desk's, so stage panels ignore
# $service. The Prometheus counter of the same spans misses status changes, so stage panels read Tempo.
# ------------------------------------------------------------------------------------------------
MIXED = {"type": "datasource", "uid": "-- Mixed --"}
ANNOUNCE = "jira.announce."
# (stage, the Jira status the desk announces)
STAGES = [("filed", "triaged"), ("planned", "planned"), ("approved", "approved"),
          ("building", "in_progress"), ("PR opened", "in_review"), ("merged", "done")]
STAGE_NAMES = [stage for stage, _ in STAGES]
STAGE_KINDS = "jira[.]announce[.](" + "|".join(status for _, status in STAGES) + ")"
# Outcomes the desk announces into the thread while the ticket stays in Triaged or Approved: the hop was answered,
# so they end "waiting". (outcome, label, colour)
ANNOUNCE_OUTCOMES = [("needs_info", "needs info", "#8f8f8f"), ("plan_stopped", "plan stopped", "#8f8f8f"),
                     ("approved_without_plan", "approved without plan", "#8f8f8f"), ("launch_failed", "launch failed", "red")]
STATE_KINDS = "jira[.]announce[.](" + "|".join([status for _, status in STAGES] + [o for o, _, _ in ANNOUNCE_OUTCOMES]) + ")"
# One ramp from pale blue to deep violet, lightness falling in even steps (filed lightest, merged darkest), so
# neighbours separate (1.4-2x luminance) without saturated green or red; segments get a 1px separator. Funnel drops
# are grey.
STAGE_RAMP = ["#CDE0F3", "#99BBE6", "#6891D4", "#4055BF", "#4B3993", "#421F6B"]
STAGE_COLOURS = dict(zip(STAGE_NAMES, STAGE_RAMP))
TICKET_SPAN_ATTR = "factory.ticket.key"
DELIVERY_KIND = "factory.delivery.kind"
START_TIME = "Start time"
# Tempo returns at most this many spans per search; a ticket's spans beyond it are not read.
TEMPO_LIMIT = 1000
SPAN_LOSS_NOTE = ("The desk's announce spans can be lost at flush (in the 2026-10-05 audit 7 of 25 status changes in "
                  "24h had no span), so span-based stage panels can miss a change; the Loki milestone panels (the Business "
                  "flow and lead times, Ticket milestones on Factory ops) read the hosts' own JSON lines, one per "
                  "milestone, and are the reference.")
STAGE_NOTE = ("Stages are the Jira statuses the desk announces in the ticket's Slack thread, read from Tempo: one "
              "factory.background span per status change, kind jira.announce.<status>, tagged factory.ticket.key. filed is "
              "Triaged (a desk-filed ticket is moved there at filing; a Jira-filed one after triage-jira), planned is "
              "Planned, approved is Approved (the person's go-ahead), building is In Progress (the worker launched the "
              "cloud agent), PR opened is In Review (the worker opened the PR), merged is Done (the worker moves it only "
              "for a person's merge). Every stage is the desk's, so the Service filter does not apply. The Prometheus "
              "counter of the same spans misses status changes, so no stage panel reads it (README). " + SPAN_LOSS_NOTE)
LIMIT_NOTE = (f"Tempo returns at most the newest {TEMPO_LIMIT} status changes in range; past that the oldest tickets' "
              "spans are not read.")


def announce_selector(status: str = "", *, outcomes: bool = False):
    """The desk's announce spans with a ticket key: one status, every stage, or (outcomes) every stage and outcome."""
    kinds = (f'span.factory.delivery.kind = "{ANNOUNCE}{status}"' if status
             else f'span.factory.delivery.kind =~ "{STATE_KINDS if outcomes else STAGE_KINDS}"')
    return TraceQL(query='resource.service.namespace = "software-factory" && name = "factory.background" && '
                   f"{kinds} && span.factory.ticket.key != nil")


def announce_table(selector: TraceQL, *, ref: str = "A"):
    """Announce spans as a table: start time, ticket, kind."""
    return traceql(TraceQL(query=f"{{ {selector.query} }} | select(span.factory.ticket.key, span.factory.delivery.kind)"),
                   ref=ref, limit=TEMPO_LIMIT)


# Streaming Tempo search adds a progress frame (State, Elapsed Time, Total Blocks, Progress); an empty search shows it
# as the table, and merge would fold its row into the tickets. Dropped before anything else reads the frames.
DROP_SEARCH_PROGRESS = {"id": "filterFieldsByName", "options": {"exclude": {"names": [
    "State", "Elapsed Time", "Total Blocks", "Progress"]}}}


# ------------------------------------------------------------------------------------------------
# v2: ticket timeline, stuck tickets, dwell times (Tempo announce spans)
# ------------------------------------------------------------------------------------------------
TIMELINE_WINDOW = "7d"
# The hop watch's deadlines (factory-desk lib/hop-watch.ts HOPS): plan waits in Triaged, launch in Approved.
# Planned waits for a person and has no deadline; the triage hop (To Do) has no announce span.
HOP_DEADLINES = [("triaged", "plan", 15), ("approved", "launch", 7)]


def stage_age():
    """Per ticket: its latest kind, when it changed (last_change_ms) and how long ago (in_stage_ms, to the range end)."""
    return [
        keep_fields([START_TIME, TICKET_SPAN_ATTR, DELIVERY_KIND]),
        {"id": "sortBy", "options": {"sort": [{"field": START_TIME, "desc": False}]}},
        {"id": "groupBy", "options": {"fields": {
            TICKET_SPAN_ATTR: {"operation": "groupby", "aggregations": []},
            DELIVERY_KIND: {"operation": "aggregate", "aggregations": ["last"]},
            START_TIME: {"operation": "aggregate", "aggregations": ["max"]}}}},
        {"id": "calculateField", "options": {"mode": "reduceRow", "alias": "last_change_ms",
                                             "reduce": {"include": [f"{START_TIME} (max)"], "reducer": "sum",
                                                        "nullValueMode": "null as zero"}}},
        # calculateField itself never interpolates: a literal "${__to}" would be a field name, no field matches, and
        # in_stage_ms would be null. Scenes interpolates the panel's transformation JSON first, but only when its
        # variable scan finds a reference, so the operand must stay this literal ${__to}; it arrives as epoch ms.
        {"id": "calculateField", "options": {"mode": "binary", "alias": "in_stage_ms",
                                             "binary": {"left": "${__to}", "operator": "-", "right": "last_change_ms"}}},
    ]


def stuck_transforms():
    """Announce spans -> tickets whose latest status is a hop's waiting status, older than that hop's deadline."""
    triaged_ms = HOP_DEADLINES[0][2] * 60_000
    launch_ms = HOP_DEADLINES[1][2] * 60_000
    waiting = "|".join(re.escape(ANNOUNCE + status) for status, _, _ in HOP_DEADLINES)
    return [
        *stage_age(),
        # Waiting in Triaged or Approved past the shorter (launch) deadline ...
        {"id": "filterByValue", "options": {"type": "include", "match": "all", "filters": [
            {"fieldName": f"{DELIVERY_KIND} (last)", "config": {"id": "regex", "options": {"value": f"^({waiting})$"}}},
            {"fieldName": "in_stage_ms", "config": {"id": "greaterOrEqual", "options": {"value": launch_ms}}}]}},
        # ... less Triaged tickets still inside the plan deadline.
        {"id": "filterByValue", "options": {"type": "exclude", "match": "all", "filters": [
            {"fieldName": f"{DELIVERY_KIND} (last)", "config": {"id": "equal", "options": {"value": ANNOUNCE + "triaged"}}},
            {"fieldName": "in_stage_ms", "config": {"id": "lower", "options": {"value": triaged_ms}}}]}},
        {"id": "sortBy", "options": {"sort": [{"field": "in_stage_ms", "desc": True}]}},
    ]


STUCK_NOTE = ("Stuck means the hop-watch deadline passed with no outcome posted (factory-desk lib/hop-watch.ts): the "
              "ticket's latest announce is Triaged, older than 15 min (the planner has not answered), or Approved, older "
              "than 7 min (the worker has not launched). An outcome the desk announces while the status stays put "
              "(needs info, plan stopped, approved without plan, launch failed) is the newer state, so that ticket is "
              "not stuck. The hop watch posts in the ticket's thread at those deadlines; this is the same rule, read now. "
              "Planned has no deadline (it waits for a person) and To Do has no announce span, so neither is here. Reads "
              "the last 7 days of status changes, so a ticket stuck for longer is missed.")


def stuck_table():
    p = table(Copy(title="Stuck tickets (past hop deadline)",
                   desc="Tickets waiting past a hop deadline now, longest first: the stage they are in, since when, and for "
                   "how long. Orange past the deadline, red after an hour. " + STUCK_NOTE),
              ds=TEMPO, targets=[announce_table(announce_selector(outcomes=True))], transforms=tuple(stuck_transforms()) + (
                  organize({TICKET_SPAN_ATTR: "Ticket", f"{DELIVERY_KIND} (last)": "Waiting in", f"{START_TIME} (max)": "Since",
                            "in_stage_ms": "Time in stage"},
                           order=[TICKET_SPAN_ATTR, f"{DELIVERY_KIND} (last)", "in_stage_ms", f"{START_TIME} (max)"],
                           exclude=("last_change_ms",)),),
              overrides=(links_on("Ticket", links=[JIRA_LINK, TICKET_OPS]), min_width("Ticket", px=110),
                         min_width("Waiting in", px=190), min_width("Time in stage", px=120), min_width("Since", px=150),
                         field_unit(("Since", TIME_FMT)),
                         {"matcher": {"id": "byName", "options": "Waiting in"}, "properties": [{"id": "mappings", "value": [
                             {"type": "value", "options": {ANNOUNCE + "triaged": {"text": "Triaged: planner (15 min)", "index": 0},
                                                           ANNOUNCE + "approved": {"text": "Approved: worker (7 min)", "index": 1}}}]}]},
                         {"matcher": {"id": "byName", "options": "Time in stage"}, "properties": [
                             {"id": "unit", "value": "ms"}, {"id": "decimals", "value": 0},
                             {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}},
                             {"id": "thresholds", "value": severity_steps(((None, "warn"), (3_600_000, "bad")))}]}),
              no_value=empty_state(EmptyState(missing="No ticket is past a hop deadline", action="Nothing to do")))
    p["timeFrom"] = TIMELINE_WINDOW
    p["hideTimeOverride"] = True
    # No empty-frame guard here: it would cache whole-column calcs that the groupBy in stage_age() reuses
    # for every ticket (EMPTY_FRAME_GUARD). table() appends the guard after the grouping; an empty search
    # still ends as no fields there, so noValue renders.
    p["transformations"][0:0] = [DROP_SEARCH_PROGRESS, {"id": "merge", "options": {}}]
    return p


def stuck_count():
    p = stat(Copy(title="Stuck now", desc="Tickets waiting past a hop deadline now. Calm at 0, orange from 1, red from 3. "
                  + STUCK_NOTE),
             query=Query(ds=TEMPO, expr=announce_table(announce_selector(outcomes=True))), kind="good_bad",
             thresholds=severity_steps(((None, "good"), (1, "warn"), (3, "bad"))), no_value="0",
             time_from=TIMELINE_WINDOW, color_mode="background", text={"title": 14, "value": 36})
    p["transformations"] = [DROP_SEARCH_PROGRESS, *stuck_transforms()]
    p["options"]["reduceOptions"] = {"calcs": ["count"], "fields": f"/^{re.escape(TICKET_SPAN_ATTR)}$/", "values": False}
    return p


# ------------------------------------------------------------------------------------------------
# v2: hosted execution heatmap
# ------------------------------------------------------------------------------------------------
# #220's boundaries (factory-otel.ts HOSTED_EXECUTION_DURATION_BUCKETS_MS).
EXEC_BUCKETS_MS = [100, 250, 500, 1000, 2500, 5000, 10000, 15000, 20000, 30000, 60000, 120000, 180000,
                   300000, 450000, 600000, 900000, 1800000]


def le_forms(bound: int):
    """A bucket bound as an le regex in both spellings: Mimir's OTLP path writes 1800000, Prometheus 3
    normalises le to a float (100.0, 1.8e+06). One backend uses one spelling, so nothing is counted twice."""
    g = format(float(bound), "g")
    prom3 = g if ("." in g or "e" in g) else g + ".0"
    return "|".join(f.replace(".", "\\\\.").replace("+", "\\\\+") for f in (str(bound), prom3))


EXEC_LE = "|".join(le_forms(b) for b in EXEC_BUCKETS_MS) + "|\\\\+Inf"
EXEC_TOP_LE = le_forms(EXEC_BUCKETS_MS[-1])
EXEC_SVC = 'service_name=~"${exec_service}"'


def exec_bucket(le: str):
    return f'{EXEC_DURATION}_bucket{{{NS}, {EXEC_SVC}, phase="total", le=~"{le}"}}'


def heatmap_expr():
    """Per bucket and le, only series on #220's layout, with every le row present at every step.

    A series counts only where its 30 min sibling exists in the same bucket (old OTel-default series, top
    edge 10 s, would put their +Inf in the > 30 min row). The zero scaffold makes every le frame the same
    length: Grafana de-accumulates heatmap rows by index, not by time. `@ end()` evaluates the scaffold once for the
    whole range instead of at every step. Like the p95 bars, no $__to cap."""
    values = (f"sum by (le) ({inc(exec_bucket(EXEC_LE), window=PROM_AHEAD, cap=False)} and ignoring (le) "
              f"max_over_time({exec_bucket(EXEC_TOP_LE)}{rng(PROM_AHEAD)}))")
    scaffold = f"sum by (le) (0 * last_over_time({exec_bucket(EXEC_LE)}[$__range] @ end()))"
    return f"{values} or {scaffold}"


def exec_service_var():
    query = (f'label_values({EXEC_DURATION}_bucket{{{NS}, {SVC}, le=~"{EXEC_TOP_LE}"}}, service_name)')
    return {"name": "exec_service", "label": "Slugs with hosted executions", "type": "query", "datasource": PROM,
            "query": {"qryType": 1, "query": query, "refId": "PrometheusVariableQueryEditor-VariableQuery"},
            "definition": query, "refresh": 1, "regex": "", "sort": 1, "hide": 2, "includeAll": True, "multi": True,
            "allValue": ".*", "options": [], "current": {"text": ["All"], "value": ["$__all"]},
            "description": "Selected slugs that report hosted executions on #220's buckets (the heatmap repeats "
                           "over these). Refreshed on dashboard load: with refresh on time change, Grafana Cloud (12.2+; verified on 13.3.0) "
                           "repeats the hidden default (All) into one empty panel inside the collapsed Latency row."}


def latency_heatmap():
    target = prom(PromQL(expr=heatmap_expr()), legend="{{le}}")
    target["format"] = "heatmap"
    p = base("heatmap", copy=Copy(
        title="Exec duration: $exec_service",
        desc="How long July's hosted executions took (agent_sdk.hosted_execution.duration_ms, phase=\"total\"): one column "
        "per bucket, one row per histogram bucket (100 ms to 30 min, #220); the more executions, the more solid the blue, on "
        "a fixed scale from 0. "
        "One panel per slug that runs hosted executions. Only VMs on #220's buckets are counted: a VM still on the old "
        "OTel default buckets (top edge 10 s) is left out until it is redeployed, because its slow runs would land in "
        "the > 30 min row. Every row is padded with zeros over the range so the cells sit at the right times. Counted "
        "per bucket with counter_inc and the same one-step look-ahead as the p95 line above. " + TWO_WRITERS),
        ds=PROM, targets=[target])
    p["fieldConfig"]["defaults"]["custom"] = {"scaleDistribution": {"type": "linear"},
                                              "hideFrom": {"legend": False, "tooltip": False, "viz": False}}
    p["fieldConfig"]["defaults"]["noValue"] = empty_state(EmptyState(missing="No hosted executions in range", action="Widen the time range or pick All services"))
    p["options"] = {"calculate": False, "cellGap": 1, "rowsFrame": {"layout": "le"},
                    # Opacity of one blue reads the same way in both themes (more = more solid); Grafana flips a
                    # colour scheme such as Viridis in the light theme.
                    "color": {"mode": "opacity", "fill": "#1F78B4", "scale": "exponential", "exponent": 0.5,
                              "steps": 64, "reverse": False, "min": 0},
                    "filterValues": {"le": 1e-9}, "yAxis": {"axisPlacement": "left", "unit": "ms", "reverse": False, "decimals": 0},
                    "cellValues": {"unit": "none", "decimals": 0}, "showValue": "never",
                    "tooltip": {"mode": "single", "yHistogram": True, "showColorScale": True},
                    "legend": {"show": True}, "exemplars": {"color": "rgba(255,0,255,0.7)"}}
    p["interval"] = "$bucket"
    p["repeat"], p["repeatDirection"], p["maxPerRow"] = "exec_service", "h", 2
    return p


def background(p: dict):
    """A status tile: warn and bad fill the tile; calm stays transparent, not a filled block."""
    p["options"]["colorMode"] = "background"
    for step in p["fieldConfig"]["defaults"].get("thresholds", {}).get("steps", []):
        if step["color"] == PALETTE["severity"]["calm"]:
            step["color"] = "transparent"
    return p


def deliveries_by_kind_table():
    """Deliveries by slug, kind and outcome in range (Prometheus); Ops, Debug: deliveries."""
    return table(Copy(title="Deliveries by service, kind and outcome", desc="Counts in the time range. Span is almost always factory.delivery; Kind already tells the story. Click a service to open its logs. " + COUNTER_NOTE + " " + RESTART_OVERCOUNT), ds=PROM,
                targets=[prom(PromQL(expr=f"sort_desc({total(DELIVERY, by='service_name, factory_delivery_kind, factory_outcome')})"),
                      instant=True, table=True)],
                transforms=[organize({"service_name": "Service", "factory_delivery_kind": "Kind",
                                      "factory_outcome": "Outcome", "Value": "Count"},
                                     order=["service_name", "factory_delivery_kind", "factory_outcome", "Value"],
                                     exclude=["Time"])],
                overrides=[links_on("Service", links=[SERVICE_OPS]),
                           min_width("Service", px=190), min_width("Kind", px=195),
                           min_width("Outcome", px=90),
                           width("Count", px=80)],
                unit="locale", decimals=0,
                footer=["Count"], no_value="No deliveries in range", sort=("Count", True))


def failed_or_noop_table():
    """Deliveries in range whose outcome is an error or a no-op (Prometheus); Ops, Debug: deliveries."""
    return table(Copy(title="Deliveries that failed or did nothing", desc=f"Outcomes that are errors ({ERR_RE}) or no-ops ({NOOP_RE}), from the factory code's vocabulary. "
                "Empty is good. " + RESTART_OVERCOUNT), ds=PROM,
                targets=[prom(PromQL(expr=f"sort_desc({total(DELIVERY, where=(FAILED_OR_NOOP,), by='service_name, factory_delivery_kind, factory_outcome')})"),
                      instant=True, table=True)],
                transforms=[organize({"service_name": "Service", "factory_delivery_kind": "Kind", "factory_outcome": "Outcome",
                                      "Value": "Count"}, order=["service_name", "factory_delivery_kind", "factory_outcome", "Value"],
                                     exclude=["Time"])],
                overrides=[links_on("Service", links=[SERVICE_OPS]),
                           min_width("Service", px=190), min_width("Kind", px=195),
                           min_width("Outcome", px=90), width("Count", px=80)],
                unit="locale", decimals=0, footer=["Count"],
                no_value=NONE_GOOD, sort=("Count", True))


def deliveries_by_event_type_table():
    """Distinct deliveryId per slug and eventType in range (Loki); in the overview's collapsed Cross-check row."""
    return table(Copy(title="Deliveries in logs by service and event type (Loki)", desc="Per-event delivery counts from logs, unaffected by counter rewinds: distinct deliveryId per slug and "
                "eventType (pull_request, check_suite, agent-sdk.schedule/fire, ...), from the line that names it; a "
                "delivery whose lines name no eventType is not in this table but is in the cross-check. "
                "Compare with Deliveries by service, kind and outcome in this row (Prometheus, approximate). " + LOG_SHAPES_NOTE), ds=LOKI,
                targets=[loki(LogQL(expr=f"sort_desc({delivery_ids('service_name, f_event_type', event_type=True)})"), instant=True)],
                transforms=[{"id": "merge", "options": {}},
                            {"id": "labelsToFields", "options": {"mode": "columns"}},
                            organize({"service_name": "Service", "f_event_type": "Event type", "Value #A": "Deliveries", "Value": "Deliveries"},
                                     order=["service_name", "f_event_type", "Value #A", "Value"], exclude=["Time"])],
                overrides=[links_on("Service", links=[SERVICE_OPS]),
                           min_width("Service", px=190),
                           min_width("Event type", px=230), min_width("Deliveries", px=100)],
                unit="none", decimals=0, footer=["Deliveries"],
                no_value="No deliveryId on any log line in range", sort=("Deliveries", True))


# ------------------------------------------------------------------------------------------------
# v2: ticket-first entry and the Traces summary
# ------------------------------------------------------------------------------------------------
RECENT_WINDOW = "7d"


def state_mappings():
    """Announce kinds as readable state names: stages in their ramp colour, outcomes grey (launch failed red)."""
    options = {ANNOUNCE + status: {"text": stage, "color": STAGE_COLOURS[stage], "index": i}
               for i, (stage, status) in enumerate(STAGES)}
    options.update({ANNOUNCE + outcome: {"text": label, "color": colour, "index": len(STAGES) + i}
                    for i, (outcome, label, colour) in enumerate(ANNOUNCE_OUTCOMES)})
    return [{"type": "value", "options": options}]


def furthest_stage_mappings():
    """Loki furthest-stage names as readable cells (same ramp as Tempo announce mappings)."""
    options = {stage: {"text": stage, "color": STAGE_COLOURS[stage], "index": i}
               for i, stage in enumerate(STAGE_NAMES)}
    return [{"type": "value", "options": options}]


# Empty Ticket box only: while a key is selected the journey panels below own the view.
RECENT_EMPTY_TICKET = ('| label_format m_pick=`{{ if eq "${ticket}" "" }}yes{{ end }}` | m_pick="yes"')
FURTHEST_STAGE_LABEL = (
    '| label_format stage=`'
    # stage=done is the merge milestone even when outcome is not_moved (Jira board lag).
    '{{ if and (eq .f_event "pr_status") (eq .m_stage "done") }}merged'
    '{{ else if or (and (eq .f_event "implement_pr") (eq .f_outcome "opened")) '
    '(and (eq .f_event "pr_status") (eq .m_stage "in_review") (eq .f_outcome "moved")) }}PR opened'
    '{{ else if and (eq .f_event "decision") (eq .f_outcome "launched") }}building'
    '{{ else if and (eq .f_event "decision") '
    '(or (eq .f_outcome "turn_sent") (eq .f_outcome "launch_failed")) }}approved'
    '{{ else if and (eq .f_event "turn_started") (eq .service_name "factory-planner") }}planned'
    '{{ else if or (and (eq .f_event "plan_start_watch") (eq .f_via "arm")) '
    '(and (eq .f_event "turn_started") (eq .service_name "factory-planner")) }}filed'
    '{{ end }}` '
    '| label_format rank=`{{ if eq .stage "merged" }}6{{ else if eq .stage "PR opened" }}5'
    '{{ else if eq .stage "building" }}4{{ else if eq .stage "approved" }}3'
    '{{ else if eq .stage "planned" }}2{{ else if eq .stage "filed" }}1{{ else }}0{{ end }}` '
    '| stage != ""'
)
FURTHEST_STAGE_NOTE = (
    "Current stage is the furthest milestone the ticket has reached in the last 7 days "
    "(filed → planned → approved → building → PR opened → merged), from the hosts' own JSON "
    "console lines — the same milestones as Factory business Ticket flow. Merged beats every "
    "earlier stage even when a newer log line names an earlier one. Tempo announce spans are "
    "lossy and are not used here. Merged here includes a Done PR whose Jira board was not moved (pr_status stage=done, outcome not_moved); Factory business Merged still requires moved. " + SPAN_LOSS_NOTE
)


def recent_tickets():
    """Ticket-first entry: 20 tickets that most recently reached their furthest stage (7 days).

    Furthest milestone wins (merged beats building / PR opened), matching the Business funnel —
    not the latest log line. Empty while a ticket is selected. Uses MERGED_WHERE etc. defined below
    (called from ops() after those names exist).
    """
    # Broaden Merged vs Business: any pr_status with m_stage=done (moved or not_moved).
    merged_reach = '(f_event="pr_status" and m_stage="done")'
    where = (f'({merged_reach} or {PR_OPENED_WHERE} or '
             f'(f_event="decision" and f_outcome="launched") or {APPROVED_WHERE} or '
             f'{PLAN_START_WHERE_M} or {FILED_WHERE})')
    expr = f"{milestone_lines(where)} {RECENT_EMPTY_TICKET} {FURTHEST_STAGE_LABEL}"
    p = table(Copy(title="Recent tickets (latest 20, 7 days)",
                   desc="The 20 tickets that most recently reached their furthest pipeline stage in the last "
                   "7 days (whatever the dashboard range), newest first: current stage, how long in it, and "
                   "since when. Click a key to open Jira or filter this dashboard to its journey, or type one "
                   "in Ticket. Empty while a ticket is selected. " + FURTHEST_STAGE_NOTE),
              ds=LOKI, targets=[loki(LogQL(expr=expr), max_lines=500)],
              transforms=({"id": "merge", "options": {}},
                          {"id": "extractFields", "options": {"source": "labels", "format": "json",
                                                              "replace": False, "keepTime": False}},
                          keep_fields(["Time", "f_ticket", "stage", "rank"]),
                          # rank is a single digit "1"…"6" so lexicographic sort matches numeric order.
                          {"id": "sortBy", "options": {"sort": [
                              {"field": "rank", "desc": True},
                              {"field": "Time", "desc": False}]}},
                          {"id": "groupBy", "options": {"fields": {
                              "f_ticket": {"operation": "groupby", "aggregations": []},
                              "stage": {"operation": "aggregate", "aggregations": ["first"]},
                              "Time": {"operation": "aggregate", "aggregations": ["first"]}}}},
                          {"id": "calculateField", "options": {"mode": "reduceRow", "alias": "last_change_ms",
                                                               "reduce": {"include": ["Time (first)"], "reducer": "sum",
                                                                          "nullValueMode": "null as zero"}}},
                          {"id": "calculateField", "options": {"mode": "binary", "alias": "in_stage_ms",
                                                               "binary": {"left": "${__to}", "operator": "-",
                                                                          "right": "last_change_ms"}}},
                          {"id": "sortBy", "options": {"sort": [{"field": "Time (first)", "desc": True}]}},
                          {"id": "limit", "options": {"limitField": 20}},
                          organize({"f_ticket": "Ticket", "stage (first)": "Current stage",
                                    "in_stage_ms": "In stage for", "Time (first)": "Since"},
                                   order=["f_ticket", "stage (first)", "in_stage_ms", "Time (first)"],
                                   exclude=("last_change_ms",))),
              overrides=({"matcher": {"id": "byName", "options": "Current stage"}, "properties": [
                             {"id": "custom.minWidth", "value": 190},
                             {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}},
                             {"id": "color", "value": {"mode": "thresholds"}},
                             {"id": "thresholds", "value": steps([(None, "text")])},
                             {"id": "mappings", "value": furthest_stage_mappings()}]},
                         {"matcher": {"id": "byName", "options": "In stage for"}, "properties": [
                             {"id": "custom.minWidth", "value": 120}, {"id": "unit", "value": "ms"},
                             {"id": "decimals", "value": 0}]},
                         {"matcher": {"id": "byName", "options": "Since"}, "properties": [
                             {"id": "custom.minWidth", "value": 150}, {"id": "unit", "value": TIME_FMT}]}),
              no_value=empty_state(EmptyState(missing="A ticket is selected",
                                              action="Its journey is below; clear Ticket to list tickets again")))
    p["timeFrom"] = RECENT_WINDOW
    p["hideTimeOverride"] = True
    p["fieldConfig"]["overrides"].append({"matcher": {"id": "byName", "options": "Ticket"}, "properties": [
        {"id": "custom.minWidth", "value": 100}, *links_on_nonempty("Ticket", links=[JIRA_LINK, TICKET_OPS])["properties"]]})
    return p



# ------------------------------------------------------------------------------------------------
# v2: cost share and cost per ticket
# ------------------------------------------------------------------------------------------------
# The instance-id carry-over in COUNT_CAVEAT is a host bug with a fix in progress; no query compensates for it.
RESTART_OVERCOUNT = ("Counter-based figures can read high after a host changes its service instance id: the new series "
                     "starts at the carried-over totals, which are counted again (host fix in progress). Example: "
                     "factory-desk turns read 16 here against 12 in Loki in 2026-10-03 data. Loki and Tempo are the reference.")
BOTH_COUNTERS = "Both sides are counters that can read high, so the ratio can be off either way. "


# Cost per ticket over time (Simon). Prometheus only, from factory_ticket_key: merged tickets' own cost.
# cap=False: the #224 recipe windows are plain range selectors (Explore-safe, promtool-proven).
ROLLING = Window(span="1d", cap=False)
# The cost lookback must cover a ticket's whole life, which spans days; the merge window alone would count
# only the sliver of a ticket's work that landed inside it.
COST_LOOKBACK = "7d"
# A ticket's work spans hours: a 15-minute bucket's merges over their cost reads noisy, so the
# per-bucket series steps at least this far.
TICKET_BUCKET = "6h"
BUCKET_MERGE = Window(span=TICKET_BUCKET, cap=False)
MEAN_TICKET_LEGEND = "mean cost per merged ticket (merged in trailing 24h, 7d cost lookback)"
BUCKET_TICKET_LEGEND = "per 6h bucket (merged in that 6h, 7d cost lookback)"
COST_RAMP = {BUCKET_TICKET_LEGEND: "#9ecae1", MEAN_TICKET_LEGEND: "#2171b5"}


def cost_per_ticket_over_time():
    p = timeseries(Copy(title="Cost per merged ticket",
                        desc="Mean full cost of the tickets merged in the trailing 24h: for each ticket merged in that "
                        "window, its own end-to-end estimated cost from factory_ticket_key over the last 7 days "
                        "(summed over every host that tagged the key; the Service filter does not apply), then the "
                        "mean across those merged tickets. Unkeyed turns (factory_ticket_key none or other) and "
                        "tickets not merged in the window contribute nothing. The points are the same mean per 6h "
                        "bucket. Tickets merged before the ticket key was deployed (2026-10-04 04:43 UTC) carry no "
                        "key, so the line starts from then; it has a value only once a merged ticket's key also "
                        "appears on the token and cost counters. Excludes the worker's cloud build agent (launched "
                        "through @cursor/sdk, not counted by July); the planner's cloud turns (since #227) and the "
                        "worker's July cloud turn (since #229) are counted, and report input net of cache reads, which "
                        "the per-series uncached rule prices in full. "
                        + RESTART_OVERCOUNT + " " + ESTIMATE_NOTE),
                   ds=PROM,
                   targets=[prom(PromQL(expr=mean_cost_per_merged_ticket(BUCKET_MERGE, cost_window=COST_LOOKBACK)),
                                 legend=BUCKET_TICKET_LEGEND),
                            prom(PromQL(expr=mean_cost_per_merged_ticket(ROLLING, cost_window=COST_LOOKBACK)),
                                 legend=MEAN_TICKET_LEGEND, ref="B")],
                   unit="currencyUSD", decimals=2, bars=False, calcs=["mean"],
                   overrides=colours_from(COST_RAMP),
                   no_value=empty_state(EmptyState(missing="No merged ticket with keyed cost yet",
                                                   action="The line starts once a ticket merged after the key deploy "
                                                          "(2026-10-04 04:43 UTC) has keyed model turns")))
    p["fieldConfig"]["overrides"] += [
        {"matcher": {"id": "byName", "options": BUCKET_TICKET_LEGEND},
         "properties": [{"id": "custom.drawStyle", "value": "points"}, {"id": "custom.pointSize", "value": 7}]},
        {"matcher": {"id": "byName", "options": MEAN_TICKET_LEGEND},
         "properties": [{"id": "custom.lineWidth", "value": 2}]},
    ]
    p["fieldConfig"]["defaults"]["custom"].update({"showPoints": "never", "spanNulls": False, "fillOpacity": 0})
    p["targets"][0]["interval"] = TICKET_BUCKET
    return p


def unattributed_cost(window: Window = RANGE):
    """Spend in range not tagged with a Jira key: total − keyed tickets.

    Only emits a series when that difference is > 0, so an empty range still shows the table noValue
    instead of a permanent Unattributed 0 row.
    """
    keyed = f"(sum({cost_per_ticket(window, where=(KEYED,))}) or vector(0))"
    total = f"({estimate(window, factory_wide=True)} or vector(0))"
    # PromQL `x > 0` keeps x when true and drops the series when false.
    return (f'label_replace((({total}) - ({keyed})) > 0, "{TICKET_KEY}", "{UNATTRIBUTED_TICKET}", "", "")')


def ticket_cost_table(*, plain: bool = False):
    """One row per keyed Jira ticket in range, plus an Unattributed row so costs sum to Spend."""
    keyed_cost = f"({cost_per_ticket(RANGE, where=(KEYED,))}) or ({unattributed_cost()})"
    cols = [("A", "Cost", keyed_cost),
            ("B", "Uncached", uncached_input(by=TICKET_KEY, where=(KEYED,), factory_wide=True)),
            ("C", "Cache read", token_type("cache_read", by=TICKET_KEY, where=(KEYED,), factory_wide=True)),
            ("D", "Output", token_type("output", by=TICKET_KEY, where=(KEYED,), factory_wide=True)),
            ("E", "Turns", total(TURNS, by=TICKET_KEY, where=(KEYED,), factory_wide=True))]
    org = organize({TICKET_KEY: "Ticket", **{f"Value #{r}": n for r, n, _ in cols}},
                   order=[TICKET_KEY] + [f"Value #{r}" for r, _, _ in cols], exclude=["Time"])
    # No Ticket data links: an Unattributed row is not a Jira key (Bugbot #244). Use Recent tickets / the Ticket box.
    p = table(Copy(title="Cost by ticket",
                   desc="Estimated spend, tokens and model turns per Jira ticket with a ticket key in the time range "
                   "(including in-flight tickets), plus **Unattributed (before ticket tagging)** when spend has no "
                   "Jira key (none / other / empty, or before tagging rolled out). Keyed rows plus that row equal "
                   "Spend / Cost above. Paste a key into the Ticket box (or use Recent tickets) to open it — this "
                   "table has no per-row links so Unattributed cannot open a fake Jira URL. "
                   + (BUSINESS_ESTIMATE if plain else RESTART_OVERCOUNT + " " + ESTIMATE_NOTE)),
              ds=PROM, targets=[prom(PromQL(expr=e), ref=r, instant=True, table=True) for r, _, e in cols],
              transforms=[{"id": "merge", "options": {}}, org],
              overrides=[{"matcher": {"id": "byName", "options": "Cost"},
                          "properties": [{"id": "unit", "value": "currencyUSD"}, {"id": "decimals", "value": 2}]},
                         field_unit(("Turns", "locale")), decimals_on("Turns", n=0), width("Turns", px=70),
                         min_width("Ticket", px=110), min_width("Uncached", px=110), min_width("Cache read", px=110),
                         min_width("Output", px=100), width("Cost", px=90)],
              unit="locale", decimals=0, footer=[n for _, n, _ in cols],
              no_value=empty_state(EmptyState(missing="No model turn in range", action="Widen the time range")),
              sort=("Cost", True))
    return p


# ------------------------------------------------------------------------------------------------
# v3: ticket milestones and factory health from Loki. The desk's jira.announce.* spans are lossy (2026-10-05, last
# 24h: 18 announce spans stored, 7 missing: TLSSN-60 planned + in_progress, TLSSN-61 in_progress, TLSSN-62 planned +
# in_review), so the span funnel, timeline and dwell table undercount. Each host logs one JSON console line per
# milestone (read from the host code; the dashboards never change it), and those lines are the cross-check.
#   planner  {"planner":"turn_started","sessionId":…,"issueKey":…}                       plan started
#   planner  {"planner":"turn_model","outcome":"completed"|"failed",…,"issueKey":…}        plan turn completed / failed
#   desk     {"desk":"plan_start_watch","via":"arm"|"reminder"|"sweep","issueKey":…,"result":…}
#            result is a StartCheck (started | retried | not_moved | final | moved_on | gated | unread | duplicate),
#            armed | unavailable | failed when arming, or superseded | already_checked | early | kv_unavailable
#   desk     {"desk":"reaction","verb":"approve","target":"plan",…,"issueKey":…,"outcome":"approved"}
#   desk     {"desk":"approve_command","outcome":"approved","issueKey":…}                   a typed approve
#            (the desk's approve_ticket tool and a drag to Approved on the board log no desk line)
#   worker   {"worker":"decision","outcome":"launched"|"turn_sent"|"launch_failed"|…,"issueKey":…,"via":"delivery"|"heal"|…,"retried":bool,"agentId":…}
#            a delivery launch logs turn_sent (the cloud turn sent) and later launched (the agent bound), both with
#            the same retried; a heal launch logs launched only
#   worker   {"worker":"implement_pr",…,"issueKey":…,"outcome":"opened"|"reused"|…,"pr":"owner/repo#n"}
#   worker   {"worker":"pr_status","issueKey":…,"stage":"in_review"|"done","pr":…,"outcome":"moved"|"not_moved"|…}
#   desk     {"desk":"review_update",…,"posted":bool,"issueKey":…,"pr":…,"changeReview":"pending"|"planned"|"verified"|"attention"|"incomplete","components":[…]}
# The desk's idle hop-watch tick {"desk":"hop_watch","via":"schedule","due":0,"fired":0} (every 5 min) is noise and
# is dropped from the event counts (HOP_TICK_DROP).
# ------------------------------------------------------------------------------------------------
# Fields beyond FACTORY_FIELDS that the milestone lines carry. m_* can never collide with structured metadata.
MILESTONE_JSON = ["result", "stage", "retried", "verb", "target", "changeReview", "posted", "components", "agentId"]
MILESTONE_FIELDS = ("| json " + ", ".join(f'm_{k}="{k}"' for k in MILESTONE_JSON)
                    + " | drop __error__, __error_details__")
# The idle tick as the desk serialises it (object key order). A line filter, so no parse is needed to drop it.
HOP_TICK_DROP = '!= `{"desk":"hop_watch","via":"schedule","due":0,"fired":0}`'
HOP_TICK_NOTE = ("The desk's idle hop-watch tick (hop_watch via schedule with nothing due, every 5 minutes) is left out: "
                 "it is a liveness line, not an event.")
PLAN_NEVER_STARTED = "retried|not_moved|final"
# One ticket's milestone lines, or every ticket's while the Ticket box is empty (a template, because LogQL
# compares a label with a literal only; `${ticket}` arrives interpolated).
TICKET_PICK = ('| label_format m_pick=`{{ if or (eq "${ticket}" "") (eq .f_ticket "${ticket}") }}yes{{ end }}` '
               '| m_pick="yes"')


@dataclass(frozen=True, kw_only=True)
class Milestone:
    """One ticket milestone read from a host's JSON console line; `note` is what the count does and does not mean."""
    name: str
    where: str
    note: str = ""


# The desk's Slack approvals: a ✅ reaction on the plan, or a typed approve. The approve_ticket tool and a drag to
# Approved on the board leave no desk line, so these are listed per ticket but are not the approved count.
SLACK_APPROVED_WHERE = ('((f_event="reaction" and m_verb="approve" and m_target="plan" and f_outcome="approved") '
                        'or (f_event="approve_command" and f_outcome="approved"))')
# Label filters, each a parenthesised `and` group so `or` binds as written. f_event is the JSON line's first key
# (desk / worker / planner) through FACTORY_FIELDS; the planner is named too so no other host's turn_started counts.
MILESTONES = [
    Milestone(name="plan start", where='(f_event="turn_started" and service_name="factory-planner")'),
    Milestone(name="plan turn completed", where='(f_event="turn_model" and f_outcome="completed")',
              note="Any planner turn that completed (turn_model completed), whether it posted a plan, stopped, or asked "
                   "for information: a completed turn is not always a plan. A failed turn is listed in Ticket milestones "
                   "as plan turn failed and is not here."),
    Milestone(name="approved (reached worker)", where='(f_event="decision" and f_outcome=~"turn_sent|launched|launch_failed")',
              note="Approvals that reached the worker: a decision line with outcome turn_sent (the cloud turn sent), "
                   "launched (the agent bound) or launch_failed, whichever way the ticket was approved (a Slack reaction "
                   "or typed approve, the desk's approve tool, or a drag to Approved on the board). The desk's reaction "
                   "and approve_command lines see Slack approvals only, so they are listed in Ticket milestones and not "
                   "counted here. An approval the worker declined (no plan, duplicate, stale status) is not counted."),
    Milestone(name="launched", where='(f_event="decision" and f_outcome="launched")'),
    Milestone(name="PR opened", where='((f_event="implement_pr" and f_outcome="opened") '
                                     'or (f_event="pr_status" and m_stage="in_review" and f_outcome="moved"))'),
    Milestone(name="merged", where='(f_event="pr_status" and m_stage="done" and f_outcome="moved")'),
]
# Every line the milestones panel lists: the six above plus the signals around them.
MILESTONE_LINES = " or ".join([m.where for m in MILESTONES] + [
    '(f_event="turn_model" and f_outcome="failed")',
    f'(f_event="plan_start_watch" and m_result=~"started|{PLAN_NEVER_STARTED}")',
    SLACK_APPROVED_WHERE,
    '(f_event="review_update" and m_posted="true")',
])
MILESTONE_LABEL = (
    '| label_format milestone=`'
    '{{ if eq .f_event "turn_started" }}plan started'
    '{{ else if eq .f_event "turn_model" }}{{ if eq .f_outcome "completed" }}plan turn completed{{ else }}plan turn failed{{ end }}'
    '{{ else if eq .f_event "plan_start_watch" }}plan start check: {{ .m_result }}'
    '{{ else if eq .f_event "reaction" }}approved (reaction)'
    '{{ else if eq .f_event "approve_command" }}approved (command)'
    '{{ else if eq .f_event "decision" }}worker {{ .f_outcome }} via {{ .f_via }}{{ if eq .m_retried "true" }}, retried{{ end }}'
    '{{ else if eq .f_event "implement_pr" }}PR opened {{ .f_pr }}'
    '{{ else if eq .f_event "pr_status" }}{{ if eq .m_stage "done" }}merged{{ else }}PR in review{{ end }} {{ .f_pr }}'
    '{{ else if eq .f_event "review_update" }}review update'
    '{{ if .m_changeReview }}, change review {{ .m_changeReview }}{{ end }}'
    '{{ end }}`')
MILESTONE_LINE_FORMAT = ('| line_format `{{ .f_ticket }} · {{ .milestone }} '
                         '({{ regexReplaceAll "^factory-" .service_name "" }})`')
ALL_SLUGS_SEL = '{service_namespace="software-factory"}'


def milestone_lines(where: str, *, ticket: bool = False):
    """Factory JSON lines with a ticket key that match `where`, parsed for the milestone fields."""
    pick = f" {TICKET_PICK}" if ticket else ""
    return f'{ALL_SLUGS_SEL} {FACTORY_FIELDS} {MILESTONE_FIELDS} | f_ticket != ""{pick} | {where}'


def distinct_tickets(where: str, *, window: Window = RANGE):
    """Distinct ticket keys with a matching line in range: a Loki count that no span loss can lower."""
    return f"count(sum by (f_ticket) (count_over_time({milestone_lines(where)} [{window.span}])))"


def line_count(where: str, *, window: Window = RANGE, by: str = ""):
    """Matching lines in range, optionally per label."""
    grouping = f" by ({by})" if by else ""
    return f"sum{grouping} (count_over_time({milestone_lines(where)} [{window.span}]))"


def ticket_milestones():
    """The milestone lines, newest first, for $ticket or every ticket while the box is empty."""
    expr = f"{milestone_lines(MILESTONE_LINES, ticket=True)} {MILESTONE_LABEL} {MILESTONE_LINE_FORMAT}"
    return logs(Copy(title="Ticket milestones (logs)",
                     desc="One line per milestone from the hosts' own JSON console lines, newest first: plan started and "
                     "plan turn completed / failed (planner), the plan start check (desk), approved (a Slack reaction or a "
                     "typed approve; the approve tool and a board drag log no desk line, so the worker's decision is the "
                     "sign of those), worker launched / turn sent / launch failed (with via and whether it was a retry), "
                     "PR opened and PR in review, review updates with the change-review state, and merged. Shows the "
                     "ticket in the Ticket box, or every ticket while it is empty. " + SPAN_LOSS_NOTE + " " + LOG_SHAPES_NOTE),
                target=loki(LogQL(expr=expr), max_lines=500), no_value="No milestone line in range")


# Health events (Loki). Severity: a never-started plan is bad from 1 (the desk re-sent once and gave up), a launch
# retry or heal is orange (the first launch did not bind, the second did), started and posts are neutral counts.
PLAN_START_WHERE = '(f_event="plan_start_watch")'
NEVER_STARTED_WHERE = f'(f_event="plan_start_watch" and m_result=~"{PLAN_NEVER_STARTED}")'
STARTED_WHERE = '(f_event="plan_start_watch" and m_result="started")'
DECISION_WHERE = '(f_event="decision")'
# launched only: a retried delivery logs turn_sent and then launched for the one launch, so matching both would count
# it twice.
LAUNCH_RETRY_WHERE = '(f_event="decision" and f_outcome="launched" and (f_via="heal" or m_retried="true"))'
CHANGE_REVIEW_WHERE = '(f_event="review_update" and m_posted="true" and m_components=~".*changeMonitor.*")'
HEALTH_ROW = "Factory health events"


def never_started_stat():
    p = stat(Copy(title="Never started (alerts)",
                     desc=f"Distinct tickets with a plan start check in range whose result was {PLAN_NEVER_STARTED.replace('|', ', ')}: "
                     "the desk's 4-minute check found no sign of the planner running (retried = the ticket was re-sent once, "
                     "final = it gave up after that one retry, not_moved = the re-send could not move the ticket). One per "
                     "ticket, so a ticket that was retried and then given up on counts once. Calm at 0, red from 1. A healthy "
                     "check logs started and is the neutral tile beside this one. " + LOG_SHAPES_NOTE),
                query=Query(ds=LOKI, expr=loki(LogQL(expr=f"{distinct_tickets(NEVER_STARTED_WHERE)} or vector(0)"), instant=True)),
                kind="good_bad", thresholds=severity_steps(((None, "calm"), (1, "bad"))), no_value="0")
    p["fieldConfig"]["defaults"]["links"] = [link(Href(title="Plan start lines on Factory ops", url=f"{OPS_SEARCH}plan_start_watch&${{__url_time_range}}"))]
    return p


def plan_started_stat():
    return stat(Copy(title="Plan start: started",
                     desc="Plan start checks in range that found the planner running (result started): the healthy answer, "
                     "a neutral count. The check runs 4 minutes after a ticket enters Triaged, from a reminder or the "
                     "5-minute sweep. " + LOG_SHAPES_NOTE),
                query=Query(ds=LOKI, expr=loki(LogQL(expr=f"{line_count(STARTED_WHERE)} or vector(0)"), instant=True)),
                no_value="0")


def launch_retries_stat():
    p = stat(Copy(title="Launch retries / heals",
                     desc="Worker launches in range that were a retry or came through heal (decision lines with outcome "
                     "launched and via heal or retried true): the first launch did not bind and a later one did. One line "
                     "per bound launch: a retried delivery also logs turn_sent for the same launch, which is not counted. "
                     "A heal relaunches through @cursor/sdk, so its agent's tokens and cost are not on the token panels "
                     "(a delivery's cloud turn is, since #229). Orange from 1 by design (each retry burned a hop deadline) — not a red alert. "
                     + LOG_SHAPES_NOTE),
                query=Query(ds=LOKI, expr=loki(LogQL(expr=f"{line_count(LAUNCH_RETRY_WHERE)} or vector(0)"), instant=True)),
                kind="good_bad", thresholds=severity_steps(((None, "calm"), (1, "warn"))), no_value="0")
    p["fieldConfig"]["defaults"]["links"] = [link(Href(title="Worker decision lines on Factory ops", url=f"{OPS_SEARCH}decision&${{__url_time_range}}"))]
    return p


def change_review_posts_stat():
    return stat(Copy(title="Change reviews",
                     desc="Review updates the desk posted in range whose components include the change monitor: the "
                     "lines that announce a change review as pending, planned, verified, attention or incomplete. A neutral "
                     "count. " + LOG_SHAPES_NOTE),
                query=Query(ds=LOKI, expr=loki(LogQL(expr=f"{line_count(CHANGE_REVIEW_WHERE)} or vector(0)"), instant=True)),
                no_value="0")


@dataclass(frozen=True, kw_only=True)
class LabelColumn:
    """A Loki label shown as a table column: its display name and 1280 px floor."""
    label: str
    display: str
    px: int


def label_count_table(copy: Copy, *, where: str, columns: list, no_value: str):
    """Lines in range grouped by the columns' labels (Loki instant), one count column, sorted by count."""
    by = ", ".join(c.label for c in columns)
    order = [c.label for c in columns] + ["Value #A", "Value"]
    return table(copy, ds=LOKI,
                 targets=[loki(LogQL(expr=f"sort_desc({line_count(where, by=by)})"), instant=True)],
                 transforms=[{"id": "merge", "options": {}},
                             {"id": "labelsToFields", "options": {"mode": "columns"}},
                             organize({**{c.label: c.display for c in columns}, "Value #A": "Count", "Value": "Count"},
                                      order=order, exclude=["Time"])],
                 overrides=[*(min_width(c.display, px=c.px) for c in columns), width("Count", px=70)],
                 unit="locale", decimals=0, footer=["Count"], no_value=no_value, sort=("Count", True))


def plan_start_table():
    return label_count_table(
        Copy(title="Plan start watch by result and via",
             desc="The desk's plan start check in range, by result and how it ran (via arm when the reminder is armed, "
             "reminder when it fires, sweep when the 5-minute sweep ran a late or missing check). Results: armed, "
             "started (the planner was running: healthy), retried (no sign of it, the ticket was re-sent once), final "
             "(still nothing after the retry), not_moved, moved_on, gated, unread, duplicate; superseded, already_checked, "
             "early and kv_unavailable are the check standing down. Expect armed and started only. " + LOG_SHAPES_NOTE),
        where=PLAN_START_WHERE, no_value="No plan start check in range",
        columns=[LabelColumn(label="m_result", display="Result", px=110), LabelColumn(label="f_via", display="Via", px=80)])


def launch_decisions_table():
    return label_count_table(
        Copy(title="Worker launch decisions by outcome",
             desc="The worker's decision lines in range by outcome, via and whether the launch was a retry: launched is "
             "the cloud agent bound, turn_sent its first turn sent, launch_failed / launch_timeout a failed launch, "
             "duplicate and ignored no-ops. via delivery is the Approved webhook, heal the recovery path after a launch "
             "that did not bind. " + LOG_SHAPES_NOTE),
        where=DECISION_WHERE, no_value="No worker decision in range",
        columns=[LabelColumn(label="f_outcome", display="Outcome", px=110), LabelColumn(label="f_via", display="Via", px=80),
                 LabelColumn(label="m_retried", display="Retried", px=70)])


def change_review_table():
    """Latest change-review state per ticket: time order, then review-state rank on ties.

    pending < planned ≤ verified / attention / incomplete. Equal timestamps (desk can emit
    pending and planned in the same ms) take the further state, not an unstable last().
    """
    rank = ('| label_format review_rank=`{{ if eq .m_changeReview "pending" }}1'
            '{{ else if eq .m_changeReview "planned" }}2'
            '{{ else if eq .m_changeReview "verified" }}3'
            '{{ else if eq .m_changeReview "attention" }}3'
            '{{ else if eq .m_changeReview "incomplete" }}3'
            '{{ else }}0{{ end }}`')
    expr = f"{milestone_lines(CHANGE_REVIEW_WHERE)} {PR_PATH} {rank}"
    fields = ["Time", "f_ticket", "f_pr", "pr_path", "m_changeReview", "review_rank"]
    p = table(Copy(title="Change review per ticket (latest)",
                   desc="The furthest change-review state the desk posted for each ticket in range "
                   "(review_update lines whose components include changeMonitor): pending < planned ≤ "
                   "verified / attention / incomplete. A later pending does not hide an earlier planned "
                   "(TLSSN-63 class of bug). Ticket opens Jira, the pull request on GitHub, or Factory ops. "
                   "Grouped in the browser from the newest 200 such lines. " + LOG_SHAPES_NOTE),
              ds=LOKI, targets=[loki(LogQL(expr=expr), max_lines=200)],
              transforms=[{"id": "merge", "options": {}},
                          {"id": "extractFields", "options": {"source": "labels", "format": "json", "replace": False,
                                                              "keepTime": False}},
                          keep_fields(fields),
                          # Furthest review state wins (pending < planned ≤ verified/attention/incomplete),
                          # even when a later line regresses to pending; among that state, newest Time.
                          {"id": "sortBy", "options": {"sort": [
                              {"field": "review_rank", "desc": True},
                              {"field": "Time", "desc": True}]}},
                          {"id": "groupBy", "options": {"fields": {
                              "f_ticket": {"operation": "groupby", "aggregations": []},
                              "f_pr": {"operation": "aggregate", "aggregations": ["first"]},
                              "pr_path": {"operation": "aggregate", "aggregations": ["first"]},
                              "m_changeReview": {"operation": "aggregate", "aggregations": ["first"]},
                              "Time": {"operation": "aggregate", "aggregations": ["first"]}}}},
                          organize({"f_ticket": "Ticket", "f_pr (first)": "PR", "pr_path (first)": "pr_path",
                                    "m_changeReview (first)": "Review", "Time (first)": "Posted"},
                                   order=["f_ticket", "m_changeReview (first)", "Time (first)", "f_pr (first)", "pr_path (first)"])],
              overrides=[field_unit(("Posted", TIME_FMT)), min_width("Ticket", px=85), min_width("Review", px=90),
                         hide("PR"), hide("pr_path"), min_width("Posted", px=165),
                         value_colours("Review", mapping=[("verified", "text"), ("planned", "blue"), ("pending", "blue"),
                                                                 ("attention", "orange"), ("incomplete", "orange")])],
              no_value="No change-review post in range", sort=("Posted", True))
    p["fieldConfig"]["overrides"].append(links_on_nonempty("Ticket", links=[
        JIRA_LINK, link(Href(title="Open the pull request on GitHub", url="https://github.com/${__data.fields.pr_path}"), blank=True),
        TICKET_OPS]))
    return p




def health_events_row(d: Dashboard, *, lines: bool = False):
    """Four tiles over three tables; the Logs copy adds the raw lines underneath."""
    d.row(HEALTH_ROW)
    d.add(background(never_started_stat()), size=Size(w=6, h=4))
    d.add(plan_started_stat(), size=Size(w=6, h=4))
    d.add(background(launch_retries_stat()), size=Size(w=6, h=4))
    d.add(change_review_posts_stat(), size=Size(w=6, h=4))
    d.add(plan_start_table(), size=Size(w=8, h=7))
    d.add(launch_decisions_table(), size=Size(w=8, h=7))
    d.add(change_review_table(), size=Size(w=8, h=7))
    if lines:
        where = f"{PLAN_START_WHERE} or {DECISION_WHERE} or (f_event=\"review_update\" and m_posted=\"true\")"
        expr = (f"{milestone_lines(where)} {MILESTONE_LABEL} "
                '| line_format `{{ .f_ticket }} · {{ .f_event }} {{ .f_outcome }}{{ .m_result }}'
                '{{ if .f_via }} via {{ .f_via }}{{ end }}{{ if eq .m_retried "true" }} retried{{ end }}'
                '{{ if .m_changeReview }} change review {{ .m_changeReview }}{{ end }}'
                '{{ if .f_pr }} {{ .f_pr }}{{ end }} ({{ regexReplaceAll "^factory-" .service_name "" }})`')
        d.add(logs(Copy(title="Health event lines (plan start watch, worker decisions, review updates)",
                        desc="The lines behind the tiles above, newest first: every plan_start_watch line (armed, started, "
                        "retried, final, …), every worker decision (launched, turn_sent, launch_failed, duplicate, …) and "
                        "every review update the desk posted. The idle hop-watch tick is not a health event and is not "
                        "here. " + LOG_SHAPES_NOTE),
                   target=loki(LogQL(expr=expr), max_lines=300), no_value="No health event line in range"),
              size=Size(w=24, h=9))


def pr_link_transform(field: str):
    """Splits an owner/repo#n value into hidden pr_repo / pr_number fields the PR data link uses."""
    return {"id": "extractFields", "options": {"source": field, "format": "regexp",
                                               "regExp": "/^(?<pr_repo>[^#]+)#(?<pr_number>[0-9]+)$/",
                                               "replace": False, "keepTime": False}}


PR_LINK = link(Href(title="Open the pull request on GitHub", url="https://github.com/${__data.fields.pr_repo}/pull/${__data.fields.pr_number}"), blank=True)


# Tempo names its own columns by display name (Start time, Name, Duration, Span ID); attributes keep their key.
# A selected attribute that some spans lack is safe when Tempo omits it (an empty cell, as for
# agent_sdk.usage.reasoning_tokens). One that comes back as the string "nil", like http.response.status_code,
# fails the whole panel in an int column (Grafana's Tempo plugin), so its query needs a `!= nil` guard.
SPAN_COLUMNS = {
    "Start time": "Start time", "service.name": "Service", "Name": "Span",
    "Duration": "Duration",
    "Span ID": "Span ID", "status": "Status", "factory.delivery.kind": "Kind", "factory.outcome": "Outcome",
    "factory.ticket.key": "Ticket", "factory.reason": "Reason", "error.type": "Error type",
    "factory.pr": "PR", "factory.cloud_agent.id": "Cloud agent", "http.request.method": "Method",
    "url.path": "Path", "http.response.status_code": "HTTP status", "agent_sdk.channel": "Channel",
    "agent_sdk.session_mode": "Mode", "agent_sdk.usage.input_tokens": "Input (gross)",
    "agent_sdk.usage.cache_read_tokens": "Cache read", "Uncached": "Uncached",
    "agent_sdk.usage.output_tokens": "Output", "agent_sdk.usage.reasoning_tokens": "Reasoning",
    "agent_sdk.expected_error": "Expected error", "cursor.tool.name": "Tool",
    "agent_sdk.turn_id": "Turn", "traceIdHidden": "traceIdHidden",
}


def span_select_names(query: str):
    """Display names Tempo will return for this TraceQL select(), plus built-in columns."""
    names = {"Start time", "Duration", "Span ID", "traceIdHidden"}
    q = re.sub(r"\s+with\([^)]+\)\s*$", "", query)
    mo = re.search(r"\|\s*select\((.*)\)\s*$", q, re.S)
    if not mo:
        return names
    # TraceQL `name` is the span name; Tempo's built-in column is "Name" / "Span".
    aliases = {"name": "Span", **SPAN_COLUMNS}
    for raw in mo.group(1).split(","):
        arg = raw.strip()
        for key in (arg, arg.removeprefix("span."), arg.removeprefix("resource."),
                    arg.capitalize(), arg.split(".")[-1]):
            if key in aliases:
                names.add(aliases[key])
                break
    if "Input (gross)" in names:
        names.add("Uncached")
    return names


@dataclass(frozen=True, kw_only=True)
class EmptyState:
    """Empty-state standard (v2): what is missing, then what to do, as two sentences."""
    missing: str
    action: str

    def text(self):
        return f"{self.missing}. {self.action}."


def empty_state(state: EmptyState):
    return state.text()


TICKET_EMPTY = empty_state(EmptyState(missing="Pick a ticket in the Ticket box above", action="If one is picked, widen the time range"))


def newest(query: str) -> str:
    """Tempo search returns an arbitrary matching set unless most_recent is set."""
    pin = "with(most_recent=true)"
    return query if pin in query else f"{query} {pin}"


def span_table(copy: Copy, *, query: str, has_pr: bool = False, no_value: str, limit: int = 50,
               columns: dict | None = None):
    """A Tempo spans table: Duration and Span ID sit right after Span so the trace link
    is on-screen at 1280.

    Tempo's Span ID link reads ${__data.fields.traceIdHidden} (resultTransformer.ts), so that
    field stays in the frame and is only hidden. Trace ID stays hidden (Span ID already opens
    the trace). Tables that name columns in their description are full width (w=24) and keep
    those columns. Hide Trace ID, fields that are constant on the query, and fields the
    description doesn't name when another table already shows them. Floors are minWidth sized
    for 1280 (Service 180, Span ID 110, Kind 195). columns maps display names this query
    returns to a px floor ({"min": n}), a fixed px ({"width": n}), "hide", or "exclude".
    Floors plus the other columns' rendered widths must fit the panel at a 1280 px viewport
    (see the dashboard tests). Ticket/PR links are appended after table()'s catch-all so they
    are the only override for those columns. merge then filterFields (count > 0)
    drops a zero-row Tempo frame so defaults.noValue renders.
    """
    query = newest(query)
    spec = {"Service": {"min": 190}, "Span": {"min": 190}, "Span ID": {"min": 110},
            "Kind": {"min": 195}, "Duration": {"min": 80}, "Start time": {"width": 165},
            "Tool": {"min": 160},
            "Error type": {"min": 100}, "HTTP status": {"min": 100}, "Expected error": {"min": 124},
            "Path": {"min": 210}, "PR": {"min": 200}, "Input (gross)": {"min": 120},
            "Cache read": {"min": 100}, "Uncached": {"min": 80}, "Reasoning": {"min": 90},
            **dict(columns or {})}
    min_widths, widths, hidden, extra_exclude = {}, {}, [], []
    for name, rule in spec.items():
        if rule == "hide":
            hidden.append(name)
        elif rule == "exclude":
            extra_exclude.append(name)
        elif isinstance(rule, dict) and not (set(rule) - {"min", "width"}) and ("min" in rule or "width" in rule):
            if "min" in rule:
                min_widths[name] = rule["min"]
            if "width" in rule:
                widths[name] = rule["width"]
        else:
            raise ValueError(f"unknown column rule for {name!r}: {rule!r}")
    overrides = [links_on("Service", links=[SERVICE_OPS])]
    for name, px in min_widths.items():
        overrides.append(min_width(name, px=px))
    for name, px in widths.items():
        overrides.append(width(name, px=px))
    selected = span_select_names(query)
    if "Span ID" in hidden and "Span" not in hidden:
        overrides.append(links_on("Span", links=[SPAN_TRACE_LINK]))
    if "HTTP status" in selected:
        overrides.append(http_status_colours("HTTP status"))
    if "Status" in selected:
        overrides.append(value_colours("Status", mapping=[
            ("unset", PALETTE["severity"]["calm"]),
            ("ok", PALETTE["severity"]["calm"]),
            ("error", "red"),
        ]))
    if "Outcome" in selected:
        overrides.append(outcome_cell_colours("Outcome"))
    overrides += [
        hide("traceIdHidden"),
        field_unit(("Start time", TIME_FMT)),
        # nil only on columns that have no colour mappings of their own.
        {"matcher": {"id": "byRegexp",
                     "options": r"/^(Reason|PR|Ticket|Cloud agent|Path|Tool|Turn|Channel|Mode|Error type|Expected error)$/"},
         "properties": [{"id": "mappings",
                         "value": [{"type": "value", "options": {"nil": {"text": "", "index": 0}}}]}]},
    ]
    for name in hidden:
        overrides.append(hide(name))
    transforms = [TEMPO_PROGRESS_DROP, {"id": "merge", "options": {}}, EMPTY_FRAME_GUARD]
    if has_pr:
        transforms.append(pr_link_transform("factory.pr"))
        overrides += [hide("pr_repo"), hide("pr_number")]
    # Do not exclude traceIdHidden: Tempo's Span ID link reads ${__data.fields.traceIdHidden}.
    unused = [k for k, v in SPAN_COLUMNS.items()
              if v not in span_select_names(query) and k not in extra_exclude and v not in extra_exclude]
    transforms.append(organize(SPAN_COLUMNS, order=list(SPAN_COLUMNS),
                               exclude=["Trace Service", "Trace Name", "service.namespace",
                                        *UNCACHED_HELPERS, *extra_exclude, *unused]))
    p = table(copy, ds=TEMPO, targets=[traceql(TraceQL(query=query), limit=limit)], transforms=transforms, overrides=overrides,
              no_value=no_value, sort=("Start time", True))
    # After table()'s catch-all noValue, so empty Ticket/PR cells are blank, not a blue link.
    p["fieldConfig"]["overrides"].extend([
        links_on_nonempty("Ticket", links=[JIRA_LINK, TICKET_OPS]),
        *([links_on_nonempty("PR", links=[PR_LINK])] if has_pr else []),
    ])
    return p


FACTORY_SELECT = ("select(resource.service.name, name, span.factory.delivery.kind, span.factory.outcome, "
                  "span.factory.ticket.key, span.factory.reason, span.factory.pr, span.factory.cloud_agent.id)")


# ------------------------------------------------------------------------------------------------
# Loki event tables (the ticket journey and the recent factory events on Ops).
# ------------------------------------------------------------------------------------------------
EVENT_FIELDS = ["Time", "timestamp", "service_name", "f_event", "f_ticket", "f_outcome", "f_reason", "f_via", "f_wake",
                "f_pr", "pr_path", "trace_id"]


EVENT_RENAME = {"service_name": "Service", "f_event": "Event", "f_ticket": "Ticket", "f_outcome": "Outcome",
                "f_reason": "Reason", "f_via": "Via", "f_wake": "Wake", "f_pr": "PR", "trace_id": "Trace"}


# pr_path (the GitHub link) keeps the full owner/repo; the f_pr cell then
# drops the owner so "repo#N" fits a 170 px column at 1280.
PR_PATH = ('| label_format pr_path=`{{ regexReplaceAll "#" .f_pr "/pull/" }}`'
           ' | label_format f_pr=`{{ regexReplaceAll "^[^#/]*/" .f_pr "" }}`')


# f_ticket is issueKey on most lines and factoryKey on the security reviewer's factoryDebug lines. A raw tagged
# line names its ticket only in text ("[planner] TLSSN-5 stopped without a plan"), so the journey also matches
# the Ticket box as a whole word in the body.
TICKET_IN_TEXT = '| regexp `(?P<r_ticket>\\b$ticket\\b)` | label_format f_ticket=`{{ or .f_ticket .r_ticket }}`'


# Tag lines: raw "[tag] ..." bodies (current); older tag:<tag> records from before #217 are still parsed.
TAG_LINE = r"^(tag:|\[[A-Za-z0-9][A-Za-z0-9/_.:-]*\] )"


def event_table(copy: Copy, *, expr: str, sort_desc: bool = True, no_value: str, widths: dict | None = None,
                hidden: tuple = ()):
    visible = [f for f in EVENT_FIELDS if f != "timestamp"]
    resolved_w = {"Time": 165, "Ticket": 85, "Outcome": 110}
    # Service is a floor, not fixed: factory-security-reviewer must fit, longer names may grow.
    resolved_min = {"Service": 190, "Event": 160, "Reason": 110, "PR": 170, "Trace": 150}
    for name, px in dict(widths or {}).items():
        if px is None:
            resolved_w.pop(name, None)
            resolved_min.pop(name, None)
        else:
            resolved_w[name] = px
            resolved_min.pop(name, None)
    # Hidden columns must not keep a width (journey Ticket was 90 + hide).
    for name in hidden:
        resolved_w.pop(name, None)
        resolved_min.pop(name, None)
    fixed = [width(name, px=px) for name, px in resolved_w.items()]
    fixed += [min_width(name, px=px) for name, px in resolved_min.items()]
    p = table(copy, ds=LOKI, targets=[loki(LogQL(expr=expr), max_lines=200)],
              transforms=[{"id": "merge", "options": {}}, EMPTY_FRAME_GUARD,
                          {"id": "extractFields", "options": {"source": "labels", "format": "json", "replace": False,
                                                              "keepTime": False}},
                          keep_fields(visible), organize(EVENT_RENAME, order=visible)],
              overrides=[links_on("Trace", links=[TRACE_LINK]),
                         links_on("Service", links=[SERVICE_OPS]),
                         field_unit(("Time", TIME_FMT)),
                         hide("pr_path"), *fixed,
                         *[hide(name) for name in hidden]],
              no_value=no_value, sort=("Time", sort_desc))
    p["fieldConfig"]["overrides"].extend([
        links_on_nonempty("Ticket", links=[JIRA_LINK, TICKET_OPS]),
        links_on_nonempty("PR", links=[link(Href(title="Open the pull request on GitHub", url="https://github.com/${__data.fields.pr_path}"), blank=True)]),
    ])
    return p


# ------------------------------------------------------------------------------------------------
# v4: two dashboards. Factory business is the cold-open story (delivery, lead times, first-pass rate, economics);
# Factory ops is health now, the Loki health events and ticket panels, and every debug table under collapsed rows.
# The headline flow figures read Loki: each host logs one JSON line per milestone (the v3 list above), so a count or
# a timestamp per ticket needs no Tempo span and no join across datasources.
# ------------------------------------------------------------------------------------------------
TICKET_HINT = ("Type a Jira key such as `TLSSN-56` in the Ticket box above, or click a ticket key "
               "in any table on either Factory dashboard.\n\nEmpty means no ticket: the ticket panels stay empty and the "
               "rest of the dashboard is unfiltered.")
# Filed: the ticket entered Triaged. The desk arms its plan-start check at that moment (plan_start_watch via arm;
# factory-desk lib/hop-watch.ts armHopWatch, for a ticket with a Slack thread), or failing that the planner's first
# turn starts (turn_started), which the desk triggers at Triaged. The desk's jira.announce.triaged span is the exact
# filing but is lossy (SPAN_LOSS_NOTE), so the Loki lines are the headline source.
FILED_WHERE = ('((f_event="plan_start_watch" and f_via="arm") '
               'or (f_event="turn_started" and service_name="factory-planner"))')
FILED_NOTE = ("Tickets that entered the factory in the time range: the desk started watching as the ticket went "
              "to Triaged, or the planner started when that watch is missing. A ticket with no Slack thread and no "
              "plan is not counted, so this is an approximation that can read low.")
MILESTONE_BY_NAME = {m.name: m for m in MILESTONES}
PLAN_START_WHERE_M = MILESTONE_BY_NAME["plan start"].where
APPROVED_WHERE = MILESTONE_BY_NAME["approved (reached worker)"].where
PR_OPENED_WHERE = MILESTONE_BY_NAME["PR opened"].where
MERGED_WHERE = MILESTONE_BY_NAME["merged"].where
# A ticket's filing or a launch retry can predate the range it merged in: those lines are read over the range or
# the last 7 days, whichever is longer (an `or` of the two windows; only label presence matters).
LOOKBACK_7D = Window(span="7d")
LOOKBACK_NOTE = ("Events that can predate the range (the filing, a launch retry, a Bugbot round) are counted over the "
                 "dashboard range or the last 7 days, whichever is longer; older ones are missed.")
# The line's own timestamp as a number, so a range aggregation can take the earliest per ticket.
TS_UNWRAP = "| label_format m_ts=`{{ __timestamp__ | unixEpochMillis }}` | unwrap m_ts"
# A Bugbot fix round on a PR: the fixer granted a round and dispatched the drive (bugbot_round drive, logged just
# before driveTask), or a Bugbot wake with no bound agent started a fresh drive (bugbot_wake fresh_drive).
# recordBugbotRound logs nothing on success, so the granted round is the nearest signal to "a round went".
BUGBOT_FIX_WHERE = ('((f_event="bugbot_round" and f_outcome="drive") '
                    'or (f_event="bugbot_wake" and f_outcome="fresh_drive"))')
FIXER_SEL = '{service_namespace="software-factory", service_name="factory-pr-autofixer"}'
# The worker's lines that carry both issueKey and pr (owner/repo#n, the same label the fixer logs): the PR -> ticket map.
PR_TICKET_WHERE = '(f_event=~"implement_pr|pr_status")'
FIRST_PASS_NOTE = ("First pass means the ticket merged with no worker launch retry and no Bugbot fix round on its PR. "
                   "Approximation: a Bugbot round that was granted but then failed still counts as a round (reads low); "
                   "a PR the worker never tied to the ticket cannot be joined (reads high). " + LOOKBACK_NOTE)
# Hop-watch deliveries: the desk's 5-minute liveness schedule (schedule.hop-watch, outcome idle / due / fired), its
# reminders and backstop sweeps. Hundreds a day with no ticket work behind them, so Ops leaves them out of every
# delivery error and no-op figure; the by-kind chart still shows them as their own family.
HOP_WATCH_KINDS = "schedule[.]hop-watch|reminder[.]hop_watch|hop_watch[.].*"
NOT_HOP_WATCH = f'factory_delivery_kind!~"{HOP_WATCH_KINDS}"'
HOP_WATCH_KIND_NOTE = ("Hop-watch deliveries (kinds schedule.hop-watch, reminder.hop_watch, hop_watch.*: the desk's "
                       "5-minute liveness tick, its reminders and backstop sweeps) are left out of this figure, so an "
                       "idle tick's no-op or a sweep's error cannot dominate it; the by-kind chart lists them.")
HOURS_DEFAULT = "4"
HOURS_NOTE = ("MODELLED, not measured. Assumes $hours_per_ticket engineer-hours of manual work per merged ticket; the "
              "default 4 h is a conservative manual baseline for a small ticket (plan + implement + PR), chosen because "
              "recent factory tickets took about 25 to 40 minutes from filing to PR. It is not an observation of hours "
              "saved. Edit the Hours / ticket variable to change the model.")
# Exec funnel: five stages the data supports (Filed→…→Merged). "Launched" sits between
# Approved and PR opened in the logs but is redundant for the business view.
FLOW_STAGES = [("Filed", FILED_WHERE), ("Planned", PLAN_START_WHERE_M),
               ("Approved", APPROVED_WHERE), ("PR opened", PR_OPENED_WHERE),
               ("Merged", MERGED_WHERE)]
# Five stops on the six-step stage ramp (skip the middle-dark step so Merged stays darkest).
FLOW_RAMP = [STAGE_RAMP[0], STAGE_RAMP[1], STAGE_RAMP[2], STAGE_RAMP[4], STAGE_RAMP[5]]
FLOW_COLOURS = dict(zip((name for name, _ in FLOW_STAGES), FLOW_RAMP))
# Business-facing stage names for Spend by service (Ops keeps the hosted slugs).
BUSINESS_SERVICE_LABELS = {
    "factory-desk": "Intake & Slack",
    "factory-planner": "Planning",
    "factory-worker": "Building",
    "factory-security-reviewer": "Security review",
    "factory-pr-autofixer": "PR fixes",
    "factory-triage-jira": "Triage",
}
UNATTRIBUTED_TICKET = "Unattributed (before ticket tagging)"
LEAD_PR = "Filed → PR opened"
LEAD_MERGED = "Filed → merged"
# groupingToMatrix names its first column `${rowField}\${columnField}` (a literal backslash).
LEAD_MATRIX_ROW = "f_ticket\\lead"


@dataclass(frozen=True, kw_only=True)
class LeadSpec:
    """One lead-time end milestone: LogQL where-clause and the static `lead` label / display name."""
    where: str
    name: str

LEAD_TO_PR = LeadSpec(where=PR_OPENED_WHERE, name=LEAD_PR)
LEAD_TO_MERGED = LeadSpec(where=MERGED_WHERE, name=LEAD_MERGED)
LEAD_NOTE = ("Per ticket, from filing to the first matching stage, using each ticket's own timestamps. Only tickets "
             "that reached the end stage in this range are measured; a ticket whose filing is older than the range "
             "or 7 days is left out. " + FILED_NOTE)


def service_var(*, hide: int = 0):
    # Static list, not label_values(): all six slugs stay selectable even
    # when idle in the time range (owner request, r14).
    return {"name": "service", "label": "Service", "type": "custom", "hide": hide,
            "query": ", ".join(SERVICES),
            "options": [{"text": s, "value": s, "selected": False} for s in SERVICES],
            "current": {"text": ["All"], "value": ["$__all"]},
            "includeAll": True, "multi": True, "allValue": ".*",
            "description": "Hosted slug (resource service.name). All six factory slugs, idle ones included."}


def hours_var():
    return custom_var(VarSpec(name="hours_per_ticket", label="Hours / ticket", default=HOURS_DEFAULT,
                              desc="MODELLED engineer-hours of manual work one merged ticket is assumed to replace: "
                                   "Engineer-hours saved (modelled) is merged tickets × this. The default 4 h is a "
                                   "conservative manual baseline for a small ticket (plan, implement, PR), not a "
                                   "measurement. Pick another value, or set var-hours_per_ticket in the URL."),
                      options=[(v, v) for v in ("1", "2", "4", "8", "16")])


def either_window(build: Callable[[Window], str]):
    """build(window) over the range, else over the last 7 days (LOOKBACK_NOTE)."""
    return f"(({build(RANGE)}) or ({build(LOOKBACK_7D)}))"


def first_line_ms(where: str, *, window: Window = RANGE):
    """Per ticket, the epoch-ms of its earliest `where` line in the window."""
    return f"min_over_time({milestone_lines(where)} {TS_UNWRAP} [{window.span}]) by (f_ticket)"


def lead_time_ms(lead: LeadSpec):
    """Per ticket: ms from its filing (range, else 7d) to its first end-milestone line in range. Missing either side drops it.

    The end side carries a static `lead` label (via label_format before unwrap). Loki drops extra labels on
    binary subtraction, so the duration is computed on (f_ticket) only, then the `lead` label is re-attached
    with `* on(f_ticket) group_left(lead)` against a keeper series from the same end lines — needed for the
    Lead times table's groupingToMatrix (ticket × lead).
    """
    filed = either_window(lambda w: first_line_ms(FILED_WHERE, window=w))
    # lead.name is one of our LEAD_* constants, not user input.
    end = (f"min_over_time({milestone_lines(lead.where)} | label_format lead=`{lead.name}` {TS_UNWRAP} "
           f"[{RANGE.span}]) by (f_ticket, lead)")
    dur = f"(({end}) - on(f_ticket) ({filed})) >= 0"
    keeper = f"count by (f_ticket, lead) ({end})"
    return f"({dur}) * on(f_ticket) group_left(lead) (({keeper}) > 0)"


def tickets_with(where: str, *, window: Window = RANGE):
    """One series per ticket with a `where` line in the window (the value is the line count; only the label matters)."""
    return f"sum by (f_ticket) (count_over_time({milestone_lines(where)} [{window.span}]))"


def tickets_reaching(stage_idx: int, *, window: Window = RANGE):
    """Distinct tickets that reached this funnel stage or any later one in the window.

    A later milestone implies every earlier stage (Slack / board approvals that leave no
    worker decision line still count as Approved once a PR opens or merges). The funnel
    only narrows.
    """
    wheres = [w for _, w in FLOW_STAGES]
    union = " or ".join(f"({tickets_with(w, window=window)})" for w in wheres[stage_idx:])
    return f"(count({union}) or vector(0))"


def bugbot_tickets(window: Window):
    """Tickets whose PR had a Bugbot fix round: fixer lines keyed by pr, joined on pr to the worker's lines that carry
    both issueKey and pr."""
    pr_map = (f"sum by (f_ticket, f_pr) (count_over_time({milestone_lines(PR_TICKET_WHERE)} "
              f'| f_pr != "" [{window.span}]))')
    rounds = (f"sum by (f_pr) (count_over_time({FIXER_SEL} {FACTORY_FIELDS} "
              f'| f_pr != "" | {BUGBOT_FIX_WHERE} [{window.span}]))')
    return f"sum by (f_ticket) (({pr_map}) and on(f_pr) ({rounds}))"


def first_pass_rate():
    """Share of the tickets merged in range with no launch retry / heal and no Bugbot fix round (FIRST_PASS_NOTE)."""
    merged = tickets_with(MERGED_WHERE)
    retried = either_window(lambda w: tickets_with(LAUNCH_RETRY_WHERE, window=w))
    bugbot = either_window(bugbot_tickets)
    clean = f"(({merged}) unless on(f_ticket) {retried} unless on(f_ticket) {bugbot})"
    return f"(count({clean}) or vector(0)) / (count({merged}) > 0)"


def slack_approvals_per_ticket():
    """Slack approvals in range (a ✅ on the plan or a typed approve) per ticket that reached the worker in range."""
    return f"({line_count(SLACK_APPROVED_WHERE)} or vector(0)) / ({distinct_tickets(APPROVED_WHERE)} > 0)"


def hours_saved():
    """Merged tickets in range × the Hours / ticket variable (HOURS_NOTE)."""
    return f"({distinct_tickets(MERGED_WHERE)} or vector(0)) * ${{hours_per_ticket}}"


def loki_count_stat(copy: Copy, *, expr: str, colour: Color | None = None):
    fixed = colour.name if colour else None
    p = stat(copy, query=Query(ds=LOKI, expr=loki(LogQL(expr=f"{expr} or vector(0)"), instant=True)),
             fixed_color=fixed, color_mode="background" if fixed else None,
             text={"title": 14, "value": 36})
    p["fieldConfig"]["defaults"]["links"] = [link(Href(title="Ticket milestones on Factory ops",
                                                       url=f"/d/{OPS}?${{__url_time_range}}"))]
    return p


def filed_stat():
    return loki_count_stat(Copy(title="Filed", desc=FILED_NOTE), expr=distinct_tickets(FILED_WHERE),
                           colour=Color(name=FLOW_COLOURS["Filed"]))


def prs_opened_stat():
    return loki_count_stat(Copy(title="PRs opened", desc="Tickets whose worker opened a pull request in the time range."),
                           expr=distinct_tickets(PR_OPENED_WHERE), colour=Color(name=FLOW_COLOURS["PR opened"]))


def merged_stat():
    return loki_count_stat(Copy(title="Merged", desc="Tickets the worker moved to Done on a merged pull request in the "
                                "time range."), expr=distinct_tickets(MERGED_WHERE),
                           colour=Color(name=FLOW_COLOURS["Merged"]))


def first_pass_stat():
    return stat(Copy(title="First-pass rate", desc="Share of merges in the time range that needed no launch retry/heal "
                     "and no Bugbot fix round. " + FIRST_PASS_NOTE),
                query=Query(ds=LOKI, expr=loki(LogQL(expr=first_pass_rate()), instant=True)),
                unit="percentunit", kind="ratio", decimals=1, no_value="no merged ticket in range",
                thresholds=severity_steps(((None, "bad"), (0.5, "warn"), (0.8, "good"))),
                color_mode="background", text={"title": 14, "value": 36})


def lead_time_stat(copy: Copy, *, lead: LeadSpec):
    """Median over tickets measured in range (Grafana reduces across per-ticket series; LogQL has no vector quantile)."""
    return stat(copy, query=Query(ds=LOKI, expr=loki(LogQL(expr=lead_time_ms(lead)), instant=True)),
                unit="ms", kind="latency", no_value="no ticket measured in range",
                reduce=Reduce(calc="p50", fields=""), color_mode="background",
                thresholds=severity_steps(((None, "good"), (3_600_000, "warn"), (86_400_000, "bad"))),
                text={"title": 13, "value": 28})


def lead_pr_stat():
    return lead_time_stat(Copy(title="Filed → PR opened", desc="Median time from filing to the worker opening the pull "
                               "request, for tickets whose PR opened in the time range. Detail in Lead times below. "
                               + LEAD_NOTE), lead=LEAD_TO_PR)


def lead_merged_stat():
    return lead_time_stat(Copy(title="Filed → merged", desc="Median time from filing to Done on a merged PR, for tickets "
                               "merged in the time range (includes human review wait). Detail in Lead times below. "
                               + LEAD_NOTE), lead=LEAD_TO_MERGED)


def slack_approvals_stat():
    return stat(Copy(title="Slack approvals / ticket", desc="Slack plan approvals in the time range (✅ on the plan, or a "
                     "typed approve) per ticket that reached the worker. Known undercount: an approval through the "
                     "desk's approve command or a drag to Approved on the board is not counted."),
                query=Query(ds=LOKI, expr=loki(LogQL(expr=slack_approvals_per_ticket()), instant=True)),
                unit="locale", kind="ratio", decimals=1, no_value="no ticket reached the worker in range",
                color_mode="background",
                thresholds=severity_steps(((None, "calm"),)),
                text={"title": 13, "value": 28})


def spend_stat():
    # Instant range-total (not a sliding $__range sparkline — that over-counted and skewed the delta).
    return stat(Copy(title="Spend", desc="Estimated model spend in the time range (list prices, not the invoice). "
                     + BUSINESS_ESTIMATE),
                query=Query(ds=PROM, expr=prom(PromQL(expr=estimate(RANGE, factory_wide=True)), instant=True)),
                unit="currencyUSD", decimals=2, no_value="no token data", kind="ratio",
                thresholds=severity_steps(((None, "calm"),)),
                color_mode="background",
                text={"title": 14, "value": 32})


def cost_per_merged_stat():
    expr = per_unit(Fraction(num=estimate(RANGE, factory_wide=True), den=f"sum({merged_tickets(RANGE_UNCAPPED)})"))
    return stat(Copy(title="Cost per merge", desc="Estimated spend in the time range divided by tickets merged. Short "
                     "windows look expensive when spend includes earlier work. "
                     + BUSINESS_ESTIMATE),
                query=Query(ds=PROM, expr=prom(PromQL(expr=expr), instant=True)),
                unit="currencyUSD", kind="ratio", decimals=2, no_value="no merged ticket in range",
                color_mode="background", text={"title": 13, "value": 28})


def hours_saved_stat():
    p = stat(Copy(title="Engineer-hours saved", desc=HOURS_NOTE),
             query=Query(ds=LOKI, expr=loki(LogQL(expr=hours_saved()), instant=True)),
             unit="suffix: h", decimals=0, kind="ratio",
             thresholds=severity_steps(((None, "good"),)),
             color_mode="background", text={"title": 13, "value": 28})
    p["fieldConfig"]["defaults"]["links"] = [link(Href(title="Open Factory ops", url=f"/d/{OPS}?${{__url_time_range}}"))]
    return p


def ticket_flow_bars():
    """Monotonic funnel: tickets at each stage or any later stage (later implies earlier)."""
    stages = list(FLOW_STAGES)
    targets = [loki(LogQL(expr=tickets_reaching(i)), ref=chr(65 + i), instant=True, legend=name)
               for i, (name, _) in enumerate(stages)]
    p = base("bargauge", copy=Copy(
        title="Ticket flow",
        desc="How many tickets reached each stage in the time range, in pipeline order (Filed → Planned → Approved → "
        "PR opened → Merged). Each bar is distinct tickets that reached this stage **or any later one** — a later "
        "milestone implies the earlier stages (for example a PR opened without a logged approval still counts as "
        "Approved). The funnel only narrows. " + FILED_NOTE),
        ds=LOKI, targets=targets)
    d = p["fieldConfig"]["defaults"]
    d.update({"unit": "none", "decimals": 0, "min": 0,
              "noValue": empty_state(EmptyState(missing="No tickets in range", action="Widen the time range")),
              **neutral_colour(),
              "links": [link(Href(title="Ticket milestones on Factory ops", url=f"/d/{OPS}?${{__url_time_range}}"))]})
    p["fieldConfig"]["overrides"] = [
        {"matcher": {"id": "byName", "options": f"Value #{chr(65 + i)}"},
         "properties": [{"id": "displayName", "value": name},
                        {"id": "color", "value": {"mode": "fixed", "fixedColor": FLOW_COLOURS[name]}}]}
        for i, (name, _) in enumerate(stages)
    ]
    p["options"] = {"orientation": "horizontal", "displayMode": "gradient", "valueMode": "text", "namePlacement": "left",
                    "showUnfilled": True, "sizing": "auto", "minVizHeight": 18, "minVizWidth": 8, "maxVizHeight": 48,
                    "text": {"titleSize": 14, "valueSize": 20},
                    "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "legend": {"showLegend": False}}
    return p


def ticket_flow_conversion():
    """Each funnel stage as a share of Filed (same cumulative ticket sets as Ticket flow)."""
    stages = list(FLOW_STAGES)
    filed = tickets_reaching(0)
    targets = []
    for i, (name, _) in enumerate(stages):
        if i == 0:
            # LogQL keeps the left-hand value on `> 0` (so count 4 → 4 = 400%). Divide to force 1.
            expr = f"(({filed} > 0) / ({filed} > 0))"
        else:
            expr = f"(({tickets_reaching(i)}) / ({filed} > 0))"
        targets.append(loki(LogQL(expr=expr), ref=chr(65 + i), instant=True, legend=name))
    p = base("bargauge", copy=Copy(
        title="Reach rate",
        desc="Each stage as a share of Filed in the time range (Filed = 100%), using the same cumulative ticket sets "
        "as Ticket flow (a later stage implies earlier ones). Bars use the same stage colours as Ticket flow."),
        ds=LOKI, targets=targets)
    d = p["fieldConfig"]["defaults"]
    d.update({"unit": "percentunit", "decimals": 0, "min": 0, "max": 1.5,
              "noValue": empty_state(EmptyState(missing="No tickets filed in range", action="Widen the time range")),
              **neutral_colour(),
              "links": [link(Href(title="Ticket milestones on Factory ops", url=f"/d/{OPS}?${{__url_time_range}}"))]})
    p["fieldConfig"]["overrides"] = [
        {"matcher": {"id": "byName", "options": f"Value #{chr(65 + i)}"},
         "properties": [{"id": "displayName", "value": name},
                        {"id": "color", "value": {"mode": "fixed", "fixedColor": FLOW_COLOURS[name]}}]}
        for i, (name, _) in enumerate(stages)
    ]
    p["options"] = {"orientation": "horizontal", "displayMode": "gradient", "valueMode": "text", "namePlacement": "left",
                    "showUnfilled": True, "sizing": "auto", "minVizHeight": 18, "minVizWidth": 8, "maxVizHeight": 48,
                    "text": {"titleSize": 14, "valueSize": 20},
                    "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "legend": {"showLegend": False}}
    return p


def lead_times_table():
    """One row per ticket: filed→PR and filed→merged (blank until the ticket merges).

    Do not seriesToRows + groupBy on `lead` / `Value #A`. When only one lead type is in
    range every series shares the same legend, Grafana names the value field `Value` or
    after that legend (not `Value #A`), and `lead` stays a label — groupBy then emits an
    empty frame and the trailing filterFields shows the no-data sentence.

    Loki dataplane numeric-multi is one frame per series (Time + Value, labels on Value).
    labelsToFields must run before merge: merge.copyFieldStructure drops `labels` once two
    or more frames are present, so a later labelsToFields has nothing to promote.
    groupingToMatrix then names its first column `f_ticket\\lead` (not `f_ticket`).
    """
    expr = f"({lead_time_ms(LEAD_TO_PR)}) or ({lead_time_ms(LEAD_TO_MERGED)})"
    # Empty legend so a single series is not named after the lead type (that name is
    # reserved for the matrix column). labelsToFields still exposes `lead`.
    targets = [loki(LogQL(expr=expr), ref="A", instant=True, legend="")]
    transforms = (
        {"id": "labelsToFields", "options": {"mode": "columns"}},
        {"id": "merge", "options": {}},
        # Value / Value #A / a shared-legend name. renameByRegex (not organize) so
        # layout_check does not treat an intermediate value-field header as visible.
        {"id": "renameByRegex", "options": {
            "regex": r"^(Value.*|Filed → .+)$", "renamePattern": "ms"}},
        {"id": "groupingToMatrix", "options": {
            "columnField": "lead", "rowField": "f_ticket", "valueField": "ms"}},
        organize({LEAD_MATRIX_ROW: "Ticket"}, order=[LEAD_MATRIX_ROW, LEAD_PR, LEAD_MERGED],
                 exclude=["Time"]),
    )
    return table(Copy(title="Lead times",
                      desc=f"{LEAD_PR}: filing to PR open. {LEAD_MERGED}: filing to Done on a merged PR (includes review "
                      f"wait). One row per ticket; merged stays blank until Done. " + LEAD_NOTE),
                 ds=LOKI, targets=targets, transforms=transforms,
                 overrides=(links_on("Ticket", links=[JIRA_LINK, TICKET_OPS]),
                            min_width("Ticket", px=110),
                            {"matcher": {"id": "byRegexp", "options": "/^Filed/"},
                             "properties": [{"id": "unit", "value": "ms"}, {"id": "decimals", "value": 1},
                                            {"id": "custom.minWidth", "value": 160}]},
                            min_width(LEAD_PR, px=160), min_width(LEAD_MERGED, px=160)),
                 no_value=empty_state(EmptyState(missing="No ticket reached PR opened in range",
                                                 action="Widen the time range")),
                 sort=("Ticket", False))


def cost_by_service(*, plain_names: bool = False):
    """Spend by hosted slug. On Business, rename slugs to plain stage names (Ops keeps the slugs)."""
    desc = ("Estimated spend in the time range by factory service. " + ESTIMATE_NOTE)
    if plain_names:
        desc = ("Estimated spend in the time range by stage. "
                + BUSINESS_ESTIMATE)
    p = bar_gauge(Copy(title="Spend by service", desc=desc),
                  query=Query(ds=PROM, expr=prom(PromQL(expr=f'sort_desc({all_services(estimate(RANGE, by="service_name"))})'),
                                                 legend='{{service_name}}', instant=True)),
                  unit="currencyUSD", decimals=2, no_value="— no spend")
    if plain_names:
        for o in p["fieldConfig"]["overrides"]:
            slug = (o.get("matcher") or {}).get("options")
            if slug in BUSINESS_SERVICE_LABELS:
                o["properties"].append({"id": "displayName", "value": BUSINESS_SERVICE_LABELS[slug]})
    return p


def cumulative_cost(*, factory_wide: bool = False):
    scope = "every factory service" if factory_wide else "the selected service"
    p = timeseries(Copy(title="Cumulative spend", desc=f"Running estimated spend since the start of the time range ({scope}). "
                        + (BUSINESS_ESTIMATE if factory_wide else ESTIMATE_NOTE)),
                   ds=PROM, targets=[prom(PromQL(expr=f"({estimate(PROM_AHEAD, factory_wide=factory_wide)}) > 0"),
                                          legend="Estimated cost")],
                   unit="currencyUSD", bars=False, calcs=["last"], decimals=2)
    p["fieldConfig"]["defaults"]["custom"].update({
        "showPoints": "never", "spanNulls": True, "fillOpacity": 45, "lineWidth": 2,
        "gradientMode": "opacity", "axisSoftMax": 1})
    p["transformations"] = [{"id": "calculateField", "options": {
        "mode": "cumulativeFunctions", "cumulative": {"field": "Estimated cost", "reducer": "sum"},
        "alias": "Cumulative estimated cost", "replaceFields": True}}]
    return p


def business_header():
    return text(Copy(title="Overview", desc="What this dashboard shows."),
                content=("Turns Jira tickets into merged pull requests — plan, approve, build, "
                         "review, merge — with people in the loop for approvals and merges.\n\n"
                         "**Read left to right:** delivery volume → quality and speed → spend. "
                         "**Ticket pipeline** is the funnel (counts and reach rate). "
                         "**Cost** uses list-price estimates, not the invoice — detail on Factory ops."))


def estimate_text_short():
    return text(Copy(title="About these figures", desc="Short note on what Spend measures."),
                content=("Spend is **estimated** from token counts × Cursor list prices (not billing). "
                         "**Cost by ticket** lists keyed tickets plus **Unattributed (before ticket tagging)** so the "
                         "cost column sums to Spend. **Ticket flow** counts a later milestone as having reached every "
                         "earlier stage (for example a PR without a logged approval still counts as Approved). "
                         "Engineer-hours saved is a **model** (merged tickets × Hours / ticket). "
                         f"Full pricing assumptions live on [Factory ops](/d/{OPS})."))


def estimate_text():
    """Full estimate methodology — shown on Factory ops."""
    return text(Copy(title="Estimate, not billing", desc="How the cost estimate is made, and what it leaves out."),
                content="July 0.2.20 dropped `cursor.cost.usage`; 0.2.22 emits no USD cost metric and no "
                "`cursor.model.name` / `agent_sdk.cost_usd` on new turns. Cost here is "
                f"tokens × the hidden price variables (USD per 1M tokens, [Cursor list prices]({PRICES_URL}), retrieved "
                f"{PRICES_DATE}), by design, not a workaround for a late estimate. Defaults are Grok 4.6 Fast, the desk's and triage's model: $4 input, $1 cache read, $12 output; "
                "reasoning $0 because reasoning tokens are counted inside output. Uncached input is priced at the input price "
                "and cache reads once at the cache price. Historical `cursor_cost_usage_USD_total` series, if still in the store, are unused.\n\n"
                "The planner, worker, fixer and reviewer run Cursor Auto, which bills at the list price of whatever model each "
                "request is routed to. Auto routing and the Cursor Token Rate for third-party models are not modelled.\n\n"
                "**Engineer-hours saved** is a model, not a measurement: merged tickets × the Hours / ticket variable "
                "(default 4 h). Change the variable to change the model.")


def business():
    v = [service_var(hide=2), hours_var(), bucket_var(hide=2), prom_res_var(), smooth_var()] + price_vars(hide=2)
    d = Dashboard(DashMeta(uid=BUSINESS, title="Factory business",
                           description="What the Software Factory delivered and what it cost: tickets filed, PRs opened "
                           "and merged, lead times, first-pass rate, Slack approvals, list-price spend, and modelled "
                           "engineer-hours. Health and debugging are on Factory ops. " + BUSINESS_ESTIMATE),
                  variables=v)

    d.add(business_header(), size=Size(w=24, h=3))

    d.row("Delivery")
    for p in (filed_stat(), prs_opened_stat(), merged_stat(), first_pass_stat()):
        d.add(p, size=Size(w=6, h=6))
    for p in (lead_pr_stat(), lead_merged_stat(), slack_approvals_stat()):
        d.add(p, size=Size(w=8, h=5))
    for p in (spend_stat(), cost_per_merged_stat(), hours_saved_stat()):
        d.add(p, size=Size(w=8, h=5))

    d.row("Ticket pipeline")
    d.add(ticket_flow_bars(), size=Size(w=12, h=10))
    d.add(ticket_flow_conversion(), size=Size(w=12, h=10))
    d.add(lead_times_table(), size=Size(w=24, h=8))

    d.row("Cost")
    d.add(cumulative_cost(factory_wide=True), size=Size(w=12, h=8))
    d.add(cost_by_service(plain_names=True), size=Size(w=12, h=8))
    d.add(ticket_cost_table(plain=True), size=Size(w=24, h=9))
    d.add(estimate_text_short(), size=Size(w=24, h=4))
    return d.json()

# ================================================================================================
# 2. Factory ops
# ================================================================================================
def ops():
    tag_lines = custom_var(VarSpec(name="tag_lines", label="Tags", default=TAG_LINE, desc="Most lines are July's [bdk] admission lines (raw [bdk] text; older tag:bdk records "
                           "are still parsed). Hide every tagged line, raw [tag] or tag:<tag>, in All factory logs. Hidden from the variable bar so it stays one line at 1280; the Raw panel still applies it."),
                           options=[("Hide tag lines", TAG_LINE), ("Show everything", "^$")], hide=2)
    search = textbox_var(VarSpec(name="search", label="Find", default="", desc="Case-insensitive regex on the log body in All factory logs (Debug: volume and raw logs). "
                                 "Hidden from the variable bar so it stays one line at 1280 with Service, Ticket and Bucket; set var-search=<regex> in the URL."), hide=2)
    v = [service_var(), ticket_var(), bucket_var(), search, tag_lines, prom_res_var(), smooth_var()] + price_vars(hide=2) + [exec_service_var()]
    d = Dashboard(DashMeta(uid=OPS, title="Factory ops",
                           description="Is the Software Factory healthy now, and what is each ticket doing? Live health, "
                           "in-range KPIs, tickets in flight, change reviews, and failures that need action. Detail "
                           "tables, charts and raw logs sit under collapsed Debug rows. Prometheus counts are "
                           "approximate; log lines are the reference for ticket stages. The delivery story is on "
                           "Factory business."),
                  variables=v)
    d.add(text(Copy(title="Overview", desc="How to read Factory ops."),
               content=("**Now** is the last 15 minutes: stuck tickets, errors, ack speed. **In range** is the time "
                        "window you picked — Cost with Service=All matches Factory business Spend. **Tickets** lists "
                        "what is in flight (furthest stage and change review). Open a **Debug** row only when you need "
                        "the underlying lines or charts.")),
          size=Size(w=24, h=3))
    ack = ('factory_span="factory.delivery"',)
    err = f'factory_outcome=~"{ERR_RE}"'
    count_bad = severity_steps(((None, "calm"), (1, "bad")))
    count_warn = severity_steps(((None, "calm"), (1, "warn")))
    ack_steps = severity_steps(((None, "calm"), (3000, "warn"), (10000, "bad")))
    err_rate_steps = severity_steps(((None, "good"), (0.01, "warn"), (0.05, "bad")))
    activity = all_services(whole(total(DELIVERY, window=PROM_AHEAD, by="service_name")))
    totals = f'cursor_token_type=~"{TOTAL_TYPES}"'
    tok = token_type

    d.row("Now · 15m")
    d.add(background(stuck_count()), size=Size(w=4, h=4))
    d.add(stat(Copy(title="Errors", desc=f"Deliveries whose factory.outcome is an error ({ERR_RE}) in the last 15 minutes. "
                    "Red from 1 in this short window (any failure is worth a look now). "
                    + HOP_WATCH_KIND_NOTE + " " + NOW_NOTE),
               query=Query(ds=PROM, expr=prom(PromQL(expr=f"{total(DELIVERY, window=NOW, where=(err, NOT_HOP_WATCH))} or vector(0)"),
                                      instant=True)),
               kind="good_bad", thresholds=count_bad, no_value="0", time_from="15m", color_mode="background",
               links=[link(Href(title="Failures and warnings, last 15 minutes", url=f"/d/{OPS}?from=now-15m&to=now&${{__all_variables}}"))]),
               size=Size(w=4, h=4))
    d.add(stat(Copy(title="Turn fails", desc="Agent turns with agent_sdk.turn_status = failed in the last 15 minutes "
                    "(expected-error statuses excluded). Red from 1. " + NOW_NOTE + " " + COUNTER_NOTE),
               query=Query(ds=PROM, expr=prom(PromQL(expr=f"{total(TURNS, window=NOW, where=(TURN_FAILED,))} or vector(0)"),
                                      instant=True)),
               kind="good_bad", thresholds=count_bad, no_value="0", time_from="15m", color_mode="background"), size=Size(w=4, h=4))
    d.add(stat(Copy(title="Tool fails", desc="Tool calls with cursor.tool.status = failure in the last 15 minutes. Orange from 1. "
                    + NOW_NOTE),
               query=Query(ds=PROM, expr=prom(PromQL(expr=f"{total(TOOLS, window=NOW, where=(TOOL_FAILED,))} or vector(0)"),
                                      instant=True)),
               kind="good_bad", thresholds=count_warn, no_value="0", time_from="15m", color_mode="background"), size=Size(w=4, h=4))
    d.add(stat(Copy(title="Ack p95", desc="p95 of the factory.delivery span (the webhook or hook handler up to its reply) "
                    "in the last 15 minutes. Target: under 3 s (orange), 10 s is red. Background work, "
                    "reminders and cloud-agent launches are not in it (see Debug: latency). "
                    + QUANTILE_NOTE + " " + TWO_WRITERS + " " + NOW_NOTE),
               query=Query(ds=PROM, expr=prom(PromQL(expr=quantile(0.95, histogram=DELIVERY_DURATION, window=NOW,
                                                      where=ack)), instant=True)),
               unit="ms", kind="latency", thresholds=ack_steps, no_value="— no traffic",
               time_from="15m", color_mode="background"), size=Size(w=4, h=4))
    d.add(stat(Copy(title="Deliveries", desc="Factory deliveries, reminders, schedules and launches in the last 15 minutes "
                    "(apj_factory_delivery_total). " + HOP_WATCH_KIND_NOTE + " " + NOW_NOTE + " " + COUNTER_NOTE),
               query=Query(ds=PROM, expr=prom(PromQL(expr=f"{total(DELIVERY, window=NOW, where=(NOT_HOP_WATCH,))} or vector(0)"), instant=True)),
               time_from="15m", no_value="0"), size=Size(w=4, h=4))
    d.add(stuck_table(), size=Size(w=24, h=6))
    d.add(status_history(Copy(title="Activity per service (deliveries per hour)", desc="One row per slug, one cell per hour (Grafana widens the step on long ranges; "
                         "the query interval is 1h with maxDataPoints 200). "
                         "A cell of 1+ is visible (light blue); darker blue is busier. "
                         + ALL_SERVICES_NOTE + " An idle slug keeps its row with blank cells. " + COUNTER_NOTE),
                         target=prom(PromQL(expr=activity), legend="{{service_name}}"), interval="1h"), size=Size(w=24, h=8))

    d.row("In range")
    d.add(stat(Copy(title="Deliveries", desc="Factory deliveries, reminders, schedules and launches in the time range "
                    "(apj_factory_delivery_total). " + HOP_WATCH_KIND_NOTE + " " + COUNTER_NOTE),
               query=Query(ds=PROM, expr=prom(PromQL(expr=f"{total(DELIVERY, where=(NOT_HOP_WATCH,))} or vector(0)"), instant=True))),
           size=Size(w=4, h=4))
    d.add(stat(Copy(title="Errors", desc=f"Deliveries in range whose factory.outcome is an error ({ERR_RE}). "
                    "Count only — colour lives on Error % (green under 1%, orange 1–5%, red above 5%), so a single "
                    "failure in hundreds of deliveries stays calm. " + HOP_WATCH_KIND_NOTE + " " + COUNTER_NOTE),
               query=Query(ds=PROM, expr=prom(PromQL(expr=f"{total(DELIVERY, where=(err, NOT_HOP_WATCH))} or vector(0)"), instant=True)),
               no_value="0",
               links=[link(Href(title="Failed or no-op deliveries (Debug)",
                                url=f"/d/{OPS}?${{__url_time_range}}&${{__all_variables}}"))]),
           size=Size(w=4, h=4))
    d.add(stat(Copy(title="Error %", desc=f"Share of deliveries whose factory.outcome is an error ({ERR_RE}). "
                    "Green under 1%, orange from 1%, red from 5%. Empty means no deliveries in range. "
                    + HOP_WATCH_KIND_NOTE + " " + BOTH_COUNTERS),
               query=Query(ds=PROM, expr=prom(PromQL(expr=ratio(DELIVERY, bad=(err,), where=(NOT_HOP_WATCH,))), instant=True)),
               unit="percentunit", kind="ratio", thresholds=err_rate_steps, decimals=1,
               no_value="— no deliveries", color_mode="background"), size=Size(w=4, h=4))
    d.add(stat(Copy(title="Ack p95", desc="p95 of the factory.delivery span in range. Target: under 3 s (orange), 10 s is red. "
                    "Background work, reminders and cloud-agent launches are not in it (see Debug: latency). "
                    + QUANTILE_NOTE + " " + TWO_WRITERS),
               query=Query(ds=PROM, expr=prom(PromQL(expr=quantile(0.95, histogram=DELIVERY_DURATION, where=ack)), instant=True)),
               unit="ms", kind="latency", thresholds=ack_steps, no_value="— no traffic",
               color_mode="background"), size=Size(w=4, h=4))
    d.add(stat(Copy(title="Cost", desc=ESTIMATE_NOTE + " With Service=All this matches Factory business Spend. "
                    "Narrow Service to one factory-* slug to see that host only. Breakdown under Debug: cost."),
               query=Query(ds=PROM, expr=prom(PromQL(expr=estimate(RANGE, factory_wide=True)), instant=True)),
               unit="currencyUSD", decimals=2, no_value="— no spend", kind="ratio",
               thresholds=severity_steps(((None, "calm"),)), color_mode="background"), size=Size(w=4, h=4))
    d.add(stat(Copy(title="Cache %", desc="Share of the prompt input in range that was served from cache: cache_read / "
                    "(uncached input + cache_read), with uncached input decided per series. "
                    + TWO_SHAPES_NOTE),
               query=Query(ds=PROM, expr=prom(PromQL(expr=cache_share()), instant=True)),
               unit="percentunit", kind="tokens", decimals=1, no_value="— no tokens"), size=Size(w=4, h=4))

    d.row("Needs action")
    d.add(background(never_started_stat()), size=Size(w=6, h=4))
    d.add(plan_started_stat(), size=Size(w=6, h=4))
    d.add(background(launch_retries_stat()), size=Size(w=6, h=4))
    d.add(change_review_posts_stat(), size=Size(w=6, h=4))

    d.row("Tickets")
    d.add(recent_tickets(), size=Size(w=16, h=10))
    d.add(change_review_table(), size=Size(w=8, h=10))

    d.row("Failures and warnings")
    failed_turn = 'agent_sdk_event="turn.failed" | agent_sdk_expected_error=""'
    d.add(timeseries(Copy(title="Errors and warnings per bucket by level", desc="Factory error and warning log lines per bucket, stacked by level "
                     f"(error red, warn orange; {SLACK_PAIR} left out). "
                     + LOKI_BUCKET_NOTE),
                     ds=LOKI, targets=[loki(LogQL(expr=f"sum by (level) (count_over_time({LSEL} | {LEVELS_BAD} {NOT_SLACK_SDK_WARN} {LEVEL} {rng(LOKI_AHEAD)}))"),
                                 legend="{{level}}", step="$bucket")]), size=Size(w=24, h=9))

    # ---- Debug rows: collapsed by default. ----
    d.row("Debug: more in-range KPIs", collapsed=True)
    d.add(stat(Copy(title='5xx', desc='Share of July hosted HTTP requests (agent_sdk.http.duration count) answered 5xx. Orange from 1%, red from 5%. ' + COUNTER_NOTE), query=Query(ds=PROM, expr=prom(PromQL(expr=ratio(HTTP_DURATION + '_count', bad=('http_response_status_code=~"5.."',))), instant=True)), unit='percentunit', kind='ratio', thresholds=severity_steps(((None, 'calm'), (0.01, 'warn'), (0.05, 'bad'))), decimals=1, no_value='— no HTTP', color_mode='background'), size=Size(w=4, h=4))
    d.add(stat(Copy(title='KV fails', desc='Ops-funnel failures (apj_factory_kv_failure_total). Bind emits a zero baseline (site="none", reason="none"), so 0 is the normal answer. Orange from 1; Debug: agent turns and tools has the breakdown (table filters the baseline).'), query=Query(ds=PROM, expr=prom(PromQL(expr=f'{total(KV_FAILURES)} or vector(0)'), instant=True)), kind='good_bad', thresholds=count_warn, no_value='0', color_mode='background'), size=Size(w=4, h=4))
    d.add(stat(Copy(title='Turns', desc='Agent turns, any status (agent_sdk_turn_count_total). The Loki turn chart under Debug: turns counts July\'s turn.completed / turn.failed records instead, so the two can differ. ' + COUNTER_NOTE), query=Query(ds=PROM, expr=prom(PromQL(expr=f'{total(TURNS)} or vector(0)'), instant=True))), size=Size(w=4, h=4))
    d.add(stat(Copy(title='Turn fail %', desc='Share of turns with agent_sdk.turn_status = failed. Expected customer-state errors are their own statuses and are not counted. Orange from 5%, red from 20%. ' + COUNTER_NOTE), query=Query(ds=PROM, expr=prom(PromQL(expr=ratio(TURNS, bad=(TURN_FAILED,))), instant=True)), unit='percentunit', kind='ratio', thresholds=severity_steps(((None, 'calm'), (0.05, 'warn'), (0.2, 'bad'))), decimals=1, no_value='— no turns', color_mode='background'), size=Size(w=4, h=4))
    d.add(stat(Copy(title='Tool calls', desc='Tool calls, any status (cursor_tool_calls_total). ' + COUNTER_NOTE), query=Query(ds=PROM, expr=prom(PromQL(expr=f'{total(TOOLS)} or vector(0)'), instant=True))), size=Size(w=4, h=4))
    d.add(stat(Copy(title='Tool err %', desc='Share of tool calls with cursor.tool.status = failure. Orange from 5%.'), query=Query(ds=PROM, expr=prom(PromQL(expr=ratio(TOOLS, bad=(TOOL_FAILED,))), instant=True)), unit='percentunit', kind='ratio', thresholds=severity_steps(((None, 'calm'), (0.05, 'warn'))), decimals=1, no_value='— no tools', color_mode='background'), size=Size(w=4, h=4))

    d.row("Debug: factory health detail", collapsed=True)
    d.add(plan_start_table(), size=Size(w=12, h=7))
    d.add(launch_decisions_table(), size=Size(w=12, h=7))
    where = f"{PLAN_START_WHERE} or {DECISION_WHERE} or (f_event=\"review_update\" and m_posted=\"true\")"
    expr = (f"{milestone_lines(where)} {MILESTONE_LABEL} "
            '| line_format `{{ .f_ticket }} · {{ .f_event }} {{ .f_outcome }}{{ .m_result }}'
            '{{ if .f_via }} via {{ .f_via }}{{ end }}{{ if eq .m_retried "true" }} retried{{ end }}'
            '{{ if .m_changeReview }} change review {{ .m_changeReview }}{{ end }}'
            '{{ if .f_pr }} {{ .f_pr }}{{ end }} ({{ regexReplaceAll "^factory-" .service_name "" }})`')
    d.add(logs(Copy(title="Health event lines (plan start watch, worker decisions, review updates)",
                    desc="The lines behind the Needs action tiles, newest first: every plan_start_watch line (armed, started, "
                    "retried, final, …), every worker decision (launched, turn_sent, launch_failed, duplicate, …) and "
                    "every review update the desk posted. The idle hop-watch tick is not a health event and is not "
                    "here. " + LOG_SHAPES_NOTE),
               target=loki(LogQL(expr=expr), max_lines=300), no_value="No health event line in range"),
          size=Size(w=24, h=9))

    d.row("Debug: ticket journey and milestones", collapsed=True)
    d.add(ticket_milestones(), size=Size(w=24, h=10))
    d.add(event_table(Copy(title='Ticket journey: events in time order', desc=TICKET_HINT + "\n\nEvery log line whose issueKey (or the reviewer's factoryKey) is the Ticket box above (empty means this panel stays empty), or whose raw body names it as a whole word, all slugs, oldest first. Ticket opens Jira, PR opens GitHub, Trace opens the trace. " + LOG_SHAPES_NOTE), expr=f'{{service_namespace="software-factory"}} {FACTORY_FIELDS} {TICKET_IN_TEXT} | f_ticket != "" | f_ticket = "$ticket" {PR_PATH}', no_value=TICKET_EMPTY, sort_desc=False, hidden=("Via", "Wake", "Ticket")), size=Size(w=24, h=8))

    d.row("Debug: delivery charts", collapsed=True)
    d.add(timeseries(Copy(title="Deliveries per bucket by service", desc="Factory deliveries per bucket, stacked by slug, hop-watch ticks included. " + ALL_SERVICES_NOTE + " " + BUCKET_NOTE),
                     ds=PROM, targets=[prom(PromQL(expr=all_services(whole(total(DELIVERY, window=PROM_AHEAD, by="service_name")))), legend="{{service_name}}")],
                     keep_zeros=True,
                     links=[link(Href(title="${__field.labels.service_name} on Factory ops",
                                      url=f"/d/{OPS}?var-service=${{__field.labels.service_name}}&${{__url_time_range}}"))]), size=Size(w=12, h=10))
    d.add(timeseries(Copy(title="Deliveries per bucket by kind", desc="Factory deliveries per bucket, stacked by kind family "
                     "(github, jira, slack, schedule, reminder, hop_watch, …), hop-watch ticks included as their own families. "
                     "Categorical palette (PALETTE kind): kind is not an outcome. "
                     "Outcome class is the next panel. " + BUCKET_NOTE),
                     ds=PROM, targets=[prom(PromQL(expr=whole(delivery_by_kind_family(window=PROM_AHEAD))),
                                            legend="{{family}}")],
                     calcs=[],
                     legend={"display": "list", "placement": "bottom"}), size=Size(w=12, h=10))
    d.add(timeseries(Copy(title="Deliveries per bucket by outcome class", desc="Per bucket, 100% stacked by outcome class (error / no-op / ok / handoff / other) from "
                     f"factory.outcome. ok is explicit success ({OK_RE}); handoff is in-flight "
                     f"({HANDOFF_RE}); a missing or unlisted value is other (neutral grey). Kind is "
                     f"the panel above. " + HOP_WATCH_KIND_NOTE + " " + BUCKET_NOTE),
                     ds=PROM, targets=[prom(PromQL(expr=whole(outcome_class(window=PROM_AHEAD, where=(NOT_HOP_WATCH,)))), legend="{{class}}")],
                     percent=True), size=Size(w=24, h=10))
    d.row("Debug: turns and failure detail", collapsed=True)
    any_turn = f'sum(count_over_time({LSEL} | agent_sdk_event=~"turn[.](completed|failed)" {rng(LOKI_AHEAD)}))'
    d.add(timeseries(Copy(title="Turns completed vs failed per bucket", desc="July turn.completed and turn.failed records per bucket (failed leaves out expected customer-state "
                     "errors, as the Turn fails tiles do). Each series is 0 in every bucket that had a turn, "
                     "so a flat failed series means no failed turn, not a missing feed. " + TURNS_CAVEAT + " The In range "
                     "Turns tile counts the Prometheus turn counter (approximate) instead, so the two can differ. " + LOKI_BUCKET_NOTE),
                     ds=LOKI, targets=[loki(LogQL(expr=f'sum(count_over_time({LSEL} | agent_sdk_event="turn.completed" {rng(LOKI_AHEAD)})) or 0 * {any_turn}'),
                                           ref="A", legend="completed", step="$bucket"),
                            loki(LogQL(expr=f'sum(count_over_time({LSEL} | {failed_turn} {rng(LOKI_AHEAD)})) or 0 * {any_turn}'),
                                 ref="B", legend="failed", step="$bucket")],
                     overrides=colours_from(PALETTE["turn"]),
                     no_value=empty_state(EmptyState(missing="No turn.completed records in range", action="Widen the time range"))), size=Size(w=24, h=9))
    d.add(logs(Copy(title="Failures and warnings", desc="Factory error and warning lines: turn.failed, session.failed, failed action.result, factory kv/ops/step "
               f"warnings, and tagged lines logged at warn or error. Lines from {SLACK_PAIR} are under Debug: Slack SDK "
               "(expected), not here. Each line shows the slug and the body, then the tool, ticket and reason when present. "
               "An empty panel is the normal state (the 2026-10-03 audit hour had one error line and no warning). "
               + LOG_SHAPES_NOTE),
               target=loki(LogQL(expr=LSEL + " | " + LEVELS_BAD + " " + NOT_SLACK_SDK_WARN + " " + FACTORY_FIELDS
                    + ' | line_format "{{.service_name}} {{ __line__ }}'
                    '{{ if .cursor_tool_name }} tool={{.cursor_tool_name}} status={{.cursor_tool_status}}{{ end }}'
                    '{{ if .f_ticket }} issue={{.f_ticket}}{{ end }}{{ if .f_reason }} reason={{.f_reason}}{{ end }}"')),
               no_value="No factory errors or warnings in range"), size=Size(w=24, h=12))
    d.row("Debug: cost", collapsed=True)
    d.add(cost_by_service(), size=Size(w=12, h=8))
    d.add(timeseries(Copy(title="Cost / bucket", desc=ALL_SERVICES_NOTE + " " + TURNS_CAVEAT + " " + ESTIMATE_NOTE + " " + BUCKET_NOTE + " " + BUCKET_VS_RANGE), ds=PROM,
                     targets=[prom(PromQL(expr=all_services(estimate(PROM_AHEAD, by="service_name"))), legend="{{service_name}}")],
                     unit="currencyUSD", decimals=2, calcs=["sum"],
                     keep_zeros=True), size=Size(w=12, h=8))
    d.add(cost_per_ticket_over_time(), size=Size(w=24, h=9))
    d.add(ticket_cost_table(), size=Size(w=24, h=9))
    d.add(estimate_text(), size=Size(w=24, h=10))
    cols = [("A", "Input (gross)", all_services(tok("input", by="service_name"))),
            ("B", "Cache read", all_services(tok("cache_read", by="service_name"))),
            ("C", "Uncached", all_services(uncached_input(by="service_name"))),
            ("D", "Output", all_services(tok("output", by="service_name"))),
            ("E", "Reasoning", all_services(tok("reasoning", by="service_name"))),
            ("F", "Total", all_services(total(TOKEN_USAGE, where=(totals,), by="service_name"))),
            ("G", "Turns", all_services(total(TURNS, by="service_name"))),
            ("H", "Cost", all_services(estimate(RANGE, by="service_name")))]
    token_org = organize({"service_name": "Service", **{f"Value #{r}": n for r, n, _ in cols}},
                         order=["service_name"] + [f"Value #{r}" for r, _, _ in cols], exclude=["Time"])
    token_org["options"]["excludeByName"]["Service"] = False
    token_org["options"]["excludeByName"]["service_name"] = False
    d.add(table(Copy(title="Tokens and cost by service", desc="One row per slug. Input (gross) is input as reported: gross on a host turn, net of cache reads on a "
                "cloud turn; Uncached is decided per series (input - cache_read on a gross series, the whole input on a net one). "
                + ALL_SERVICES_NOTE + " " + TURNS_CAVEAT + " " + ESTIMATE_NOTE), ds=PROM,
                targets=[prom(PromQL(expr=e), ref=r, instant=True, table=True) for r, _, e in cols],
                transforms=[{"id": "merge", "options": {}},
                            token_org],
                overrides=[{"matcher": {"id": "byName", "options": "Cost"},
                            "properties": [{"id": "unit", "value": "currencyUSD"}, {"id": "decimals", "value": 2}]},
                           field_unit(("Turns", "locale")),
                           decimals_on("Turns", n=0),
                           width("Turns", px=70),
                           min_width("Service", px=190),
                           min_width("Input (gross)", px=120),
                           min_width("Cache read", px=100),
                           min_width("Uncached", px=80),
                           {"matcher": {"id": "byName", "options": "Reasoning"},
                            "properties": [{"id": "custom.minWidth", "value": 90}, {"id": "noValue", "value": "0"}]},
                           width("Cost", px=90),
                           links_on("Service", links=[SERVICE_OPS])],
                unit="locale", footer=[n for _, n, _ in cols], no_value="No token data in range",
                sort=("Cost", True)), size=Size(w=24, h=9))
    d.row("Debug: deliveries by kind and outcome (Prometheus, approximate)", collapsed=True)
    d.add(deliveries_by_kind_table(), size=Size(w=24, h=11))
    d.add(failed_or_noop_table(), size=Size(w=24, h=11))
    d.add(deliveries_by_event_type_table(), size=Size(w=12, h=9))
    xcheck = [("A", "Metric", PROM, all_services(total(DELIVERY, by="service_name"))),
              ("B", "Delivery ids", LOKI, all_services(delivery_ids("service_name"))),
              ("C", "Factory events", LOKI, all_services(f'sum by (service_name) (count_over_time({LSEL} {HOP_TICK_DROP} {FACTORY_FIELDS} | f_event != "" [$__range]))'))]
    d.add(table(Copy(title="Cross-check per service: metric vs logs", desc="Deliveries from apj_factory_delivery_total (" + COUNT_CAVEAT + ") beside the distinct "
                "deliveryId count and the factory event lines in Loki for the same range. The three count different "
                "things (a delivery can log several factory events, and a schedule fire has a deliveryId but no factory "
                "span), so read them for agreement in shape, not equality. " + HOP_TICK_NOTE + " " + ALL_SERVICES_NOTE + " " + LOG_SHAPES_NOTE),
                ds=MIXED,
                targets=[(prom(PromQL(expr=e), ref=r, instant=True, table=True) if ds is PROM else loki(LogQL(expr=e), ref=r, instant=True)) for r, _, ds, e in xcheck],
                transforms=[{"id": "merge", "options": {}},
                            {"id": "labelsToFields", "options": {"mode": "columns"}},
                            # The Prometheus frame's value can arrive as plain "Value" beside the Loki "Value #B"/"#C".
                            organize({"service_name": "Service", "Value": xcheck[0][1], **{f"Value #{r}": n for r, n, _, _ in xcheck}},
                                     order=["service_name", "Value"] + [f"Value #{r}" for r, _, _, _ in xcheck if r != "A"],
                                     exclude=["Time", "Value #A"])],
                overrides=[links_on("Service", links=[SERVICE_OPS]),
                           min_width("Service", px=180),
                           width("Metric", px=80), width("Delivery ids", px=110),
                           width("Factory events", px=130)], unit="locale", decimals=0,
                footer=[n for _, n, _, _ in xcheck], no_value="No deliveries in range"), size=Size(w=12, h=9))

    latency_legend = {"display": "list", "placement": "bottom"}
    d.row("Debug: latency (p95 per 15 min, hosted execution heatmap)", collapsed=True)
    d.add(timeseries(Copy(title="Delivery p95 by span", desc="p95 per factory span over 15-minute windows. factory.delivery is the webhook ack; "
                     "factory.background, factory.cloud_agent.launch and reminders run seconds to minutes. " + QUANTILE_NOTE
                     + " " + TWO_WRITERS),
                     ds=PROM, targets=[prom(PromQL(expr=as_seconds(quantile(0.95, histogram=DELIVERY_DURATION, window=PROM_AHEAD, by="factory_span"))), legend="{{factory_span}}")],
                     unit="suffix: s", bars=False, interval="15m", calcs=[], legend=latency_legend,
                     points=True, log_y=True), size=Size(w=24, h=8))
    d.add(timeseries(Copy(title="Hosted HTTP p95 by service", desc=f"p95 of July's agent_sdk.http.duration per slug over 15-minute windows, platform routes ({PLATFORM_PATHS}) left out. Summed over every VM's series "
                     "(no per-instance breakdown: these buckets are 61.5% of the factory's series). " + QUANTILE_NOTE + " " + TWO_WRITERS),
                     ds=PROM, targets=[prom(PromQL(expr=as_seconds(quantile(0.95, histogram=HTTP_DURATION, window=PROM_AHEAD, where=(f'url_path!~"{PLATFORM_PATHS}"',), by="service_name"))),
                                 legend="{{service_name}}")], unit="suffix: s", bars=False, interval="15m", calcs=[],
                     legend=latency_legend, points=True), size=Size(w=12, h=9))
    d.add(timeseries(Copy(title="Hosted execution p95 by service (total)", desc="p95 of July's agent_sdk.hosted_execution.duration_ms over 15-minute windows, "
                     "phase=\"total\" only (the whole execution; the other four phases are its parts). "
                     "The metric also keeps channel_kind, delivery_surface and outcome. " + QUANTILE_NOTE),
                     ds=PROM, targets=[prom(PromQL(expr=as_seconds(quantile(0.95, histogram=EXEC_DURATION, window=PROM_AHEAD, where=('phase="total"',), by="service_name"))), legend="{{service_name}}")],
                     unit="suffix: s", decimals=0, bars=False, interval="15m", calcs=[], legend=latency_legend,
                     no_value=empty_state(EmptyState(missing="No hosted execution in range", action="Widen the time range")),
                     points=True), size=Size(w=12, h=9))
    for p95 in d.current_row["panels"][-3:]:
        p95["fieldConfig"]["defaults"]["custom"]["lineWidth"] = 2
    d.add(latency_heatmap(), size=Size(w=24, h=8))

    d.row("Debug: agent turns, tools, HTTP and KV", collapsed=True)
    d.add(timeseries(Copy(title="Turns per bucket by status", desc="Agent turns per bucket by agent_sdk.turn_status (completed, failed, or an expected-error class). " + BUCKET_NOTE),
                     ds=PROM, targets=[prom(PromQL(expr=whole(total(TURNS, window=PROM_AHEAD, by="agent_sdk_turn_status"))), legend="{{agent_sdk_turn_status}}")]), size=Size(w=12, h=10))
    d.add(timeseries(Copy(title="Tool calls per bucket by service", desc="Tool calls per bucket, stacked by slug. " + ALL_SERVICES_NOTE + " " + BUCKET_NOTE),
                     ds=PROM, targets=[prom(PromQL(expr=all_services(whole(total(TOOLS, window=PROM_AHEAD, by="service_name")))), legend="{{service_name}}")],
                     keep_zeros=True), size=Size(w=12, h=10))
    d.add(timeseries(Copy(title="Sessions per bucket by channel", desc="Sessions started per bucket by July channel (agent_sdk.channel). " + BUCKET_NOTE),
                     ds=PROM, targets=[prom(PromQL(expr=whole(total(SESSIONS, window=PROM_AHEAD, by="agent_sdk_channel"))), legend="{{agent_sdk_channel}}")]), size=Size(w=12, h=10))
    d.add(timeseries(Copy(title="Hosted executions per bucket by service", desc="agent_sdk_hosted_execution_visible_reply_total counts each hosted execution once. Its outcome "
                     "(visible reply, error, none), channel_kind and delivery_surface labels are kept; this panel "
                     "counts executions per slug, not replies. " + ALL_SERVICES_NOTE + " " + BUCKET_NOTE),
                     ds=PROM, targets=[prom(PromQL(expr=all_services(whole(total(EXECUTIONS, window=PROM_AHEAD, by="service_name")))), legend="{{service_name}}")],
                     keep_zeros=True), size=Size(w=12, h=10))
    d.add(table(Copy(title="Top tools (range)", desc="The 20 busiest tool and status pairs in range. failure is red."), ds=PROM,
                targets=[prom(PromQL(expr=f"topk(20, {total(TOOLS, by='cursor_tool_name, cursor_tool_status')})"), instant=True, table=True)],
                transforms=[organize({"cursor_tool_name": "Tool", "cursor_tool_status": "Status", "Value": "Calls"},
                                     order=["cursor_tool_name", "cursor_tool_status", "Value"], exclude=["Time"])],
                overrides=[min_width("Tool", px=200), width("Status", px=80), width("Calls", px=70),
                           value_colours("Status", mapping=[("success", "text"), ("failure", "red")])], unit="locale",
                decimals=0, footer=["Calls"], no_value="No tool calls in range", sort=("Calls", True)), size=Size(w=12, h=10))
    d.add(table(Copy(title="Reminder fire outcomes (range)", desc="July reminder fires by reason (agent_sdk_reminder_fire_outcome_total); kind and purpose labels are kept."),
                ds=PROM, targets=[prom(PromQL(expr=f"sort_desc({total(REMINDERS, by='service_name, reason')})"), instant=True, table=True)],
                transforms=[organize({"service_name": "Service", "reason": "Reason", "Value": "Fires"},
                                     order=["service_name", "reason", "Value"], exclude=["Time"])],
                overrides=[min_width("Service", px=180), min_width("Reason", px=120), width("Fires", px=70)],
                unit="locale", decimals=0, footer=["Fires"], no_value="No reminder fired in range", sort=("Fires", True)), size=Size(w=12, h=10))
    d.add(table(Copy(title="KV failures by slug, site and reason (range)", desc="apj_factory_kv_failure_total from the ops funnel (agent/lib/ops-funnel.ts; labels slug, site, reason). "
                "Bind emits a zero baseline (site=\"none\", reason=\"none\"; slug is factorySlug, or factorySlug-staging "
                "when FACTORY_ENV is staging). This table excludes that baseline (site!=\"none\"); an empty table is the "
                "normal state."), ds=PROM,
                targets=[prom(PromQL(expr=f"sort_desc({total(KV_FAILURES, where=('site!=\"none\"',), by='service_name, slug, site, reason')})"), instant=True, table=True)],
                transforms=[organize({"service_name": "Service", "slug": "Slug", "site": "Site", "reason": "Reason", "Value": "Failures"},
                                     order=["service_name", "slug", "site", "reason", "Value"], exclude=["Time"])],
                overrides=[links_on("Service", links=[SERVICE_OPS]),
                           min_width("Service", px=180), min_width("Slug", px=155), width("Site", px=60),
                           min_width("Reason", px=80), width("Failures", px=80)],
                unit="locale", decimals=0, footer=["Failures"], no_value="No KV failures in range", sort=("Failures", True)), size=Size(w=12, h=8))
    # Method is folded into Route ("POST /v1/…") so Route can take the spare
    # width at 1280 instead of clipping (r14 M3).
    http_by = "service_name, http_request_method, url_path, http_response_status_code"
    http_route = (f'label_join({total(HTTP_DURATION + "_count", by=http_by)}, '
                  '"route", " ", "http_request_method", "url_path")')
    d.add(table(Copy(title="HTTP requests by service, route and status (range)", desc="July's url.path is a route class (ids replaced by :id), shown with its method. 5xx is red, 4xx is orange; other statuses stay the theme text. " + COUNTER_NOTE),
                ds=PROM, targets=[prom(PromQL(expr=f"sort_desc({http_route})"),
                            instant=True, table=True)],
                transforms=[organize({"service_name": "Service", "route": "Route",
                                      "http_response_status_code": "Status", "Value": "Requests"},
                                     order=["service_name", "route", "http_response_status_code", "Value"],
                                     exclude=["Time", "http_request_method", "url_path"])],
                overrides=[http_status_colours("Status"), min_width("Service", px=180),
                           min_width("Route", px=225), width("Status", px=60),
                           width("Requests", px=90)],
                unit="locale", decimals=0, footer=["Requests"], no_value="No hosted HTTP requests in range",
                sort=("Requests", True)), size=Size(w=12, h=8))
    d.add(timeseries(Copy(title="HTTP requests per bucket by service and status", desc=f"July hosted HTTP requests per bucket, platform routes ({PLATFORM_PATHS}) left out. Colour is the slug, then 4xx/5xx. " + BUCKET_NOTE),
                     ds=PROM, targets=[prom(PromQL(expr=whole(total(HTTP_DURATION + "_count", window=PROM_AHEAD, where=(f'url_path!~"{PLATFORM_PATHS}"',),
                                       by="service_name, http_response_status_code"))),
                                 legend="{{service_name}} {{http_response_status_code}}")]), size=Size(w=24, h=10))

    d.row("Debug: tokens and the Loki cross-check", collapsed=True)
    d.add(timeseries(Copy(title="Tokens per bucket: uncached input, cache read, output", desc="Per bucket, stacked: uncached input (per series: input - cache_read on a gross series, the whole "
                     "input on a net one), cache read, and output, so the bar is the whole prompt plus output whatever the shape. "
                     "Reasoning is inside output and not stacked. " + TWO_SHAPES_NOTE + " " + BUCKET_NOTE),
                     ds=PROM,
                     targets=[prom(PromQL(expr=uncached_input(window=PROM_AHEAD)), legend="uncached input"),
                              prom(PromQL(expr=f"{tok('cache_read', window=PROM_AHEAD)}"), legend="cache read", ref="B"),
                              prom(PromQL(expr=f"{tok('output', window=PROM_AHEAD)}"), legend="output", ref="C")],
                     unit="short", count=False), size=Size(w=12, h=10))
    d.add(timeseries(Copy(title="Tokens per bucket by service (input + output)", desc="Input + output per bucket, stacked by slug (input as reported: gross on a host turn, net of cache reads on a cloud turn). " + ALL_SERVICES_NOTE + " " + TURNS_CAVEAT + " " + BUCKET_NOTE), ds=PROM,
                     targets=[prom(PromQL(expr=all_services(total(TOKEN_USAGE, window=PROM_AHEAD, where=(totals,), by="service_name"))), legend="{{service_name}}")],
                     unit="short", count=False, keep_zeros=True), size=Size(w=12, h=10))
    turn = f'{LSEL} | agent_sdk_event="turn.completed"'
    per_turn = [("A", "p50 in", f"quantile_over_time(0.5, {turn} | agent_sdk_usage_input_tokens != \"\" | unwrap agent_sdk_usage_input_tokens [$__range]) by (service_name)"),
                ("B", "p95 in", f"quantile_over_time(0.95, {turn} | agent_sdk_usage_input_tokens != \"\" | unwrap agent_sdk_usage_input_tokens [$__range]) by (service_name)"),
                ("C", "p50 out", f"quantile_over_time(0.5, {turn} | agent_sdk_usage_output_tokens != \"\" | unwrap agent_sdk_usage_output_tokens [$__range]) by (service_name)"),
                ("D", "p95 out", f"quantile_over_time(0.95, {turn} | agent_sdk_usage_output_tokens != \"\" | unwrap agent_sdk_usage_output_tokens [$__range]) by (service_name)"),
                ("E", "Turns", all_services(f"sum by (service_name) (count_over_time({turn} [$__range]))"))]
    d.add(table(Copy(title="Tokens per turn from turn.completed logs (range)", desc="Per-turn input and output token quantiles from July's turn.completed records (agent_sdk_usage_input_tokens, "
                "agent_sdk_usage_output_tokens). Input here is gross input (cache reads included), as in the metric. "
                + ALL_SERVICES_NOTE + " " + TURNS_CAVEAT), ds=LOKI,
                targets=[loki(LogQL(expr=e), ref=r, instant=True) for r, _, e in per_turn],
                transforms=[{"id": "merge", "options": {}},
                            {"id": "labelsToFields", "options": {"mode": "columns"}},
                            organize({"service_name": "Service", **{f"Value #{r}": n for r, n, _ in per_turn}},
                                     order=["service_name"] + [f"Value #{r}" for r, _, _ in per_turn], exclude=["Time"])],
                overrides=[links_on("Service", links=[SERVICE_OPS]),
                           min_width("Service", px=180), field_unit(("Turns", "locale")),
                           decimals_on("Turns", n=0),
                           width("p50 in", px=80), width("p95 in", px=80),
                           width("p50 out", px=80), width("p95 out", px=80),
                           width("Turns", px=55)],
                unit="short", no_value="No turn.completed records in range"), size=Size(w=12, h=9))
    check = [("A", "Logs in", all_services(f"sum by (service_name) (sum_over_time({turn} | agent_sdk_usage_input_tokens != \"\" | unwrap agent_sdk_usage_input_tokens [$__range]))"), LOKI),
             ("B", "Metric in", all_services(tok("input", by="service_name")), PROM),
             ("C", "Logs out", all_services(f"sum by (service_name) (sum_over_time({turn} | agent_sdk_usage_output_tokens != \"\" | unwrap agent_sdk_usage_output_tokens [$__range]))"), LOKI),
             ("D", "Metric out", all_services(tok("output", by="service_name")), PROM)]
    d.add(table(Copy(title="Cross-check: tokens in logs vs metric (range)", desc="The same turns counted twice: Loki's turn.completed usage vs cursor_token_usage_total. They should be close; a "
                "turn whose metrics or logs were lost when its VM was replaced (docs s.11, Loss) makes them drift. "
                + ALL_SERVICES_NOTE + " " + TURNS_CAVEAT + " The metric "
                "side: " + COUNT_CAVEAT),
                ds=MIXED,
                targets=[(loki(LogQL(expr=e), ref=r, instant=True) if ds is LOKI else prom(PromQL(expr=e), ref=r, instant=True, table=True)) for r, _, e, ds in check],
                transforms=[{"id": "merge", "options": {}},
                            {"id": "labelsToFields", "options": {"mode": "columns"}},
                            organize({"service_name": "Service", **{f"Value #{r}": n for r, n, _, _ in check}},
                                     order=["service_name"] + [f"Value #{r}" for r, _, _, _ in check], exclude=["Time"])],
                overrides=[links_on("Service", links=[SERVICE_OPS]),
                           min_width("Service", px=180), width("Logs in", px=90),
                           width("Metric in", px=95), width("Logs out", px=90),
                           width("Metric out", px=95)],
                unit="short", no_value="No token data in range"), size=Size(w=12, h=9))

    d.row("Debug: volume and raw logs", collapsed=True)
    d.add(stat(Copy(title='Err & warn', desc=f'Factory (and July) log lines at error, warn, fatal or critical level ({LEVELS_BAD}) in range, without {SLACK_PAIR} (those have their own stat under Debug: Slack SDK). Orange from 1.'), query=Query(ds=LOKI, expr=loki(LogQL(expr=f'sum(count_over_time({LSEL} | {LEVELS_BAD} {NOT_SLACK_SDK_WARN} [$__range])) or vector(0)'), instant=True)), kind='good_bad', thresholds=severity_steps(((None, 'calm'), (1, 'warn'))), no_value='0'), size=Size(w=6, h=4))
    d.add(stat(Copy(title='Turn fails (logs)', desc="July turn.failed records in range, without expected customer-state errors (July sets agent_sdk_expected_error and logs those at WARN; the Prometheus Turn fails tiles leave them out too). Red from 1."), query=Query(ds=LOKI, expr=loki(LogQL(expr=f'sum(count_over_time({LSEL} | {failed_turn} [$__range])) or vector(0)'), instant=True)), kind='good_bad', thresholds=severity_steps(((None, 'calm'), (1, 'bad'))), no_value='0'), size=Size(w=6, h=4))
    d.add(stat(Copy(title='Events', desc='Factory structured console lines (those with a factory event) in range. ' + HOP_TICK_NOTE + ' ' + LOG_SHAPES_NOTE), query=Query(ds=LOKI, expr=loki(LogQL(expr=f'sum(count_over_time({LSEL} {HOP_TICK_DROP} {FACTORY_FIELDS} | f_event != "" [$__range])) or vector(0)'), instant=True))), size=Size(w=6, h=4))
    d.add(stat(Copy(title='Log lines', desc='All factory log lines in range, every level.'), query=Query(ds=LOKI, expr=loki(LogQL(expr=f'sum(count_over_time({LSEL} [$__range])) or vector(0)'), instant=True))), size=Size(w=6, h=4))
    d.add(table(Copy(title="Factory structured events (range)", desc="Counts of factory console events by slug, event and outcome (lines with no factory event left out). "
                + HOP_TICK_NOTE + " " + LOG_SHAPES_NOTE),
                ds=LOKI, targets=[loki(LogQL(expr=f'sum by (service_name, f_event, f_outcome) (count_over_time({LSEL} {HOP_TICK_DROP} {FACTORY_FIELDS} | f_event != "" [$__range]))'), instant=True)],
                transforms=[{"id": "merge", "options": {}},
                            {"id": "labelsToFields", "options": {"mode": "columns"}},
                            organize({"service_name": "Service", "f_event": "Event", "f_outcome": "Outcome",
                                      "Value #A": "Count", "Value": "Count"},
                                     order=["service_name", "f_event", "f_outcome", "Value #A", "Value"], exclude=["Time"])],
                overrides=[links_on("Service", links=[SERVICE_OPS]),
                           min_width("Service", px=190), min_width("Event", px=200),
                           width("Outcome", px=90), width("Count", px=80)],
                unit="locale", decimals=0, footer=["Count"],
                no_value="No factory events in range", sort=("Count", True)), size=Size(w=24, h=8))
    d.add(event_table(Copy(title='Recent factory events (newest 200)', desc="Lines that carry a factory event, newest first, with their ticket, outcome, reason, PR and trace. Via and Wake are hidden (mostly empty). July's [bdk] lines (no factory event) are left out; see All factory logs. A log line's trace_id is often the inbound request's id, which Tempo holds only when Cursor sampled that request; a factory span's own Trace ID in the Tempo span tables is the one that is always sampled. " + HOP_TICK_NOTE + " " + LOG_SHAPES_NOTE), expr=f'{LSEL} {HOP_TICK_DROP} {FACTORY_FIELDS} | f_event != "" {PR_PATH}', no_value='No factory events in range', hidden=("Via", "Wake")), size=Size(w=24, h=12))
    d.add(timeseries(Copy(title="Log lines per bucket by service", desc="All log lines per bucket by slug. " + ALL_SERVICES_NOTE + " " + LOKI_BUCKET_NOTE),
                     ds=LOKI, targets=[loki(LogQL(expr=all_services(f"sum by (service_name) (count_over_time({LSEL} {rng(LOKI_AHEAD)}))")),
                                 legend="{{service_name}}", step="$bucket")]), size=Size(w=12, h=10))
    d.add(timeseries(Copy(title="July events per bucket", desc="Lines with agent_sdk_event (message.received, turn.completed, action.result, ...) per bucket. " + LOKI_BUCKET_NOTE),
                     ds=LOKI, targets=[loki(LogQL(expr=f'sum by (agent_sdk_event) (count_over_time({LSEL} | agent_sdk_event != "" {rng(LOKI_AHEAD)}))'),
                                 legend="{{agent_sdk_event}}", step="$bucket")]), size=Size(w=12, h=10))
    d.add(timeseries(Copy(title="Log lines per bucket by level", desc="All log lines per bucket by level: detected_level in lower case, "
                     "so the factory's WARN / ERROR lines and July's warn / error events share one series. " + LOKI_BUCKET_NOTE),
                     ds=LOKI, targets=[loki(LogQL(expr=f"sum by (level) (count_over_time({LSEL} {LEVEL} {rng(LOKI_AHEAD)}))"),
                                 legend="{{level}}", step="$bucket")],
                     ), size=Size(w=24, h=10))
    d.add(logs(Copy(title="All factory logs", desc="Every factory log line, filtered by the Find variable (case-insensitive regex on the body; hidden from the "
               "variable bar: set var-search=<regex> in the URL). "
               "Tagged [tag] / tag:<tag> lines are hidden here (the Tags variable lives on this panel, not the top bar). "
               "Append var-tag_lines=%5E%24 to the URL to show them. Lines are not wrapped, so a multi-line prompt stays one "
               "row; open a line (log details) for the full body and any structured metadata."),
               target=loki(LogQL(expr=f'{LSEL} !~ `$tag_lines` |~ "(?i)$search"')), no_value="No log lines match", wrap=False), size=Size(w=24, h=14))

    d.row("Debug: Tempo span tables", collapsed=True)
    any_ns = 'resource.service.namespace = "software-factory"'
    d.add(span_table(Copy(title='Ticket journey: spans', desc=TICKET_HINT + "\n\nEvery span tagged factory.ticket.key = the Ticket box above (empty means this panel stays empty), across all slugs (desk, planner, triage, worker, fixer, reviewer), newest first. Exact match. " + FACTORY_SPANS_NOTE), query=f'{{ {any_ns} && span.factory.ticket.key = "$ticket" }} | {FACTORY_SELECT}', no_value=TICKET_EMPTY, has_pr=True, limit=100, columns={'Cloud agent': 'hide', 'Reason': 'hide', 'Ticket': 'hide', 'Span ID': 'hide'}), size=Size(w=24, h=10))
    d.add(span_table(Copy(title='Recent factory spans (newest 50 traces)', desc='Factory spans with kind, outcome, ticket and PR. Start time is shown; Span opens the trace. Reason and cloud-agent ids live on the tables below. Empty Tempo frames become no-data (progress fields dropped, then merge + filterFields) so the empty-state sentence shows. ' + FACTORY_SPANS_NOTE), query=f'{{ {TSEL} && name =~ "factory[.].*" }} | {FACTORY_SELECT}', no_value=NO_FACTORY_SPANS, has_pr=True, columns={'Outcome': {'min': 80}, 'Ticket': {'width': 90}, 'Span': {'min': 170}, 'PR': {'min': 170}, 'Reason': 'hide', 'Cloud agent': 'hide', 'Span ID': 'hide'}), size=Size(w=24, h=9))
    d.add(span_table(Copy(title='Factory spans that failed or did nothing (newest 50 traces)', desc=f'factory.outcome is an error ({ERR_RE}) or a no-op ({NOOP_RE}). The Prometheus version that counts every delivery is "Deliveries that failed or did nothing" under Debug: deliveries. Empty Tempo frames become no-data (progress fields dropped, then merge + filterFields) so the empty-state sentence shows. ' + FACTORY_SPANS_NOTE), query=f'{{ {TSEL} && name =~ "factory[.].*" && span.factory.outcome =~ "{ERR_RE}|{NOOP_RE}" }} | select(resource.service.name, name, span.factory.delivery.kind, span.factory.outcome, span.factory.reason, span.error.type, span.factory.ticket.key, span.factory.pr)', no_value=NONE_GOOD, has_pr=True, columns={'Ticket': 'hide', 'PR': 'hide', 'Reason': 'hide', 'Span ID': 'hide'}), size=Size(w=24, h=8))
    d.add(span_table(Copy(title='Cloud agent launches, all outcomes (newest 50 traces)', desc="factory.cloud_agent.launch spans: the worker's implementing agent and every fixer drive, with the agent id or error.type and reason (launch_timeout, rate_limited, ...). " + FACTORY_SPANS_NOTE), query=f'{{ {TSEL} && name = "factory.cloud_agent.launch" }} | select(resource.service.name, name, span.factory.delivery.kind, span.factory.outcome, span.factory.reason, span.error.type, span.factory.cloud_agent.id, span.factory.ticket.key, span.factory.pr)', no_value=NO_FACTORY_SPANS, has_pr=True, columns={'Cloud agent': {'width': 320}, 'Span': 'hide', 'Kind': 'hide', 'Ticket': 'hide', 'PR': 'hide'}), size=Size(w=24, h=8))
    d.add(span_table(Copy(title='Recent agent_sdk.http spans (newest 50 traces)', desc="July's server span per hosted request: method and HTTP status. Path is hidden at 1280 (open the span for the raw path; the metric's url_path is the route class). Span status is omitted (always unset). Recorded only when Cursor's backend sampled the inbound request; empty means none in range."), query=f'{{ {TSEL} && name = "agent_sdk.http" && span.http.response.status_code != nil }} | select(resource.service.name, name, span.http.request.method, span.url.path, span.http.response.status_code)', no_value=NO_FACTORY_SPANS, columns={'Span': 'hide', 'Path': 'hide', 'HTTP status': {'width': 100}}), size=Size(w=24, h=9))
    d.add(span_table(Copy(title='Error spans (newest 50 traces)', desc="July and factory spans (agent_sdk.*, factory.*, MCP tools/call and tools/list) with status error; the hosted runtime's context-tracer spans are left out. July's agent_sdk.http span records exception text for a 5xx (docs s.11). HTTP status codes are on Recent agent_sdk.http spans and the HTTP table under Debug: agent turns. factory.* spans are always recorded; agent_sdk.http only when Cursor sampled the request. Span and Service name the failure; Error type is kept when Tempo returns it."), query=f'{{ {TSEL} && {OWN_SPANS} && status = error }} | select(resource.service.name, name, span.error.type)', no_value=NONE_GOOD, columns={'Error type': {'min': 100}}), size=Size(w=24, h=9))
    d.add(span_table(Copy(title='Recent turns (newest 50 traces)', desc="agent_sdk.turn spans with channel, session mode and turn id (attributes July's collector sets on the turn span). Span status (always unset) and the empty expected-error class are omitted. Token usage per turn is in the table below; a failed turn has none. A turn whose root span was lost at flush is missing (3 of 8 turns were stored in the 2026-10-03 audit hour); the turn.completed logs count every turn. A turn.completed log line's trace_id is the delivery's trace, not this one: join on conversation and turn id."), query=f'{{ {TSEL} && name = "agent_sdk.turn" }} | select(resource.service.name, name, span.agent_sdk.channel, span.agent_sdk.session_mode, span.agent_sdk.turn_id)', no_value=NO_FACTORY_SPANS, columns={'Span': 'hide'}), size=Size(w=24, h=9))
    d.add(span_table(Copy(title='Failed tool calls (newest 50 traces)', desc="agent_sdk.tool spans with cursor.tool.status = failure. Tool spans are listed even when their turn's root span was lost at flush; the Tool fails tiles count all."), query=f'{{ {TSEL} && name = "agent_sdk.tool" && span.cursor.tool.status = "failure" }} | select(resource.service.name, name, span.cursor.tool.name, span.agent_sdk.turn_id)', no_value=NONE_GOOD, columns={'Span': 'hide', 'cursor.tool.status': 'exclude', 'span.cursor.tool.status': 'exclude'}), size=Size(w=24, h=9))
    # reasoning_tokens is absent on many turns. Selecting it is safe: Tempo omits this missing attribute (an empty
    # cell), unlike http.response.status_code, which comes back as the string "nil" and panics an int column.
    usage = span_table(Copy(title='Per-turn token usage (newest 50 traces)', desc='agent_sdk.turn spans that reported usage (a failed turn has none): input as reported (gross, cache reads included, on a host turn; net of cache reads on a cloud turn), cache read, uncached input = input - cache read, floored at 0, output, and reasoning (inside output; blank when the model reports none). The Uncached column applies the gross rule only (a Grafana transform has no per-row branch), so a cloud turn, whose cache read exceeds its input, reads 0 here where its whole input is uncached; the priced panels decide per series. A turn whose root span was lost at flush is missing; totals are in the Cost row.'), query=f'{{ {TSEL} && name = "agent_sdk.turn" && span.agent_sdk.usage.input_tokens != nil }} | select(resource.service.name, name, span.agent_sdk.usage.input_tokens, span.agent_sdk.usage.cache_read_tokens, span.agent_sdk.usage.output_tokens, span.agent_sdk.usage.reasoning_tokens, span.agent_sdk.turn_id)', no_value=NO_FACTORY_SPANS, columns={'Span': 'hide', 'Turn': 'hide'})
    # After progress-drop + merge: helpers on the leftover progress frame
    # (it still has a row after the name drop) become a junk usage row.
    xf = usage["transformations"]
    merge_at = next(i for i, t in enumerate(xf) if t["id"] == "merge")
    usage["transformations"] = (
        xf[:merge_at + 1]
        + list(uncached_input_transforms(TokenFields(input="agent_sdk.usage.input_tokens",
                                                     cache_read="agent_sdk.usage.cache_read_tokens")))
        + xf[merge_at + 1:])
    usage["fieldConfig"]["overrides"].extend([
        decimals_on("Input (gross)", n=0), decimals_on("Cache read", n=0),
        decimals_on("Uncached", n=0), decimals_on("Output", n=0),
        decimals_on("Reasoning", n=0),
        field_unit(("Input (gross)", "locale")), field_unit(("Cache read", "locale")),
        field_unit(("Uncached", "locale")), field_unit(("Output", "locale")),
        field_unit(("Reasoning", "locale")),
        *[align_right(n) for n in ("Input (gross)", "Cache read", "Uncached", "Output", "Reasoning")],
    ])
    d.add(usage, size=Size(w=24, h=9))

    d.row("Debug: Slack SDK (expected)", collapsed=True)
    d.add(stat(Copy(title='Slack SDK', desc=f'Slack WebClient pair for {SLACK_SDK_WARN_CODE} and "{SLACK_SDK_SUBSCRIBE}" (about 2 per desk turn; July Stop-button noise — the factory has no agent_session_stopped channel). One shared regex both ways, not every Slack line. Split out so they do not inflate Errors.'), query=Query(ds=LOKI, expr=loki(LogQL(expr=f'sum(count_over_time({LSEL} | {LEVELS_BAD} {SLACK_SDK_WARN} [$__range])) or vector(0)'), instant=True)), kind='good_bad', thresholds=steps([(None, PALETTE["severity"]["calm"]), (1, NEUTRAL)]), no_value='0'), size=Size(w=4, h=10))
    d.add(logs(Copy(title="Slack SDK warnings", desc=f"Slack WebClient pair for {SLACK_SDK_WARN_CODE} and \"{SLACK_SDK_SUBSCRIBE}\" "
               "(about 2 per desk turn; July Stop-button noise — the factory has no agent_session_stopped channel). "
               "One shared regex both ways, not every Slack or [bdk/slack] line. "
               "Parsed-label filter so the logs panel does not highlight every line. Query filter only; the lines stay in Loki. "
               "Collapsed: this is expected noise."),
               target=loki(LogQL(expr=f"{LSEL} | {LEVELS_BAD} {SLACK_SDK_LABEL}")),
               no_value="No Slack SDK session-stopped warnings in range"), size=Size(w=20, h=10))
    return d.json()


def iter_panels(dash: dict):
    """Every non-row panel, including those inside collapsed rows."""
    for p in dash["panels"]:
        if p["type"] == "row":
            yield from p.get("panels", [])
        else:
            yield p


BUILDERS = {BUSINESS: business, OPS: ops}


def render(uid: str):
    return json.dumps(BUILDERS[uid](), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


# ------------------------------------------------------------------------------------------------
# Secret check: nothing in this folder may hold a Grafana token, a literal bearer token, an OTLP
# Basic header, or an instance UUID. Patterns are assembled so this file does not match itself.
# ------------------------------------------------------------------------------------------------
SECRET_PATTERNS = [
    ("Grafana service-account token", re.compile("gl" + "sa_[A-Za-z0-9]{8,}")),
    ("Grafana Cloud access-policy token", re.compile("gl" + "c_[A-Za-z0-9+/=]{8,}")),
    ("literal bearer token", re.compile(r"Authorization:\s*Bearer\s+[A-Za-z0-9._~+/-]{8,}=*")),
    ("OTLP Basic auth header", re.compile(r"Authorization\s*[=:]\s*Basic\s+[A-Za-z0-9+/]{8,}=*")),
    ("UUID (instance id)", re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")),
]
SKIP_DIRS = {"__pycache__", "screenshots"}


def secret_findings(root: str = HERE):
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(n for n in dirnames if n not in SKIP_DIRS)
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            try:
                with open(path, encoding="utf-8") as f:
                    body = f.read()
            except (UnicodeDecodeError, OSError):
                continue
            for label, pattern in SECRET_PATTERNS:
                for mo in pattern.finditer(body):
                    line = body.count("\n", 0, mo.start()) + 1
                    found.append(f"{os.path.relpath(path, root)}:{line}: {label}")
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="fail if a committed JSON is stale or a file holds a secret")
    args = ap.parse_args()
    rc = 0
    for uid, filename in DASHBOARD_FILES.items():
        path = os.path.join(HERE, filename)
        want = render(uid)
        if args.check:
            try:
                with open(path, encoding="utf-8") as f:
                    have = f.read()
            except FileNotFoundError:
                have = None
            if have != want:
                print(f"{filename}: stale (run python3 generate.py)", file=sys.stderr)
                rc = 1
            else:
                print(f"{filename}: up to date")
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(want)
            print(f"{filename}: {len(list(iter_panels(json.loads(want))))} panels")
    findings = secret_findings()
    for f in findings:
        print(f"secret-shaped value: {f}", file=sys.stderr)
    if findings:
        rc = 1
    elif args.check:
        print("secrets: none found")
    if args.check:
        sys.path.insert(0, os.path.join(HERE, "tools"))
        import grafana_ids
        id_findings = grafana_ids.findings([json.loads(render(uid)) for uid in DASHBOARD_FILES])
        for row in id_findings:
            print(f"grafana-id: {row}", file=sys.stderr)
        if id_findings:
            rc = 1
        else:
            print("grafana ids: ok")
    alarm_rows = palette_alarm_findings()
    for row in alarm_rows:
        print(f"palette: {row}", file=sys.stderr)
        rc = 1
    if not alarm_rows:
        print("palette: no warn/error hues outside severity groups")
    for uid, filename in DASHBOARD_FILES.items():
        dash = json.loads(render(uid))
        width_rows = check_column_width_budgets(dash)
        for row in width_rows:
            print(f"column-budget: {row}", file=sys.stderr)
            rc = 1
        if not width_rows:
            print(f"{filename}: column widths within 1280 budgets")
        dd_rows = no_dollar_dollar_findings(dash)
        for row in dd_rows:
            print(f"dollar-dollar: {row}", file=sys.stderr)
            rc = 1
        if not dd_rows:
            print(f"{filename}: no $$ in query expressions")
        guard_rows = guard_before_reducer_findings(dash)
        for row in guard_rows:
            print(f"guard-before-reducer: {row}", file=sys.stderr)
            rc = 1
        if not guard_rows:
            print(f"{filename}: no filterFields byValue ahead of a groupBy / reduce")
    return rc


if __name__ == "__main__":
    sys.exit(main())
