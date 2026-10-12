import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibrateJudgment,
  calibrateSeverity,
  choosableTypes,
  DEFAULT_ISSUE_TYPES,
  JEV_THRESHOLD,
  judgeLine,
  judgeState,
  judgeTriage,
  jevConfidence,
  triagedByLine,
  kindForType,
  readAnswers,
  settleJudgment,
  severityCeiling,
  templateVerdict,
  triageQuestions,
  typeContradicted,
  guardJudgmentType,
  holdJudgmentType,
  ISSUE_TYPE_CRITERIA,
  type JevAnswers,
  type TriageJudgment,
} from "./jev-triage.js";
import type { TriageVerdict } from "./types.js";

type Labels = { issueType: [string, number]; severity: [string, number]; gate?: [string, number] };

/** A TypeSafe System One response, the shape `decide` decodes. */
function systemOne(labels: Labels): Record<string, unknown> {
  const answer = ([choice, probability]: [string, number]) => ({ choice, probabilities: { [choice]: probability } });
  return { answers: { issueType: answer(labels.issueType), severity: answer(labels.severity), gate: answer(labels.gate ?? ["proceed", 0.9]) } };
}

function stubFetch(respond: () => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const env = { TYPESAFE_API_KEY: "test-key" };
// As getJiraProjectIssueTypesMetadata returns them for a team-managed project, filtered to standard types.
const TLSSN_TYPES = { source: "project" as const, types: [{ name: "Task", id: "10170" }, { name: "Bug", id: "10172" }, { name: "Story", id: "10171" }] };

const modelSaid: TriageVerdict = {
  identifier: "TLSSN-7",
  kind: "question",
  severity: "low",
  title: "Why did my export fail yesterday?",
  summary: "Reporter asks why yesterday's export failed.",
  nextStep: "Answer the reporter.",
};

const inbound = {
  identifier: "TLSSN-7",
  title: "Why did my export fail yesterday?",
  description: "My CSV export failed at 14:02 yesterday with a 500. Request id 9f2c.",
  reporter: "Sam",
};

async function judge(labels: Labels, verdict: TriageVerdict = modelSaid) {
  const stub = stubFetch(() => json(systemOne(labels)));
  const judgment = await judgeTriage({ verdict, inbound, types: TLSSN_TYPES, env, fetch: stub.fetch });
  return { judgment, stub };
}

test("asks the project's own Jira type names, with the reporter's words and the key", async () => {
  const { stub } = await judge({ issueType: ["Bug", 0.93], severity: ["medium", 0.82] });
  assert.equal(stub.requests.length, 1);
  const { url, init } = stub.requests[0]!;
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((init.headers as Record<string, string>)["Authorization"], "Bearer test-key");
  assert.ok(init.signal instanceof AbortSignal, "every call carries a timeout signal");
  const body = JSON.parse(String(init.body));
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.state, { source: "webhook", title: inbound.title, description: inbound.description, reporter: "Sam" });
  assert.deepEqual(Object.keys(body.questions), ["issueType", "severity", "gate"]);
  for (const question of Object.values(body.questions) as { type: string }[]) assert.equal(question.type, "choice");
  assert.deepEqual(Object.keys(body.questions.issueType.criteria), ["Task", "Bug", "Story"]);
  assert.doesNotMatch(JSON.stringify(Object.keys(body.questions.issueType.criteria)), /bug"|question|feedback/);
});

test("only project types with a criterion are asked; Epic and unknown types are not", () => {
  const listed = [{ name: "Epic", id: "1" }, { name: "bug", id: "2" }, { name: "Feature", id: "3" }, { name: "Task", id: "4" }];
  assert.deepEqual(choosableTypes(listed), [{ name: "bug", id: "2" }, { name: "Task", id: "4" }]);
  assert.deepEqual(choosableTypes(DEFAULT_ISSUE_TYPES).map((type) => type.name), ["Bug", "Story", "Task"]);
});

test("fewer than two choosable types: no Jev call", async () => {
  const stub = stubFetch(() => json({}));
  const judgment = await judgeTriage({ verdict: modelSaid, inbound, types: { source: "project", types: [{ name: "Task", id: "1" }, { name: "Epic", id: "2" }] }, env, fetch: stub.fetch });
  assert.equal(judgment.status, "unavailable");
  assert.equal(stub.requests.length, 0);
});

test("the kind the planner gates on follows the Jira type", () => {
  assert.equal(kindForType("Bug", "question"), "bug");
  assert.equal(kindForType("Story", "bug"), "feedback");
  assert.equal(kindForType("Task", "question"), "question");
  assert.equal(kindForType("Task", "bug"), "feedback");
  assert.equal(kindForType("task", "feedback"), "feedback");
});

test("Needs info is recorded, never applied, in either direction", async () => {
  const add = await judge({ issueType: ["Bug", 0.9], severity: ["medium", 0.9], gate: ["needsInfo", 0.99] }, { ...modelSaid, kind: "bug" });
  const added = settleJudgment({ ...modelSaid, kind: "bug" }, add.judgment, { status: "set" });
  assert.equal(added.verdict.needsInfo, undefined);
  assert.equal(added.judgment.status === "judged" && added.judgment.gate.choice, "needsInfo");

  const clear = await judge({ issueType: ["Bug", 0.9], severity: ["medium", 0.9], gate: ["proceed", 0.99] }, { ...modelSaid, kind: "bug", needsInfo: true });
  assert.equal(settleJudgment({ ...modelSaid, kind: "bug", needsInfo: true }, clear.judgment, { status: "set" }).verdict.needsInfo, true);
});

test("fail-open: HTTP error, non-JSON, timeout, and off-label answers keep the model's verdict", async () => {
  const cases: { name: string; fetch: typeof globalThis.fetch; timeoutMs?: number }[] = [
    { name: "500", fetch: stubFetch(() => json({ error: "boom" }, 500)).fetch },
    { name: "non-json", fetch: stubFetch(() => new Response("<html>", { status: 200 })).fetch },
    { name: "internal label", fetch: stubFetch(() => json(systemOne({ issueType: ["bug", 0.99], severity: ["low", 0.9] }))).fetch },
    { name: "off-label type", fetch: stubFetch(() => json(systemOne({ issueType: ["Epic", 0.99], severity: ["low", 0.9] }))).fetch },
    {
      name: "timeout",
      timeoutMs: 20,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // AbortSignal.timeout's timer is unref'd; keep this idle test process alive until it fires.
          const alive = setTimeout(() => {}, 5_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(alive);
            reject(init.signal?.reason);
          });
        })) as typeof globalThis.fetch,
    },
  ];
  for (const entry of cases) {
    const judgment = await judgeTriage({ verdict: modelSaid, inbound, types: TLSSN_TYPES, env, fetch: entry.fetch, ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }) });
    assert.equal(judgment.status, "unavailable", entry.name);
    assert.equal(settleJudgment(modelSaid, judgment, { status: "not_written" }).verdict, modelSaid, entry.name);
    assert.equal(judgeLine(judgment), undefined, entry.name);
  }
});

