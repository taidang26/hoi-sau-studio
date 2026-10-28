/**
 * Tư liệu: a moodboard per brand. Images come from an upload or from a
 * public Instagram business account (Business Discovery). Text comes from
 * lines pasted by hand (a Threads comment someone liked) or from the replies
 * under our own Threads posts: Muse Spark turns those into voice patterns
 * (a sentence frame, the slang and what it means) plus one new line of ours,
 * so the writer learns how young readers talk without quoting them. Muse Spark reads
 * each one and writes down only transferable structure (the gag, the panel
 * layout, a pose, the palette, the dialogue rhythm) as short recipes with the
 * source kept. The person pins a recipe for the next episode or for a
 * character; Studio adds it to the episode's direction as words.
 *
 * Source images stay on this machine and are never sent to Muse Image as a
 * reference. After an episode is drawn, its pages can be compared with the
 * sources it learned from, so nothing goes out that looks copied.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageSize, svgToPng } from "@hoi-sau/svg-text";
import { maskSwears, S, type ChatMessage, type JsonSchema } from "@hoi-sau/studio";
import { t } from "./i18n.js";
import { button, esc, flash, layout } from "./views.js";

export const IDEA_KINDS = ["gag", "layout", "pose", "palette", "rhythm", "voice"] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];
export const KIND_LABEL: Record<IdeaKind, string> = { gag: "Kiểu gag", layout: "Bố cục khung", pose: "Tư thế", palette: "Bảng màu", rhythm: "Nhịp thoại", voice: "Giọng Threads" };
const KIND_ICON: Record<IdeaKind, string> = { gag: "😆", layout: "▦", pose: "🤸", palette: "🎨", rhythm: "💬", voice: "🧵" };

export interface Idea {
  id: string;
  kind: IdeaKind;
  title: string;
  recipe: string;
  /** Voice patterns: one new line in our own voice that uses the pattern. */
  example?: string;
  /** Our characters this suits. */
  fits: string[];
  /** Pinned for the next episode, or as a note on one character. */
  pin?: { to: "next" } | { to: "character"; slug: string };
  /** Episodes that used it. */
  usedIn: string[];
}

export interface Clip {
  id: string;
  brand: string;
  /** The saved image; text clips have none. */
  file?: string;
  /** Pasted lines or a batch of replies, for voice clips. */
  text?: string;
  hash: string;
  addedAt: string;
  source: { from: "upload" | "instagram" | "sample" | "text" | "threads"; link?: string; account?: string; caption?: string };
  status: "new" | "reading" | "done" | "failed";
  summary?: string;
  ideas: Idea[];
  error?: string;
}

export interface Verdict {
  clip: string;
  brand: string;
  score: number;
  tooClose: boolean;
  note: string;
}

export interface Comparison {
  at: string;
  results: Verdict[];
}

/** What Muse Spark offers here: one structured call that may include images. */
export interface Analyst {
  json<T>(name: string, schema: JsonSchema, messages: ChatMessage[]): Promise<T>;
}

/** One recent post of a public Instagram business or creator account. */
export interface FoundPost {
  image: string;
  link: string;
  caption?: string;
  account: string;
}

/** One reply under one of our own Threads posts. */
export interface ThreadsLine {
  id: string;
  text: string;
  link?: string;
}

export interface ResearchOptions {
  dir: string;
  analyst: () => Analyst;
  cast: () => Array<{ slug: string; name: string; about: string }>;
  discover?: (handle: string) => Promise<FoundPost[]>;
  /** Replies already pulled from the brand's Threads posts. */
  threadsReplies?: (brand: string) => Promise<ThreadsLine[]>;
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 4000;
/** Replies sent to Muse Spark in one read. */
const THREADS_BATCH = 60;
const newId = () => randomBytes(5).toString("hex");

const analysisSchema = S.obj({
  summary: S.str("One sentence: what kind of post this is, in craft terms only."),
  ideas: S.arr(
    S.obj({
      kind: S.enum([...IDEA_KINDS]),
      title: S.str("Three to seven words."),
      recipe: S.str("One or two sentences another artist could apply to different characters."),
      example: S.str("For `voice` ideas: one new office line of ours, Hanoi spoken Vietnamese, at most 12 words. Otherwise an empty string."),
      fits: S.arr(S.str("A slug from our cast.")),
    }),
    1,
    6,
  ),
});

const voiceSchema = S.obj({
  summary: S.str("One sentence: what kind of lines these are and the mood, in craft terms."),
  ideas: S.arr(
    S.obj({
      kind: S.enum(["voice", "rhythm"]),
      title: S.str("Three to seven words naming the pattern."),
      recipe: S.str("The sentence frame with slots, the slang word and what it means, and when it lands. One or two sentences."),
      example: S.str("One new line for our office comic that uses the pattern: Hanoi spoken Vietnamese, at most 12 words, not a line from the source."),
      fits: S.arr(S.str("A slug from our cast.")),
    }),
    1,
    6,
  ),
});

const compareSchema = S.obj({
  score: S.int("0 = nothing alike, 10 = a copy or a trace."),
  too_close: S.bool(),
  note: S.str("One sentence on what is alike, if anything."),
});

const dataUrl = (data: Buffer) => `data:${imageSize(data).mime};base64,${data.toString("base64")}`;

/** PNG, JPEG or WebP; anything else is refused before it is saved. */
function imageExt(data: Buffer): string {
  try {
    const { mime } = imageSize(data);
    return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  } catch {
    throw new Error(t("Chỉ nhận ảnh PNG, JPG hoặc WebP."));
  }
}

/** "@name", "name" or an instagram.com profile link → "name". */
export function instagramHandle(input: string): string {
  const h = input
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9._]{1,30}$/.test(h)) throw new Error(t("Tên tài khoản Instagram không hợp lệ."));
  return h;
}

export class Research {
  readonly jobs = new Map<string, { running: boolean; step?: string; error?: string }>();
  constructor(readonly opts: ResearchOptions) {}

