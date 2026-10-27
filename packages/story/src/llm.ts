/**
 * Text models behind one small interface, so listening can run on Muse Spark
 * (Meta Model API), Muse Spark Open (Baseten or Modal) or the offline mock
 * without knowing which.
 */

export interface LlmRequest {
  /** Names the step; the mock uses it to pick an answer. */
  task: string;
  system: string;
  user: string;
  temperature?: number;
}

export interface LlmResult {
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface Llm {
  /** Model id, written into outputs so every file says what made it. */
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}

export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export class LlmError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

interface HttpOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  transport?: Transport;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

abstract class HttpLlm implements Llm {
  readonly model: string;
  protected readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(protected readonly opts: HttpOptions) {
    if (!opts.apiKey) throw new LlmError(`Missing API key for ${opts.model}`);
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.transport = opts.transport ?? ((url, init) => fetch(url, init));
    this.retries = opts.retries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  protected abstract path: string;
  abstract requestBody(req: LlmRequest): Record<string, unknown>;
  abstract parse(json: any): LlmResult;

  async complete(req: LlmRequest): Promise<LlmResult> {
    const body = JSON.stringify(this.requestBody(req));
    for (let attempt = 0; ; attempt++) {
      const res = await this.transport(`${this.baseUrl}${this.path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.status >= 200 && res.status < 300) return this.parse(json);
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= this.retries) {
        throw new LlmError(`${this.model} ${res.status}: ${json?.error?.message ?? "request failed"}`, res.status);
      }
      await this.sleep(1000 * 2 ** attempt + Math.random() * 250);
    }
  }
}

/**
 * OpenAI-compatible chat completions. The Meta Model API (Muse Spark, Muse
 * Wonder) and Muse Spark Open on Baseten or Modal all speak it.
 */
export class ChatLlm extends HttpLlm {
  protected path = "/chat/completions";

  requestBody(req: LlmRequest): Record<string, unknown> {
    return {
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      temperature: req.temperature ?? 0.4,
    };
  }

  parse(json: any): LlmResult {
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new LlmError("empty text in response");
    const u = json.usage ?? {};
    return { text, usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } };
  }
}

/** Takes the first JSON object or array out of a reply that may wrap it in prose or a code fence. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const src = fenced ? fenced[1] : text;
  const start = src.search(/[[{]/);
  if (start < 0) throw new LlmError("no JSON in reply");
  const open = src[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new LlmError("unterminated JSON in reply");
}

/**
 * Asks for JSON and checks it. On a parse or validation failure the model gets
 * one more turn with the errors listed, which fixes most slips.
 */
export async function askJson<T>(llm: Llm, req: LlmRequest, check: (value: unknown) => T, attempts = 2): Promise<T> {
  let user = req.user;
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    const { text } = await llm.complete({ ...req, user });
    try {
      return check(extractJson(text));
    } catch (e) {
      lastError = (e as Error).message;
      user = `${req.user}\n\nCâu trả lời trước bị lỗi: ${lastError}\nHãy trả lại đúng một JSON hợp lệ, sửa hết các lỗi trên.`;
    }
  }
  throw new LlmError(`${req.task}: no valid JSON after ${attempts} tries (${lastError})`);
}

export type Role = "writer" | "judge" | "listener";

export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
export const DEFAULT_MODELS: Record<Role, string> = {
  writer: "muse-spark-1.3",
  judge: "muse-spark-1.3",
  listener: "meta-models/muse-spark-open-1026",
};

/**
 * listener = Muse Spark Open when MUSE_SPARK_OPEN_URL and _KEY are set (the
 * open-weights track), else Muse Spark. writer = MUSE_WRITER_MODEL (e.g. Muse
 * Wonder) else Muse Spark. Returns undefined when no key is set, so callers
 * fall back to the offline mock.
 */
export function llmFromEnv(role: Role, env: NodeJS.ProcessEnv = process.env, transport?: Transport): Llm | undefined {
  if (role === "listener" && env.MUSE_SPARK_OPEN_URL && env.MUSE_SPARK_OPEN_KEY) {
    return new ChatLlm({
      apiKey: env.MUSE_SPARK_OPEN_KEY,
      baseUrl: env.MUSE_SPARK_OPEN_URL,
      model: env.MUSE_SPARK_OPEN_MODEL || DEFAULT_MODELS.listener,
      transport,
    });
  }
  const apiKey = env.META_API_KEY || env.MODEL_API_KEY;
  if (!apiKey) return undefined;
  const model = (role === "writer" && env.MUSE_WRITER_MODEL) || env.MUSE_SPARK_MODEL || DEFAULT_MODELS.judge;
  return new ChatLlm({ apiKey, baseUrl: env.META_API_BASE_URL || DEFAULT_BASE_URL, model, transport });
}
