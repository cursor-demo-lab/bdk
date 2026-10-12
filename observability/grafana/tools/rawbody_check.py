#!/usr/bin/env python3
"""Proves the Loki panels read factory fields from raw log bodies as well as from structured metadata.

    tools/rawbody_check.py [--loki http://127.0.0.1:3100]

Pushes one fixture over OTLP to a Loki you can write to (a local or dev Loki, never the factory's stack), under
a service name and ticket key unique to this run, then runs the dashboards' own Loki targets (from the committed
JSON, interpolated as verify.py does) straight against Loki and checks the results. The fixture mixes both shapes
a factory line can arrive in:

- raw bodies with no attributes, as once the console bridge stops parsing lines: July's
  `[bdk] hosted admission received deliveryId=... eventType=...` lines, a `[planner]` line that names the ticket
  only in text, factory JSON lines, and the multi-line bodies a bridge that sends util.format(...args) produces
  (a tagged error with its stack, a JSON line followed by an Error and its stack);
- structured metadata on older records exported before #217: a `tag:bdk` or
  `factory.<key>` body with the fields as attributes.

The milestone fixture (planner, desk, worker and fixer lines shaped as the hosts write them, four tickets) is pushed
with the hosts minutes apart, so Factory business's lead times, first-pass rate, Slack approvals per ticket and
modelled hours have known answers too.

Levels follow the senders: a console line carries severityText (INFO / WARN / ERROR, which Loki 3.5 keeps as an
upper-case detected_level), a July session event only a severity number (a lower-case detected_level).

--loki takes a plain http(s) URL; one with a user or password in it is refused, and only scheme, host and port
are ever printed.

Exit 1 if any check fails. scripts/grafana-dashboards.test.mjs runs it when FACTORY_LOKI_URL is set.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
from dataclasses import dataclass

from generate import DASHBOARD_FILES  # noqa: E402
from grafana_client import TimeRange  # noqa: E402
from verify import Overrides, prepared_targets  # noqa: E402


@dataclass(frozen=True, kw_only=True)
class Stream:
    """Loki URL and slug, so they are not adjacent strings."""
    loki: str
    service: str

WINDOW = "now-15m"


STACK = "\n    at hopWatch (/app/agent/lib/hop-watch.js:41:11)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)"


def fixture(*, ticket: str):
    """(body, attributes, level, sender) records; sender "console" sets severityText, "july" only the number.
    Expected results are in checks()."""
    raw = [
        ("[bdk] hosted admission received deliveryId=raw-d1 channelId=C1 channelKind=github eventType=pull_request "
         "sessionMode=live", {}, "INFO", "console"),
        ("[bdk] hosted enqueue inject failed deliveryId=raw-d1: socket hang up", {}, "WARN", "console"),
        ("[bdk] hosted admission received deliveryId=raw-d2 channelId=C2 channelKind=jira eventType=jira:issue_updated "
         "sessionMode=live", {}, "INFO", "console"),
        (json.dumps({"desk": "intake_root", "issueKey": ticket, "outcome": "skipped", "why": "filed_in_slack_unbound"}), {}, "INFO", "console"),
        (json.dumps({"worker": "decision", "issueKey": ticket, "outcome": "launching", "via": "jira", "deliveryId": "raw-d3",
                     "pr": "acme/app#12"}), {}, "INFO", "console"),
        (json.dumps({"factoryDebug": "review", "factoryKey": ticket, "outcome": "posted"}), {}, "INFO", "console"),
        (f"[planner] {ticket} stopped without a plan (jira): no_scope", {}, "INFO", "console"),
        (json.dumps({"kv": "warn", "site": "hop_watch", "reason": "kv_timeout", "issueKey": ticket}), {}, "WARN", "console"),
        # util.format(...args) bodies: an error line with its stack, and a JSON line followed by an Error.
        (f"[factory-desk] hop-watch for {ticket} failed: Error: socket hang up{STACK}", {}, "ERROR", "console"),
        (json.dumps({"desk": "hop_watch", "issueKey": ticket, "outcome": "failed", "deliveryId": "raw-d4"})
         + " Error: Jira answered 502 } {" + STACK, {}, "ERROR", "console"),
        # Slack Bolt pair: both lines must land in Slack SDK warnings, not Errors.
        ("web-api:WebClient:395 missing_agent_session_stopped_event_subscription", {}, "WARN", "console"),
        ("web-api:WebClient:396 Subscribe to the agent_session_stopped event", {}, "WARN", "console"),
        # A factory line that only mentions the code must still count as a factory warning.
        ("factory line mentions missing_agent_session_stopped_event_subscription", {}, "WARN", "console"),
        # The desk's idle hop-watch tick (every 5 minutes): a liveness line, dropped from every event count.
        (HOP_TICK, {}, "INFO", "console"),
    ]
    structured = [
        ("tag:bdk", {"deliveryId": "sm-d1", "eventType": "check_suite"}, "INFO", "console"),
        ("factory.desk", {"factory.event": "intake_backlink", "issueKey": ticket, "outcome": "written"}, "INFO", "console"),
        ("turn.completed", {"agent_sdk.event": "turn.completed"}, "INFO", "july"),
        # July drops an undefined attribute (otel/attrs.js), so an unexpected failure has no expected_error key at all.
        ("turn.failed", {"agent_sdk.event": "turn.failed"}, "ERROR", "july"),
        ("turn.failed", {"agent_sdk.event": "turn.failed", "agent_sdk.expected_error": "usage_limit"}, "WARN", "july"),
    ]
    return raw + structured


HOP_TICK = json.dumps({"desk": "hop_watch", "via": "schedule", "due": 0, "fired": 0}, separators=(",", ":"))
# The milestone lines, shaped as the hosts write them (field names from the host code; see generate.py "v3: ticket
# milestones"). Ticket A goes all the way with a healed launch and a Bugbot round on its PR; ticket B's planner was
# silent at the start check (retried, then final: two never-started lines on one ticket), planned late anyway, was
# approved by a typed command, and its launch was a retried delivery (turn_sent, then launched, both retried: one
# launch, two lines); it is still building. Ticket C went through first time (one launch, no Bugbot round) and
# merged. Ticket D launched once and merged, but the fixer ran a Bugbot round on its PR. So of the three merged
# tickets (A, C, D) one is first-pass. The hosts are pushed minutes apart (MILESTONE_OFFSETS_MIN): the planner
# first, then the desk, the worker and the fixer, so filed -> PR opened and filed -> merged are both LEAD_MIN.
MILESTONE_SLUGS = ("factory-planner", "factory-desk", "factory-worker", "factory-pr-autofixer")
MILESTONE_OFFSETS_MIN = {"factory-planner": 12, "factory-desk": 9, "factory-worker": 3, "factory-pr-autofixer": 1}
LEAD_MIN = MILESTONE_OFFSETS_MIN["factory-planner"] - MILESTONE_OFFSETS_MIN["factory-worker"]
HOURS_PER_TICKET = 4


def milestone_fixture(*, stamp: str):
    """{slug: records} in time order within each host (push() stamps them 1 ms apart, in list order)."""
    a, b, c, dd = (f"MILE-{stamp}-{n}" for n in (1, 2, 3, 4))
    j = lambda d: json.dumps(d)  # noqa: E731
    planner = [
        (f"[planner] webhook status {a} planned (changelog {a}:Triaged:1, verdict bug)", {}, "INFO", "console"),
        (j({"planner": "turn_started", "sessionId": "s1", "issueKey": a, "requested": "auto"}), {}, "INFO", "console"),
        (j({"planner": "turn_model", "outcome": "completed", "sessionId": "s1", "issueKey": a, "model": "unknown",
            "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 900}), {}, "INFO", "console"),
        # A replan: a second turn on the same ticket counts once as a distinct ticket.
        (j({"planner": "turn_started", "sessionId": "s2", "issueKey": a, "requested": "auto"}), {}, "INFO", "console"),
        (j({"planner": "turn_model", "outcome": "completed", "sessionId": "s2", "issueKey": a, "model": "unknown"}), {}, "INFO", "console"),
        (j({"planner": "turn_started", "sessionId": "s3", "issueKey": b, "requested": "auto"}), {}, "INFO", "console"),
        (j({"planner": "turn_model", "outcome": "failed", "sessionId": "s3", "issueKey": b, "model": "unknown"}), {}, "INFO", "console"),
        (j({"planner": "turn_started", "sessionId": "s4", "issueKey": b, "requested": "auto"}), {}, "INFO", "console"),
        (j({"planner": "turn_model", "outcome": "completed", "sessionId": "s4", "issueKey": b, "model": "unknown"}), {}, "INFO", "console"),
        # C and D: filed through the planner only (no desk arm line), one turn each.
        (j({"planner": "turn_started", "sessionId": "s5", "issueKey": c, "requested": "auto"}), {}, "INFO", "console"),
        (j({"planner": "turn_started", "sessionId": "s6", "issueKey": dd, "requested": "auto"}), {}, "INFO", "console"),
    ]
    desk = [
        (j({"desk": "plan_start_watch", "via": "arm", "issueKey": a, "changelogId": f"{a}:Triaged:1", "result": "armed"}), {}, "INFO", "console"),
        (j({"desk": "plan_start_watch", "via": "reminder", "issueKey": a, "changelogId": f"{a}:Triaged:1", "result": "started"}), {}, "INFO", "console"),
        (j({"desk": "plan_start_watch", "via": "arm", "issueKey": b, "changelogId": f"{b}:Triaged:1", "result": "armed"}), {}, "INFO", "console"),
        (j({"desk": "plan_start_watch", "via": "reminder", "issueKey": b, "changelogId": f"{b}:Triaged:1", "result": "retried",
            "rescheduleMs": 240000, "posted": True}), {}, "INFO", "console"),
        (j({"desk": "plan_start_watch", "via": "sweep", "issueKey": b, "changelogId": f"{b}:Triaged:1", "result": "final",
            "posted": True}), {}, "INFO", "console"),
        (j({"desk": "reaction", "verb": "approve", "target": "plan", "channel": "C1", "ts": "1.1", "user": "U1", "issueKey": a,
            "outcome": "approved"}), {}, "INFO", "console"),
        (j({"desk": "reaction", "verb": "decline", "target": "plan", "channel": "C1", "ts": "1.1", "user": "U2", "issueKey": a,
            "outcome": "ignored", "why": "bot"}), {}, "INFO", "console"),
        (j({"desk": "approve_command", "outcome": "approved", "issueKey": b, "channel": "C1", "ts": "1.2"}), {}, "INFO", "console"),
        (j({"desk": "review_update", "wake": "check_suite", "posted": True, "reason": "posted_in_thread", "pr": "acme/app#12",
            "issueKey": a, "headSha": "a" * 40, "pending": [], "changeReview": "pending", "components": ["ci", "changeMonitor"]}), {}, "INFO", "console"),
        (j({"desk": "review_update", "wake": "pull_request", "posted": True, "reason": "posted_in_thread", "pr": "acme/app#12",
            "issueKey": a, "components": ["bugbot"]}), {}, "INFO", "console"),
        (j({"desk": "review_update", "wake": "workflow_run", "posted": True, "reason": "updated_in_thread", "pr": "acme/app#12",
            "issueKey": a, "changeReview": "verified", "components": ["changeMonitor"]}), {}, "INFO", "console"),
        (j({"desk": "review_update", "wake": "check_suite", "posted": False, "reason": "already_announced", "pr": "acme/app#12",
            "issueKey": a, "changeReview": "verified", "components": []}), {}, "INFO", "console"),
        (HOP_TICK, {}, "INFO", "console"),
        (HOP_TICK, {}, "INFO", "console"),
    ]
    worker = [
        (j({"worker": "decision", "outcome": "launch_failed", "issueKey": a, "changelogId": f"{a}:Approved:1", "via": "delivery",
            "retried": False, "reason": "rate_limited"}), {}, "WARN", "console"),
        (j({"worker": "decision", "outcome": "launched", "issueKey": a, "changelogId": f"{a}:Approved:1", "via": "heal",
            "retried": True, "agentId": "bc_1", "url": "https://cursor.com/agents/bc_1"}), {}, "INFO", "console"),
        # One retried delivery launch, two lines: the cloud turn sent, then the agent bound. Counted once as a retry.
        (j({"worker": "decision", "outcome": "turn_sent", "issueKey": b, "changelogId": f"{b}:Approved:2", "via": "delivery",
            "retried": True, "continuation": f"implement:{b}#{b}:Approved:2", "sentMarked": True}), {}, "INFO", "console"),
        (j({"worker": "decision", "outcome": "launched", "issueKey": b, "changelogId": f"{b}:Approved:2", "via": "delivery",
            "retried": True, "agentId": "bc_2"}), {}, "INFO", "console"),
        (j({"worker": "decision", "outcome": "duplicate", "issueKey": b, "changelogId": f"{b}:Approved:1", "via": "delivery",
            "reposted": False}), {}, "INFO", "console"),
        (j({"worker": "implement_pr", "via": "approved", "issueKey": a, "outcome": "opened", "pr": "acme/app#12",
            "url": "https://github.com/acme/app/pull/12", "branch": "cursor/a", "ready": "ready", "move": "moved"}), {}, "INFO", "console"),
        (j({"worker": "pr_status", "issueKey": a, "stage": "in_review", "pr": "acme/app#12", "outcome": "moved", "move": "transitioned"}), {}, "INFO", "console"),
        (j({"worker": "pr_status", "issueKey": b, "stage": "in_review", "pr": "acme/app#13", "outcome": "not_moved", "move": "skipped_status"}), {}, "INFO", "console"),
        (j({"worker": "pr_status", "issueKey": a, "stage": "done", "pr": "acme/app#12", "outcome": "moved", "move": "transitioned"}), {}, "INFO", "console"),
        # C: one clean launch, PR opened, merged. D: the same, but the fixer spends a Bugbot round on its PR below.
        (j({"worker": "decision", "outcome": "launched", "issueKey": c, "changelogId": f"{c}:Approved:1", "via": "delivery",
            "retried": False, "agentId": "bc_3"}), {}, "INFO", "console"),
        (j({"worker": "implement_pr", "via": "approved", "issueKey": c, "outcome": "opened", "pr": "acme/app#14",
            "url": "https://github.com/acme/app/pull/14", "branch": "cursor/c", "ready": "ready", "move": "moved"}), {}, "INFO", "console"),
        (j({"worker": "pr_status", "issueKey": c, "stage": "done", "pr": "acme/app#14", "outcome": "moved", "move": "transitioned"}), {}, "INFO", "console"),
        (j({"worker": "decision", "outcome": "launched", "issueKey": dd, "changelogId": f"{dd}:Approved:1", "via": "delivery",
            "retried": False, "agentId": "bc_4"}), {}, "INFO", "console"),
        (j({"worker": "implement_pr", "via": "approved", "issueKey": dd, "outcome": "opened", "pr": "acme/app#15",
            "url": "https://github.com/acme/app/pull/15", "branch": "cursor/d", "ready": "ready", "move": "moved"}), {}, "INFO", "console"),
        (j({"worker": "pr_status", "issueKey": dd, "stage": "done", "pr": "acme/app#15", "outcome": "moved", "move": "transitioned"}), {}, "INFO", "console"),
    ]
    # The fixer names the PR only (no issueKey): a granted round on A's and D's PRs, a duplicate on D's (not a round),
    # and a fresh drive on a PR no worker line ties to a ticket (joins to nothing).
    fixer = [
        (j({"fixer": "bugbot_round", "pr": "acme/app#12", "head": "a" * 40, "outcome": "drive"}), {}, "INFO", "console"),
        (j({"fixer": "bugbot_round", "pr": "acme/app#15", "head": "d" * 40, "outcome": "drive"}), {}, "INFO", "console"),
        (j({"fixer": "bugbot_round", "pr": "acme/app#15", "head": "d" * 40, "outcome": "duplicate"}), {}, "INFO", "console"),
        (j({"fixer": "bugbot_wake", "pr": "acme/app#99", "head": "e" * 40, "outcome": "fresh_drive"}), {}, "INFO", "console"),
    ]
    return dict(zip(MILESTONE_SLUGS, (planner, desk, worker, fixer)))


def milestone_checks(*, stamp: str):
    """(name, (file, panel, refId), ticket override, test(data) -> (ok, detail)) for the Loki milestone panels."""
    a, b = f"MILE-{stamp}-1", f"MILE-{stamp}-2"
    biz, ops = "factory-business.json", "factory-ops.json"
    lead_ms = LEAD_MIN * 60_000

    def total(expected: float):
        return lambda d: (sum(v for _, v in series(d)) == expected, f"{sum(v for _, v in series(d)):g} (want {expected})")

    def by(labels: tuple, *, expected: dict):
        def test(d: dict):
            got = {tuple(m.get(k, "") for k in labels): v for m, v in series(d)}
            return got == expected, f"{got} (want {expected})"
        return test

    def milestones(expected: int, *, want: tuple):
        def test(d: dict):
            got = [line for _, line in lines(d)]
            missing = [w for w in want if w not in got]
            return len(got) == expected and not missing, f"{len(got)} lines (want {expected}), missing {missing}"
        return test

    def change_review(d: dict):
        got = sorted((m.get("f_ticket"), m.get("m_changeReview"), m.get("pr_path")) for m, _ in lines(d))
        want = [(a, "pending", "acme/app/pull/12"), (a, "verified", "acme/app/pull/12")]
        return got == want, f"{got} (want {want})"

    def leads(expected: int, *, lead: str | None = None):
        """One per-ticket series each within 5 s of LEAD_MIN (the hosts were pushed that far apart).

        When lead is set, only series carrying that static `lead` label count (the table's single `or`
        query returns both filed→PR and filed→merged series on ref A).
        """
        def test(d: dict):
            got = {m.get("f_ticket"): v for m, v in series(d)
                   if lead is None or m.get("lead") == lead}
            near = all(abs(v - lead_ms) <= 5_000 for v in got.values())
            tag = f"{lead}: " if lead else ""
            return len(got) == expected and near, f"{tag}{len(got)} tickets (want {expected}), ms {got} (want about {lead_ms})"
        return test

    def ratio(expected: float):
        return lambda d: (abs(sum(v for _, v in series(d)) - expected) < 1e-9, f"{sum(v for _, v in series(d)):g} (want {expected:g})")

    return [
        ("Business: filed (A and B through the desk's arm line, C and D through the planner's first turn)", (biz, "Filed", "A"), "", total(4)),
        ("Business flow: filed", (biz, "Ticket flow (Loki, distinct tickets in range)", "A"), "", total(4)),
        ("Business flow: plan started (distinct tickets, replans once)", (biz, "Ticket flow (Loki, distinct tickets in range)", "B"), "", total(4)),
        # A: launch_failed then a healed launched; B: turn_sent then launched. One ticket each, not one per line.
        ("Business flow: approved (reached worker) is distinct tickets with a worker decision", (biz, "Ticket flow (Loki, distinct tickets in range)", "C"), "", total(4)),
        ("Business flow: launched", (biz, "Ticket flow (Loki, distinct tickets in range)", "D"), "", total(4)),
        ("Business flow: PR opened", (biz, "Ticket flow (Loki, distinct tickets in range)", "E"), "", total(3)),
        ("Business flow: merged", (biz, "Ticket flow (Loki, distinct tickets in range)", "F"), "", total(3)),
        ("Business: PRs opened", (biz, "PRs opened", "A"), "", total(3)),
        ("Business: merged", (biz, "Merged", "A"), "", total(3)),
        # Merged A (heal + Bugbot round), C (clean), D (Bugbot round): one of three went through first time.
        ("Business: first-pass rate is the clean merged ticket over the three merged", (biz, "First-pass rate", "A"), "", ratio(1 / 3)),
        ("Business: engineer-hours saved is merged tickets x the hours variable (modelled)", (biz, "Engineer-hours saved (modelled)", "A"), "",
         total(3 * HOURS_PER_TICKET)),
        # A's reaction and B's typed approve over the four tickets that reached the worker.
        ("Business: Slack approvals per ticket", (biz, "Slack approvals per ticket", "A"), "", ratio(2 / 4)),
        ("Business: filed -> PR opened per ticket (A, C, D), from the lines' own timestamps", (biz, "Filed → PR opened p50", "A"), "", leads(3)),
        ("Business: filed -> merged per ticket (A, C, D)", (biz, "Filed → merged p50", "A"), "", leads(3)),
        ("Business: lead times table, PR opened series", (biz, "Lead times (p50 / p95 / tickets)", "A"), "",
         leads(3, lead="filed → PR opened")),
        ("Business: lead times table, merged series", (biz, "Lead times (p50 / p95 / tickets)", "A"), "",
         leads(3, lead="filed → merged")),
        ("Business: cost / filed denominator", (biz, "Cost / filed (est.)", "B"), "", total(4)),
        # B logs retried and then final: one ticket, so 1, not 2 lines.
        ("Ops health: never started is distinct tickets (retried then final on one ticket is 1)", (ops, "Never started (alerts)", "A"), "", total(1)),
        ("Ops health: plan start started", (ops, "Plan start: started", "A"), "", total(1)),
        # A's heal and B's retried delivery: B's turn_sent line is the same launch as its launched line and is not counted.
        ("Ops health: launch retries / heals counts launched only (turn_sent of the same launch is not a second one)",
         (ops, "Launch retries / heals", "A"), "", total(2)),
        ("Ops health: change-review posts", (ops, "📡 Change reviews", "A"), "", total(2)),
        ("Ops health: plan start watch by result and via", (ops, "Plan start watch by result and via", "A"), "",
         by(("m_result", "f_via"), expected={("armed", "arm"): 2.0, ("started", "reminder"): 1.0, ("retried", "reminder"): 1.0,
                                             ("final", "sweep"): 1.0})),
        ("Ops health: launch decisions by outcome, via, retried", (ops, "Worker launch decisions by outcome", "A"), "",
         by(("f_outcome", "f_via", "m_retried"), expected={("launch_failed", "delivery", "false"): 1.0, ("launched", "heal", "true"): 1.0,
                                                           ("turn_sent", "delivery", "true"): 1.0, ("launched", "delivery", "true"): 1.0,
                                                           ("launched", "delivery", "false"): 2.0, ("duplicate", "delivery", ""): 1.0})),
        ("Ops health: change review per ticket (lines the browser groups)", (ops, "📡 Change review per ticket (latest)", "A"), "", change_review),
        ("Ops: ticket milestones for one ticket", (ops, "Ticket milestones (logs)", "A"), a,
         milestones(14, want=(f"{a} · plan turn completed (planner)", f"{a} · plan start check: started (desk)", f"{a} · approved (reaction) (desk)",
                              f"{a} · worker launch_failed via delivery (worker)", f"{a} · worker launched via heal, retried (worker)",
                              f"{a} · PR opened acme/app#12 (worker)", f"{a} · PR in review acme/app#12 (worker)",
                              f"{a} · merged acme/app#12 (worker)", f"{a} · review update, change review verified (desk)",
                              f"{a} · review update (desk)"))),
        ("Ops: ticket milestones for every ticket while Ticket is empty", (ops, "Ticket milestones (logs)", "A"), "",
         milestones(31, want=(f"{b} · plan turn failed (planner)", f"{b} · plan start check: retried (desk)",
                              f"{b} · plan start check: final (desk)", f"{b} · approved (command) (desk)",
                              f"{b} · worker turn_sent via delivery, retried (worker)",
                              f"{b} · worker launched via delivery, retried (worker)"))),
        ("Ops health: event lines", (ops, "Health event lines (plan start watch, worker decisions, review updates)", "A"), "",
         lambda d: (len(lines(d)) == 15, f"{len(lines(d))} lines (want 15: 5 plan start, 7 decisions, 3 posted review updates)")),
    ]


def scoped(q: dict, *, stamp: str):
    """The all-slug milestone queries read every ticket; restrict them to this run's keys so earlier runs do not count.
    Every ticket-keyed sub-query (the lead times and the first-pass rate join several) gets the guard."""
    guard = '| f_ticket != ""'
    if guard not in q["expr"]:
        raise SystemExit(f"milestone query lost its ticket guard: {q['expr'][:120]}")
    return {**q, "expr": q["expr"].replace(guard, f'| f_ticket =~ "MILE-{stamp}-.*"')}


def loki_version(url: str) -> str:
    """Loki buildinfo version, or 'unknown'. LOW-1 label-filter claims are tied to this."""
    req = urllib.request.Request(url.rstrip("/") + "/loki/api/v1/status/buildinfo", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            body = json.loads(r.read())
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError):
        return "unknown"
    return str(body.get("version") or "unknown")


def origin(url: str):
    """scheme://host[:port] of a plain http(s) URL; refuses one that carries a user or password."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SystemExit("rawbody_check: --loki must be an http(s) URL")
    if parts.username is not None or parts.password is not None:
        raise SystemExit("rawbody_check: refusing a --loki / FACTORY_LOKI_URL with credentials in it; use a Loki without auth")
    return f"{parts.scheme}://{parts.hostname}" + (f":{parts.port}" if parts.port else "")


