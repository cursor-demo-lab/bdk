import { HttpSessionAdmitError, httpChannel } from "@cursor/july/channels";
import type { AuthContext } from "@cursor/july/channels";
import { MANAGED_HOSTING_ENV } from "../lib/implement-turn.js";

// Guard for the built-in HTTP session channel (`/v1/session*`), the one
// surface where July honors a caller-supplied per-session `cloud` override
// (dist/internal/http-channel.js readCloudOptions). The merge lets the
// caller's `autoCreatePR`, `repos`, `env`, and `envVars` win over the
// agent's `cloud: { autoCreatePR: false }` (dist/internal/cloud-merge.js
// mergeCloudOptions), so an admitted HTTP caller could start a cloud agent
// of its own choosing under the worker's service account, with auto PR on
// or against another repository.
//
// Until the implement agent became a July cloud turn, `tools: []` on
// agent.ts closed this: July refuses any non-local turn of an agent that
// declares `tools` (session-engine.js `buildTurnRequest`). That declaration is gone, since
// the implement turn is exactly such a turn, so this gate takes its place.
// Same analysis as the planner's channels/http.ts on 0.2.18:
// - Cursor-managed hosting (the deployed posture): the engine's
//   `/v1/session*` mounts are not served on a hosted v2 guest; every HTTP
//   session start arrives as an `agentsdk.session` admission whose payload
//   parser fails closed on any field beyond message/dryRun/asOf/modelConfig/
//   instructions, so a `cloud` key is a 400 before any authored code runs
//   (http-control-plane-session.js parseControlPlaneSessionPayload). Those
//   admissions call `onMessage` with `auth: null`, and this gate lets them
//   through: a person's direct chat on the hosted playground stays a local
//   turn that answers per instructions.md.
// - A serve with AGENT_SERVE_GENERATION set outside managed hosting still
//   mounts `/v1/session*` and would honor `body.cloud` from any caller its
//   auth chain admits (`--allow-anonymous` admits everyone). A request on
//   those mounted routes always carries the auth chain's principal, so
//   refusing principal-bearing sends under the hosted posture closes it.
//   HttpSessionAdmitError maps to a 400, never a turn.
// - Off managed hosting (local dev, evals): the gate passes everything. The
//   only principals July admits there are the operator's own (loopback
//   local-dev-strict, or a bearer the operator configured), and a per-send
//   cloud attach from the operator's terminal is the operator's choice.
//
// An `auth` override here would NOT work: `project.httpChannel.auth` also
// guards `/v1/info`, `/v1/logs`, `/v1/artifacts`, `/v1/tools`, and the MCP
// endpoint, which ARE mounted on hosted pods behind the platform's bearer;
// pinning loopback would lock the platform out.
export function gateHttpSession(message: string, auth: AuthContext | null, env: NodeJS.ProcessEnv): string {
  if ((env[MANAGED_HOSTING_ENV] ?? "").trim() !== "" && auth !== null) {
    throw new HttpSessionAdmitError(
      "The HTTP session API is closed on the hosted worker posture: a per-session `cloud` override could start a cloud agent of the caller's choosing under the worker's service account. The worker acts on Jira approvals; use the control-plane surfaces (playground, ask, agent-sdk run --prod) to chat, or serve without AGENT_SERVE_GENERATION for local sessions."
    );
  }
  return message;
}

export default httpChannel({
  onMessage: (message, { auth }) => gateHttpSession(message, auth, process.env),
});
