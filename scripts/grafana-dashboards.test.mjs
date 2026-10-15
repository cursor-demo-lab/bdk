import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// observability/grafana/generate.py is the source of the four committed
// dashboard JSONs. These tests fail when a JSON is stale, when a file in that
// folder holds something shaped like a Grafana token or OTLP header, when a
// target leaves a template variable unresolved, and when a dashboard regresses
// on the conventions the README states (slug legends, counter_inc instead of
// rate/increase, neutral volume stats, estimate labelling, empty-default
// ticket). They need python3; without it they are skipped with a notice.

const DIR = fileURLToPath(new URL("../observability/grafana/", import.meta.url));
const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
const skip = python.status === 0 ? false : "python3 is not installed (run python3 observability/grafana/generate.py --check by hand)";

function run(args, cwd = DIR) {
  return spawnSync("python3", args, { cwd, encoding: "utf8" });
}

function findPromtool() {
  if (process.env.PROMTOOL) return process.env.PROMTOOL;
  for (const p of ["/tmp/prometheus-3.5.0.linux-amd64/promtool", "/usr/local/bin/promtool"]) {
    if (existsSync(p)) return p;
  }
  const which = spawnSync("sh", ["-c", "command -v promtool"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : "";
}

function findLoki() {
  if (process.env.FACTORY_LOKI_URL) return process.env.FACTORY_LOKI_URL;
  const probe = spawnSync("sh", ["-c", "curl -sf -m 1 http://127.0.0.1:3100/ready || true"], { encoding: "utf8" });
  if ((probe.stdout || "").includes("ready")) return "http://127.0.0.1:3100";
  return "";
}

const PROMTOOL = findPromtool();
const LOKI_URL = findLoki();
const skipPromtool = skip || (PROMTOOL ? false : "promtool not on PATH or /tmp/prometheus-3.5.0.linux-amd64 (Loki/promtool factory tests are not in repo CI)");
const skipLoki = skip || (LOKI_URL ? false : "Loki not at FACTORY_LOKI_URL or http://127.0.0.1:3100 (not in repo CI)");

const FILES = { "factory-business": "factory-business.json", "factory-ops": "factory-ops.json" };
const BUSINESS = "factory-business";
const OPS = "factory-ops";
const dashboards = Object.entries(FILES).map(([uid, file]) => ({ uid, file, json: JSON.parse(readFileSync(join(DIR, file), "utf8")) }));

function panels(dash) {
  return dash.panels.flatMap((p) => (p.type === "row" ? p.panels : [p]));
}

function targets(dash) {
  return panels(dash).flatMap((p) => (p.targets ?? []).map((t) => ({ panel: p, target: t, ds: (t.datasource ?? p.datasource ?? {}).type })));
}

test("generate.py --check: committed dashboards match the generator and no file holds a secret", { skip }, () => {
  const out = run(["generate.py", "--check"]);
  assert.equal(out.status, 0, `generate.py --check failed:\n${out.stdout}${out.stderr}`);
});

test("docs and dashboards do not claim when Loki's last point covers now", () => {
  const files = ["generate.py", "README.md", ...Object.values(FILES)];
  const banned = [
    /Loki's last point/i,
    /Loki legend sums/i,
    /align_queries_with_step/,
    /last point covers now/i,
    /bars are full-width \(the last one is not a shorter stub\)/,
    /the last bar is the in-progress bucket \(full width, not a shorter stub\)/,
  ];
  for (const file of files) {
    const text = readFileSync(join(DIR, file), "utf8");
    for (const re of banned) {
      assert.equal(re.test(text), false, `${file} matches ${re}`);
    }
  }
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  const gen = readFileSync(join(DIR, "generate.py"), "utf8");
  for (const text of [readme, gen]) {
    assert.match(text, /first bar starts at the first\s+step boundary at or after the range start/);
    assert.match(text, /On a live range \(to = now\) the last bar is the in-progress bucket/);
    assert.match(text, /On a range that ends before now, the last bar covers its whole bucket/);
    assert.doesNotMatch(text, /clipped at now/);
  }
  assert.match(readme, /Mimir never caches a negative-offset query/);
  assert.match(readme, /unless resets\(/);
  assert.match(readme, /min_over_time/);
  assert.match(readme, /vector\(time\(\)\) >= \$\{__from:date:seconds\}/);
  assert.match(readme, /vector\(time\(\)\) <= \$\{__to:date:seconds\}/);
  assert.match(readme, /\[w:\$\{prom_res\}\] offset -w/);
  assert.match(gen, /FROM_CAP = "\$\{__from:date:seconds\}"/);
  assert.match(gen, /TO_CAP = "\$\{__to:date:seconds\}"/);
  assert.match(gen, /PROM_RES = "\$\{prom_res\}"/);
  assert.match(gen, /min_over_time\(/);
  assert.match(gen, /vector\(time\(\)\) >= \{FROM_CAP\}/);
  assert.match(gen, /vector\(time\(\)\) <= \{TO_CAP\}/);
  assert.match(gen, /window\.res or PROM_RES|subquery_step\(window\)/);
});

test("verify.py --offline: every target interpolates with the dashboards' variable defaults", { skip }, () => {
  const out = run(["verify.py", "--offline"]);
  assert.equal(out.status, 0, `verify.py --offline failed:\n${out.stdout}${out.stderr}`);
});

test("verify.py now/d, last_over_time service probe, and frame_value skip Time", { skip }, () => {
  const src = readFileSync(join(DIR, "verify.py"), "utf8");
  assert.match(src, /now\/d/);
  assert.match(src, /last_over_time\(\{metric\}\[\$__range\]\)/);
  assert.match(src, /RANGE_TOTAL_SPANS/);
  assert.match(src, /--ranges/);
  const py = run(["-c", [
    "import sys",
    "sys.path.insert(0, '.')",
    "import verify",
    "from grafana_client import TimeRange",
    "frm, to, _ = verify.panel_window({'timeFrom': 'now/d'}, span=TimeRange(frm='now-24h', to='now'), variables={})",
    "assert frm == 'now/d', frm",
    "assert 0 <= verify.relative_seconds('now/d') < 86400",
    "inner = verify.variable_promql('label_values(apj_factory_delivery_total, service_name)')",
    "assert 'last_over_time' in inner and '$__range' in inner, inner",
    "ts = 1759536000000",
    "frame = {'frames': [{'schema': {'fields': [{'name': 'Time', 'type': 'time'}, {'name': 'Value', 'type': 'number'}]}, 'data': {'values': [[ts], [12]]}}]}",
    "assert verify.frame_value(frame) == 12",
    "bare = {'frames': [{'schema': {'fields': [{'name': 'Time'}, {'name': 'Value'}]}, 'data': {'values': [[ts], [12]]}}]}",
    "assert verify.frame_value(bare) == 12",
    "print('ok')",
  ].join("\n")]);
  assert.equal(py.status, 0, `${py.stdout}${py.stderr}`);
});

test("no function has an unannotated parameter (except self/cls) or two adjacent same-type parameters", { skip }, () => {
  const script = join(DIR, "tools/param_rule.py");
  const tmp = mkdtempSync(join(tmpdir(), "ast-ann-"));
  try {
    const sample = join(tmp, "samples.py");
    writeFileSync(sample, [
      "from dataclasses import dataclass",
      "def optional_pair(a: str, b: str | None):",
      "    pass",
      'def quoted_pair(a: "str", b: str):',
      "    pass",
      "def union_pair(a: str, b: Union[str, None]):",
      "    pass",
      "def typing_pair(a: str, b: typing.Optional[str]):",
      "    pass",
      "def t_pair(a: str, b: t.Optional[str]):",
      "    pass",
      "def optional_ok(a: str, b: int | None):",
      "    pass",
      "@dataclass(frozen=True)",
      "class Pair:",
      "    a: str",
      "    b: str",
      "",
    ].join("\n"));
    const samples = run([script, "--annotations", sample]);
    assert.equal(samples.status, 1, samples.stderr);
    const found = JSON.parse(samples.stdout);
    assert.ok(found.some((row) => /optional_pair\(a, b\): annotation str/.test(row)),
      `str vs str | None must be caught: ${JSON.stringify(found)}`);
    assert.ok(found.some((row) => /quoted_pair\(a, b\): annotation str/.test(row)),
      `"str" vs str must be caught: ${JSON.stringify(found)}`);
    assert.ok(found.some((row) => /union_pair\(a, b\): annotation str/.test(row)),
      `str vs Union[str, None] must be caught: ${JSON.stringify(found)}`);
    assert.ok(found.some((row) => /typing_pair\(a, b\): annotation str/.test(row)),
      `str vs typing.Optional[str] must be caught: ${JSON.stringify(found)}`);
    assert.ok(found.some((row) => /t_pair\(a, b\): annotation str/.test(row)),
      `str vs t.Optional[str] must be caught: ${JSON.stringify(found)}`);
    assert.ok(found.some((row) => /Pair: @dataclass must set kw_only=True/.test(row)),
      `dataclass without kw_only must be caught: ${JSON.stringify(found)}`);
    assert.ok(!found.some((row) => row.includes("optional_ok")),
      `str vs int | None must stay allowed: ${JSON.stringify(found)}`);
    const selfTest = run([script, "--self-test"]);
    assert.equal(selfTest.status, 0, selfTest.stdout);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const files = [...readdirSync(DIR), ...readdirSync(join(DIR, "tools")).map((f) => `tools/${f}`)].filter((f) => f.endsWith(".py"));
  const out = run([script, "--annotations", ...files.map((f) => (f.startsWith("tools/") ? f : f))]);
  assert.equal(out.status, 0, `${out.stderr}\n${out.stdout}`);
  assert.deepEqual(JSON.parse(out.stdout), [], "every parameter except self/cls must be annotated; adjacent parameters must not share a type");
});

test("the Python helpers take one positional parameter at most; the rest are keyword-only (no swappable pairs)", { skip }, () => {
  const script = join(DIR, "tools/param_rule.py");
  const tmp = mkdtempSync(join(tmpdir(), "ast-pos-"));
  try {
    const sample = join(tmp, "ctor.py");
    writeFileSync(sample, [
      "from dataclasses import dataclass",
      "@dataclass(frozen=True, kw_only=True)",
      "class Pair:",
      "    a: str",
      "    b: str",
      "Pair('x', 'y')",
      "",
    ].join("\n"));
    const injected = run([script, "--positional", sample]);
    assert.equal(injected.status, 1, injected.stdout);
    const found = JSON.parse(injected.stdout);
    assert.ok(found.some((row) => /Pair\(2 positional\)/.test(row)),
      `positional dataclass call must be caught: ${JSON.stringify(found)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const files = [...readdirSync(DIR), ...readdirSync(join(DIR, "tools")).map((f) => `tools/${f}`)].filter((f) => f.endsWith(".py"));
  assert.ok(files.length >= 6, files.join(" "));
  const out = run([script, "--positional", ...files]);
  assert.equal(out.status, 0, `${out.stderr}\n${out.stdout}`);
  assert.deepEqual(JSON.parse(out.stdout), [], "make every parameter after the first keyword-only (def f(first, *, ...))");
});

test("the secret scan flags token shapes, a literal bearer, an OTLP Basic header, and a UUID", { skip }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "grafana-secret-scan-"));
  try {
    const filler = "A1b2C3d4E5f6G7h8J9k0";
    const samples = [
      `token = "${"gl" + "sa_"}${filler}_0123abcd"`,
      `${"gl" + "c_"}${filler}${filler}==`,
      `curl -H "Authorization: Bearer ${filler}"`,
      `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic ${Buffer.from(`123456:${filler}`).toString("base64")}`,
      `instance="${["0f8fad5b", "d9cb", "469f", "a165", "70867728950e"].join("-")}"`,
    ];
    samples.forEach((line, i) => writeFileSync(join(scratch, `sample-${i}.txt`), `${line}\n`));
    writeFileSync(join(scratch, "clean.sh"), "printf 'Authorization: Bearer %s\\n' \"$TOKEN\" | curl -H @- \"$URL\"\n");
    const out = run(["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(DIR)}); import generate; print(json.dumps(generate.secret_findings(${JSON.stringify(scratch)})))`]);
    assert.equal(out.status, 0, out.stderr);
    const findings = JSON.parse(out.stdout);
    for (let i = 0; i < samples.length; i += 1) {
      assert.ok(findings.some((f) => f.startsWith(`sample-${i}.txt:`)), `sample ${i} was not flagged: ${samples[i]}`);
    }
    assert.ok(!findings.some((f) => f.startsWith("clean.sh")), "apply.sh's header-on-stdin form was flagged");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("two dashboards, each with the Factory dropdown, 24 h default, browser timezone, 5 m refresh, unique panel ids", () => {
  assert.deepEqual(dashboards.map((d) => d.uid), [BUSINESS, OPS]);
  for (const { uid, json } of dashboards) {
    assert.equal(json.uid, uid);
    assert.equal(json.links.length, 1, `${uid} links`);
    assert.equal(json.links[0].title, "Factory", `${uid} Factory dropdown`);
    assert.equal(json.links[0].asDropdown, true, `${uid} Factory dropdown`);
    assert.equal(json.links[0].type, "dashboards", `${uid} Factory dropdown`);
    assert.ok((json.links[0].tags ?? []).includes("software-factory"), `${uid} Factory tags`);
    assert.ok(json.links[0].keepTime && json.links[0].includeVars, `${uid} links keep time and vars`);
    assert.ok(json.tags.includes("software-factory"), `${uid} is tagged software-factory so the dropdown lists it`);
    assert.equal(json.timezone, "browser");
    assert.deepEqual(json.time, { from: "now-24h", to: "now" });
    assert.equal(json.refresh, "5m");
    const ids = [...json.panels.filter((p) => p.type === "row"), ...panels(json)].map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, `${uid} panel ids are unique`);
  }
  assert.equal(byUid(BUSINESS).title, "Factory business");
  assert.equal(byUid(OPS).title, "Factory ops");
  // The four retired uids are gone from the repo and named for apply.sh to delete.
  const src = readFileSync(join(DIR, "generate.py"), "utf8");
  assert.match(src, /RETIRED_UIDS = \("factory-overview", "factory-traces", "factory-logs", "factory-cost-tokens"\)/);
  for (const old of ["factory-overview.json", "factory-traces.json", "factory-logs.json", "factory-tokens.json"]) {
    assert.ok(!existsSync(join(DIR, old)), `${old} must be deleted`);
  }
  const apply = readFileSync(join(DIR, "apply.sh"), "utf8");
  assert.match(apply, /DASHBOARDS=\(factory-business\.json factory-ops\.json\)/);
  assert.match(apply, /RETIRED_UIDS=\(factory-overview factory-traces factory-logs factory-cost-tokens\)/);
  assert.match(apply, /api DELETE "\/api\/dashboards\/uid\/\$uid"/, "retired uids are deleted by uid");
  assert.ok(apply.indexOf('if [ "$rc" != "0" ]; then') < apply.indexOf("api DELETE"), "deletes run only after every upsert succeeded");
  assert.doesNotMatch(apply, /DELETE "\/api\/folders/, "never deletes a folder");
});

test("every panel has a description and no title shows a raw regex", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      assert.ok((p.description ?? "").length > 20, `${uid} / ${p.title}: no description`);
      assert.doesNotMatch(p.title, /\.\+|\.\*/, `${uid} / ${p.title}: raw regex in the title`);
    }
  }
});

test("Prometheus targets use service_name, never job or instance, and count with counter_inc, never rate() or increase()", () => {
  for (const { uid, json } of dashboards) {
    for (const { panel, target, ds } of targets(json)) {
      if (ds !== "prometheus") continue;
      const where = `${uid} / ${panel.title} (${target.refId})`;
      assert.doesNotMatch(target.expr, /\bjob\s*=|\binstance\s*=|__name__/, `${where}: job, instance or a __name__ regex`);
      // increase() is allowed only as counter_inc's resets()>0 fallback and
      // in the left-edge restart branch (increase(raw) gated on resets == 1).
      const outsideFallback = target.expr
        .replace(/\(increase\([\s\S]*?\) and \(resets\([\s\S]*?\) == 1\)\)/g, "EDGE_GATE")
        .replace(
          /unless \(resets\([\s\S]*?\) > 0\) or increase\([\s\S]*?\)/g,
          "RESET_GATE",
        )
        // merged_tickets(): increase() as an existence test only (`> 0`, row pinned to 1); a restarted
        // worker's re-created series is caught by the first-appearance arm, never double-counted.
        .replace(/max by \(factory_ticket_key\) \(increase\([\s\S]*?\)\) > 0/g, "MERGE_GATE");
      assert.doesNotMatch(outsideFallback, /\b(rate|increase|irate|sum_over_time)\(/, `${where}: rate/increase/sum_over_time on raw per-VM series`);
      assert.doesNotMatch(target.expr, /\bsum(?: by \([^)]*\))? \((?:apj_|agent_sdk_|cursor_|traces_)/, `${where}: aggregated before counter_inc`);
      assert.doesNotMatch(target.expr, /cursor_cost_usage|cursor_model_name|cache_creation|agent_sdk_subagent/, `${where}: a metric the dashboards must not read`);
      assert.doesNotMatch(target.legendFormat ?? "", /\{\{\s*job\s*\}\}/, `${where}: job in the legend`);
    }
  }
});

test("coverage audit 2026-10-03: zero baselines, no means on two-writer histograms, no per-VM breakdowns, own spans only", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      const where = `${uid} / ${p.title}`;
      const exprs = (p.targets ?? []).map((t) => t.expr ?? t.query ?? "");
      for (const e of exprs) {
        assert.doesNotMatch(e, /by \([^)]*\b(instance|service_instance_id)\b/, `${where}: a per-instance breakdown`);
        assert.doesNotMatch(e, /_milliseconds_sum|_milliseconds_count\{[^}]*\}\[[^\]]*\]\) \/|traces_spanmetrics_latency_bucket/, `${where}: a mean on two-writer histograms or a classic bucket on a native histogram`);
        for (const m of e.matchAll(/or increase\((\w+)\{/g)) assert.match(m[1], /_total$/, `${where}: the reset fallback on a histogram part`);
        if (/status = error|duration > /.test(e)) assert.match(e, /name =~? "/, `${where}: a generic Tempo table that includes context-tracer spans`);
      }
      if (p.type !== "stat") continue;
      const d = p.fieldConfig.defaults;
      // Tempo (TraceQL) and server-side expression targets have no or vector(0); the baseline rule is PromQL/LogQL's.
      const metricExprs = (p.targets ?? []).filter((t) => typeof t.expr === "string").map((t) => t.expr);
      const division = metricExprs.some((e) => / \/ /.test(e) && !/ \/ 1e6$/.test(e));
      if (d.unit === "percentunit") assert.ok(metricExprs.every((e) => e.includes("or vector(0)")), `${where}: a ratio without an or vector(0) numerator`);
      if (["short", "none"].includes(d.unit) && !division) assert.ok(metricExprs.every((e) => e.includes("or vector(0)")), `${where}: a count stat without a zero baseline`);
    }
  }
  const ops = panels(byUid(OPS)).map((p) => p.title);
  for (const title of ["Deliveries in logs by service and event type (Loki)", "Cross-check per service: metric vs logs"]) {
    assert.ok(ops.includes(title), `the Loki delivery cross-check "${title}" is missing`);
  }
  assert.match(byUid(OPS).description, /Prometheus counts are approximate/);
  const cross = byUid(OPS).panels.find((p) => p.type === "row" && /^Debug: deliveries by kind and outcome/.test(p.title));
  assert.ok(cross?.collapsed, "the delivery cross-check row should start collapsed");
  assert.ok(cross.panels.some((p) => p.title === "Cross-check per service: metric vs logs"), "the cross-check sits in that Debug row");
});

test("count caveats say totals can read high after an instance-id change; Loki/Tempo are the reference", () => {
  const caveat = /Counter totals can read high after a host changes instance id; Loki\/Tempo are the reference/;
  const texts = dashboards.flatMap(({ uid, json }) => [
    ...json.panels.filter((p) => p.type === "row").map((r) => ({ uid, title: r.title, text: r.title })),
    ...panels(json).map((p) => ({ uid, title: p.title, text: `${p.title}\n${p.description ?? ""}\n${p.options?.content ?? ""}` })),
  ]);
  for (const { uid, title, text } of texts) {
    assert.doesNotMatch(text, /405s 57 vs 41/, `${uid} / ${title}: sampled-span comparison`);
    assert.doesNotMatch(text, /this loss stops/i, `${uid} / ${title}`);
  }
  const deliveries = panels(byUid(OPS)).find((p) => p.title === "Deliveries" && p.type === "stat").description;
  assert.match(deliveries, caveat);
  const tokenCheck = panels(byUid(OPS)).find((p) => p.title === "Cross-check: tokens in logs vs metric (range)");
  assert.match(tokenCheck.description, caveat);
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  assert.match(readme, /\*\*Prometheus counts are approximate\.\*\*/);
  assert.match(readme, /\*\*One id per process life, no rebase\.\*\*/);
  assert.match(readme, /invalid\s+temporality and type combination/, "why the metrics are cumulative");
  assert.match(readme, /returns 22 for a true 12/);
  assert.match(readme, /Grafana 12\.2 OSS does not register `filterFields`/);
  assert.doesNotMatch(readme, /405s 57 vs 41/);
  assert.doesNotMatch(readme, /this loss stops|counts are lower bounds|Counter totals are lower bounds/);
  assert.match(readme, /0\.2\.20 dropped `cursor\.cost\.usage`|No USD cost metric after July 0\.2\.20/);
  assert.doesNotMatch(readme, /No real cost or model reaches Grafana/);
});

test("no instance or model variable; ticket is an empty-default textbox; service lists service_name", () => {
  for (const { uid, json } of dashboards) {
    const vars = json.templating.list;
    assert.ok(!vars.some((v) => ["instance", "model"].includes(v.name)), `${uid}: instance/model variable`);
    const service = vars.find((v) => v.name === "service");
    // A static custom variable: label_values() hides an idle slug, and the
    // dashboards must always list all six factory services.
    assert.equal(service.type, "custom", `${uid}: service variable is static`);
    assert.equal(service.multi, true);
    assert.equal(service.includeAll, true);
    assert.deepEqual(service.options.map((o) => o.value), [
      "factory-desk", "factory-planner", "factory-worker",
      "factory-pr-autofixer", "factory-security-reviewer", "factory-triage-jira",
    ], `${uid}: all six factory slugs`);
    assert.equal(service.allValue, ".*");
    const ticket = vars.find((v) => v.name === "ticket");
    if (ticket) {
      assert.equal(ticket.type, "textbox");
      assert.equal(ticket.current.value, "", `${uid}: ticket default is not empty`);
    }
  }
});

test("stat colours: volume stats are neutral; ratios, latency and estimates never show 0 for no data", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "stat")) {
      const d = p.fieldConfig.defaults;
      const where = `${uid} / ${p.title}`;
      assert.ok(d.thresholds?.steps?.length >= 1, `${where}: no explicit thresholds (Grafana's default 80 would colour it)`);
      if (["percentunit", "ms", "currencyUSD"].includes(d.unit)) assert.notEqual(d.noValue, "0", `${where}: 0 for no data`);
      if (d.color?.mode === "fixed") assert.ok(d.thresholds.steps.every((s) => s.color === d.color.fixedColor), `${where}: neutral stat with coloured steps`);
    }
  }
});

// Titles that carry "est." themselves: Simon's per-ticket cost line, and the Business strip tiles, which sit in the
// Delivery row rather than under an "(estimate)" row heading.
const EST_TITLES = new Set(["Cost per merged ticket", "Spend", "Cost per merge", "Cumulative spend", "Spend by service", "Cost by ticket"]);

test("every cost panel is an estimate in USD with the price source in its description", () => {
  const caveat = /ESTIMATE, not billing.*cursor\.com\/docs\/models-and-pricing.*2026-10-03/s;
  const businessCaveat = /list-price estimate from token counts, not the invoice/;
  assert.match(byUid(BUSINESS).description, businessCaveat, "the Business description carries the estimate caveat once");
  for (const [uid, rowRe] of [[BUSINESS, /^Cost$/], [OPS, /^Debug: cost$/]]) {
    const costRow = byUid(uid).panels.find((p) => p.type === "row" && rowRe.test(p.title));
    assert.ok(costRow, `${uid}: cost row ${rowRe}`);
  }
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      const usd = p.fieldConfig?.defaults?.unit === "currencyUSD";
      if (usd || /cost/i.test(p.title)) {
        if (!EST_TITLES.has(p.title)) {
          assert.doesNotMatch(p.title, /Estimated|\best\.|\(estimate\)/,
            `${uid} / ${p.title}: drop est. from panel titles; the row and dashboard already say estimate`);
        }
        if (p.type !== "table") {
          assert.ok(usd, `${uid} / ${p.title}: not in currencyUSD`);
        }
        assert.match(p.description, uid === OPS ? caveat : businessCaveat, `${uid} / ${p.title}: no source or date`);
      }
    }
  }
});

// Two input shapes (README "Two input shapes"): a host turn reports input gross (cache reads inside it), a cloud
// turn reports it net of cache reads, and no label tells them apart. Uncached input is decided per series before
// any sum: `sum without (cursor_token_type)` on each type so input and cache_read match one-to-one, then
// input - ((cache_read <= input) or 0 * input): cache reads come off only where they fit inside the series' input.
const PER_SERIES = String.raw`sum without \(cursor_token_type\) \((?:(?!sum without).)*?cursor_token_type="%s"(?:(?!sum without).)*?\)`;
const perSeries = (kind) => PER_SERIES.replace("%s", kind);
const UNCACHED_RE = new RegExp(String.raw`label_replace\(sum(?: by \([^)]*\))? \(${perSeries("input")} - \(\(${perSeries("cache_read")} <= ${perSeries("input")}\) or 0 \* ${perSeries("input")}\)\) \* \$price_input, "part", "uncached_input"`, "s");

