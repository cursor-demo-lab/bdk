#!/usr/bin/env python3
"""Proves the per-series uncached-input rule (README "Two input shapes") under `promtool test rules`.

    tools/promtool_shape_check.py [--promtool PATH] [--dump]

`cursor_token_usage_total` carries two input shapes with no label to tell them apart: a host/local turn reports
provider-gross input (cache reads inside it) and a cloud turn reports input net of cache reads. generate.py's
uncached_input() decides per series, before any sum: cache_read <= input is gross (input - cache_read),
cache_read > input is net (the whole input), no cache_read series is the whole input. This test builds the
dashboard's queries exactly as generate.py does (prices at the dashboard defaults 4 / 1 / 12 / 0 USD per 1M tokens,
range 10 minutes, the (10m, 20m] fixture range of promtool_ticket_check.py) and the form the dashboards used
before (sum every host's series first, then clamp_min(input - cache_read, 0): `legacy_*` below), over one range:

- TLSSN-60, the live ticket that exposed the bug: a gross desk series (input 41,977, cache_read 39,296, output 890,
  pod desk-a) and one net planner cloud turn (input 187,541, cache_read 1,191,168, output 29,543, pod planner-a).
  Per series: planner 187,541 x 4 + 1,191,168 x 1 + 29,543 x 12 = 2.295848 USD (July billed that turn 1.127171 on
  Auto; the dashboard prices at Grok 4.6 Fast list), desk (41,977 - 39,296) x 4 + 39,296 x 1 + 890 x 12 =
  0.060700, ticket 2.356548. The legacy form summed first: clamp_min(229,518 - 1,230,464, 0) = 0 uncached, so it
  read 1.595660: the planner's 187,541 input priced at 0 and the desk's 2,681 netted away with it (0.760888 missing).
  Merged in range, so it is the one merged ticket: cost per merged ticket and the mean are 2.356548.
- TLSSN-61: a net planner series (pod planner-b) whose host RESTARTS inside the range, every series at once, as a
  real restart does: input 0 → 100,000, reset, 0 → 60,000 (true increase 160,000); cache_read 0 → 500,000, reset,
  0 → 300,000 (800,000); output 0 → 10,000, reset, 0 → 5,000 (15,000). inc() drops the exact branch on resets() > 0
  and takes increase(); each series starts the range at 0 (durationToZero = 0), so increase() extrapolates nothing
  and reads the true increase. 160,000 < 800,000 is net: 160,000 x 4 + 800,000 + 15,000 x 12 = 1.62 USD;
  legacy 0 uncached, 0.98.
- TLSSN-62: gross only (input 1,000,000, cache_read 400,000, output 100,000): (1,000,000 - 400,000) x 4 + 400,000
  + 100,000 x 12 = 4.00, the same under both forms. The rule changes nothing for a host turn.
- TLSSN-63: no cache_read series at all (input 250,000, output 50,000; the `or 0 * input` arm): 1.60 under both.
- TLSSN-64: one slug, two pods, two shapes: a gross planner pod (planner-c: input 300,000, cache_read 200,000,
  output 10,000; a turn from before #227) and a net planner pod (planner-d: input 50,000, cache_read 400,000,
  output 5,000). Per series: 100,000 x 4 + 200,000 + 120,000 = 0.72 and 50,000 x 4 + 400,000 + 60,000 = 0.66,
  ticket 1.38; legacy clamp_min(350,000 - 600,000, 0) = 0, so 0.78. `sum without (cursor_token_type)` keeps the
  pod apart; a `sum by (service_name)` first would have netted them.

The per-slug estimate (Cost by service, Tokens and cost by service), the factory-wide estimate (Spend (est.),
Cost / filed and merged, the capped ${prom_res} subquery form) and the uncached-input term read the same series.

PROMTOOL or --promtool names the binary. scripts/grafana-dashboards.test.mjs runs this when PROMTOOL is set.
"""
import argparse
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Literal, NewType

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import generate as g  # noqa: E402
import promtool_ticket_check as tc  # noqa: E402

