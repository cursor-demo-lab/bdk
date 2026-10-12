#!/usr/bin/env python3
"""Proves the README's per-ticket cost queries under `promtool test rules`.

    tools/promtool_ticket_check.py [--promtool PATH]

Builds cost_per_ticket(), merged_tickets(), cost_per_merged_ticket(), mean_cost_per_merged_ticket() and
keyed_cost_per_merged_ticket() exactly as generate.py does (prices fixed at the dashboard defaults 4 / 1 / 12 / 0 USD
per 1M tokens, the range at 10 minutes), plus the widened-cost-window pair the Cost per ticket (est.) panel uses
(merge window 5m, cost window 10m here; 24h and 7d on the panel), and runs them over one range holding every shape
the queries must handle:

- TLSSN-1: input, cache reads and output all in range, merged in range with a counter increment (0 before the
  range, 1 in it: the increase() arm). Priced (1,000,000 - 400,000) x 4 + 400,000 x 1 + 100,000 x 12 = 4.00 USD;
  4.00 per merged ticket.
- TLSSN-2: a ticket whose token series are new in range (no sample before it: the `or max_over_time` fallback
  counts it from zero) and that has no cache_read series at all (the `or 0 * input` path keeps its whole input).
  1.60 USD; not merged, so no per-merged row.
- TLSSN-3: input counted from a non-zero value before the range (300,000 - 100,000), a cache_read series present
  but flat (a 0 that is subtracted, not a missing term), and merged BEFORE the range: its merged series is present
  and flat through the whole range, so neither the increase() arm nor the first-appearance arm counts it. 0.80 USD;
  no per-merged row.
- TLSSN-4: input only, merged in range and counted TWICE by the worker (a `ticket-merged/<KEY>` marker it could
  not read, or a lost read-then-put race). 2.00 USD; 2.00 per merged ticket, not 1.00: merged_tickets() pins a
  key's row at exactly 1 (`* 0 + 1`), so the double count neither halves the ticket's cost nor adds a ticket to
  the keyed denominator.
- TLSSN-5: the live shape that broke increase()-only counting, plus the widened cost window. Its merged series
  FIRST APPEARS inside the range, already at 1 (the series is created on the worker's first increment, and
  increase()/rate() cannot see the jump from "no series" to 1: there is no earlier point to diff against), so only
  the first-appearance arm (`last_over_time ... unless ... offset`) counts it. Its cost accrues on TWO hosts
  (factory-desk 500,000 and factory-planner 250,000 input: 3.00 USD summed, no $service filter) EARLY in the
  range, days before the merge in panel terms: with the narrow 5m merge window as the cost window the cost reads
  0, with the 10m cost window the full 3.00 is counted.
- none: the unattributed remainder, counted from a non-zero value before the range. 1.56 USD; never merged.
- other: a pin that was not a Jira key; its merged count is excluded from the denominator (KEYED). 0.04 USD.
- an unlabelled series (no factory_ticket_key: a host from before the label): its own row, 0.20 USD, no key.

So over the 10m range three tickets merged (TLSSN-1, TLSSN-4, TLSSN-5): the true mean is
(4.00 + 2.00 + 3.00) / 3 = 3.00 and the keyed figure (4.00 + 1.60 + 0.80 + 2.00 + 3.00) / 3 = 3.80: different
numbers, which is why the README names them differently. Without the `* 0 + 1` pin the double-counted TLSSN-4
would show at half its cost (mean 2.67, keyed denominator 4 and figure 2.85). Over the narrow 5m merge window
only TLSSN-5 merged: its cost is 0.00 with the 5m cost window and 3.00 with the 10m one (the widened pair).

PROMTOOL or --promtool names the binary. scripts/grafana-dashboards.test.mjs runs this when PROMTOOL is set.
"""
import argparse
import os
import subprocess
import sys
import tempfile
from typing import Literal, NewType

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import generate as g  # noqa: E402

PRICES = {"$price_input": "4", "$price_cache_read": "1", "$price_output": "12", "$price_reasoning": "0"}

MERGE_NARROW = g.Window(span="5m", cap=False)
COST_WIDE = "10m"