test("token input has two shapes: uncached input is decided per series (input - cache_read where cache_read <= input, else input), never summed first; cache reads priced once", () => {
  let priced = 0;
  for (const { uid, json } of dashboards) {
    for (const { panel, target } of targets(json)) {
      const expr = target.expr ?? "";
      for (const [, types] of expr.matchAll(/cursor_token_type=~"([^"]*)"/g)) {
        const kinds = types.split("|");
        assert.ok(!(kinds.includes("input") && kinds.includes("cache_read")), `${uid} / ${panel.title}: sums input and cache_read (${types})`);
        assert.ok(!kinds.includes("reasoning"), `${uid} / ${panel.title}: adds reasoning, which is inside output`);
      }
      if (expr.includes("$price_")) {
        priced++;
        assert.match(expr, UNCACHED_RE, `${uid} / ${panel.title}: uncached input is not the per-series form`);
        assert.doesNotMatch(expr, /clamp_min\(sum by \([^)]*\) \(\(\(clamp_min\(max_over_time\(cursor_token_usage_total\{[^}]*cursor_token_type="input"/,
          `${uid} / ${panel.title}: sums input over every series before subtracting cache reads (prices a cloud turn's input at 0)`);
        assert.match(expr, /cursor_token_type="cache_read".*\* \$price_cache_read, "part", "cache_read"/s, `${uid} / ${panel.title}: no cache-read term`);
        if (uid === OPS) {
          assert.match(panel.description, /two shapes|Two input shapes/, `${uid} / ${panel.title}: description does not name the two input shapes`);
        }
      } else if (/^Uncached$|^Tokens per bucket: uncached/.test(panel.title) && target.refId === "A") {
        assert.match(expr, new RegExp(String.raw`sum(?: by \([^)]*\))? \(${perSeries("input")} - \(\(${perSeries("cache_read")} <= ${perSeries("input")}\) or 0 \* ${perSeries("input")}\)\)`, "s"),
          `${uid} / ${panel.title}: uncached tokens are not the per-series form`);
      }
      if (/Cache read share/.test(panel.title)) assert.doesNotMatch(expr, /\/ .*cache_read/s, `${uid} / ${panel.title}: share denominator includes cache_read`);
    }
  }
  assert.ok(priced >= 10, `expected every cost panel to be priced (${priced})`);
  const gen = readFileSync(join(DIR, "generate.py"), "utf8");
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  for (const text of [gen, readme]) {
    assert.match(text, /toCatalogDisjointUsage/, "the July precedent is named");
    assert.match(text, /187,541/, "TLSSN-60's planner input (the net shape) is quoted");
    assert.match(text, /1,191,168/, "TLSSN-60's planner cache reads are quoted");
    assert.match(text, /(classified|read) as (a whole|gross)/, "the residual risks are stated");
  }
  assert.match(readme, /\*\*Two input shapes\.\*\*/);
  assert.match(readme, /`sum by \(…\) \(I - \(\(C <= I\) or 0 \* I\)\)`/, "the README gives the per-series PromQL form");
  assert.doesNotMatch(readme, /\*\*Input is gross: it includes cache reads\.\*\*/, "the one-shape claim is gone");
});

// Raw console bodies, as they reach Loki once the factory's console bridge stops parsing lines into attributes.
const RAW = {
  admission: "[bdk] hosted admission received deliveryId=raw-d1 channelId=C1 channelKind=jira eventType=jira:issue_updated sessionMode=live",
  injectFailed: "[bdk] hosted enqueue inject failed deliveryId=raw-d2: socket hang up",
  planner: "[planner] TLSSN-5 stopped without a plan (jira): no_scope",
  json: JSON.stringify({ desk: "intake_root", issueKey: "TLSSN-5", outcome: "skipped", why: "filed_in_slack_unbound" }),
  // A bridge that sends util.format(...args) as the body: an error line and its stack, over several lines.
  stack: "[factory-desk] hop-watch for TLSSN-5 failed: Error: socket hang up deliveryId=raw-d3\n    at hopWatch (/app/hop-watch.js:41:11)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
};
const FACTORY_KEYS = ["factory_event", "issueKey", "factoryKey", "deliveryId", "eventType", "outcome", "reason", "via", "wake", "pr"];

function lokiTargets() {
  return dashboards.flatMap(({ uid, json }) => targets(json).filter(({ ds, target }) => ds === "loki" && target.expr).map((t) => ({ uid, ...t })));
}

test("Loki panels parse factory fields from raw bodies: [bdk] key=value lines and JSON lines", () => {
  // The distinct-deliveryId query (FACTORY_FIELDS over every log shape) is refId B of the Ops cross-check table.
  const expr = panels(byUid(OPS)).find((p) => p.title === "Cross-check per service: metric vs logs").targets.find((t) => t.refId === "B").expr;
  const regexps = [...expr.matchAll(/\| regexp `([^`]+)`/g)].map(([, re]) => new RegExp(re.replaceAll("(?P<", "(?<")));
  const parse = (line) => Object.assign({}, ...regexps.map((re) => re.exec(line)?.groups ?? {}));
  assert.deepEqual(parse(RAW.admission), { r_deliveryId: "raw-d1", r_eventType: "jira:issue_updated" });
  assert.deepEqual(parse(RAW.injectFailed), { r_deliveryId: "raw-d2" }, "the ':' after an id is July's punctuation, not the id");
  assert.deepEqual(parse(RAW.json), {});
  assert.deepEqual(parse(RAW.stack), { r_deliveryId: "raw-d3" }, "a value at a line break ends there");

  // JSON lines: every key the factory's bridge turns into a field is extracted, and the event is the first event key.
  const jsonKeys = Object.fromEntries([...expr.match(/\| json ([^|]+)/)[1].matchAll(/(\w+)="(\w+)"/g)].map(([, label, key]) => [key, label]));
  const otel = readFileSync(fileURLToPath(new URL("../factory-desk/agent/lib/factory-otel.ts", import.meta.url)), "utf8");
  // While the console bridge still parses lines, its event keys must all be read; once it no longer does, the
  // generator's list stands alone.
  const bridged = otel.match(/LOG_EVENT_KEYS[^=]*= new Set\((\[[^\]]*\])\)/);
  const eventKeys = Object.keys(jsonKeys).filter((k) => !["issueKey", "factoryKey", "outcome", "reason", "why", "via", "wake", "pr", "deliveryId", "eventType"].includes(k));
  if (bridged) assert.deepEqual(eventKeys, JSON.parse(bridged[1]), "| json event keys differ from the bridge's LOG_EVENT_KEYS");
  for (const key of ["desk", "worker", "issueKey", "factoryKey", "outcome", "deliveryId", "eventType"]) assert.ok(jsonKeys[key], `| json does not extract ${key}`);
  const template = (name) => expr.match(new RegExp(`${name}=\`\\{\\{ or ([^}]*) \\}\\}\``))[1].trim().split(/\s+/);
  assert.deepEqual(template("f_event"), [".factory_event", ...eventKeys.map((k) => `.${jsonKeys[k]}`)]);
  assert.deepEqual(template("f_delivery"), [".deliveryId", `.${jsonKeys.deliveryId}`, ".r_deliveryId"]);
  // Many factory JSON lines give their reason code as `why` (intake_root's filed_in_slack_unbound, threw, timeout).
  assert.deepEqual(template("f_reason"), [".reason", `.${jsonKeys.reason}`, `.${jsonKeys.why}`]);
  const line = JSON.parse(RAW.json);
  const event = template("f_event").map((ref) => line[Object.keys(jsonKeys).find((k) => `.${jsonKeys[k]}` === ref)]).find(Boolean);
  assert.equal(event, "intake_root");
  assert.match(expr, /\| drop __error__, __error_details__/, "non-JSON lines would fail the metric query with JSONParserErr");
});

test("no Loki query filters or groups on a bare factory key: each reads the f_* field that covers both log shapes", () => {
  for (const { uid, panel, target } of lokiTargets()) {
    const outside = target.expr.replace(/`[^`]*`/g, "``");
    for (const key of FACTORY_KEYS) {
      assert.doesNotMatch(outside, new RegExp(`\\|\\s*${key}\\s*(=|!=|=~|!~)`), `${uid} / ${panel.title}: filters on ${key}`);
      assert.doesNotMatch(outside, new RegExp(`by \\([^)]*\\b${key}\\b`), `${uid} / ${panel.title}: groups by ${key}`);
    }
    if (/\bf_\w+/.test(outside)) assert.match(target.expr, /\| json .*\| label_format f_event=/s, `${uid} / ${panel.title}: uses f_* without FACTORY_FIELDS`);
  }
});

test("the Tag lines toggle hides raw [tag] lines and tag:<tag> lines, and nothing else", () => {
  const logs = byUid(OPS);
  const toggle = logs.templating.list.find((v) => v.name === "tag_lines");
  const hide = new RegExp(toggle.options.find((o) => o.text.startsWith("Hide")).value);
  for (const line of ["tag:bdk", "tag:bdk/slack", RAW.admission, RAW.injectFailed, RAW.planner, RAW.stack, "[bdk/slack] warn setTitle not-ok"]) assert.match(line, hide);
  for (const line of [RAW.json, "turn.completed", "factory.desk", "factory.log"]) assert.doesNotMatch(line, hide);
  assert.equal(toggle.current.value, toggle.options.find((o) => o.text.startsWith("Hide")).value);
  for (const { panel, target } of targets(logs)) if (target.expr?.includes("$tag_lines")) assert.match(target.expr, /!~ `\$tag_lines`/, `${panel.title}: the regex needs a raw string`);
  for (const p of panels(logs)) assert.doesNotMatch(p.description ?? "", /carry no values/i, `${p.title}: raw bodies carry values`);
});

test("level filters ignore case: the bridge's WARN / ERROR lines keep severity_text's case in detected_level", () => {
  const levels = [];
  for (const { uid, panel, target } of lokiTargets()) {
    for (const [, re] of target.expr.matchAll(/detected_level\s*=~\s*"([^"]*)"/g)) {
      levels.push(re);
      assert.match(re, /^\(\?i\)/, `${uid} / ${panel.title}: case-sensitive level filter ${re}`);
      const anchored = new RegExp(`^(?:${re.replace("(?i)", "")})$`, "i");
      for (const level of ["WARN", "ERROR", "warn", "error", "Warning", "CRITICAL"]) assert.match(level, anchored);
      for (const level of ["INFO", "info", "debug", "warnings"]) assert.doesNotMatch(level, anchored);
    }
    assert.doesNotMatch(target.expr, /by \([^)]*\bdetected_level\b/, `${uid} / ${panel.title}: groups on detected_level; group on the lower-cased level`);
  }
  assert.ok(levels.length >= 3, "the Logs error and warning panels filter on detected_level");
  const logs = byUid(OPS);
  const byLevel = panels(logs).find((p) => p.title === "Log lines per bucket by level").targets[0].expr;
  assert.match(byLevel, /label_format level=`\{\{ regexReplaceAll "\^warning\$" \(lower \.detected_level\) "warn" \}\}`/);
});

test("tools/rawbody_check.py refuses a Loki URL with credentials and never prints it", { skip }, () => {
  const secret = "s3cr3t-" + "probe";
  const out = run(["tools/rawbody_check.py", "--loki", `http://admin:${secret}@127.0.0.1:9`]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /refusing/);
  assert.ok(!`${out.stdout}${out.stderr}`.includes(secret), "the password was printed");
});

test("every PromQL and LogQL division guards its denominator, so zero traffic is no result, not NaN or +Inf", () => {
  let divisions = 0;
  for (const { uid, panel, target } of dashboards.flatMap(({ uid, json }) => targets(json).filter(({ ds }) => ["prometheus", "loki"].includes(ds)).map((t) => ({ uid, ...t })))) {
    const expr = target.expr ?? "";
    for (const at of [...expr.matchAll(/\) \/ /g)].map((m) => m.index + 4)) {
      // `/ on (label)` vector matching may sit between the division and its denominator.
      const rest = expr.slice(at).replace(/^on \([^)]*\) /, "");
      if (/^1e6\b/.test(rest) || /^1000\b/.test(rest)) continue;
      divisions += 1;
      assert.match(rest, /^\(/, `${uid} / ${panel.title}: unguarded denominator`);
      let depth = 0, end = 0;
      for (; end < rest.length; end++) { if (rest[end] === "(") depth++; if (rest[end] === ")" && --depth === 0) break; }
      // Guarded: filtered to > 0, or pinned to exactly 1 (`* 0 + 1`, merged_tickets()), so never 0.
      assert.match(rest.slice(0, end + 1), /(?: > 0\)| \* 0 \+ 1\)+)$/, `${uid} / ${panel.title}: denominator not filtered to > 0`);
    }
  }
  assert.ok(divisions >= 10, `found ${divisions} divisions`);
});

