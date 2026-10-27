/**
 * Muse Image over the Meta Model API Responses endpoint.
 *
 * Each call is one turn of a conversation. A later turn passes
 * `previous_response_id`, so the server already holds the character sheet and
 * every earlier panel: that is what keeps the character on-model.
 * Reference: meta-models/meta-model-cookbook, 05_muse_image.
 */

import sharp from "sharp";

export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
export const MUSE_IMAGE_MODEL = "muse-image-1.0";

export interface ImageTurn {
  prompt: string;
  previousResponseId?: string;
  /**
   * "WxH" of the picture we want back. The API takes only three sizes, so the
   * nearest one is requested and the result is centre-cropped to this.
   */
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
  constructor(
    message: string,
    public readonly status?: number,
    /** Meta's content filter refused the prompt. Rewording can help; retrying the same prompt does not. */
    public readonly filtered = false,
  ) {
    super(message);
  }
}

/** Sizes the image_generation tool accepts; anything else is a 400 ("unknown value 1024x1280"). */
export const API_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

export function apiSize(size: string): string {
  if ((API_SIZES as readonly string[]).includes(size)) return size;
  const [w, h] = size.split("x").map(Number);
  return w > h * 1.1 ? "1536x1024" : h > w * 1.1 ? "1024x1536" : "1024x1024";
}

/**
 * Every image becomes a PNG (the SVG renderer cannot embed WebP), centre-
 * cropped to the aspect ratio asked for at the resolution Muse drew it.
 * `size` only picks the shape: Muse renders at about 2.5 MP (1280x1920 for a
 * tall frame), and shrinking that to the request's 1024 px would throw detail
 * away. Final post sizes are set later, in one downscale.
 */
export async function normalizeImage(image: Buffer, size?: string): Promise<Buffer> {
  try {
    const img = sharp(image);
    const [w, h] = (size ?? "").split("x").map(Number);
    const meta = await img.metadata();
    if (w && h && meta.width && meta.height) {
      const ratio = w / h;
      const cw = Math.min(meta.width, Math.round(meta.height * ratio));
      const ch = Math.min(meta.height, Math.round(meta.width / ratio));
      img.extract({ left: Math.floor((meta.width - cw) / 2), top: Math.floor((meta.height - ch) / 2), width: cw, height: ch });
    }
    return await img.png().toBuffer();
  } catch {
    // Not an image sharp can read (test stubs); pass it through untouched.
    return image;
  }
}

const FILTERED = /content management policy|filtered/i;

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
    // PNG, not the default lossy WebP: line art and flat colour show WebP artefacts.
    if (turn.size) body.tools = [{ type: "image_generation", size: apiSize(turn.size), output_format: "png" }];
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
      if (res.status >= 200 && res.status < 300) {
        const result = parseResponse(json);
        return { ...result, image: await normalizeImage(result.image, turn.size) };
      }
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= this.retries) {
        const message = json?.error?.message ?? "request failed";
        throw new MuseImageError(`Muse Image ${res.status}: ${message}`, res.status, res.status === 400 && FILTERED.test(message));
      }
      await this.sleep(1000 * 2 ** attempt + Math.random() * 250);
    }
  }
}

export function parseResponse(json: any): ImageResult {
  if (json?.status && json.status !== "completed") throw new MuseImageError(`response status ${json.status}`);
  const output: any[] = Array.isArray(json?.output) ? json.output : [];
  const call = output.find((o) => o?.type === "image_generation_call");
  if (!call?.result) throw new MuseImageError("no image in response (filtered by safety, or text-only reply)", undefined, true);
  const note = output
    .filter((o) => o?.type === "message")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .map((c: any) => c?.text ?? "")
    .join(" ")
    .trim();
  return { id: json.id, image: Buffer.from(call.result, "base64"), note, usage: json.usage ?? {} };
}

// Words that read as danger or distress out of context; a filtered prompt is retried without them.
const TENSE: Array<[RegExp, string]> = [
  [/\b(angry|furious|rage|shaking|trembling)\b/gi, "flustered"],
  [/\b(spiky|spikes|spiked)\b/gi, "puffed-up"],
  [/\b(defending itself|attack(ed|ing)?|fight(ing)?|threat(ening)?)\b/gi, "startled"],
  [/\b(scream(ing)?|panic(king)?|terrified|horror)\b/gi, "surprised"],
  [/\b(deer in headlights)\b/gi, "a surprised statue"],
  // Cartoon exaggeration that reads as injury or distress when taken literally.
  [/\bmelting off ([^,.;]+?) in despair like a puddle\b/gi, "sliding off $1 like soft jelly"],
  [/\b(melting|melts?)\b/gi, "drooping"],
  [/\bsquashed flat under\b/gi, "half hidden behind"],
  [/\b(squashed|crushed|flattened)\b/gi, "buried"],
  [/\b(toppling|collapsing|collapsed)\b/gi, "wobbly"],
  [/\btears streaming like fountains\b/gi, "big cartoon teardrops"],
  [/\b(tears streaming|streaming tears|crying|sobbing)\b/gi, "teary-eyed"],
  [/\b(despair|despairing|agony|anguish)\b/gi, "a comic sulk"],
  [/\banger veins?( on the forehead)?\b/gi, "a small cartoon cross mark"],
  [/\bsteam puffs from the ears\b/gi, "little puffs of steam"],
  [/\beyes popping( out)?\b/gi, "eyes wide"],
  [/\bspiral eyes|eyes turned to spirals\b/gi, "dizzy eyes"],
  [/\bjaw dropped to the floor\b/gi, "mouth wide open"],
  [/\bfur standing on end\b/gi, "fluffed-up fur"],
  [/\blate at night alone in a dark office\b/gi, "after hours in a cosy office"],
];

/** A gentler wording of a prompt Meta's filter refused. */
export function softenPrompt(prompt: string): string {
  const calm = TENSE.reduce((p, [re, to]) => p.replace(re, to), prompt);
  return `A gentle, wholesome, all-ages cartoon about friendly animal office workers. ${calm}`;
}

/** Generate; if the content filter refuses, try once more with the softened prompt. */
export async function generateSoftly(client: Pick<MuseImage, "generate">, turn: ImageTurn, log?: (s: string) => void): Promise<ImageResult> {
  try {
    return await client.generate(turn);
  } catch (e) {
    if (!(e instanceof MuseImageError && e.filtered)) throw e;
    log?.("content filter refused the prompt; retrying with gentler wording");
    return client.generate({ ...turn, prompt: softenPrompt(turn.prompt) });
  }
}
