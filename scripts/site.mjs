#!/usr/bin/env node
// The public site on Firebase Hosting: landing and legal pages, plus the media
// Instagram and Threads fetch by URL when we publish.
//
//   npm run site -- add <episode-id>...   copy finished panels into site/public/media/<id>/ as JPEG
//   npm run site -- deploy                upload site/public to Firebase Hosting
//   npm run site -- urls <episode-id>     print the public URL of each file
//
// Only episodes you add go public, so an unreleased episode never has a URL.
// site/public/media/ is not committed: a deploy replaces what is online with
// this folder, so keep it on the machine that deploys.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MEDIA = join(ROOT, "site", "public", "media");

function mediaBase() {
  const env = join(ROOT, ".env");
  const line = existsSync(env) ? readFileSync(env, "utf8").match(/^\s*MEDIA_BASE_URL\s*=\s*(.+?)\s*$/m) : null;
  return (process.env.MEDIA_BASE_URL || line?.[1] || "https://hoisau.dangtrantai.com/media/").replace(/\/?$/, "/");
}

async function add(ids) {
  if (ids.length === 0) throw new Error("Name at least one episode, e.g. npm run site -- add lolo-test-001");
  for (const id of ids) {
    const final = join(ROOT, "episodes", id, "final");
    if (!existsSync(final)) throw new Error(`${final} does not exist. Finish the episode first.`);
    const out = join(MEDIA, id);
    mkdirSync(out, { recursive: true });
    for (const name of readdirSync(final)) {
      const src = join(final, name);
      // Instagram takes JPEG only, so every still becomes one.
      if (/\.(png|webp|jpe?g)$/i.test(name)) {
        await sharp(src).flatten({ background: "#ffffff" }).jpeg({ quality: 90, mozjpeg: true }).toFile(join(out, name.replace(/\.\w+$/, ".jpg")));
      } else if (/\.(mp4|mov)$/i.test(name)) {
        copyFileSync(src, join(out, name));
      }
    }
    urls([id]);
  }
  console.log("Now run: npm run site -- deploy");
}

function urls(ids) {
  for (const id of ids) {
    const dir = join(MEDIA, id);
    if (!existsSync(dir)) throw new Error(`${id} is not on the site yet. Run: npm run site -- add ${id}`);
    for (const f of readdirSync(dir)) console.log(`${mediaBase()}${id}/${f}`);
  }
}

function deploy() {
  const res = spawnSync("firebase", ["deploy", "--only", "hosting"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  process.exit(res.status ?? 1);
}

const [cmd, ...args] = process.argv.slice(2);
const commands = { add: () => add(args), urls: () => urls(args), deploy };
if (!commands[cmd]) {
  console.log("Usage: npm run site -- add <episode-id>... | deploy | urls <episode-id>...");
  process.exit(cmd ? 1 : 0);
}
try {
  await commands[cmd]();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
