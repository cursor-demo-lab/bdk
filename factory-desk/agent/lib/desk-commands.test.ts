import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DESK_COMMAND_PHRASES } from "./desk-commands.js";
import { unaskedFilingPrompt } from "./intake-triage.js";

const HOST_COPY = ["plan-post.ts", "threads.ts", "originator.ts"].map((name) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
);

// The routing table as the model reads it. Each numbered rule opens with a
// bold heading and, for some rules, a parenthesised list of phrases before
// its first colon. Those two places are the phrases a person types.
const INSTRUCTIONS = readFileSync(new URL("../instructions.md", import.meta.url), "utf8");

function routingRules(): string[] {
  const section = INSTRUCTIONS.split("## Route by what the message carries")[1]!.split("\n## ")[0]!;
  return section
    .split(/\n(?=\d+\. )/)
    .filter((rule) => /^\d+\. /.test(rule.trim()))
    .map((rule) => rule.replace(/\s+/g, " ").trim());
}

function ticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

function tablePhrases(): string[] {
  const phrases: string[] = [];
  for (const rule of routingRules()) {
    for (const bold of rule.matchAll(/\*\*([^*]+)\*\*/g)) phrases.push(...ticked(bold[1]!));
    const lead = rule.split(/: /)[0]!;
    for (const group of lead.matchAll(/\(([^)]*)\)/g)) phrases.push(...ticked(group[1]!));
  }
  return phrases;
}

const exported = Object.values(DESK_COMMAND_PHRASES).flat() as string[];

test("every phrase in the routing table is in DESK_COMMAND_PHRASES, and every exported phrase is in the table", () => {
  const table = tablePhrases();
  assert.ok(table.length >= 25, `parsed only ${table.length} phrases; the table format changed`);
  assert.deepEqual([...new Set(table)].sort(), [...new Set(exported)].sort());
});

test("instructions write commands without a mention everywhere and still take a mentioned one", () => {
  assert.match(INSTRUCTIONS, /In a\s+factory thread the commands take no mention: `approve file` \/\s+`deny file`, then `approve` \(or `approve KEY`\) \/ `deny KEY`/);
  assert.match(INSTRUCTIONS, /A mentioned\s+one \(`@factory approve file`\) is the same command and must call the same\s+tool/);
  assert.match(INSTRUCTIONS, /Write commands in your replies\s+without a mention, always\./);
  assert.doesNotMatch(INSTRUCTIONS, /unless `<slack_reply>` says a plain reply does not/);
  assert.match(INSTRUCTIONS, /A new request still starts with the mention/);
  const asks = INSTRUCTIONS.split("\n").filter((line) => /\b(?:ask for|say|says|reply|Reply)\b[^\n]*`@factory (?:approve|deny|replan|plan|retry)/.test(line));
  assert.deepEqual(asks, [], "no in-thread ask copy puts @factory before a command");
});

test("instructions read July's sender fields: the handle is <slack_reply>'s, bot senders give no command, times go in user_tz", () => {
  const sender = INSTRUCTIONS.split("## Who sent it")[1]?.split("\n## ")[0];
  assert.ok(sender !== undefined, "instructions.md has a Who sent it section");
  for (const field of ["user_tz", "user_is_bot: true", "user_bot_id", "self_user_id", "self_name"]) assert.ok(sender.includes(`\`${field}`), field);
  assert.match(sender, /A bot sender[^]*gives no command[^]*Use no tool, and reply with one short line/);
  assert.match(sender, /in their `user_tz`,\s+with the zone named/);
  assert.match(sender, /No\s+`user_tz`: write UTC/);
  assert.match(INSTRUCTIONS, /you are the handle `<slack_reply>` names \(`@factory` when it names none\);\s+write that handle, never `@` plus `self_name`/);
  assert.doesNotMatch(INSTRUCTIONS, /In Slack\s+you are `@factory`\./, "the handle comes from <slack_reply>, with @factory only as the fallback");
  assert.doesNotMatch(INSTRUCTIONS, /handle is `@` plus `self_name`/, "self_name is Slack's username, not the handle people type");
});

