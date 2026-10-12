#!/usr/bin/env python3
"""Proves per-bucket look-ahead includes the in-progress step and does not inflate it.

    tools/bucket_look_ahead_check.py --promtool PATH
    tools/bucket_look_ahead_check.py --promtool PATH --loki http://127.0.0.1:3100

Expressions come from generate.inc(..., window=Window(...)), pinned with `@`
so promtool can see later samples. Prometheus (promtool test rules), 30m of
samples, 5m step. Grafana stamps the last point at 25m when now is 30m;
promtool only sees samples up to eval_time, so last-bucket checks evaluate
at 30m with `@ 1500` (25m) on each selector. `${__from:date:seconds}` and
`${__to:date:seconds}` are replaced with unix seconds for the fixture.

- A counter goes 0 → 7 at 12m and 7 → 23 at 27m.
- The last aligned point without look-ahead covers (20m, 25m] and reads 0.
- With `offset -5m` it covers (25m, 30m] and reads 16 on a live range.
- On a range that ends at 26m the last bar is capped at $__to and reads 0
  (the 27m increment is after to); the 26m range total is 7.
- On a step-aligned live 30m range the look-ahead bucket sum equals the
  range total (23). An unaligned start (from = 2m) keeps the bar stamped
  at 0 and counts only samples at or after from (5), so the legend is 28.
- `increase()` on a slope that ends before the window reads 12.5 vs exact 10;
  look-ahead `inc()` stays on the exact branch.

Loki (optional `--loki`), real timestamps, 30m range, 5m step:

- Aligned start: 7 lines before the last aligned boundary, 16 after it.
  `count_over_time([5m])` legend sum misses the 16; `offset -5m` matches the
  30m range count (23) on that aligned range.
- Unaligned start (`last_boundary - 1800 - 120`): extra lines land between
  from and the first kept boundary; after dropping points with t < from the
  look-ahead legend is short by exactly those lines. LogQL has no subquery,
  so Loki stays uncapped at $__to (fixed range 7 vs look-ahead 23).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import generate as g  # noqa: E402


@dataclass(frozen=True, kw_only=True)
class Caps:
    """Unix-second $__from / $__to for a fixture range."""
    start: int
    end: int

SEL = 'd_total{service_namespace="software-factory",service_name="desk"}'
INC = 'i_total{service_namespace="software-factory",service_name="desk"}'
LABELS = '{service_name="desk",service_namespace="software-factory"}'
STEP = g.Window(span="5m", ahead=True)
STEP_BEHIND = g.Window(span="5m")
RANGE30 = g.Window(span="30m")


def pin(expr: str, *, at: int):
    """Append `@ at` after each range selector so promtool sees later samples.

    Skip a selector that already has `@` (the $__from baseline). promtool's
    eval_time is the range end, so `vector(time())` in the baseline would see
    that end, not the bar timestamp; rewrite those two comparisons to `vector(at)`.
    The subquery's `vector(time())` stays: it is evaluated at each inner step.
    The inner `[${smooth}]` running-max window is not pinned: it must move
    with each subquery step. Distinguisher: skip `[2m]`/`[5m]` when it is
    the bounded() inner (`) and on() (vector(time())`); baseline smooth is
    followed by `) or last_over_time`.
    """
    # Baseline is `((lookback and on() (vector(time()) >= from)) or
    # (lookback @ from and on() (vector(time()) < from)))`.
    # `) or ((` after the >= comparison is unique to that fallback (the
    # subquery uses `) and on() (vector(time()) <=`).
    expr = re.sub(
        r"vector\(time\(\)\) >= (\d+)\)\) or \(\(",
        rf"vector({at}) >= \1)) or ((",
        expr,
    )
    expr = re.sub(
        r"vector\(time\(\)\) < (\d+)\)",
        rf"vector({at}) < \1)",
        expr,
    )

    def stamp(match: re.Match[str]):
        sel = match.group(1)
        whole = match.group(0)
        if re.match(r"^\[\d+[smhd]\]$", sel):
            rest = expr[match.end():]
            if re.match(r"\) and on\(\) \(vector\(time\(\)\)", rest):
                return whole
        return whole + f" @ {at}"

    return re.sub(r"(\[[^\]]+\])(?: offset -?[^\s)]+)?(?! @)", stamp, expr)


def with_caps(expr: str, *, caps: Caps, res: str = "1m"):
    smooth = g.SMOOTH_LONG if res == "5m" else g.SMOOTH_SHORT
    return (expr.replace(g.FROM_CAP, str(caps.start)).replace(g.TO_CAP, str(caps.end))
            .replace("${prom_res}", res).replace("${smooth}", smooth))


def ahead(selector: str, *, caps: Caps, at: int | None = None, cap: bool = True, res: str = "1m"):
    expr = with_caps(g.inc(selector, window=STEP, cap=cap), caps=caps, res=res)
    return pin(expr, at=at) if at is not None else expr


def sample(value: float | str | None):
    if value is None:
        return ""
    rendered = value if isinstance(value, str) else value
    return f'    - {{labels: \'{LABELS}\', value: {rendered}}}'


U_SEL = 'u_total{service_namespace="software-factory",service_name="desk"}'
RI_TOTAL = 'ri_total{service_namespace="software-factory",service_name="desk"}'
RI_EXACT = 'ri_count{service_namespace="software-factory",service_name="desk"}'
RE_TOTAL = 're_total{service_namespace="software-factory",service_name="desk"}'
RE_EXACT = 're_count{service_namespace="software-factory",service_name="desk"}'
FS_SEL = 'fs_total{service_namespace="software-factory",service_name="desk"}'
FU_SEL = 'fu_total{service_namespace="software-factory",service_name="desk"}'
W_SEL = 'w_total{service_namespace="software-factory",service_name="desk"}'
A_SEL = 'a_total{service_namespace="software-factory",service_name="desk"}'
C_SEL = 'c_total{service_namespace="software-factory",service_name="desk"}'
D_SEL = 'dflip_total{service_namespace="software-factory",service_name="desk"}'
RF_SEL = 'rf_total{service_namespace="software-factory",service_name="desk"}'
IDLE_SEL = 'idle_total{service_namespace="software-factory",service_name="desk"}'
T10_SEL = 't10_total{service_namespace="software-factory",service_name="desk"}'
M1_SEL = 'm1_total{service_namespace="software-factory",service_name="desk"}'
SL_SEL = 'sl_total{service_namespace="software-factory",service_name="desk"}'
FL5_SEL = 'fl5_total{service_namespace="software-factory",service_name="desk"}'
RS5_SEL = 'rs5_total{service_namespace="software-factory",service_name="desk"}'
F3_SEL = 'f3_total{service_namespace="software-factory",service_name="desk"}'
STEP10 = g.Window(span="10m", ahead=True)
TO_2630 = Caps(start=0, end=1590)
FROM_1020 = Caps(start=620, end=1800)
RANGE28 = g.Window(span="28m")
RANGE_FROM90 = g.Window(span="1710s")


LIVE = Caps(start=0, end=1800)
FIXED = Caps(start=0, end=1560)
UNALIGNED = Caps(start=120, end=1800)
FROM_FIRST = Caps(start=90, end=1800)


def test_yaml():
    look = g.inc(SEL, window=STEP)
    behind = with_caps(g.inc(SEL, window=STEP_BEHIND), caps=LIVE)
    if ("${prom_res}" not in look or "${smooth}" not in look or "offset -5m" not in look
            or "min_over_time(" not in look or "vector(time())" not in look):
        raise SystemExit(f"generate.inc look-ahead drifted: {look}")
    if " < max_over_time(" in look:
        raise SystemExit(f"generate.inc still gates increase() on last<max: {look}")
    # The first-sample drop test must join per series (r14 HIGH-2): with
    # `and on()` one restarting series switched every series onto raw max.
    if " and on() (min_over_time(" in look:
        raise SystemExit(f"generate.inc drop test joins on no labels again: {look}")
    if " and (min_over_time(" not in look:
        raise SystemExit(f"generate.inc first-sample drop test missing: {look}")
    first = ahead(U_SEL, caps=UNALIGNED, at=0)
    # Baseline comparisons are rewritten to vector(at); the subquery keeps time().
    if ("and on() (vector(0) >= 120)" not in first
            or "and on() (vector(0) < 120)" not in first
            or "vector(time()) >= 120)" not in first):
        raise SystemExit(f"pin() left baseline time() at eval_time: {first}")
    deliveries = " ".join(["0"] * 12 + ["7"] * 15 + ["23"] * 4)
    # Unaligned from=2m: rise to 4 at 1m (before from, must not count), +5 at 3m,
    # then +7 at 12m and +16 at 27m. Range from 2m is 28; first bar at 0 is 5.
    unaligned = " ".join(["0"] + ["4"] * 2 + ["9"] * 9 + ["16"] * 15 + ["32"] * 4)
    # 0 until 25m, 5 at 26m, 10 at 27m, then stale: increase() extrapolates to 12.5.
    inflating = " ".join(["0"] * 26 + ["5", "10"])
    # Restart inside (25m, 30m]: +5 then drop to 2 and +8. Exact sees only max-before = 5.
    restart_inside = " ".join(["10"] * 26 + ["15", "2", "5", "8", "10"])
    # Restart at the 25m stamp (bucket edge): previous window sees the drop; this one does not.
    # Previous bucket holds 1 event (sampled at 25m); increase() reads 1.25.
    restart_edge = " ".join(["10"] * 25 + ["1", "3", "5", "7", "9", "12"])
    # Restart on the first sample of the last bucket (26m): baseline at 25m is 10,
    # subquery is 1..5 (no drop), exact clamps to 0; min < baseline takes max = 5.
    first_sample = " ".join(["10"] * 26 + ["1", "2", "3", "4", "5"])
    # from=90s, restart at 2m (first 1m inner point after from). 0m/1m stay 10.
    first_unaligned = " ".join(["10", "10"] + [str(i) for i in range(1, 30)])
    cases = [
        ("last aligned point, look-ahead", ahead(SEL, caps=LIVE, at=1500), 16),
        ("last aligned point, no look-ahead", pin(behind, at=1500), 0),
        ("bucket at 5m", ahead(SEL, caps=LIVE, at=300), 0),
        ("bucket at 10m", ahead(SEL, caps=LIVE, at=600), 7),
        ("bucket at 15m", ahead(SEL, caps=LIVE, at=900), 0),
        ("bucket at 20m", ahead(SEL, caps=LIVE, at=1200), 0),
        ("30m range, step-aligned", with_caps(g.inc(SEL, window=RANGE30), caps=LIVE), 23),
        ("exact look-ahead on a slope that ends early", ahead(INC, caps=LIVE, at=1500), 10),
        ("increase() look-ahead extrapolates", f"increase({INC}[5m] offset -5m @ 1500)", 12.5),
        ("unaligned first stamped point (kept; samples at/after from)", ahead(U_SEL, caps=UNALIGNED, at=0), 5),
        ("unaligned next point", ahead(U_SEL, caps=UNALIGNED, at=300), 0),
        ("unaligned kept 10m", ahead(U_SEL, caps=UNALIGNED, at=600), 7),
        ("unaligned kept 15m", ahead(U_SEL, caps=UNALIGNED, at=900), 0),
        ("unaligned kept 20m", ahead(U_SEL, caps=UNALIGNED, at=1200), 0),
        ("unaligned kept 25m", ahead(U_SEL, caps=UNALIGNED, at=1500), 16),
        ("unaligned 28m range includes the left-edge 5",
         with_caps(g.inc(U_SEL, window=RANGE28), caps=UNALIGNED), 28),
        # HIGH 1: a range that ends at 26m (before the 27m increment) reads 7; the last
        # look-ahead bar at 25m is capped at the last whole 1m at or before $__to
        # and reads 0. Uncapped still reads 16. `@ ${__to}` (26m) on the 10m stamp
        # reads the window at 26m, not (10m, 15m].
        ("HIGH1: 26m range ending before the 27m increment",
         pin(with_caps(g.inc(SEL, window=g.Window(span="26m")), caps=FIXED), at=1560), 7),
        ("HIGH1: live 30m range includes the 27m increment",
         with_caps(g.inc(SEL, window=RANGE30), caps=LIVE), 23),
        ("HIGH1: last bar at 25m on a 26m range is capped at to", ahead(SEL, caps=FIXED, at=1500), 0),
        ("HIGH1: last bar at 25m on a live 30m range", ahead(SEL, caps=LIVE, at=1500), 16),
        ("HIGH1: uncapped last bar still reads past to", ahead(SEL, caps=FIXED, at=1500, cap=False), 16),
        ("HIGH1: @ to pins every point (uncapped 10m stamp @ 26m)",
         pin(g.inc(SEL, window=STEP, cap=False), at=1560), 16),
        # HIGH 2: exact-only undercounts a restart inside the bucket; reset-safe inc() does not.
        ("HIGH2: exact-only undercounts a restart inside the last bucket", ahead(RI_EXACT, caps=LIVE, at=1500), 5),
        # True increment is 13 (+5 then +8); increase() leftover is 12.5.
        ("HIGH2: reset-safe look-ahead counts a restart inside the last bucket, with increase() leftover",
         ahead(RI_TOTAL, caps=LIVE, at=1500), 12.5),
        ("HIGH2: exact-only at a reset on the bucket edge", ahead(RE_EXACT, caps=LIVE, at=1500), 11),
        # Drop detected even when the new life ends at/above the old maximum.
        ("HIGH2: reset-safe at a reset on the bucket edge uses increase() leftover",
         ahead(RE_TOTAL, caps=LIVE, at=1500), 2),
        ("HIGH2: previous bucket last>=max stays exact (0 leftover)",
         ahead(RE_TOTAL, caps=LIVE, at=1200), 0),
        # First-sample restart: aligned last bar, and first inner point after unaligned from.
        ("first-sample restart, bucket-aligned last bar is max", ahead(FS_SEL, caps=LIVE, at=1500), 5),
        ("first-sample restart, unaligned from first bar is max", ahead(FU_SEL, caps=FROM_FIRST, at=0), 4),
        ("first-sample restart, unaligned from range is max since restart",
         with_caps(g.inc(FU_SEL, window=RANGE_FROM90), caps=FROM_FIRST), 29),
        # Idle > LOOKBACK then active: empty last_over_time at t >= from must
        # not fall back to at_from (that would be 10, and 104-10 = 94).
        ("idle lookback: empty last_over_time at t>=from counts from zero",
         ahead(IDLE_SEL, caps=LIVE, at=1500).replace("[1d]", "[10m]"), 104),
    ]
    out = "rule_files: [rules.yml]\nevaluation_interval: 1m\ntests:\n- interval: 1m\n  input_series:\n"
    out += f"  - series: '{SEL}'\n    values: '{deliveries}'\n"
    out += f"  - series: '{INC}'\n    values: '{inflating}'\n"
    out += f"  - series: '{U_SEL}'\n    values: '{unaligned}'\n"
    out += f"  - series: '{RI_TOTAL}'\n    values: '{restart_inside}'\n"
    out += f"  - series: '{RI_EXACT}'\n    values: '{restart_inside}'\n"
    out += f"  - series: '{RE_TOTAL}'\n    values: '{restart_edge}'\n"
    out += f"  - series: '{RE_EXACT}'\n    values: '{restart_edge}'\n"
    out += f"  - series: '{FS_SEL}'\n    values: '{first_sample}'\n"
    out += f"  - series: '{FU_SEL}'\n    values: '{first_unaligned}'\n"
    # 10, 10, 10, then idle 23m, then 100..104. LOOKBACK is rewritten to 10m.
    idle = "10 10 10 " + " ".join(["_"] * 23) + " 100 101 102 103 104"
    out += f"  - series: '{IDLE_SEL}'\n    values: '{idle}'\n"
    out += "  promql_expr_test:\n"
    for name, expr, value in cases:
        out += f"  # {name}\n"
        out += f"  - expr: '{expr}'\n    eval_time: 30m\n    exp_samples:\n{sample(value)}\n"
    out += interleaved_yaml()
    out += truncation_yaml()
    out += five_min_grid_yaml()
    out += three_min_flip_yaml()
    out += two_series_yaml()
    out += left_edge_yaml()
    out += zero_fill_yaml()
    return out


J_DESK = 'j_total{service_namespace="software-factory",service_name="desk"}'
J_PLANNER = 'j_total{service_namespace="software-factory",service_name="planner"}'
J_BOTH = 'j_total{service_namespace="software-factory"}'
RANGE25 = g.Window(span="25m")
FROM_5M = Caps(start=300, end=1800)


def two_series_yaml():
    """HIGH-2: one restarting series must not switch its neighbours onto raw max.

    Two series in one selector, window (5m, 30m]: desk climbs 1000 → 1010
    (true 10); planner was 500 before the window and restarts to a new life
    that climbs to 3 (true 3, via the first-sample raw-max branch). With the
    old `and on()` join, planner's drop put desk on the raw-max branch too and
    desk read 1010.
    """
    desk = " ".join(["1000"] * 10 + ["1010"] * 21)
    planner = " ".join(["500"] * 6 + ["1", "2"] + ["3"] * 23)
    expr = with_caps(g.inc(J_BOTH, window=RANGE25), caps=FROM_5M)
    out = "- interval: 1m\n  input_series:\n"
    out += f"  - series: '{J_DESK}'\n    values: '{desk}'\n"
    out += f"  - series: '{J_PLANNER}'\n    values: '{planner}'\n"
    out += "  promql_expr_test:\n"
    out += "  # HIGH-2: per-series drop test; desk stays exact while planner restarts\n"
    out += f"  - expr: '{expr}'\n    eval_time: 30m\n    exp_samples:\n"
    out += "    - {labels: '{service_name=\"desk\",service_namespace=\"software-factory\"}', value: 10}\n"
    out += "    - {labels: '{service_name=\"planner\",service_namespace=\"software-factory\"}', value: 3}\n"
    return out


ME_SEL = 'me_total{service_namespace="software-factory",service_name="desk"}'
MF_SEL = 'mf_total{service_namespace="software-factory",service_name="desk"}'
RANGE5 = g.Window(span="5m")


def left_edge_yaml():
    """MEDIUM-1: a restart a short window can read 0; the raw-increase edge
    branch counts it.

    5m range (25m, 30m], 1m grid, 2m smooth. me: flat 10, restart to 1 on the
    final sample. The running max hides the drop at every inner point
    (resets(smoothed)=0), exact reads 0 and the raw window has a reset, so the
    first-sample branch is blocked too; the edge branch takes increase() on
    the raw subquery (1.25, true 1; extrapolation). mf restarts just after the
    range start instead: the smoothed series still drops, so the ordinary
    increase() path already counts it (5, true 4) and the edge branch must
    stay out of its way.
    """
    me = " ".join(["10"] * 30 + ["1"])
    mf = " ".join(["10"] * 27 + ["1", "2", "3", "4"])
    out = "- interval: 1m\n  input_series:\n"
    out += f"  - series: '{ME_SEL}'\n    values: '{me}'\n"
    out += f"  - series: '{MF_SEL}'\n    values: '{mf}'\n"
    out += "  promql_expr_test:\n"
    out += "  # MEDIUM-1: restart on the last sample of a 5m range was 0; edge branch reads 1.25 (true 1)\n"
    out += f"  - expr: '{with_caps(g.inc(ME_SEL, window=RANGE5), caps=Caps(start=1500, end=1800))}'\n"
    out += f"    eval_time: 30m\n    exp_samples:\n{sample(1.25)}\n"
    out += "  # MEDIUM-1: restart just after the range start takes the increase() path (5, true 4)\n"
    out += f"  - expr: '{with_caps(g.inc(MF_SEL, window=RANGE5), caps=Caps(start=1500, end=1800))}'\n"
    out += f"    eval_time: 30m\n    exp_samples:\n{sample(5)}\n"
    return out


Z_SEL = 'z_total{service_namespace="software-factory",service_name="factory-desk"}'
IDLE_SERVICES = tuple(s for s in g.SERVICES if s != "factory-desk")


def zero_filled(selector: str, *, caps: Caps, service_regex: str = ".*"):
    inner = f"sum by (service_name) ({g.inc(selector, window=RANGE30)})"
    return (with_caps(g.all_services(inner), caps=caps)
            .replace("${service:regex}", service_regex))


def zero_fill_yaml():
    """All-six zero fill: idle slugs appear as 0, a slug with data is not doubled."""
    deliveries = " ".join(["0"] * 12 + ["7"] * 15 + ["23"] * 4)
    out = "- interval: 1m\n  input_series:\n"
    out += f"  - series: '{Z_SEL}'\n    values: '{deliveries}'\n"
    out += "  promql_expr_test:\n"
    out += "  # all-six: five idle slugs read 0, the busy one keeps its range total\n"
    out += f"  - expr: '{zero_filled(Z_SEL, caps=LIVE)}'\n    eval_time: 30m\n    exp_samples:\n"
    out += "    - {labels: '{service_name=\"factory-desk\"}', value: 23}\n"
    for slug in IDLE_SERVICES:
        out += "    - {labels: '{service_name=\"" + slug + "\"}', value: 0}\n"
    narrowed = zero_filled(Z_SEL, caps=LIVE, service_regex="factory-desk")
    out += "  # all-six: a narrowed $service never doubles the slug with data\n"
    out += f"  - expr: '{narrowed}'\n"
    out += "    eval_time: 30m\n    exp_samples:\n"
    out += "    - {labels: '{service_name=\"factory-desk\"}', value: 23}\n"
    return out


def ahead10(selector: str, *, caps: Caps, at: int, cap: bool = True):
    expr = with_caps(g.inc(selector, window=STEP10, cap=cap), caps=caps)
    return pin(expr, at=at)


def truncation_yaml():
    """10s samples: to=26m30s last inner point is 26m00s; unaligned from=10m20s."""
    # index i is t = i*10s. Increments at 610, 630, 650, 1550, 1570, 1590, 1630.
    vals = []
    for i in range(181):
        t = i * 10
        n = 0
        for stamp in (610, 630, 650, 1550, 1570, 1590, 1630):
            if t >= stamp:
                n += 1
        vals.append(str(n))
    # Last 10m bar at 20m, to=26m30s: subquery last inner eval is 26m00s, so
    # only the 25m50s increment (1). The three increments at or before to are
    # the true bucket count; the 27m10s increment is after to.
    range_2630 = with_caps(g.inc(T10_SEL, window=g.Window(span="1590s")), caps=TO_2630)
    range_2630_5m = with_caps(g.inc(T10_SEL, window=g.Window(span="1590s")), caps=TO_2630, res="5m")
    bar_25m_5m = pin(with_caps(g.inc(T10_SEL, window=g.Window(span="5m", ahead=True)),
                              caps=TO_2630, res="5m"), at=1500)
    cases = [
        ("LOW1: last 10m bar at 20m, to=26m30s reads 1 (grid 26m00s)",
         ahead10(T10_SEL, caps=TO_2630, at=1200), 1),
        ("LOW1: unaligned from=10m20s, 10m bar at 10m drops the 10m10s increment",
         ahead10(T10_SEL, caps=FROM_1020, at=600), 2),
        ("LOW1: to=26m30s range stat is 4 (same grid as the bars; true 6)",
         range_2630, 4),
        ("NIT1: 5m-grid range at to=26m30s stops at 25m00s and reads 3",
         range_2630_5m, 3),
        ("NIT1: 5m-grid last bar at 25m, to=26m30s has one inner point and is empty",
         bar_25m_5m, None),
    ]
    out = "- interval: 10s\n  input_series:\n"
    out += f"  - series: '{T10_SEL}'\n    values: '{' '.join(vals)}'\n"
    out += "  promql_expr_test:\n"
    for name, expr, value in cases:
        out += f"  # {name}\n"
        out += f"  - expr: '{expr}'\n    eval_time: 30m\n    exp_samples:\n{sample(value)}\n"
    return out


BAR_STAMPS = (0, 300, 600, 900, 1200, 1500)


def _samples_a():
    """A: 1 on even minutes, 2 on odd minutes. True increment 2."""
    # t=0 missing so the series is born inside the window.
    vals = ["_"]
    for i in range(1, 121):
        t = i * 15
        vals.append("2" if (t // 60) % 2 == 1 else "1")
    return " ".join(vals)


def _samples_c():
    """C: counter to 20, lagger (true-1) on every odd minute. True increment 20."""
    vals = ["_"]
    for i in range(1, 121):
        t = i * 15
        true = min(20, 1 + t // 90)
        vals.append(str(true - 1 if t % 120 == 60 else true))
    return " ".join(vals)


def _samples_d():
    """D: 1 on whole minutes, 2 on the other 15s ticks. True increment 2."""
    vals = ["_"]
    for i in range(1, 121):
        t = i * 15
        vals.append("1" if t % 60 == 0 else "2")
    return " ".join(vals)


def _samples_m1_restart_past_max():
    """0→10, restart at 10m15s, climb to 20. True increment 30."""
    vals = []
    for i in range(0, 121):
        t = i * 15
        if t < 615:
            vals.append(str(min(10, t // 60)))
        else:
            vals.append(str(min(20, 1 + (t - 615) // 45)))
    return " ".join(vals)


def _samples_short_vm():
    """Samples only 5m15s–7m45s, rising to 3. True increment 3."""
    vals = []
    for i in range(0, 121):
        t = i * 15
        if 315 <= t <= 465:
            vals.append(str(min(3, 1 + (t - 315) // 75)))
        else:
            vals.append("_")
    return " ".join(vals)


def _samples_3m_flip():
    """Two writers, 3-minute flips. True increment 30; 1m/2m inflates."""
    vals = ["_"]
    for i in range(1, 121):
        t = i * 15
        true = min(30, 1 + t // 60)
        vals.append(str(max(0, true - 20) if (t // 180) % 2 == 1 else true))
    return " ".join(vals)


def _samples_5m_flip():
    """Climb to 10; lagging writer 3 behind on alternate 3-minute stretches."""
    vals = ["_"]
    for i in range(1, 121):
        t = i * 15
        true = min(10, 1 + t // 180)
        vals.append(str(max(0, true - 3) if (t // 180) % 2 == 1 else true))
    return " ".join(vals)


def _samples_5m_restart():
    """Climb to 10, restart at 12m15s, climb to 15. True 25."""
    vals = []
    for i in range(0, 121):
        t = i * 15
        if t < 735:
            vals.append(str(min(10, t // 72)))
        else:
            vals.append(str(min(15, 1 + (t - 735) // 72)))
    return " ".join(vals)


def _samples_restart_flip():
    """Climb to 10 with 1-off flips, restart at 12m, climb to 8. True 18."""
    vals = ["_"]
    for i in range(1, 121):
        t = i * 15
        if t <= 720:
            true = min(10, 1 + t // 72)
        else:
            true = min(8, 1 + (t - 720) // 90)
        vals.append(str(true - 1 if t % 120 == 60 else true))
    return " ".join(vals)


def five_min_grid_yaml():
    """5m subquery step + 5m smooth: short-lived VM, flip, restart."""
    series = [
        (SL_SEL, _samples_short_vm(), "short-vm", 3),
        (FL5_SEL, _samples_5m_flip(), "5m-flip", 10),
        (RS5_SEL, _samples_5m_restart(), "5m-restart", 25),
    ]
    out = "- interval: 15s\n  input_series:\n"
    for sel, values, _, _ in series:
        out += f"  - series: '{sel}'\n    values: '{values}'\n"
    out += "  promql_expr_test:\n"
    for sel, _, name, true in series:
        out += f"  # HIGH1 5m-grid {name}: range\n"
        out += f"  - expr: '{with_caps(g.inc(sel, window=RANGE30), caps=LIVE, res='5m')}'\n"
        out += f"    eval_time: 30m\n    exp_samples:\n{sample(true)}\n"
        for i, at in enumerate(BAR_STAMPS):
            expect = FIVE_MIN_BAR_EXPECT[name][i]
            out += f"  # HIGH1 5m-grid {name}: bar {i} at {at}s\n"
            out += f"  - expr: '{ahead(sel, caps=LIVE, at=at, res='5m')}'\n"
            out += f"    eval_time: 30m\n    exp_samples:\n{sample(expect)}\n"
    return out


def three_min_flip_yaml():
    """1m/2m on 3-minute writer flips: bars and range both inflate vs true 30."""
    values = _samples_3m_flip()
    out = "- interval: 15s\n  input_series:\n"
    out += f"  - series: '{F3_SEL}'\n    values: '{values}'\n"
    out += "  promql_expr_test:\n"
    out += "  # MEDIUM-1 3m-flip 1m/2m: range (inflated; true 30)\n"
    out += f"  - expr: '{with_caps(g.inc(F3_SEL, window=RANGE30), caps=LIVE)}'\n"
    out += f"    eval_time: 30m\n    exp_samples:\n{sample(THREE_MIN_FLIP_RANGE)}\n"
    for i, at in enumerate(BAR_STAMPS):
        expect = THREE_MIN_FLIP_BARS[i]
        out += f"  # MEDIUM-1 3m-flip 1m/2m: bar {i} at {at}s\n"
        out += f"  - expr: '{ahead(F3_SEL, caps=LIVE, at=at)}'\n"
        out += f"    eval_time: 30m\n    exp_samples:\n{sample(expect)}\n"
    return out


# Locked after promtool at 1m/2m. True increment is 30; increase() leftover
# from flips longer than ${smooth} inflates both the range and the bars.
THREE_MIN_FLIP_RANGE = 105
THREE_MIN_FLIP_BARS = (1.25, 9, 6, 26.25, 26, 37.5)
if THREE_MIN_FLIP_RANGE == 30 or abs(sum(THREE_MIN_FLIP_BARS) - 30) < 1e-9:
    raise SystemExit("3m-flip fixture must stay inflated versus true 30")


# Locked after promtool: 5m step + 5m smooth. short-vm lives 5m15s–7m45s
# (true 3): the 10m bar sees it; a 2m window on that 5m grid is empty.
FIVE_MIN_BAR_EXPECT = {
    "short-vm": (None, 3, None, None, None, None),
    "5m-flip": (1, 2, 2, 2, 2, 1),
    "5m-restart": (4, 4, 3, 0, 4, 4),
}


def interleaved_yaml():
    """Fixtures A, C, D: range = bar sum = true value at 1m / 2m-smooth.

    Restart+flip takes increase() leftover (range ≠ bar sum ≠ true 18).
    M1: restart whose new life passes the old max; drop is resets()>0.
    Bar expected values are locked after promtool (see FLIP_BAR_EXPECT).
    """
    series = [
        (A_SEL, _samples_a(), "A", 2),
        (C_SEL, _samples_c(), "C", 20),
        (D_SEL, _samples_d(), "D", 2),
        (RF_SEL, _samples_restart_flip(), "restart+flip", 17.586206896551726),
        (M1_SEL, _samples_m1_restart_past_max(), "M1-restart-past-max", "3.0000000000000004e+01"),
        # Raw increase() on D still counts every flip (locked so the 2m smooth
        # is the thing that makes D's range 2).
        (W_SEL, _samples_d(), "raw-increase-D", None),
    ]
    out = "- interval: 15s\n  input_series:\n"
    for sel, values, _, _ in series:
        out += f"  - series: '{sel}'\n    values: '{values}'\n"
    out += "  promql_expr_test:\n"
    for sel, _, name, true in series:
        if true is None:
            raw = f"increase({sel}[30m])"
            out += "  # D raw increase() counts every flip (not the series max)\n"
            out += f"  - expr: '{raw}'\n    eval_time: 30m\n    exp_samples:\n{sample(FLIP_RAW_INCREASE_D)}\n"
            continue
        out += f"  # {name}: range = {true}\n"
        out += f"  - expr: '{with_caps(g.inc(sel, window=RANGE30), caps=LIVE)}'\n"
        out += f"    eval_time: 30m\n    exp_samples:\n{sample(true)}\n"
        for i, at in enumerate(BAR_STAMPS):
            expect = FLIP_BAR_EXPECT[name][i]
            out += f"  # {name}: bar {i} at {at}s\n"
            out += f"  - expr: '{ahead(sel, caps=LIVE, at=at)}'\n"
            out += f"    eval_time: 30m\n    exp_samples:\n{sample(expect)}\n"
    return out


# Locked after promtool (2m smooth + resets()>0). A/C/D bars sum to the true
# increment. restart+flip takes increase() leftover (range 17.586, bars 18.75).
# M1 bar sum is locked after the first promtool run.
FLIP_BAR_EXPECT = {
    "A": (2, 0, 0, 0, 0, 0),
    "C": (4, 3, 3, 4, 3, 3),
    "D": (2, 0, 0, 0, 0, 0),
    "restart+flip": (4, 5, 3.75, 4, 2, 0),
    "M1-restart-past-max": (5, 5, 7, 7, 6, 0),
}
FLIP_RAW_INCREASE_D = 59.49579831932773
FLIP_BAR_SUM = {"A": 2, "C": 20, "D": 2, "restart+flip": 18.75, "M1-restart-past-max": 30}
for _name, _bars in FLIP_BAR_EXPECT.items():
    _true = FLIP_BAR_SUM[_name]
    if abs(sum(_bars) - _true) > 1e-9:
        raise SystemExit(f"{_name}: bar sum {sum(_bars)} != locked {_true}")


def run_promtool(promtool: str):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "test.yml")
        with open(os.path.join(tmp, "rules.yml"), "w", encoding="utf-8") as f:
            f.write("groups:\n- name: look_ahead\n  rules:\n  - record: keep\n    expr: vector(1)\n")
        with open(path, "w", encoding="utf-8") as f:
            f.write(test_yaml())
        run = subprocess.run([promtool, "test", "rules", path], cwd=tmp, capture_output=True, text=True)
    print(run.stdout + run.stderr)
    if run.returncode != 0:
        return run.returncode
    print("promtool: last aligned point (25m) reads 16 with look-ahead, 0 without; "
          "aligned live 30m = 23 and last bar 16; fixed 26m range (ends before the 27m "
          "increment) = 7 and that same last bar is capped at to and reads 0; "
          "uncapped last bar still reads 16; @ 26m on the uncapped 10m stamp also reads 16; "
          "unaligned from=2m keeps the bar at 0 = 5 (rise before from is excluded) "
          "and 5+0+7+0+0+16 = 28 equals the 28m range; "
          "increase() offset -5m reads 12.5 vs exact 10; "
          "restart inside last bucket: exact 5, reset-safe increase() leftover 12.5 (true 13); "
          "restart at 25m edge: last>=max so exact 2, previous bucket 0 leftover; "
          "first-sample restart aligned last bar = 5; unaligned from first bar = 4 "
          "and range = 29; fixtures A/C/D have range = bar sum = true; "
          "restart+flip leftover range 17.59 bars 18.75 true 18; "
          "M1 restart-past-max range ≈30; 5m-grid short-lived VM reads 3; "
          "3m-flip 1m/2m range 105 bars 106 vs true 30; "
          "two-series restart: desk stays 10 while planner restarts to 3 (per-series and); "
          "left-edge restart on a 5m range reads 1.25 via raw increase() (was 0); "
          "all-six zero fill lists idle slugs at 0 and never doubles a busy slug")
    return 0


def loki_request(endpoint: str, *, data: bytes | None = None, params: dict | None = None,
                 method: str | None = None):
    q = f"?{urllib.parse.urlencode(params)}" if params else ""
    req = urllib.request.Request(endpoint + q, data=data, method=method or ("POST" if data else "GET"))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        if not raw:
            return None
        return json.loads(raw)


def summed(payload: dict, *, since: float | None = None):
    total = 0
    points = []
    for series in payload.get("data", {}).get("result", []):
        for ts, val in series.get("values", []):
            t = float(ts)
            if since is not None and t < since:
                continue
            n = float(val)
            points.append((t, n))
            total += n
    return total, points


def run_loki(url: str):
    now = time.time()
    step = 300
    last_boundary = int(now // step * step)
    start_aligned = last_boundary - 1800
    start_unaligned = last_boundary - 1800 - 120
    aligned_end = last_boundary
    stat_time = last_boundary + 180
    early = last_boundary - 120
    late = last_boundary + 60
    left_edge = last_boundary - 1800 - 60
    aligned_job = f"bucket-look-ahead-{int(now)}"
    unaligned_job = f"bucket-look-ahead-unaligned-{int(now)}"
    aligned_values = [[str(int(early * 1e9)), f"early {i}"] for i in range(7)]
    aligned_values += [[str(int(late * 1e9)), f"late {i}"] for i in range(16)]
    unaligned_values = [[str(int(left_edge * 1e9)), f"left {i}"] for i in range(5)]
    unaligned_values += aligned_values
    for job, values in ((aligned_job, aligned_values), (unaligned_job, unaligned_values)):
        loki_request(url.rstrip("/") + "/loki/api/v1/push",
                     data=json.dumps({"streams": [{"stream": {"job": job, "service_namespace": "software-factory"},
                                                   "values": values}]}).encode())
    aligned_sel = '{job="' + aligned_job + '"}'
    unaligned_sel = '{job="' + unaligned_job + '"}'
    loki_ahead = g.rng(g.Window(span="5m", ahead=True))
    look_a = f"sum(count_over_time({aligned_sel}{loki_ahead}))"
    behind_q = f"sum(count_over_time({aligned_sel}{g.rng(g.Window(span='5m'))}))"
    look_u = f"sum(count_over_time({unaligned_sel}{loki_ahead}))"
    aligned = {
        "start": str(int(start_aligned * 1e9)),
        "end": str(int(aligned_end * 1e9)),
        "step": str(step),
    }
    # Loki 3.5 aligns the start to the step; Time ≥ from then drops the first stamped point.
    unaligned_query = {
        "start": str(int(start_unaligned * 1e9)),
        "end": str(int(aligned_end * 1e9)),
        "step": str(step),
    }
    behind = loki_request(url.rstrip("/") + "/loki/api/v1/query_range", params={**aligned, "query": behind_q})
    ahead = loki_request(url.rstrip("/") + "/loki/api/v1/query_range", params={**aligned, "query": look_a})
    unaligned = loki_request(url.rstrip("/") + "/loki/api/v1/query_range", params={**unaligned_query, "query": look_u})
    instant = loki_request(url.rstrip("/") + "/loki/api/v1/query", params={
        "query": f"sum(count_over_time({aligned_sel}[30m]))",
        "time": str(stat_time),
    })
    unaligned_range = loki_request(url.rstrip("/") + "/loki/api/v1/query", params={
        "query": f"sum(count_over_time({unaligned_sel}[{int(stat_time - start_unaligned)}s]))",
        "time": str(stat_time),
    })

    behind_sum, behind_pts = summed(behind)
    ahead_sum, ahead_pts = summed(ahead)
    unaligned_all, unaligned_pts = summed(unaligned)
    unaligned_kept, _ = summed(unaligned, since=start_unaligned)
    inst = instant.get("data", {}).get("result", [])
    range_count = float(inst[0]["value"][1]) if inst else 0
    uinst = unaligned_range.get("data", {}).get("result", [])
    unaligned_range_count = float(uinst[0]["value"][1]) if uinst else 0
    print(f"loki behind sum={behind_sum} points={behind_pts}")
    print(f"loki ahead  sum={ahead_sum} points={ahead_pts}")
    print(f"loki range  count={range_count}")
    print(f"loki unaligned raw={unaligned_all} kept(t≥from)={unaligned_kept} range={unaligned_range_count} points={unaligned_pts}")
    if behind_sum != 7:
        print(f"loki: unshifted legend sum {behind_sum} want 7 (only lines before the last boundary)", file=sys.stderr)
        return 1
    if ahead_sum != range_count or range_count != 23:
        print(f"loki: aligned look-ahead sum {ahead_sum} != range {range_count} (want 23)", file=sys.stderr)
        return 1
    if unaligned_range_count != 28:
        print(f"loki: unaligned range {unaligned_range_count} want 28", file=sys.stderr)
        return 1
    if unaligned_kept != unaligned_range_count - 5:
        print(f"loki: unaligned kept {unaligned_kept} want range-5={unaligned_range_count - 5}", file=sys.stderr)
        return 1
    # HIGH 1: Loki has no subquery, so a range that ends at last_boundary (before
    # the late lines) still has those 16 events in the last look-ahead bar.
    fixed_range = loki_request(url.rstrip("/") + "/loki/api/v1/query", params={
        "query": f"sum(count_over_time({aligned_sel}[{int(last_boundary - start_aligned)}s]))",
        "time": str(last_boundary),
    })
    finst = fixed_range.get("data", {}).get("result", [])
    fixed_count = float(finst[0]["value"][1]) if finst else 0
    print(f"loki HIGH1 fixed-range-at-boundary count={fixed_count} look-ahead-legend={ahead_sum}")
    if fixed_count != 7:
        print(f"loki HIGH1: range ending at last_boundary {fixed_count} want 7", file=sys.stderr)
        return 1
    if ahead_sum != 23:
        print(f"loki HIGH1: look-ahead legend {ahead_sum} still includes the 16 lines after to", file=sys.stderr)
        return 1
    print("loki: on a step-aligned live range the look-ahead legend sum equals the 30m count; "
          "on an unaligned start the legend is short by the 5 events before the first kept boundary; "
          "on a range that ends before now the last bar still covers its whole bucket (HIGH 1)")
    return 0


def main():
    ap = argparse.ArgumentParser(description="promtool + optional Loki proof that look-ahead includes the in-progress bucket.")
    ap.add_argument("--promtool", default=os.environ.get("PROMTOOL", "promtool"))
    ap.add_argument("--loki", default=os.environ.get("FACTORY_LOKI_URL") or os.environ.get("LOKI_URL"))
    args = ap.parse_args()
    rc = run_promtool(args.promtool)
    if rc != 0:
        return rc
    if args.loki:
        try:
            return run_loki(args.loki)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            print(f"loki check failed: {err}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