test("without the webhook stash the judge falls back to the model's title and summary, and says so", () => {
  assert.deepEqual(judgeState(modelSaid, undefined), { source: "model", title: modelSaid.title, description: modelSaid.summary });
  assert.deepEqual(judgeState(modelSaid, { identifier: "TLSSN-7", title: " ", description: "" }).source, "model");
});

test("the Judge: line is plain text the desk can parse", () => {
  const judgment: TriageJudgment = {
    status: "judged",
    source: "webhook",
    types: "project",
    type: { choice: "Task", id: "10170", probability: 0.912, model: "bug", confident: true, jira: "set", applied: true },
    severity: { choice: "low", probability: 0.88, model: "low", applied: false },
    gate: { choice: "proceed", probability: 0.9, model: "proceed" },
  };
  assert.equal(judgeLine(judgment), "Judge: Jev type Task 0.91 (set in Jira; model said bug); severity low 0.88 (agreed)");
});

test("a Jev-only verdict cuts a long title between words with …, in its title and its templated summary", () => {
  const title = 'On the Activity page the "Sol 214"-style day separators are plain divs, so screen reader users can\'t jump between days with the heading shortcut and the list reads as one unbroken run of transactions.';
  const answer = (choice: string) => ({ choice, probabilities: { [choice]: 0.9 } });
  const verdict = templateVerdict({ identifier: "TLSSN-50", title }, { issueType: answer("Bug"), severity: answer("medium"), gate: answer("proceed") } as JevAnswers)!;
  const quoted = verdict.summary.match(/^Bug reported as "(.*)", medium severity\.$/)?.[1];
  for (const [cut, max] of [[verdict.title, 80], [quoted!, 160]] as const) {
    assert.ok(cut.length <= max && cut.endsWith("…"), cut);
    const kept = cut.slice(0, -1);
    assert.ok(title.startsWith(kept));
    assert.match(title.slice(kept.length), /^[\s,]/, `cut mid-word: …${kept.slice(-12)}|${title.slice(kept.length, kept.length + 8)}`);
  }
  assert.equal(templateVerdict({ identifier: "TLSSN-51", title: "Export fails" }, { issueType: answer("Bug"), severity: answer("low"), gate: answer("proceed") } as JevAnswers)!.title, "Export fails");
});

