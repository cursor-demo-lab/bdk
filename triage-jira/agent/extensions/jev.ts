import jev from "@cursor/july/extensions/jev";

// Mounted for hosting: the deploy allowlists api.typesafe.ai and expects the
// TYPESAFE_API_KEY secret. Host code calls `decide` itself (triage-jira on the
// issue-created wake, factory-desk on a Slack filing request), so the model
// gets neither the evaluate tool nor the Jev skills. Shared verbatim by
// triage-jira and factory-desk (scripts/copies-parity.test.mjs).
export default jev({ harnessTools: false, skills: false });