def push(*, dest: Stream, records: list, minutes_ago: int = 0):
    """Pushes `records` stamped 1 ms apart in list order, ending `minutes_ago` minutes before now."""
    def attr(pair: tuple):
        return {"key": pair[0], "value": {"stringValue": pair[1]}}

    now = time.time_ns() - minutes_ago * 60 * 10**9
    severities = {"INFO": 9, "WARN": 13, "ERROR": 17}
    logs = [{"timeUnixNano": str(now - (len(records) - i) * 1_000_000), "severityNumber": severities[level],
             **({"severityText": level} if sender == "console" else {}),
             "body": {"stringValue": body}, "attributes": [attr(kv) for kv in attributes.items()]}
            for i, (body, attributes, level, sender) in enumerate(records)]
    payload = {"resourceLogs": [{"resource": {"attributes": [attr(("service.name", dest.service)), attr(("service.namespace", "software-factory"))]},
                                 "scopeLogs": [{"scope": {"name": "rawbody_check"}, "logRecords": logs}]}]}
    req = urllib.request.Request(dest.loki.rstrip("/") + "/otlp/v1/logs", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def targets(*, overrides: dict):
    """{(dashboard file, panel title, refId): target with the query interpolated} for every Loki target."""
    out = {}
    for filename in DASHBOARD_FILES.values():
        with open(os.path.join(HERE, "..", filename), encoding="utf-8") as f:
            dash = json.load(f)
        for panel, target, q, _, _, _ in prepared_targets(
                dash, span=TimeRange(frm=WINDOW, to="now"), overrides=Overrides(values=overrides)):
            if (q.get("datasource") or {}).get("type") == "loki":
                out[(filename, panel["title"], target["refId"])] = q
                out[(filename, panel["title"], target["refId"], panel["type"])] = q
    return out


def run(q: dict, *, loki: str):
    base = loki.rstrip("/") + "/loki/api/v1/"
    if q.get("queryType") == "instant":
        url = base + "query?" + urllib.parse.urlencode({"query": q["expr"]})
    else:
        url = base + "query_range?" + urllib.parse.urlencode({"query": q["expr"], "start": str(time.time_ns() - 15 * 60 * 10**9),
                                                             "end": str(time.time_ns()), "limit": q.get("maxLines") or 1000})
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)["data"]