test("a Jev-only verdict's title cut near a path ends before the path, not inside it", () => {
  const answer = (choice: string) => ({ choice, probabilities: { [choice]: 0.9 } });
  const title = "The Held column is wrong for every loan row rendered by components/banking/accounts-table.tsx on main";
  const verdict = templateVerdict({ identifier: "TLSSN-52", title }, { issueType: answer("Bug"), severity: answer("low"), gate: answer("proceed") } as JevAnswers)!;
  assert.equal(verdict.title, "The Held column is wrong for every loan row rendered by…");
});

// Live 2026-09-27: this confirmation-step request came out "Triaged by Jev: Bug, urgent severity."
const LOG_OUT = 'The "Log out" button logs you out straight away even when the transfer form has something typed in. Could it ask to confirm first when the form has input?';
const SEVERITY_ORDER = ["low", "medium", "high", "urgent"] as const;

test("calibrateSeverity: a UX or confirmation-step ask with no data-loss, security, or outage words is never high or urgent", () => {
  for (const severity of ["urgent", "high"] as const) {
    assert.equal(calibrateSeverity({ text: LOG_OUT, type: "Bug", severity }), "medium", `Bug ${severity}`);
    assert.equal(calibrateSeverity({ text: LOG_OUT, type: "Story", severity }), "medium", `Story ${severity}`);
  }
  assert.equal(calibrateSeverity({ text: "Losing what I typed in the transfer form when the page reloads is annoying.", type: "Bug", severity: "urgent" }), "medium", "typed form input is not data loss");
  assert.equal(calibrateSeverity({ text: "Could the Save button say Saved instead of Done?", type: "question", severity: "high" }), "low", "a question is at most low");
  assert.equal(calibrateSeverity({ text: "The export button throws an error on empty filters.", type: "Story", severity: "high" }), "medium");
  assert.equal(calibrateSeverity({ text: "Please expose the session timeout as a setting.", type: "Story", severity: "urgent" }), "medium", "expose alone is a UI ask, not a leak");
});

test("calibrateSeverity: a Story or Task describing a sharp edge that costs time keeps medium", () => {
  for (const type of ["Story", "Task", "feedback"]) {
    assert.equal(calibrateSeverity({ text: "Tellers keep re-entering every transfer after a timeout; please add autosave.", type, severity: "medium" }), "medium", type);
  }
});

// A Story is capped by its type unless a loss or critical phrase is read, so a
// Story ceiling of medium shows the phrase was not read; a Bug with no
// evidence keeps Jev's severity either way.
test("calibrateSeverity: not reaching a form or page is not an outage; not reaching the account or app is", () => {
  for (const text of ["I can't access the settings page from the transfer form.", "Unable to access the export option on mobile."]) {
    assert.equal(severityCeiling({ text, type: "Story" }), "medium", text);
    assert.equal(calibrateSeverity({ text, type: "Bug", severity: "urgent" }), "urgent", `${text}: no evidence, so a Bug keeps Jev's severity`);
  }
  for (const text of ["I can't access my account since the update.", "Customers are unable to access the app."]) for (const type of ["Bug", "Story"]) assert.equal(severityCeiling({ text, type }), "urgent", `${type}: ${text}`);
});

