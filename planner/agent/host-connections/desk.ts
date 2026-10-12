import { peerConnection } from "../lib/peers.js";

// Host-only edge back to the desk, used by record_plan to post a chained
// plan into the Slack thread that filed the ticket. `call_tool` alone: the
// planner runs the desk's deterministic announce_plan, never an `ask`, so a
// plan can never start a desk model turn. Closes a host-only cycle with the
// desk's ask_2 edge; neither tool calls back across it.
//
// Hosted v2 is one slug per app, so this is a stub unless
// FACTORY_INPROCESS_PEERS=1 (local `serve --dir .`). Since July 0.2.15 a
// real peer would boot here too; the stub stays so `deploy` declares no
// hosted peer (lib/peers.ts).
export default peerConnection({
  agent: "factory-desk",
  description: "Tell the Slack thread that filed a ticket that its plan is ready.",
  tools: ["call_tool"],
});