Samples = NewType("Samples", str)
TokenKind = Literal["input", "cache_read", "output", "reasoning"]
BY_SERVICE = "service_name"


def legacy_uncached_input(*, by: str | None, window: g.Window) -> str:
    """The form before the per-series rule: every host's series summed by `by`, then clamp_min(input - cache_read, 0)."""
    gross = g.token_type("input", window=window, by=by, factory_wide=True)
    cached = g.token_type("cache_read", window=window, by=by, factory_wide=True)
    return f"clamp_min({gross} - ({cached} or 0 * {gross}), 0)"


def legacy_estimate(*, by: str | None, window: g.Window) -> str:
    terms = [(legacy_uncached_input(by=by, window=window), "$price_input", "uncached_input")] + [
        (g.token_type(kind, window=window, by=by, factory_wide=True), f"$price_{kind}", kind)
        for kind in ("cache_read", "output", "reasoning")]
    parts = " or ".join(f'label_replace({expr} * {price}, "part", "{name}", "", "")' for expr, price, name in terms)
    grouping = f" by ({by})" if by else ""
    return f"sum{grouping} ({parts}) / 1e6"


def rules() -> dict[str, str]:
    return {
        "cost_per_ticket": tc.fixed(g.cost_per_ticket()),
        "cost_per_merged_ticket": tc.fixed(g.cost_per_merged_ticket()),
        "mean_cost_per_merged_ticket": tc.fixed(g.mean_cost_per_merged_ticket()),
        "keyed_cost_per_merged_ticket": tc.fixed(g.keyed_cost_per_merged_ticket()),
        "cost_by_service": tc.fixed(g.estimate(g.RANGE_UNCAPPED, by=BY_SERVICE, factory_wide=True)),
        # The capped dashboard form (bounded() + ${prom_res} / ${smooth} subqueries): Spend (est.), Cost / filed and merged.
        "cost_factory_wide_capped": tc.fixed(g.estimate(g.RANGE, factory_wide=True)),
        "uncached_tokens": tc.fixed(g.uncached_input(factory_wide=True)),
        # Cache %: cache_read / (uncached + cache_read), per series, so it stays within 0..1; the form before it
        # (cache_read / input) passes 100% as soon as net cloud series dominate.
        "cache_share": tc.fixed(g.cache_share()),
        "legacy_cache_share": tc.fixed(g.per_unit(g.Fraction(num=f"{g.token_type('cache_read')} or vector(0)", den=g.token_type("input")))),
        # The per-ticket table on Tokens & cost (Uncached and Cache read columns; Cost is cost_per_ticket above).
        "uncached_by_ticket": tc.fixed(g.uncached_input(by=g.TICKET_KEY, where=(g.KEYED,), factory_wide=True)),
        "cache_read_by_ticket": tc.fixed(g.token_type("cache_read", by=g.TICKET_KEY, where=(g.KEYED,), factory_wide=True)),
        "legacy_cost_per_ticket": tc.fixed(legacy_estimate(by=g.TICKET_KEY, window=g.RANGE_UNCAPPED)),
        "legacy_cost_by_service": tc.fixed(legacy_estimate(by=BY_SERVICE, window=g.RANGE_UNCAPPED)),
    }


def restart_at_16(lives: tuple[int, int]) -> Samples:
    """A host restart inside the (10m, 20m] range: nothing before the range, 0 at minute 11, lives[0] through minute 15,
    0 again at minute 16 (the reset), lives[1] through minute 20. Starting each life at 0 keeps increase() exact."""
    first, second = lives
    return Samples(" ".join(["_"] * 11 + ["0"] + [str(first)] * 4 + ["0"] + [str(second)] * 4))


@dataclass(frozen=True, kw_only=True)
class Pod:
    """One hosted VM of one slug: its service_name and its instance label, so the two strings are never adjacent."""
    service: str
    name: str


