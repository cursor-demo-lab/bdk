#!/usr/bin/env python3
"""Allow-list of Grafana Cloud ids used by generate.py, keyed to GRAFANA_MIN.

    python3 tools/grafana_ids.py          print findings for the committed JSON
    imported by generate.py --check

A typo here is how r10 shipped continuous-Blues (Registry.get is
case-sensitive and the whole dashboard then fails). filterFields is a
hidden transformer from 13.1.0; GRAFANA_MIN is (13, 1).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from generate import DASHBOARD_FILES, GRAFANA_BANNER, GRAFANA_MIN  # noqa: E402

# FieldColorModeId (grafana-data fieldColor.ts). Grafana Cloud 13.1+.
COLOR_MODES = {
    "thresholds",
    "palette-classic",
    "palette-classic-by-name",
    "continuous-GrYlRd",
    "continuous-RdYlGr",
    "continuous-BlYlRd",
    "continuous-YlRd",
    "continuous-BlPu",
    "continuous-YlBl",
    "continuous-blues",
    "continuous-reds",
    "continuous-greens",
    "continuous-purples",
    "fixed",
    "shades",
}

MATCHER_IDS = {"byName", "byRegexp", "byType", "byFrameRefID", "byValue"}
# DataTransformerID floors. Allowed when GRAFANA_MIN >= the floor.
# filterFields is hiddenTransformer from 13.1.0; 12.2–13.0 throw.
TRANSFORM_SINCE = {
    "merge": (12, 2),
    "organize": (12, 2),
    "calculateField": (12, 2),
    "filterByValue": (12, 2),
    "filterFieldsByName": (12, 2),
    "labelsToFields": (12, 2),
    "extractFields": (12, 2),
    "sortBy": (12, 2),
    "filterFields": (13, 1),
    # DataTransformerID values the v2 ticket and cost panels use; all predate 12.2.
    "groupBy": (12, 2),
    "joinByField": (12, 2),
    "partitionByValues": (12, 2),
    "limit": (12, 2),
    "concatenate": (12, 2),
    "groupingToMatrix": (12, 2),
    "reduce": (12, 2),
    "renameByRegex": (12, 2),
    # v4 lead times used seriesToRows; the table now pivots with groupingToMatrix (still allowed).
    "seriesToRows": (12, 2),
}


def transform_ids_for(min_version: tuple) -> set:
    return {tid for tid, since in TRANSFORM_SINCE.items() if since <= min_version}


TRANSFORM_IDS = transform_ids_for(GRAFANA_MIN)
CELL_TYPES = {"auto", "color-text", "color-background"}
MAPPING_TYPES = {"value", "range", "regex", "special"}
REDUCER_IDS = {
    "lastNotNull", "sum", "mean", "max", "min", "allIsNull", "count",
    # ReducerID values the v2 ticket panels use ("step" is the smallest gap between values).
    "step", "last", "distinctCount", "p50", "p95",
}


def _walk(value: object, *, path: str, acc: list):
    if isinstance(value, dict):
        mode = value.get("mode")
        if isinstance(mode, str) and (
            "fixedColor" in value or mode.startswith(
                ("continuous", "palette", "fixed", "shades", "thresholds"))
        ):
            if mode not in COLOR_MODES:
                acc.append(f"{path}: colour mode {mode!r}")
        mid = value.get("id")
        if isinstance(mid, str):
            if path.endswith("matcher") and mid not in MATCHER_IDS:
                acc.append(f"{path}: matcher id {mid!r}")
            if path.endswith("matcher") and mid == "byRegexp":
                pat = value.get("options") or ""
                if isinstance(pat, str):
                    slashed = len(pat) >= 2 and pat.startswith("/") and pat.endswith("/")
                    full = pat in (".*", "^.*$") or (pat.startswith("^") and pat.endswith("$"))
                    if not slashed and not full:
                        acc.append(f"{path}: byRegexp {pat!r} must be /…/ or a full-name ^…$ match")
            if path.endswith("cellOptions") and mid not in CELL_TYPES:
                acc.append(f"{path}: cell type {mid!r}")
            if "mappings" in path and mid in ("value", "range", "regex", "special"):
                if mid not in MAPPING_TYPES:
                    acc.append(f"{path}: mapping type {mid!r}")
            if path.endswith("config") and mid not in (
                REDUCER_IDS | {"equal", "isNull", "greaterOrEqual", "lower"}
            ):
                pass
        if value.get("reducer") in (None, "") or isinstance(value.get("reducer"), list):
            pass
        elif isinstance(value.get("reducer"), str) and value["reducer"] not in REDUCER_IDS:
            if "cumulative" in path or "reduce" in path:
                acc.append(f"{path}: reducer {value['reducer']!r}")
        if isinstance(value.get("id"), str) and path.endswith("transform"):
            if value["id"] not in TRANSFORM_IDS:
                acc.append(f"{path}: transform id {value['id']!r} (not in {GRAFANA_BANNER})")
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            if key == "transformations" and isinstance(child, list):
                for i, t in enumerate(child):
                    tid = (t or {}).get("id")
                    if tid and tid not in TRANSFORM_IDS:
                        acc.append(f"{child_path}[{i}]: transform id {tid!r} (not in {GRAFANA_BANNER})")
                    _walk(t, path=f"{child_path}[{i}]", acc=acc)
            else:
                _walk(child, path=child_path, acc=acc)
    elif isinstance(value, list):
        for i, child in enumerate(value):
            _walk(child, path=f"{path}[{i}]", acc=acc)


def findings(dashboards: list) -> list[str]:
    acc = []
    for dash in dashboards:
        uid = dash.get("uid", "?")
        _walk(dash, path=uid, acc=acc)
    return acc


def findings_for_dir(root: str = ROOT) -> list[str]:
    dashes = []
    for filename in DASHBOARD_FILES.values():
        path = os.path.join(root, filename)
        with open(path, encoding="utf-8") as f:
            dashes.append(json.load(f))
    return findings(dashes)


def main() -> int:
    rows = findings_for_dir()
    for row in rows:
        print(row, file=sys.stderr)
    if rows:
        print(f"grafana_ids: {len(rows)} failure(s)", file=sys.stderr)
        return 1
    print(f"grafana_ids: ok ({GRAFANA_BANNER}; {len(TRANSFORM_IDS)} transformers)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