def series(data: dict):
    """[(labels, value)] of an instant metric result."""
    return [(s["metric"], float(s["value"][1])) for s in data["result"]]


def lines(data: dict):
    """[(labels, line)] of a log result, labels including parsed ones."""
    return [(s["stream"], v[1]) for s in data["result"] for v in s["values"]]


def checks(*, ticket: str):
    """(name, (file, panel, refId), extra overrides, test(data) -> (ok, detail))."""
    ops = "factory-ops.json"

    def total(expected: float):
        return lambda d: (sum(v for _, v in series(d)) == expected, f"{sum(v for _, v in series(d)):g} (want {expected})")

    def by(label: str, *, expected: dict):
        def test(d: dict):
            got = {m.get(label, ""): v for m, v in series(d)}
            return got == expected, f"{got} (want {expected})"
        return test

    def events(d: dict):
        got = sorted((m.get("f_event"), m.get("f_outcome"), v) for m, v in series(d))
        want = sorted([("intake_root", "skipped", 1.0), ("decision", "launching", 1.0), ("review", "posted", 1.0),
                       ("intake_backlink", "written", 1.0), ("warn", "", 1.0), ("hop_watch", "failed", 1.0)])
        return got == want, f"{got}"

    def recent(d: dict):
        got = sorted((m.get("f_event"), m.get("f_ticket"), m.get("f_reason", ""), m.get("f_pr", ""), m.get("pr_path", ""))
                     for m, _ in lines(d))
        # The f_pr cell drops the owner (repo#N fits 170 px); pr_path keeps it for the GitHub link.
        want = sorted([("intake_root", ticket, "filed_in_slack_unbound", "", ""), ("decision", ticket, "", "app#12", "acme/app/pull/12"),
                       ("review", ticket, "", "", ""), ("intake_backlink", ticket, "", "", ""), ("warn", ticket, "kv_timeout", "", ""),
                       ("hop_watch", ticket, "", "", "")])
        return got == want, f"{len(got)} lines {got}"

    def journey(d: dict):
        got = sorted(line for _, line in lines(d))
        ok = (len(got) == 8 and all(m.get("f_ticket") == ticket for m, _ in lines(d))
              and any(line.startswith("[planner]") for line in got) and any(line.startswith("[factory-desk]") for line in got))
        return ok, f"{len(got)} lines (want 8: five JSON, the [planner] and multi-line [factory-desk] text lines, the structured one)"

    def failures(d: dict):
        got = [line for _, line in lines(d)]
        want = ["deliveryId=raw-d1: socket hang up", '"kv": "warn"', f"hop-watch for {ticket} failed",
                '"outcome": "failed"', "turn.failed", "factory line mentions missing_agent_session_stopped"]
        missing = [w for w in want if not any(w in line for line in got)]
        slack = [line for line in got if "web-api:WebClient" in line]
        return not missing and not slack and len(got) == 7, f"{len(got)} lines (want 7), missing {missing}, slack {slack}"

    def slack_pair(d: dict):
        got = [line for _, line in lines(d)]
        ok = (len(got) == 2
              and any("missing_agent_session_stopped_event_subscription" in line for line in got)
              and any("Subscribe to the agent_session_stopped event" in line for line in got)
              and all("web-api:WebClient" in line for line in got))
        return ok, f"{len(got)} lines {got}"

    def levels(d: dict):
        got = sorted({s["metric"].get("level", "") for s in d["result"]})
        return got == ["error", "info", "warn"], f"{got} (want one lower-case series per level)"

    def shown(expected: int):
        def test(d: dict):
            got = len(lines(d))
            return got == expected, f"{got} lines (want {expected})"
        return test

    return [
        ("Ops debug: deliveries by event type", (ops, "Deliveries in logs by service and event type (Loki)", "A"), {},
         by("f_event_type", expected={"pull_request": 1.0, "jira:issue_updated": 1.0, "check_suite": 1.0})),
        ("Ops cross-check: delivery ids (logs)", (ops, "Cross-check per service: metric vs logs", "B"), {}, total(5)),
        ("Ops cross-check: factory events (logs)", (ops, "Cross-check per service: metric vs logs", "C"), {}, total(6)),
        ("Ops: errors and warnings stat", (ops, "Err & warn", "A"), {}, total(7)),
        ("Ops: Slack SDK warnings stat is the pair only", (ops, "Slack SDK", "A", "stat"), {}, total(2)),
        ("Ops: turns failed (logs) counts the unexpected one only", (ops, "Turn fails (logs)", "A"), {}, total(1)),
        # 6, not 7: the idle hop-watch tick in the fixture is dropped from every event count.
        ("Ops: factory events stat", (ops, "Events", "A"), {}, total(6)),
        ("Ops: factory structured events", (ops, "Factory structured events (range)", "A"), {}, events),
        ("Ops: recent factory events", (ops, "Recent factory events (newest 200)", "A"), {}, recent),
        ("Ops: ticket journey", (ops, "Ticket journey: events in time order", "A"), {}, journey),
        ("Ops: failures and warnings", (ops, "Failures and warnings", "A"), {}, failures),
        ("Ops: Slack SDK warnings are the pair", (ops, "Slack SDK warnings", "A", "logs"), {}, slack_pair),
        ("Ops: log lines by level", (ops, "Log lines per bucket by level", "A"), {}, levels),
        ("Ops: all factory logs, tag lines hidden", (ops, "All factory logs", "A"), {}, shown(13)),
        ("Ops: all factory logs, everything", (ops, "All factory logs", "A"), {"tag_lines": "^$"}, shown(19)),
    ]


