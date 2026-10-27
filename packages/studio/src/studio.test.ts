import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("all four test characters load and validate", () => {
  assert.deepEqual(listCharacters(), ["ca-noc", "cu-li", "sao-la", "te-te"]);
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
    tools: [{ type: "image_generation", size: "1024x1536" }],
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
  assert.match(run.images[1].prompt, /six full-body poses/);
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
  assert.deepEqual(cast.map((c) => c.name).sort(), ["Lolo", "Pango", "Poppy", "Uni"]);
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

test("the office floor plan seats every character once and reaches the prompts", async () => {
  const { loadOffice, officeBrief, officePanelText, officePlanSvg } = await import("./office.js");
  const office = loadOffice()!;
  assert.ok(office, "series/office.yaml exists");
  const seated = office.desks.map((d) => d.character).sort();
  assert.deepEqual(seated, ["ca-noc", "cu-li", "sao-la", "te-te"]);
  assert.match(officeBrief(office), /Lolo's desk/);
  const text = officePanelText(office, ["cu-li"]);
  assert.match(text, /pothos/);
  assert.doesNotMatch(text, /Poppy's desk/, "only the seats of characters on stage");
  assert.match(text, /small animal coworkers sitting and working/);
  const svg = officePlanSvg(office, { "cu-li": "Lolo" });
  assert.match(svg, />Lolo</);
});