test("every histogram_quantile is filtered to >= 0, so a quiet slug (all-zero buckets) is no result, not NaN", () => {
  let quantiles = 0;
  for (const { uid, panel, target } of dashboards.flatMap(({ uid, json }) => targets(json).filter(({ ds }) => ds === "prometheus").map((t) => ({ uid, ...t })))) {
    const expr = target.expr ?? "";
    const n = (expr.match(/histogram_quantile\(/g) ?? []).length;
    if (!n) continue;
    quantiles += n;
    assert.equal(n, 1, `${uid} / ${panel.title}: one quantile per target`);
    assert.match(expr, /\(histogram_quantile\(.+\)\) >= 0/, `${uid} / ${panel.title}: quantile not filtered to >= 0`);
  }
  assert.ok(quantiles >= 4, `found ${quantiles} quantiles`);
});

test("range stats share the bar subquery and first-sample / interleaved reset cases exist", { skip }, () => {
  const overview = byUid(OPS);
  const business = byUid(BUSINESS);
  const named = (dash, title) => panels(dash).find((p) => p.title === title);
  for (const [dash, title] of [
    [overview, "Turns"],
    [overview, "Cost"],
    [business, "Spend"],
    [overview, "Tokens and cost by service"],
  ]) {
    const p = named(dash, title);
    assert.ok(p, title);
    const expr = (p.targets ?? []).map((t) => t.expr).join("\n");
    assert.match(expr, /\[\$__range:\$\{prom_res\}\]/, `${title}: range stats need the same subquery as the bars`);
    assert.match(expr, /min_over_time\(/, `${title}: first-sample restart`);
  }
  const turns = named(overview, "Turns");
  assert.equal(turns.targets[0].instant, true);
  const res = overview.templating.list.find((v) => v.name === "prom_res");
  assert.ok(res, "prom_res variable");
  assert.equal(res.current.value, "1m");
  assert.equal(res.refresh, 2);
  assert.equal(res.hide, 2, "prom_res stays hidden; 1m is the JSON fallback");
  assert.match(res.definition, /^query_result\(/);
  assert.match(res.query.query, /^query_result\(/);
  assert.equal(res.query.qryType, 5);
  assert.match(res.definition, /604800/);
  assert.match(res.definition, /__to:date:seconds/);
  assert.doesNotMatch(res.definition, /\$__range_s/);
  const smooth = overview.templating.list.find((v) => v.name === "smooth");
  assert.ok(smooth, "smooth variable");
  assert.equal(smooth.current.value, "2m");
  assert.equal(smooth.hide, 2);
  assert.equal(smooth.query.qryType, 5);
  assert.match(smooth.definition, /smooth", "5m"/);
  assert.match(smooth.definition, /smooth", "2m"/);
  assert.match(turns.targets[0].expr, /max_over_time\([\s\S]*?\[\$\{smooth\}\]/);
  const checker = readFileSync(join(DIR, "tools/bucket_look_ahead_check.py"), "utf8");
  assert.match(checker, /first-sample restart, bucket-aligned/);
  assert.match(checker, /first-sample restart, unaligned from/);
  assert.match(checker, /Fixtures A, C, D/);
  assert.match(checker, /to=26m30s reads 1/);
  assert.match(checker, /to=26m30s range stat is 4/);
  assert.match(checker, /5m-grid range at to=26m30s/);
  assert.match(checker, /unaligned from=10m20s/);
  assert.match(checker, /idle lookback: empty last_over_time/);
  assert.match(checker, /def with_caps\(expr: str, \*, caps: Caps, res: str = "1m"\)/);
  assert.match(checker, /def five_min_grid_yaml/);
  assert.match(checker, /_samples_short_vm/);
  assert.match(checker, /_samples_5m_flip/);
  assert.match(checker, /_samples_3m_flip/);
  assert.match(checker, /_samples_5m_restart/);
  assert.match(checker, /M1-restart-past-max/);
});

test("look-ahead buckets include the last few minutes and do not inflate via increase() (tools/bucket_look_ahead_check.py; needs PROMTOOL)", { skip: skipPromtool }, () => {
  const args = ["tools/bucket_look_ahead_check.py", "--promtool", PROMTOOL];
  if (LOKI_URL) args.push("--loki", LOKI_URL);
  const out = run(args);
  assert.equal(out.status, 0, `bucket_look_ahead_check failed:\n${out.stdout}${out.stderr}`);
});

test("ratio, per-unit and quantile guards under promtool: busy reads, quiet and absent have no result (tools/promtool_ratio_check.py; needs PROMTOOL)", { skip: skipPromtool }, () => {
  const out = run(["tools/promtool_ratio_check.py", "--promtool", PROMTOOL]);
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
});

test("per-ticket cost: the README's expanded queries are the generator's, verbatim (cost_per_ticket, cost_per_merged_ticket, mean_cost_per_merged_ticket)", { skip }, () => {
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  const out = run(["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(DIR)}); import generate as g; print(json.dumps({"cost_per_ticket": g.cost_per_ticket(), "cost_per_merged_ticket": g.cost_per_merged_ticket(), "mean_cost_per_merged_ticket": g.mean_cost_per_merged_ticket(), "keyed_cost_per_merged_ticket": g.keyed_cost_per_merged_ticket(), "merged_tickets": g.merged_tickets()}))`]);
  assert.equal(out.status, 0, out.stderr);
  const generated = JSON.parse(out.stdout);
  for (const name of ["cost_per_ticket", "cost_per_merged_ticket", "mean_cost_per_merged_ticket"]) {
    const block = new RegExp(`<summary>[^<]*\\(<code>${name}\\(\\)</code>\\)</summary>\\n\\n\`\`\`promql\\n([^\`]+)\\n\`\`\``).exec(readme);
    assert.ok(block, `README has no expanded block for ${name}()`);
    assert.equal(block[1], generated[name], `${name}(): the README's expanded query differs from the generator's`);
  }
  // The operator's long-hand file (cost-per-ticket-final.promql) is the panel's two refs: the README quotes them
  // verbatim from factory-tokens.json, so the file can always be rebuilt from the generator.
  const tokens = byUid(OPS);
  const panel = panels(tokens).find((p) => p.title === "Cost per merged ticket");
  assert.ok(panel, "Cost per merged ticket panel");
  for (const [ref, legend] of [["A", /per 6h bucket \(merged in that 6h, 7d cost lookback\)/], ["B", /merged in trailing 24h, 7d cost lookback/]]) {
    const target = panel.targets.find((t) => t.refId === ref);
    assert.match(target.legendFormat, legend);
    const block = new RegExp(`cost-per-ticket-final\\.promql\`, ref ${ref}\\)[^\\n]*\\n\\n\`\`\`promql\\n([^\`]+)\\n\`\`\``).exec(readme);
    assert.ok(block, `README has no expanded block for the panel's ref ${ref}`);
    assert.equal(block[1], target.expr, `ref ${ref}: the README's expanded query differs from factory-tokens.json`);
    assert.match(target.expr, /^avg\(\(sum by \(factory_ticket_key\) \(label_replace\(sum by \(factory_ticket_key\) \(sum without \(cursor_token_type\)/, `ref ${ref}: per-series uncached input`);
    assert.ok((target.expr.match(/\[7d\]/g) ?? []).length >= 20, `ref ${ref}: 7d cost lookback on every token selector`);
    assert.match(target.expr, ref === "A" ? /apj_factory_ticket_merged_total\{[^}]*\}\[6h\]/ : /apj_factory_ticket_merged_total\{[^}]*\}\[1d\]\)\) > 0/, `ref ${ref}: merge window`);
  }
  // July's token counter grouped by the ticket label the hooks put on it; the denominator keeps Jira keys only; the division matches on the key.
  assert.match(generated.cost_per_ticket, /^sum by \(factory_ticket_key\) \(/);
  assert.ok((generated.cost_per_ticket.match(/cursor_token_usage_total\{/g) ?? []).length >= 5, "per-ticket cost reads July's cursor_token_usage_total, which carries factory_ticket_key");
  assert.doesNotMatch(generated.cost_per_ticket, /apj_factory_ticket_tokens/, "no factory-owned token instrument: the owner approved the label on July's metrics and spans");
  assert.match(generated.merged_tickets, /apj_factory_ticket_merged_total\{service_namespace="software-factory", factory_ticket_key!~"none\|other\|"\}\[/);
  assert.doesNotMatch(generated.merged_tickets, /service_name[=~]/, "per-ticket queries sum every host; no $service filter");
  // Counted when the counter increased in the window OR the series first appeared in it: increase()/rate()
  // cannot see a series' first sample, and every ticket key is a new series created at 1 on its first merge.
  assert.match(generated.merged_tickets, /max by \(factory_ticket_key\) \(increase\(/);
  assert.match(generated.merged_tickets, /last_over_time\(.*\)\) unless max by \(factory_ticket_key\) \(last_over_time\(.*\] offset /s,
    "a series that first appeared in the window counts as merged");
  assert.match(generated.merged_tickets, /\) \* 0 \+ 1\)$/, "a key the worker counted twice is one merged ticket at exactly 1, so a double count cannot halve that ticket's cost");
  assert.match(generated.cost_per_merged_ticket, /\) \/ on \(factory_ticket_key\) \(\(\(\(/);
  assert.equal(generated.mean_cost_per_merged_ticket, `avg(${generated.cost_per_merged_ticket})`);
  assert.match(generated.keyed_cost_per_merged_ticket, /^\(sum\(sum by \(factory_ticket_key\) \(.*\) \/ \(sum\(.*\) > 0\)$/s);
  assert.ok((generated.keyed_cost_per_merged_ticket.match(/factory_ticket_key!~"none\|other\|"/g) ?? []).length >= 6, "every numerator selector keeps Jira keys only");
});

test("per-ticket cost: the README states the design the hosts implement (the label on July's token and turn metrics and spans through July's public API, an approved exception; no View; kv-outage and budget fallbacks; mean vs keyed; cardinality)", () => {
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  // The "Metric | Labels used" table is the first table naming each metric; the cardinality table names them again.
  const rows = {};
  for (const m of readme.matchAll(/^\| `([a-zA-Z_]+(?:_\{[a-z,]+\}|_\*)?)` \| (.*) \|$/gm)) rows[m[1]] ??= m[2];
  for (const labelled of ["agent_sdk_turn_count_total", "cursor_token_usage_total", "apj_factory_ticket_merged_total"]) {
    assert.ok(rows[labelled], `${labelled} row`);
    assert.match(rows[labelled], /`factory_ticket_key`/, `${labelled} lists the ticket label`);
    assert.doesNotMatch(rows[labelled], /never `factory_ticket_key`/, labelled);
  }
  for (const stamped of ["cursor_tool_calls_total", "apj_factory_kv_failure_total"]) {
    assert.ok(rows[stamped], `${stamped} row`);
    assert.doesNotMatch(rows[stamped], /never `factory_ticket_key`/, `${stamped}: with no View the label is not dropped`);
  }
  assert.equal(rows["apj_factory_ticket_tokens_total"], undefined, "no factory-owned token instrument");
  assert.match(readme, /approved exception to the rule that July's spans leave as\s+July makes them/);
  assert.match(readme, /adds this one attribute,\s+`factory\.ticket\.key`, to July's turn, tool, phase and subagent spans and\s+to July's metrics/);
  assert.match(readme, /only through July's public\s+`setAttributes` \/ `setSessionAttributes` API/);
  assert.match(readme, /Nothing else on July's spans or logs changes/);
  assert.doesNotMatch(readme, /`TICKET_LABELLED_METRICS`|metricAttributes/);
  assert.doesNotMatch(readme, /never on July's\s+metrics or spans|Nothing calls `ctx\.host\.otel`|withdrawn so\s+July's spans and metrics stay untouched/);
  const slugRows = Object.fromEntries([...readme.matchAll(/^\| `(factory-desk|planner|triage-jira|pr-autofixer|security-reviewer|factory-worker)` \| (.*) \| (.*) \|$/gm)].map((m) => [m[1], { key: m[2], none: m[3] }]));
  assert.match(slugRows["factory-desk"].none, /kv outage/);
  for (const slug of ["pr-autofixer", "security-reviewer"]) assert.match(slugRows[slug].none, /PR read that fails or takes over 2 s/, slug);
  assert.match(slugRows["pr-autofixer"].key, /once per session and within a 2 s budget/);
  assert.match(readme, /kept\s+truly first-time by a `ticket-merged\/<KEY>` kv marker/);
  assert.match(readme, /each key's row is pinned to exactly 1/, "the double-counted-merge guard is stated");
  assert.match(readme, /first appeared in it|first-appearance arm/, "the first-sample blindness of increase() and its fix are stated");
  assert.doesNotMatch(readme, /high by one rather than\s+missing a ticket/, "a double count does not just raise the denominator by one; it would halve that ticket's cost, which the clamp prevents");
  assert.match(readme, /Which spans carry it, exactly\.[\s\S]*`paintOpenSpans` does not paint phase spans[\s\S]*previous turn's key on a\s+re-tagged session/, "phase spans opened before the hook settles are called out");
  assert.doesNotMatch(readme, /on every sample and span of the turn/);
  assert.match(readme, /^\| `cursor_cost_usage_USD_total` \| gone after July 0\.2\.20/m);
  assert.match(readme, /`agent_sdk\.tool` span \(they open at the tool call: on\s+`actions\.requested`, or in `runInCall` when July executes the tool itself\)\s+and `agent_sdk\.subagent` span \(they open on `subagent\.called`\)/, "tool spans open at the tool call, either path");
  assert.doesNotMatch(readme, /they open on `actions\.requested`\)/);
  assert.match(readme, /^\| `agent_sdk_turn_count_total` \| one per `agent_sdk_turn_status` \(`completed`, `failed`, `usage_limit`, `unpaid_invoice`\)/m, "July's four turn statuses, no invented ones");
  assert.doesNotMatch(readme, /`interrupted`, `busy`/);
  assert.doesNotMatch(readme, /\. the SDK keeps/);
  assert.match(slugRows["factory-desk"].key, /re-tagged by `file_ticket` itself, which calls `tagSessionTicket` the moment `createIssue` returns the key/, "the desk's mid-turn re-tag is the tool's own call");
  assert.match(slugRows["factory-desk"].key, /`approve_ticket`, `deny_ticket` and `request_plan` tag their input key on entry/);
  assert.match(slugRows["factory-desk"].key, /`action\.result` listener is a second path over the same keys, parsing the JSON-string tool output/);
  assert.doesNotMatch(readme, /re-tagged from `file_ticket`'s result/, "July hands hooks a JSON string for a server tool's result, not the object; the result alone never re-tagged a turn");
  assert.match(readme, /that first phase span always starts before the hook/);
  assert.match(readme, /may not\. The key is\s+reliable/, "later early phase spans may or may not predate the hook");
  assert.doesNotMatch(readme, /goes on opening\s+the turn's first phase spans synchronously/);
  assert.doesNotMatch(readme, /some twenty tickets/);
  assert.match(readme, /close to, not equal to, the per-slug estimate/);
  assert.doesNotMatch(readme, /Summed over every key the result equals the per-slug/);
  assert.match(readme, /\*Mean cost per merged ticket\*.*true mean/s);
  assert.match(readme, /\*Keyed cost over merged tickets\*.*not a mean/s);
  assert.doesNotMatch(readme, /the mean over merged tickets, wrap both sides/);
  assert.match(readme, /\*\*Cardinality\.\*\* The factory's MeterProvider has no label allowlist/);
  for (const instrument of ["agent_sdk_turn_count_total", "apj_factory_ticket_merged_total", "cursor_tool_calls_total", "cursor_token_usage_total"]) {
    assert.match(readme, new RegExp(`^\\| \`${instrument}\` \\| .* \\| .* \\|$`, "m"), `${instrument} has a cardinality row`);
  }
  assert.match(readme, /cursor_token_usage_total\{otel_metric_overflow="true"\}/);
  assert.match(readme, /2000 attribute sets per instrument per process life/);
  assert.doesNotMatch(readme, /METRIC_CARDINALITY_LIMIT|So the cap stays at 500/);
});

test("per-ticket cost queries under promtool: first-sample merges counted, merged-before-window not, early cost counted in full via the widened cost window (tools/promtool_ticket_check.py; needs PROMTOOL)", { skip: skip || (process.env.PROMTOOL ? false : "set PROMTOOL to a promtool binary") }, () => {
  const out = run(["tools/promtool_ticket_check.py", "--promtool", process.env.PROMTOOL]);
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  assert.match(out.stdout, /SUCCESS/);
});

test("two input shapes under promtool: TLSSN-60's gross desk + net planner series price 2.356548 per series (legacy summed-first 1.59566); net series with a restart, gross-only, no cache_read, mixed pods (tools/promtool_shape_check.py; needs PROMTOOL)", { skip: skipPromtool }, () => {
  const out = run(["tools/promtool_shape_check.py", "--promtool", PROMTOOL]);
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  assert.match(out.stdout, /SUCCESS/);
  assert.match(out.stdout, /TLSSN-60 reads 2\.356548 per series \(legacy summed-first form: 1\.59566\)/);
  // The fixture's expectations are the README's numbers.
  const src = readFileSync(join(DIR, "tools/promtool_shape_check.py"), "utf8");
  for (const n of ["41_977", "39_296", "890", "187_541", "1_191_168", "29_543"]) assert.match(src, new RegExp(`\\b${n}\\b`), `TLSSN-60 fixture carries ${n}`);
  assert.match(src, /"TLSSN-60": 1\.59566/);
  assert.match(src, /"instance": pod\.name/, "pods are told apart by the instance label, as hosted VMs are");
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  assert.match(readme, /`tools\/promtool_shape_check\.py`[\s\S]*prices 2\.356548 \(planner 2\.295848 \+ desk\s+0\.060700\) where the old form read\s+1\.595660/);
});

test("apply.sh resolves a symlinked token file with BSD tools: no realpath, no readlink -f, and ignores CDPATH", { skip }, (t) => {
  for (const tool of ["bash", "curl", "jq", "readlink"]) {
    if (spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0) return t.skip(`${tool} is not installed`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "apply-bsd-"));
  const inTree = join(DIR, ".apply-test-intree.token");
  const inTreeSub = join(DIR, ".apply-test-sub");
  try {
    const realReadlink = spawnSync("sh", ["-c", "command -v readlink"], { encoding: "utf8" }).stdout.trim();
    const bin = join(scratch, "bin");
    spawnSync("mkdir", ["-p", bin, join(scratch, "a", "b"), inTreeSub, join(scratch, "cdpath", ".apply-test-sub")]);
    writeFileSync(join(bin, "realpath"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    writeFileSync(join(bin, "readlink"), `#!/bin/sh\nfor a in "$@"; do case "$a" in -f|-e|-m|--canonicalize*) echo "readlink: illegal option" >&2; exit 1;; esac; done\nexec ${realReadlink} "$@"\n`, { mode: 0o755 });
    writeFileSync(inTree, "glsa_" + "probe_not_a_token\n");
    writeFileSync(join(scratch, "outside.token"), "glsa_" + "probe_not_a_token\n");
    writeFileSync(join(inTreeSub, "probe.token"), "glsa_" + "probe_not_a_token\n");
    spawnSync("ln", ["-s", inTree, join(scratch, "a", "b", "hop2")]);
    spawnSync("ln", ["-s", "b/hop2", join(scratch, "a", "hop1")]);
    spawnSync("ln", ["-s", "../outside.token", join(scratch, "a", "out-link")]);
    const apply = (file, env = {}) => spawnSync("bash", [join(DIR, "apply.sh")], { cwd: DIR, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GRAFANA_URL: "http://127.0.0.1:9", GRAFANA_TOKEN: "", GRAFANA_TOKEN_FILE: file, ...env } });
    const refused = apply(join(scratch, "a", "hop1"));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /inside the git work tree/, "an outside symlink chain to an in-tree token must be refused");
    // A relative in-tree path, with an exported CDPATH holding a same-named decoy directory outside the tree.
    for (const env of [{}, { CDPATH: join(scratch, "cdpath") }]) {
      const relative = apply(".apply-test-sub/probe.token", env);
      assert.equal(relative.status, 1, `CDPATH=${env.CDPATH ?? ""}: ${relative.stderr}`);
      assert.match(relative.stderr, /inside the git work tree/, `CDPATH=${env.CDPATH ?? ""}: an in-tree token must be refused`);
    }
    for (const ok of [join(scratch, "outside.token"), join(scratch, "a", "out-link")]) {
      const out = apply(ok);
      assert.doesNotMatch(out.stderr, /inside the git work tree|cannot resolve/, `${ok}: ${out.stderr}`);
      assert.match(out.stderr, /Failed to connect|Couldn't connect|curl/, "it got as far as calling Grafana");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(inTree, { force: true });
    rmSync(inTreeSub, { recursive: true, force: true });
  }
});

test("raw-body fixture through the dashboards' Loki targets (tools/rawbody_check.py; needs FACTORY_LOKI_URL)", { skip: skipLoki }, () => {
  const out = run(["tools/rawbody_check.py", "--loki", LOKI_URL]);
  // The script prints only scheme, host and port, so its output is safe to show; the env var itself is not.
  assert.equal(out.status, 0, `rawbody_check failed:\n${out.stdout}${out.stderr}`);
});

test("the Logs failed-turn counts leave out July's expected customer-state errors, like the Overview", () => {
  const logs = byUid(OPS);
  const failed = targets(logs).filter(({ target }) => /agent_sdk_event="turn\.failed"/.test(target.expr ?? ""));
  assert.ok(failed.length >= 2, "expected the Turns failed stat and the completed-vs-failed series");
  for (const { panel, target } of failed) assert.match(target.expr, /agent_sdk_expected_error=""/, `${panel.title}: counts expected errors`);
});

test("round-6: raw log bodies, KV baseline filtered from the table, metric labels kept", () => {
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  assert.match(readme, /Raw `util\.format` bodies/);
  assert.match(readme, /Older records exported before #217/);
  assert.doesNotMatch(readme, /a separate PR removes|console bridge rewrites|allowlist drops|none survive the allowlist|no zero baseline|dropped by the log allowlist/);
  assert.match(readme, /turn_model[\s\S]*raw\s+JSON body/);
  assert.match(readme, /KV table filters `site!="none"`/);

  const overview = byUid(OPS);
  const kvTable = panels(overview).find((p) => p.title.startsWith("KV failures by slug"));
  assert.ok(kvTable, "KV failures table missing");
  assert.match(kvTable.targets[0].expr, /site!="none"/);
  assert.match(kvTable.description, /zero baseline/);
  assert.doesNotMatch(kvTable.description, /created by the first failure/);
  const kvStat = panels(overview).find((p) => p.title === "KV fails");
  assert.match(kvStat.targets[0].expr, /or vector\(0\)/);
  assert.doesNotMatch(kvStat.targets[0].expr, /site!="none"/, "the KV stat must stay honest, including the baseline series");

  for (const title of ["Hosted execution p95 by service (total)", "Hosted executions per bucket by service", "Reminder fire outcomes (range)"]) {
    const p = panels(overview).find((x) => x.title === title);
    assert.ok(p, `${title} missing`);
    assert.doesNotMatch(p.description, /allowlist drops|are dropped|pools phases/);
  }
  const hostedP95 = panels(overview).find((x) => x.title === "Hosted execution p95 by service (total)");
  assert.match(hostedP95.targets[0].query, /name = "agent_sdk\.turn" \} \| quantile_over_time\(duration, \.95\) by \(resource\.service\.name\)$/);
  assert.doesNotMatch(readme, /still pools phases/);

  const logs = byUid(OPS);
  const tag = logs.templating.list.find((v) => v.name === "tag_lines");
  assert.equal(tag.label, "Tags");
  assert.match(tag.description, /older tag:bdk records/);
  assert.doesNotMatch(tag.description, /console bridge rewrites/);
});

test("Traces lists per-turn token usage, guarded to turns that reported it", () => {
  const traces = byUid(OPS);
  const usage = panels(traces).find((p) => p.title.startsWith("Per-turn token usage"));
  assert.ok(usage, "no per-turn token table");
  const query = usage.targets[0].query;
  assert.match(query, /name = "agent_sdk\.turn" && span\.agent_sdk\.usage\.input_tokens != nil/);
  for (const attr of ["input_tokens", "cache_read_tokens", "output_tokens", "reasoning_tokens"]) assert.match(query, new RegExp(`span\\.agent_sdk\\.usage\\.${attr}`));
});

function operand(values, ref) {
  if (Object.hasOwn(values, ref)) return values[ref] == null ? NaN : Number(values[ref]);
  if (typeof ref === "number") return ref;
  if (typeof ref === "string" && ref.trim() !== "" && !Number.isNaN(Number(ref))) return Number(ref);
  return NaN;
}

function applyCalculateFields(row, transforms) {
  const values = { ...row };
  for (const t of transforms ?? []) {
    if (t.id !== "calculateField") continue;
    const o = t.options;
    if (o.mode === "reduceRow") {
      const nums = (o.reduce?.include ?? []).map((field) => {
        const raw = values[field];
        if (raw == null) return o.reduce.nullValueMode === "null as zero" ? 0 : null;
        return Number(raw);
      });
      if (nums.some((n) => n == null)) {
        values[o.alias] = null;
      } else if (o.reduce?.reducer === "sum") {
        values[o.alias] = nums.reduce((sum, n) => sum + n, 0);
      } else if (o.reduce?.reducer === "max") {
        values[o.alias] = Math.max(...nums);
      }
    } else if (o.mode === "binary") {
      const l = operand(values, o.binary.left);
      const r = operand(values, o.binary.right);
      values[o.alias] = o.binary.operator === "-" ? l - r : o.binary.operator === "*" ? l * r : NaN;
    }
  }
  return values;
}

test("per-turn uncached input treats a missing cache read as 0, not NaN, and floors cache_read > input at 0", () => {
  const traces = byUid(OPS);
  const usage = panels(traces).find((p) => p.title.startsWith("Per-turn token usage"));
  const calc = (usage.transformations ?? []).filter((t) => t.id === "calculateField");
  const fill = calc.find((t) => t.options.mode === "reduceRow" && t.options.reduce?.include?.includes("agent_sdk.usage.cache_read_tokens"));
  const subtract = calc.find((t) => t.options.mode === "binary" && t.options.binary?.operator === "-");
  const zero = calc.find((t) => t.options.mode === "binary" && t.options.binary?.operator === "*");
  const floor = calc.find((t) => t.options.mode === "reduceRow" && t.options.alias === "Uncached" && t.options.reduce?.reducer === "max");
  assert.ok(fill, "no reduceRow fill of cache_read before the subtract");
  assert.equal(fill.options.reduce.nullValueMode, "null as zero");
  assert.ok(subtract, "no raw-difference binary subtract");
  assert.ok(zero, "no input * 0 helper");
  assert.ok(floor, "no reduceRow max floor at 0");
  assert.ok(calc.indexOf(fill) < calc.indexOf(subtract), "fill must run before the binary subtract");
  assert.ok(calc.indexOf(subtract) < calc.indexOf(floor), "subtract must run before the max floor");
  assert.ok(calc.indexOf(zero) < calc.indexOf(floor), "zero helper must run before the max floor");
  assert.match(usage.description, /floored at 0/);
  assert.match(readFileSync(join(DIR, "README.md"), "utf8"), /floored at 0/);

  const org = (usage.transformations ?? []).find((t) => t.id === "organize");
  for (const helper of ["cache_read_or_0", "uncached_raw", "zero"]) {
    assert.equal(org.options.excludeByName[helper], true, `${helper} is not hidden`);
  }

  const withCache = applyCalculateFields({
    "agent_sdk.usage.input_tokens": 26870,
    "agent_sdk.usage.cache_read_tokens": 18710,
  }, usage.transformations);
  assert.equal(withCache.Uncached, 8160);

  const noCache = applyCalculateFields({ "agent_sdk.usage.input_tokens": 12049 }, usage.transformations);
  assert.equal(noCache.Uncached, 12049);
  assert.equal(applyCalculateFields({ "agent_sdk.usage.input_tokens": 12005 }, usage.transformations).Uncached, 12005);

  const overCache = applyCalculateFields({
    "agent_sdk.usage.input_tokens": 100,
    "agent_sdk.usage.cache_read_tokens": 150,
  }, usage.transformations);
  assert.equal(overCache.Uncached, 0);

  const nullMode = applyCalculateFields(
    { "agent_sdk.usage.input_tokens": 12049 },
    [{ id: "calculateField", options: { mode: "reduceRow", alias: "cache_read_or_0",
      reduce: { include: ["agent_sdk.usage.cache_read_tokens"], reducer: "sum", nullValueMode: "null" } } },
     { id: "calculateField", options: { mode: "binary", alias: "Uncached input",
       binary: { left: "agent_sdk.usage.input_tokens", operator: "-", right: "cache_read_or_0" } } }],
  );
  assert.ok(Number.isNaN(nullMode["Uncached input"]), "nullValueMode null must yield NaN after subtract");
});

test("no binary calculateField subtracts a field that can be null without filling it first", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      const calc = (p.transformations ?? []).filter((t) => t.id === "calculateField");
      calc.forEach((t, i) => {
        if (t.options.mode !== "binary") return;
        const right = t.options.binary?.right;
        if (typeof right !== "string") return;
        if (right.trim() !== "" && !Number.isNaN(Number(right))) return;
        const filled = calc.slice(0, i).some((prev) => prev.options.mode === "reduceRow" && prev.options.alias === right
          && prev.options.reduce?.nullValueMode === "null as zero");
        assert.ok(filled || t.options.binary.operator !== "-", `${uid} / ${p.title}: binary - ${right} without a null-as-zero fill`);
      });
    }
  }
});

test("dashboards and README do not talk about the shipped trace-sampling fix as pending", () => {
  const stale = /until the (separate )?trace-sampling fix ships|today about 4%|need the trace-sampling fix|expected until the trace-sampling|No sampled HTTP or factory span|column yourself\. Sampled|row\. Sampled|No sampled turn spans|No failed tool call in the sampled spans|No sampled turn span with token usage|Sampled, so not every turn|Sampled, and a turn whose root|Sampled; Factory overview|No failed tool call in the spans|failure\. A turn whose root span/i;
  for (const { uid, json } of dashboards) {
    for (const p of [...json.panels.filter((r) => r.type === "row"), ...panels(json)]) {
      const text = `${p.title}\n${p.description ?? ""}\n${p.options?.content ?? ""}\n${JSON.stringify(p.fieldConfig ?? {})}`;
      assert.doesNotMatch(text, stale, `${uid} / ${p.title}`);
    }
  }
  assert.doesNotMatch(readFileSync(join(DIR, "README.md"), "utf8"), stale);
});

test("ticket panel titles stay readable when the Ticket box is empty", () => {
  for (const { uid, json } of dashboards) {
    for (const p of [...json.panels, ...panels(json)]) {
      assert.doesNotMatch(p.title, /\$\{ticket\}/, `${uid} / ${p.title}: interpolates an empty ticket into the title`);
    }
  }
  const titles = [
    ...panels(byUid(OPS)),
    ...panels(byUid(OPS)),
  ].map((p) => p.title);
  assert.ok(titles.includes("Ticket journey: spans"), titles.join(" | "));
  assert.ok(titles.includes("Ticket journey: events in time order"), titles.join(" | "));
});

test("count stats and count table columns are whole numbers; rates, costs keep decimals; token totals use locale", () => {
  const tokenStat = /token|input|^cache read$|^output$|^reasoning$|uncached/i;
  const countCols = ["Count", "Deliveries", "Calls", "Fires", "Failures", "Requests", "Turns", "Turns logged"];
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "stat")) {
      const d = p.fieldConfig.defaults;
      const where = `${uid} / ${p.title}`;
      if (["percentunit", "ms", "currencyUSD"].includes(d.unit)) {
        assert.notEqual(d.decimals, 0, `${where}: rate/latency/cost forced to 0 decimals`);
        continue;
      }
      if (d.unit === "locale" && tokenStat.test(p.title)) {
        assert.equal(d.decimals, 0, `${where}: token total is locale, not short/Mil`);
        continue;
      }
      if (d.unit === "none" || d.unit === "short") assert.equal(d.decimals, 0, `${where}: count stat is not whole numbers`);
    }
    for (const p of panels(json).filter((x) => x.type === "table")) {
      const names = new Set();
      for (const t of p.transformations ?? []) {
        for (const n of Object.values(t.options?.renameByName ?? {})) names.add(n);
      }
      const footerFields = p.options?.footer?.fields;
      if (Array.isArray(footerFields)) {
        for (const n of footerFields) names.add(n);
      }
      const overrides = p.fieldConfig.overrides ?? [];
      const defaultZero = p.fieldConfig.defaults.decimals === 0;
      for (const name of countCols) {
        if (!names.has(name)) continue;
        const hit = overrides.find((o) => o.matcher?.options === name && (o.properties ?? []).some((prop) => prop.id === "decimals" && prop.value === 0));
        assert.ok(defaultZero || hit, `${uid} / ${p.title}: ${name} has no decimals: 0`);
      }
    }
  }
});

test("estimated cost by service is a bar gauge in service colours", () => {
  const tokens = byUid(OPS);
  const cost = panels(tokens).find((p) => p.title === "Spend by service");
  assert.ok(cost, "no cost-by-service panel");
  assert.equal(cost.type, "bargauge");
  assert.equal(cost.options.displayMode, "basic");
  assert.equal(cost.options.showUnfilled, false);
  assert.equal(cost.fieldConfig.defaults.noValue, "— no spend");
  assert.equal(cost.gridPos.w, 12, "beside Cost / bucket in the Ops Cost row");
  assert.equal(cost.gridPos.h, 8);
  assert.equal(cost.options.namePlacement, "left");
  assert.equal(cost.options.sizing, "manual");
  assert.equal(cost.options.minVizHeight, 22);
  assert.match(cost.targets[0].expr, /^sort_desc\(/);
  assert.match(cost.targets[0].expr, /label_replace\(vector\(0\)/, "idle slugs show a 0 bar");
  assert.equal(cost.fieldConfig.overrides.find((o) => o.matcher?.options === "factory-desk")
    ?.properties?.find((p) => p.id === "color")?.value?.fixedColor, "#0072B2");
  const business = panels(byUid(BUSINESS)).find((p) => p.title === "Spend by service");
  assert.equal(business.type, "bargauge", "Business shows cost by service as bars, not a pie");
  assert.equal(business.gridPos.w, 12, `beside Cumulative spend: ${business.gridPos.w}`);
  assert.equal(business.fieldConfig.overrides.find((o) => o.matcher?.options === "factory-desk")
    ?.properties?.find((p) => p.id === "displayName")?.value, "Intake & Slack",
    "Business renames slugs to plain stage names");
  assert.ok(!dashboards.some(({ json }) => panels(json).some((p) => p.type === "piechart")), "no pie chart on either dashboard");
  const cumulative = panels(byUid(BUSINESS)).find((p) => p.title === "Cumulative spend");
  assert.equal(cumulative.gridPos.w, 12, `cumulative w=${cumulative.gridPos.w}`);
  // Ops keeps hosted slugs (no displayName remap).
  assert.equal(cost.fieldConfig.overrides.find((o) => o.matcher?.options === "factory-desk")
    ?.properties?.find((p) => p.id === "displayName"), undefined);
});

function assertPackedGrid(items, label) {
  if (items.length === 0) {
    return;
  }
  const cells = new Map();
  let minY = Infinity;
  let maxY = 0;
  for (const p of items) {
    const { x, y, w, h } = p.gridPos;
    const name = p.title || p.type;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const key = `${xx},${yy}`;
        assert.equal(cells.has(key), false, `${label}: ${name} overlaps ${cells.get(key)} at ${key}`);
        cells.set(key, name);
      }
    }
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + h);
  }
  for (let yy = minY; yy < maxY; yy++) {
    for (let xx = 0; xx < 24; xx++) {
      assert.ok(cells.has(`${xx},${yy}`), `${label}: gap at x=${xx} y=${yy}`);
    }
  }
}

test("dashboards have no grid gaps or overlaps", () => {
  for (const { uid, json } of dashboards) {
    assertPackedGrid(json.panels, uid);
    for (const row of json.panels.filter((p) => p.type === "row" && (p.panels ?? []).length)) {
      assertPackedGrid(row.panels, `${uid} / ${row.title}`);
    }
  }
});

test("All factory logs is tall enough to show a reasonable number of lines", () => {
  const logs = byUid(OPS);
  const raw = panels(logs).find((p) => p.title === "All factory logs");
  assert.ok(raw, "no All factory logs panel");
  assert.ok(raw.gridPos.h >= 14, `All factory logs height ${raw.gridPos.h} is still short`);
});

test("count bar legends round each bucket so the sum calc is a whole number", () => {
  const overview = byUid(OPS);
  const countBars = [
    "Turns per bucket by status",
    "Hosted executions per bucket by service",
    "Deliveries per bucket by service",
    "Deliveries per bucket by kind",
    "Tool calls per bucket by service",
    "Sessions per bucket by channel",
    "HTTP requests per bucket by service and status",
  ];
  for (const title of countBars) {
    const p = panels(overview).find((x) => x.title === title);
    assert.ok(p, `${title} missing`);
    assert.equal(p.fieldConfig.defaults.decimals, 0, `${title}: decimals`);
    assert.deepEqual(p.options.legend.calcs, [], `${title}: legend calc`);
    for (const t of p.targets.filter((x) => x.legendFormat !== "error rate")) {
      // The all-services zero-fill wraps round(...) in "((round(...)) or <zeros>)".
      assert.match(t.expr.replace(/^\(+/, ""), /^round\(/, `${title}: ${t.refId} is not rounded`);
      assert.match(t.expr, /\[\$__interval:\$\{prom_res\}\]/, `${title}: ${t.refId} should use $__interval:\${prom_res}`);
      assert.doesNotMatch(t.expr, /\[\$__auto\]/, `${title}: ${t.refId} must not use $__auto`);
    }
  }
});

test("Deliveries per bucket by outcome class is 100% stacked without an error-rate line", () => {
  const overview = byUid(OPS);
  const p = panels(overview).find((x) => x.title === "Deliveries per bucket by outcome class");
  assert.ok(p);
  assert.equal(p.fieldConfig.defaults.custom.stacking.mode, "percent");
  assert.equal(p.targets.length, 1);
  assert.match(p.targets[0].expr, /sum by \(class\)/);
  assert.match(p.targets[0].expr, /label_replace/);
  assert.equal(p.targets[0].legendFormat, "{{class}}");
  const rate = (p.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "error rate");
  assert.equal(rate, undefined, "error-rate line dropped (it duplicated the red stack)");
  const ok = (p.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "ok");
  assert.equal(ok?.properties?.find((x) => x.id === "color")?.value?.fixedColor, "#0072B2");
});

test("per-bucket Prometheus uses $__interval; Loki uses $__auto with step=$bucket", () => {
  let promBuckets = 0;
  let lokiBuckets = 0;
  for (const { uid, json } of dashboards) {
    for (const { panel, target, ds } of targets(json)) {
      const expr = target.expr ?? "";
      const where = `${uid} / ${panel.title} (${target.refId})`;
      if (ds === "prometheus") {
        assert.doesNotMatch(expr, /\$__auto/, `${where}: Prometheus must not use $__auto`);
        if (/\[\$__interval(?::(?:1m|\$\{prom_res\}))?\]/.test(expr) && panel.type !== "stat") {
          promBuckets += 1;
        }
      }
      if (ds === "loki" && /\[\$__auto\]/.test(expr)) {
        lokiBuckets += 1;
        assert.equal(target.step, "$bucket", `${where}: Loki per-bucket without step=$bucket`);
        assert.doesNotMatch(expr, /\[\$__interval\]/, `${where}: Loki mixed $__interval with $__auto`);
      }
    }
  }
  assert.ok(promBuckets >= 10, `expected Prometheus per-bucket targets, got ${promBuckets}`);
  assert.ok(lokiBuckets >= 5, `expected Loki per-bucket targets, got ${lokiBuckets}`);
});

test("per-bucket queries look ahead one step so the in-progress bucket is included", () => {
  let prom = 0;
  let loki = 0;
  for (const { uid, json } of dashboards) {
    for (const { panel, target, ds } of targets(json)) {
      const expr = target.expr ?? "";
      const where = `${uid} / ${panel.title} (${target.refId})`;
      if (ds === "prometheus" && /\[\$__interval(?::(?:1m|\$\{prom_res\}))?\]/.test(expr) && !target.instant && panel.type !== "stat") {
        assert.match(expr, /offset -\$__interval/, `${where}: missing look-ahead offset -$__interval`);
        const outsideFallback = expr.replace(
          /unless \(resets\([\s\S]*?\) > 0(?: and last_over_time\([\s\S]*?\) < max_over_time\([\s\S]*?\))?\) or increase\([\s\S]*?\)/g,
          "RESET_GATE",
        );
        assert.doesNotMatch(outsideFallback, /increase\(/, `${where}: increase() outside the reset fallback extrapolates`);
        prom += 1;
        if (panel.type === "timeseries" && panel.fieldConfig?.defaults?.custom?.drawStyle === "bars") {
          assert.equal(panel.fieldConfig.defaults.custom.barAlignment, 1, `${where}: bar sits on (t, t+step]`);
          assert.match(expr, /\[\$__interval:\$\{prom_res\}\]/, `${where}: Prometheus look-ahead needs a \${prom_res} subquery`);
          if (/increase\(/.test(expr)) {
            assert.match(expr, /min_over_time\(/, `${where}: first-sample restart needs min_over_time < baseline`);
          }
          assert.match(expr, /vector\(time\(\)\) >= \$\{__from:date:seconds\}/, `${where}: cap samples at \$__from`);
          assert.match(expr, /vector\(time\(\)\) <= \$\{__to:date:seconds\}/, `${where}: cap samples at \$__to`);
        }
      }
      if (ds === "loki" && /\[\$__auto\]/.test(expr) && target.queryType !== "instant") {
        assert.match(expr, /offset -\$__auto/, `${where}: missing look-ahead offset -$__auto`);
        loki += 1;
      }
    }
  }
  assert.ok(prom >= 10, `expected Prometheus look-ahead targets, got ${prom}`);
  assert.ok(loki >= 5, `expected Loki look-ahead targets, got ${loki}`);
});

test("Prom counter totals do not claim exactness", () => {
  const overview = byUid(OPS);
  const tokens = byUid(OPS);
  const named = [
    panels(overview).find((p) => p.title === "Turns" && !p.timeFrom),
    panels(overview).find((p) => p.title.startsWith("HTTP requests by service, route")),
    panels(overview).find((p) => p.title === "Cross-check per service: metric vs logs"),
    panels(tokens).find((p) => p.title === "Tokens and cost by service"),
    panels(tokens).find((p) => p.title === "Cross-check: tokens in logs vs metric (range)"),
  ];
  assert.ok(named.every(Boolean), named.map((p) => p?.title).join(" | "));
  for (const p of named) {
    assert.match(p.description, /Counter totals can read high after a host changes instance id; Loki\/Tempo are the reference/, p.title);
    assert.doesNotMatch(p.description, /exact(ly)? (count|total|match)/i, p.title);
  }
});

test("Slack SDK session-stopped warnings use one regex both ways", () => {
  const logs = byUid(OPS);
  const named = (title, type) => panels(logs).find((p) => p.title === title && (!type || p.type === type));
  const exclude = [
    named("Err & warn"),
    named("Failures and warnings"),
    named("Errors and warnings per bucket by level"),
  ];
  const include = [
    named("Slack SDK", "stat"),
    named("Slack SDK warnings", "logs"),
  ];
  assert.ok([...exclude, ...include].every(Boolean));
  const pattern = (expr, op) => (expr.match(new RegExp(`${op} \`([^\`]+)\``)) || [])[1];
  const labelPattern = (expr) => ((expr.match(/regexp `\(\?P<slack_pair>([^`]+)`/) || [])[1] || "").replace(/\)$/, "");
  const patterns = [
    ...exclude.flatMap((p) => (p.targets ?? []).map((t) => pattern(t.expr, "!~"))),
    ...named("Slack SDK", "stat").targets.map((t) => pattern(t.expr, "\\|~")),
    ...named("Slack SDK warnings", "logs").targets.map((t) => labelPattern(t.expr)),
  ];
  assert.ok(patterns.every(Boolean), `missing Slack regex: ${patterns.join(" | ")}`);
  assert.equal(new Set(patterns).size, 1, `include and exclude must share one regex, got ${[...new Set(patterns)].join(" | ")}`);
  assert.match(patterns[0], /web-api:WebClient/);
  assert.match(patterns[0], /missing_agent_session_stopped_event_subscription/);
  assert.match(patterns[0], /Subscribe to the agent_session_stopped event/);
  assert.doesNotMatch(patterns[0], /\.\*/, "Loki 3.5 line filters miss literal.*(?:A|B); use [^\\n]*");
  for (const p of panels(logs).filter((x) => (x.targets ?? []).some((t) => /detected_level=~/.test(t.expr || "")))) {
    const expr = (p.targets ?? []).map((t) => t.expr).join("\n");
    if (/Slack SDK/.test(p.title)) continue;
    assert.match(expr, /!~ `/, `${p.title}: error-count panel must drop Slack Stop-button noise`);
    assert.match(expr, /agent_session_stopped/, p.title);
  }
});

test("Ticket journey empty state, Failures height, and raw logs wrap", () => {
  const logs = byUid(OPS);
  const traces = byUid(OPS);
  const journey = panels(logs).find((p) => p.title === "Ticket journey: events in time order");
  const spans = panels(traces).find((p) => p.title === "Ticket journey: spans");
  assert.match(journey.fieldConfig.defaults.noValue, /^Pick a ticket in the Ticket box above\. /);
  assert.match(spans.fieldConfig.defaults.noValue, /^Pick a ticket in the Ticket box above\. /);
  assert.equal(journey.gridPos.h, 8, "Logs ticket journey height");
  assert.equal(spans.gridPos.h, 10, "Traces ticket journey height");
  assert.equal(journey.transformations?.[1]?.id, "filterFields");
  assert.equal(spans.transformations?.[0]?.id, "filterFieldsByName");
  assert.equal(spans.transformations?.[1]?.id, "merge");
  assert.equal(spans.transformations?.[2]?.id, "filterFields");
  assert.equal(journey.transformations?.[1]?.options?.include?.id, "byValue");
  assert.equal(spans.transformations?.[2]?.options?.include?.options?.reducer, "count");
  assert.equal(spans.transformations?.[2]?.options?.include?.options?.op, "gt");
  const recent = panels(traces).find((p) => p.title === "Recent factory spans (newest 50 traces)");
  const failed = panels(traces).find((p) => p.title.startsWith("Factory spans that failed"));
  const errors = panels(traces).find((p) => p.title === "Error spans (newest 50 traces)");
  assert.equal(recent.fieldConfig.defaults.noValue, "Nothing in range");
  assert.equal(failed.fieldConfig.defaults.noValue, "✓ None — good");
  assert.equal(errors.fieldConfig.defaults.noValue, "✓ None — good");
  assert.equal(widthByName(journey).get("Time"), 165, "Ticket journey Time fits YYYY-MM-DD HH:mm:ss");
  const failures = panels(logs).find((p) => p.title === "Failures and warnings");
  assert.ok(failures.gridPos.h >= 12, `Failures height ${failures.gridPos.h}`);
  assert.match(failures.description, /Lines from the Slack WebClient session-stopped pair are under Debug: Slack SDK \(expected\)/);
  const slack = panels(logs).find((p) => p.title === "Slack SDK warnings" && p.type === "logs");
  assert.ok(slack.gridPos.h >= 10, `Slack SDK warnings height ${slack.gridPos.h}`);
  const raw = panels(logs).find((p) => p.title === "All factory logs");
  assert.equal(raw.options.wrapLogMessage, false);
});

function panelWidthPx(w, viewport = 1280) {
  return Math.floor((w * viewport) / 24) - 16;
}

// Natural widths Grafana actually uses at 1600 px (not a flat 50 px). A
// table whose named columns exceed the panel width fails this model the
// same way it overflows in the live preview.
const RENDERED = {
  "Start time": 150,
  Time: 140,
  timestamp: 140,
  Duration: 75,
  "Span ID": 110,
  "Trace ID": 200,
  Trace: 110,
  Service: 180,
  Span: 160,
  Kind: 150,
  Outcome: 85,
  Count: 70,
  Path: 160,
  "HTTP status": 85,
  Turn: 160,
  Ticket: 90,
  Reason: 90,
  PR: 140,
  "Cloud agent": 220,
  "Error type": 100,
  Method: 70,
  Status: 70,
  Channel: 80,
  Mode: 80,
  "Expected error": 100,
  Tool: 90,
  Event: 100,
  Via: 70,
  Wake: 110,
  "Input tokens (gross)": 130,
  "Cache read tokens": 130,
  "Uncached input": 130,
  "Output tokens": 130,
  "Reasoning tokens": 130,
  "Input (gross)": 130,
  "Cache read": 130,
  Uncached: 130,
  Output: 130,
  Reasoning: 130,
  "Reasoning (in output)": 110,
  "Total (input + output)": 110,
  Turns: 70,
  "Estimated cost": 135,
  Cost: 80,
};
const DEFAULT_COL = 80;

const SELECT_DISPLAY = {
  "resource.service.name": "Service",
  "service.name": "Service",
  name: "Span",
  status: "Status",
  "span.factory.delivery.kind": "Kind",
  "factory.delivery.kind": "Kind",
  "span.factory.outcome": "Outcome",
  "factory.outcome": "Outcome",
  "span.factory.ticket.key": "Ticket",
  "factory.ticket.key": "Ticket",
  "span.factory.reason": "Reason",
  "factory.reason": "Reason",
  "span.error.type": "Error type",
  "error.type": "Error type",
  "span.factory.pr": "PR",
  "factory.pr": "PR",
  "span.factory.cloud_agent.id": "Cloud agent",
  "factory.cloud_agent.id": "Cloud agent",
  "span.http.request.method": "Method",
  "http.request.method": "Method",
  "span.url.path": "Path",
  "url.path": "Path",
  "span.http.response.status_code": "HTTP status",
  "http.response.status_code": "HTTP status",
  "span.agent_sdk.channel": "Channel",
  "agent_sdk.channel": "Channel",
  "span.agent_sdk.session_mode": "Mode",
  "agent_sdk.session_mode": "Mode",
  "span.agent_sdk.usage.input_tokens": "Input (gross)",
  "agent_sdk.usage.input_tokens": "Input (gross)",
  "span.agent_sdk.usage.cache_read_tokens": "Cache read",
  "agent_sdk.usage.cache_read_tokens": "Cache read",
  "span.agent_sdk.usage.output_tokens": "Output",
  "agent_sdk.usage.output_tokens": "Output",
  "span.agent_sdk.usage.reasoning_tokens": "Reasoning",
  "agent_sdk.usage.reasoning_tokens": "Reasoning",
  "span.agent_sdk.expected_error": "Expected error",
  "agent_sdk.expected_error": "Expected error",
  "span.cursor.tool.name": "Tool",
  "cursor.tool.name": "Tool",
  "span.agent_sdk.turn_id": "Turn",
  "agent_sdk.turn_id": "Turn",
};

function hiddenNames(panel) {
  const names = new Set();
  for (const o of panel.fieldConfig.overrides ?? []) {
    if (!(o.properties ?? []).some((prop) => prop.id === "custom.hidden" && prop.value === true)) {
      continue;
    }
    const name = o.matcher?.options;
    if (!name) {
      continue;
    }
    names.add(name);
    if (name === "traceIdHidden") {
      names.add("Trace ID");
    }
  }
  return names;
}

function minWidthByName(panel) {
  const out = new Map();
  for (const o of panel.fieldConfig.overrides ?? []) {
    const name = o.matcher?.options;
    const px = (o.properties ?? []).find((prop) => prop.id === "custom.minWidth")?.value;
    if (name && px) {
      out.set(name === "traceIdHidden" ? "Trace ID" : name, px);
    }
  }
  return out;
}

function selectedSpanColumns(panel) {
  const query = (panel.targets?.[0]?.query ?? "").replace(/\s+with\([^)]+\)\s*$/, "");
  const sel = query.match(/\|\s*select\(([\s\S]*)\)\s*$/);
  assert.ok(sel, `${panel.title}: no select()`);
  const names = new Set(["Start time", "Duration", "Span ID", "Trace ID"]);
  for (const raw of sel[1].split(",")) {
    const arg = raw.trim();
    const display = SELECT_DISPLAY[arg] ?? SELECT_DISPLAY[arg.replace(/^span\./, "")] ?? SELECT_DISPLAY[arg.replace(/^resource\./, "")];
    assert.ok(display, `${panel.title}: unknown select field ${arg}`);
    names.add(display);
  }
  if ((panel.transformations ?? []).some((t) => t.id === "calculateField" && t.options?.alias === "Uncached")) {
    names.add("Uncached");
  }
  return names;
}

function returnedSpanColumns(panel) {
  const names = selectedSpanColumns(panel);
  for (const hidden of hiddenNames(panel)) {
    names.delete(hidden);
  }
  return names;
}

function widthByName(panel) {
  const out = new Map();
  for (const o of panel.fieldConfig.overrides ?? []) {
    const name = o.matcher?.options;
    const px = (o.properties ?? []).find((prop) => prop.id === "custom.width")?.value;
    if (name && px) {
      out.set(name, px);
    }
  }
  return out;
}

function excludedByTransforms(panel) {
  const excluded = new Set();
  const include = [];
  for (const t of panel.transformations ?? []) {
    if (t.id === "organize") {
      for (const [k, v] of Object.entries(t.options?.excludeByName ?? {})) {
        if (v) {
          excluded.add(k);
        }
      }
    }
    if (t.id === "filterFieldsByName" && Array.isArray(t.options?.include?.names)) {
      include.push(new Set(t.options.include.names));
    }
  }
  return { excluded, include };
}

function linkFields(panel) {
  const fields = new Set();
  const re = /\$\{__data\.fields\.([^}]+)\}/g;
  const walk = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(re)) {
        fields.add(match[1]);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(panel.fieldConfig);
  walk(panel.links);
  // Tempo's Span ID link reads traceIdHidden; grouped Tempo tables (no Span ID column) have no such link.
  if ((panel.datasource ?? {}).type === "tempo" && panel.type === "table" && (organizeVisible(panel) ?? []).includes("Span ID")) {
    fields.add("traceIdHidden");
  }
  return fields;
}

function organizeVisible(panel) {
  const org = [...(panel.transformations ?? [])].reverse().find((t) => t.id === "organize");
  if (!org) {
    return null;
  }
  const exclude = new Set(Object.entries(org.options?.excludeByName ?? {}).filter(([, v]) => v).map(([k]) => k));
  const rename = org.options?.renameByName ?? {};
  const order = Object.entries(org.options?.indexByName ?? {}).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const names = [];
  for (const key of order) {
    if (exclude.has(key) || hiddenNames(panel).has(rename[key] || key) || hiddenNames(panel).has(key)) {
      continue;
    }
    names.push(rename[key] || key);
  }
  return names;
}

function renderedWidth(name, mins, widths) {
  if (widths.has(name)) {
    return widths.get(name);
  }
  if (mins.has(name)) {
    return mins.get(name);
  }
  return RENDERED[name] ?? DEFAULT_COL;
}

function assertFitsViewport(panel, returned) {
  const mins = minWidthByName(panel);
  const widths = widthByName(panel);
  const hidden = hiddenNames(panel);
  const visible = [...returned].filter((name) => !hidden.has(name) && name !== "traceIdHidden");
  const parts = visible.map((name) => `${name}=${renderedWidth(name, mins, widths)}`);
  const need = visible.reduce((sum, name) => sum + renderedWidth(name, mins, widths), 0);
  const width = panelWidthPx(panel.gridPos.w);
  assert.ok(need <= width, `${panel.title}: ${parts.join(" + ") || "(none)"} = ${need}px > panel ${width}px`);
}

test("every span table has exactly one Ticket/PR override; min widths fit the panel", () => {
  const traces = byUid(OPS);
  // Span tables list spans (Span ID in organize, visible or hidden behind a Span link); grouped Tempo
  // tables such as Recent tickets have no per-span link and no Span ID column at all.
  const spanTables = panels(traces).filter((p) => p.type === "table" && (p.datasource ?? {}).type === "tempo"
    && (p.transformations ?? []).some((t) => t.id === "organize" && JSON.stringify(t.options ?? {}).includes('"Span ID"')));
  assert.ok(spanTables.length >= 8, `expected span tables, got ${spanTables.length}`);
  for (const p of spanTables) {
    const named = (name) => (p.fieldConfig.overrides ?? []).filter((o) => o.matcher?.options === name);
    const withLinks = (name) => named(name).filter((o) => (o.properties ?? []).some((prop) => prop.id === "links"));
    assert.equal(withLinks("Ticket").length, 1, `${p.title}: Ticket link overrides`);
    const hasPr = (p.transformations ?? []).some((t) => t.id === "extractFields" && t.options?.source === "factory.pr");
    assert.equal(withLinks("PR").length, hasPr ? 1 : 0, `${p.title}: PR link overrides`);
    const ticket = withLinks("Ticket")[0];
    const mapped = JSON.stringify(ticket.properties);
    assert.match(mapped, /"id":"noValue","value":""/);
    assert.match(mapped, /"null"/);
    assert.match(mapped, /"empty"/);
    const mins = minWidthByName(p);
    const hidden = hiddenNames(p);
    if (!hidden.has("Span ID")) {
      assert.equal(mins.get("Span ID"), 110, `${p.title}: Span ID needs a 110 px minWidth`);
    } else {
      const spanLink = (p.fieldConfig.overrides ?? []).some((o) => o.matcher?.options === "Span"
        && (o.properties ?? []).some((prop) => prop.id === "links"));
      assert.ok(spanLink, `${p.title}: hidden Span ID needs a trace link on Span`);
    }
    assert.equal(p.transformations?.[0]?.id, "filterFieldsByName", `${p.title}: drop Tempo progress fields first`);
    assert.ok((p.transformations ?? []).some((t) => t.id === "merge"), `${p.title}: merge so empty frames show noValue`);
    assertFitsViewport(p, returnedSpanColumns(p));
    const visible = organizeVisible(p);
    assert.ok(visible, `${p.title}: missing organize`);
    const span = visible.indexOf("Span");
    if (span >= 0) {
      assert.equal(visible[span + 1], "Duration", `${p.title}: Duration should sit after Span`);
      if (!hidden.has("Span ID")) {
        assert.equal(visible[span + 2], "Span ID", `${p.title}: Span ID should sit after Duration`);
      }
    } else if (!hidden.has("Span ID")) {
      assert.ok(visible.includes("Span ID"), `${p.title}: Span ID missing`);
      assert.ok(visible.indexOf("Duration") < visible.indexOf("Span ID"), `${p.title}: Duration before Span ID`);
    }
    assert.ok(!visible.includes("Trace ID"), `${p.title}: Trace ID should stay hidden`);
    assert.ok(hiddenNames(p).has("traceIdHidden"), `${p.title}: hide traceIdHidden, do not exclude it`);
  }
  for (const { json } of dashboards) {
    for (const p of panels(json).filter((panel) => panel.type === "table" && (panel.datasource ?? {}).type !== "tempo")) {
      const visible = organizeVisible(p);
      if (!visible || minWidthByName(p).size === 0) {
        continue;
      }
      assertFitsViewport(p, visible);
    }
  }
});

test("cumulative cost fills empty buckets; last point ends within one step of now", () => {
  const tokens = byUid(OPS);
  const cumulative = panels(byUid(BUSINESS)).find((p) => p.title === "Cumulative spend");
  assert.match(cumulative.targets[0].expr, /\) > 0/);
  assert.doesNotMatch(cumulative.targets[0].expr, /or vector\(0\)/);
  assert.match(cumulative.targets[0].expr, /\[\$__interval:\$\{prom_res\}\]/);
  assert.doesNotMatch(cumulative.targets[0].expr, /\$__auto/);
  assert.equal(cumulative.fieldConfig.defaults.custom.spanNulls, true);
  assert.deepEqual(cumulative.options.legend.calcs, ["last"]);
  assert.match(cumulative.description, /list-price estimate from token counts, not the invoice/);
  assert.equal(cumulative.transformations[0].id, "calculateField");
  const table = panels(tokens).find((p) => p.title === "Tokens and cost by service");
  const servicePx = minWidthByName(table).get("Service") ?? widthByName(table).get("Service");
  assert.equal(servicePx, 190);
  assert.equal(widthByName(table).get("Cost"), 90);
  assert.equal(widthByName(table).get("Turns"), 70);
  // All six slugs are zero-filled per column, so an idle slug shows a 0 row
  // instead of being dropped (no last_over_time[1d] probe, no filterByValue).
  assert.match(table.targets[0].expr, /label_replace\(vector\(0\)/);
  const keepService = (table.transformations ?? []).find((t) => t.id === "organize"
    && (t.options?.excludeByName?.Service === false || t.options?.indexByName?.Service != null));
  assert.ok(keepService, "tokens table keeps Service");
  assert.ok(!(table.transformations ?? []).some((t) => t.id === "filterByValue"),
    "tokens table keeps idle-service 0 rows: all six slugs are always listed");
  assert.equal(cumulative.fieldConfig.defaults.custom.axisSoftMax, 1);
});

test("factory-field queries parse raw bodies and older structured metadata, not live bridge attributes", () => {
  const rawbody = readFileSync(join(DIR, "tools/rawbody_check.py"), "utf8");
  assert.doesNotMatch(rawbody, /the bridge's current shape/);
  assert.match(rawbody, /before #217|older records/);
  for (const { uid, panel, target } of lokiTargets()) {
    if (!/\bf_\w+/.test(target.expr)) continue;
    assert.match(target.expr, /\| json .*\| label_format f_event=/s, `${uid} / ${panel.title}: f_* without body parse`);
  }
});

test("verify.py Loki $__auto uses the target's interpolated step", { skip }, () => {
  const script = [
    "import json",
    "from grafana_client import TimeRange",
    "from verify import Overrides, prepared_targets",
    "dash = json.load(open('factory-ops.json'))",
    "found = 0",
    "for panel, target, q, *_ in prepared_targets(dash, span=TimeRange(frm='now-7d', to='now'), overrides=Overrides(values={'bucket': '5m'})):",
    "    if (q.get('datasource') or {}).get('type') != 'loki' or target.get('step') != '$bucket':",
    "        continue",
    "    assert '[5m]' in q['expr'], (panel['title'], q['expr'])",
    "    assert '[15m]' not in q['expr'], (panel['title'], q['expr'])",
    "    found += 1",
    "assert found >= 3, found",
    "print(found)",
  ].join("\n");
  const out = run(["-c", script]);
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.ok(Number(out.stdout.trim()) >= 3, out.stdout);
});

test("Slack panel descriptions name the session-stopped pair", () => {
  const logs = byUid(OPS);
  for (const title of ["Err & warn", "Errors and warnings per bucket by level", "Failures and warnings"]) {
    const p = panels(logs).find((x) => x.title === title);
    assert.ok(p, title);
    assert.match(p.description, /the Slack WebClient session-stopped pair/, title);
  }
});

test("count timeseries drop the pre-range bucket on Loki only; Prometheus keeps it", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "timeseries")) {
      const ds = (p.datasource ?? {}).type;
      const drop = (p.transformations ?? []).find((t) => t.id === "filterByValue"
        && (t.options?.filters ?? []).some((f) => f.fieldName === "Time"));
      if (ds === "loki") {
        assert.ok(drop, `${uid} / ${p.title}: Loki must drop Time < $__from`);
        assert.equal(drop.options.filters[0].fieldName, "Time");
        assert.equal(drop.options.filters[0].config.id, "greaterOrEqual");
        assert.equal(drop.options.filters[0].config.options.value, "${__from}");
      } else {
        assert.equal(drop, undefined, `${uid} / ${p.title}: Prometheus keeps the straddling bar`);
      }
      const custom = p.fieldConfig.defaults.custom ?? {};
      const count = (p.fieldConfig.defaults.unit === "short" || p.fieldConfig.defaults.unit === "none")
        && custom.drawStyle === "bars"
        && p.fieldConfig.defaults.decimals === 0;
      if (count) {
        assert.equal(custom.axisSoftMax, 1, `${uid} / ${p.title}: count axis needs axisSoftMax 1`);
      }
      const hideEmpty = (p.fieldConfig.overrides ?? []).some((o) => o.matcher?.id === "byValue"
        && o.matcher?.options?.reducer === "allIsNull"
        && (o.properties ?? []).some((prop) => prop.id === "custom.hideFrom"));
      assert.ok(hideEmpty, `${uid} / ${p.title}: hide all-null legend series`);
      const hideZero = (p.fieldConfig.overrides ?? []).some((o) => o.matcher?.id === "byValue"
        && o.matcher?.options?.reducer === "sum"
        && o.matcher?.options?.op === "eq"
        && Number(o.matcher?.options?.value) === 0
        && (o.properties ?? []).some((prop) => prop.id === "custom.hideFrom"));
      const zeroFilled = (p.targets ?? []).some((t) => /label_replace\(vector\(0\)/.test(t.expr ?? ""));
      if (ds === "prometheus" && !zeroFilled) {
        assert.ok(hideZero, `${uid} / ${p.title}: Prometheus hides sum-0 legend series`);
      } else {
        assert.equal(hideZero, false, `${uid} / ${p.title}: zero-filled/Loki panels keep 0 series`);
      }
    }
  }
});

test("delivery tables (on Factory traces since v2): Count and Kind fit", () => {
  const overview = byUid(OPS);
  for (const title of ["Deliveries by service, kind and outcome", "Deliveries that failed or did nothing"]) {
    const p = panels(overview).find((x) => x.title === title);
    const kind = (p.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "Kind"
      && (o.properties ?? []).some((prop) => prop.id === "custom.minWidth"));
    assert.equal(kind.properties.find((prop) => prop.id === "custom.minWidth").value, 195, title);
    assert.equal(widthByName(p).get("Count"), 80, title);
    assert.ok(p.gridPos.w >= 12, `${title}: widen so Count is not clipped`);
  }
  const byKind = panels(overview).find((x) => x.title === "Deliveries by service, kind and outcome");
  assert.equal(minWidthByName(byKind).get("Span"), undefined);
  assert.equal(minWidthByName(byKind).get("Outcome"), 90);
});

test("link fields survive organize and filterFieldsByName", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      const { excluded, include } = excludedByTransforms(p);
      for (const field of linkFields(p)) {
        assert.ok(!excluded.has(field), `${uid} / ${p.title}: ${field} is excluded so the data link is empty`);
        for (const names of include) {
          assert.ok(names.has(field), `${uid} / ${p.title}: ${field} is dropped by filterFieldsByName`);
        }
      }
    }
  }
});

test("columns named in a table description stay visible", () => {
  const described = {
    "Recent factory spans (newest 50)": ["Kind", "Outcome", "Ticket", "PR", "Start time"],
    "Factory spans that failed or did nothing (newest 50)": ["Kind", "Error type"],
    "Cloud agent launches, all outcomes (newest 50)": ["Reason", "Start time", "Error type", "Cloud agent"],
    "Recent agent_sdk.http spans (newest 50)": ["HTTP status", "Method"],
    "Error spans (newest 50)": ["Span"],
    "Recent turns (newest 50)": ["Turn"],
  };
  const traces = byUid(OPS);
  const spanTables = panels(traces).filter((p) => p.type === "table" && (p.datasource ?? {}).type === "tempo");
  for (const p of spanTables) {
    const hidden = hiddenNames(p);
    const selected = selectedSpanColumns(p);
    for (const name of described[p.title] ?? []) {
      assert.ok(selected.has(name), `${p.title}: description names ${name} but the query does not select it`);
      assert.ok(!hidden.has(name), `${p.title}: description names ${name} but the column is hidden`);
    }
    if (described[p.title]) {
      assert.equal(p.gridPos.w, 24, `${p.title}: described-column tables are full width`);
    }
  }
});

test("ID and number columns have 1280-first minWidth floors", () => {
  const traces = byUid(OPS);
  for (const p of panels(traces).filter((panel) => panel.type === "table" && (panel.datasource ?? {}).type === "tempo")) {
    if (hiddenNames(p).has("Span ID")) continue;
    // Grouped Tempo tables (Recent tickets) have no Span ID column at all.
    if (!(p.transformations ?? []).some((t) => t.id === "organize" && JSON.stringify(t.options ?? {}).includes('"Span ID"'))) continue;
    assert.equal(minWidthByName(p).get("Span ID"), 110, p.title);
    assert.equal(widthByName(p).get("Span ID"), undefined, `${p.title}: Span ID should be minWidth, not width`);
  }
  // v2: the two Prometheus delivery tables live on Factory traces.
  for (const title of ["Deliveries by service, kind and outcome", "Deliveries that failed or did nothing"]) {
    const p = panels(traces).find((x) => x.title === title);
    assert.equal(widthByName(p).get("Count"), 80, title);
  }
  const tokens = byUid(OPS);
  const cost = panels(tokens).find((p) => p.title === "Tokens and cost by service");
  assert.equal(widthByName(cost).get("Cost"), 90);
  const tracesRecent = panels(traces).find((p) => p.title === "Recent factory spans (newest 50 traces)");
  assert.equal(minWidthByName(tracesRecent).get("Kind"), 195);
  assert.equal(minWidthByName(tracesRecent).get("Outcome"), 80);
  assert.equal(minWidthByName(tracesRecent).get("Duration"), 80);
  assert.equal(widthByName(tracesRecent).get("Ticket"), 90);
  assert.equal(widthByName(tracesRecent).get("Start time"), 165);
  assert.ok(hiddenNames(tracesRecent).has("Reason"), "Recent factory spans hides Reason");
  assert.equal(minWidthByName(tracesRecent).get("PR"), 170);
  assert.ok(organizeVisible(tracesRecent).includes("Span"), "Recent factory spans keeps Span");
  assert.ok(hiddenNames(tracesRecent).has("Cloud agent"), "Recent factory spans hides Cloud agent");
  assert.ok(hiddenNames(tracesRecent).has("Span ID"), "Recent factory spans hides Span ID at 1280");
  const ticketSpans = panels(traces).find((p) => p.title === "Ticket journey: spans");
  assert.equal(minWidthByName(ticketSpans).get("PR"), 200, "Ticket journey: spans PR");
  assert.equal(ticketSpans.gridPos.w, 24, "Ticket journey: spans is full width");
  const launches = panels(traces).find((p) => p.title === "Cloud agent launches, all outcomes (newest 50 traces)");
  assert.equal(widthByName(launches).get("Cloud agent"), 320);
  const http = panels(traces).find((p) => p.title === "Recent agent_sdk.http spans (newest 50 traces)");
  assert.ok(hiddenNames(http).has("Path"), "Recent agent_sdk.http hides Path at 1280");
  // v4 dropped the Slow spans table and its Slow variable: a span dump nobody read.
  assert.ok(!panels(traces).some((p) => p.title.startsWith("Slow HTTP")), "Slow HTTP table was cut in v4");
  assert.ok(!traces.templating.list.some((v) => v.name === "min_duration"), "no Slow variable without its table");
  const usage = panels(traces).find((p) => p.title === "Per-turn token usage (newest 50 traces)");
  assert.ok(hiddenNames(usage).has("Span"), "Per-turn token usage hides constant Span");
  assert.equal(minWidthByName(usage).get("Service"), 190);
  for (const name of ["Input (gross)", "Cache read", "Uncached", "Output", "Reasoning"]) {
    const align = (usage.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === name
      && (o.properties ?? []).some((prop) => prop.id === "custom.align"));
    assert.equal(align?.properties.find((prop) => prop.id === "custom.align")?.value, "right", name);
  }
  const failedTools = panels(traces).find((p) => p.title === "Failed tool calls (newest 50 traces)");
  const failedHidden = hiddenNames(failedTools);
  const failedExcluded = excludedByTransforms(failedTools).excluded;
  assert.ok(failedExcluded.has("cursor.tool.status"),
    "Failed tool calls excludes constant cursor.tool.status");
  assert.equal(failedHidden.has("cursor.tool.status"), false,
    "Failed tool calls should exclude cursor.tool.status, not also hide it");
  const logs = byUid(OPS);
  const recentEvents = panels(logs).find((p) => p.title === "Recent factory events (newest 200)");
  assert.equal(minWidthByName(recentEvents).get("Trace"), 150);
  assert.equal(recentEvents.transformations?.[0]?.id, "merge");
  assert.equal(widthByName(recentEvents).get("Time"), 165);
  for (const [name, px] of [["Ticket", 85], ["Outcome", 110]]) {
    assert.equal(widthByName(recentEvents).get(name), px, name);
  }
  assert.equal(minWidthByName(recentEvents).get("Service"), 190, "Service is a floor, so factory-security-reviewer fits");
  assert.equal(minWidthByName(recentEvents).get("PR"), 170, "PR minWidth");
  assert.equal(minWidthByName(recentEvents).get("Reason"), 110, "Reason minWidth");
  assert.ok(hiddenNames(recentEvents).has("Via"));
  assert.ok(hiddenNames(recentEvents).has("Wake"));
  const ticketEvents = panels(logs).find((p) => p.title === "Ticket journey: events in time order");
  assert.equal(minWidthByName(ticketEvents).get("PR"), 170, "Ticket journey: events PR");
  assert.ok(hiddenNames(ticketSpans).has("Ticket"), "Ticket journey: spans hides the repeated Ticket column");
  assert.ok(hiddenNames(ticketEvents).has("Ticket"), "Ticket journey: events hides the repeated Ticket column");
  assert.equal(widthByName(ticketEvents).get("Ticket"), undefined,
    "hidden Ticket must not keep a width that steals leftover space");
  const errorSpans = panels(traces).find((p) => p.title === "Error spans (newest 50 traces)");
  assert.ok(organizeVisible(errorSpans).includes("Span"), "Error spans must keep the Span name");
  assert.equal(excludedByTransforms(errorSpans).excluded.has("Name"), false);
  assert.ok(organizeVisible(errorSpans).includes("Error type"), "Error spans keeps Error type");
  assert.equal(organizeVisible(errorSpans).includes("Outcome"), false,
    "Error spans no longer selects Outcome (NIT-6: drop unused fields)");
  const httpSpans = panels(traces).find((p) => p.title === "Recent agent_sdk.http spans (newest 50 traces)");
  const turns = panels(traces).find((p) => p.title === "Recent turns (newest 50 traces)");
  assert.ok(!selectedSpanColumns(httpSpans).has("Status"), "HTTP table drops span Status");
  assert.ok(returnedSpanColumns(httpSpans).has("HTTP status"), "HTTP table keeps HTTP status");
  assert.ok(!selectedSpanColumns(turns).has("Status"), "Recent turns drops span Status");
  assert.ok(!selectedSpanColumns(turns).has("Expected error"), "Recent turns drops empty Expected error");
});

// Grafana ValueMatcherID (packages/grafana-data/.../valueMatchers/ids.ts) and
// FieldMatcherID. equalTo is not a matcher; H1 used it and the Tokens table
// failed at every range. byValue is a field matcher, not a value matcher.
const VALUE_MATCHER_IDS = new Set([
  "equal", "notEqual", "greater", "greaterOrEqual", "lower", "lowerOrEqual",
  "between", "regex", "isNull", "isNotNull",
]);
const FIELD_MATCHER_IDS = new Set([
  "byName", "byNames", "byRegexp", "byRegexpOrNames", "byType", "byFrameRefID",
  "byValue", "numeric", "time", "first", "firstTimeField",
]);
const TRANSFORM_IDS = new Set([
  "calculateField", "concatenate", "configFromData", "convertFieldType",
  "extractFields", "fieldLookup",   "filterByRefId", "filterByValue", "filterFields",
  "filterFieldsByName", "formatString", "formatTime", "groupBy",
  "groupingToMatrix", "histogram", "joinByField", "joinByLabels",
  "labelsToFields", "limit", "merge", "organize", "partitionByValues",
  "prepareTimeSeries", "reduce", "renameByRegex", "rowsToFields",
  "seriesToRows", "sortBy", "spatial", "timeSeriesTable", "transpose",
]);
const VALUE_NEEDS_VALUE = new Set([
  "equal", "notEqual", "greater", "greaterOrEqual", "lower", "lowerOrEqual", "regex",
]);
const BY_VALUE_OPS = new Set(["gt", "lt", "eq", "neq", "gte", "lte"]);

function walkTransforms(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkTransforms(item, visit));
    return;
  }
  if (value && typeof value === "object") {
    visit(value);
    Object.values(value).forEach((item) => walkTransforms(item, visit));
  }
}

function assertValueMatcher(config, where) {
  assert.ok(config && typeof config === "object", `${where}: missing matcher config`);
  assert.ok(VALUE_MATCHER_IDS.has(config.id), `${where}: unknown ValueMatcherID ${config.id}`);
  const options = config.options ?? {};
  if (VALUE_NEEDS_VALUE.has(config.id)) {
    assert.ok(Object.hasOwn(options, "value"), `${where}: ${config.id} needs options.value`);
  }
  if (config.id === "between") {
    assert.ok(Object.hasOwn(options, "from") && Object.hasOwn(options, "to"), `${where}: between needs from and to`);
  }
}

function assertTransform(t, where) {
  assert.ok(TRANSFORM_IDS.has(t.id), `${where}: unknown transformation id ${t.id}`);
  const o = t.options ?? {};
  if (t.id === "filterByValue") {
    assert.ok(["include", "exclude"].includes(o.type), `${where}: filterByValue type`);
    assert.ok(["all", "any"].includes(o.match), `${where}: filterByValue match`);
    assert.ok(Array.isArray(o.filters) && o.filters.length, `${where}: filterByValue filters`);
    for (const [i, f] of o.filters.entries()) {
      assert.ok(typeof f.fieldName === "string" && f.fieldName, `${where}: filter ${i} fieldName`);
      assertValueMatcher(f.config, `${where} filter ${i} ${f.fieldName}`);
    }
  }
  if (t.id === "calculateField") {
    assert.ok(["reduceRow", "binary", "index", "unary", "cumulativeFunctions", "windowFunctions"].includes(o.mode),
      `${where}: calculateField mode ${o.mode}`);
    if (o.mode === "reduceRow") {
      assert.ok(o.alias, `${where}: reduceRow alias`);
      if (o.replaceFields !== false) {
        assert.ok(Array.isArray(o.reduce?.include), `${where}: reduceRow include`);
      }
    }
    if (o.mode === "binary") {
      assert.ok(o.alias && o.binary?.left != null && o.binary?.operator && o.binary?.right != null,
        `${where}: binary left/operator/right`);
    }
    if (o.mode === "cumulativeFunctions") {
      assert.ok(o.alias && o.cumulative?.field && o.cumulative?.reducer, `${where}: cumulative field/reducer`);
    }
  }
  if (t.id === "organize") {
    assert.ok(o.excludeByName || o.renameByName || o.indexByName, `${where}: organize is empty`);
  }
  if (t.id === "extractFields") {
    assert.ok(o.source, `${where}: extractFields source`);
  }
  if (t.id === "filterFieldsByName") {
    assert.ok(o.include || o.exclude, `${where}: filterFieldsByName include/exclude`);
  }
  if (t.id === "filterFields") {
    assert.ok(o.include || o.exclude, `${where}: filterFields include/exclude`);
  }
  if (t.id === "labelsToFields" && o.mode) {
    assert.ok(["columns", "rows"].includes(o.mode), `${where}: labelsToFields mode`);
  }
}

test("matcher ids and transform configs are ones Grafana can run", () => {
  const badEqualTo = {
    id: "filterByValue",
    options: { type: "exclude", match: "any", filters: [{ fieldName: "Total", config: { id: "equalTo", options: { value: 0 } } }] },
  };
  assert.throws(() => assertTransform(badEqualTo, "self-test"), /unknown ValueMatcherID equalTo/);

  for (const { uid, json } of dashboards) {
    for (const p of [...json.panels.filter((r) => r.type === "row"), ...panels(json)]) {
      const where = `${uid} / ${p.title}`;
      for (const t of p.transformations ?? []) {
        assertTransform(t, `${where} ${t.id}`);
      }
      for (const o of p.fieldConfig?.overrides ?? []) {
        const mid = o.matcher?.id;
        assert.ok(FIELD_MATCHER_IDS.has(mid), `${where}: unknown FieldMatcherID ${mid}`);
        if (mid === "byValue") {
          const opt = o.matcher.options ?? {};
          assert.ok(typeof opt.reducer === "string" && opt.reducer, `${where}: byValue reducer`);
          assert.ok(BY_VALUE_OPS.has(opt.op), `${where}: byValue op ${opt.op}`);
          assert.ok(opt.value != null, `${where}: byValue value`);
        }
      }
    }
  }
});

test("Logs bucket panels describe log line counts, not Prometheus counters", () => {
  const logs = byUid(OPS);
  const titles = [
    "Errors and warnings per bucket by level",
    "Turns completed vs failed per bucket",
    "Log lines per bucket by service",
    "July events per bucket",
    "Log lines per bucket by level",
  ];
  for (const title of titles) {
    const p = panels(logs).find((x) => x.title === title);
    assert.ok(p, title);
    assert.match(p.description, /count of matching log lines|log lines per bucket|records per bucket|Lines with agent_sdk_event/i, title);
    assert.doesNotMatch(p.description, /counter_inc|Prometheus uses \$__interval|#215/, title);
  }
});

test("PALETTE is applied to service, channel, outcome, level and token series", () => {
  const overview = byUid(OPS);
  const tokens = byUid(OPS);
  const logs = byUid(OPS);
  const colourOf = (panel, name) => (panel.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === name)
    ?.properties?.find((p) => p.id === "color")?.value?.fixedColor;
  const byService = panels(overview).find((p) => p.title === "Deliveries per bucket by service");
  assert.equal(colourOf(byService, "factory-desk"), "#0072B2");
  assert.equal(colourOf(byService, "factory-triage-jira"), "#8F3BB8");
  const sessions = panels(overview).find((p) => p.title === "Sessions per bucket by channel");
  assert.equal(colourOf(sessions, "slack"), "#6699CC");
  const levels = panels(logs).find((p) => p.title === "Errors and warnings per bucket by level");
  assert.equal(colourOf(levels, "error"), "red");
  assert.equal(colourOf(levels, "warn"), "orange");
  const volume = panels(logs).find((p) => p.title === "Log lines per bucket by level");
  assert.equal(colourOf(volume, "unknown"), "#767676");
  const kinds = panels(tokens).find((p) => p.title.startsWith("Tokens per bucket:"));
  assert.equal(colourOf(kinds, "uncached input"), "#1F2D6B");
  assert.equal(colourOf(kinds, "cache read"), "#BDBDBD");
  assert.equal(colourOf(kinds, "output"), "#6A7FD1");
  const cost = panels(byUid(BUSINESS)).find((p) => p.title === "Cumulative spend");
  assert.equal(colourOf(cost, "Estimated cost"), "#2171b5");
  const bucketCost = panels(tokens).find((p) => p.title === "Cost / bucket");
  assert.deepEqual(bucketCost.options.legend.calcs, ["sum"]);
  const july = panels(logs).find((p) => p.title === "July events per bucket");
  assert.equal(colourOf(july, "turn.completed"), "#0072B2");
  assert.equal(colourOf(july, "session.started"), "#56B4E9");
  assert.equal(colourOf(july, "message.received"), "#08519c");
  assert.equal(colourOf(july, "turn.failed"), "red");
  assert.equal(colourOf(july, "action.result"), "#9ecae1");
  assert.equal(colourOf(july, "session.failed"), "red");
  const julyLegendKeys = ["turn.completed", "session.started", "session.ended", "message.received",
    "action.requested", "action.result", "turn.failed", "session.failed"];
  for (const name of julyLegendKeys) {
    assert.ok(colourOf(july, name), `July events legend ${name} needs a PALETTE entry`);
  }
  const byKind = panels(overview).find((p) => p.title === "Deliveries per bucket by kind");
  assert.ok(byKind, "by-kind panel");
  assert.match(byKind.targets[0].legendFormat, /family/);
  assert.match(byKind.targets[0].expr, /label_replace/);
  assert.equal(byKind.fieldConfig.defaults.color.mode, "fixed");
  assert.equal(byKind.fieldConfig.defaults.color.fixedColor, "#969696");
  assert.equal(byKind.options.legend.displayMode, "list");
  assert.equal(byKind.options.legend.placement, "bottom");
  const kindRegex = (byKind.fieldConfig.overrides ?? []).filter((o) => o.matcher?.id === "byRegexp"
    && (o.properties ?? []).some((prop) => prop.id === "color"));
  assert.ok(kindRegex.some((o) => /hop_watch/.test(String(o.matcher.options))), "hop_watch prefix");
  assert.ok(kindRegex.some((o) => /github/.test(String(o.matcher.options))), "github prefix");
  assert.ok(kindRegex.every((o) => {
    const pat = String(o.matcher.options);
    return pat.startsWith("/") && pat.endsWith("/");
  }), "kind byRegexp must be /…/ on Grafana 13.3");
  for (const o of kindRegex) {
    const hex = o.properties.find((prop) => prop.id === "color")?.value?.fixedColor;
    assert.ok(hex && !/^(red|orange|#e24d42|#ff780a)$/i.test(String(hex)), `${o.matcher.options}: ${hex}`);
  }
  const history = panels(overview).find((p) => p.type === "status-history");
  assert.equal(history.fieldConfig.defaults.color.mode, "thresholds");
  assert.equal(history.fieldConfig.defaults.noValue, "No activity");
  assert.equal(history.fieldConfig.defaults.custom.fillOpacity, 100);
  assert.equal(history.options.showValue, "never");
  const zeroMap = (history.fieldConfig.defaults.mappings ?? []).find((m) => m.type === "value");
  assert.equal(zeroMap?.options?.["0"]?.color, "transparent");
  const histSteps = history.fieldConfig.defaults.thresholds?.steps ?? [];
  assert.ok(histSteps.some((s) => s.value === 1 && s.color === "#9ecae1"), "activity visible at 1");
  assert.match(history.targets[0].expr, /\) > 0/, "activity drops all-zero series");
  const p95 = panels(overview).find((p) => p.title === "Delivery p95 by span");
  assert.equal(p95.fieldConfig.defaults.unit, "suffix: s", "plain seconds suffix; dtdurations humanizes axis ticks");
  assert.equal(p95.fieldConfig.defaults.custom.scaleDistribution.type, "log");
  assert.equal(p95.fieldConfig.defaults.custom.showPoints, "always");
  assert.equal(p95.fieldConfig.defaults.custom.pointSize, 4);
  assert.match(p95.targets[0].expr, /\/ 1000/);
  assert.doesNotMatch(p95.targets[0].legendFormat, /p95 /);
  assert.deepEqual(p95.options.legend.calcs, []);
  assert.equal(p95.options.legend.displayMode, "list");
  assert.equal(p95.options.legend.placement, "bottom");
  const httpTable = panels(overview).find((p) => p.title.startsWith("HTTP requests by service, route"));
  const statusOverrides = httpTable.fieldConfig.overrides.filter((o) => o.matcher?.options === "Status");
  const statusMaps = statusOverrides.flatMap((o) => o.properties?.find((prop) => prop.id === "mappings")?.value ?? []);
  assert.ok(statusMaps.some((m) => m.type === "regex" && m.options?.pattern === "^5..$"));
  assert.ok(statusMaps.some((m) => m.type === "regex" && m.options?.pattern === "^4..$"));
  const statusThresh = statusOverrides.flatMap((o) => o.properties?.find((prop) => prop.id === "thresholds")?.value?.steps ?? []);
  assert.ok(statusThresh.some((s) => s.color === "text"));
  assert.equal(httpTable.gridPos.w, 12);
  const kv = panels(overview).find((p) => p.title.startsWith("KV failures"));
  assert.equal(kv.gridPos.w, 12);
  const nowStats = panels(overview).filter((p) => p.type === "stat" && p.timeFrom === "15m");
  assert.equal(nowStats.length, 5, "five 15m tiles beside Stuck now (7d)");
  assert.ok(nowStats.every((p) => p.gridPos.w === 4));
  const defaultStat = panels(overview).find((p) => p.title === "Deliveries" && p.timeFrom === "15m");
  assert.equal(defaultStat.options.text.titleSize, 14);
  assert.equal(defaultStat.options.text.valueSize, 32);
  const raw = panels(logs).find((p) => p.title === "All factory logs");
  assert.equal(raw.gridPos.h, 14);
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "stat")) {
      const steps = p.fieldConfig.defaults.thresholds?.steps ?? [];
      assert.ok(!steps.some((s) => s.color === "green"), `${uid} / ${p.title}: healthy state is green`);
    }
  }
});

test("quantile p95 bars skip the $__to subquery cap", () => {
  const overview = byUid(OPS);
  const p95 = panels(overview).find((p) => p.title === "Delivery p95 by span");
  assert.doesNotMatch(p95.targets[0].expr, /\$\{prom_res\}/);
  assert.match(p95.targets[0].expr, /offset -\$__interval/);
});

test("price variables are hidden on Tokens; layout_check passes at 1280/1600/1920", { skip }, () => {
  const tokens = byUid(OPS);
  const prices = tokens.templating.list.filter((v) => v.name.startsWith("price_"));
  assert.ok(prices.length >= 3);
  assert.ok(prices.every((v) => v.hide === 2), "price variables should be hide: 2");
  const out = run(["tools/layout_check.py"]);
  assert.equal(out.status, 0, out.stderr || out.stdout);
  const crashDir = mkdtempSync(join("/tmp", "grafana-crash-"));
  writeFileSync(join(crashDir, "overview.page.json"), JSON.stringify({
    ok: false, error: "An unexpected error happened",
  }));
  const crash = run(["tools/layout_check.py", "--renders", crashDir]);
  rmSync(crashDir, { recursive: true, force: true });
  assert.equal(crash.status, 1, "whole-dashboard crash must fail the render gate");
  assert.match(crash.stderr || "", /whole-dashboard crash|unexpected error/i);
});

test("Recent factory events hides Via and Wake", () => {
  const logs = byUid(OPS);
  const p = panels(logs).find((x) => x.title === "Recent factory events (newest 200)");
  assert.ok(hiddenNames(p).has("Via"));
  assert.ok(hiddenNames(p).has("Wake"));
  assert.equal(minWidthByName(p).get("PR"), 170);
});

test("explanatory rows start collapsed", () => {
  for (const { uid, json } of dashboards) {
    for (const row of json.panels.filter((p) => p.type === "row" && /^(About|Cross-check)/.test(p.title))) {
      assert.equal(row.collapsed, true, `${uid} / ${row.title}`);
    }
  }
});

// Grafana Cloud (13.1+; verified on 13.3.0): an unknown colour mode throws in
// applyFieldConfig and the whole dashboard shows "An unexpected error happened"
// (r10's continuous-Blues did).
const COLOR_MODES = new Set(["fixed", "shades", "thresholds", "palette-classic", "palette-classic-by-name",
  "continuous-GrYlRd", "continuous-RdYlGr", "continuous-BlYlRd", "continuous-YlRd", "continuous-BlPu", "continuous-YlBl",
  "continuous-blues", "continuous-reds", "continuous-greens", "continuous-purples"]);

function eachColorMode(value, visit) {
  if (!value || typeof value !== "object") return;
  if (typeof value.mode === "string" && ("fixedColor" in value || /^(continuous|palette|fixed|shades|thresholds)/.test(value.mode))) {
    visit(value.mode);
  }
  for (const child of Object.values(value)) eachColorMode(child, visit);
}

test("every colour mode is a Grafana Cloud FieldColorModeId (fails on continuous-Blues)", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      eachColorMode(p, (mode) => {
        assert.ok(COLOR_MODES.has(mode), `${uid} / ${p.title}: colour mode ${mode}`);
      });
    }
  }
});

test("query_result variables use the classic form, so Grafana does not send the expression as a series match", () => {
  for (const { uid, json } of dashboards) {
    for (const v of json.templating.list.filter((x) => x.type === "query" && /query_result|\bvector\(/.test(x.definition ?? ""))) {
      assert.equal(v.query.qryType, 5, `${uid} / ${v.name}`);
      assert.match(v.query.query, /^query_result\(.*\)$/s, `${uid} / ${v.name}`);
      assert.match(v.definition, /^query_result\(.*\)$/s, `${uid} / ${v.name}`);
    }
  }
});

test("Now · 15m stats pin a 1m subquery step; Turns columns use unit none; Loki tables merge first", () => {
  const overview = byUid(OPS);
  const tokens = byUid(OPS);
  const logs = byUid(OPS);
  const now = panels(overview).find((p) => p.title === "Deliveries" && p.timeFrom === "15m");
  assert.match(now.targets[0].expr, /:1m\]/);
  assert.doesNotMatch(now.targets[0].expr, /\$\{prom_res\}/);
  const byClass = panels(overview).find((p) => p.title.includes("outcome class"));
  const other = (byClass.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "other");
  assert.equal(other?.properties?.find((prop) => prop.id === "color")?.value?.fixedColor, "#969696");
  const httpTs = panels(overview).find((p) => p.title.startsWith("HTTP requests per bucket"));
  // Coloured by status class; the last matching override wins, as in Grafana. Both the legend and the
  // field-name form Grafana Cloud matches against. 4xx takes a per-slug 50% orange mix (r14), so the
  // exact hue is per slug; the grafanaRegexp test checks the 4xx/5xx matchers themselves.
  const colourFor = (name) => (httpTs.fieldConfig.overrides ?? []).filter((o) => o.matcher?.id === "byRegexp"
    && grafanaRegex(o.matcher.options).test(name)).map((o) => o.properties.find((x) => x.id === "color")?.value?.fixedColor)
    .filter(Boolean).at(-1) ?? httpTs.fieldConfig.defaults.color.fixedColor;
  for (const [status, svc] of [["200", "factory-triage-jira"], ["201", "factory-planner"], ["500", "factory-planner"], ["503", "factory-worker"], ["404", "factory-desk"]]) {
    for (const name of [`${svc} ${status}`, `{http_response_status_code="${status}", service_name="${svc}"}`]) {
      const c = colourFor(name);
      if (status.startsWith("2")) assert.notEqual(c, "red", `${name}: a 200 is never red`);
      if (status.startsWith("5")) assert.equal(c, "red", `${name}: a 500 is red`);
      if (status.startsWith("4")) assert.notEqual(c, "red", `${name}: a 4xx is never plain red`);
      assert.ok(!["green", "#009E73", "#117733"].includes(c), `${name}: never green`);
    }
  }
  for (const dash of [tokens, logs]) {
    for (const p of panels(dash).filter((x) => x.type === "table")) {
      const turns = (p.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "Turns"
        && (o.properties ?? []).some((prop) => prop.id === "unit"));
      if (!turns) continue;
      assert.equal(turns.properties.find((prop) => prop.id === "unit").value, "locale", p.title);
    }
  }
  for (const dash of [overview, logs, tokens]) {
    for (const p of panels(dash).filter((x) => x.type === "table" && (x.datasource ?? {}).type === "loki")) {
      assert.equal(p.transformations?.[0]?.id, "merge", `${p.title}: merge first`);
    }
  }
});

test("Tempo tables keep Outcome colours; nil is per-field, not a catch-all mapping wipe", () => {
  const traces = byUid(OPS);
  for (const p of panels(traces).filter((panel) => panel.type === "table" && (panel.datasource ?? {}).type === "tempo")) {
    const catchAllMaps = (p.fieldConfig.overrides ?? []).filter((o) =>
      o.matcher?.id === "byRegexp" && o.matcher?.options === ".*"
      && (o.properties ?? []).some((prop) => prop.id === "mappings"));
    assert.equal(catchAllMaps.length, 0, `${p.title}: byRegexp .* must not replace mappings`);
    const outcome = (p.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "Outcome"
      && (o.properties ?? []).some((prop) => prop.id === "mappings"));
    if (!organizeVisible(p).includes("Outcome") || hiddenNames(p).has("Outcome")) {
      continue;
    }
    assert.ok(outcome, `${p.title}: Outcome needs its own mappings`);
    const maps = JSON.stringify(outcome.properties);
    assert.match(maps, /"nil"/, `${p.title}: Outcome mappings include Tempo nil`);
  }
});

test("volume stats and count tables use locale; tokens charts use short", () => {
  const overview = byUid(OPS);
  const tokens = byUid(OPS);
  const deliveries = panels(overview).find((p) => p.title === "Deliveries" && !p.timeFrom);
  assert.equal(deliveries.fieldConfig.defaults.unit, "locale");
  assert.equal(deliveries.fieldConfig.defaults.color.fixedColor, "text");
  const traces = byUid(OPS);
  const delivTable = panels(traces).find((p) => p.title === "Deliveries by service, kind and outcome");
  assert.equal(delivTable.fieldConfig.defaults.unit, "locale");
  const noneGood = panels(traces).find((p) => p.title === "Deliveries that failed or did nothing");
  assert.equal(noneGood.fieldConfig.defaults.noValue, "✓ None — good");
  const tokTs = panels(tokens).find((p) => p.title.startsWith("Tokens per bucket:"));
  assert.equal(tokTs.fieldConfig.defaults.unit, "short");
  const xcheck = panels(tokens).find((p) => p.title.startsWith("Cross-check: tokens"));
  assert.equal(xcheck.fieldConfig.defaults.unit, "short");
  assert.equal(xcheck.gridPos.h, 9, "six always-listed slugs need the taller table");
  // v4 trimmed the token micro-tiles (Tokens, Input, Uncached, Cache read, Output, Reasoning, per turn / session).
  for (const { uid, json } of dashboards) {
    for (const title of ["Tokens", "Input", "Uncached", "Cache read", "Output", "Reasoning", "Tokens / turn", "Cost / turn", "Cost / session"]) {
      assert.ok(!panels(json).some((p) => p.title === title && p.type === "stat"), `${uid}: token micro-tile ${title} was cut`);
    }
  }
});

test("Ops Debug volume is four w=6 Loki stats; Slack SDK warnings filter on a parsed label", () => {
  const logs = byUid(OPS);
  const healthTitles = ["Err & warn", "Turn fails (logs)", "Events", "Log lines"];
  const stats = healthTitles.map((title) => panels(logs).find((p) => p.title === title && p.type === "stat"));
  assert.ok(stats.every(Boolean), `Debug volume stats: ${stats.map((p, i) => p?.title || `missing ${healthTitles[i]}`).join(", ")}`);
  assert.ok(stats.every((p) => p.gridPos.w === 6 && p.gridPos.h === 4));
  assert.equal(rowOf(OPS, "Log lines"), "Debug: volume and raw logs");
  const slackStat = panels(logs).find((p) => p.title === "Slack SDK" && p.type === "stat");
  assert.equal(rowOf(OPS, slackStat.title), "Debug: Slack SDK (expected)");
  const slack = panels(logs).find((p) => p.title === "Slack SDK warnings" && p.type === "logs");
  assert.match(slack.targets[0].expr, /regexp `\(\?P<slack_pair>/);
  assert.match(slack.targets[0].expr, /slack_pair =~ "\.\+"/);
  assert.doesNotMatch(slack.targets[0].expr, /slack_pair != ""/,
    "=~ \".+\" requires the capture; equivalent to != \"\" for an absent label");
  assert.doesNotMatch(slack.targets[0].expr, /\|~ `/);
});

test("Activity history has no placeholder series; PALETTE hues survive light theme", () => {
  const overview = byUid(OPS);
  const history = panels(overview).find((p) => p.type === "status-history");
  assert.doesNotMatch(history.targets[0].expr, /unless on\(\)/);
  assert.doesNotMatch(history.targets[0].expr, /no deliveries/);
  assert.match(history.targets[0].expr, /\) > 0/);
  assert.equal(history.fieldConfig.defaults.noValue, "No activity");
  assert.equal(history.transformations?.at(-1)?.id, "filterFields");
  const colourOf = (panel, name) => (panel.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === name)
    ?.properties?.find((p) => p.id === "color")?.value?.fixedColor;
  const byService = panels(overview).find((p) => p.title === "Deliveries per bucket by service");
  assert.equal(colourOf(byService, "factory-pr-autofixer"), "#B8A400");
  const sessions = panels(overview).find((p) => p.title === "Sessions per bucket by channel");
  assert.equal(colourOf(sessions, "webhook"), "#AA4499");
  assert.equal(colourOf(sessions, "slack"), "#6699CC");
});

test("round-11 variable bar, empty states, and legend policy", () => {
  const overview = byUid(OPS);
  const traces = byUid(OPS);
  const logs = byUid(OPS);
  const tokens = byUid(OPS);
  const bucket = overview.templating.list.find((v) => v.name === "bucket");
  assert.equal(bucket.hide, 0, "Bucket keeps its label");
  const hours = byUid(BUSINESS).templating.list.find((v) => v.name === "hours_per_ticket");
  assert.equal(hours.hide, 0, "Hours / ticket keeps its label: the model is meant to be edited");
  const find = logs.templating.list.find((v) => v.name === "search");
  assert.equal(find.hide, 2, "Find is hidden so the Ops bar (Service, Ticket, Bucket, Factory) stays one line at 1280");
  const tags = logs.templating.list.find((v) => v.name === "tag_lines");
  assert.equal(tags.hide, 2, "Tags lives on the Raw panel, not the variable bar");
  const history = panels(overview).find((p) => p.type === "status-history");
  assert.equal(history.options.legend.showLegend, false);
  const byClass = panels(overview).find((p) => p.title.includes("outcome class"));
  const errLine = (byClass.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "error rate");
  assert.equal(errLine, undefined, "error-rate line removed");
  assert.deepEqual(byClass.options.legend.calcs, []);
  const costTable = panels(tokens).find((p) => p.title === "Tokens and cost by service");
  assert.equal(costTable.gridPos.h, 9);
  const slackRow = logs.panels.find((p) => p.type === "row" && /Slack SDK/.test(p.title));
  assert.equal(slackRow.collapsed, true);
  const byLevel = panels(logs).find((p) => p.title === "Errors and warnings per bucket by level");
  assert.match(byLevel.targets[0].expr, /regexReplaceAll "\^warning\$"/);
  const costGauge = panels(tokens).find((p) => p.title === "Spend by service");
  assert.equal(costGauge.fieldConfig.defaults.color.fixedColor, "text");
  assert.equal(costGauge.fieldConfig.defaults.noValue, "— no spend");
  assert.equal(costGauge.fieldConfig.defaults.min, 0);
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "table")) {
      const px = minWidthByName(p).get("Service") ?? widthByName(p).get("Service");
      if (px != null) assert.ok(px >= 180, `${uid} / ${p.title}: Service ${px} < 180`);
    }
  }
});

// Grafana 13.1+ TablePanel shows defaults.noValue only when there are
// no frames or no fields. Port of filter.ts + fieldReducer count + TablePanel.
function fieldCount(values) {
  if (!values || values.length === 0) return 0;
  return values.length;
}

function filterFieldsByCount(frames) {
  const processed = [];
  for (const series of frames) {
    const fields = (series.fields ?? []).filter((field) => fieldCount(field.values) > 0);
    if (!fields.length) continue;
    processed.push({ ...series, fields });
  }
  return processed;
}

function tableShowsNoValue(frames, noValue) {
  const count = frames?.length ?? 0;
  const hasFields = (frames ?? []).some((frame) => (frame.fields ?? []).length > 0);
  if (!count || !hasFields) return noValue;
  return null;
}

test("filterFields count>0 drops a zero-row Tempo/Loki frame so noValue renders", () => {
  const emptyTempo = [{
    fields: [
      { name: "Start time", values: [] },
      { name: "Duration", values: [] },
      { name: "Span", values: [] },
      { name: "Service", values: [] },
    ],
  }];
  const afterEmpty = filterFieldsByCount(emptyTempo);
  assert.equal(afterEmpty.length, 0);
  assert.equal(tableShowsNoValue(afterEmpty, "Nothing in range"), "Nothing in range");
  assert.equal(tableShowsNoValue(afterEmpty, "Pick a ticket"), "Pick a ticket");
  assert.equal(tableShowsNoValue(emptyTempo, "Nothing in range"), null,
    "calculateField / merge leave the schema, so TablePanel still shows headers");

  const populated = [{
    fields: [
      { name: "Start time", values: [1_759_500_000_000] },
      { name: "Duration", values: [0.42] },
      { name: "Span", values: ["factory.delivery"] },
      { name: "Service", values: ["factory-desk"] },
      { name: "Outcome", values: ["ok"] },
    ],
  }];
  const afterPop = filterFieldsByCount(populated);
  assert.equal(afterPop.length, 1);
  assert.deepEqual(afterPop[0].fields.map((f) => f.name),
    ["Start time", "Duration", "Span", "Service", "Outcome"]);
  assert.equal(tableShowsNoValue(afterPop, "Nothing in range"), null);

  const traces = byUid(OPS);
  const logs = byUid(OPS);
  const streamTables = [...panels(traces), ...panels(logs)].filter((panel) => panel.type === "table"
    && ((panel.datasource ?? {}).type === "tempo"
      || (panel.transformations ?? []).some((t) => t.id === "extractFields" && t.options?.source === "labels")));
  assert.ok(streamTables.length >= 4, "ticket + recent stream tables");
  for (const p of streamTables) {
    const guard = (p.transformations ?? []).find((t) => t.id === "filterFields");
    assert.ok(guard, `${p.title}: empty-frame filterFields`);
    assert.equal(guard.options?.include?.options?.reducer, "count", p.title);
    assert.ok(p.fieldConfig.defaults.noValue, `${p.title}: noValue sentence`);
  }
});

test("every table ends with filterFields count>0 so empty frames show noValue", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "table")) {
      const xf = p.transformations ?? [];
      const last = xf[xf.length - 1];
      assert.equal(last?.id, "filterFields", `${uid} / ${p.title}: last transform`);
      assert.equal(last.options?.include?.id, "byValue", `${uid} / ${p.title}`);
      assert.equal(last.options?.include?.options?.reducer, "count", `${uid} / ${p.title}`);
      assert.equal(last.options?.include?.options?.op, "gt", `${uid} / ${p.title}`);
      assert.equal(last.options?.include?.options?.value, 0, `${uid} / ${p.title}`);
    }
  }
});

test("categorical charts default to fixed grey; http is not green; worker stays Okabe-Ito", () => {
  const src = readFileSync(join(DIR, "generate.py"), "utf8");
  assert.match(src, /Okabe-Ito bluish green \(#009E73\)|#009E73 is the agreed Okabe-Ito/);
  assert.doesNotMatch(src, /#117733/);
  const overview = byUid(OPS);
  const logs = byUid(OPS);
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "timeseries" || x.type === "piechart")) {
      const color = p.fieldConfig.defaults.color;
      assert.notEqual(color?.mode, "palette-classic", `${uid} / ${p.title}: no classic palette`);
      if (color?.mode === "fixed") {
        assert.equal(color.fixedColor, "#969696", `${uid} / ${p.title}: default grey (4.5:1 on light theme)`);
      }
    }
  }
  const worker = (panels(overview).find((p) => p.title.includes("by service"))
    ?.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "factory-worker");
  assert.equal(worker?.properties?.find((prop) => prop.id === "color")?.value?.fixedColor, "#009E73");
  const http = (panels(overview).find((p) => p.title.includes("by channel"))
    ?.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "http");
  assert.equal(http?.properties?.find((prop) => prop.id === "color")?.value?.fixedColor, "#7777AA");
  const level = panels(logs).find((p) => p.title.includes("by level"));
  assert.equal(level?.fieldConfig.defaults.color?.fixedColor, "#969696");
});

test("dashboard copy does not name fixtures or say up to one scrape", () => {
  for (const { uid, json } of dashboards) {
    const blob = JSON.stringify(json);
    assert.doesNotMatch(blob, /Fixtures A/);
    assert.doesNotMatch(blob, /bucket_look_ahead_check/);
    assert.doesNotMatch(blob, /up to one scrape/);
  }
  const overview = JSON.stringify(byUid(OPS));
  assert.match(overview, /up to one \$\{prom_res\} step/);
});

test("dashboard copy has no factory PR numbers and About does not repeat its title", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      const text = `${p.description ?? ""}\n${p.options?.content ?? ""}`;
      assert.doesNotMatch(text, /#21[57]\b/, `${uid} / ${p.title}`);
      assert.doesNotMatch(text, /#1071620/, `${uid} / ${p.title}`);
      if (p.type === "text" && p.options?.content) {
        const first = p.options.content.replace(/^#+ /, "").trimStart();
        assert.notEqual(first.slice(0, p.title.length + 2).replace(/\*+/g, ""),
          p.title, `${uid} / ${p.title}: About repeats the title`);
        assert.doesNotMatch(p.options.content, new RegExp(`^\\*\\*${p.title.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\.\\*\\*`));
      }
    }
    for (const v of json.templating.list) {
      assert.doesNotMatch(`${v.description ?? ""}\n${v.label ?? ""}`, /#21[57]\b/, `${uid} var ${v.name}`);
    }
    assert.doesNotMatch(json.description ?? "", /#21[57]\b/, `${uid} dashboard description`);
  }
  const traces = byUid(OPS);
  const logs = byUid(OPS);
  const start = (p) => (p.fieldConfig.overrides ?? []).find((o) =>
    (o.properties ?? []).some((prop) => prop.id === "unit" && String(prop.value).startsWith("time:")))
    ?.properties.find((prop) => prop.id === "unit")?.value;
  const spanTime = start(panels(traces).find((p) => p.title === "Recent factory spans (newest 50 traces)"));
  const logTime = start(panels(logs).find((p) => p.title === "Recent factory events (newest 200)"));
  assert.equal(spanTime, "time:YYYY-MM-DD HH:mm:ss");
  assert.equal(logTime, "time:YYYY-MM-DD HH:mm:ss");
});

test("Grafana 13.3 byRegexp is slashed or a full-name match", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      for (const o of p.fieldConfig?.overrides ?? []) {
        if (o.matcher?.id !== "byRegexp") continue;
        const pat = String(o.matcher.options ?? "");
        const slashed = pat.length >= 2 && pat.startsWith("/") && pat.endsWith("/");
        const full = pat === ".*" || pat === "^.*$" || (/^\^/.test(pat) && /\$$/.test(pat));
        assert.ok(slashed || full, `${uid} / ${p.title}: byRegexp ${pat}`);
      }
    }
  }
});

test("generate.py --check rejects undelimited prefix byRegexp and unknown transforms", { skip }, () => {
  const tools = JSON.stringify(join(DIR, "tools"));
  const root = JSON.stringify(DIR);
  const script = [
    "import json, os, sys",
    `sys.path.insert(0, ${tools})`,
    `sys.path.insert(0, ${root})`,
    "import grafana_ids",
    "bad = {",
    "  'uid': 'probe',",
    "  'panels': [{",
    "    'title': 'probe',",
    "    'fieldConfig': {'overrides': [",
    "      {'matcher': {'id': 'byRegexp', 'options': '(^|[=\"])jira'}, 'properties': []},",
    "    ]},",
    "    'transformations': [{'id': 'notARealTransform', 'options': {}}],",
    "  }],",
    "}",
    "rows = grafana_ids.findings([bad])",
    "print(json.dumps(rows))",
  ].join("\n");
  const out = run(["-c", script], DIR);
  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.ok(rows.some((r) => /byRegexp/.test(r) && /jira/.test(r)),
    `undelimited prefix must fail: ${JSON.stringify(rows)}`);
  assert.ok(rows.some((r) => /notARealTransform/.test(r)),
    `unknown transform must fail: ${JSON.stringify(rows)}`);
});

test("Tempo count stats sum count_over_time and cap at 24h; progress fields are dropped", () => {
  const traces = byUid(OPS);
  // v2 counts these four by Tempo search (Summary row, any range); a TraceQL metrics count stat must still sum the
  // series and stay inside Tempo's 25h limit.
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "stat"
      && (x.targets ?? []).some((t) => t.datasource?.type === "tempo" && /\| count_over_time\(/.test(t.query ?? "")))) {
      assert.deepEqual(p.options.reduceOptions.calcs, ["sum"], `${uid} / ${p.title}`);
      assert.equal(p.options.reduceOptions.fields, "/^count_over_time$/", `${uid} / ${p.title}`);
      assert.equal(p.timeFrom, "24h", `${uid} / ${p.title}`);
    }
  }
  // v4 cut the Tempo Summary row (four search counts); the span tables live under Debug: Tempo span tables.
  assert.ok(!panels(traces).some((p) => ["Error spans", "Failed / no-op spans", "Slow spans", "Cloud agent launches"].includes(p.title)), "Tempo summary counts were cut");
  for (const p of panels(traces).filter((x) => x.type === "table" && (x.datasource ?? {}).type === "tempo")) {
    const drop = (p.transformations ?? []).find((t) => t.id === "filterFieldsByName"
      && (t.options?.exclude?.names ?? []).includes("Progress"));
    assert.ok(drop, `${p.title}: drop Tempo search-progress fields`);
  }
});

test("a Tempo count_over_time() on a stat is instant or sum-reduced", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "stat")) {
      for (const t of p.targets ?? []) {
        const query = t.query || "";
        const ds = (t.datasource || p.datasource || {}).type;
        if (ds !== "tempo" || !query.includes("count_over_time()")) continue;
        const instant = t.metricsQueryType === "instant";
        const sum = (p.options?.reduceOptions?.calcs ?? []).includes("sum");
        assert.ok(instant || sum, `${uid} / ${p.title}: Tempo count_over_time must be instant or sum-reduced`);
      }
    }
  }
});

