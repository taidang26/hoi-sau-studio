/**
 * Model rotation for the Meta Model API. Models are tried in order; one that
 * is refused (403/404), rate limited (429) or keeps failing (5xx) is set
 * aside for a while and the next one takes over, so a block on one model does
 * not stop the day's work. When the pause ends the earlier model is used again.
 *
 * Env (both clients read the same keys):
 *   MUSE_SPARK_MODELS          full list, comma separated, first = preferred
 *   MUSE_SPARK_MODEL           first model (default muse-spark-1.3-contributor)
 *   MUSE_SPARK_FALLBACK_MODEL  models after it, comma separated ("none" = no rotation)
 */

export const CONTRIBUTOR_SPARK_MODEL = "muse-spark-1.3-contributor";
export const DEFAULT_SPARK_FALLBACKS = ["muse-spark-1.2-contributor", "muse-spark-1.3"];

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** The Spark model list from env, first = preferred. `first` overrides the default first model. */
export function sparkModelsFromEnv(env: NodeJS.ProcessEnv = process.env, first?: string): string[] {
  const full = list(env.MUSE_SPARK_MODELS);
  if (full.length) return [...new Set(full)];
  const head = first || env.MUSE_SPARK_MODEL || CONTRIBUTOR_SPARK_MODEL;
  const rest = env.MUSE_SPARK_FALLBACK_MODEL === "none" ? [] : env.MUSE_SPARK_FALLBACK_MODEL ? list(env.MUSE_SPARK_FALLBACK_MODEL) : DEFAULT_SPARK_FALLBACKS;
  return [...new Set([head, ...rest])];
}

export class ModelRotation {
  readonly models: string[];
  private readonly until = new Map<string, number>();
  private readonly now: () => number;

  constructor(models: string[], opts: { now?: () => number } = {}) {
    if (!models.length) throw new Error("ModelRotation needs at least one model");
    this.models = [...new Set(models)];
    this.now = opts.now ?? Date.now;
  }

  /** First model not set aside; if all are, the one free soonest. */
  current(): string {
    const t = this.now();
    const free = this.models.find((m) => (this.until.get(m) ?? 0) <= t);
    if (free) return free;
    return [...this.models].sort((a, b) => this.until.get(a)! - this.until.get(b)!)[0];
  }

  /** Ms until some model is free again (0 when one is free now). */
  waitMs(): number {
    const t = this.now();
    return Math.max(0, Math.min(...this.models.map((m) => (this.until.get(m) ?? 0) - t)));
  }

  /** Set `model` aside for `ms`. Returns true when another model is free to take over now. */
  block(model: string, ms: number): boolean {
    this.until.set(model, Math.max(this.until.get(model) ?? 0, this.now() + ms));
    const next = this.current();
    return next !== model && (this.until.get(next) ?? 0) <= this.now();
  }
}

/** How long a model is set aside after each kind of failure. */
export const BLOCK_MS = { refused: 60 * 60_000, rateLimited: 60_000, failing: 2 * 60_000 };

/** Wait before retry `attempt`: Retry-After when sent, else exponential backoff; capped at 60 s. */
export function retryDelayMs(attempt: number, retryAfter?: string | null): number {
  const secs = retryAfter ? Number(retryAfter) : NaN;
  const fromHeader = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 0;
  return Math.min(60_000, Math.max(fromHeader, 1000 * 2 ** attempt + Math.random() * 250));
}

export interface RotationCallOptions {
  /** Retries of the same model on 5xx before it is set aside. */
  retries: number;
  /** Total 429s tolerated in one call before giving up. */
  rateLimitRetries: number;
  sleep: (ms: number) => Promise<void>;
  error: (message: string, status: number) => Error;
  warn?: (message: string) => void;
}

/**
 * One API call that survives a blocked model: 403/404 and 429 move to the
 * next free model at once (waiting only when every model is set aside), 5xx
 * retries the same model with backoff and then moves on.
 */
export async function callWithRotation(
  rotation: ModelRotation,
  send: (model: string) => Promise<{ status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }>,
  opts: RotationCallOptions,
): Promise<{ json: any; model: string }> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  for (let server = 0, limited = 0; ; ) {
    const model = rotation.current();
    const res = await send(model);
    const json = (await res.json().catch(() => ({}))) as any;
    if (res.status >= 200 && res.status < 300) return { json, model };
    const message = `${model} ${res.status}: ${json?.error?.message ?? "request failed"}`;
    if (res.status === 403 || res.status === 404) {
      if (rotation.block(model, BLOCK_MS.refused)) {
        warn(`${message}; switching to ${rotation.current()}`);
        server = 0;
        continue;
      }
      throw opts.error(message, res.status);
    }
    if (res.status === 429) {
      if (limited >= opts.rateLimitRetries) throw opts.error(message, res.status);
      const wait = retryDelayMs(limited++, res.headers?.get("retry-after"));
      if (rotation.block(model, Math.max(wait, BLOCK_MS.rateLimited))) {
        warn(`${message}; switching to ${rotation.current()}`);
        server = 0;
        continue;
      }
      await opts.sleep(wait);
      continue;
    }
    if (res.status < 500) throw opts.error(message, res.status);
    if (server < opts.retries) {
      await opts.sleep(retryDelayMs(server++));
      continue;
    }
    if (rotation.block(model, BLOCK_MS.failing)) {
      warn(`${message}; switching to ${rotation.current()}`);
      server = 0;
      continue;
    }
    throw opts.error(message, res.status);
  }
}
