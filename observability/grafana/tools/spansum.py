#!/usr/bin/env python3
"""Counts the spans a TraceQL query returns, by service and span name (how much of the factory reaches Tempo).

    tools/spansum.py '{ resource.service.namespace = "software-factory" }' [--from now-1h]

GRAFANA_URL and GRAFANA_TOKEN / GRAFANA_TOKEN_FILE as in ../grafana_client.py; the token is never printed.
"""
import argparse
import collections
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from grafana_client import DATASOURCES, Grafana, TimeRange  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="Span counts by service and name for one TraceQL query.")
    ap.add_argument("query")
    ap.add_argument("--from", dest="frm", default="now-1h")
    ap.add_argument("--to", default="now")
    args = ap.parse_args()
    query = args.query
    if "select(" not in query:
        # Without a select() Tempo leaves the span name blank in a spans table.
        query += " | select(resource.service.name, name)"
    target = {"refId": "A", "datasource": DATASOURCES["tempo"], "queryType": "traceql", "query": query,
              "limit": 500, "spss": 100, "tableType": "spans"}
    code, res = Grafana().ds_query(target, span=TimeRange(frm=args.frm, to=args.to))
    result = (res.get("results") or {}).get("A", {})
    if code >= 400 or code == 0 or result.get("error"):
        print("ERROR", code, result.get("error") or res.get("message"))
        return 1
    counts, traces = collections.Counter(), set()
    for frame in result.get("frames", []):
        names = [f["name"] for f in frame["schema"]["fields"]]
        values = frame["data"]["values"]
        for i in range(max((len(v) for v in values), default=0)):
            row = {n: v[i] for n, v in zip(names, values) if i < len(v)}
            counts[(row.get("service.name") or row.get("traceService") or "?", row.get("name") or "?")] += 1
            traces.add(row.get("traceIdHidden") or row.get("traceID"))
    print(f"traces={len(traces)} spans={sum(counts.values())}")
    for (service, name), n in sorted(counts.items()):
        print(f"  {n:5} {service:28} {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
