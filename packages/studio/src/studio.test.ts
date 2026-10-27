import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  approveStyle,
  characterSheetPrompt,
  consistencyBeats,
  loadStyle,
  poseSheetPrompt,
  runStyleTest,
  SERIES_DIR,
  styleReference,
  styleText,
  listCharacters,
  loadProfile,
  mockTransport,
  MuseImage,
  MuseImageError,
  panelPrompt,
  parseResponse,
  ProfileError,
  runConsistency,
  validateProfile,
  type Transport,
} from "./index.js";

test("every test character loads and validates", () => {
  assert.deepEqual(listCharacters(), ["ca-noc", "cay-muc", "chon-bac-ma", "cu-li", "sao-la", "te-te"]);
  for (const slug of listCharacters()) {
    const p = loadProfile(slug);
    assert.equal(p.slug, slug);
    assert.equal(p.status, "candidate");
  }
});

test("characters are told apart by their palettes", () => {
  const main = listCharacters().map((s) => loadProfile(s).look.palette[0].hex);
  assert.equal(new Set(main).size, main.length);
});

test("validation reports every problem at once", () => {
  const p = structuredClone(loadProfile("cu-li")) as any;
  p.look.palette[0].hex = "brown";
  p.never_says = [];
  delete p.voice.register;
  assert.throws(
    () => validateProfile(p, "cu-li"),
    (e: unknown) => e instanceof ProfileError && /palette/.test(e.message) && /never_says/.test(e.message) && /voice/.test(e.message),
  );
  assert.throws(() => validateProfile(loadProfile("cu-li"), "ca-noc"), /does not match folder/);
});

test("prompts carry the signature and forbid drawn text", () => {
  for (const slug of listCharacters()) {
    const p = loadProfile(slug);
    const sheet = characterSheetPrompt(p);
    for (const s of p.look.signature) assert.ok(sheet.includes(s), `${slug} sheet prompt lost "${s}"`);
    assert.match(sheet, /no speech bubbles/);
    for (const beat of consistencyBeats(p)) {
      const prompt = panelPrompt(p, beat.scene);
      assert.match(prompt, /no text/);
      assert.match(prompt, /character from the sheet/);
      assert.equal(beat.size, "1024x1280"); // 4:5 feed carousel
    }
  }
});

test("request body follows the Responses API shape", () => {
  const client = new MuseImage({ apiKey: "k" });
  assert.deepEqual(client.requestBody({ prompt: "a", previousResponseId: "resp_1", size: "1024x1280" }), {
    model: "muse-image-1.0",
    input: "a",
    previous_response_id: "resp_1",
    tools: [{ type: "image_generation", size: "1024x1536", output_format: "png" }],
  });
  const withRef = client.requestBody({ prompt: "b", references: ["data:image/png;base64,AA"] }) as any;
  assert.equal(withRef.input[0].role, "user");
  assert.deepEqual(withRef.input[0].content[1], { type: "input_image", image_url: "data:image/png;base64,AA" });
});

test("parseResponse pulls the image and refuses empty or filtered replies", () => {
  const r = parseResponse({
    id: "resp_x",
    status: "completed",
    output: [
      { type: "reasoning" },
      { type: "message", content: [{ type: "output_text", text: "here" }] },
      { type: "image_generation_call", result: Buffer.from("img").toString("base64") },
    ],
    usage: { total_tokens: 5 },
  });
  assert.equal(r.image.toString(), "img");
  assert.equal(r.note, "here");
  assert.throws(() => parseResponse({ id: "r", status: "completed", output: [{ type: "message", content: [] }] }), MuseImageError);
  assert.throws(() => parseResponse({ id: "r", status: "incomplete", output: [] }), /incomplete/);
});

