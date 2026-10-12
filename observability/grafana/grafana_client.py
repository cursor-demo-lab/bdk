"""Grafana HTTP access shared by verify.py and tools/*.py. Python 3 standard library only.

GRAFANA_URL (default https://<GRAFANA_STACK>.grafana.net) and a service-account token from
GRAFANA_TOKEN or GRAFANA_TOKEN_FILE (a file outside this git work tree). The token is held in memory
only and never printed: error messages carry the HTTP status and Grafana's message, never a header.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass


@dataclass(frozen=True, kw_only=True)
class Host:
    """Optional Grafana URL and token, so they are not adjacent strings."""
    url: str | None = None
    token: str | None = None


@dataclass(frozen=True, kw_only=True)
class Request:
    """HTTP method and path, so they are not adjacent strings."""
    method: str
    path: str


@dataclass(frozen=True, kw_only=True)
class TimeRange:
    """Query window, so from/to are not adjacent strings."""
    frm: str
    to: str

DEFAULT_URL = "https://<GRAFANA_STACK>.grafana.net"
HERE = os.path.dirname(os.path.abspath(__file__))
DATASOURCES = {
    "prom": {"type": "prometheus", "uid": "grafanacloud-prom"},
    "loki": {"type": "loki", "uid": "grafanacloud-logs"},
    "tempo": {"type": "tempo", "uid": "grafanacloud-traces"},
}


def grafana_url():
    return os.environ.get("GRAFANA_URL", DEFAULT_URL).rstrip("/")


def _worktree():
    try:
        out = subprocess.run(["git", "-C", HERE, "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return os.path.realpath(out.stdout.strip())


def load_token():
    token = os.environ.get("GRAFANA_TOKEN", "").strip()
    if token:
        return token
    path = os.environ.get("GRAFANA_TOKEN_FILE", "")
    if not path:
        sys.exit("set GRAFANA_TOKEN or GRAFANA_TOKEN_FILE (a Grafana service-account token)")
    real = os.path.realpath(path)
    tree = _worktree()
    if tree and (real == tree or real.startswith(tree + os.sep)):
        sys.exit(f"GRAFANA_TOKEN_FILE is inside the git work tree ({tree}); keep the token outside the repository")
    try:
        with open(real, encoding="utf-8") as f:
            token = f.read().strip()
    except OSError as e:
        sys.exit(f"GRAFANA_TOKEN_FILE is not readable ({e.strerror})")
    if not token:
        sys.exit("the Grafana token is empty")
    return token


class Grafana:
    def __init__(self, host: Host | None = None):
        host = host or Host()
        self.url = (host.url or grafana_url()).rstrip("/")
        self._token = host.token or load_token()

    def call(self, req: Request, *, body: dict | None = None, timeout: int = 90):
        req = urllib.request.Request(self.url + req.path, method=req.method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + self._token,
                                              "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"message": raw.decode(errors="replace")[:500]}
        except urllib.error.URLError as e:
            return 0, {"message": f"cannot reach {self.url}: {e.reason}"}

    def ds_query(self, query: dict, *, span: TimeRange):
        return self.call(Request(method="POST", path="/api/ds/query"),
                         body={"queries": [query], "from": span.frm, "to": span.to})


def frame_rows(result: dict):
    """Rows across a /api/ds/query result's frames (the longest field of each frame)."""
    rows = 0
    for fr in result.get("frames", []) or []:
        values = (fr.get("data") or {}).get("values") or []
        rows += max((len(v) for v in values), default=0)
    return rows
