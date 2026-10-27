/**
 * Where every episode came from and who touched it: episodes/<id>/provenance.json.
 *
 * The first entry says where the idea came from (audience comments picked by
 * listening, an editor's pick, or typed by hand, and by whom). Every step the
 * pipeline writes adds an entry with the SHA-256 of what it wrote, so a step
 * file edited by hand afterwards, or committed by someone else, no longer
 * matches its entry and shows up at approval.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { sha256 } from "@hoi-sau/channel";

export interface EpisodeSource {
  /** audience: the top idea from comments; editor: picked on the dashboard; manual: typed in. */
  kind: "audience" | "editor" | "season" | "manual";
  /** Who started it: the OS user, or HOISAU_EDITOR when set. */
  by: string;
  /** Comments the direction came from. */
  commentIds?: string[];
  /** The listen report it came from. */
  report?: string;
}

export interface ProvenanceEntry {
  at: string;
  /** "created", a step name, "approved". */
  event: string;
  /** SHA-256 of the file written, for steps. */
  sha256?: string;
  by?: string;
  source?: EpisodeSource;
  detail?: string;
}

export const PROVENANCE_FILE = "provenance.jsonl";

export const whoAmI = () => process.env.HOISAU_EDITOR || (() => { try { return userInfo().username; } catch { return "unknown"; } })();

/** One JSON object per line, append only. */
export function logProvenance(episodeDir: string, entry: Omit<ProvenanceEntry, "at">, now = new Date()): void {
  appendFileSync(join(episodeDir, PROVENANCE_FILE), JSON.stringify({ at: now.toISOString(), ...entry }) + "\n");
}

export function readProvenance(episodeDir: string): ProvenanceEntry[] {
  const f = join(episodeDir, PROVENANCE_FILE);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ProvenanceEntry);
}

/** Step files that differ from what the pipeline last wrote, or that it never wrote. */
export function editedSteps(episodeDir: string, steps: readonly string[]): string[] {
  const log = readProvenance(episodeDir);
  return steps.filter((s) => {
    const f = join(episodeDir, `${s}.json`);
    if (!existsSync(f)) return false;
    const last = log.filter((e) => e.event === s).at(-1);
    return !last || last.sha256 !== sha256(readFileSync(f));
  });
}