test("calibrateSeverity: a negated loss phrase is not loss language", () => {
  for (const text of [
    "No data was lost, but the export button is misaligned.",
    "We didn't lose any data; the save spinner is just slow.",
    "The sync hiccup happened without losing records.",
    "Nothing was deleted, the toast just says the wrong thing.",
  ]) assert.equal(severityCeiling({ text, type: "Story" }), "medium", text);
  assert.equal(severityCeiling({ text: "No data was lost, but the export button is misaligned.", type: "Bug" }), "medium", "a misaligned button is evidence of a cosmetic report");
  assert.equal(severityCeiling({ text: "We didn't lose any data; the save spinner is just slow.", type: "Bug" }), "urgent", "a negation alone is not evidence: the Bug keeps Jev's severity");
  assert.equal(severityCeiling({ text: "No warning appeared, and every transaction record was deleted.", type: "Story" }), "urgent", "a negation in another clause does not hide the loss");
});

test("calibrateSeverity: a Bug with no loss or critical phrase is capped only on evidence of typed input, a UI element's appearance, or a request", () => {
  for (const text of ["Payees deleted after the update", "A customer lost their saved payees after the migration", "Transfers fail for all our business customers with no workaround", "Memory leak in the dashboard tab"]) {
    for (const severity of SEVERITY_ORDER) assert.equal(calibrateSeverity({ text, type: "Bug", severity }), severity, `${severity}: ${text}`);
  }
  for (const text of ["the details I was typing were lost when the page refreshed", "the export button is gone from the toolbar", "Can we add a confirm dialog before deleting a project?"]) {
    assert.equal(calibrateSeverity({ text, type: "Bug", severity: "urgent" }), "medium", text);
  }
});

test("calibrateSeverity: outage, access, and exposure phrasing variants stay eligible for urgent, whatever the case or apostrophe", () => {
  for (const text of [
    "Users can’t log in since this morning.",
    "I cannot log into my account.",
    "USERS CANNOT SIGN IN",
    "Everyone is blocked on checkout.",
    "500 errors for all users on the dashboard.",
    "Every user gets a 500 on login.",
    "Payments page returns 503 for everybody.",
    "No one can pay invoices.",
    "I can see someone else’s account details.",
    "Money went missing from the balance.",
  ]) assert.equal(severityCeiling({ text, type: "Bug" }), "urgent", text);
});

test("calibrateSeverity: data loss, money sent wrong, security exposure, and outages keep urgent", () => {
  for (const text of [
    "Saving a payee deleted every transaction record on the account.",
    "Our database backups are corrupted since the migration.",
    "The transfer went through twice: money sent twice to the same payee.",
    "A payment was sent to the wrong account after editing the payee.",
    "Statement PDFs are exposed without login; anyone with the link can read them.",
    "There is a data leak: other users' details show on my profile page.",
    "An unauthorised user could approve transfers.",
    "The app is down for everyone since 9am.",
    "Outage: customers can't log in on web or mobile.",
    "After the release everyone is blocked at the MFA screen.",
  ]) {
    assert.equal(severityCeiling({ text, type: "Bug" }), "urgent", text);
    assert.equal(calibrateSeverity({ text, type: "Bug", severity: "urgent" }), "urgent", text);
  }
});

test("calibrateSeverity never raises a severity", () => {
  for (const text of [LOG_OUT, "The app is down for everyone.", "Could we have dark mode?", ""]) {
    for (const type of ["Bug", "Story", "Task", "bug", "feedback", "question"]) {
      for (const severity of SEVERITY_ORDER) {
        const out = calibrateSeverity({ text, type, severity });
        assert.ok(SEVERITY_ORDER.indexOf(out) <= SEVERITY_ORDER.indexOf(severity), `${text} ${type} ${severity} -> ${out}`);
      }
    }
  }
});