test("transformer ids are in the allow-list for GRAFANA_MIN", () => {
  const src = readFileSync(join(DIR, "generate.py"), "utf8");
  const mo = src.match(/GRAFANA_MIN = \((\d+), (\d+)\)/);
  assert.ok(mo, "GRAFANA_MIN");
  const min = [Number(mo[1]), Number(mo[2])];
  assert.deepEqual(min, [13, 1]);
  assert.match(src, /GRAFANA_BANNER = "Grafana Cloud \(13\.1\+; verified on 13\.3\.0\)"/);
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  assert.match(readme, /Grafana Cloud \(13\.1\+; verified on 13\.3\.0\)/);
  assert.doesNotMatch(readme, /12\.2\+/);
  const since = {
    merge: [12, 2], organize: [12, 2], calculateField: [12, 2], filterByValue: [12, 2],
    filterFieldsByName: [12, 2], labelsToFields: [12, 2], extractFields: [12, 2], sortBy: [12, 2],
    filterFields: [13, 1],
    // v2 (#221) transformers; floors mirror tools/grafana_ids.py TRANSFORM_SINCE.
    joinByField: [12, 2], groupBy: [12, 2], partitionByValues: [12, 2], limit: [12, 2],
    concatenate: [12, 2], groupingToMatrix: [12, 2], reduce: [12, 2], renameByRegex: [12, 2],
    // v4 lead times: Loki per-ticket series to rows (Grafana 7+).
    seriesToRows: [12, 2],
  };
  const atLeast = (floor) => min[0] > floor[0] || (min[0] === floor[0] && min[1] >= floor[1]);
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      for (const t of p.transformations ?? []) {
        const floor = since[t.id];
        assert.ok(floor, `${uid} / ${p.title}: ${t.id} has no version floor`);
        assert.ok(atLeast(floor), `${uid} / ${p.title}: ${t.id} needs Grafana ${floor.join(".")}+`);
      }
    }
  }
});