def tokens(ticket: str, *, kind: TokenKind, pod: Pod, values: Samples) -> tuple[str, dict[str, str], Samples, str]:
    return (g.TOKEN_USAGE, {"cursor_token_type": kind, g.TICKET_KEY: ticket, "instance": pod.name}, values, pod.service)


def turn(ticket: str, *, pod: Pod, usage: dict[str, object], restart: bool = False) -> list:
    """One pod's series for a ticket: each token type a series born before the range at 0 and stepping to its total,
    or, with restart, restarting mid-range (usage values are then (first life, second life) totals)."""
    rows = []
    for kind, value in usage.items():
        values = restart_at_16(value) if restart else tc.flat_then((0, value))  # type: ignore[arg-type]
        rows.append(tokens(ticket, kind=kind, pod=pod, values=values))  # type: ignore[arg-type]
    return rows


DESK, PLANNER = "factory-desk", "factory-planner"
INPUTS = [
    # TLSSN-60: the live numbers. Gross desk series, net planner cloud turn, merged in range.
    *turn("TLSSN-60", pod=Pod(service=DESK, name="desk-a"), usage={"input": 41_977, "cache_read": 39_296, "output": 890}),
    *turn("TLSSN-60", pod=Pod(service=PLANNER, name="planner-a"), usage={"input": 187_541, "cache_read": 1_191_168, "output": 29_543}),
    tc.merged("TLSSN-60", values=tc.step_at_13((0, 1))),
    # TLSSN-61: net planner series, host restart inside the range (every series resets at once).
    *turn("TLSSN-61", pod=Pod(service=PLANNER, name="planner-b"), restart=True,
          usage={"input": (100_000, 60_000), "cache_read": (500_000, 300_000), "output": (10_000, 5_000)}),
    # TLSSN-62: gross only. TLSSN-63: no cache_read series.
    *turn("TLSSN-62", pod=Pod(service=DESK, name="desk-b"), usage={"input": 1_000_000, "cache_read": 400_000, "output": 100_000}),
    *turn("TLSSN-63", pod=Pod(service=DESK, name="desk-c"), usage={"input": 250_000, "output": 50_000}),
    # TLSSN-64: one slug, a gross pod and a net pod.
    *turn("TLSSN-64", pod=Pod(service=PLANNER, name="planner-c"), usage={"input": 300_000, "cache_read": 200_000, "output": 10_000}),
    *turn("TLSSN-64", pod=Pod(service=PLANNER, name="planner-d"), usage={"input": 50_000, "cache_read": 400_000, "output": 5_000}),
]