test("templateVerdict caps Jev's severity over the reporter's title and description", () => {
  const answers = { issueType: { choice: "Bug", probabilities: { Bug: 0.93 } }, severity: { choice: "urgent", probabilities: { urgent: 0.84 } }, gate: { choice: "proceed", probabilities: { proceed: 0.9 } } } as unknown as JevAnswers;
  assert.equal(templateVerdict({ identifier: "TLSSN-9", title: "Log out asks no confirmation", description: LOG_OUT }, answers)?.severity, "medium");
  assert.equal(templateVerdict({ identifier: "TLSSN-9", title: "Payee save", description: "Saving a payee deleted every transaction record." }, answers)?.severity, "urgent");
});

test("calibrateJudgment: a Jev severity that would override the verdict is capped, so settling never puts urgent back", () => {
  const answers = { issueType: { choice: "Bug", probabilities: { Bug: 0.93 } }, severity: { choice: "urgent", probabilities: { urgent: 0.84 } }, gate: { choice: "proceed", probabilities: { proceed: 0.9 } } } as unknown as JevAnswers;
  const verdict: TriageVerdict = { identifier: "TLSSN-9", kind: "bug", severity: "medium", title: "Log out", summary: LOG_OUT, nextStep: "x" };
  const judged = readAnswers(verdict, "webhook", "project", TLSSN_TYPES.types, answers);
  assert.equal(judged.status === "judged" && judged.severity.applied, true, "uncapped, Jev's urgent would win");
  const capped = calibrateJudgment(judged, LOG_OUT);
  assert.equal(settleJudgment(verdict, capped, { status: "set" }).verdict.severity, "medium");
  assert.equal(calibrateJudgment(judged, "The app is down for everyone."), judged, "outage words leave it alone");
});

// Live Test B (2026-09-27; Jev replay: Bug 0.99, urgent 0.58-0.65, proceed 1.0).
const TEST_B = 'The "Log out" button in the banking header signs you out immediately, even when you\'re halfway through a transfer on Move tokens.\n\nOne of our testers lost a half-filled transfer after brushing it on a trackpad. It would be nicer if it asked "Leave this transfer?" when the form has unsaved input, and logged out straight away otherwise.';

test("live Test B: a lost half-filled transfer is unsubmitted input, not data loss, so Jev's urgent ends at medium", () => {
  assert.equal(severityCeiling({ text: TEST_B, type: "Bug" }), "medium");
  for (const severity of ["urgent", "high"] as const) assert.equal(calibrateSeverity({ text: TEST_B, type: "Bug", severity }), "medium");
  assert.equal(calibrateSeverity({ text: "I lost what I typed in the transfer form.", type: "Bug", severity: "urgent" }), "medium");
});

test("real money and data loss in other words stays eligible for urgent", () => {
  for (const text of [
    "Scheduled payments silently vanish from the list after the update.",
    "Funds disappeared from my savings pot overnight.",
    "The balance is wrong after a refund.",
    "The home screen shows the wrong balance.",
    "I was double charged for one transfer.",
    "The card charged me twice.",
    "Money was transferred to the wrong account.",
    "It sent $40 to the wrong payee.",
  ]) assert.equal(severityCeiling({ text, type: "Bug" }), "urgent", text);
});

test("jevConfidence is the lowest of the three answers, as a whole percent rounded to nearest", () => {
  assert.equal(jevConfidence([0.99, 0.775, 1]), 78);
  assert.equal(jevConfidence([0.93, 0.844, 0.9]), 84);
  assert.equal(jevConfidence([0.524, 0.9, 0.9]), 52);
});

