import { HttpSessionAdmitError, httpChannel } from "@cursor/july/channels";
import type { AuthContext } from "@cursor/july/channels";
import { cloudPlanning } from "../lib/checkout.js";

// Guard for the built-in HTTP session channel (`/v1/session*`), the one
// surface where July honors a caller-supplied per-session `cloud` override
// (`readCloudOptions` in http-channel.js, merged by `mergeCloudOptions`). The
// caller's `autoCreatePR`, `repos`, `env`, and `envVars` would win over the
// agent's `cloud: { autoCreatePR: false }` and the planning send's sandbox
// repos, so an admitted caller could turn auto PR back on or point the turn
// at another repo. How each shape is closed (July 0.2.25):
// - Managed hosting: the `/v1/session*` routes are not mounted on a hosted v2
//   guest. A session start arrives as an `agentsdk.session` admission whose
//   payload parser rejects any field but message/dryRun/asOf/modelConfig/
//   instructions, so a `cloud` key is a 400 before this code runs. Those
//   admissions call `onMessage` with `auth: null`, which this gate lets through.
// - Off managed hosting: the agent declares `tools`, and the session engine
//   refuses a per-send cloud attach for an agent that declares them.
// - A serve with AGENT_SERVE_GENERATION set outside managed hosting mounts
//   `/v1/session*` and runs `runtime: "cloud"` with no `tools`, so it would
//   honor `body.cloud` from any caller its auth admits. Those requests always
//   carry a principal, so refusing principal-bearing sends under cloudPlanning
//   closes it. HttpSessionAdmitError maps to a 400, never a turn.
// An `auth` override would not work: `project.httpChannel.auth` also guards
// `/v1/info`, `/v1/logs` and the other engine routes a hosted pod serves to
// the platform, so a loopback-only pin would lock the platform out.
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