  private brandDir(brand: string): string {
    if (!/^[a-z0-9-]+$/.test(brand)) throw new Error(t("Không thấy kênh này."));
    return join(this.opts.dir, brand);
  }

  fileOf(clip: Clip): string {
    if (!clip.file) throw new Error(t("Tư liệu này là chữ, không có ảnh."));
    return join(this.brandDir(clip.brand), "files", clip.file);
  }

  list(brand: string): Clip[] {
    const file = join(this.brandDir(brand), "library.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { clips: Clip[] }).clips : [];
  }

  private save(brand: string, clips: Clip[]): void {
    const dir = this.brandDir(brand);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "library.json"), `${JSON.stringify({ clips }, null, 2)}\n`);
  }

  /** Brands that have a library. */
  brands(): string[] {
    return existsSync(this.opts.dir) ? readdirSync(this.opts.dir).filter((b) => existsSync(join(this.opts.dir, b, "library.json"))) : [];
  }

  private update(brand: string, clipId: string, change: (c: Clip) => void): Clip {
    const clips = this.list(brand);
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) throw new Error(t("Không thấy ảnh tư liệu này."));
    change(clip);
    this.save(brand, clips);
    return clip;
  }

  /** Saves one image; the same image twice is kept once. Returns the clip and whether it is new. */
  add(brand: string, data: Buffer, source: Clip["source"]): { clip: Clip; added: boolean } {
    if (!data.length) throw new Error(t("Chưa chọn ảnh."));
    if (data.length > MAX_BYTES) throw new Error(t("Ảnh lớn quá (tối đa 15 MB)."));
    const ext = imageExt(data);
    const hash = createHash("sha1").update(data).digest("hex");
    const clips = this.list(brand);
    const same = clips.find((c) => c.hash === hash);
    if (same) return { clip: same, added: false };
    const id = newId();
    const clip: Clip = { id, brand, file: `${id}.${ext}`, hash, addedAt: new Date().toISOString(), source, status: "new", ideas: [] };
    mkdirSync(join(this.brandDir(brand), "files"), { recursive: true });
    writeFileSync(this.fileOf(clip), data);
    this.save(brand, [clip, ...clips]);
    return { clip, added: true };
  }

  /** Saves pasted lines; the same text twice (ignoring case and spaces) is kept once. */
  addText(brand: string, text: string, source: Clip["source"]): { clip: Clip; added: boolean } {
    const body = text.trim();
    if (!body) throw new Error(t("Chưa dán câu nào."));
    if (body.length > MAX_TEXT) throw new Error(t("Dài quá (tối đa {n} ký tự).", { n: MAX_TEXT }));
    const hash = createHash("sha1").update(body.toLowerCase().replace(/\s+/g, " ")).digest("hex");
    const clips = this.list(brand);
    const same = clips.find((c) => c.hash === hash);
    if (same) return { clip: same, added: false };
    const clip: Clip = { id: newId(), brand, text: body, hash, addedAt: new Date().toISOString(), source, status: "new", ideas: [] };
    this.save(brand, [clip, ...clips]);
    return { clip, added: true };
  }

  /** Replies under our Threads posts not learned from yet, saved as one text clip. Returns how many. */
  async learnThreads(brand: string): Promise<number> {
    if (!this.opts.threadsReplies) throw new Error(t("Chưa kết nối Threads."));
    const seenFile = join(this.brandDir(brand), "threads-seen.json");
    const seen = new Set<string>(existsSync(seenFile) ? (JSON.parse(readFileSync(seenFile, "utf8")) as string[]) : []);
    const fresh = (await this.opts.threadsReplies(brand)).filter((r) => !seen.has(r.id) && r.text.trim().length >= 4).slice(0, THREADS_BATCH);
    if (!fresh.length) return 0;
    this.addText(brand, fresh.map((r) => `- ${r.text.trim().replace(/\s+/g, " ")}`).join("\n"), { from: "threads", link: fresh[0].link });
    for (const r of fresh) seen.add(r.id);
    writeFileSync(seenFile, `${JSON.stringify([...seen])}\n`);
    return fresh.length;
  }

  async addFromUrl(brand: string, url: string, source: Clip["source"]): Promise<{ clip: Clip; added: boolean }> {
    const res = await (this.opts.fetch ?? fetch)(url);
    if (!res.ok) throw new Error(t("Không tải được ảnh ({status}).", { status: res.status }));
    return this.add(brand, Buffer.from(await res.arrayBuffer()), source);
  }

  /** Latest posts of a public Instagram business or creator account. Returns how many were new. */
  async importInstagram(brand: string, input: string, max = 6): Promise<number> {
    const handle = instagramHandle(input);
    if (!this.opts.discover) throw new Error(t("Chưa kết nối Instagram nên chưa đọc được kênh khác."));
    const posts = (await this.opts.discover(handle)).slice(0, max);
    if (!posts.length) throw new Error(t("@{handle} chưa có bài ảnh công khai.", { handle }));
    let added = 0;
    for (const p of posts) {
      const r = await this.addFromUrl(brand, p.image, { from: "instagram", link: p.link, account: p.account, caption: p.caption?.slice(0, 280) });
      if (r.added) added++;
    }
    return added;
  }

  remove(brand: string, clipId: string): void {
    const clips = this.list(brand);
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    if (clip.file) rmSync(this.fileOf(clip), { force: true });
    this.save(
      brand,
      clips.filter((c) => c.id !== clipId),
    );
  }

  private background(key: string, work: (log: (s: string) => void) => Promise<void>): void {
    if (this.jobs.get(key)?.running) throw new Error(t("Việc này đang chạy."));
    const job: { running: boolean; step?: string; error?: string } = { running: true };
    this.jobs.set(key, job);
    void (async () => {
      try {
        await work((s) => (job.step = s));
      } catch (e) {
        job.error = e instanceof Error ? e.message : String(e);
      } finally {
        job.running = false;
      }
    })();
  }

  running(brand: string): boolean {
    return [...this.jobs.entries()].some(([k, j]) => j.running && k.endsWith(`:${brand}`));
  }

  /** Reads one image or one text into recipes; the analysis asks for structure only. */
  async read(brand: string, clipId: string): Promise<Clip> {
    const clip = this.update(brand, clipId, (c) => {
      c.status = "reading";
      c.error = undefined;
    });
    const cast = this.opts.cast();
    if (clip.text !== undefined) return this.readText(clip, cast);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You study other creators' comics and short posts to learn craft, never to copy them.",
          "Write down only structure that transfers to different characters: the kind of gag and its setup, the panel layout and camera, a body pose or acting beat, the palette as a mood (warm/cool, contrast), and the rhythm of the dialogue.",
          "Never describe or name their characters, mascots, brand, logo or signature drawing style. Never quote their text. Never suggest tracing or redrawing the image.",
          "If the image is a screenshot of posts or comments (Threads, Facebook, TikTok), it is about voice, not drawing: use kind `voice` for the sentence frame, the reversal or the slang (a slang phrase may be named, a whole line never), `rhythm` for the pacing, and write `example` as a new line our office characters could say, typed the way Threads writes. Keep swearing if the source swears, but always masked with * (\"đ*m\", \"v*l\"). Skip insults at someone, sexual words and anything about real people.",
          "Write titles and recipes in Vietnamese. `fits` lists slugs of our characters whose personality suits the recipe, or is empty.",
          `Our cast: ${cast.map((c) => `${c.slug} (${c.name}): ${c.about}`).join("; ")}.`,
        ].join("\n"),
      },
      { role: "user", content: [{ type: "text", text: clip.source.caption ? `Post caption, for context only: ${clip.source.caption}` : "Read this image." }, { type: "image_url", image_url: { url: dataUrl(readFileSync(this.fileOf(clip))) } }] },
    ];
    try {
      const out = await this.opts.analyst().json<{ summary: string; ideas: Array<{ kind: IdeaKind; title: string; recipe: string; example?: string; fits: string[] }> }>("research", analysisSchema, messages);
      const slugs = new Set(cast.map((c) => c.slug));
      return this.update(brand, clipId, (c) => {
        c.status = "done";
        c.summary = out.summary;
        c.ideas = out.ideas.map((i) => ({ id: newId(), kind: i.kind, title: i.title, recipe: i.recipe, ...(i.example?.trim() ? { example: maskSwears(i.example.trim()) } : {}), fits: i.fits.filter((f) => slugs.has(f)), usedIn: [] }));
      });
    } catch (e) {
      this.update(brand, clipId, (c) => {
        c.status = "failed";
        c.error = e instanceof Error ? e.message : String(e);
      });
      throw e;
    }
  }

  /** Lines people write on Threads → voice patterns, each with a new line of ours. */
  private async readText(clip: Clip, cast: Array<{ slug: string; name: string; about: string }>): Promise<Clip> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You study how young Vietnamese write on Threads (comments, replies, short posts) so an office comic can sound like them, never to copy them.",
          "Pull out patterns that transfer: a sentence frame with slots (e.g. \"[khen] tưởng mình [chê]\"), a reversal or fake-praise move, the beat of short lines, a slang word or phrase and what it means right now.",
          "Use kind `voice` for frames and slang, `rhythm` for how lines are paced. A slang phrase may be named; never repeat a whole line from the source.",
          "For each pattern write `example`: one new line our characters could say or our caption could use, typed the way young people write on Threads (lowercase-casual, t/m/ko/đc, \"=)))\", trailing \"…\"), Hà Nội speech, punchy, at most 12 words, set in an office, without explaining the joke. Keep the swearing if the source swears, always masked with * (\"đ*m\", \"v*l\", \"đ*o\").",
          "Skip insults aimed at someone, sexual words, and anything mocking a body, a region, a gender, a real person or a brand. Write titles, recipes and examples in Vietnamese. `fits` lists slugs of our characters whose personality suits it, or is empty.",
          `Our cast: ${cast.map((c) => `${c.slug} (${c.name}): ${c.about}`).join("; ")}.`,
        ].join("\n"),
      },
      { role: "user", content: `Lines (${clip.source.from === "threads" ? "replies under our own posts" : "pasted by our editor"}):\n${clip.text}` },
    ];
    try {
      const out = await this.opts.analyst().json<{ summary: string; ideas: Array<{ kind: IdeaKind; title: string; recipe: string; example: string; fits: string[] }> }>("voice", voiceSchema, messages);
      const slugs = new Set(cast.map((c) => c.slug));
      return this.update(clip.brand, clip.id, (c) => {
        c.status = "done";
        c.summary = out.summary;
        c.ideas = out.ideas.map((i) => ({ id: newId(), kind: i.kind, title: i.title, recipe: i.recipe, example: maskSwears(i.example), fits: i.fits.filter((f) => slugs.has(f)), usedIn: [] }));
      });
    } catch (e) {
      this.update(clip.brand, clip.id, (c) => {
        c.status = "failed";
        c.error = e instanceof Error ? e.message : String(e);
      });
      throw e;
    }
  }

  /** Reads every image not read yet, in the background. Returns how many. */
  readNew(brand: string): number {
    const todo = this.list(brand).filter((c) => c.status === "new" || c.status === "failed");
    if (!todo.length) return 0;
    this.background(`read:${brand}`, async (log) => {
      for (const [i, c] of todo.entries()) {
        log(t("Đọc tư liệu {i}/{n}", { i: i + 1, n: todo.length }));
        await this.read(brand, c.id).catch(() => {});
      }
    });
    return todo.length;
  }

  private findIdea(brand: string, ideaId: string): { clips: Clip[]; idea: Idea } {
    const clips = this.list(brand);
    const idea = clips.flatMap((c) => c.ideas).find((i) => i.id === ideaId);
    if (!idea) throw new Error(t("Không thấy ý này."));
    return { clips, idea };
  }

  pin(brand: string, ideaId: string, pin: Idea["pin"]): void {
    const { clips, idea } = this.findIdea(brand, ideaId);
    idea.pin = pin;
    this.save(brand, clips);
  }

  /** Every idea with its clip, newest first. */
  ideas(brand: string): Array<{ clip: Clip; idea: Idea }> {
    return this.list(brand).flatMap((clip) => clip.ideas.map((idea) => ({ clip, idea })));
  }

  /** Pinned recipes across brands: for the next episode, or for one of `cast`. */
  pinned(cast?: string[]): Array<{ clip: Clip; idea: Idea }> {
    return this.brands()
      .flatMap((b) => this.ideas(b))
      .filter(({ idea }) => idea.pin && (idea.pin.to === "next" || !cast || cast.includes(idea.pin.slug)));
  }

  /** "brand:ideaId" refs → the lines added to an episode's direction. */
  recipes(refs: string[]): string {
    const lines = refs.flatMap((ref) => {
      const [brand, id] = ref.split(":");
      try {
        const { idea } = this.findIdea(brand, id);
        return [`- ${idea.title}: ${idea.recipe}${idea.example ? ` ${t("Ví dụ: “{line}”", { line: idea.example })}` : ""}`];
      } catch {
        return [];
      }
    });
    return lines.length ? `\n\n${t("Công thức tham khảo (chỉ học cấu trúc, không chép hình hay chép câu):")}\n${lines.join("\n")}` : "";
  }

  /** Records that an episode used these ideas; "next" pins are spent. */
  attach(refs: string[], episodeId: string): void {
    for (const ref of refs) {
      const [brand, id] = ref.split(":");
      try {
        const { clips, idea } = this.findIdea(brand, id);
        if (!idea.usedIn.includes(episodeId)) idea.usedIn.push(episodeId);
        if (idea.pin?.to === "next") idea.pin = undefined;
        this.save(brand, clips);
      } catch {
        /* removed meanwhile */
      }
    }
  }

  /** Images an episode learned from; text clips are not drawings to compare against. */
  sourcesOf(episodeId: string): Clip[] {
    return this.brands().flatMap((b) => this.list(b).filter((c) => c.file && c.ideas.some((i) => i.usedIn.includes(episodeId))));
  }

  comparison(episodeId: string): Comparison | undefined {
    const file = join(this.opts.dir, "compare", `${episodeId}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Comparison) : undefined;
  }

  /** Compares the finished pages with every source the episode learned from, in the background. */
  compare(episodeId: string, pages: string[]): void {
    const sources = this.sourcesOf(episodeId);
    if (!sources.length) throw new Error(t("Tập này không dùng tư liệu nào."));
    if (!pages.length) throw new Error(t("Tập chưa có trang hoàn chỉnh để so."));
    this.background(`compare:${episodeId}`, async (log) => {
      const ours = pages.slice(0, 3).map((p) => ({ type: "image_url" as const, image_url: { url: dataUrl(readFileSync(p)) } }));
      const results: Verdict[] = [];
      for (const [i, clip] of sources.entries()) {
        log(t("So với ảnh {i}/{n}", { i: i + 1, n: sources.length }));
        const r = await this.opts.analyst().json<{ score: number; too_close: boolean; note: string }>("compare", compareSchema, [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "The first images are our new comic. The last image is someone else's post we only took ideas from. Rate how close ours is to theirs: same characters or designs, traced poses, the same composition shot for shot, copied text. Sharing a general gag type or a palette mood is fine. Set too_close when a viewer could fairly say ours copies theirs. Write the note in Vietnamese.",
              },
              ...ours,
              { type: "image_url", image_url: { url: dataUrl(readFileSync(this.fileOf(clip))) } },
            ],
          },
        ]);
        results.push({ clip: clip.id, brand: clip.brand, score: Math.max(0, Math.min(10, Math.round(r.score))), tooClose: r.too_close || r.score >= 7, note: r.note });
      }
      mkdirSync(join(this.opts.dir, "compare"), { recursive: true });
      writeFileSync(join(this.opts.dir, "compare", `${episodeId}.json`), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
    });
  }
}

// ── demo ─────────────────────────────────────────────────────────────────

const SAMPLE_IDEAS: Array<Omit<Idea, "id" | "usedIn" | "fits"> & { fits: number[] }> = [
  { kind: "layout", title: "Ba khung, khung cuối im lặng", recipe: "Hai khung đầu dồn thoại, khung ba không chữ, chỉ còn gương mặt phản ứng phóng to.", fits: [0, 3] },
  { kind: "gag", title: "Than hai lần, lần ba phũ", recipe: "Nhân vật than thở hai lần cùng một nhịp, lần thứ ba thực tế đập lại bằng một hình ảnh ngắn.", fits: [0, 1] },
  { kind: "pose", title: "Ôm đầu ngửa ra ghế", recipe: "Ngả hẳn ra sau ghế, hai tay ôm đầu, chân duỗi thẳng: đọc được cả khi ảnh thu nhỏ.", fits: [0] },
  { kind: "palette", title: "Nền pastel ấm, nhân vật đậm", recipe: "Nền một màu kem hoặc hồng nhạt, nhân vật viền đen dày và màu bão hoà hơn nền một bậc.", fits: [] },
  { kind: "rhythm", title: "Câu ngắn dần", recipe: "Mỗi bong bóng ngắn hơn bong bóng trước, câu cuối chỉ một hai chữ.", fits: [1, 2] },
  { kind: "pose", title: "Cuộn tròn trốn việc", recipe: "Thu người thành một khối tròn ở góc khung, chỉ lộ đôi mắt, đồng nghiệp đứng to phía trước.", fits: [2] },
  { kind: "gag", title: "Khen xong biến mất", recipe: "Được khen trước đám đông, khung sau chỉ còn chiếc ghế trống và một chiếc lá rung.", fits: [3] },
  { kind: "layout", title: "Cận mặt rồi kéo xa", recipe: "Khung một cận sát mắt, khung hai kéo xa thấy cả văn phòng đang nhìn.", fits: [1, 3] },
];

const SAMPLE_VOICE = [
  { kind: "voice" as const, title: "Khen ngược", recipe: "Khung “[khen] tưởng mình [chê]”: khen mà như chê, dùng khi ai đó làm quá tốt một việc vô bổ.", example: "đi làm đúng giờ tưởng mình bị phạt =)))", fits: [0] },
  { kind: "voice" as const, title: "Khựng lại: “Ủa? Từ từ…”", recipe: "Đọc đến chi tiết bất ngờ thì khựng, hai chữ rồi dấu ba chấm; câu sau mới là cú lật.", example: "ủa từ từ… mail tăng lương là gửi nhầm phòng á đ*m", fits: [0, 1] },
  { kind: "voice" as const, title: "“Cổ điển. Tôn trọng.”", recipe: "Hai câu cụt khen mỉa một thói quen cũ mà ai cũng ngán nhưng vẫn làm tới nơi.", example: "16h59 thứ 6 giao việc. cổ điển. tôn trọng.", fits: [1] },
  { kind: "rhythm" as const, title: "Ba câu, câu cuối một chữ", recipe: "Hai reply dài kể lể, reply cuối chỉ một chữ chốt lại cả chuỗi.", example: "deadline mai. sếp nghỉ phép. t cũng nghỉ… việc", fits: [] },
];

const SAMPLE_ART = [
  `<rect width="800" height="1000" fill="#fff4e8"/><g stroke="#2b2238" stroke-width="10" fill="#fff"><rect x="60" y="60" width="680" height="270" rx="18"/><rect x="60" y="365" width="680" height="270" rx="18"/><rect x="60" y="670" width="680" height="270" rx="18"/></g><g fill="#ffd2dc"><ellipse cx="220" cy="200" rx="90" ry="70"/><ellipse cx="560" cy="500" rx="90" ry="70"/><ellipse cx="400" cy="805" rx="150" ry="110"/></g><g fill="#fff" stroke="#2b2238" stroke-width="6"><path d="M330 120h300a30 30 0 0 1 30 30v40a30 30 0 0 1-30 30H380l-40 30 10-30h-20a30 30 0 0 1-30-30v-40a30 30 0 0 1 30-30z"/><path d="M110 420h300a30 30 0 0 1 30 30v40a30 30 0 0 1-30 30H200l-40 30 10-30h-60a30 30 0 0 1-30-30v-40a30 30 0 0 1 30-30z"/></g>`,
  `<rect width="800" height="1000" fill="#fdf0f3"/><g stroke="#2b2238" stroke-width="8"><rect x="90" y="120" width="190" height="190" rx="24" fill="#ffb4a2"/><rect x="305" y="120" width="190" height="190" rx="24" fill="#ffd6a5"/><rect x="520" y="120" width="190" height="190" rx="24" fill="#fdffb6"/><rect x="90" y="340" width="190" height="190" rx="24" fill="#caffbf"/><rect x="305" y="340" width="190" height="190" rx="24" fill="#a0c4ff"/><rect x="520" y="340" width="190" height="190" rx="24" fill="#2b2238"/></g><circle cx="400" cy="760" r="150" fill="#ffd6a5" stroke="#2b2238" stroke-width="12"/><circle cx="350" cy="740" r="16" fill="#2b2238"/><circle cx="450" cy="740" r="16" fill="#2b2238"/><path d="M350 810q50 30 100 0" stroke="#2b2238" stroke-width="10" fill="none"/>`,
  `<rect width="800" height="1000" fill="#eef4ff"/><rect x="180" y="560" width="440" height="40" rx="12" fill="#c9b8a6" stroke="#2b2238" stroke-width="8"/><path d="M250 600v260M550 600v260" stroke="#2b2238" stroke-width="12"/><g stroke="#2b2238" stroke-width="14" stroke-linecap="round" fill="none"><path d="M400 520l-60-150"/><path d="M330 380l-80-120M350 370l80-130"/><path d="M400 520l120 40 130 10"/></g><circle cx="320" cy="300" r="85" fill="#fff" stroke="#2b2238" stroke-width="12"/><path d="M290 300h20M340 300h20" stroke="#2b2238" stroke-width="10"/><path d="M240 230l-20-40M300 210l0-45M360 220l20-40" stroke="#ff5a7a" stroke-width="10" stroke-linecap="round"/>`,
  `<rect width="800" height="1000" fill="#f3efff"/><g fill="#fff" stroke="#2b2238" stroke-width="8"><path d="M80 120h640a30 30 0 0 1 30 30v100a30 30 0 0 1-30 30H200l-50 40 12-40H80a30 30 0 0 1-30-30V150a30 30 0 0 1 30-30z"/><path d="M180 380h460a30 30 0 0 1 30 30v80a30 30 0 0 1-30 30H300l-50 40 12-40h-82a30 30 0 0 1-30-30v-80a30 30 0 0 1 30-30z"/><path d="M300 620h220a30 30 0 0 1 30 30v60a30 30 0 0 1-30 30h-90l-40 40 10-40h-100a30 30 0 0 1-30-30v-60a30 30 0 0 1 30-30z"/></g><g stroke="#6c5cff" stroke-width="14" stroke-linecap="round"><path d="M120 180h560M120 225h420M220 435h380M220 475h220M340 680h140"/></g><circle cx="410" cy="880" r="60" fill="#ffd2dc" stroke="#2b2238" stroke-width="10"/>`,
];

/** Fake Muse Spark for the demo and tests: fixed recipes, and a copy is caught by its bytes. */
export function demoAnalyst(castSlugs: () => string[]): Analyst {
  let reads = 0;
  return {
    async json<T>(name: string, _schema: JsonSchema, messages: ChatMessage[]): Promise<T> {
      const images = messages.flatMap((m) => (Array.isArray(m.content) ? m.content.flatMap((c) => (c.type === "image_url" ? [c.image_url.url] : [])) : []));
      if (name === "compare") {
        const theirs = images[images.length - 1];
        const copy = images.slice(0, -1).includes(theirs);
        return (copy ? { score: 10, too_close: true, note: "Giống hệt ảnh gốc." } : { score: 2, too_close: false, note: "Chỉ chung kiểu nhịp truyện; nhân vật, bố cục và lời thoại khác hẳn." }) as T;
      }
      const n = reads++;
      const cast = castSlugs();
      if (name === "voice") {
        const picks = [0, 1].map((k) => SAMPLE_VOICE[(n * 2 + k) % SAMPLE_VOICE.length]);
        return {
          summary: "Bình luận ngắn kiểu Threads, khen ngược và câu cụt.",
          ideas: picks.map((p) => ({ ...p, fits: p.fits.map((f) => cast[f]).filter(Boolean) })),
        } as T;
      }
      const picks = [0, 1].map((k) => SAMPLE_IDEAS[(n * 2 + k) % SAMPLE_IDEAS.length]);
      return {
        summary: "Truyện tranh ngắn nhiều khung, nhịp nhanh, nền đơn giản.",
        ideas: picks.map((p) => ({ kind: p.kind, title: p.title, recipe: p.recipe, fits: p.fits.map((f) => cast[f]).filter(Boolean) })),
      } as T;
    },
  };
}

/** A few drawn sample cards, read by the demo analyst, so the page has something to show. */
export async function seedResearch(r: Research, brand = "hoi-sau"): Promise<void> {
  if (r.list(brand).length) return;
  for (const [i, art] of SAMPLE_ART.entries()) {
    const png = svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">${art}</svg>`);
    const { clip } = r.add(brand, png, { from: "sample", account: "vi_du", link: "https://www.instagram.com/" });
    await r.read(brand, clip.id);
    if (i === 0) r.pin(brand, r.list(brand).find((c) => c.id === clip.id)!.ideas[0].id, { to: "next" });
  }
  const { clip } = r.addText(brand, "- Hài hước tưởng mình vô duyên\n- Ủa? Từ từ…\n- Cổ điển. Tôn trọng.", { from: "text", link: "https://www.threads.net/" });
  await r.read(brand, clip.id);
}

