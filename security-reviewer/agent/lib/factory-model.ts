// The July host model every factory agent runs, from FACTORY_AGENT_MODEL,
// FACTORY_AGENT_EFFORT, and FACTORY_AGENT_SPEED: Cursor Auto (`auto-smart`,
// optimize_for=balanced) unless those say otherwise. Two agents pass
// LIGHT_MODEL as their default instead: factory-desk (every turn: filing,
// its fallback triage, commands) and triage-jira (its one turn, the fallback
// when Jev does not settle a ticket). The same FACTORY_AGENT_* settings
// override that default the same way. factory-worker's cloud agent model
// (`workerModel`) is a different model and stays in its config.ts.
//
// Shared verbatim by the six factory agents and re-exported from each
// config.ts (scripts/copies-parity.test.mjs);
// scripts/factory-model-catalog.test.mjs holds every copy to the recorded
// model catalog.

export type FactoryModel = { id: string; params: { id: string; value: string }[] };

// grok-4.7 is a Model Deployment Registry id. Hosted turns copy param ids
// verbatim and remap only `fast` → `speed`; an id the registry row does not
// define fails with "Invalid parameters for registry model: grok-4.7".
// GET /v1/models lists grok-4.7 with `context` (256k/500k), which the
// registry does not accept — sending that catalog-only param is what broke
// hosted desk (PR #74). Registry params are reasoning_effort + speed
// (proven #42). Catalog ids take a full GET /v1/models variant.
export const REGISTRY_MODELS: ReadonlySet<string> = new Set(["grok-4.7"]);

// Auto routes per turn and takes only `optimize_for`, not effort or fast.
export const AUTO_MODELS: ReadonlySet<string> = new Set(["auto-smart"]);

export const HOST_MODEL_PARAMS: Readonly<Record<string, { effort: string; context?: string; defaultEffort?: string; defaultFast?: boolean }>> = {
  "claude-opus-5-5": { effort: "effort", context: "300k", defaultEffort: "low", defaultFast: false },
  "grok-4.6": { effort: "effort" },
  "grok-4.5": { effort: "effort" },
};

// The light default: with no effort or speed set this is catalog grok-4.6 at
// effort high, fast=true (grok-4.6-fast).
export const LIGHT_MODEL = "grok-4.6";

// July's `fallbacks`: models tried in order when the root model is refused
// ("Cannot use this model"), blocked by a team admin ("Model Blocked", July
// 0.2.13+), or out of capacity before the turn produces any output. Fixed
// catalog variants that ignore FACTORY_AGENT_*, so an override that the
// catalog refuses still has a model to land on. Each list skips the
// primary's own id and spans providers (xAI grok, Cursor Auto, Anthropic) so
// one provider's capacity error does not take out every backup.
const FALLBACK_CANDIDATES: readonly FactoryModel[] = [
  { id: LIGHT_MODEL, params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] },
  { id: "auto-smart", params: [{ id: "optimize_for", value: "balanced" }] },
  { id: "claude-opus-5-5", params: [{ id: "context", value: "300k" }, { id: "effort", value: "low" }, { id: "fast", value: "false" }] },
];

export function factoryFallbacks(primary: FactoryModel): FactoryModel[] {
  return FALLBACK_CANDIDATES.filter((model) => model.id !== primary.id).slice(0, 2);
}

// Effort and speed are settings, not id suffixes (July rejects grok-4.7-high-fast).
// Registry ids send `speed`; catalog ids send `fast`. An id not listed above
// is sent without params rather than with param names its row may not have.
// `defaultId` is the model when FACTORY_AGENT_MODEL is unset or blank.
export function factoryModel(env: NodeJS.ProcessEnv, defaultId = "auto-smart"): FactoryModel {
  const id = env.FACTORY_AGENT_MODEL?.trim() || defaultId;
  if (AUTO_MODELS.has(id)) return { id, params: [{ id: "optimize_for", value: "balanced" }] };
  if (REGISTRY_MODELS.has(id)) {
    const effort = env.FACTORY_AGENT_EFFORT?.trim() || "high";
    const speed = env.FACTORY_AGENT_SPEED?.trim() || "fast";
    return { id, params: [{ id: "reasoning_effort", value: effort }, { id: "speed", value: speed }] };
  }
  const known = HOST_MODEL_PARAMS[id];
  if (known === undefined) return { id, params: [] };
  const effort = env.FACTORY_AGENT_EFFORT?.trim() || known.defaultEffort || "high";
  const speed = env.FACTORY_AGENT_SPEED?.trim() || (known.defaultFast === false ? "standard" : "fast");
  const fast = speed === "fast" ? "true" : "false";
  return {
    id,
    params: [
      ...(known.context === undefined ? [] : [{ id: "context", value: known.context }]),
      { id: known.effort, value: effort },
      { id: "fast", value: fast },
    ],
  };
}
