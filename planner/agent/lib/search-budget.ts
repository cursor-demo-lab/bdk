import { type KeyedKv, searchBudgetKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { searchBudgetKey };

// One planning turn searched the sandbox 215 times in 23 minutes (TLSSN-45)
// where a normal run takes 55-108 tool calls in all. The budget is per
// turn (the plan-outcome hook resets it on turn.started, since a tool call
// does not see its turn id): a repeated query is answered without searching again, and past
// SEARCH_BUDGET searches the tool stops searching and tells the model to
// record what it has. Hosted kv has no compare-and-set, so two parallel
// calls can both count as the same slot, and a parallel call with the same
// query that throws can refund the slot and query the other one recorded;
// the cap and the repeat memory are approximate by one or two.

export const SEARCH_BUDGET = 80;
const QUERY_MEMORY = 200;

export type SearchBudget = { count: number; queries: string[] };

export type BudgetDecision =
  | { search: true; count: number; recorded: boolean }
  | { search: false; why: "repeated" | "exhausted"; count: number };

/** A new turn (a resumed session included) starts with a full budget. */
export async function resetSearchBudget(kv: KeyedKv, sessionId: string): Promise<void> {
  try {
    await kv.delete(searchBudgetKey(sessionId));
  } catch (error) {
    warnKv("search-budget.resetSearchBudget", error);
    // The old count stands; the budget only saves time.
  }
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Counts this call and says whether to search. A kv that fails counts
 * nothing and lets the search run: the budget saves time, it must never be
 * why a plan is refused. `recorded` is false only when the read failed and
 * nothing was written, so there is nothing of this call's for refundSearch
 * to take back.
 */
export async function spendSearch(kv: KeyedKv, input: { sessionId: string; query: string }): Promise<BudgetDecision> {
  const key = searchBudgetKey(input.sessionId);
  const query = normalizeQuery(input.query);
  let current: SearchBudget;
  try {
    current = parseBudget(await kv.get(key));
  } catch (error) {
    warnKv("search-budget.spendSearch.get", error);
    return { search: true, count: 0, recorded: false };
  }
  const count = current.count + 1;
  const repeated = current.queries.includes(query);
  const exhausted = current.count >= SEARCH_BUDGET;
  const queries = repeated || exhausted ? current.queries : [...current.queries, query].slice(-QUERY_MEMORY);
  try {
    await kv.put(key, { count, queries });
  } catch (error) {
    warnKv("search-budget.spendSearch.put", error);
    // The put may have landed (a 502, 504, or reset after the store wrote it),
    // so this still counts as recorded. If it did not land, refundSearch finds
    // no query to take back: on search: true the query was not stored before.
  }
  if (exhausted) return { search: false, why: "exhausted", count };
  if (repeated) return { search: false, why: "repeated", count };
  return { search: true, count, recorded: true };
}

/**
 * Takes back the slot and the query of a search that threw; call it only when
 * spendSearch answered `recorded: true`, or it removes an earlier search's
 * record. July reruns a read tool with the same input when the error looks
 * transient, which includes any message with a bare 429/502/503/504 in it;
 * without this the rerun counts twice and meets its own query as repeated,
 * answering "its earlier result stands" for a search that never returned.
 */
export async function refundSearch(kv: KeyedKv, input: { sessionId: string; query: string }): Promise<void> {
  const key = searchBudgetKey(input.sessionId);
  const query = normalizeQuery(input.query);
  try {
    const current = parseBudget(await kv.get(key));
    const at = current.queries.lastIndexOf(query);
    if (at === -1) return;
    const queries = [...current.queries.slice(0, at), ...current.queries.slice(at + 1)];
    await kv.put(key, { count: Math.max(0, current.count - 1), queries });
  } catch (error) {
    warnKv("search-budget.refundSearch", error);
    // The slot stays spent; the budget only saves time.
  }
}

export function budgetAnswer(input: { decision: Extract<BudgetDecision, { search: false }>; query: string }): {
  searched: false;
  reason: "repeated_query" | "search_budget_spent";
  query: string;
  searches: number;
  budget: number;
  next: string;
} {
  const { decision } = input;
  if (decision.why === "repeated") {
    return {
      searched: false,
      reason: "repeated_query",
      query: input.query,
      searches: decision.count,
      budget: SEARCH_BUDGET,
      next: "This exact query was already searched in this run; its earlier result stands. Search for something different, or record the plan.",
    };
  }
  return {
    searched: false,
    reason: "search_budget_spent",
    query: input.query,
    searches: decision.count,
    budget: SEARCH_BUDGET,
    next: `The search budget for this run (${SEARCH_BUDGET} searches) is spent. Stop searching. Call record_plan now with the paths you already opened, or record_needs_info if nothing you found places the request on the sandbox.`,
  };
}

function parseBudget(value: unknown): SearchBudget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { count: 0, queries: [] };
  const record = value as Record<string, unknown>;
  const count = typeof record["count"] === "number" && Number.isFinite(record["count"]) ? record["count"] : 0;
  const queries = Array.isArray(record["queries"]) ? record["queries"].filter((query): query is string => typeof query === "string") : [];
  return { count, queries };
}
