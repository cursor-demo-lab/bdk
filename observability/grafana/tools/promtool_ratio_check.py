#!/usr/bin/env python3
"""Proves the dashboards' ratios, per-unit stats and quantiles show no result, not NaN or +Inf, when nothing happened.

    tools/promtool_ratio_check.py [--promtool PATH]

Builds ratio(), per_unit(), quantile() and whole() per-bucket exactly as generate.py does and runs them through `promtool test rules`
for three slugs: a busy one (2 of 4 deliveries failed, 400 tokens over 2 turns, 4 requests between 1 s and 2 s), a
quiet one whose series are present in range but never increment (the denominator is a present 0, and every bucket
is 0, which histogram_quantile turns into NaN), and one with no series at all. The busy slug must read 0.5, 200 and
a p95 of 1.95; the other two must have no result, which the panels render as their no-traffic text.

PROMTOOL or --promtool names the binary. scripts/grafana-dashboards.test.mjs runs this when PROMTOOL is set.
"""
import argparse
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import generate as g  # noqa: E402


def rules():
    def fixed(expr: str):
        return (expr.replace("$__range", "10m").replace("${service:pipe}", ".*")
                .replace("${prom_res}", "1m").replace("${smooth}", "2m")
                .replace(g.FROM_CAP, "600").replace(g.TO_CAP, "1200"))

    tokens = g.total("t_total", where=('kind="tok"',))
    turns = g.total("t_total", where=('kind="turn"',))
    return {
        "delivery_error_ratio": fixed(g.ratio("d_total", bad=('outcome="error"',))),
        "tokens_per_turn": fixed(g.per_unit(g.Fraction(num=tokens, den=turns))),
        "latency_p95": fixed(g.quantile(0.95, histogram="h")),
        "deliveries_per_bucket": fixed(g.whole(g.total("d_total", window=g.PROM_BUCKET)).replace("$__interval", "10m")),
    }


@dataclass(frozen=True, kw_only=True)
class SeriesKey:
    """Metric name and slug, so they are not adjacent strings."""
    name: str
    slug: str


def series(key: SeriesKey, *, labels: dict, values: str):
    extra = "".join(f',{k}="{v}"' for k, v in labels.items())
    return f"  - series: '{key.name}{{service_namespace=\"software-factory\",service_name=\"{key.slug}\"{extra}}}'\n    values: '{values}'\n"


FLAT = " ".join(["5"] * 21)
CASES = [
    ("busy", [("d_total", {"outcome": "ok"}, "0 0 0 0 0 0 0 0 0 0 0 1 1 2 2 2 2 2 2 2 2"),
              ("d_total", {"outcome": "error"}, "0 0 0 0 0 0 0 0 0 0 0 0 1 1 2 2 2 2 2 2 2"),
              ("t_total", {"kind": "turn"}, "0 0 0 0 0 0 0 0 0 0 0 1 2 2 2 2 2 2 2 2 2"),
              ("t_total", {"kind": "tok"}, "0 0 0 0 0 0 0 0 0 0 0 100 200 300 400 400 400 400 400 400 400"),
              ("h_bucket", {"le": "1"}, "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"),
              ("h_bucket", {"le": "2"}, "0 0 0 0 0 0 0 0 0 0 0 1 2 3 4 4 4 4 4 4 4"),
              ("h_bucket", {"le": "+Inf"}, "0 0 0 0 0 0 0 0 0 0 0 1 2 3 4 4 4 4 4 4 4")],
     {"delivery_error_ratio": 0.5, "tokens_per_turn": 200, "latency_p95": 1.95, "deliveries_per_bucket": 4}),
    ("quiet", [("d_total", {"outcome": "ok"}, FLAT), ("t_total", {"kind": "turn"}, FLAT), ("t_total", {"kind": "tok"}, FLAT),
               ("h_bucket", {"le": "1"}, FLAT), ("h_bucket", {"le": "2"}, FLAT), ("h_bucket", {"le": "+Inf"}, FLAT)],
     {"delivery_error_ratio": None, "tokens_per_turn": None, "latency_p95": None, "deliveries_per_bucket": 0}),
    ("absent", [("other_total", {}, FLAT)], {"delivery_error_ratio": None, "tokens_per_turn": None, "latency_p95": None, "deliveries_per_bucket": None}),
]


def test_file():
    out = "rule_files: [rules.yml]\nevaluation_interval: 1m\ntests:\n"
    for slug, inputs, want in CASES:
        out += "- interval: 1m\n  input_series:\n"
        out += "".join(series(SeriesKey(name=name, slug=slug), labels=labels, values=values) for name, labels, values in inputs)
        out += "  promql_expr_test:\n"
        for record, value in want.items():
            samples = "[]" if value is None else f'[{{labels: "{{__name__=\\"{record}\\"}}", value: {value}}}]'
            out += f"  - {{expr: {record}, eval_time: 20m, exp_samples: {samples}}}\n"
    return out


def main():
    ap = argparse.ArgumentParser(description="promtool test of the dashboards' ratio, per-unit and quantile guards.")
    ap.add_argument("--promtool", default=os.environ.get("PROMTOOL", "promtool"))
    args = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, "rules.yml"), "w", encoding="utf-8") as f:
            f.write("groups:\n- name: ratios\n  rules:\n"
                    + "".join(f"  - record: {name}\n    expr: '{expr}'\n" for name, expr in rules().items()))
        with open(os.path.join(tmp, "test.yml"), "w", encoding="utf-8") as f:
            f.write(test_file())
        run = subprocess.run([args.promtool, "test", "rules", "test.yml"], cwd=tmp, capture_output=True, text=True)
    print(run.stdout + run.stderr)
    return run.returncode


if __name__ == "__main__":
    sys.exit(main())