test("429 and 5xx are retried with backoff; 4xx is not", async () => {
  const ok = { id: "r", status: "completed", output: [{ type: "image_generation_call", result: "AA==" }] };
  const statuses = [429, 503, 200];
  let calls = 0;
  const flaky: Transport = async () => {
    const status = statuses[calls++];
    return { status, json: async () => (status === 200 ? ok : { error: { message: "busy" } }) };
  };
  const waits: number[] = [];
  const client = new MuseImage({ apiKey: "k", transport: flaky, sleep: async (ms) => void waits.push(ms) });
  await client.generate({ prompt: "x" });
  assert.equal(calls, 3);
  assert.ok(waits[1] > waits[0]);

  let bad = 0;
  const denied = new MuseImage({ apiKey: "k", transport: async () => (bad++, { status: 400, json: async () => ({ error: { message: "bad input" } }) }), sleep: async () => {} });
  await assert.rejects(denied.generate({ prompt: "x" }), /400: bad input/);
  assert.equal(bad, 1);
});

test("missing key fails early with a clear message", () => {
  assert.throws(() => MuseImage.fromEnv({}), /META_API_KEY/);
});

test("consistency run chains every panel from the sheet and writes a review page", async () => {
  const { transport, calls } = mockTransport();
  const client = new MuseImage({ apiKey: "mock", transport });
  const out = mkdtempSync(join(tmpdir(), "hoisau-"));
  const run = await runConsistency(client, loadProfile("te-te"), out, { model: "mock", mock: true });

  assert.deepEqual(run.images.map((i) => i.id), ["sheet", "poses", "desk", "meeting", "gag"]);
  assert.equal(calls[0].previous_response_id, undefined);
  for (let i = 1; i < calls.length; i++) assert.equal(calls[i].previous_response_id, run.images[i - 1].responseId);
  assert.equal(run.images[0].file, "sheet.png");
  assert.match(run.images[1].prompt, /12 full-body poses in a 4x3 grid/);
  assert.match(run.images[1].prompt, /fat red pen/);
  const saved = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
  assert.equal(saved.images.length, 5);
  assert.match(readFileSync(join(out, "review.html"), "utf8"), /large overlapping warm-brown rounded scales/);
});

test("every character has an identifying item named in its prompts", () => {
  for (const slug of listCharacters()) {
    const p = loadProfile(slug);
    assert.ok(p.look.icon, `${slug} has no look.icon`);
    assert.ok(characterSheetPrompt(p).includes(p.look.icon!));
    assert.ok(poseSheetPrompt(p).includes(p.look.icon!));
    assert.ok(panelPrompt(p, "a scene").includes(p.look.icon!));
  }
});

test("the series style replaces each profile's own style in prompts", () => {
  const style = loadStyle()!;
  assert.equal(style.chosen, null);
  assert.ok(style.variants.length >= 2);
  const text = styleText(style, "sticker-bold");
  assert.match(text, /chibi/);
  assert.match(text, /sticker/);
  assert.match(text, /Avoid:/);
  const p = loadProfile("cu-li");
  assert.ok(characterSheetPrompt(p, text).includes("Bold sticker look"));
  assert.ok(!characterSheetPrompt(p, text).includes(p.look.style));
  assert.ok(characterSheetPrompt(p).includes(p.look.style));
});