# Expected rows at minute 20 over the range (10m, 20m]: {expr: {label value or None: value}}. A label value is
# factory_ticket_key for the per-ticket records and service_name for the per-service ones.
TLSSN_60 = 2.356548
WANT = {
    "cost_per_ticket": {"TLSSN-60": TLSSN_60, "TLSSN-61": 1.62, "TLSSN-62": 4.0, "TLSSN-63": 1.6, "TLSSN-64": 1.38},
    "legacy_cost_per_ticket": {"TLSSN-60": 1.59566, "TLSSN-61": 0.98, "TLSSN-62": 4.0, "TLSSN-63": 1.6, "TLSSN-64": 0.78},
    "cost_per_merged_ticket": {"TLSSN-60": TLSSN_60},
    "mean_cost_per_merged_ticket": {None: TLSSN_60},
    # (2.356548 + 1.62 + 4.0 + 1.6 + 1.38) / 1 = 10.956548; promtool compares the exact float64 bits of the sum.
    "keyed_cost_per_merged_ticket": {None: 10.956548},
    # desk: 0.0607 + 4.0 + 1.6; planner: 2.295848 + 1.62 + 1.38. Micro-dollar parts are integers, one division at the end.
    "cost_by_service": {DESK: 5.6607, PLANNER: 5.295848},
    # Legacy planner: 697,541 input against 2,591,168 cache reads sums to 0 uncached; 2,591,168 + 59,543 x 12.
    "legacy_cost_by_service": {DESK: 5.6607, PLANNER: 3.305684},
    "cost_factory_wide_capped": {None: 10.956548},
    # 2,681 + 187,541 + 160,000 + 600,000 + 250,000 + 100,000 + 50,000.
    "uncached_tokens": {None: 1_350_222},
    # cache reads 39,296 + 1,191,168 + 800,000 + 400,000 + 200,000 + 400,000 = 3,030,464 over a prompt of
    # 1,350,222 + 3,030,464 = 4,380,686 tokens: 69.2%. The legacy form divided by input as reported (1,989,518),
    # 152%: a net cloud series' cache reads are not inside its input.
    "cache_share": {None: 3_030_464 / 4_380_686},
    "legacy_cache_share": {None: 3_030_464 / 1_989_518},
    "uncached_by_ticket": {"TLSSN-60": 190_222, "TLSSN-61": 160_000, "TLSSN-62": 600_000, "TLSSN-63": 250_000, "TLSSN-64": 150_000},
    "cache_read_by_ticket": {"TLSSN-60": 1_230_464, "TLSSN-61": 800_000, "TLSSN-62": 400_000, "TLSSN-64": 600_000},
}
LABEL_OF = {"cost_by_service": BY_SERVICE, "legacy_cost_by_service": BY_SERVICE}


def sample(row: tuple[str | None, float], *, record: str) -> str:
    key, value = row
    label = LABEL_OF.get(record, g.TICKET_KEY)
    labels = f'__name__=\\"{record}\\"' + ("" if key is None else f', {label}=\\"{key}\\"')
    return f'{{labels: "{{{labels}}}", value: {value}}}'


def test_file() -> str:
    out = "rule_files: [rules.yml]\nevaluation_interval: 1m\ntests:\n- interval: 1m\n  input_series:\n"
    out += "".join(tc.series(name, labels=labels, values=values, service=service)
                   for name, labels, values, service in INPUTS)
    out += "  promql_expr_test:\n"
    for record, rows in WANT.items():
        samples = ", ".join(sample(row, record=record) for row in rows.items())
        out += f"  - {{expr: {record}, eval_time: 20m, exp_samples: [{samples}]}}\n"
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="promtool test of the per-series uncached-input rule.")
    ap.add_argument("--promtool", default=os.environ.get("PROMTOOL", "promtool"))
    ap.add_argument("--dump", action="store_true", help="print the generated rules and test files instead of running them")
    args = ap.parse_args()
    rule_text = "groups:\n- name: shapes\n  rules:\n" + "".join(f"  - record: {name}\n    expr: '{expr}'\n" for name, expr in rules().items())
    if args.dump:
        print(rule_text)
        print(test_file())
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, "rules.yml"), "w", encoding="utf-8") as f:
            f.write(rule_text)
        with open(os.path.join(tmp, "test.yml"), "w", encoding="utf-8") as f:
            f.write(test_file())
        run = subprocess.run([args.promtool, "test", "rules", "test.yml"], cwd=tmp, capture_output=True, text=True)
    print(run.stdout + run.stderr)
    if run.returncode == 0:
        print(f"shapes: TLSSN-60 reads {TLSSN_60} per series (legacy summed-first form: {WANT['legacy_cost_per_ticket']['TLSSN-60']}); "
              f"net restart ticket {WANT['cost_per_ticket']['TLSSN-61']} (legacy {WANT['legacy_cost_per_ticket']['TLSSN-61']}); "
              "gross-only and no-cache tickets unchanged; "
              f"Cache % {WANT['cache_share'][None]:.3f} (legacy cache_read / input {WANT['legacy_cache_share'][None]:.3f})")
    return run.returncode


if __name__ == "__main__":
    sys.exit(main())
