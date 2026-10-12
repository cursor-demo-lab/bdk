#!/usr/bin/env python3
"""One raw query through Grafana's /api/ds/query, to check a signal before putting it on a panel.

    tools/rawcheck.py prom  '<promql>'   [--from now-1h]          instant query; prints each series
    tools/rawcheck.py loki  '<logql>'    [--from now-1h] [--max 30]
    tools/rawcheck.py tempo '<traceql>'  [--from now-1h] [--max 30] [--spans]

GRAFANA_URL and GRAFANA_TOKEN / GRAFANA_TOKEN_FILE as in ../grafana_client.py; the token is never printed.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from grafana_client import DATASOURCES, Grafana, TimeRange  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="One raw Prometheus, Loki or Tempo query through Grafana.")
    ap.add_argument("kind", choices=sorted(DATASOURCES))
    ap.add_argument("query")
    ap.add_argument("--from", dest="frm", default="now-1h")
    ap.add_argument("--to", default="now")
    ap.add_argument("--max", type=int, default=30, help="rows to print for logs and spans")
    ap.add_argument("--spans", action="store_true", help="Tempo: a spans table instead of traces")
    args = ap.parse_args()

    target = {"refId": "A", "datasource": DATASOURCES[args.kind]}
    if args.kind == "prom":
        target.update(expr=args.query, instant=True, range=False)
    elif args.kind == "loki":
        target.update(expr=args.query, queryType="range", maxLines=1000)
    else:
        target.update(queryType="traceql", query=args.query, limit=100, spss=20, tableType="spans" if args.spans else "traces")
    code, res = Grafana().ds_query(target, span=TimeRange(frm=args.frm, to=args.to))
    result = (res.get("results") or {}).get("A", {})
    if code >= 400 or code == 0 or result.get("error"):
        print("ERROR", code, result.get("error") or res.get("message"))
        return 1
    for frame in result.get("frames", []):
        fields = frame["schema"].get("fields", [])
        values = frame["data"]["values"]
        rows = max((len(v) for v in values), default=0)
        print(f"-- frame {frame['schema'].get('name', '')} rows={rows}")
        labelled = [(f, v) for f, v in zip(fields, values) if f.get("labels")]
        if args.kind == "prom" or labelled:
            for f, v in labelled:
                print("  ", f["labels"], "last=", v[-1] if v else None)
            continue
        names = [f["name"] for f in fields]
        for i in range(min(rows, args.max)):
            row = {n: (v[i] if i < len(v) else None) for n, v in zip(names, values) if n not in ("tsNs", "id")}
            print("  ", {k: (json.dumps(x)[:200] if isinstance(x, (dict, list)) else str(x)[:200]) for k, x in row.items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