test("per-turn token helpers run after merge, not on the Tempo progress frame", () => {
  const traces = byUid(OPS);
  const usage = panels(traces).find((p) => p.title.startsWith("Per-turn token usage"));
  const ids = (usage.transformations ?? []).map((t) => t.id);
  assert.equal(ids[0], "filterFieldsByName", "drop Tempo progress fields first");
  assert.equal(ids[1], "merge");
  const firstCalc = ids.indexOf("calculateField");
  assert.ok(firstCalc > ids.indexOf("merge"), "token helpers after merge");
});

test("idle is a no-op; the Ticket textbox keeps its label; Find is hidden but still drives All factory logs", () => {
  const src = readFileSync(join(DIR, "generate.py"), "utf8");
  assert.match(src, /"action_skipped", "none", "idle"/);
  const logs = byUid(OPS);
  const find = logs.templating.list.find((v) => v.name === "search");
  assert.equal(find.label, "Find");
  assert.equal(find.hide, 2, "hidden from the bar; set var-search in the URL");
  assert.match(find.description, /var-search/);
  const ticket = logs.templating.list.find((v) => v.name === "ticket");
  assert.equal(ticket.label, "Ticket");
  assert.equal(ticket.hide, 0);
  const raw = panels(logs).find((p) => p.title === "All factory logs");
  assert.match(raw.targets[0].expr, /\$search/);
  assert.match(raw.description, /Find variable/);
  assert.match(raw.description, /var-search=<regex>/);
  assert.doesNotMatch(raw.description, /Search box/);
});