def main():
    ap = argparse.ArgumentParser(description="Raw-body and structured-metadata fixture through the dashboards' Loki targets.")
    ap.add_argument("--loki", default=os.environ.get("FACTORY_LOKI_URL", "http://127.0.0.1:3100"))
    args = ap.parse_args()
    shown_url = origin(args.loki)
    version = loki_version(args.loki)
    print(f"Loki {version} at {shown_url}")

    stamp = str(time.time_ns())[-9:]
    service, ticket = f"factory-rawbody-{stamp}", f"RAWCHK-{stamp}"
    status = push(dest=Stream(loki=args.loki, service=service), records=fixture(ticket=ticket))
    print(f"pushed fixture to {shown_url} as {service}, ticket {ticket} (HTTP {status})")

    for slug, records in milestone_fixture(stamp=stamp).items():
        status = push(dest=Stream(loki=args.loki, service=slug), records=records, minutes_ago=MILESTONE_OFFSETS_MIN[slug])
    print(f"pushed the milestone fixture as {', '.join(MILESTONE_SLUGS)}, tickets MILE-{stamp}-1 to -4 (HTTP {status})")

    failed = 0
    deadline = time.time() + 30
    for name, key, extra, test in checks(ticket=ticket):
        q = targets(overrides={"service": service, "ticket": ticket, **extra})[key]
        while True:
            ok, detail = test(run(q, loki=args.loki))
            if ok or time.time() > deadline:
                break
            time.sleep(1)
        failed += not ok
        print(f"{'pass' if ok else 'FAIL'}  {name}: {detail}")
    for name, key, picked, test in milestone_checks(stamp=stamp):
        q = scoped(targets(overrides={"ticket": picked, "hours_per_ticket": str(HOURS_PER_TICKET)})[key], stamp=stamp)
        while True:
            ok, detail = test(run(q, loki=args.loki))
            if ok or time.time() > deadline:
                break
            time.sleep(1)
        failed += not ok
        print(f"{'pass' if ok else 'FAIL'}  {name}: {detail}")
    total_checks = len(checks(ticket=ticket)) + len(milestone_checks(stamp=stamp))
    print(f"{failed} of {total_checks} checks failed" if failed else "all checks pass")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