test("Slack-facing instructions never narrate tools or send people only to Jira", () => {
  assert.doesNotMatch(INSTRUCTIONS, /Name the tool you used or say you used none/);
  assert.match(INSTRUCTIONS, /Never name a tool, never write\s+"I used/);
  assert.match(INSTRUCTIONS, /your whole reply is the result's\s+`reply` field, exactly as given and nothing before or after it/, "TLSSN-36: one Filed post, host-written");
  assert.match(INSTRUCTIONS, /no separate\s+Triaged line follows, so never promise one/);
  assert.doesNotMatch(INSTRUCTIONS, /the Triaged line with the\s+verdict follows/);
  assert.doesNotMatch(INSTRUCTIONS, /`KEY is filed:`/);
  assert.doesNotMatch(INSTRUCTIONS, /nothing has been triaged yet/, "a desk-filed ticket is triaged before it is filed");
  assert.match(INSTRUCTIONS, /`transitioned` or `bounced`: the\s+ticket is in Triaged and with the planner; say that in one line and\s+nothing about what comes after\./);
  assert.match(INSTRUCTIONS, /Every reply covers only the current step/);
  assert.doesNotMatch(INSTRUCTIONS, /Once it is filed and planned|the agent link\s+follows in this thread|nothing is built until it is\s+approved/);
  assert.doesNotMatch(INSTRUCTIONS, /and the Plan lands here when the ticket reaches Planned/);
  assert.doesNotMatch(INSTRUCTIONS, /which wakes the planner; the Plan lands in this\s+thread/);
  assert.match(INSTRUCTIONS, /Never say planning is underway after `triage_gate`/);
  assert.doesNotMatch(INSTRUCTIONS, /triage and planning are underway/);
  assert.doesNotMatch(INSTRUCTIONS, /once the ticket reaches In Progress/);
  assert.doesNotMatch(INSTRUCTIONS, /the ticket is where to watch/);
  assert.doesNotMatch(INSTRUCTIONS, /@factory-desk approve/);
  assert.match(INSTRUCTIONS, /Never write `@factory-desk`/);
});

test("the filing prompt is host text: the block's prompt verbatim, and without a block the lines instructions.md quotes from intake-triage.ts", () => {
  const fence = INSTRUCTIONS.match(/\n   ```text\n([\s\S]*?)\n   ```\n/);
  assert.ok(fence !== null, "rule 0 quotes the no-block filing prompt in a text fence");
  assert.equal(fence[1]!.split("\n").map((line) => line.replace(/^ {3}/, "")).join("\n"), unaskedFilingPrompt(), "instructions.md and unaskedFilingPrompt must not drift");
  assert.match(INSTRUCTIONS, /reply with the text between its\s+`<filing_prompt>` markers: exactly as written for `by="jev"`; for\s+`by="model"`, triage the request with the block's rubric and fill each\s+`<…>` slot/);
  assert.match(INSTRUCTIONS, /Keep\s+the `Summary: ` label; the summary says what is wrong, where, and the\s+likely cause or area when evident, never copies a sentence from the\s+request, and is never the title line again\./, "desk/file-ticket-asks-first gates on Summary: and on it not repeating the title (TLSSN-37)");
  assert.match(INSTRUCTIONS, /never `approve KEY` \(there is no key yet\)/);
  assert.doesNotMatch(INSTRUCTIONS, /triage-rubric` skill/);
  assert.match(INSTRUCTIONS, /from your filing prompt: `kind` \(bug, feedback, or question\),\s+`severity`, `summary`/);
});

test("a status question says the verdict lands in this thread either way", () => {
  assert.match(INSTRUCTIONS, /Either way the verdict\s+lands in this thread: in the Filed post for a ticket filed here, in a\s+Triaged line for one filed in Jira\./);
});

test("host Slack copy does not hardcode @factory-desk, and the plan post's decision line carries no handle", () => {
  for (const src of HOST_COPY) {
    assert.doesNotMatch(src, /@factory-desk/);
  }
  assert.doesNotMatch(HOST_COPY[0]!, /deskSlackHandle/);
});