test("every timeseries legend resolves to a PALETTE group or a named colour", () => {
  const src = readFileSync(join(DIR, "generate.py"), "utf8");
  assert.match(src, /def require_palette\(/);
  assert.match(src, /"action.result": "#9ecae1"/);
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "timeseries")) {
      for (const t of p.targets ?? []) {
        const legend = t.legendFormat || "";
        if (!legend || legend === "__auto") continue;
        if (legend.includes("{{")) continue;
        const coloured = (p.fieldConfig.overrides ?? []).some((o) =>
          o.matcher?.options === legend && (o.properties ?? []).some((prop) => prop.id === "color"));
        assert.ok(coloured, `${uid} / ${p.title}: legend ${legend} has no PALETTE colour`);
      }
    }
  }
});

// ---- Visual v2 (stacked on #219).
const byUid = (uid) => dashboards.find((d) => d.uid === uid).json;
const panel = (uid, title) => {
  const p = panels(byUid(uid)).find((x) => x.title === title);
  assert.ok(p, `${uid}: no panel "${title}"`);
  return p;
};
const rowOf = (uid, title) => {
  let current = null;
  for (const p of byUid(uid).panels) {
    if (p.type === "row") {
      current = p.title;
      if ((p.panels ?? []).some((x) => x.title === title)) return current;
    } else if (p.title === title) return current;
  }
  return null;
};

test("Ops: the wide Prometheus delivery tables and every debug table sit under collapsed Debug rows", () => {
  for (const title of ["Deliveries by service, kind and outcome", "Deliveries that failed or did nothing"]) {
    assert.equal(panel(OPS, title).gridPos.w, 24, title);
    assert.equal(rowOf(OPS, title), "Debug: deliveries by kind and outcome (Prometheus, approximate)");
  }
  const visible = byUid(OPS).panels.filter((p) => p.type === "table").map((p) => p.title);
  assert.deepEqual(visible, ["Stuck tickets (past hop deadline)",
    "Recent tickets (latest 20, 7 days)", "Change review per ticket (latest)"],
    "open Ops tables: stuck list, recent tickets, change review");
  assert.equal(panel(OPS, "Change review per ticket (latest)").gridPos.w, 8, "change review is a narrow list");
  const rows = byUid(OPS).panels.filter((p) => p.type === "row");
  const collapsed = rows.filter((p) => p.collapsed).map((p) => p.title);
  assert.ok(collapsed.every((t) => t.startsWith("Debug:")), "only Debug rows are collapsed");
  assert.ok(collapsed.includes("Debug: factory health detail"));
  assert.ok(collapsed.includes("Debug: ticket journey and milestones"));
  assert.ok(collapsed.includes("Debug: volume and raw logs"));
  assert.ok(collapsed.includes("Debug: cost"));
  assert.ok(collapsed.includes("Debug: Tempo span tables"));
  assert.ok(rows.filter((p) => !p.collapsed).every((p) => !/^Debug/.test(p.title)), "no Debug row is open by default");
  assert.deepEqual(rows.filter((p) => !p.collapsed).map((p) => p.title), [
    "Now · 15m", "In range", "Needs action", "Tickets", "Failures and warnings",
  ]);
  const open = byUid(OPS).panels.filter((p) => p.type !== "row").length;
  const debug = rows.filter((p) => p.collapsed).reduce((n, r) => n + r.panels.length, 0);
  assert.ok(open >= 20 && open <= 30, `${open} visible Ops panels (want 20 to 30)`);
  assert.ok(debug >= 50, `${debug} Debug panels`);
  assert.equal(rowOf(OPS, "Ticket milestones (logs)"), "Debug: ticket journey and milestones");
  assert.equal(rowOf(OPS, "Health event lines (plan start watch, worker decisions, review updates)"), "Debug: factory health detail");
  assert.equal(rowOf(OPS, "Deliveries in logs by service and event type (Loki)"), "Debug: deliveries by kind and outcome (Prometheus, approximate)");
  const linksOf = (title) => panel(OPS, title).fieldConfig.defaults.links.map((l) => l.url);
  assert.ok(linksOf("Deliveries per bucket by service").some((u) => u.includes("var-service=${__field.labels.service_name}")));
  // No link anywhere points at a retired dashboard.
  for (const { uid, json } of dashboards) {
    const text = JSON.stringify(json);
    for (const old of ["factory-overview", "factory-traces", "factory-logs", "factory-cost-tokens"]) {
      assert.ok(!text.includes(`/d/${old}`), `${uid} links to the retired ${old}`);
    }
  }
});

test("every link to another dashboard keeps the time range", () => {
  let count = 0;
  const walk = (value, where) => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, where));
    if (!value || typeof value !== "object") return;
    if (typeof value.url === "string" && value.url.startsWith("/d/")) {
      count += 1;
      assert.match(value.url, /\$\{__url_time_range\}|from=/, `${where}: ${value.url}`);
    }
    Object.values(value).forEach((v) => walk(v, where));
  };
  for (const { uid, json } of dashboards) for (const p of panels(json)) walk([p.links, p.fieldConfig], `${uid} / ${p.title}`);
  assert.ok(count >= 15, `found ${count} links`);
});

