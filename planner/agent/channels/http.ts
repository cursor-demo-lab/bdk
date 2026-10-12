import { HttpSessionAdmitError, httpChannel } from "@cursor/july/channels";
import type { AuthContext } from "@cursor/july/channels";
import { cloudPlanning } from "../lib/checkout.js";

// Guard for the built-in HTTP session channel (`/v1/session*`), the one
// surface where July honors a caller-supplied per-session `cloud` override
// (http-channel.js:57, readCloudOptions at :468-521). The merge lets the
// caller's `autoCreatePR`, `repos`, `env`, and `envVars` win over the agent's
// `cloud: { autoCreatePR: false }` and the planning send's sandbox repos
// (cloud-merge.js:10-24), so an admitted HTTP caller could turn auto PR back
// on or point the turn at another repo.
//
// Where that override can bite, and how each shape is closed on 0.2.18:
// - Cursor-managed hosting (the deployed posture): the engine's `/v1/session*`
//   mounts are not served on a hosted v2 guest (server.js:1673-1676); every
//   HTTP session start arrives as an `agentsdk.session` admission whose
//   payload parser fails closed on any field beyond
//   message/dryRun/asOf/modelConfig/instructions — a `cloud` key is a 400
//   before any authored code runs (http-control-plane-session.js:37-39).
//   Those admissions call `onMessage` with `auth: null`
//   (http-control-plane-session.js:143), so this gate lets them through.
// - Off managed hosting: the agent declares `tools`, and July refuses any
//   per-send cloud attach of an agent that declares them
//   (session-engine.js:2091-2093). Local dev, evals, and the playground see
//   no change from this gate.
// - The remaining shape: a serve with AGENT_SERVE_GENERATION set outside
//   managed hosting still mounts `/v1/session*` (no hosted control plane),
//   runs `runtime: "cloud"` with no `tools`, and would honor `body.cloud`
//   from any caller its auth chain admits (`--allow-anonymous` admits
//   everyone). A request on those mounted routes always carries the auth
//   chain's principal, so refusing principal-bearing sends under
//   cloudPlanning closes it. HttpSessionAdmitError maps to a 400
//   (request-error-status.js:37-44), never a turn.
//
// An `auth` override here would NOT work: `project.httpChannel.auth` also
// guards `/v1/info`, `/v1/logs`, `/v1/artifacts`, `/v1/tools`, and the MCP
// endpoint, which ARE mounted on hosted pods behind the platform's bearer
// (server.js:1148-1153); pinning loopback would lock the platform out.
export function gateHttpSession(message: string, auth: AuthContext | null, env: NodeJS.ProcessEnv): string {
  if (cloudPlanning(env) && auth !== null) {
    throw new HttpSessionAdmitError(
      "The HTTP session API is closed on the hosted planner posture: a per-session `cloud` override could re-enable autoCreatePR or swap the repos. Use the control-plane surfaces (playground, ask, agent-sdk run --prod), or serve without AGENT_SERVE_GENERATION for local sessions."
    );
  }
  return message;
}

export default httpChannel({
  onMessage: (message, { auth }) => gateHttpSession(message, auth, process.env),
});
