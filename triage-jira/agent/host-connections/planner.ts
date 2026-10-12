import { peerConnection } from "../lib/peers.js";

// Host-only edge to the planner. record_triage calls plan_issue over it
// after the ticket comment lands. `call_tool` alone, never an `ask`, so
// no triage event can spend a planner model turn by itself. The model of
// this agent never sees the connection.
//
// Hosted v2 is one slug per app, so this is a stub unless
// FACTORY_INPROCESS_PEERS=1 (local `serve --dir .`). Since July 0.2.15 a
// real peer would boot here too; the stub stays so `deploy` declares no
// hosted peer (lib/peers.ts).
export default peerConnection({
  agent: "planner",
  description: "Hand a triaged issue to the planning stage.",
  tools: ["call_tool"],
});
