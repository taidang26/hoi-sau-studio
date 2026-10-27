/**
 * Wiring shared by the CLI and the dashboard: open a Studio context (real or
 * mock clients, bible, profiles), lock a model sheet, and write episode
 * memory back into profiles without losing their comments.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import { loadBible, saveBible, SERIES_DIR } from "./bible.js";
import type { StudioContext } from "./episode.js";
import { mockSparkTransport, mockTransport } from "./mock.js";
import { MuseImage } from "./muse-image.js";
import { MuseSpark } from "./muse-spark.js";
import { CHARACTERS_DIR, listCharacters, loadProfile, type Profile } from "./profile.js";
import { loadOffice } from "./office.js";
import { loadStyle } from "./style.js";

export interface OpenOptions {
  mock?: boolean;
  env?: NodeJS.ProcessEnv;
  charactersDir?: string;
  seriesDir?: string;
  episodesDir?: string;
  log?: (s: string) => void;
}

export function loadProfiles(dir = CHARACTERS_DIR): Map<string, Profile> {
  return new Map(listCharacters(dir).map((s) => [s, loadProfile(s, dir)]));
}

export function openStudio(opts: OpenOptions = {}): StudioContext {
  const env = opts.env ?? process.env;
  const mock = opts.mock ?? env.MUSE_MOCK === "1";
  const charactersDir = opts.charactersDir ?? CHARACTERS_DIR;
  const seriesDir = opts.seriesDir ?? SERIES_DIR;
  return {
    spark: mock ? new MuseSpark({ apiKey: "mock", transport: mockSparkTransport().transport }) : MuseSpark.fromEnv(env),
    image: mock ? new MuseImage({ apiKey: "mock", transport: mockTransport({ charactersDir }).transport }) : MuseImage.fromEnv(env),
    bible: loadBible(seriesDir),
    style: loadStyle(seriesDir),
    office: loadOffice(seriesDir),
    profiles: loadProfiles(charactersDir),
    dir: opts.episodesDir,
    charactersDir,
    seriesDir,
    log: opts.log,
    saveBible: (b) => saveBible(b, seriesDir),
    saveMemory: (slug, facts, episode) => rememberEpisode(slug, episode, facts, charactersDir),
  };
}

/**
 * Append { episode, facts } to memory.episodes in profile.yaml. Profiles are
 * hand-written, so only the `memory:` block at the end is rewritten and the
 * rest of the file keeps its layout and comments.
 */
export function rememberEpisode(slug: string, episode: string, facts: string[], dir = CHARACTERS_DIR): void {
  const file = join(dir, slug, "profile.yaml");
  const text = readFileSync(file, "utf8");
  const list = ((parse(text) as Profile).memory?.episodes ?? []) as Array<{ episode?: string }>;
  const memory = stringify({ memory: { episodes: [...list.filter((e) => e?.episode !== episode), { episode, facts }] } }, { lineWidth: 0 });
  const at = text.search(/^memory:/m);
  if (at >= 0 && !/^\S/m.test(text.slice(at).split("\n").slice(1).join("\n"))) writeFileSync(file, text.slice(0, at) + memory);
  else {
    const doc = parseDocument(text);
    doc.set("memory", doc.createNode(parse(memory).memory));
    writeFileSync(file, doc.toString());
  }
  loadProfile(slug, dir);
}

/**
 * Lock the approved character sheet from a consistency run as the model sheet
 * every panel is drawn against: characters/<slug>/model-sheet.<ext>.
 */
export function approveSheet(slug: string, runDir: string, dir = CHARACTERS_DIR): string {
  const find = (id: string) => (existsSync(runDir) ? readdirSync(runDir).find((f) => new RegExp(`^${id}\\.(png|jpe?g|webp)$`).test(f)) : undefined);
  const src = find("sheet");
  if (!src) throw new Error(`no sheet image in ${runDir}; run \`studio sheet ${slug}\` first`);
  const name = `model-sheet${extname(src)}`;
  copyFileSync(join(runDir, src), join(dir, slug, name));
  setLook(slug, "character_sheet", name, "every panel is drawn against it", dir);
  // Runs from before pose sheets existed have none; the profile then keeps pose_sheet unset.
  const poses = find("poses");
  if (poses) {
    const poseName = `pose-sheet${extname(poses)}`;
    copyFileSync(join(runDir, poses), join(dir, slug, poseName));
    setLook(slug, "pose_sheet", poseName, "six reusable poses, attached with the model sheet", dir);
  }
  loadProfile(slug, dir);
  return name;
}

/** Set look.<key> in a hand-written profile, keeping the rest of the file as written. */
function setLook(slug: string, key: string, value: string, note: string, dir: string): void {
  const file = join(dir, slug, "profile.yaml");
  const text = readFileSync(file, "utf8");
  const line = `  ${key}: ${value}   # locked with \`studio sheet approve\`; ${note}`;
  const re = new RegExp(`^  ${key}:.*$`, "m");
  if (re.test(text)) return writeFileSync(file, text.replace(re, line));
  // Not there yet: add it right after character_sheet, inside look.
  if (key !== "character_sheet" && /^  character_sheet:.*$/m.test(text)) return writeFileSync(file, text.replace(/^(  character_sheet:.*)$/m, `$1\n${line}`));
  const doc = parseDocument(text);
  doc.setIn(["look", key], value);
  writeFileSync(file, doc.toString());
}