const FACTORY_WIDE = (expr) => !expr.includes('service_name=~"${service:pipe}"');

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const hue = (hex) => {
  const [r, g, b] = rgb(hex); const max = Math.max(r, g, b); const d = max - Math.min(r, g, b);
  if (d === 0) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
// Grafana's stringToJsRegex: /body/flags is used as written; anything else is anchored as ^…$.
const grafanaRegex = (pattern) => {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  return m ? new RegExp(m[1], m[2]) : new RegExp(`^(?:${pattern})$`);
};
const SERVICE_HEXES = ["#0072B2", "#CC79A7", "#009E73", "#F0E442", "#56B4E9", "#8F3BB8"];

test("v2 colours: stages are one blue-to-violet ramp, lightness falling in even steps; the Loki flow bars use it; no green or red", () => {
  const flow = panel(BUSINESS, "Ticket flow");
  assert.equal(flow.type, "bargauge");
  assert.equal(flow.datasource.type, "loki", "the flow reads Loki milestone lines, not Tempo announce spans");
  const legends = flow.targets.map((t) => t.legendFormat);
  assert.deepEqual(legends, ["Filed", "Planned", "Approved", "PR opened", "Merged"]);
  for (const t of flow.targets) {
    assert.equal(t.queryType, "instant");
    assert.match(t.expr, /count\(/, `${t.legendFormat}: distinct tickets`);
    assert.match(t.expr, /sum by \(f_ticket\) \(count_over_time\(/, `${t.legendFormat}: milestone lines`);
    assert.match(t.expr, / or vector\(0\)/, `${t.legendFormat}: zero baseline`);
    // Cumulative: later stages are OR'd in so the funnel only narrows.
    if (t.legendFormat !== "Merged") {
      assert.match(t.expr, /\) or \(/, `${t.legendFormat}: includes later stages`);
    }
  }
  // Bargauge renders multi-query frames as Value #A..F; displayName + colour overrides rename them.
  const valueOverrides = legends.map((_, i) => flow.fieldConfig.overrides.find((o) => o.matcher.options === `Value #${String.fromCharCode(65 + i)}`));
  assert.ok(valueOverrides.every(Boolean), "Value #A..F overrides present");
  assert.deepEqual(valueOverrides.map((o) => o.properties.find((p) => p.id === "displayName").value), legends);
  const colours = valueOverrides.map((o) => o.properties.find((p) => p.id === "color").value.fixedColor);
  const flowRamp = ["#CDE0F3", "#99BBE6", "#6891D4", "#4B3993", "#421F6B"];
  assert.deepEqual(colours, flowRamp);
  flowRamp.forEach((c, i) => {
    assert.ok(hue(c) >= 205 && hue(c) <= 275, `${legends[i]} ${c}: hue ${hue(c)} is blue to violet`);
    if (i) {
      assert.ok(luminance(c) < luminance(flowRamp[i - 1]), `${legends[i]} is darker than ${legends[i - 1]}`);
      assert.ok(contrast(c, flowRamp[i - 1]) >= 1.4, `${legends[i - 1]} / ${legends[i]}: neighbours separate`);
    }
  });
  assert.ok(!flowRamp.some((c) => SERVICE_HEXES.includes(c)));
  // The Tempo-span funnel, stage timeline, stage-change chart and dwell table were cut in v4 (lossy announce spans).
  for (const title of ["Ticket flow: tickets filed in range, furthest stage", "Ticket journey: stages (newest 60 changes)",
    "Ticket stage changes per 15 min (last 24h)", "Time in each stage (p50 / p95)", "Stages"]) {
    assert.ok(!dashboards.some(({ json }) => panels(json).some((p) => p.title === title)), `${title} was cut in v4`);
  }
});

test("v2 colours: token kinds have distinct lightness, cache read is grey, no service hue, stacked", () => {
  const kinds = panel(OPS, "Tokens per bucket: uncached input, cache read, output");
  const colour = Object.fromEntries(kinds.fieldConfig.overrides.map((o) => [o.matcher.options, o.properties.find((x) => x.id === "color")?.value?.fixedColor]));
  const [uncached, cache, output] = [colour["uncached input"], colour["cache read"], colour.output];
  assert.equal(hue(cache), null, "cache read is grey");
  const ls = [uncached, output, cache].map(luminance);
  assert.ok(ls[0] < ls[1] && ls[1] < ls[2], "three lightness levels");
  assert.ok(contrast(uncached, output) >= 2 && contrast(output, cache) >= 1.8, "each pair separates on lightness alone");
  for (const c of [uncached, output]) {
    assert.ok(SERVICE_HEXES.every((s) => Math.abs(hue(s) - hue(c)) >= 20), `${c} is not a service hue`);
  }
  assert.equal(kinds.fieldConfig.defaults.custom.stacking.mode, "normal");
  assert.equal(kinds.fieldConfig.defaults.unit, "short", "54.6 Mil like the stats, not 13387396");
});

test("v2 status tiles use the severity ladder: calm is transparent text, never a saturated green", () => {
  const strip = byUid(OPS).panels.slice(2, 8);
  const traces = byUid(OPS).panels.slice(2, 6);
  for (const p of [...strip, ...traces]) {
    const steps = ((p.fieldConfig.defaults.thresholds ?? {}).steps ?? []).map((x) => x.color);
    assert.ok(!steps.includes("green"), `${p.title}: green for healthy`);
    if (p.options.colorMode === "background") assert.equal(steps[0], "transparent", `${p.title}: a calm tile is not filled`);
  }
});

test("Ops opens on Now · 15m: six w=4 tiles (Stuck now first), the stuck table, the activity grid; no Today strip, no budget", () => {
  const ops = byUid(OPS);
  assert.equal(ops.panels[0].title, "Overview");
  assert.doesNotMatch(ops.panels[0].options.content, /Prometheus|Loki|Tempo/);
  assert.equal(ops.panels[1].title, "Now · 15m");
  const strip = ops.panels.slice(2, 8);
  assert.deepEqual(strip.map((p) => p.title), ["Stuck now", "Errors", "Turn fails", "Tool fails", "Ack p95", "Deliveries"]);
  strip.forEach((p, i) => {
    assert.deepEqual(p.gridPos, { h: 4, w: 4, x: 4 * i, y: 4 }, `${p.title}: on the 6-column grid`);
    assert.equal(p.timeFrom, p.title === "Stuck now" ? "7d" : "15m", p.title);
    assert.equal(p.hideTimeOverride, true, `${p.title}: no badge eating the title`);
  });
  const [stuck, errors, , , ack, deliveries] = strip;
  assert.equal(ack.fieldConfig.defaults.noValue, "— no traffic", "Ack p95: no deliveries in the last 15m");
  assert.equal(stuck.options.colorMode, "background");
  assert.deepEqual(stuck.fieldConfig.defaults.thresholds.steps.map((x) => [x.value, x.color]).slice(-2), [[1, "orange"], [3, "red"]]);
  // Hop-watch ticks (schedule.hop-watch idle every 5 minutes, reminder.hop_watch, hop_watch.* sweeps) are out of every
  // Ops delivery error / no-op figure, so an idle tick cannot dominate a tile.
  const hop = /factory_delivery_kind!~"schedule\[\.\]hop-watch\|reminder\[\.\]hop_watch\|hop_watch\[\.\]\.\*"/;
  for (const p of [errors, deliveries, panel(OPS, "Error %"), panels(ops).find((x) => x.title === "Errors" && !x.timeFrom),
    panels(ops).find((x) => x.title === "Deliveries" && !x.timeFrom), panel(OPS, "Deliveries per bucket by outcome class")]) {
    for (const t of p.targets) assert.match(t.expr, hop, `${p.title} (${t.refId}): hop-watch ticks must be excluded`);
    assert.match(p.description, /Hop-watch deliveries .* are left out/, `${p.title}: says so`);
  }
  for (const title of ["Deliveries per bucket by service", "Deliveries per bucket by kind"]) {
    assert.doesNotMatch(panel(OPS, title).targets[0].expr, hop, `${title}: the volume charts keep hop-watch as its own family`);
  }
  assert.equal(ops.panels[8].title, "Stuck tickets (past hop deadline)");
  assert.equal(ops.panels[9].type, "status-history");
  assert.equal(ops.panels[10].title, "In range");
  // v4 cut the Today strip (Filed today, Fail/no-op, Err % today, Spend, Budget used, the Yesterday row) and the budget.
  for (const { uid, json } of dashboards) {
    const titles = panels(json).map((p) => p.title);
    for (const title of ["Filed today", "Fail/no-op", "Err % today", "Budget used", "Yesterday", "Budget"]) {
      assert.ok(!titles.includes(title), `${uid}: ${title} was cut in v4`);
    }
    assert.ok(!panels(json).some((p) => p.type === "gauge"), `${uid}: no budget gauge`);
    assert.ok(!json.templating.list.some((v) => v.name === "daily_budget"), `${uid}: no budget variable`);
    assert.ok(!JSON.stringify(json).match(/daily_budget|Daily budget|budget gauge/), `${uid}: no budget text`);
  }
  const src = readFileSync(join(DIR, "generate.py"), "utf8");
  assert.doesNotMatch(src, /def budget_var|def budget_gauge|def health_strip|def yesterday\(/, "dead budget / Today helpers deleted");
});

test("Business opens on the delivery strip: ten large tiles in three rows, Loki for delivery, Prometheus for spend", () => {
  const biz = byUid(BUSINESS);
  assert.equal(biz.panels[0].title, "Overview");
  assert.equal(biz.panels[1].title, "Delivery");
  const strip = biz.panels.slice(2, 12);
  assert.deepEqual(strip.map((p) => p.title), ["Filed", "PRs opened", "Merged", "First-pass rate",
    "Filed → PR opened", "Filed → merged", "Slack approvals / ticket",
    "Spend", "Cost per merge", "Engineer-hours saved"]);
  assert.deepEqual(strip.map((p) => p.gridPos.w), [6, 6, 6, 6, 8, 8, 8, 8, 8, 8]);
  assert.ok(strip.every((p) => p.type === "stat" && p.gridPos.h >= 5 && !p.timeFrom), "large range stats");
  const byTitle = Object.fromEntries(strip.map((p) => [p.title, p]));
  for (const title of ["Filed", "PRs opened", "Merged", "First-pass rate", "Filed → PR opened", "Filed → merged",
    "Slack approvals / ticket", "Engineer-hours saved"]) {
    assert.equal(byTitle[title].datasource.type, "loki", `${title}: read from the hosts' milestone lines`);
  }
  for (const title of ["Spend", "Cost per merge"]) assert.equal(byTitle[title].datasource.type, "prometheus", title);
  // Filed: the desk's arm line, else the planner's first turn; described as an approximation.
  assert.match(byTitle.Filed.targets[0].expr, /f_event="plan_start_watch" and f_via="arm"/);
  assert.match(byTitle.Filed.targets[0].expr, /f_event="turn_started" and service_name="factory-planner"/);
  assert.match(byTitle.Filed.description, /approximation/);
  // First-pass: merged unless a launch retry / heal, unless a Bugbot round joined through the worker's pr lines.
  const fp = byTitle["First-pass rate"].targets[0].expr;
  assert.match(fp, /m_stage="done" and f_outcome="moved"/);
  assert.match(fp, /unless on\(f_ticket\) \(\(sum by \(f_ticket\) \(count_over_time\([^\n]*f_outcome="launched" and \(f_via="heal" or m_retried="true"\)/);
  assert.match(fp, /service_name="factory-pr-autofixer"/);
  assert.match(fp, /\(f_event="bugbot_round" and f_outcome="drive"\) or \(f_event="bugbot_wake" and f_outcome="fresh_drive"\)/);
  assert.match(fp, /sum by \(f_ticket, f_pr\)[^\n]*f_event=~"implement_pr\|pr_status"[^\n]*\| f_pr != ""/);
  assert.match(fp, /\) and on\(f_pr\) \(/, "PR -> ticket join");
  assert.match(fp, /^\(count\(.*\) or vector\(0\)\) \/ \(count\(.*\) > 0\)$/s, "a share with a guarded denominator and a zero numerator");
  assert.match(fp, /\[7d\]/, "defect signals also read over the last 7 days");
  assert.equal(byTitle["First-pass rate"].fieldConfig.defaults.unit, "percentunit");
  assert.match(byTitle["First-pass rate"].description, /Approximation/);
  // Lead times: the lines' own timestamps; a static `lead` label on the end side; p50 across series in the browser
  // (LogQL has no vector quantile; seriesToRows + /^Value$/ was empty when every series shared one legend).
  for (const title of ["Filed → PR opened", "Filed → merged"]) {
    const lead = byTitle[title];
    assert.match(lead.targets[0].expr, /label_format m_ts=`\{\{ __timestamp__ \| unixEpochMillis \}\}` \| unwrap m_ts/);
    assert.match(lead.targets[0].expr, /label_format lead=`[^`]+`/);
    assert.match(lead.targets[0].expr, /by \(f_ticket, lead\)/);
    assert.match(lead.targets[0].expr, /- on\(f_ticket\) \(/);
    assert.match(lead.targets[0].expr, /\* on\(f_ticket\) group_left\(lead\) \(\(count by \(f_ticket, lead\)/);
    assert.deepEqual(lead.transformations ?? [], []);
    assert.deepEqual(lead.options.reduceOptions, { calcs: ["p50"], fields: "", values: false });
    assert.equal(lead.fieldConfig.defaults.unit, "ms");
    assert.doesNotMatch(lead.description, /Loki|Tempo|Prometheus|Grafana/);
  }
  // Lead times table: one Loki `or` + labelsToFields + groupingToMatrix (ticket × lead).
  // Do not groupBy Value #A / seriesToRows: those field names vanish when only one lead type is in range.
  {
    const table = panels(biz).find((p) => p.title === "Lead times");
    assert.ok(table, "Lead times table present");
    assert.equal(table.targets.length, 1);
    assert.match(table.targets[0].expr, /^\(/);
    assert.match(table.targets[0].expr, /\) or \(/);
    assert.match(table.targets[0].expr, /\* on\(f_ticket\) group_left\(lead\) \(\(count by \(f_ticket, lead\)/);
    assert.equal(table.targets[0].legendFormat, "");
    const ids = (table.transformations ?? []).map((t) => t.id);
    assert.deepEqual(ids.slice(0, 4), ["labelsToFields", "merge", "renameByRegex", "groupingToMatrix"]);
    assert.ok(ids.indexOf("labelsToFields") < ids.indexOf("merge"),
      "labelsToFields before merge: merge drops labels once two or more frames are present");
    assert.ok(!ids.includes("seriesToRows"), "seriesToRows drops labels on a single frame");
    assert.ok(!ids.includes("joinByField"), "joinByField drops the only frame when merged is empty");
    assert.ok(!ids.includes("groupBy"), "groupBy on Value #A / lead is empty when only one lead type is in range");
    const matrix = table.transformations.find((t) => t.id === "groupingToMatrix");
    assert.deepEqual(matrix.options, { columnField: "lead", rowField: "f_ticket", valueField: "ms" });
    const rename = table.transformations.find((t) => t.id === "renameByRegex").options;
    assert.equal(rename.renamePattern, "ms");
    assert.match(rename.regex, /Value/);
    assert.match(rename.regex, /Filed/);
    const organize = table.transformations.find((t) => t.id === "organize");
    assert.equal(organize.options.renameByName["f_ticket\\lead"], "Ticket");
    assert.equal(organize.options.indexByName["f_ticket\\lead"], 0);
    assert.equal(organize.options.renameByName.f_ticket, undefined,
      "groupingToMatrix names the row column f_ticket\\lead, not f_ticket");
    assert.match(table.fieldConfig.defaults.noValue, /No ticket reached PR opened in range/);
    assert.match(table.targets[0].expr, /label_format lead=`Filed → PR opened`/);
    assert.match(table.targets[0].expr, /label_format lead=`Filed → merged`/);
  }
  // Slack approvals per ticket: reaction approve on the plan + approve_command only, with the undercount stated.
  const approvals = byTitle["Slack approvals / ticket"];
  assert.match(approvals.targets[0].expr, /f_event="reaction" and m_verb="approve" and m_target="plan" and f_outcome="approved"/);
  assert.match(approvals.targets[0].expr, /f_event="approve_command" and f_outcome="approved"/);
  assert.match(approvals.description, /approve command or a drag to Approved on the board is not counted/);
  assert.ok(!panels(biz).some((p) => /human touches/i.test(p.title)), "titled Slack approvals per ticket, not human touches");
  // Engineer-hours saved: merged tickets x the editable variable, labelled MODELLED.
  const hours = byTitle["Engineer-hours saved"];
  assert.match(hours.targets[0].expr, /^\(count\(sum by \(f_ticket\) \(count_over_time\(.*m_stage="done" and f_outcome="moved".*\)\)\) or vector\(0\)\) \* \$\{hours_per_ticket\}$/s);
  assert.equal(hours.fieldConfig.defaults.unit, "suffix: h");
  assert.match(hours.description, /^MODELLED, not measured\. Assumes \$hours_per_ticket engineer-hours of manual work per merged ticket; the default 4 h is a conservative manual baseline for a small ticket \(plan \+ implement \+ PR\), chosen because recent factory tickets took about 25 to 40 minutes from filing to PR\. It is not an observation of hours saved\. Edit the Hours \/ ticket variable to change the model\./);
  const v = biz.templating.list.find((x) => x.name === "hours_per_ticket");
  assert.equal(v.type, "custom");
  assert.equal(v.current.value, "4");
  assert.equal(v.hide, 0);
  assert.match(v.description, /MODELLED/);
  assert.ok(v.options.some((o) => o.value === "4" && o.selected));
  // Spend / cost: Prometheus estimate, all slugs; cost per merged over the merged counter, guarded.
  assert.doesNotMatch(byTitle["Spend"].targets[0].expr, /\$\{service:pipe\}/, "all slugs");
  assert.match(byTitle["Cost per merge"].targets[0].expr, /\/ \(sum\(\(\(\(max by \(factory_ticket_key\)/);
  const service = biz.templating.list.find((x) => x.name === "service");
  assert.equal(service.hide, 2, "Business is all slugs; the service variable only feeds the zero-fill helpers");
  assert.deepEqual(biz.panels.filter((p) => p.type === "row").map((p) => [p.title, p.collapsed]),
    [["Delivery", false], ["Ticket pipeline", false], ["Cost", false]]);
  assert.equal(panels(biz).length, 18, "the cold-open story stays at 15 to 20 panels");
});

test("Business user-visible panel copy has no Prom/Loki/Tempo/Grafana jargon", () => {
  const jargon = /Prometheus|Loki|Tempo|Grafana|PromQL|LogQL|TraceQL/;
  const biz = byUid(BUSINESS);
  assert.doesNotMatch(biz.description ?? "", jargon, "dashboard description");
  for (const p of panels(biz)) {
    assert.doesNotMatch(p.description ?? "", jargon, p.title);
    assert.doesNotMatch(p.options?.content ?? "", jargon, `${p.title} content`);
  }
  for (const title of ["Filed", "Filed → PR opened", "Filed → merged", "Ticket flow", "Lead times"]) {
    const p = panels(biz).find((x) => x.title === title);
    assert.ok(p, title);
    assert.doesNotMatch(p.description, jargon, title);
  }
});

test("verify.py resolves a now/d (today so far) panel override", { skip }, () => {
  const script = [
    "from grafana_client import TimeRange",
    "from verify import panel_window, range_seconds",
    "frm, to, _ = panel_window({'timeFrom': 'now/d', 'type': 'stat'}, span=TimeRange(frm='now-24h', to='now'), variables={})",
    "assert (frm, to) == ('now/d', 'now'), (frm, to)",
    "s = range_seconds(TimeRange(frm=frm, to=to))",
    "assert 0 <= s < 86400, s",
    "frm, to, _ = panel_window({'timeFrom': '15m', 'type': 'stat'}, span=TimeRange(frm='now-24h', to='now'), variables={})",
    "assert (frm, to) == ('now-15m', 'now'), (frm, to)",
    "print('ok')",
  ].join("\n");
  const out = run(["-c", script]);
  assert.equal(out.status, 0, out.stderr || out.stdout);
});

const STAGE_KINDS = ["triaged", "planned", "approved", "in_progress", "in_review", "done"];
const STAGE_NAMES = ["filed", "planned", "approved", "building", "PR opened", "merged"];
const STAGE_RAMP = ["#CDE0F3", "#99BBE6", "#6891D4", "#4055BF", "#4B3993", "#421F6B"];
const OUTCOME_KINDS = ["needs_info", "plan_stopped", "approved_without_plan", "launch_failed"];
const ANNOUNCE = /^\{ resource\.service\.namespace = "software-factory" && name = "factory\.background" && span\.factory\.delivery\.kind =~ "jira\[\.\]announce\[\.\]\(triaged\|planned\|approved\|in_progress\|in_review\|done\)" && span\.factory\.ticket\.key != nil/;

// Grafana transforms on one column-map or a Loki dataplane numeric-multi list of frames
// { Time, Value, labels:{…} on Value, displayNameFromDS }. merge / labelsToFields /
// groupingToMatrix follow packages/grafana-data/src/transformations/transformers/*.ts:
// merge.copyFieldStructure omits labels at 2+ frames; labelsToFields (columns) promotes
// labels and clears displayNameFromDS; groupingToMatrix names the row `${row}\${col}`
// and fills missing cells empty. Single-frame input keeps the old column-map API.
function cloneFrame(raw) {
  const labels = (raw.labels && !Array.isArray(raw.labels)) ? { ...raw.labels } : undefined;
  const columns = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "displayNameFromDS") continue;
    if (k === "labels" && !Array.isArray(v)) continue;
    columns[k] = Array.isArray(v) ? [...v] : v;
  }
  return { columns, labels, displayNameFromDS: raw.displayNameFromDS };
}

function frameLen(frame) {
  return (Object.values(frame.columns)[0] ?? []).length;
}

function applyLabelsToFields(frame) {
  const columns = { ...frame.columns };
  const labels = frame.labels;
  if (!labels) return { columns, labels: undefined, displayNameFromDS: undefined };
  const n = frameLen({ columns });
  for (const [name, value] of Object.entries(labels)) {
    columns[name] = Array.from({ length: n }, () => value);
  }
  return { columns, labels: undefined, displayNameFromDS: undefined };
}

function applyMerge(frames) {
  if (frames.length <= 1) return frames;
  const names = [];
  for (const fr of frames) {
    for (const n of Object.keys(fr.columns)) {
      if (!names.includes(n)) names.push(n);
    }
  }
  const columns = {};
  for (const n of names) {
    columns[n] = [];
    for (const fr of frames) {
      const len = frameLen(fr);
      columns[n].push(...(fr.columns[n] ?? Array.from({ length: len }, () => null)));
    }
  }
  return [{ columns, labels: undefined, displayNameFromDS: frames[0].displayNameFromDS }];
}

function runTransforms(input, transforms, { to = 0 } = {}) {
  let frames = Array.isArray(input) ? input.map(cloneFrame) : [cloneFrame(input)];
  const columnsOf = () => (frames[0] ? { ...frames[0].columns } : {});
  const setColumns = (cols) => {
    frames = [{ columns: cols, labels: frames[0]?.labels, displayNameFromDS: frames[0]?.displayNameFromDS }];
  };
  const len = () => (Object.values(columnsOf())[0] ?? []).length;
  const rows = () => {
    const f = columnsOf();
    return Array.from({ length: len() }, (_, i) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v[i]])));
  };
  const fromRows = (rs, names) => Object.fromEntries(names.map((n) => [n, rs.map((r) => r[n] ?? null)]));
  const reducers = {
    max: (xs) => (xs.length ? Math.max(...xs) : null), min: (xs) => (xs.length ? Math.min(...xs) : null),
    sum: (xs) => xs.reduce((a, b) => a + b, 0), count: (xs) => xs.length, distinctCount: (xs) => new Set(xs).size,
    step: (xs) => (xs.length > 1 ? Math.min(...xs.slice(1).map((x, i) => x - xs[i])) : null),
    first: (xs) => (xs.length ? xs[0] : null), last: (xs) => (xs.length ? xs.at(-1) : null),
  };
  const operand = (r, x) => (x === "${__to}" ? to : x in r ? r[x] : Number(x));
  const matches = (r, { fieldName, config }) => {
    const v = r[fieldName]; const o = config.options?.value;
    return { isNotNull: v != null, equal: v === o, regex: new RegExp(o).test(String(v)), greaterOrEqual: v >= o, lower: v < o }[config.id];
  };
  for (const tr of transforms) {
    const o = tr.options;
    if (tr.id === "labelsToFields") {
      frames = frames.map(applyLabelsToFields);
      continue;
    }
    if (tr.id === "merge") {
      frames = applyMerge(frames);
      continue;
    }
    let f = columnsOf();
    if (tr.id === "filterFields") {
      f = Object.fromEntries(Object.entries(f).filter(([, v]) => v.length > 0));
    } else if (tr.id === "filterFieldsByName") {
      f = o.include ? Object.fromEntries(o.include.names.filter((n) => n in f).map((n) => [n, f[n]]))
        : Object.fromEntries(Object.entries(f).filter(([n]) => !o.exclude.names.includes(n)));
    } else if (tr.id === "sortBy") {
      const rs = rows().sort((x, y) => {
        for (const { field, desc } of o.sort) {
          const xv = x[field], yv = y[field];
          const cmp = (typeof xv === "string" || typeof yv === "string")
            ? String(xv).localeCompare(String(yv), undefined, { numeric: true })
            : (xv - yv);
          if (cmp) return desc ? -cmp : cmp;
        }
        return 0;
      });
      f = fromRows(rs, Object.keys(f));
    } else if (tr.id === "limit") f = fromRows(rows().slice(0, o.limitField), Object.keys(f));
    else if (tr.id === "groupingToMatrix") {
      // groupingToMatrix.ts: one frame only; otherwise pass through. Missing keys pass through.
      if (frames.length !== 1 || !(o.columnField in f && o.rowField in f && o.valueField in f)) continue;
      const colVals = [...new Set(f[o.columnField])];
      const rowVals = [...new Set(f[o.rowField])];
      const rowColumnField = `${o.rowField}\\${o.columnField}`;
      const cell = new Map();
      for (const r of rows()) cell.set(`${r[o.rowField]}\0${r[o.columnField]}`, r[o.valueField]);
      const out = rowVals.map((row) => Object.fromEntries([
        [rowColumnField, row],
        ...colVals.map((col) => [col, cell.has(`${row}\0${col}`) ? cell.get(`${row}\0${col}`) : null]),
      ]));
      f = fromRows(out, [rowColumnField, ...colVals]);
    } else if (tr.id === "groupBy") {
      const keys = Object.entries(o.fields).filter(([, c]) => c.operation === "groupby").map(([k]) => k);
      const aggs = Object.entries(o.fields).filter(([, c]) => c.operation === "aggregate");
      const groups = new Map();
      for (const r of rows()) {
        const k = keys.map((x) => r[x]).join("\u0000");
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      const out = [...groups.values()].map((rs) => Object.fromEntries([...keys.map((k) => [k, rs[0][k]]),
        ...aggs.flatMap(([k, c]) => c.aggregations.map((a) => [`${k} (${a})`, reducers[a](rs.map((r) => r[k]))]))]));
      f = fromRows(out, [...keys, ...aggs.flatMap(([k, c]) => c.aggregations.map((a) => `${k} (${a})`))]);
    } else if (tr.id === "calculateField") {
      const names = Object.keys(f);
      const rs = rows().map((r) => {
        let v;
        if (o.mode === "binary") {
          const l = operand(r, o.binary.left); const rt = operand(r, o.binary.right);
          v = l == null || rt == null ? null : { "*": l * rt, "-": l - rt, "/": l / rt }[o.binary.operator];
        } else {
          const vals = o.reduce.include.map((n) => r[n]).map((x) => (x == null && o.reduce.nullValueMode === "null as zero" ? 0 : x));
          v = reducers[o.reduce.reducer](o.reduce.reducer === "step" ? vals.filter((x) => x != null) : vals.filter((x) => x != null));
        }
        return { ...r, [o.alias]: v };
      });
      f = fromRows(rs, [...names.filter((n) => n !== o.alias), o.alias]);
    } else if (tr.id === "filterByValue") {
      const keep = (r) => (o.match === "all" ? o.filters.every((x) => matches(r, x)) : o.filters.some((x) => matches(r, x)));
      f = fromRows(rows().filter((r) => (o.type === "include" ? keep(r) : !keep(r))), Object.keys(f));
    } else if (tr.id === "reduce") {
      f = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, [reducers[o.reducers[0]](v.filter((x) => x != null))]]));
    } else if (tr.id === "organize") {
      const exclude = o.excludeByName ?? {};
      const rename = o.renameByName ?? {};
      const order = Object.entries(o.indexByName ?? {}).sort((x, y) => x[1] - y[1]).map(([k]) => k);
      const include = Object.keys(o.includeByName ?? {});
      const existing = Object.keys(f).filter((k) => !exclude[k]);
      let names;
      if (include.length) names = order;
      else if (order.length) names = [...order.filter((k) => existing.includes(k)), ...existing.filter((k) => !order.includes(k))];
      else names = existing;
      f = Object.fromEntries(names.map((n) => [rename[n] || n, f[n]]));
    } else if (tr.id === "renameByRegex") {
      const re = new RegExp(o.regex);
      f = Object.fromEntries(Object.entries(f).map(([k, v]) => [re.test(k) ? k.replace(re, o.renamePattern) : k, v]));
    } else throw new Error(`runTransforms: ${tr.id} not modelled`);
    setColumns(f);
  }
  return columnsOf();
}

const H = 3600e3;
const spans = (list) => ({ "Start time": list.map((x) => x[2]), "factory.ticket.key": list.map((x) => x[0]),
  "factory.delivery.kind": list.map((x) => `jira.announce.${x[1]}`) });

test("no TraceQL metrics query spans more than Tempo's 25h limit", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      for (const t of (p.targets ?? []).filter((x) => x.datasource?.type === "tempo" && /\| (count_over_time|rate|quantile_over_time|histogram_over_time)\(/.test(x.query ?? ""))) {
        assert.ok(/^(\d+)h$/.test(p.timeFrom ?? "") && Number(p.timeFrom.slice(0, -1)) <= 24, `${uid} / ${p.title}: TraceQL metrics need timeFrom <= 24h`);
        assert.ok(!/\$/.test(t.step ?? ""), `${uid} / ${p.title}: a literal step`);
      }
    }
  }
});

test("stuck tickets: past the hop-watch deadline (Triaged 15 min, Approved 7 min), longest first", () => {
  const p = panel(OPS, "Stuck tickets (past hop deadline)");
  const now = 100 * H;
  const out = runTransforms(spans([
    ["S1", "triaged", now - 20 * 60e3], ["OK1", "triaged", now - 10 * 60e3],
    ["S2", "triaged", now - 2 * H], ["S2", "planned", now - 1.5 * H], ["S2", "approved", now - 8 * 60e3],
    ["OK2", "triaged", now - H], ["OK2", "approved", now - 5 * 60e3], ["DONE", "triaged", now - 9 * H], ["DONE", "done", now - 8 * H],
    ["MOVING", "triaged", now - 3 * H], ["MOVING", "in_progress", now - 2 * H],
    // Answered: the desk posted the outcome, so the ticket waits on a person, not on a hop.
    ["ASKED", "triaged", now - 5 * H], ["ASKED", "needs_info", now - 4 * H],
    ["STOPPED", "triaged", now - 5 * H], ["STOPPED", "planned", now - 4 * H], ["STOPPED", "plan_stopped", now - 3 * H],
    ["NOPLAN", "triaged", now - 5 * H], ["NOPLAN", "approved_without_plan", now - 3 * H],
    ["NOLAUNCH", "triaged", now - 5 * H], ["NOLAUNCH", "approved", now - 4 * H], ["NOLAUNCH", "launch_failed", now - 3 * H],
  ]), p.transformations, { to: now });
  assert.deepEqual(out.Ticket, ["S1", "S2"], "answered tickets (needs_info, plan_stopped, ...) are not stuck");
  assert.deepEqual(out["Waiting in"], ["jira.announce.triaged", "jira.announce.approved"]);
  const waiting = p.fieldConfig.overrides.filter((o) => o.matcher.options === "Waiting in")
    .flatMap((o) => o.properties).find((x) => x.id === "mappings").value[0].options;
  assert.deepEqual(out["Waiting in"].map((k) => waiting[k].text), ["Triaged: planner (15 min)", "Approved: worker (7 min)"]);
  for (const k of OUTCOME_KINDS) assert.match(p.targets[0].query, new RegExp(`\|${k}[|)]`), `${k} counts as a stage change`);
  const stat = panel(OPS, "Stuck now");
  assert.equal(stat.targets[0].query, p.targets[0].query);
  assert.deepEqual(p.transformations.slice(0, 2).map((x) => x.id), ["filterFieldsByName", "merge"],
    "search progress dropped, then merge; no filterFields before the groupBy (it caches calcs every group would reuse)");
  assert.equal(p.transformations.at(-1).id, "filterFields", "the empty-frame guard is table()'s trailing one");
  const rows = p.transformations.slice(2);
  assert.deepEqual(stat.transformations[0], p.transformations[0]);
  assert.deepEqual(stat.transformations.slice(1), rows.slice(0, stat.transformations.length - 1), "the count is the table's rows");
  assert.equal(stat.options.reduceOptions.calcs[0], "count");
  // The live symptom (2026-10-05): every ticket read the newest span's stage and time. Two tickets whose newest
  // spans differ must come out with their own latest kind and time.
  const two = runTransforms(spans([["X", "triaged", now - 30 * 60e3], ["Y", "triaged", now - 3 * H], ["Y", "approved", now - 20 * 60e3]]),
    p.transformations, { to: now });
  assert.deepEqual(two.Ticket, ["X", "Y"]);
  assert.deepEqual(two["Waiting in"], ["jira.announce.triaged", "jira.announce.approved"], "each ticket's own latest stage");
  assert.deepEqual(two.Since, [now - 30 * 60e3, now - 20 * 60e3], "each ticket's own latest change");
});

test("latency heatmap and hosted p95: Tempo agent_sdk.turn span durations (no 10 s cap), all six slugs on the p95", () => {
  const p = panel(OPS, "Exec duration (Tempo, agent_sdk.turn)");
  assert.equal(p.type, "heatmap");
  assert.equal(p.datasource.type, "tempo");
  assert.match(p.targets[0].query, /name = "agent_sdk\.turn" \} \| histogram_over_time\(duration\)$/);
  assert.equal(p.options.yAxis.unit, "s");
  assert.ok(!byUid(OPS).templating.list.some((x) => x.name === "exec_service"), "the Prometheus bucket-layout variable is gone");
  const p95 = panel(OPS, "Hosted execution p95 by service (total)");
  assert.equal(p95.datasource.uid, "-- Mixed --");
  assert.deepEqual(p95.targets.map((t) => t.datasource.type), ["tempo", "prometheus"], "Tempo p95 plus a Prometheus zero per slug");
  const calcs = p95.transformations.filter((t) => t.id === "calculateField");
  assert.equal(calcs.length, 6, "one max(p95, 0) per slug");
});

test("Cost per filing removed; Cost per merge stays Prometheus-only; Cost by ticket includes Unattributed", () => {
  assert.ok(!dashboards.some(({ json }) => panels(json).some((x) => x.title === "Cost per filing")),
    "Cost per filing was redundant next to Cost per merge and contradicted Filed");
  const merged = panel(BUSINESS, "Cost per merge");
  assert.equal(merged.datasource.type, "prometheus");
  assert.match(merged.targets[0].expr, /apj_factory_ticket_merged_total/);
  assert.match(merged.targets[0].expr, /\* 0 \+ 1\)\) > 0\)$/);
  assert.equal(merged.fieldConfig.defaults.noValue, "no merged ticket in range");
  const byTicket = panel(BUSINESS, "Cost by ticket");
  assert.match(byTicket.targets[0].expr, /Unattributed \(before ticket tagging\)/);
  assert.match(byTicket.targets[0].expr, /\) > 0/, "Unattributed only when spend exceeds keyed");
  assert.match(byTicket.description, /Unattributed \(before ticket tagging\)/);
  assert.ok(!(byTicket.fieldConfig.overrides ?? []).some((o) => (o.properties ?? []).some((p) => p.id === "links")),
    "no Ticket data links (Unattributed is not a Jira key)");
  assert.ok(!dashboards.some(({ json }) => panels(json).some((x) => ["Cost / filed ticket", "Cost / merged ticket", "Cost/merged ticket est."].includes(x.title))),
    "the Tempo-denominator cost tiles were replaced");
});

test("Recent tickets: furthest Loki stage (merged beats earlier), empty while Ticket is set", () => {
  const p = panel(OPS, "Recent tickets (latest 20, 7 days)");
  assert.equal(p.datasource.type, "loki", "Loki milestones, not Tempo announce spans");
  assert.equal(p.timeFrom, "7d", "a ticket's furthest stage can predate the dashboard range");
  assert.match(p.targets[0].expr, /eq "\$\{ticket\}" ""/, "empty while a ticket is selected");
  assert.match(p.targets[0].expr, /label_format stage=/, "stage from milestone lines");
  assert.match(p.targets[0].expr, /label_format rank=/, "numeric rank for furthest-wins");
  assert.match(p.description, /furthest milestone/i);
  assert.match(p.description, /Merged beats/i);
  const stage = p.fieldConfig.overrides.find((o) => o.matcher.options === "Current stage").properties;
  const mapping = stage.find((x) => x.id === "mappings").value[0].options;
  assert.equal(mapping.planned.text, "planned");
  assert.equal(mapping.planned.color, STAGE_RAMP[1]);
  assert.equal(mapping.merged.text, "merged");
  assert.equal(mapping.merged.color, STAGE_RAMP[5]);
  assert.equal(stage.find((x) => x.id === "custom.cellOptions").value.type, "color-background", "dark stages unreadable as text");
  // Furthest rank wins: A has building then merged → merged; B only PR opened; C filed then planned → planned.
  // Sort by When entered furthest stage (newest first): A merged at 6H, B at 5H, C at 4H.
  const now = 10 * H;
  const rows = {
    Time: [1 * H, 3 * H, 6 * H, 5 * H, 2 * H, 4 * H],
    labels: [
      { f_ticket: "A", stage: "building", rank: "4" },
      { f_ticket: "A", stage: "building", rank: "4" },
      { f_ticket: "A", stage: "merged", rank: "6" },
      { f_ticket: "B", stage: "PR opened", rank: "5" },
      { f_ticket: "C", stage: "filed", rank: "1" },
      { f_ticket: "C", stage: "planned", rank: "2" },
    ],
  };
  // extractFields is a no-op in our harness when labels is already a column of objects —
  // feed flat fields the transforms after extractFields expect.
  const flat = {
    Time: rows.Time,
    f_ticket: rows.labels.map((l) => l.f_ticket),
    stage: rows.labels.map((l) => l.stage),
    rank: rows.labels.map((l) => l.rank),
  };
  // Skip merge + extractFields (labels already flattened for the harness).
  const fromSort = p.transformations.findIndex((t) => t.id === "sortBy");
  const out = runTransforms(flat, p.transformations.slice(fromSort), { to: now });
  assert.deepEqual(out.Ticket, ["A", "B", "C"], "newest furthest-stage entry first");
  assert.deepEqual(out["Current stage"], ["merged", "PR opened", "planned"]);
  const ticket = p.fieldConfig.overrides.find((o) => o.matcher.options === "Ticket" && o.properties.some((x) => x.id === "links"));
  assert.ok(JSON.stringify(ticket).includes(`/d/${OPS}?var-ticket=\${__value.raw}&\${__url_time_range}`), "opens the journey on this dashboard");
});


test("Change review per ticket: review-state rank breaks equal-timestamp ties (planned over pending)", () => {
  const p = panel(OPS, "Change review per ticket (latest)");
  assert.match(p.targets[0].expr, /review_rank/);
  assert.match(p.description, /furthest change-review|pending < planned|later pending does not hide/i);
  const ids = p.transformations.map((t) => t.id);
  assert.ok(ids.includes("groupBy"));
  const sort = p.transformations.find((t) => t.id === "sortBy" && (t.options.sort ?? []).some((s) => s.field === "review_rank" && s.desc));
  assert.ok(sort, "sorts by review_rank desc so furthest state wins");
});

test("ticket journeys render their empty state: #219's empty-frame guard drops a zero-row frame", () => {
  for (const [uid, title] of [[OPS, "Ticket journey: spans"], [OPS, "Ticket journey: events in time order"]]) {
    const p = panel(uid, title);
    assert.equal(p.fieldConfig.defaults.noValue, "Pick a ticket in the Ticket box above. If one is picked, widen the time range.");
    const lead = p.datasource.type === "tempo" ? ["filterFieldsByName", "merge", "filterFields"] : ["merge", "filterFields"];
    assert.deepEqual(p.transformations.slice(0, lead.length).map((x) => x.id), lead, "Tempo drops search progress first");
  }
  {
    const recent = panel(OPS, "Recent tickets (latest 20, 7 days)");
    assert.equal(recent.datasource.type, "loki");
    assert.deepEqual(recent.transformations.slice(0, 2).map((x) => x.id), ["merge", "extractFields"],
      "Loki labels → fields before furthest-stage groupBy");
    assert.equal(recent.transformations.at(-1).id, "filterFields", "the trailing guard still drops an empty frame");
    assert.ok(!recent.transformations.slice(0, -1).some((t) => t.id === "filterFields" && t.options?.include?.id === "byValue"),
      "no byValue filterFields ahead of groupBy");
  }
});

// Grafana's byValue field matcher runs reduceField(), which caches the whole-column calcs in field.state.calcs;
// groupBy then reduces a copy of each field that still carries the cache, so every group reads the whole column's
// max / last (replayed on @grafana/data 13.2.3 against the live Tempo response: Stuck tickets and Recent tickets
// listed every ticket as Triaged since the newest span overall). sortBy, merge, filterFieldsByName and limit do not
// clear it. So a byValue filterFields may only follow a groupBy / reduce, never precede one.
const REDUCER_TRANSFORMS = new Set(["groupBy", "reduce"]);
const isValueFilter = (t) => t.id === "filterFields"
  && ["include", "exclude"].some((side) => t.options?.[side]?.id === "byValue");

test("no panel runs a filterFields byValue step before a groupBy or reduce (the calc cache makes every group read the whole column)", () => {
  let guarded = 0;
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      const xf = p.transformations ?? [];
      const first = xf.findIndex(isValueFilter);
      if (first < 0) continue;
      guarded++;
      for (const t of xf.slice(first + 1)) {
        assert.ok(!REDUCER_TRANSFORMS.has(t.id), `${uid} / ${p.title}: filterFields byValue at step ${first} precedes ${t.id}`);
      }
    }
  }
  assert.ok(guarded >= 20, `found ${guarded} guarded panels`);
  for (const [uid, title] of [[OPS, "Stuck tickets (past hop deadline)"], [OPS, "Recent tickets (latest 20, 7 days)"],
    [OPS, "Change review per ticket (latest)"]]) {
    const xf = panel(uid, title).transformations;
    assert.ok(xf.some((t) => t.id === "groupBy"), `${uid} / ${title}: groups by ticket`);
    assert.equal(xf.findIndex(isValueFilter), xf.length - 1, `${uid} / ${title}: the only guard is the trailing one`);
  }
  {
    const xf = panel(BUSINESS, "Lead times").transformations;
    assert.ok(xf.some((t) => t.id === "groupingToMatrix"), "Lead times: pivots by ticket");
    assert.equal(xf.findIndex(isValueFilter), xf.length - 1, "Lead times: the only guard is the trailing one");
  }
});

test("generate.py --check flags a filterFields byValue ahead of a groupBy", { skip }, () => {
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(DIR)})`,
    "import generate",
    "guard = generate.EMPTY_FRAME_GUARD",
    "group = {'id': 'groupBy', 'options': {'fields': {}}}",
    "bad = {'uid': 'probe', 'panels': [",
    "  {'type': 'table', 'title': 'early', 'transformations': [guard, {'id': 'sortBy', 'options': {}}, group, guard]},",
    "  {'type': 'table', 'title': 'late', 'transformations': [{'id': 'merge', 'options': {}}, group, guard]},",
    "  {'type': 'table', 'title': 'reduce', 'transformations': [guard, {'id': 'reduce', 'options': {}}]},",
    "]}",
    "print(json.dumps(generate.guard_before_reducer_findings(bad)))",
  ].join("\n");
  const out = run(["-c", script], DIR);
  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.ok(rows.some((r) => /early/.test(r) && /groupBy/.test(r)), JSON.stringify(rows));
  assert.ok(rows.some((r) => /reduce/.test(r)), JSON.stringify(rows));
  assert.ok(!rows.some((r) => /late/.test(r)), `a trailing guard is fine: ${JSON.stringify(rows)}`);
  const gen = readFileSync(join(DIR, "generate.py"), "utf8");
  assert.match(gen, /guard_before_reducer_findings\(dash\)/, "main() runs the check");
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  assert.match(readme, /field\.state\.calcs/, "the README names the cache");
  assert.match(readme, /never before a\s+`groupBy`/, "the README states the rule");
});
test("Lead times table one-series: transforms do not require a field that vanishes when only PR-opened is in range", () => {
  const p = panel(BUSINESS, "Lead times");
  const xf = p.transformations ?? [];
  assert.ok(xf.some((t) => t.id === "labelsToFields"), "labels become fields even with one series");
  assert.ok(xf.indexOf(xf.find((t) => t.id === "labelsToFields")) < xf.indexOf(xf.find((t) => t.id === "merge")),
    "labelsToFields before merge so 2+ frames still have f_ticket / lead");
  assert.ok(!xf.some((t) => t.id === "joinByField" || t.id === "seriesToRows" || t.id === "groupBy"));
  const rename = xf.find((t) => t.id === "renameByRegex").options;
  assert.match(rename.regex, /Value\.\*/);
  assert.match(rename.regex, /Filed → /);
  assert.equal(rename.renamePattern, "ms");
  const matrix = xf.find((t) => t.id === "groupingToMatrix");
  assert.notEqual(matrix.options.valueField, "Value #A");
  assert.notEqual(matrix.options.valueField, "Value");
  const organize = xf.find((t) => t.id === "organize").options;
  assert.equal(organize.renameByName["f_ticket\\lead"], "Ticket");
  assert.deepEqual(Object.entries(organize.indexByName).sort((a, b) => a[1] - b[1]).map(([k]) => organize.renameByName[k] || k),
    ["Ticket", "Filed → PR opened", "Filed → merged"]);
  assert.ok(!Object.values(organize.renameByName).some((n) => /f_ticket|\\/.test(n)));
  assert.ok(!Object.keys(organize.renameByName).includes("f_ticket"));

  // Loki dataplane numeric-multi: one frame per series, labels on Value, displayNameFromDS slug.
  const lokiLead = (ticket, lead, ms) => ({
    Time: [1_728_510_000_000],
    Value: [ms],
    labels: { f_ticket: ticket, lead },
    displayNameFromDS: `{f_ticket="${ticket}", lead="${lead}"}`,
  });
  const headers = (out) => Object.keys(out);
  const one = runTransforms([lokiLead("TLSSN-64", "Filed → PR opened", 1_346_701)], xf);
  assert.deepEqual(one.Ticket, ["TLSSN-64"]);
  assert.equal(one["Filed → PR opened"][0], 1_346_701);
  assert.equal(one["Filed → merged"], undefined, "merged column is absent, not a dropped row");
  assert.deepEqual(headers(one), ["Ticket", "Filed → PR opened"]);
  assert.ok(!headers(one).some((h) => h.includes("\\") || h.includes("f_ticket")));

  const both = runTransforms([
    lokiLead("TLSSN-56", "Filed → PR opened", 1_289_924),
    lokiLead("TLSSN-56", "Filed → merged", 74_792_478),
    lokiLead("TLSSN-63", "Filed → PR opened", 1_194_433),
  ], xf);
  assert.deepEqual(headers(both), ["Ticket", "Filed → PR opened", "Filed → merged"]);
  assert.ok(!headers(both).some((h) => h.includes("\\") || h === "f_ticket"));
  const i56 = both.Ticket.indexOf("TLSSN-56");
  const i63 = both.Ticket.indexOf("TLSSN-63");
  assert.equal(both["Filed → PR opened"][i56], 1_289_924);
  assert.equal(both["Filed → merged"][i56], 74_792_478);
  assert.equal(both["Filed → PR opened"][i63], 1_194_433);
  assert.equal(both["Filed → merged"][i63], null, "TLSSN-63 merged stays blank");

  const empty = runTransforms([], xf);
  assert.equal(Object.keys(empty).length, 0);
  assert.match(p.fieldConfig.defaults.noValue, /No ticket reached PR opened in range\. Widen the time range\./);
});

test("empty states follow one standard: what is missing, then what to do", () => {
  const v2 = [[BUSINESS, "Ticket flow"], [BUSINESS, "Lead times"],
    [OPS, "Stuck tickets (past hop deadline)"], [OPS, "Recent tickets (latest 20, 7 days)"],
    [OPS, "Ticket journey: spans"], [OPS, "Ticket journey: events in time order"],
    [OPS, "Turns completed vs failed per bucket"], [BUSINESS, "Cumulative spend"]];
  for (const [uid, title] of v2) {
    assert.match(panel(uid, title).fieldConfig.defaults.noValue, /^[A-Z].*[a-z]\. [A-Z].*\.$/, `${uid} / ${title}`);
  }
});

// The v2 / v4 panel builders whose dataclass arguments must be keyword-only (Copy, Size, Query, ...).
const V2_FUNCTIONS = ["announce_selector", "announce_table", "background", "cost_per_ticket", "deliveries_by_event_type_table",
  "deliveries_by_kind_table", "empty_state", "stage_age", "failed_or_noop_table", 
  "latency_heatmap", "recent_tickets", "state_mappings", "stuck_count", "stuck_table", "stuck_transforms",
  // v4
  "business", "ops", "filed_stat", "prs_opened_stat", "merged_stat", "first_pass_stat", "lead_time_stat", "lead_pr_stat",
  "lead_merged_stat", "slack_approvals_stat", "spend_stat", "cost_per_merged_stat", "hours_saved_stat", "ticket_flow_bars",
  "lead_times_table", "ticket_flow_conversion", "business_header", "estimate_text_short", "tickets_reaching", "unattributed_cost", "cost_by_service", "cumulative_cost", "estimate_text", "loki_count_stat", "hours_var",
  "either_window", "first_line_ms", "lead_time_ms", "tickets_with", "bugbot_tickets", "first_pass_rate"];

test("v2 dataclass call sites are keyword-only", () => {
  const script = `
import ast, dataclasses, sys
sys.path.insert(0, ${JSON.stringify(DIR)})
import generate as g
v2 = set(${JSON.stringify(V2_FUNCTIONS)})
classes = {n for n, c in vars(g).items() if isinstance(c, type) and dataclasses.is_dataclass(c) and c.__module__ == "generate"}
tree = ast.parse(open(${JSON.stringify(join(DIR, "generate.py"))}).read())
defined = {f.name for f in ast.walk(tree) if isinstance(f, ast.FunctionDef)}
missing = sorted(v2 - defined)
bad = [f"{f.name}:{c.lineno} {c.func.id}" for f in ast.walk(tree) if isinstance(f, ast.FunctionDef) and f.name in v2
       for c in ast.walk(f) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name) and c.func.id in classes and c.args]
print(missing, bad)
assert g.EmptyState.__dataclass_params__.kw_only
sys.exit(1 if missing or bad else 0)
`;
  const out = run(["-c", script]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
});
test("v2 small fixes: no donut, time format, 1280 widths, errors + warnings", () => {
  assert.ok(!dashboards.some(({ json }) => panels(json).some((p) => p.title === "Cost share")), "the Cost share donut was cut (bar, not pie)");
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "table")) {
      for (const o of p.fieldConfig.overrides ?? []) {
        if (!["Time", "Start time", "Since"].includes(o.matcher?.options)) continue;
        const unit = (o.properties ?? []).find((x) => x.id === "unit");
        if (unit) assert.equal(unit.value, "time:YYYY-MM-DD HH:mm:ss", `${uid} / ${p.title} / ${o.matcher.options}`);
      }
    }
  }
  const events = panel(OPS, "Recent factory events (newest 200)");
  assert.equal(minWidthByName(events).get("Service"), 190, "factory-security-reviewer fits");
  const byService = panel(OPS, "Tokens and cost by service");
  const reasoning = byService.fieldConfig.overrides.find((o) => o.matcher.options === "Reasoning").properties;
  assert.equal(reasoning.find((x) => x.id === "noValue").value, "0");
  const errors = panel(OPS, "Err & warn");
  assert.equal(errors.type, "stat");
  const cross = panel(OPS, "Cross-check: tokens in logs vs metric (range)");
  assert.equal(cross.fieldConfig.defaults.unit, "short");
});

test("verify.py posts an expression panel's targets together and warns on Inf / NaN", () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(DIR)})
import verify as v
expr = {"targets": [{"refId": "A", "datasource": {"type": "prometheus"}}, {"refId": "C", "datasource": {"type": "__expr__", "uid": "__expr__"}}]}
plain = {"targets": [{"refId": "A", "datasource": {"type": "prometheus"}}, {"refId": "B", "datasource": {"type": "loki"}}]}
assert v.is_expression(expr["targets"][1]) and not v.is_expression(expr["targets"][0])
class G:
    def __init__(self): self.bodies = []
    def call(self, req, body=None):
        self.bodies.append(body)
        return 200, {"results": {q["refId"]: {"frames": []} for q in body["queries"]}}
    def ds_query(self, q, span=None):
        return self.call(None, body={"queries": [q]})
g = G()
rows = [(t, t, 0, 1, []) for t in expr["targets"]]
list(v.run_batch(g, rows=rows))
assert [len(b["queries"]) for b in g.bodies] == [2], g.bodies
g = G()
list(v.run_batch(g, rows=[(t, t, 0, 1, []) for t in plain["targets"]]))
assert [len(b["queries"]) for b in g.bodies] == [1, 1], g.bodies
assert v.non_finite({"frames": [{"data": {"entities": [None, {"Inf": [1]}]}}]})
assert not v.non_finite({"frames": [{"data": {"values": [[1], [2.0]]}}]})
print("ok")
`;
  const out = run(["-c", script]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
});

test("README documents the v4 panels, the Loki milestone figures, thresholds and data gaps", () => {
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  for (const re of [/Ticket flow/, /Stuck tickets \(past hop deadline\)/, /Lead times/,
    /First-pass rate/, /Slack approvals per ticket/, /Engineer-hours saved \(modelled\)/, /hours_per_ticket/, /MODELLED, not measured/,
    /Exec duration/, /Recent tickets/, /RETIRED_UIDS/, /jira\.announce/, /background flush/i, /bugbot_round/, /unixEpochMillis/,
    /Data does not have a time field/, /Okabe-Ito/, /25h/, /Pick a ticket in the Ticket box above/, /needs_info/,
    /verified on 13\.3\.0/, /load_smoke/]) assert.match(readme, re);
  assert.doesNotMatch(readme, /daily_budget|Budget used/, "no budget on either dashboard");
});

test("param_rule sees through typing. / t. prefixes, so a module prefix cannot hide an adjacent pair", () => {
  const file = join(mkdtempSync(join(tmpdir(), "param-rule-")), "a.py");
  writeFileSync(file, "import typing\nimport typing as t\ndef f(a: typing.Optional[str], *, b: str | None):\n    pass\ndef g(a: t.Optional[int], *, b: int):\n    pass\n");
  const out = spawnSync("python3", [join(DIR, "tools", "param_rule.py"), "--annotations", file], { encoding: "utf8" });
  assert.equal(out.status, 1);
  assert.deepEqual(JSON.parse(out.stdout).map((x) => x.split(" ").slice(1).join(" ")), ["f(a, b): annotation str", "g(a, b): annotation int"]);
});

test("no chart falls back to palette-classic: an unlisted series is grey, the span palette has no red or orange", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => ["timeseries", "piechart", "barchart", "bargauge"].includes(x.type))) {
      const mode = p.fieldConfig.defaults.color?.mode;
      assert.notEqual(mode, "palette-classic", `${uid} / ${p.title}: palette-classic paints a healthy series red or orange`);
      assert.notEqual(mode, undefined, `${uid} / ${p.title}`);
    }
  }
  const span = panel(OPS, "Delivery p95 by span");
  const colours = span.fieldConfig.overrides.map((o) => o.properties.find((x) => x.id === "color")?.value?.fixedColor).filter(Boolean);
  assert.equal(colours.length, 6);
  for (const c of colours) {
    assert.ok(!/^(red|orange)$/i.test(c), c);
    const h = hue(c);
    assert.ok(h === null || !(h < 45 || h > 345), `${c}: hue ${h} is red or orange`);
  }
  for (const name of ["factory.github.task", '{factory_span="factory.github.task"}']) {
    assert.ok(span.fieldConfig.overrides.some((o) => grafanaRegex(o.matcher.options).test(name)), `${name} is coloured`);
  }
  const levels = panel(OPS, "Log lines per bucket by level");
  assert.equal(levels.fieldConfig.overrides.find((o) => o.matcher.options === "unknown").properties[0].value.fixedColor, "#767676");
  const events = panel(OPS, "July events per bucket");
  assert.ok(events.fieldConfig.overrides.some((o) => o.matcher.options === "action.result"), "the largest July event is named");
});

test("span tables keep their outcome and status colours; nil cells stay blank", () => {
  for (const p of panels(byUid(OPS)).filter((x) => x.type === "table" && x.datasource?.type === "tempo")) {
    const nil = p.fieldConfig.overrides.find((o) => o.matcher.id === "byRegexp" && JSON.stringify(o).includes('"nil"'));
    if (!nil) continue;
    for (const coloured of ["Outcome", "Status", "HTTP status"]) {
      assert.ok(!grafanaRegex(nil.matcher.options).test(coloured), `${p.title}: the nil mapping would replace ${coloured}'s colours`);
    }
    for (const o of p.fieldConfig.overrides.filter((x) => ["Outcome", "Status", "HTTP status"].includes(x.matcher.options))) {
      const maps = o.properties.find((x) => x.id === "mappings")?.value ?? [];
      if (!maps.length) continue;
      assert.ok(maps.some((m) => m.type === "value" && m.options.nil), `${p.title} / ${o.matcher.options}: maps nil itself`);
      const reds = maps.some((m) => (m.type === "regex" && m.options.result.color === "red")
        || (m.type === "value" && Object.values(m.options).some((x) => x.color === "red")));
      assert.ok(reds, `${p.title} / ${o.matcher.options}: red stays`);
    }
  }
});

test("round-2 visual fixes: legends, labels, empty states, Service links, the In range grid", () => {
  for (const title of ["Delivery p95 by span", "Hosted HTTP p95 by service", "Hosted execution p95 by service (total)"]) {
    assert.equal(panel(OPS, title).fieldConfig.defaults.custom.lineWidth, 2, `${title}: visible on the light theme`);
  }
  assert.equal(panel(OPS, "Hosted execution p95 by service (total)").fieldConfig.defaults.decimals, 0, "2 min, not 1.67 mins");
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "timeseries")) {
      assert.match(p.fieldConfig.defaults.noValue, /^[A-Z].*[a-z]\. [A-Z].*\.$/, `${uid} / ${p.title}: the empty-state standard`);
    }
    for (const p of panels(json).filter((x) => x.type === "table")) {
      const names = (p.transformations ?? []).filter((t) => t.id === "organize").flatMap((t) => Object.values(t.options.renameByName ?? {}));
      if (!names.includes("Service")) continue;
      assert.ok(p.fieldConfig.overrides.some((o) => o.matcher.options === "Service" && o.properties.some((x) => x.id === "links")),
        `${uid} / ${p.title}: a Service cell is always a link`);
    }
  }
  const ops = byUid(OPS);
  const start = ops.panels.findIndex((p) => p.type === "row" && p.title === "In range");
  const end = ops.panels.findIndex((p, i) => i > start && p.type === "row");
  const tiles = ops.panels.slice(start + 1, end);
  assert.equal(tiles.length, 6, "one row of six w=4 tiles");
  assert.ok(tiles.every((p) => p.gridPos.w === 4 && p.gridPos.h === 4 && p.type === "stat"), "one tile size");
  assert.deepEqual(tiles.map((p) => p.title), ["Deliveries", "Errors", "Error %", "Ack p95", "Cost", "Cache %"]);
  const errPct = panel(OPS, "Error %");
  const steps = errPct.fieldConfig.defaults.thresholds.steps.map((s) => [s.value, s.color]);
  assert.ok(steps.some((s) => s[0] === 0.01), "amber from 1%");
  assert.ok(steps.some((s) => s[0] === 0.05), "red from 5%");
  const errorsInRange = tiles.find((p) => p.title === "Errors");
  assert.notEqual(errorsInRange.options.colorMode, "background", "Errors count is neutral; Error % is coloured");
  assert.equal(rowOf(OPS, "5xx"), "Debug: more in-range KPIs");
  assert.equal(rowOf(OPS, "Turns"), "Debug: more in-range KPIs");
});

