import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BRANDS_FILE } from "@hoi-sau/channel";
import { DEMO, demoGraph } from "@hoi-sau/channel/dist/demo.js";
import { demoTikTok, TIKTOK_DEMO } from "@hoi-sau/channel/dist/tiktok-demo.js";
import { CHARACTERS_DIR, loadProfile } from "@hoi-sau/studio";
import { Accounts } from "./accounts.js";
import { writeDemoData } from "./seed.js";
import { startDashboard } from "./server.js";

const root = mkdtempSync(join(tmpdir(), "hoisau-friendly-"));
const dataDir = join(root, "data");
const charactersDir = join(root, "characters");
const brandsFile = join(root, "channels.yaml");
const envFile = join(root, ".env");
const SET = ["META_APP_ID", "META_APP_SECRET", "FB_PAGE_ID", "FB_PAGE_TOKEN", "IG_USER_ID", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI", "TIKTOK_TOKEN", "TIKTOK_TOKEN_EXPIRES", "TIKTOK_TOKEN_REFRESH", "TIKTOK_TOKEN_REFRESH_EXPIRES", "TIKTOK_OPEN_ID", "TIKTOK_NAME"];
const saved = Object.fromEntries(SET.map((k) => [k, process.env[k]]));
let base = "";
let close = () => {};
let accounts: Accounts;

const post = (path: string, form: Record<string, string | string[]> = {}, headers: Record<string, string> = {}) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) for (const x of [v].flat()) body.append(k, x);
  return fetch(base + path, { method: "POST", body, redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
};
const note = (res: Response) => decodeURIComponent(res.headers.get("location") ?? "");

before(async () => {
  for (const k of SET) delete process.env[k];
  writeDemoData(dataDir);
  cpSync(CHARACTERS_DIR, charactersDir, { recursive: true });
  cpSync(BRANDS_FILE, brandsFile);
  writeFileSync(envFile, "# keep me\nOTHER=1\n");
  accounts = new Accounts({ envFile, dataDir, brandsFile, fetch: demoGraph().fetch, tiktokFetch: demoTikTok().fetch });
  const server = await startDashboard(
    { dataDir, runsDir: join(root, "runs"), charactersDir, brandsFile, accounts, channel: () => ({ facebook: false, instagram: false, mock: false }) },
    0,
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => {
  close();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

test("no commands, setting names or file names on any page", async () => {
  for (const path of ["/", "/channels", "/channels/lolo", "/characters", "/characters/cu-li", "/characters/new", "/characters/cu-li/edit", "/inbox", "/comments", "/episodes", "/automation", "/settings"]) {
    const html = (await (await fetch(base + path)).text()).replace(/<(textarea|script)[\s\S]*?<\/\1>/g, "").replace(/name="[A-Z_]+"/g, "");
    assert.doesNotMatch(html, /npm run|\.env\b|channels\.yaml|profile\.yaml|FB_PAGE_|IG_USER_ID|THREADS_TOKEN|META_GRAPH_MOCK/, path);
  }
});

test("language switch: a cookie, then the same page in English", async () => {
  const res = await fetch(base + "/lang/en?back=/channels", { redirect: "manual" });
  assert.equal(res.headers.get("location"), "/channels");
  assert.match(res.headers.get("set-cookie") ?? "", /lang=en/);
  const en = await (await fetch(base + "/channels", { headers: { cookie: "lang=en" } })).text();
  assert.match(en, /<html lang="en">/);
  assert.match(en, />Channels</);
  assert.match(await (await fetch(base + "/channels")).text(), />Kênh</);
  // Never sends anyone to another site.
  assert.equal((await fetch(base + "/lang/vi?back=//evil.example", { redirect: "manual" })).headers.get("location"), "/");
});

test("settings are saved to .env, shown only as set or missing", async () => {
  const res = await post("/settings", { META_APP_ID: "123456", META_APP_SECRET: "s3cret", META_API_KEY: "" });
  assert.match(note(res), /ok=Đã lưu 2 mục/);
  const env = readFileSync(envFile, "utf8");
  assert.match(env, /^# keep me$/m);
  assert.match(env, /^META_APP_ID=123456$/m);
  assert.match(env, /^META_APP_SECRET=s3cret$/m);
  const page = await (await fetch(base + "/settings")).text();
  assert.doesNotMatch(page, /s3cret|123456/);
  assert.equal((page.match(/pill ok/g) ?? []).length, 2);
});

test("Connect Facebook: login in the browser, the Page and its Instagram are saved", async () => {
  const start = await fetch(base + "/connect/facebook?brand=hoi-sau", { redirect: "manual" });
  const dialog = new URL(start.headers.get("location")!);
  assert.equal(dialog.host, "www.facebook.com");
  assert.equal(dialog.searchParams.get("client_id"), "123456");
  assert.match(dialog.searchParams.get("redirect_uri")!, /\/connect\/facebook\/callback$/);
  const back = await fetch(`${base}/connect/facebook/callback?code=abc&state=${dialog.searchParams.get("state")}`, { redirect: "manual" });
  assert.match(note(back), /^\/channels\/hoi-sau\?ok=Đã kết nối Trang .* và Instagram @/);
  const env = readFileSync(envFile, "utf8");
  assert.match(env, new RegExp(`^FB_PAGE_ID=${DEMO.pageId}$`, "m"));
  assert.match(env, new RegExp(`^IG_USER_ID=${DEMO.igUserId}$`, "m"));
  // A replayed or forged callback is refused.
  assert.match(note(await fetch(`${base}/connect/facebook/callback?code=abc&state=nope`, { redirect: "manual" })), /err=Phiên đăng nhập đã hết hạn/);
  // Connected now, so comments and messages can be pulled with a button.
  const comments = await post("/comments/refresh", {}, { referer: base + "/comments" });
  assert.match(note(comments), /^\/comments\?ok=\d+ bình luận mới/);
});

test("pause and turn on a channel; channels.yaml keeps its comments", async () => {
  assert.match(note(await post("/channels/lolo/threads/status", { status: "live" })), /ok=Đã bật kênh/);
  const yaml = readFileSync(brandsFile, "utf8");
  assert.match(yaml, /^# Where each episode is posted\./m);
  assert.equal(accounts.brands().find((b) => b.id === "lolo")!.channels.find((c) => c.platform === "threads")!.status, "live");
  await post("/channels/lolo/threads/status", { status: "paused" });
  assert.equal(accounts.brands().find((b) => b.id === "lolo")!.channels.find((c) => c.platform === "threads")!.status, "paused");
});

test("edit a character in place, keeping the file's comments", async () => {
  const before = loadProfile("cu-li", charactersDir);
  const form = {
    name: "Lolo Mới",
    species: before.species,
    status: "active",
    role: before.role,
    office_type: before.office_type,
    core_gag: before.core_gag,
    description: before.look.description,
    signature: before.look.signature.join("\n"),
    props: before.look.props.join("\n"),
    swatch_hex: [...before.look.palette.map((s) => s.hex), "#123456"],
    swatch_name: [...before.look.palette.map((s) => s.name), ""],
    personality: before.personality.join("\n"),
    catchphrases: before.voice.catchphrases.join("\n"),
    never_says: before.never_says.join("\n"),
    want: "",
    fear: before.fear!,
    contradiction: before.contradiction!,
    comic_engine: before.comic_engine!.join("\n"),
    life: before.life!.join("\n"),
  };
  assert.match(note(await post("/characters/cu-li/edit", form)), /^\/characters\/cu-li\?ok=/);
  const after = loadProfile("cu-li", charactersDir);
  assert.equal(after.name, "Lolo Mới");
  assert.equal(after.status, "active");
  assert.equal(after.want, undefined);
  assert.deepEqual(after.look.palette, before.look.palette, "an unnamed swatch is dropped");
  assert.deepEqual(after.look.expressions, before.look.expressions, "fields not on the form are kept");
  assert.match(readFileSync(join(charactersDir, "cu-li", "profile.yaml"), "utf8"), /^# One of four characters/m);
  // A broken form says what is missing and writes nothing.
  const bad = await post("/characters/cu-li/edit", { ...form, signature: "one", name: "X" });
  assert.match(note(bad), /err=.*ít nhất 2 nét nhận diện/);
  assert.equal(loadProfile("cu-li", charactersDir).name, "Lolo Mới");
});

test("a Vietnamese name shows in Vietnamese, the global name in English", async () => {
  const p = loadProfile("ca-noc", charactersDir);
  const form = {
    name_vi: "Bống",
    name: p.name,
    species: p.species,
    status: p.status,
    role: p.role,
    office_type: p.office_type,
    core_gag: p.core_gag,
    description: p.look.description,
    signature: p.look.signature.join("\n"),
    props: p.look.props.join("\n"),
    swatch_hex: p.look.palette.map((s) => s.hex),
    swatch_name: p.look.palette.map((s) => s.name),
    personality: p.personality.join("\n"),
    catchphrases: p.voice.catchphrases.join("\n"),
    never_says: p.never_says.join("\n"),
    want: p.want ?? "",
    fear: p.fear ?? "",
    contradiction: p.contradiction ?? "",
    comic_engine: (p.comic_engine ?? []).join("\n"),
    life: (p.life ?? []).join("\n"),
  };
  assert.match(note(await post("/characters/ca-noc/edit", form)), /^\/characters\/ca-noc\?ok=/);
  assert.match(readFileSync(join(charactersDir, "ca-noc", "profile.yaml"), "utf8"), /^name: Poppy\nname_vi: Bống$/m);
  assert.match(await (await fetch(base + "/characters/ca-noc")).text(), /<h1>Bống<\/h1>/);
  assert.match(await (await fetch(base + "/characters/ca-noc", { headers: { cookie: "lang=en" } })).text(), /<h1>Poppy<\/h1>/);
});

test("create a character by hand, without the AI", async () => {
  const res = await post("/characters/new/manual", {
    name: "Gibbo",
    species: "vượn má trắng",
    role: "Designer",
    office_type: "Trễ đúng 5 phút",
    core_gag: "Lý do nào cũng thuyết phục",
    description: "A white-cheeked gibbon in a grey hoodie",
    signature: "white cheeks\nlong arms",
    swatch_hex: "#333333",
    swatch_name: "fur",
    personality: "a\nb\nc",
    catchphrases: "Em tới liền",
    never_says: "x\ny\nz",
  });
  assert.match(note(res), /^\/characters\/vuon-ma-trang\?ok=/);
  const p = loadProfile("vuon-ma-trang", charactersDir);
  assert.equal(p.name, "Gibbo");
  assert.equal(p.look.character_sheet, null);
  assert.match(await (await fetch(base + "/characters/vuon-ma-trang")).text(), /Gibbo/);
  // It shows up on the Kênh page at once, with its accounts still to connect.
  const channels = await (await fetch(base + "/channels")).text();
  assert.match(channels, /href="\/channels\/gibbo"/);
  assert.match(readFileSync(brandsFile, "utf8"), /character: vuon-ma-trang/);
});

test("TikTok: connect through the site's forwarding page, then send a video from the site to drafts", async () => {
  const first = await fetch(`${base}/connect/tiktok?brand=hoi-sau`, { redirect: "manual" });
  assert.match(note(first), /TikTok/);
  assert.match(note(first), /^\/settings\?err=/);
  await post("/settings", { TIKTOK_CLIENT_KEY: "ck", TIKTOK_CLIENT_SECRET: "cs" });

  const port = new URL(base).port;
  const login = new URL((await fetch(`${base}/connect/tiktok?brand=hoi-sau`, { redirect: "manual" })).headers.get("location")!);
  assert.equal(login.host, "www.tiktok.com");
  assert.equal(login.searchParams.get("redirect_uri"), "https://hoisau.dangtrantai.com/tiktok-callback");
  const state = login.searchParams.get("state")!;
  assert.ok(state.startsWith(`p${port}.`));

  const done = await fetch(`${base}/connect/tiktok/callback?code=c0de&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  assert.match(note(done), /ok=Đã kết nối TikTok Hồi Sau/);
  const env = readFileSync(envFile, "utf8");
  assert.match(env, /^TIKTOK_OPEN_ID=demo-open-id$/m);
  assert.match(env, /^TIKTOK_TOKEN_REFRESH=/m);
  assert.match(env, /^OTHER=1$/m);
  const page = await (await fetch(`${base}/channels/hoi-sau`)).text();
  assert.doesNotMatch(page, new RegExp(TIKTOK_DEMO.accessToken));

  const elsewhere = await post("/channels/hoi-sau/tiktok/draft", { url: "https://example.com/x.mp4" });
  assert.match(note(elsewhere), /err=/);
  const sent = await post("/channels/hoi-sau/tiktok/draft", { url: "https://hoisau.web.app/media/talk/lolo-01.mp4" });
  assert.match(note(sent), /ok=Đã gửi vào hộp nháp TikTok/);
});
