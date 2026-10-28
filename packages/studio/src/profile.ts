/**
 * Character profiles: characters/<slug>/profile.yaml. Every Studio step reads
 * the same profile, so the look, voice and limits are written down once.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface Swatch {
  name: string;
  hex: string;
}

export interface Look {
  style: string;
  /** English, goes straight into Muse Image prompts. */
  description: string;
  /** Features that must never drift; self-review checks each one. */
  signature: string[];
  palette: Swatch[];
  props: string[];
  expressions: Record<string, string>;
  /** English: the core gag as one picture, used by the consistency test. */
  gag_scene?: string;
  /** One item readers know the character by at thumbnail size; drawn a little oversized in every panel. */
  icon?: string;
  character_sheet: string | null;
  /** Locked with the model sheet: six reusable full-body poses. */
  pose_sheet?: string | null;
}

export interface Profile {
  slug: string;
  /** The global name, used in English. */
  name: string;
  /** The name in Vietnamese posts and dialogue; falls back to `name`. */
  name_vi?: string;
  species: string;
  status: "candidate" | "active" | "retired";
  office_type: string;
  core_gag: string;
  role: string;
  /** What they want, what they fear, and the contradiction that makes them more than one gag. */
  want?: string;
  fear?: string;
  contradiction?: string;
  /** The rebellious or weird streak behind the good behaviour, kept for the twist. */
  edge?: string;
  /** Concrete details of their life outside the joke. */
  life?: string[];
  /** Repeatable situations that make them funny, tied to the animal's body. */
  comic_engine?: string[];
  relationships?: Array<{ with: string; dynamic: string }>;
  look: Look;
  personality: string[];
  voice: {
    register: string;
    speech_pattern: string;
    catchphrases: string[];
    sample_lines: string[];
    do?: string[];
    dont?: string[];
  };
  never_says: string[];
  memory: { episodes: unknown[] };
}

export const CHARACTERS_DIR = fileURLToPath(new URL("../../../characters", import.meta.url));

export class ProfileError extends Error {}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isStrList = (v: unknown, min = 1): v is string[] => Array.isArray(v) && v.length >= min && v.every(isStr);

/** Collect every problem at once, so a broken profile is fixed in one pass. */
/** The name to use in Vietnamese text. */
export const nameVi = (p: Pick<Profile, "name" | "name_vi">): string => p.name_vi?.trim() || p.name;

export function validateProfile(raw: unknown, slug?: string): Profile {
  const p = raw as Record<string, any>;
  const errors: string[] = [];
  const need = (ok: boolean, msg: string) => ok || errors.push(msg);

  if (!p || typeof p !== "object") throw new ProfileError("profile is not a YAML mapping");
  for (const k of ["slug", "name", "species", "office_type", "core_gag", "role"]) need(isStr(p[k]), `${k} is required`);
  need(p.name_vi === undefined || isStr(p.name_vi), "name_vi must be text when set");
  if (slug) need(p.slug === slug, `slug "${p.slug}" does not match folder "${slug}"`);
  need(["candidate", "active", "retired"].includes(p.status), "status must be candidate, active or retired");

  const look = p.look ?? {};
  need(isStr(look.style), "look.style is required");
  need(isStr(look.description), "look.description is required");
  need(isStrList(look.signature, 2), "look.signature needs at least 2 features");
  need(
    Array.isArray(look.palette) && look.palette.length > 0 && look.palette.every((s: any) => isStr(s?.name) && /^#[0-9a-f]{6}$/i.test(s?.hex)),
    "look.palette needs { name, hex: \"#RRGGBB\" } entries",
  );
  need(isStrList(look.props, 0), "look.props must be a list of strings");
  need(look.expressions && typeof look.expressions === "object" && isStr(look.expressions.default), "look.expressions.default is required");
  need(look.character_sheet === null || isStr(look.character_sheet), "look.character_sheet must be null or a path");
  need(look.icon === undefined || isStr(look.icon), "look.icon must be a phrase");
  need(look.gag_scene === undefined || isStr(look.gag_scene), "look.gag_scene must be a sentence");
  need(look.pose_sheet == null || isStr(look.pose_sheet), "look.pose_sheet must be null or a path");

  need(isStrList(p.personality, 3), "personality needs at least 3 traits");
  const voice = p.voice ?? {};
  need(isStr(voice.register) && isStr(voice.speech_pattern), "voice.register and voice.speech_pattern are required");
  need(isStrList(voice.catchphrases, 1) && isStrList(voice.sample_lines, 1), "voice needs catchphrases and sample_lines");
  need(isStrList(p.never_says, 3), "never_says needs at least 3 rules");

  // Depth fields are optional for older profiles, but checked when present.
  for (const k of ["want", "fear", "contradiction", "edge"]) need(p[k] === undefined || isStr(p[k]), `${k} must be a sentence`);
  for (const k of ["life", "comic_engine"]) need(p[k] === undefined || isStrList(p[k]), `${k} must be a list of strings`);
  need(
    p.relationships === undefined || (Array.isArray(p.relationships) && p.relationships.every((r: any) => isStr(r?.with) && isStr(r?.dynamic))),
    "relationships needs { with: slug, dynamic } entries",
  );
  for (const k of ["do", "dont"]) need(voice[k] === undefined || isStrList(voice[k]), `voice.${k} must be a list of strings`);
  need(Array.isArray(p.memory?.episodes), "memory.episodes must be a list");

  if (errors.length) throw new ProfileError(`${slug ?? p.slug ?? "profile"}: ${errors.join("; ")}`);
  return p as Profile;
}

export function loadProfile(slug: string, dir = CHARACTERS_DIR): Profile {
  const file = join(dir, slug, "profile.yaml");
  if (!existsSync(file)) throw new ProfileError(`no profile at ${file}`);
  return validateProfile(parse(readFileSync(file, "utf8")), slug);
}

export function listCharacters(dir = CHARACTERS_DIR): string[] {
  return readdirSync(resolve(dir), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "profile.yaml")))
    .map((d) => d.name)
    .sort();
}