test("style test draws every variant; approve locks one as the reference sent with sheets", async () => {
  const seriesDir = mkdtempSync(join(tmpdir(), "hoisau-style-"));
  cpSync(SERIES_DIR, seriesDir, { recursive: true });
  const style = loadStyle(seriesDir)!;
  const { transport, calls } = mockTransport();
  const client = new MuseImage({ apiKey: "mock", transport });
  const out = mkdtempSync(join(tmpdir(), "hoisau-style-run-"));
  const renders = await runStyleTest(client, style, out, { mock: true });
  assert.equal(renders.length, style.variants.length);
  assert.ok(calls.every((c) => c.previous_response_id === undefined), "variants must not chain into each other");
  assert.match(readFileSync(join(out, "review.html"), "utf8"), /style approve hanoi-detail/);

  const name = approveStyle("hanoi-detail", out, seriesDir);
  const yaml = readFileSync(join(seriesDir, "style.yaml"), "utf8");
  assert.match(yaml, /^chosen: hanoi-detail$/m);
  assert.match(yaml, /^# Series art style/m, "comments survive");
  const locked = loadStyle(seriesDir)!;
  assert.equal(locked.reference, name);
  assert.ok(existsSync(join(seriesDir, name)));
  const ref = styleReference(locked, seriesDir)!;
  assert.match(ref, /^data:image\/png;base64,/);
  assert.throws(() => approveStyle("nope", out, seriesDir), /unknown style/);

  const { transport: t2, calls: c2 } = mockTransport();
  await runConsistency(new MuseImage({ apiKey: "mock", transport: t2 }), loadProfile("sao-la"), mkdtempSync(join(tmpdir(), "hoisau-")), { model: "mock", mock: true, style: styleText(locked), styleRef: ref });
  assert.equal(c2[0].input[0].content[1].image_url, ref, "the style reference rides with the sheet");
  assert.equal(typeof c2[1].input, "string", "later turns chain instead of re-sending it");
  assert.match(c2[0].input[0].content[0].text, /Hanoi office and street details/);
});

test("mock images draw the staged characters from their portraits", async () => {
  const { loadMockCast, sceneFromPrompt } = await import("./mock-art.js");
  const cast = loadMockCast();
  assert.deepEqual(cast.map((c) => c.name).sort(), ["Bino", "Lolo", "Pango", "Poppy", "Rico", "Uni"]);
  const scene = sceneFromPrompt("medium shot, eye level. Lolo (slow loris (cu li)) on the left, x. Poppy (pufferfish (cá nóc)) on the right, y.", cast, 1);
  assert.deepEqual(scene.places.map((p) => [p.cast.name, p.position]), [["Lolo", "left"], ["Poppy", "right"]]);
  assert.equal(sceneFromPrompt("An original character sheet for a comic series. " + cast[0].description, cast, 2).kind, "sheet");
});

test("sizes the API refuses map to the nearest it takes, and the image comes back as PNG cropped to the asked size", async () => {
  const { apiSize, normalizeImage } = await import("./muse-image.js");
  assert.equal(apiSize("1024x1280"), "1024x1536");
  assert.equal(apiSize("1536x1024"), "1536x1024");
  assert.equal(apiSize("1080x1080"), "1024x1024");
  const sharp = (await import("sharp")).default;
  const webp = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#f7d774" } }).webp().toBuffer();
  const png = await normalizeImage(webp, "1024x1280");
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["png", 1024, 1280]);
  // Muse draws at about 2.5 MP; the crop keeps that resolution instead of shrinking to the request.
  const big = await sharp({ create: { width: 1280, height: 1920, channels: 3, background: "#f7d774" } }).webp().toBuffer();
  const kept = await sharp(await normalizeImage(big, "1024x1280")).metadata();
  assert.deepEqual([kept.width, kept.height], [1280, 1600]);
});

test("a prompt the content filter refuses is retried once with gentler wording", async () => {
  const { generateSoftly, MuseImageError, softenPrompt } = await import("./muse-image.js");
  assert.match(softenPrompt("fully inflated spiky ball, tiny fins shaking"), /^A gentle, wholesome[^]*puffed-up ball, tiny fins flustered/);
  const prompts: string[] = [];
  const client = {
    generate: async (t: { prompt: string }) => {
      prompts.push(t.prompt);
      if (prompts.length === 1) throw new MuseImageError("Muse Image 400: The response was filtered due to the prompt triggering our content management policy", 400, true);
      return { id: "r2", image: Buffer.from(""), note: "", usage: {} };
    },
  };
  assert.equal((await generateSoftly(client, { prompt: "angry pufferfish" })).id, "r2");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /flustered pufferfish/);
  // Other errors are not retried.
  const failing = { generate: async () => { throw new MuseImageError("Muse Image 401: bad key", 401); } };
  await assert.rejects(generateSoftly(failing, { prompt: "x" }), /401/);
});

