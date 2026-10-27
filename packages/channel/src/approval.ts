/**
 * The owner's sign-off on an episode, and the check `publish` runs against it.
 *
 * Approving records a SHA-256 of every file that makes the episode (premise,
 * script, safety check, lettered pages) and of what will be posted (caption
 * and media URLs). Publishing recomputes them: a file changed after approval,
 * by anyone, or a caption swapped in the post file, and the episode is
 * refused until it is approved again. The approval file lives next to the
 * episode in episodes/<id>/approval.json.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EpisodePost } from "./publish.js";

export interface Approval {
  episodeId: string;
  approvedBy: string;
  approvedAt: string;
  /** Path inside the episode folder → SHA-256 of its bytes at approval. */
  files: Record<string, string>;
  /** SHA-256 of what gets posted: caption, per-platform captions, media URLs. */
  post?: string;
  /** Warnings the approver saw and accepted. */
  notes?: string[];
}

export const APPROVAL_FILE = "approval.json";

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export function hashFiles(dir: string, files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(dir, f)))]));
}

/** Only the fields that reach the audience; order of keys does not matter. */
export function postHash(post: Pick<EpisodePost, "caption" | "captions" | "mediaUrls">): string {
  const captions = Object.fromEntries(Object.entries(post.captions ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return sha256(JSON.stringify({ caption: post.caption, captions, mediaUrls: post.mediaUrls }));
}

export function readApproval(dir: string): Approval | undefined {
  const f = join(dir, APPROVAL_FILE);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Approval) : undefined;
}

/** What stands between this post and publishing; empty means approved as it is now. */
export function approvalProblems(dir: string, post: EpisodePost): string[] {
  const a = readApproval(dir);
  if (!a) return [`${post.episodeId} has not been approved (run: npm run studio -- episode approve ${post.episodeId})`];
  const problems: string[] = [];
  if (a.episodeId !== post.episodeId) problems.push(`approval is for ${a.episodeId}, not ${post.episodeId}`);
  for (const [f, hash] of Object.entries(a.files)) {
    if (!existsSync(join(dir, f))) problems.push(`${f} was approved but is gone`);
    else if (sha256(readFileSync(join(dir, f))) !== hash) problems.push(`${f} changed after approval`);
  }
  if (!a.post) problems.push("the caption and media were not part of the approval; approve again once the post file exists");
  else if (a.post !== postHash(post)) problems.push("caption or media differ from what was approved");
  return problems;
}