def fixed(expr: str) -> str:
    """Pin every dashboard variable for the (10m, 20m] fixture range: counters
    are capped subqueries (bounded() + ${prom_res}/${smooth}), so the caps and
    grid variables must be substituted exactly as Grafana would."""
    expr = (expr.replace("$__range", "10m")
            .replace("${service:pipe}", ".*").replace("${service:regex}", ".*")
            .replace("${__from:date:seconds}", "600").replace("${__to:date:seconds}", "1200")
            .replace("${prom_res}", "1m").replace("${smooth}", "2m"))
    for name, value in PRICES.items():
        expr = expr.replace(name, value)
    return expr


def rules():
    return {
        "cost_per_ticket": fixed(g.cost_per_ticket()),
        "merged_tickets": fixed(g.merged_tickets()),
        "cost_per_merged_ticket": fixed(g.cost_per_merged_ticket()),
        "mean_cost_per_merged_ticket": fixed(g.mean_cost_per_merged_ticket()),
        "keyed_cost_per_merged_ticket": fixed(g.keyed_cost_per_merged_ticket()),
        # The panel's widened pair: merges in a narrow window, cost over a wider one (24h / 7d on the panel).
        "merged_tickets_narrow": fixed(g.merged_tickets(MERGE_NARROW)),
        "cost_per_merged_ticket_narrow": fixed(g.cost_per_merged_ticket(MERGE_NARROW)),
        "cost_per_merged_ticket_widened": fixed(g.cost_per_merged_ticket(MERGE_NARROW, cost_window=COST_WIDE)),
        "mean_cost_per_merged_ticket_widened": fixed(g.mean_cost_per_merged_ticket(MERGE_NARROW, cost_window=COST_WIDE)),
    }


def series(name: str, *, labels: dict[str, str], values: "Samples", service: str = "factory-desk") -> str:
    extra = "".join(f',{k}="{v}"' for k, v in labels.items())
    return f"  - series: '{name}{{service_namespace=\"software-factory\",service_name=\"{service}\"{extra}}}'\n    values: '{values}'\n"


# A promtool `values` string, and the token types July reports: distinct types so no two adjacent parameters share one.
Samples = NewType("Samples", str)
TokenKind = Literal["input", "cache_read", "output", "reasoning"]


def flat_then(levels: tuple[int, int]) -> Samples:
    """21 one-minute samples: levels[0] (before) up to and including minute 10 (the last sample before the range), levels[1] (after) from minute 11."""
    before, after = levels
    return Samples(" ".join([str(before)] * 11 + [str(after)] * 10))


def born_at_12(value: int) -> Samples:
    """A series whose first sample is at minute 12: nothing before the range for last_over_time to find."""
    return Samples(" ".join(["_"] * 12 + [str(value)] * 9))


def born_at_18(value: int) -> Samples:
    """A series whose first sample is at minute 18: inside even the narrow (15m, 20m] merge window."""
    return Samples(" ".join(["_"] * 18 + [str(value)] * 3))


def step_at_13(levels: tuple[int, int]) -> Samples:
    """A counter that steps inside the (10m, 20m] range (minute 13), with samples on both sides of the step:
    the shape increase() sees. The range selector excludes its left boundary, so a step at minute 11 against a
    minute-10 baseline would be invisible to increase() with 1m fixture samples (real scrapes are 15s)."""
    before, after = levels
    return Samples(" ".join([str(before)] * 13 + [str(after)] * 8))


def tokens(ticket: str | None, *, kind: TokenKind, values: Samples, service: str = "factory-desk") -> tuple[str, dict[str, str], Samples, str]:
    labels = {"cursor_token_type": kind}
    if ticket is not None:
        labels[g.TICKET_KEY] = ticket
    return (g.TOKEN_USAGE, labels, values, service)


def merged(ticket: str, *, values: Samples) -> tuple[str, dict[str, str], Samples, str]:
    return (g.TICKET_MERGED, {g.TICKET_KEY: ticket}, values, "factory-worker")


