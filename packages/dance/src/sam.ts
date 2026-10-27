/**
 * SAM 3.1 on the Meta Model API: a short noun phrase plus an image in, every
 * match back as a box and a mask. The answer is SAM's special-token text,
 * which Meta's own @meta-sam/parser turns into records and rasters.
 */

import { decodeMaskToRaster, parseImageStream, recordsOfKind, type ResponsesEvent } from "@meta-sam/parser";

export const SAM_MODEL = "sam-3.1";

export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export class SamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SamError";
  }
}

/** One object SAM found, with its mask laid on the full image. */
export interface Segment {
  objectId: string;
  score?: number;
  width: number;
  height: number;
  /** Row-major 0/1, width × height of the whole image. */
  mask: Uint8Array;
  area: number;
}

export interface SamOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  transport?: Transport;
  retries?: number;
}

export class Sam {
  private readonly baseUrl: string;
  private readonly transport: Transport;

  constructor(private readonly opts: SamOptions) {
    if (!opts.apiKey) throw new SamError("Missing API key: set META_API_KEY (or MODEL_API_KEY) in .env");
    this.baseUrl = (opts.baseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, "");
    this.transport = opts.transport ?? ((url, init) => fetch(url, init));
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, transport?: Transport): Sam {
    return new Sam({ apiKey: env.META_API_KEY || env.MODEL_API_KEY || "", baseUrl: env.META_API_BASE_URL || undefined, model: env.SAM_MODEL || undefined, transport });
  }

  requestBody(phrase: string, imageUrl: string): Record<string, unknown> {
    return {
      model: this.opts.model ?? SAM_MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: phrase }, { type: "input_image", image_url: imageUrl }] }],
    };
  }

  /** Every match for `phrase` in the image (a data URL or https URL) of `width` × `height`. Zero matches is an empty list. */
  async segment(phrase: string, imageUrl: string, width: number, height: number): Promise<Segment[]> {
    const body = JSON.stringify(this.requestBody(phrase, imageUrl));
    const retries = this.opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const res = await this.transport(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.status >= 200 && res.status < 300) return decodeSegments(outputText(json), width, height);
      if (!(res.status === 429 || res.status >= 500) || attempt >= retries) throw new SamError(`SAM ${res.status}: ${json?.error?.message ?? "request failed"}`, res.status);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** The output_text of a non-streamed Responses answer. */
export function outputText(json: any): string {
  if (typeof json?.output_text === "string") return json.output_text;
  const parts: string[] = [];
  for (const item of json?.output ?? []) for (const c of item?.content ?? []) if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
  return parts.join("");
}

async function* asEvents(text: string): AsyncIterable<ResponsesEvent> {
  const lane = { item_id: "msg", output_index: 0, content_index: 0 };
  if (text) yield { type: "response.output_text.delta", ...lane, delta: text } as ResponsesEvent;
  yield { type: "response.output_text.done", ...lane, text } as ResponsesEvent;
  yield { type: "response.completed" } as ResponsesEvent;
}

/** Parses SAM's text with @meta-sam/parser and lays each mask on a full-size canvas. */
export async function decodeSegments(text: string, width: number, height: number): Promise<Segment[]> {
  if (!text.trim()) return [];
  const result = await parseImageStream(asEvents(text)).finalResult;
  const out: Segment[] = [];
  for (const rec of recordsOfKind(result.records, "mask")) {
    const raster = decodeMaskToRaster(rec.mask);
    const mw = rec.mask.width;
    const mh = rec.mask.height;
    const { left, top } = rec.bounds;
    const mask = new Uint8Array(width * height);
    let area = 0;
    for (let y = 0; y < mh; y++) {
      const gy = top + y;
      if (gy < 0 || gy >= height) continue;
      for (let x = 0; x < mw; x++) {
        const gx = left + x;
        if (gx < 0 || gx >= width || !raster[y * mw + x]) continue;
        mask[gy * width + gx] = 1;
        area++;
      }
    }
    out.push({ objectId: rec.objectId, score: rec.confidence, width, height, mask, area });
  }
  return out;
}