// ── views ────────────────────────────────────────────────────────────────

export interface ResearchView {
  brands: Array<{ id: string; name: string }>;
  cast: Array<{ slug: string; name: string; src: string }>;
  brand: string;
  kind?: IdeaKind;
  canDiscover: boolean;
  canThreads?: boolean;
  ready: boolean;
  demo: boolean;
  ok?: string;
  error?: string;
}

const thumb = (c: Clip) => `/research-media/${esc(c.brand)}/files/${esc(c.file ?? "")}`;

/** The image, or for text clips a speech-bubble tile. */
const preview = (c: Clip) => (c.file ? `<img src="${thumb(c)}" alt="" loading="lazy">` : `<span class="text-tile" aria-hidden="true">${c.source.from === "threads" ? "🧵" : "💬"}</span>`);

function sourceLine(c: Clip): string {
  const who =
    c.source.from === "sample"
      ? t("Tư liệu mẫu")
      : c.source.from === "threads"
        ? t("Reply Threads của kênh")
        : c.source.from === "text"
          ? t("Câu dán vào")
          : c.source.account
            ? `@${c.source.account}`
            : t("Ảnh tải lên");
  return c.source.link ? `<a href="${esc(c.source.link)}" target="_blank" rel="noopener noreferrer">${esc(who)} ↗</a>` : esc(who);
}