test("the Triage: comment's Triaged by: line carries Jev's confidence, the cap, and whose number it is", () => {
  const answers = (severity: [string, number], gate = 1) => ({ issueType: { choice: "Bug", probabilities: { Bug: 0.99 } }, severity: { choice: severity[0], probabilities: { [severity[0]]: severity[1] } }, gate: { choice: "proceed", probabilities: { proceed: gate } } }) as unknown as JevAnswers;
  const verdict = templateVerdict({ identifier: "TLSSN-9", title: "Log out asks no confirmation", description: TEST_B }, answers(["urgent", 0.62]))!;
  assert.equal(verdict.severity, "medium");
  const capped = calibrateJudgment(readAnswers(verdict, "webhook", "project", TLSSN_TYPES.types, answers(["urgent", 0.62])), TEST_B);
  assert.equal(triagedByLine({ ...(capped as Extract<TriageJudgment, { status: "judged" }>), jevOnly: true }), "Triaged by: Jev (62% confidence; Jev said urgent; type, severity, and gate all above 0.52)");
  const plain = readAnswers({ ...verdict, severity: "medium" }, "webhook", "project", TLSSN_TYPES.types, answers(["medium", 0.84]));
  assert.equal(triagedByLine({ ...(plain as Extract<TriageJudgment, { status: "judged" }>), jevOnly: true }), "Triaged by: Jev (84% confidence; type, severity, and gate all above 0.52)");
  const unsure = readAnswers(verdict, "webhook", "project", TLSSN_TYPES.types, answers(["medium", 0.41]));
  assert.equal(triagedByLine(unsure), "Triaged by: Grok 4.6 Fast (Jev was only 41% confident; not above 0.52 on every answer)");
  assert.equal(triagedByLine(unsure, { model: "Cursor Auto" }), "Triaged by: Cursor Auto (Jev was only 41% confident; not above 0.52 on every answer)");
  assert.equal(triagedByLine({ status: "skipped", reason: "no_key" }), "Triaged by: Grok 4.6 Fast (Jev is not configured)", "no confidence without Jev");
});

test("type criteria: Bug is existing behaviour broken, missing, or wrong, however softly put; Story is new or a change to what works as built", () => {
  const { issueType } = triageQuestions([{ name: "Task" }, { name: "Story" }, { name: "Bug" }]);
  assert.deepEqual(Object.keys(issueType.criteria), ["Task", "Story", "Bug"]);
  assert.match(issueType.instructions, /Decide by what exists today, not by how the ask is phrased/);
  assert.match(ISSUE_TYPE_CRITERIA.Bug!, /^existing behaviour that is broken, missing, or wrong versus what the user expects/);
  for (const soft of ["doesn't show", "is wrong", "I typed X but", "used to work", "stopped working", "could it show X?"]) assert.ok(ISSUE_TYPE_CRITERIA.Bug!.includes(soft), soft);
  assert.match(ISSUE_TYPE_CRITERIA.Story!, /^a new capability the product never had, or a change to behaviour that works as built/);
  assert.match(ISSUE_TYPE_CRITERIA.Story!, /Not a Story when something that exists today is broken or wrong/);
});

test("type criteria: with no Story type, Task takes new capabilities; Epic and Subtask are never offered", () => {
  const { issueType } = triageQuestions(choosableTypes([{ name: "Epic" }, { name: "Subtask" }, { name: "Bug" }, { name: "Task" }]));
  assert.deepEqual(Object.keys(issueType.criteria), ["Bug", "Task"]);
  assert.match(issueType.criteria.Task!, /new capability/);
  assert.doesNotMatch(triageQuestions([{ name: "Bug" }, { name: "Story" }, { name: "Task" }]).issueType.criteria.Task!, /new capability/);
});

test("typeContradicted: a Story or Task over words that say something exists and is broken now", () => {
  const tlssn43 = "The \"Tokens dispatched\" screen after a transfer doesn't show the reference note I typed. Could the confirmation show the note?";
  for (const text of [
    tlssn43,
    "The Payees page used to sort by most recent payment.",
    "Freeze card stopped working for me.",
    "Since this morning the Download statement button gives a blank PDF.",
    "Export returns HTTP 500 when the filter matches no rows.",
    "I typed Rent – March but Activity shows Rent â€“ March.",
    "Opening that payee gives a white screen.",
    "The date picker doesn't work anymore.",
    "Saving a payee shows an error: Something went wrong.",
    "Since the release, the Export button gives a blank page.",
  ]) {
    assert.equal(typeContradicted({ text, type: "Story" }), true, text);
    assert.equal(typeContradicted({ text, type: " task " }), true, text);
    assert.equal(typeContradicted({ text, type: "Bug" }), false, "a Bug is never held back");
  }
  for (const text of [
    "Could each card show its expiry month next to the last four digits?",
    "There's no way to export just one card's transactions. Could the card page have an Export button?",
    "Activity doesn't let you attach a receipt photo to a movement.",
    "The Payees list doesn't show the BSB, only the account number. Could it show both?",
    "It would be nicer if Log out asked \"Leave this transfer?\" when the form has unsaved input.",
    "Can someone bump Next.js to 15.5?",
    "The error message on a declined transfer could be friendlier.",
    "Could we add a 404 page for unknown routes?",
    "Please show an error when the amount is over the daily limit.",
    "Since the release, could we also add a CSV export?",
    "After the update, add a dark mode toggle to Settings.",
  ]) assert.equal(typeContradicted({ text, type: "Story" }), false, text);
});