test("kind colours match whole series names, as Grafana's anchored regex does", () => {
  const kinds = panel(OPS, "Deliveries per bucket by kind");
  const colourFor = (name) => kinds.fieldConfig.overrides.filter((o) => o.matcher?.id === "byRegexp" && grafanaRegex(o.matcher.options).test(name))
    .map((o) => o.properties.find((x) => x.id === "color")?.value?.fixedColor).filter(Boolean).at(-1);
  for (const [name, family] of [["jira.webhook", "jira"], ["jira.announce.triaged", "jira"], ['{factory_delivery_kind="hop_watch.backstop_sweep"}', "hop_watch"],
    ["reminder.hop_watch", "reminder"], ["github.workflow_run", "github"], ["schedule.hop-watch", "schedule"]]) {
    const c = colourFor(name);
    assert.ok(c, `${name}: coloured`);
    assert.ok(!/^(red|orange)$/.test(c), `${name}: ${c}`);
    assert.equal(c, colourFor(family), `${name} takes the ${family} colour`);
  }
});

test("every byRegexp matcher is written /.../, so Grafana 13.3 does not anchor it", () => {
  let n = 0;
  const walk = (value, where) => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, where));
    if (!value || typeof value !== "object") return;
    if (value.matcher?.id === "byRegexp") {
      n += 1;
      assert.match(value.matcher.options, /^\/.+\/[a-z]*$/s, `${where}: ${value.matcher.options}`);
      assert.doesNotThrow(() => grafanaRegex(value.matcher.options), where);
    }
    Object.values(value).forEach((v) => walk(v, where));
  };
  for (const { uid, json } of dashboards) for (const p of panels(json)) walk(p.fieldConfig, `${uid} / ${p.title}`);
  assert.ok(n > 40, `found ${n} regex matchers`);
});

test("Tempo search progress fields are dropped before the ticket panels read the frames", () => {
  const progress = ["State", "Elapsed Time", "Total Blocks", "Progress"];
  const searchPanels = [[OPS, "Stuck tickets (past hop deadline)"], [OPS, "Stuck now"]];
  for (const [uid, title] of searchPanels) {
    const first = panel(uid, title).transformations[0];
    assert.equal(first.id, "filterFieldsByName", `${uid} / ${title}`);
    assert.deepEqual(first.options.exclude.names, progress, `${uid} / ${title}`);
  }
  // An empty streaming search returns only the progress frame: no ticket row comes out of it.
  const onlyProgress = { State: ["done"], "Elapsed Time": [120], "Total Blocks": [8], Progress: [100] };
  const stuck = panel(OPS, "Stuck tickets (past hop deadline)");
  const out = runTransforms(onlyProgress, stuck.transformations, { to: 10 * H });
  assert.deepEqual(out.Ticket ?? [], [], "no null ticket from the progress row");
});

test("counter-based cost, Today and per-turn panels say counters can read high after an instance-id change", () => {
  const want = {
    [OPS]: ["Cost per merged ticket", "Deliveries by service, kind and outcome", "Deliveries that failed or did nothing",
      "Cost by ticket"],
  };
  for (const [uid, titles] of Object.entries(want)) {
    const json = byUid(uid);
    for (const title of titles) {
      const p = panels(json).find((x) => x.title === title);
      assert.ok(p, `${uid} / ${title}`);
      assert.match(p.description, /can read high after a host changes its service instance id/, `${uid} / ${title}`);
      assert.doesNotMatch(p.description, /405/, `${uid} / ${title}: sampled spans are not a counter reference`);
    }
  }
  assert.match(panel(OPS, "Error %").description, /ratio can be off either way/);
});

test("cost per ticket over time: mean full cost of tickets merged in the trailing 24h, 7d cost lookback, merged only", () => {
  const p = panel(OPS, "Cost per merged ticket");
  assert.equal(p.type, "timeseries");
  assert.equal(p.datasource.type, "prometheus", "Prometheus: reads at 6h to 30d, no Tempo 25h limit");
  assert.equal(p.fieldConfig.defaults.unit, "currencyUSD");
  const [bucket, rolling] = p.targets;
  assert.deepEqual(p.targets.map((t) => t.legendFormat), [
    "per 6h bucket (merged in that 6h, 7d cost lookback)",
    "mean cost per merged ticket (merged in trailing 24h, 7d cost lookback)"]);
  for (const t of p.targets) {
    assert.match(t.expr, /^avg\(/, `${t.legendFormat}: the mean across merged tickets, each weighted once`);
    assert.match(t.expr, /\) \/ on \(factory_ticket_key\) \(/, `${t.legendFormat}: each ticket's own cost over its own merge row`);
    assert.doesNotMatch(t.expr, /\$\{service:pipe\}/, `${t.legendFormat}: all hosts, never the Service filter`);
    assert.match(t.expr, /\$price_input/);
    assert.match(t.expr, /\[7d\]/, `${t.legendFormat}: the cost lookback covers a ticket's lifetime`);
    assert.match(t.expr, /apj_factory_ticket_merged_total\{service_namespace="software-factory", factory_ticket_key!~"none\|other\|"\}/,
      `${t.legendFormat}: merged tickets come from the merged counter, keyed only, all hosts`);
    assert.doesNotMatch(t.expr, /factory_delivery_kind/, `${t.legendFormat}: not the announce counter`);
    assert.match(t.expr, /\* 0 \+ 1\)/, `${t.legendFormat}: each merged key divides by exactly 1`);
  }
  assert.match(bucket.expr, /apj_factory_ticket_merged_total\{[^}]*\}\[6h\]/, "points: merges per 6h bucket");
  assert.equal(bucket.interval, "6h", "a bucket long enough to hold a ticket's merges");
  assert.match(rolling.expr, /apj_factory_ticket_merged_total\{[^}]*\}\[1d\]/, "line: merges in the trailing 24 hours");
  const colour = Object.fromEntries(p.fieldConfig.overrides.filter((o) => o.properties.some((x) => x.id === "color"))
    .map((o) => [o.matcher.options, o.properties.find((x) => x.id === "color").value.fixedColor]));
  assert.deepEqual(Object.keys(colour).sort(), p.targets.map((t) => t.legendFormat).sort());
  for (const c of Object.values(colour)) {
    const h = hue(c);
    assert.ok(h >= 195 && h <= 215, `${c}: the neutral cost (blue) ramp`);
  }
  const drawn = (name, id) => p.fieldConfig.overrides.filter((o) => o.matcher.options === name)
    .flatMap((o) => o.properties).find((x) => x.id === id)?.value;
  assert.equal(drawn("per 6h bucket (merged in that 6h, 7d cost lookback)", "custom.drawStyle"), "points");
  assert.equal(p.fieldConfig.defaults.custom.spanNulls, false, "a window with no merge is a gap");
  assert.doesNotMatch(p.description, /not tagged with the ticket key/, "stale: the key is on July's token and cost metrics since 2026-10-04");
  assert.match(p.description, /merged in the trailing 24h|merged in that window/s);
  assert.match(p.description, /mean/i);
  assert.match(p.description, /7 days|7d/);
  assert.match(p.description, /2026-10-04 04:43 UTC/, "the key deploy time bounds the line");
  assert.match(p.description, /cloud build agent/, "the worker's cloud agent is not counted");
  // TLSSN-60's planner cloud turn did report tokens (input 187,541 net of 1,191,168 cache reads): counted, not unverified.
  assert.doesNotMatch(p.description, /hosted planning cloud turns are unverified/);
  assert.match(p.description, /planner's cloud turns \(since #227\)[^.]*report input net of cache reads/);
  assert.match(p.fieldConfig.defaults.noValue, /^No merged ticket with keyed cost yet\. /);
});

test("transformation frame filters use only byName or byRefId (all Grafana 13 registers; invertMatch throws)", () => {
  for (const { uid, json } of dashboards) {
    for (const p of panels(json)) {
      for (const t of p.transformations ?? []) {
        if (t.filter) assert.ok(["byName", "byRefId"].includes(t.filter.id), `${uid} / ${p.title}: ${t.id} filter ${t.filter.id}`);
      }
    }
  }
});

function grafanaRegexp(pat) {
  const text = String(pat);
  if (text.length >= 2 && text.startsWith("/") && text.endsWith("/")) {
    return new RegExp(text.slice(1, -1));
  }
  return new RegExp(`^${text}$`);
}

test("kind and service/status byRegexp match legend and Prometheus field names", () => {
  const overview = byUid(OPS);
  const byKind = panels(overview).find((p) => p.title === "Deliveries per bucket by kind");
  const kindPats = (byKind.fieldConfig.overrides ?? [])
    .filter((o) => o.matcher?.id === "byRegexp")
    .map((o) => grafanaRegexp(o.matcher.options));
  const jira = kindPats.find((re) => re.test("jira"));
  assert.ok(jira, "kind prefix matches legend jira");
  assert.ok(jira.test("{factory_delivery_kind=\"jira\"}"), "kind prefix matches Prom field name");
  assert.ok(jira.test("jira:issue_created"), "kind prefix matches jira:issue_created");
  assert.ok(jira.test("jira:issue_updated"), "kind prefix matches jira:issue_updated");
  const http = panels(overview).find((p) => p.title.startsWith("HTTP requests per bucket"));
  const httpPats = (http.fieldConfig.overrides ?? [])
    .filter((o) => o.matcher?.id === "byRegexp")
    .map((o) => ({ re: grafanaRegexp(o.matcher.options), raw: String(o.matcher.options) }));
  assert.ok(httpPats.some((p) => p.re.test("factory-desk 200")), "service prefix matches legend");
  assert.ok(httpPats.some((p) => p.re.test('{service_name="factory-desk",http_response_status_code="200"}')),
    "service prefix matches Prom field name");
  assert.ok(httpPats.some((p) => /5\\d\\d/.test(p.raw) && p.re.test("factory-desk 500")),
    "5xx suffix matches factory-desk 500");
  assert.ok(httpPats.some((p) => /5\\d\\d/.test(p.raw)
    && p.re.test('{service_name="factory-desk",http_response_status_code="500"}')),
    "5xx suffix matches Prom field name");
  assert.ok(httpPats.some((p) => /4\\d\\d/.test(p.raw) && p.re.test("factory-desk 404")),
    "4xx suffix matches factory-desk 404");
  assert.ok(httpPats.some((p) => p.re.test("factory-desk 200") && !p.re.test("factory-desk-extra 200")),
    "service prefix must not swallow factory-desk-extra");
});

test("time-override badges, Tempo empty stats, estimate height, handoff class", () => {
  const overview = byUid(OPS);
  const traces = byUid(OPS);
  const tokens = byUid(OPS);
  // The 15m window lives in the row title ("Now · 15m"), not each stat title:
  // short titles keep the stat header on one line at 1280 px.
  assert.ok(overview.panels.some((p) => p.type === "row" && p.title === "Now · 15m"), "Now · 15m row");
  for (const p of panels(overview).filter((x) => x.timeFrom === "15m")) {
    assert.equal(p.hideTimeOverride, true, `${p.title}: badge hidden; pin is in the row title`);
    assert.doesNotMatch(p.title, / · 15m$/, `${p.title}: the row carries the window`);
  }
  // v2 replaced the four pinned Tempo count stats with the Summary row's search counts (any range).
  assert.ok(panels(traces).every((x) => !/ · 24h$/.test(x.title)), "no pinned Tempo count stats remain");
  const note = panels(byUid(OPS)).find((p) => p.title === "Estimate, not billing");
  assert.ok(note && note.gridPos.h >= 9, `estimate text height ${note?.gridPos.h}`);
  const byClass = panels(overview).find((p) => p.title.includes("outcome class"));
  assert.match(byClass.targets[0].expr, /"handoff"/);
  assert.match(byClass.description, /handoff/);
  const handoff = (byClass.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "handoff");
  assert.equal(handoff?.properties?.find((prop) => prop.id === "color")?.value?.fixedColor, "#88CCEE");
  const src = readFileSync(join(DIR, "generate.py"), "utf8");
  assert.match(src, /OUTCOME_HANDOFF/);
  assert.match(src, /"task", "turn", "dispatched"/);
});

test("tables fit the measured 1280 px grid: fixed widths or minWidth floors within budget", () => {
  // Mirrors generate.py's check_column_width_budgets: each visible column is a
  // fixed custom.width or an elastic custom.minWidth floor (the label column
  // stretches); a column with neither counts at the 70 px table default.
  const BUDGET = { 8: 362, 12: 555, 24: 1140 };
  for (const { uid, json } of dashboards) {
    for (const p of panels(json).filter((x) => x.type === "table")) {
      // Dedupe display names: organize indexes both "Value" and "Value #A"
      // (merge yields one or the other), renamed to the same column.
      const visible = [...new Set(organizeVisible(p) ?? [])];
      if (!visible.length) continue;
      let sum = 0;
      for (const name of visible) {
        sum += widthByName(p).get(name) ?? minWidthByName(p).get(name) ?? 70;
      }
      const budget = BUDGET[p.gridPos.w] ?? panelWidthPx(p.gridPos.w);
      assert.ok(sum <= budget, `${uid} / ${p.title}: ${sum}px > ${budget}px at 1280`);
      if (p.gridPos.w <= 12) {
        for (const name of visible) {
          assert.ok(widthByName(p).has(name) || minWidthByName(p).has(name),
            `${uid} / ${p.title}: ${name} needs custom.width or custom.minWidth`);
        }
      }
    }
  }
});

test("newest-N and ticket-journey TraceQL pins most_recent", () => {
  const traces = byUid(OPS);
  for (const p of panels(traces).filter((x) => x.type === "table" && (x.datasource ?? {}).type === "tempo")) {
    if (!/newest|ticket journey/i.test(p.title)) continue;
    for (const t of p.targets ?? []) {
      assert.match(t.query || "", /with\(most_recent=true\)/, p.title);
    }
  }
});

test("PALETTE and overrides reject alarm hues outside severity groups", { skip }, () => {
  const src = readFileSync(join(DIR, "generate.py"), "utf8");
  assert.match(src, /def palette_alarm_findings/);
  assert.match(src, /WIDTH_BUDGET_1280 = \{8: 362, 12: 555, 24: 1140\}/);
  assert.doesNotMatch(src, /"output": "#E69F00"/);
  const tokens = byUid(OPS);
  const kinds = panels(tokens).find((p) => p.title.startsWith("Tokens per bucket:"));
  const output = (kinds.fieldConfig.overrides ?? []).find((o) => o.matcher?.options === "output")
    ?.properties?.find((prop) => prop.id === "color")?.value?.fixedColor;
  assert.equal(output, "#6A7FD1");
  const py = run(["-c", [
    "import generate as g",
    "assert not g.palette_alarm_findings()",
    "bad = g.palette_alarm_findings(palette={'token': {'output': '#E69F00'}})",
    "assert bad, bad",
    "print('ok')",
  ].join("\n")]);
  assert.equal(py.status, 0, `${py.stdout}${py.stderr}`);
});

test("compare_range_totals skips quotient stats; grafana_version_ok is 13.1+", { skip }, () => {
  const py = run(["-c", [
    "import verify",
    "assert verify.grafana_version_ok('13.1.0')",
    "assert verify.grafana_version_ok('13.3.0')",
    "assert not verify.grafana_version_ok('12.2.0')",
    "assert not verify.grafana_version_ok('13.0.9')",
    "import inspect, re",
    "src = inspect.getsource(verify.compare_range_totals)",
    "assert r')\\s*/\\s*(' in src or 'skip' in src.lower()",
    "print('ok')",
  ].join("\n")]);
  assert.equal(py.status, 0, `${py.stdout}${py.stderr}`);
});

test("no query or variable contains '$$': Grafana collapses it to a literal '$'", () => {
  for (const { uid, json } of dashboards) {
    for (const { panel, target } of targets(json)) {
      const text = `${target.expr ?? ""}${target.query ?? ""}`;
      assert.ok(!text.includes("$$"), `${uid} / ${panel.title} (${target.refId}): '$$' in the query`);
    }
    for (const v of json.templating.list) {
      assert.ok(!`${v.query ?? ""}${v.definition ?? ""}`.includes("$$"), `${uid} var ${v.name}: '$$'`);
    }
  }
});

test("per-service zero-fill lists all six slugs exactly once and respects the service filter", () => {
  const slugs = ["factory-desk", "factory-planner", "factory-worker",
    "factory-pr-autofixer", "factory-security-reviewer", "factory-triage-jira"];
  let found = 0;
  for (const { uid, json } of dashboards) {
    for (const { panel, target } of targets(json)) {
      const expr = target.expr ?? "";
      if (!expr.includes('label_replace(vector(0), "service_name"')) continue;
      found += 1;
      for (const slug of slugs) {
        const zero = `label_replace(vector(0), "service_name", "${slug}", "", "")`;
        assert.equal(expr.split(zero).length - 1, 1,
          `${uid} / ${panel.title} (${target.refId}): ${slug} zero-filled once`);
      }
      // The zeros honour $service (narrowing the variable must not resurrect
      // filtered slugs) and merge via `or`, so a live series is never doubled.
      assert.match(expr, /"pick", "yes", "service_name", "\$\{service:regex\}"/,
        `${uid} / ${panel.title} (${target.refId}): zeros must respect the service filter`);
      assert.match(expr, /or sum by \(service_name\) \(/,
        `${uid} / ${panel.title} (${target.refId}): zeros join with 'or', so live series win`);
    }
  }
  assert.ok(found >= 10, `expected widespread zero-fill, found ${found} targets`);
});
