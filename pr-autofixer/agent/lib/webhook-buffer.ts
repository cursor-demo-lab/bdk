import { type KeyedKv, WEBHOOK_BUFFER_KV_KEY } from "./kv-keys.js";

export { WEBHOOK_BUFFER_KV_KEY };

export interface BufferedWebhookEvent {
  eventName: string;
  action?: string;
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
  headSha?: string;
  conclusion?: string;
  /** The GitHub App behind a check_suite or check_run (`cursor` is Bugbot's). */
  app?: string;
  /** A check_run's name (`Cursor Bugbot`), or the Bugbot run a cursor suite was confirmed to hold. */
  checkName?: string;
  /** A check_suite's id, to read its check runs. */
  checkSuiteId?: number;
}

/** A flush that returns `retryInMs` keeps its event and flushes it again after that long, without an error. */
export type FlushResult = { retryInMs: number } | undefined;

export interface WebhookBufferOptions {
  debounceMs?: number;
  onFlush: (event: BufferedWebhookEvent) => FlushResult | void | Promise<FlushResult | void>;
  kv: KeyedKv;
}

interface BufferEntry {
  latest: BufferedWebhookEvent;
  count: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  deadlineMs: number;
}

interface SnapshotEntry {
  latest: BufferedWebhookEvent;
  count: number;
  deadlineMs: number;
}

export class WebhookBuffer {
  private readonly entries = new Map<string, BufferEntry>();
  private readonly inFlight = new Set<string>();
  private readonly debounceMs: number;
  private readonly onFlush: WebhookBufferOptions["onFlush"];
  private readonly kv: KeyedKv;
  private persistChain: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(options: WebhookBufferOptions) {
    this.debounceMs = options.debounceMs ?? 3000;
    this.onFlush = options.onFlush;
    this.kv = options.kv;
  }

  static keyFor(
    event: Pick<BufferedWebhookEvent, "owner" | "repo" | "number">
  ): string {
    return `${event.owner}/${event.repo}#${event.number}`;
  }

  async enqueue(event: BufferedWebhookEvent): Promise<void> {
    const key = WebhookBuffer.keyFor(event);
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, {
        latest: event,
        count: 1,
        timer: undefined,
        deadlineMs: Date.now() + this.debounceMs,
      });
    } else {
      existing.latest = event;
      existing.count += 1;
      existing.deadlineMs = Date.now() + this.debounceMs;
    }
    await this.persist();
    this.schedule(key);
  }

  async restore(): Promise<number> {
    const snapshot = await this.kv.get(WEBHOOK_BUFFER_KV_KEY);
    if (
      !isJsonObject(snapshot) ||
      snapshot.version !== 1 ||
      !isJsonObject(snapshot.entries)
    ) {
      return 0;
    }
    let restored = 0;
    for (const [key, entry] of Object.entries(snapshot.entries)) {
      if (!isValidSnapshotEntry(entry)) {
        continue;
      }
      this.entries.set(key, {
        latest: entry.latest,
        count: Math.max(1, entry.count),
        timer: undefined,
        deadlineMs: entry.deadlineMs,
      });
      this.schedule(key);
      restored += 1;
    }
    return restored;
  }

  /** Drop a PR's buffered wake; true when there was one. */
  async discard(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    clearTimeout(entry.timer);
    this.entries.delete(key);
    await this.persist();
    return true;
  }

  async clear(): Promise<void> {
    this.generation += 1;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
    }
    this.entries.clear();
    this.inFlight.clear();
  }

  private schedule(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }
    clearTimeout(entry.timer);
    const delay = Math.max(0, entry.deadlineMs - Date.now());
    // flush reschedules a failed entry before it rethrows, and nothing else
    // awaits a timer, so the rethrow is only ever an unhandled rejection.
    entry.timer = setTimeout(() => {
      this.flush(key).catch((error: unknown) => {
        console.error(`[pr-autofixer] webhook buffer: flush of ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delay);
  }

  private async flush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }

    if (this.inFlight.has(key)) {
      entry.deadlineMs = Date.now() + this.debounceMs;
      await this.persist();
      this.schedule(key);
      return;
    }

    entry.timer = undefined;
    this.inFlight.add(key);
    const generation = this.generation;
    try {
      const event = entry.latest;
      const count = entry.count;
      const result = await this.onFlush(event);
      if (generation !== this.generation) {
        return;
      }
      const current = this.entries.get(key);
      const unchanged = current !== undefined && current.latest === event && current.count === count;
      if (unchanged && result !== undefined && result !== null && typeof result === "object") {
        current.deadlineMs = Date.now() + result.retryInMs;
        await this.persist();
        this.inFlight.delete(key);
        this.schedule(key);
        return;
      }
      if (unchanged) {
        this.entries.delete(key);
      }
      await this.persist();
    } catch (error) {
      if (generation !== this.generation) {
        throw error;
      }
      entry.deadlineMs = Date.now() + this.debounceMs;
      await this.persist();
      this.schedule(key);
      throw error;
    } finally {
      if (generation === this.generation) {
        this.inFlight.delete(key);
      }
    }
  }

  private persist(): Promise<void> {
    const entries: Record<string, SnapshotEntry> = {};
    for (const [key, entry] of this.entries) {
      entries[key] = {
        latest: entry.latest,
        count: entry.count,
        deadlineMs: entry.deadlineMs,
      };
    }
    const write = (): Promise<void> =>
      this.kv.put(
        WEBHOOK_BUFFER_KV_KEY,
        JSON.parse(
          JSON.stringify({
            version: 1,
            updatedAt: new Date().toISOString(),
            entries,
          })
        )
      );
    const next = this.persistChain.then(write, write);
    this.persistChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSnapshotEntry(entry: unknown): entry is SnapshotEntry {
  if (!isJsonObject(entry) || !isJsonObject(entry.latest)) {
    return false;
  }
  const latest = entry.latest;
  return (
    typeof latest.eventName === "string" &&
    typeof latest.prUrl === "string" &&
    typeof latest.owner === "string" &&
    typeof latest.repo === "string" &&
    typeof latest.number === "number" &&
    typeof entry.count === "number" &&
    typeof entry.deadlineMs === "number"
  );
}