test("calibrateJudgment reads the model's kind, not a held type, so a held Story never caps the severity (Bugbot)", () => {
  const verdict: TriageVerdict = { identifier: "TLSSN-9", kind: "bug", severity: "low", title: "t", summary: "s", nextStep: "n" };
  const answers: JevAnswers = {
    issueType: { type: "choice", choice: "Story", probabilities: { Story: 0.95 } },
    severity: { type: "choice", choice: "high", probabilities: { high: 0.9 } },
    gate: { type: "choice", choice: "proceed", probabilities: { proceed: 0.9 } },
  };
  const text = "Freeze card stopped working for me.";
  const judged = readAnswers(verdict, "webhook", "project", [{ name: "Bug" }, { name: "Story" }, { name: "Task" }], answers);
  const held = calibrateJudgment(guardJudgmentType(judged, text), text);
  assert.equal(held.status === "judged" && held.severity.choice, "high");
  assert.equal(calibrateJudgment(judged, text).status === "judged" && (calibrateJudgment(judged, text) as { severity: { choice: string } }).severity.choice, "medium", "an unheld Story is still capped by its type");
});

test("guardJudgmentType holds back a confident Story over defect words: not confident, not applied, and the Judge: line says why", () => {
  const verdict: TriageVerdict = { identifier: "TLSSN-43", kind: "bug", severity: "medium", title: "t", summary: "s", nextStep: "n" };
  const answers: JevAnswers = {
    issueType: { type: "choice", choice: "Story", probabilities: { Story: 0.95 } },
    severity: { type: "choice", choice: "medium", probabilities: { medium: 0.9 } },
    gate: { type: "choice", choice: "proceed", probabilities: { proceed: 0.9 } },
  };
  const judged = readAnswers(verdict, "webhook", "project", [{ name: "Bug" }, { name: "Story" }, { name: "Task" }], answers);
  const held = guardJudgmentType(judged, "The confirmation stopped working.");
  assert.equal(held.status === "judged" && held.type.confident, false);
  assert.equal(held.status === "judged" && held.type.held, true);
  const settled = settleJudgment(verdict, held, { status: "set" });
  assert.equal(settled.verdict.kind, "bug", "the kind does not follow a held type");
  assert.equal(settled.judgment.status === "judged" && settled.judgment.type.applied, false);
  assert.match(judgeLine(settled.judgment)!, /^Judge: Jev type Story 0\.95 \(held back: the report says something is broken now; kept the model's bug\); severity medium 0\.90/);
  assert.equal(guardJudgmentType(judged, "Could we add dark mode?"), judged, "no defect words: unchanged");
  assert.equal(holdJudgmentType({ status: "skipped", reason: "no_key" }).status, "skipped");
});

test("type guard: bare 'broken down' and a non-negated 'any more' are not defect words (Bugbot)", () => {
  for (const text of [
    "Could the spending report be broken down by category?",
    "Is there any more documentation on the transfer limits?",
    "Can we add any more filters to the Activity view?",
  ]) assert.equal(typeContradicted({ text, type: "Story" }), false, text);
  for (const text of [
    "The Activity export doesn't load anymore since the release.",
    "The date picker won't let me pick a future sol for a scheduled transfer anymore",
    "The statement PDF link is broken.",
    "Nothing shows any more on the dashboard.",
  ]) assert.equal(typeContradicted({ text, type: "Story" }), true, text);
});
