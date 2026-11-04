/**
 * House rules: the owner's standing instructions ("caption ngắn", "không ghi nguồn",
 * "bối cảnh mặc định là văn phòng"…). They used to live only in chat; now they sit in
 * series/house-rules.json, the dashboard edits them, and every writer, planner and fixer
 * prompt reads them, so a rule said once applies to every post after it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SERIES_DIR } from "./bible.js";

export const RULE_AREAS = ["caption", "art", "dialogue", "video", "post"] as const;
export type RuleArea = (typeof RULE_AREAS)[number];

export interface HouseRule {
  id: string;
  area: RuleArea;
  /** The rule in the owner's own words (Vietnamese). */
  text: string;
  /** When it was added. */
  at: string;
  /** Where it came from, e.g. a video's "Sửa bằng lời" note. */
  from?: string;
}

/** HOISAU_RULES_FILE, else series/house-rules.json. The dashboard sets the variable for the CLIs it runs. */
export const houseRulesFile = (): string => process.env.HOISAU_RULES_FILE || join(SERIES_DIR, "house-rules.json");

export function loadHouseRules(file = houseRulesFile()): HouseRule[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { rules?: HouseRule[] };
    return (raw.rules ?? []).filter((r) => r && typeof r.text === "string" && r.text.trim() && (RULE_AREAS as readonly string[]).includes(r.area));
  } catch {
    return [];
  }
}

export function saveHouseRules(rules: HouseRule[], file = houseRulesFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ rules }, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

export function addHouseRule(area: RuleArea, text: string, from?: string, file = houseRulesFile()): HouseRule {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!clean) throw new Error("Empty rule");
  if (!(RULE_AREAS as readonly string[]).includes(area)) throw new Error(`Unknown rule area ${area}`);
  const rules = loadHouseRules(file);
  const same = rules.find((r) => r.area === area && r.text.toLowerCase() === clean.toLowerCase());
  if (same) return same;
  const rule: HouseRule = { id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, area, text: clean, at: new Date().toISOString(), ...(from ? { from } : {}) };
  saveHouseRules([...rules, rule], file);
  return rule;
}

export function removeHouseRule(id: string, file = houseRulesFile()): void {
  saveHouseRules(
    loadHouseRules(file).filter((r) => r.id !== id),
    file,
  );
}

const AREA_EN: Record<RuleArea, string> = { caption: "Captions", art: "Pictures", dialogue: "Dialogue", video: "Video", post: "Posting" };

/** The rules for these areas as one prompt block, or "" when there are none. */
export function houseRulesPrompt(areas: readonly RuleArea[], file = houseRulesFile()): string {
  const rules = loadHouseRules(file).filter((r) => areas.includes(r.area));
  if (!rules.length) return "";
  const lines = areas.flatMap((a) => rules.filter((r) => r.area === a).map((r) => `- [${AREA_EN[a]}] ${r.text}`));
  return `House rules from the owner. Always follow them; they win over any style hint above:\n${lines.join("\n")}`;
}