INPUTS = [
    tokens("TLSSN-1", kind="input", values=flat_then((0, 1_000_000))),
    tokens("TLSSN-1", kind="cache_read", values=flat_then((0, 400_000))),
    tokens("TLSSN-1", kind="output", values=flat_then((0, 100_000))),
    merged("TLSSN-1", values=step_at_13((0, 1))),
    tokens("TLSSN-2", kind="input", values=born_at_12(250_000)),
    tokens("TLSSN-2", kind="output", values=born_at_12(50_000)),
    tokens("TLSSN-3", kind="input", values=flat_then((100_000, 300_000))),
    tokens("TLSSN-3", kind="cache_read", values=flat_then((50_000, 50_000))),
    merged("TLSSN-3", values=flat_then((1, 1))),
    tokens("TLSSN-4", kind="input", values=flat_then((0, 500_000))),
    merged("TLSSN-4", values=step_at_13((0, 2))),
    # TLSSN-5: cost on two hosts early in the range; the merged series first appears at minute 18, already 1.
    tokens("TLSSN-5", kind="input", values=born_at_12(500_000)),
    tokens("TLSSN-5", kind="input", values=born_at_12(250_000), service="factory-planner"),
    merged("TLSSN-5", values=born_at_18(1)),
    tokens("none", kind="input", values=flat_then((100_000, 400_000))),
    tokens("none", kind="output", values=flat_then((0, 30_000))),
    tokens("other", kind="input", values=flat_then((0, 10_000))),
    merged("other", values=step_at_13((0, 1))),
    tokens(None, kind="input", values=flat_then((0, 50_000))),
]

# Expected rows at minute 20 over the range (10m, 20m]: {ticket label or None: value}.
WANT = {
    "cost_per_ticket": {"TLSSN-1": 4.0, "TLSSN-2": 1.6, "TLSSN-3": 0.8, "TLSSN-4": 2.0, "TLSSN-5": 3.0,
                        "none": 1.56, "other": 0.04, None: 0.2},
    "merged_tickets": {"TLSSN-1": 1, "TLSSN-4": 1, "TLSSN-5": 1},
    "cost_per_merged_ticket": {"TLSSN-1": 4.0, "TLSSN-4": 2.0, "TLSSN-5": 3.0},
    "mean_cost_per_merged_ticket": {None: 3.0},
    # 11.4 / 3 in float64: promtool compares the exact bits, so the expectation carries the rounding.
    "keyed_cost_per_merged_ticket": {None: 3.8000000000000003},
    # Narrow (15m, 20m] merge window: only TLSSN-5 merged there (TLSSN-1 and TLSSN-4 merged earlier and are flat
    # through it; TLSSN-5's series is born inside it). Its cost accrued at minute 12, before that window: the
    # narrow cost window reads 0.00, the widened 10m cost window the full 3.00.
    "merged_tickets_narrow": {"TLSSN-5": 1},
    "cost_per_merged_ticket_narrow": {"TLSSN-5": 0.0},
    "cost_per_merged_ticket_widened": {"TLSSN-5": 3.0},
    "mean_cost_per_merged_ticket_widened": {None: 3.0},
}


def sample(row: tuple[str | None, float], *, record: str) -> str:
    ticket, value = row
    labels = f'__name__=\\"{record}\\"' + ("" if ticket is None else f', {g.TICKET_KEY}=\\"{ticket}\\"')
    return f'{{labels: "{{{labels}}}", value: {value}}}'


def test_file():
    out = "rule_files: [rules.yml]\nevaluation_interval: 1m\ntests:\n- interval: 1m\n  input_series:\n"
    out += "".join(series(name, labels=labels, values=values, service=service)
                   for name, labels, values, service in INPUTS)
    out += "  promql_expr_test:\n"
    for record, rows in WANT.items():
        samples = ", ".join(sample(row, record=record) for row in rows.items())
        out += f"  - {{expr: {record}, eval_time: 20m, exp_samples: [{samples}]}}\n"
    return out


def main():
    ap = argparse.ArgumentParser(description="promtool test of the README's per-ticket cost queries.")
    ap.add_argument("--promtool", default=os.environ.get("PROMTOOL", "promtool"))
    ap.add_argument("--dump", action="store_true", help="print the generated rules and test files instead of running them")
    args = ap.parse_args()
    rule_text = "groups:\n- name: tickets\n  rules:\n" + "".join(f"  - record: {name}\n    expr: '{expr}'\n" for name, expr in rules().items())
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
    return run.returncode


if __name__ == "__main__":
    sys.exit(main())
