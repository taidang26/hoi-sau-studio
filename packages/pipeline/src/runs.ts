/**
 * data/pipeline/runs.json: one record per daily run, rewritten after every
 * stage so the dashboard can show a run while it is going. Newest first.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Format, Platform } from "@hoi-sau/channel";
import type { Direction } from "./direction.js";

export const STAGES = ["listen", "direction", "studio", "motion", "package", "upload", "publish"] as const;
export type Stage = (typeof STAGES)[number];

export type StageStatus = "running" | "done" | "warn" | "skipped" | "failed";

export interface StageRecord {
  name: Stage;
  status: StageStatus;
  startedAt: string;
  finishedAt?: string;
  /** Short Vietnamese note for the dashboard. */
  note?: string;
  error?: string;
}

export interface PostRecord {
  platform: Platform;
  format: Format;
  status: "published" | "failed" | "skipped";
  postId?: string;
  permalink?: string;
  error?: string;
}

export interface Run {
  /** Hanoi date of the run, plus "-2", "-3"… for forced reruns that day. */
  id: string;
  date: string;
  mode: "mock" | "live";
  status: "running" | "done" | "partial" | "failed";
  startedAt: string;
  finishedAt?: string;
  episodeId?: string;
  direction?: Direction;
  stages: StageRecord[];
  posts: PostRecord[];
  /** Relative to the episodes folder. */
  video?: string;
  cover?: string;
  error?: string;
}

export const pipelineDir = (dataDir: string) => join(dataDir, "pipeline");
export const runsPath = (dataDir: string) => join(pipelineDir(dataDir), "runs.json");

export function loadRuns(dataDir: string): Run[] {
  const f = runsPath(dataDir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Run[]) : [];
}

export function saveRun(dataDir: string, run: Run): void {
  const f = runsPath(dataDir);
  mkdirSync(dirname(f), { recursive: true });
  const all = loadRuns(dataDir).filter((r) => r.id !== run.id);
  all.unshift(run);
  all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  writeFileSync(`${f}.tmp`, JSON.stringify(all.slice(0, 200), null, 2) + "\n");
  renameSync(`${f}.tmp`, f);
}

/** Comment IDs already turned into an episode. */
export const usedComments = (runs: Run[]) =>
  new Set(runs.filter((r) => r.episodeId && r.status !== "failed").flatMap((r) => r.direction?.commentIds ?? []));

const LOCK_STALE_MS = 3 * 3600_000;

/**
 * One run at a time: a lock file with the PID and start time. A lock older
 * than three hours is treated as left over from a crash.
 */
export function acquireLock(dataDir: string, now = new Date()): () => void {
  const f = join(pipelineDir(dataDir), "lock");
  mkdirSync(dirname(f), { recursive: true });
  if (existsSync(f)) {
    const held = JSON.parse(readFileSync(f, "utf8")) as { pid: number; at: string };
    if (now.getTime() - Date.parse(held.at) < LOCK_STALE_MS) {
      throw new Error(`Another run (pid ${held.pid}) started at ${held.at} is still going. Delete ${f} if it crashed.`);
    }
  }
  writeFileSync(f, JSON.stringify({ pid: process.pid, at: now.toISOString() }));
  return () => rmSync(f, { force: true });
}
