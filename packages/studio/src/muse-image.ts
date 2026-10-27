/**
 * Muse Image over the Meta Model API Responses endpoint.
 *
 * Each call is one turn of a conversation. A later turn passes
 * `previous_response_id`, so the server already holds the character sheet and
 * every earlier panel: that is what keeps the character on-model.
 * Reference: meta-models/meta-model-cookbook, 05_muse_image.
 */

export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
export const MUSE_IMAGE_MODEL = "muse-image-1.0";

export interface ImageTurn {
  prompt: string;
  previousResponseId?: string;
  /** "WxH". Sets the aspect ratio only, not exact pixels. */
  size?: string;
  /** Extra images the server does not have yet, as URLs or data URLs. */
  references?: string[];
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface ImageResult {
  id: string;
  image: Buffer;
  /** The model's short message alongside the image, if any. */
  note: string;
  usage: Usage;
}

export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export class MuseImageError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

export interface MuseImageOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  transport?: Transport;
  /** Retries for 429 and 5xx. Client errors are never retried. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class MuseImage {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly transport: Transport;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: MuseImageOptions) {
    if (!opts.apiKey) throw new MuseImageError("Missing API key: set META_API_KEY (or MODEL_API_KEY) in .env");
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = opts.model ?? MUSE_IMAGE_MODEL;
    this.transport = opts.transport ?? ((url, init) => fetch(url, init));
    this.retries = opts.retries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, transport?: Transport): MuseImage {
    return new MuseImage({
      apiKey: env.META_API_KEY || env.MODEL_API_KEY || "",
      baseUrl: env.META_API_BASE_URL || undefined,
      model: env.MUSE_IMAGE_MODEL || undefined,
      transport,
    });
  }

  requestBody(turn: ImageTurn): Record<string, unknown> {
    const body: Record<string, unknown> = { model: this.model };
    // Reference images must sit inside a user message; a bare content list is a 400.
    body.input = turn.references?.length
      ? [
          {
            role: "user",
            content: [
              { type: "input_text", text: turn.prompt },
              ...turn.references.map((image_url) => ({ type: "input_image", image_url })),
            ],
          },
        ]
      : turn.prompt;
    if (turn.previousResponseId) body.previous_response_id = turn.previousResponseId;
    if (turn.size) body.tools = [{ type: "image_generation", size: turn.size }];
    return body;
  }

  async generate(turn: ImageTurn): Promise<ImageResult> {
    const body = JSON.stringify(this.requestBody(turn));
    for (let attempt = 0; ; attempt++) {
      const res = await this.transport(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.status >= 200 && res.status < 300) return parseResponse(json);
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= this.retries) {
        throw new MuseImageError(`Muse Image ${res.status}: ${json?.error?.message ?? "request failed"}`, res.status);
      }
      await this.sleep(1000 * 2 ** attempt + Math.random() * 250);
    }
  }
}

export function parseResponse(json: any): ImageResult {
  if (json?.status && json.status !== "completed") throw new MuseImageError(`response status ${json.status}`);
  const output: any[] = Array.isArray(json?.output) ? json.output : [];
  const call = output.find((o) => o?.type === "image_generation_call");
  if (!call?.result) throw new MuseImageError("no image in response (filtered by safety, or text-only reply)");
  const note = output
    .filter((o) => o?.type === "message")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => c?.text ?? "")
    .join(" ")
    .trim();
  return { id: json.id, image: Buffer.from(call.result, "base64"), note, usage: json.usage ?? {} };
}
