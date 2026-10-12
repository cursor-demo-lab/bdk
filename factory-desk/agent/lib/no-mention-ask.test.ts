import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { replyPrefix, WATCHED_CHANNELS } from "./desk-channels.js";

const AGENT = new URL("..", import.meta.url).pathname;
// In-thread copy (host strings and the model's instructions) never asks a person to @mention the desk (TLSSN-46).
const MENTION_ASK = /\b(?:mention (?:me|you|us|the (?:bot|desk|factory))|mention @|mention <@)/i;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|md)$/.test(entry.name) && !/\.(?:test|fixtures)\.ts$/.test(entry.name) ? [path] : [];
  });
}

test("no host string or instruction tells someone in a thread to mention the desk", () => {
  const hits = sources(AGENT).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => MENTION_ASK.test(line) && !/^\s*(?:\/\/|\*)/.test(line) && !/Never ask them to mention/i.test(line))
      .map((line) => `${path}: ${line.trim()}`)
  );
  assert.deepEqual(hits, []);
});

test("in a watched channel, host command copy carries no mention", () => {
  for (const channel of WATCHED_CHANNELS) assert.equal(replyPrefix(channel), "");
});

test("the not_originator refusal guidance is verb-generic, not deny-only", () => {
  const text = readFileSync(join(AGENT, "instructions.md"), "utf8");
  const refusal = text.slice(text.indexOf("- `not_originator`"), text.indexOf("- `wrong_thread`"));
  for (const verb of ["approve", "deny", "plan"]) assert.match(refusal, new RegExp(`Reply\\s+${verb}\\s+KEY\\s+in\\s+this\\s+thread\\.`), verb);
  assert.match(refusal, /same\s+command\s+they\s+used/);
});
