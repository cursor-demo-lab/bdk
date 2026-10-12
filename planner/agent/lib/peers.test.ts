import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INPROCESS_PEERS_ENV, inProcessPeers } from "./peers.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

test("inProcessPeers is off unless FACTORY_INPROCESS_PEERS is a yes value", () => {
  assert.equal(inProcessPeers({}), false);
  assert.equal(inProcessPeers({ [INPROCESS_PEERS_ENV]: "" }), false);
  assert.equal(inProcessPeers({ [INPROCESS_PEERS_ENV]: "0" }), false);
  assert.equal(inProcessPeers({ [INPROCESS_PEERS_ENV]: "1" }), true);
  assert.equal(inProcessPeers({ [INPROCESS_PEERS_ENV]: "true" }), true);
  assert.equal(inProcessPeers({ [INPROCESS_PEERS_ENV]: "YES" }), true);
});

function run(code: string, peers: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[INPROCESS_PEERS_ENV];
  if (peers !== undefined) env[INPROCESS_PEERS_ENV] = peers;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
  });
}

test("peerConnection is an inline stub unless peers are on", () => {
  const off = run(
    [
      'import { isPeerConnectionTransport } from "@cursor/july";',
      'import { peerConnection } from "./agent/lib/peers.ts";',
      'const connection = peerConnection({ agent: "factory-desk", description: "Announce a plan." });',
      'if (isPeerConnectionTransport(connection)) throw new Error("peer while gated");',
      'if (!("tools" in connection) || Array.isArray(connection.tools) || !("unmounted" in connection.tools)) {',
      '  throw new Error("expected unmounted stub");',
      "}",
    ].join("\n"),
    undefined
  );
  assert.equal(off.status, 0, off.stderr);

  const on = run(
    [
      'import { isPeerConnectionTransport } from "@cursor/july";',
      'import { peerConnection } from "./agent/lib/peers.ts";',
      'const connection = peerConnection({ agent: "factory-desk", description: "Announce a plan." });',
      'if (!isPeerConnectionTransport(connection) || connection.agent !== "factory-desk") {',
      '  throw new Error("expected peer transport");',
      "}",
    ].join("\n"),
    "1"
  );
  assert.equal(on.status, 0, on.stderr);
});
