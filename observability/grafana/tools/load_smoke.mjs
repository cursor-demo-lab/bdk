#!/usr/bin/env node
// Loads each Factory dashboard in headless Chrome at 24h, 7d and 30d, expands every collapsed row, and fails on a
// whole-dashboard crash ("An unexpected error happened") or any panel error icon (with its tooltip). It catches what
// /api/ds/query cannot: frontend-only failures (an unknown colour mode, a variable query Grafana rewrites, a Tempo
// search or transform error) and backend limits such as Tempo's metrics max_duration.
//
//   node tools/load_smoke.mjs [--ranges 24h,7d,30d] [--dashboards factory-business,factory-ops] [--json out.json]
//
// GRAFANA_URL (default http://127.0.0.1:3000); GRAFANA_TOKEN or GRAFANA_TOKEN_FILE for a stack that needs auth (sent
// as a header, never printed); CHROME (default /usr/local/bin/google-chrome); PUPPETEER_CORE, the puppeteer-core
// module to import (default "puppeteer-core"). Exit 1 on any failure, 2 when puppeteer-core is missing.
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const ranges = (args.ranges ?? "24h,7d,30d").split(",");
const uids = (args.dashboards ?? "factory-business,factory-ops").split(",");
const base = (process.env.GRAFANA_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const token = process.env.GRAFANA_TOKEN ?? (process.env.GRAFANA_TOKEN_FILE ? readFileSync(process.env.GRAFANA_TOKEN_FILE, "utf8").trim() : "");

let puppeteer;
try {
  puppeteer = (await import(process.env.PUPPETEER_CORE ?? "puppeteer-core")).default;
} catch {
  console.error("load_smoke: puppeteer-core not found; set PUPPETEER_CORE to its path (npm i puppeteer-core in a scratch dir)");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"] });
const report = [];
for (const uid of uids) {
  for (const range of ranges) {
    const page = await browser.newPage();
    if (token) await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
    await page.setViewport({ width: 1600, height: 1200 });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    await page.goto(`${base}/d/${uid}?orgId=1&kiosk&from=now-${range}&to=now`, { waitUntil: "networkidle0", timeout: 120000 });
    // Grafana mounts panels only near the viewport, so errors are read at every scroll position, not at the end.
    const errors = new Map();
    const collect = async () => {
      for (const icon of await page.$$('[data-testid="data-testid Panel status error"]')) {
        const title = await icon.evaluate((e) => (e.closest("[data-viz-panel-key], section")?.querySelector("h2")?.textContent ?? "?").trim());
        if (errors.has(title)) continue;
        await icon.hover();
        await sleep(400);
        const tip = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].map((e) => e.innerText).join(" | "));
        errors.set(title, tip.slice(0, 300));
      }
    };
    // Scroll to the bottom (lazy rows), open every collapsed row, then scroll again so each panel queries.
    const scroll = async () => {
      for (let y = 0; y < 30000; y += 600) {
        const more = await page.evaluate((yy) => {
          const s = document.querySelector("#page-scrollbar") || document.scrollingElement;
          s.scrollTo(0, yy);
          return yy < s.scrollHeight;
        }, y);
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 20000 }).catch(() => {});
        await collect();
        if (!more) break;
      }
    };
    await scroll();
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('[data-testid*="dashboard-row-title"]')) {
        const row = b.closest("button") ?? b;
        if (row.getAttribute("aria-expanded") === "false") row.click();
      }
    });
    await sleep(1000);
    await scroll();
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 90000 }).catch(() => {});
    await collect();
    const crashed = await page.evaluate(() => document.body.innerText.includes("An unexpected error happened"));
    const panels = [...errors].map(([title, error]) => ({ title, error }));
    // A transformation that throws (an id this Grafana does not register) leaves its panel blank with no error icon,
    // so an uncaught page error fails the load too.
    const thrown = [...new Set(pageErrors.map((e) => e.split("\n")[0]))];
    const ok = !crashed && panels.length === 0 && thrown.length === 0;
    report.push({ uid, range, ok, crashed, panels, pageErrors: thrown });
    console.log(`${ok ? "ok  " : "FAIL"} ${uid} now-${range}${crashed ? " WHOLE DASHBOARD CRASHED" : ""}${panels.map((p) => `\n       ${p.title}: ${p.error}`).join("")}${thrown.map((e) => `\n       page error: ${e}`).join("")}`);
    await page.close();
  }
}
await browser.close();
if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2) + "\n");
const failed = report.filter((r) => !r.ok).length;
console.log(failed ? `load_smoke: ${failed} of ${report.length} loads failed` : `load_smoke: ${report.length} loads clean`);
process.exit(failed ? 1 : 0);
