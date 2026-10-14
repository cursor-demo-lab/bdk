import { HttpSessionAdmitError, httpChannel } from "@cursor/july/channels";
import type { AuthContext } from "@cursor/july/channels";
import { MANAGED_HOSTING_ENV } from "../lib/implement-turn.js";

// Guard for the built-in HTTP session channel (`/v1/session*`), the one
// surface where July honors a caller-supplied per-session `cloud` override
// (`readCloudOptions` in July's internal/http-channel.js). The merge lets the
// caller's `autoCreatePR`, `repos`, `env`, and `envVars` win over the agent's
// `cloud: { autoCreatePR: false }` (`mergeCloudOptions`), so an admitted HTTP
// caller could start a cloud agent of its own choosing under the worker's
// service account. agent.ts cannot close this with `tools: []`, because the
// implement turn is itself a cloud turn.
// - Cursor-managed hosting: `/v1/session*` is not served on a hosted v2
//   guest. Every HTTP session start arrives as an `agentsdk.session`
//   admission whose payload parser (`parseControlPlaneSessionPayload`) fails
//   closed on any field beyond message/dryRun/asOf/modelConfig/instructions,
//   so a `cloud` key is a 400 before any authored code runs. Those admissions
//   call `onMessage` with `auth: null` and this gate lets them through, so a
//   person's direct chat on the hosted playground stays a local turn.
// - A serve with AGENT_SERVE_GENERATION set outside managed hosting still
//   mounts `/v1/session*` and would honor `body.cloud` from any caller its
//   auth chain admits. Those requests always carry a principal, so refusing
//   principal-bearing sends under the hosted posture closes it.
//   HttpSessionAdmitError maps to a 400, never a turn.
// - Off managed hosting (local dev, evals): the gate passes everything; the
//   only admitted principals are the operator's own.
//
// An `auth` override would not work: `project.httpChannel.auth` also guards
// `/v1/info`, `/v1/logs`, `/v1/artifacts`, `/v1/tools`, and the MCP endpoint,
// which are mounted on hosted pods behind the platform's bearer.
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