test("exaggerated poses are softened on retry, and a refused pose sheet is skipped", async () => {
  const { MuseImageError, softenPrompt } = await import("./muse-image.js");
  const { POSES } = await import("./prompts.js");
  const soft = softenPrompt(POSES.join("; "));
  for (const word of ["melting", "squashed", "despair", "tears streaming", "anger vein", "jaw dropped"]) assert.doesNotMatch(soft, new RegExp(word, "i"));
  const ids: string[] = [];
  const client = {
    generate: async (t: { prompt: string }) => {
      if (/pose sheet/.test(t.prompt)) throw new MuseImageError("filtered", 400, true);
      ids.push(`r${ids.length + 1}`);
      return { id: ids.at(-1)!, image: Buffer.from(""), note: "", usage: {} };
    },
  };
  const out = mkdtempSync(join(tmpdir(), "hoisau-"));
  const run = await runConsistency(client as never, loadProfile("sao-la"), out, { model: "mock", mock: true });
  assert.deepEqual(run.images.map((i) => i.id), ["sheet", "desk", "meeting", "gag"]);
  assert.equal(run.images[1].previousResponseId, run.images[0].responseId);
});

test("the office floor plan seats every character once and reaches the prompts", async () => {
  const { loadOffice, officeBrief, officePanelText, officePlanSvg } = await import("./office.js");
  const office = loadOffice()!;
  assert.ok(office, "series/office.yaml exists");
  const seated = office.desks.map((d) => d.character).sort();
  assert.deepEqual(seated, ["ca-noc", "chon-bac-ma", "cu-li", "sao-la", "te-te"]);
  assert.match(officeBrief(office), /Lolo's desk/);
  const text = officePanelText(office, ["cu-li"]);
  assert.match(text, /pothos/);
  assert.doesNotMatch(text, /Poppy's desk/, "only the seats of characters on stage");
  assert.match(text, /small animal coworkers sitting and working/);
  const svg = officePlanSvg(office, { "cu-li": "Lolo" });
  assert.match(svg, />Lolo</);
});

test("brand art: an avatar and a Facebook-size cover for every brand, offline", async () => {
  const { loadBrandList, makeBrandArt, coverPrompt, avatarPrompt, COVER_SIZE, SOCIAL_SIZES } = await import("./brand-art.js");
  const { openStudio } = await import("./studio.js");
  const { imageSize } = await import("@hoi-sau/svg-text");
  const ctx = openStudio({ mock: true });
  const brands = loadBrandList();
  assert.ok(brands.some((b) => b.id === "hoi-sau") && brands.some((b) => b.character === "cu-li"));
  const series = coverPrompt(ctx, brands.find((b) => b.id === "hoi-sau")!);
  assert.match(series, /zebra crossing/);
  assert.match(series, /Bino[\s\S]*Pango[\s\S]*Poppy[\s\S]*Lolo[\s\S]*Uni[\s\S]*Rico/, "walk order front to back, the director leads");
  assert.match(series, /Bino \(.*?\) leading the line at the far right/);
  assert.match(series, /full length with their feet/);
  assert.match(series, /none sitting at a desk/);
  const avatar = avatarPrompt(ctx, brands.find((b) => b.id === "hoi-sau")!);
  assert.match(avatar, /^Lolo \(.*alone, a big close-up/);
  assert.match(avatar, /Nobody else/);
  // Characters added later join the parade: the cover follows the cast, not a fixed four.
  assert.match(series, new RegExp(`Exactly ${["", "one", "two", "three", "four", "five", "six", "seven"][ctx.profiles.size]} main characters`));
  for (const p of ctx.profiles.values()) assert.ok(series.includes(`${p.name} (`), p.name);
  assert.match(coverPrompt(ctx, brands.find((b) => b.id === "lolo")!), /Lolo \(.*\) walks across it alone/);
  const out = mkdtempSync(join(tmpdir(), "brand-art-"));
  const { art } = await makeBrandArt(ctx, brands.filter((b) => ["hoi-sau", "lolo"].includes(b.id)), out);
  assert.equal(art.length, 2);
  for (const a of art) {
    assert.deepEqual(imageSize(readFileSync(a.cover)), { ...COVER_SIZE, mime: "image/png" });
    assert.deepEqual(imageSize(readFileSync(a.avatar)), { width: 1024, height: 1024, mime: "image/png" });
    assert.ok(existsSync(a.coverTitle));
    const dir = dirname(a.cover);
    for (const [network, sizes] of Object.entries(SOCIAL_SIZES)) {
      assert.deepEqual(imageSize(readFileSync(join(dir, "social", network, "avatar.png"))), { ...sizes.avatar, mime: "image/png" }, network);
      if ("cover" in sizes) assert.deepEqual(imageSize(readFileSync(join(dir, "social", network, "cover.png"))), { ...sizes.cover, mime: "image/png" });
    }
  }
  // Only the cover again, cropped from the saved drawing without asking Muse.
  const before = readFileSync(art[0].avatar);
  const again = await makeBrandArt(ctx, brands.filter((b) => b.id === "hoi-sau"), out, () => {}, { only: "cover", recrop: true });
  assert.equal(again.usage.length, 0);
  assert.deepEqual(readFileSync(art[0].avatar), before);
});

test("brand art: the cover crop keeps the cast's feet, even under a colourful top", async () => {
  const { coverCrop, COVER_SIZE } = await import("./brand-art.js");
  const sharp = (await import("sharp")).default;
  // Like a real drawing: orange roofs through the windows at the top, the cast lower down,
  // red shoes at 80% of the height, then grey floor with white zebra stripes.
  const w = 1920, h = 1280;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#d8d6d0"/>
    <rect y="0" width="${w}" height="380" fill="#e07a3a"/>
    <rect x="300" y="620" width="1300" height="380" fill="#3a8ee0"/>
    <rect x="300" y="1000" width="1300" height="24" fill="#e0202a"/>
    <rect y="1060" width="${w}" height="40" fill="#ffffff"/><rect y="1160" width="${w}" height="40" fill="#ffffff"/></svg>`;
  const img = await sharp(Buffer.from(svg)).png().toBuffer();
  for (const size of [COVER_SIZE, { width: 1500, height: 500 }]) {
    const out = await coverCrop(img, size);
    const meta = await sharp(out).metadata();
    assert.deepEqual([meta.width, meta.height], [size.width, size.height]);
    // The shoes (y 1000-1024 of 1280) are inside, above the bottom edge.
    const scale = size.width / w;
    const raw = await sharp(out).removeAlpha().raw().toBuffer();
    const redRows = [];
    for (let y = 0; y < size.height; y++) {
      const i = (y * size.width + Math.round(900 * scale)) * 3;
      if (raw[i] > 200 && raw[i + 1] < 80) redRows.push(y);
    }
    assert.ok(redRows.length > 0, `shoes inside the ${size.width}x${size.height} crop`);
    assert.ok(size.height - redRows[redRows.length - 1] > 10, "floor below the shoes");
  }
});

test("edge art: one picture per character of its secret side, offline", async () => {
  const { makeEdgeArt, edgePrompt, EDGE_SIZE } = await import("./edge-art.js");
  const { openStudio } = await import("./studio.js");
  const { imageSize } = await import("@hoi-sau/svg-text");
  const ctx = openStudio({ mock: true });
  for (const slug of listCharacters()) {
    const p = loadProfile(slug);
    assert.ok(p.edge, `${slug} has an edge`);
    assert.ok(edgePrompt(ctx, slug).includes(p.look.expressions.edge!), `${slug} prompt draws its edge`);
    assert.match(edgePrompt(ctx, slug), /No text/);
  }
  const out = mkdtempSync(join(tmpdir(), "edge-"));
  const { files } = await makeEdgeArt(ctx, ["cu-li", "chon-bac-ma"], out);
  assert.equal(files.length, 2);
  for (const f of files) assert.deepEqual(imageSize(readFileSync(f)), { ...EDGE_SIZE, mime: "image/png" });
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /Rico/);
  await makeEdgeArt(ctx, ["te-te"], out);
  const page = readFileSync(join(out, "index.html"), "utf8");
  assert.ok(/Rico/.test(page) && /Pango/.test(page), "redrawing one keeps the others on the page");
});
