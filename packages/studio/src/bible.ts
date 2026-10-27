/**
 * Series bible: the world, tone and rules every episode obeys, the cast and
 * how they relate, the season arc, and canon: facts established on screen
 * that later episodes must not contradict. Lives in series/bible.yaml.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

export const SERIES_DIR = fileURLToPath(new URL("../../../series", import.meta.url));

export interface Relationship {
  a: string;
  b: string;
  /** Vietnamese, one line: how they get on and the comedy between them. */
  dynamic: string;
}

export interface CanonFact {
  /** Episode that established it. */
  episode: string;
  fact: string;
  characters: string[];
}

export interface SeriesBible {
  title: string;
  premise: string;
  tone: string;
  audience: string;
  world: { company: string; places: string[]; recurring_extras: string[] };
  /** Hard rules for every script. */
  rules: string[];
  format: { panels: { min: number; max: number }; aspect: string; ending: string };
  cast: string[];
  relationships: Relationship[];
  season: { arc: string; milestones: string[] };
  canon: CanonFact[];
}

export function loadBible(dir = SERIES_DIR): SeriesBible {
  const file = join(dir, "bible.yaml");
  if (!existsSync(file)) throw new Error(`no series bible at ${file}`);
  const b = parse(readFileSync(file, "utf8")) as SeriesBible;
  const missing = (["title", "premise", "tone", "world", "rules", "format", "cast", "relationships", "season", "canon"] as const).filter((k) => b[k] === undefined);
  if (missing.length) throw new Error(`series bible is missing: ${missing.join(", ")}`);
  return b;
}

/** Add facts from a finished episode. Duplicates (same text) are skipped. */
export function addCanon(bible: SeriesBible, facts: CanonFact[]): SeriesBible {
  const seen = new Set(bible.canon.map((f) => f.fact));
  return { ...bible, canon: [...bible.canon, ...facts.filter((f) => !seen.has(f.fact))] };
}

export function saveBible(bible: SeriesBible, dir = SERIES_DIR): void {
  writeFileSync(join(dir, "bible.yaml"), "# Series bible. Every Studio step reads it; `canon` grows as episodes are finished.\n" + stringify(bible, { lineWidth: 0 }));
}

/** The parts a writer needs, small enough to send with every step. */
export function bibleBrief(b: SeriesBible, characters: string[]): string {
  const rel = b.relationships.filter((r) => characters.includes(r.a) || characters.includes(r.b));
  const canon = b.canon.filter((f) => f.characters.some((c) => characters.includes(c))).slice(-20);
  return JSON.stringify({
    premise: b.premise,
    tone: b.tone,
    audience: b.audience,
    world: b.world,
    rules: b.rules,
    format: b.format,
    relationships: rel,
    season_arc: b.season.arc,
    canon,
  });
}