export function researchPage(r: Research, v: ResearchView): string {
  const clips = r.list(v.brand);
  const busy = r.running(v.brand) || clips.some((c) => c.status === "reading");
  const job = r.jobs.get(`read:${v.brand}`);
  const unread = clips.filter((c) => c.status === "new" || c.status === "failed").length;
  const ideas = r.ideas(v.brand).filter(({ idea }) => !v.kind || idea.kind === v.kind);
  const face = (slug: string) => {
    const c = v.cast.find((x) => x.slug === slug);
    return c ? `<img class="face" src="${esc(c.src)}" alt="${esc(c.name)}" title="${esc(c.name)}">` : "";
  };
  const name = (slug: string) => v.cast.find((x) => x.slug === slug)?.name ?? slug;

  const tabs = `<nav class="chips">${v.brands.map((b) => `<a class="chip${b.id === v.brand ? " on" : ""}" href="/research?brand=${esc(b.id)}">${esc(b.name)}</a>`).join("")}</nav>`;
  const how = `<ol class="flow research-flow"><li><b>1</b>${esc(t("Thêm ảnh, câu hoặc kênh"))}</li><li><b>2</b>${esc(t("AI rút công thức"))}</li><li><b>3</b>${esc(t("Chọn ý cho tập sau"))}</li><li><b>4</b>${esc(t("Vẽ mới, so lại với gốc"))}</li></ol>
<p class="shield">🛡 ${esc(t("Chỉ học cấu trúc: kiểu gag, bố cục, tư thế, màu, nhịp thoại, giọng văn. Ảnh gốc chỉ nằm trên máy này và không bao giờ làm ảnh mẫu khi vẽ; câu của người khác không bao giờ được chép nguyên."))}</p>`;

  const add = `<div class="grid2 research-add">
<form class="card form drop" method="post" action="/research/upload?brand=${esc(v.brand)}" enctype="multipart/form-data"><h2>🖼 ${esc(t("Thêm ảnh"))}</h2>
<label>${esc(t("Link bài gốc (để ghi nguồn)"))} <span class="muted small">${esc(t("không bắt buộc, điền trước khi thả ảnh"))}</span><input name="link" type="url" placeholder="https://"></label>
<label class="dropzone"><input type="file" name="files" accept="image/png,image/jpeg,image/webp" multiple required onchange="if(this.files.length){this.nextElementSibling.textContent=${esc(JSON.stringify(t("Đang thêm {n} ảnh…")))}.replace('{n}',this.files.length);this.form.requestSubmit()}"><span class="drop-say">${esc(t("Bấm để chọn ảnh, hoặc kéo ảnh vào đây"))}</span><small class="muted">${esc(t("Ảnh chụp màn hình bài đăng hay comment Threads cũng được"))}</small></label>
<noscript><div class="row-actions"><button class="btn on">${esc(t("Thêm vào tư liệu"))}</button></div></noscript></form>
<script>/* An image dropped beside the zone would open in the tab and leave the page. */addEventListener("dragover",function(e){if(!(e.target instanceof HTMLInputElement))e.preventDefault()});addEventListener("drop",function(e){if(!(e.target instanceof HTMLInputElement))e.preventDefault()})</script>
<form class="card form" method="post" action="/research/text?brand=${esc(v.brand)}"><h2>🧵 ${esc(t("Dán câu hay"))}</h2>
<p class="muted small">${esc(t("Thấy comment Threads hay thì dán vào, mỗi câu một dòng. AI rút ra mẫu câu và từ lóng, rồi viết câu mới cho nhân vật mình."))}</p>
<label>${esc(t("Câu"))}<textarea name="text" rows="3" required maxlength="4000" placeholder="${esc(t("Hài hước tưởng mình vô duyên"))}"></textarea></label>
<label>${esc(t("Link (để ghi nguồn)"))} <span class="muted small">${esc(t("không bắt buộc"))}</span><input name="link" type="url" placeholder="https://www.threads.net/…"></label>
<div class="row-actions"><button class="btn on">${esc(t("Thêm và đọc"))}</button></div></form>
<form class="card form" method="post" action="/research/threads?brand=${esc(v.brand)}"><h2>🧵 ${esc(t("Học từ reply Threads"))}</h2>
<p class="muted small">${esc(t("Đọc reply dưới các bài Threads của kênh mình (máy tự làm mỗi tuần). Threads chỉ cho đọc bài của chính mình."))}</p>
<div class="row-actions"><button class="btn on"${v.canThreads ? "" : " disabled"}>${esc(t("Học ngay"))}</button>${v.canThreads ? "" : `<a class="small" href="/channels/hoi-sau">${esc(t("Cần kết nối Threads trước"))}</a>`}</div></form>
<form class="card form" method="post" action="/research/instagram?brand=${esc(v.brand)}"><h2>◎ ${esc(t("Lấy từ Instagram"))}</h2>
<p class="muted small">${esc(t("Kênh doanh nghiệp hoặc nhà sáng tạo công khai. Lấy 6 bài ảnh mới nhất qua Meta."))}</p>
<label>${esc(t("Tài khoản"))}<input name="account" required placeholder="@ten_kenh" autocomplete="off"></label>
<div class="row-actions"><button class="btn on"${v.canDiscover ? "" : " disabled"}>${esc(t("Lấy 6 bài mới nhất"))}</button>${v.canDiscover ? "" : `<a class="small" href="/channels/hoi-sau">${esc(t("Cần kết nối Instagram trước"))}</a>`}</div></form></div>`;

  const readBar = busy
    ? `<div class="notice"><span class="spinner"></span><b>${esc(t("AI đang đọc tư liệu"))}</b> ${esc(job?.step ?? "")}</div><meta http-equiv="refresh" content="2">`
    : unread
      ? `<div class="notice read-new"><span>${esc(t("{n} tư liệu chưa đọc.", { n: unread }))}</span>${v.ready ? button(`/research/read?brand=${v.brand}`, `✨ ${esc(t("AI đọc tất cả"))}`, "btn on") : `<a href="/settings">${esc(t("Cần khoá AI Muse"))}</a>`}</div>`
      : "";

  const kinds = `<nav class="chips">${[undefined, ...IDEA_KINDS].map((k) => `<a class="chip${k === v.kind ? " on" : ""}" href="/research?brand=${esc(v.brand)}${k ? `&kind=${k}` : ""}">${k ? `${KIND_ICON[k]} ${esc(t(KIND_LABEL[k]))}` : esc(t("Tất cả"))}</a>`).join("")}</nav>`;

  const ideaCard = ({ clip, idea }: { clip: Clip; idea: Idea }) => {
    const pinned = idea.pin?.to === "next" ? `<span class="tag ok">✓ ${esc(t("cho tập sau"))}</span>` : idea.pin?.to === "character" ? `<span class="tag ok">✓ ${esc(t("ghi cho {name}", { name: name(idea.pin.slug) }))}</span>` : "";
    const used = idea.usedIn.length ? `<span class="muted small">${esc(t("đã dùng"))}: ${idea.usedIn.map((e) => `<a href="/studio/${esc(e)}">${esc(e)}</a>`).join(", ")}</span>` : "";
    const nextBtn = button(`/research/pin?brand=${v.brand}`, esc(t(idea.pin?.to === "next" ? "Bỏ khỏi tập sau" : "Dùng cho tập sau")), idea.pin?.to === "next" ? "btn ghost" : "btn on", { idea: idea.id, to: idea.pin?.to === "next" ? "" : "next" });
    const charForm = `<form class="inline pin-char" method="post" action="/research/pin?brand=${esc(v.brand)}"><input type="hidden" name="idea" value="${esc(idea.id)}"><input type="hidden" name="to" value="character"><select name="slug" aria-label="${esc(t("Nhân vật"))}">${v.cast.map((c) => `<option value="${esc(c.slug)}"${idea.fits[0] === c.slug ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select><button class="btn">${esc(t("Ghi cho nhân vật"))}</button></form>`;
    return `<article class="card idea k-${idea.kind}"><div class="idea-head"><span class="kind">${KIND_ICON[idea.kind]} ${esc(t(KIND_LABEL[idea.kind]))}</span>${pinned}</div>
<h3>${esc(idea.title)}</h3><p>${esc(idea.recipe)}</p>${idea.example ? `<p class="example">“${esc(idea.example)}”</p>` : ""}
<div class="idea-src">${preview(clip)}<span class="small">${sourceLine(clip)}</span><span class="faces">${idea.fits.map(face).join("")}</span></div>
<div class="idea-actions">${nextBtn}${charForm}</div>${used}</article>`;
  };

  const status = (c: Clip) =>
    c.status === "done"
      ? `<span class="tag ok">${esc(t("{n} ý", { n: c.ideas.length }))}</span>`
      : c.status === "reading"
        ? `<span class="tag due"><span class="spinner"></span>${esc(t("đang đọc"))}</span>`
        : c.status === "failed"
          ? `<span class="tag over" title="${esc(c.error ?? "")}">${esc(t("chưa đọc được"))}</span>`
          : `<span class="tag">${esc(t("chưa đọc"))}</span>`;
  const clipCard = (c: Clip) =>
    `<figure class="clip">${c.file ? preview(c) : `<blockquote class="clip-text">${esc((c.text ?? "").slice(0, 160))}</blockquote>`}<figcaption>${status(c)}<span class="small">${sourceLine(c)}</span>${button(`/research/remove?brand=${v.brand}`, "✕", "btn ghost tiny", { clip: c.id })}</figcaption></figure>`;

  const body = `<header class="page-head"><div><h1>${esc(t("Tư liệu"))}</h1><p class="muted">${esc(t("Gom ý hay và câu hay từ kênh khác, AI rút thành công thức để dùng cho nhân vật của mình."))}</p></div></header>
${v.brands.length > 1 ? tabs : ""}
${flash(v.ok, v.error)}
${how}
${add}
${readBar}
<section><div class="card-head ideas-head"><h2>${esc(t("Ý dùng được"))} <span class="muted">${ideas.length}</span></h2>${kinds}</div>
${ideas.length ? `<div class="ideas">${ideas.map(ideaCard).join("")}</div>` : `<div class="card empty"><p>${esc(t(clips.length ? "Chưa có ý nào. Bấm “AI đọc tất cả” để rút công thức." : "Chưa có tư liệu. Thêm vài ảnh ở trên để bắt đầu."))}</p></div>`}</section>
${clips.length ? `<section class="card"><h2>${esc(t("Tư liệu đã thêm"))} <span class="muted">${clips.length}</span></h2><div class="clips">${clips.map(clipCard).join("")}</div></section>` : ""}`;
  return layout(t("Tư liệu"), "/research", body);
}

/** Pinned recipes as checkboxes on the new-episode form; "next" pins start ticked. */
export function inspirationField(r: Research, cast: Array<{ slug: string; name: string }>): string {
  const items = r.pinned();
  if (!items.length) return `<p class="muted small">${t('Mẹo: ghim ý hay ở trang <a href="/research">Tư liệu</a>, chúng sẽ hiện ở đây.')}</p>`;
  const who = (slug: string) => cast.find((c) => c.slug === slug)?.name ?? slug;
  return `<fieldset class="inspiration"><legend>${esc(t("Công thức từ Tư liệu"))}</legend>${items
    .map(
      ({ clip, idea }) =>
        `<label class="check"><input type="checkbox" name="idea" value="${esc(`${clip.brand}:${idea.id}`)}"${idea.pin?.to === "next" ? " checked" : ""}> ${KIND_ICON[idea.kind]} <b>${esc(idea.title)}</b>${idea.pin?.to === "character" ? ` <span class="tag">${esc(who(idea.pin.slug))}</span>` : ""} <span class="muted small">${esc(idea.recipe)}${idea.example ? ` “${esc(idea.example)}”` : ""}</span></label>`,
    )
    .join("")}</fieldset>`;
}

/** Notes pinned to one character, for its page. */
export function characterNotes(r: Research, slug: string): string {
  const items = r.pinned([slug]).filter(({ idea }) => idea.pin?.to === "character");
  if (!items.length) return "";
  return `<section class="card"><h2>${esc(t("Ghi chú từ Tư liệu"))}</h2><ul class="notes">${items
    .map(({ clip, idea }) => `<li>${preview(clip)}<div>${KIND_ICON[idea.kind]} <b>${esc(idea.title)}</b><p class="small">${esc(idea.recipe)}</p>${idea.example ? `<p class="small example">“${esc(idea.example)}”</p>` : ""}<span class="muted small">${sourceLine(clip)}</span></div></li>`)
    .join("")}</ul></section>`;
}

/** On an episode page: the sources it learned from and how close the result is. */
export function compareSection(r: Research, episodeId: string, canCompare: boolean): string {
  const sources = r.sourcesOf(episodeId);
  if (!sources.length) return "";
  const job = r.jobs.get(`compare:${episodeId}`);
  const result = r.comparison(episodeId);
  const verdict = (clip: Clip) => {
    const v = result?.results.find((x) => x.clip === clip.id);
    if (!v) return `<span class="tag">${esc(t("chưa so"))}</span>`;
    const cls = v.tooClose ? "over" : v.score >= 4 ? "due" : "ok";
    const label = v.tooClose ? "Quá giống, nên vẽ lại" : v.score >= 4 ? "Hơi giống" : "Khác hẳn";
    return `<span class="tag ${cls}">${esc(t(label))} · ${v.score}/10</span><span class="meter"><i style="width:${v.score * 10}%" class="${cls}"></i></span><p class="small muted">${esc(v.note)}</p>`;
  };
  const bar = job?.running
    ? `<div class="notice"><span class="spinner"></span>${esc(job.step ?? t("bắt đầu…"))}</div><meta http-equiv="refresh" content="2">`
    : `${job?.error ? `<div class="warn small">${esc(job.error)}</div>` : ""}${canCompare ? button(`/studio/${episodeId}/compare`, `🔍 ${esc(t(result ? "So lại" : "Kiểm tra độ giống"))}`, result ? "btn" : "btn on") : `<span class="muted small">${esc(t("Làm xong tập rồi so."))}</span>`}`;
  return `<section class="card"><div class="card-head"><h2>${esc(t("So với tư liệu gốc"))}</h2>${bar}</div><p class="muted small">${esc(t("Tập này học công thức từ các ảnh dưới đây. AI so trang hoàn chỉnh với từng ảnh để chắc không có gì giống kiểu sao chép."))}</p>
<ul class="compare">${sources.map((c) => `<li><img src="${thumb(c)}" alt="" loading="lazy"><div><span class="small">${sourceLine(c)}</span>${verdict(c)}</div></li>`).join("")}</ul></section>`;
}
