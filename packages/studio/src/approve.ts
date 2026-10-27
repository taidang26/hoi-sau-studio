/**
 * The owner's final sign-off on an episode (`studio episode approve <id>`).
 *
 * It refuses an episode whose safety check failed or is stale, lists what
 * deserves a second look (panels that failed review, step files edited by
 * hand, lettering that overflowed), and records the hash of every file that
 * makes the episode and of the post (caption and media). `channel publish`
 * refuses anything that does not match it, so nothing changed after this
 * point, by anyone, can go out.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_FILE, type Approval, type EpisodePost, hashFiles, postHash } from "@hoi-sau/channel";
import { EPISODE_STEPS, episodeDir, episodeTexts, type PanelReview, readStep, type SafetyRecord, textsHash } from "./episode.js";
import { editedSteps, logProvenance, whoAmI } from "./provenance.js";

export interface ApproveOptions {
  dir?: string;
  /** The post file to approve with the episode; default episodes/<id>/post.json when it exists. */
  postFile?: string;
  /** Approve although there are warnings; they are kept in the approval. */
  despiteWarnings?: boolean;
  by?: string;
  now?: Date;
}

export interface ApprovalCheck {
  /** Stop: cannot be approved. */
  blockers: string[];
  /** Worth a look; approving anyway is the owner's call. */
  warnings: string[];
}

export function checkForApproval(id: string, dir?: string): ApprovalCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const gate = readStep<SafetyRecord>(id, "safety", dir);
  if (!gate) blockers.push("the safety check has not run");
  else if (!gate.pass) blockers.push(`the safety check failed: ${gate.issues.map((i) => `${i.where} (${i.topic})`).join(", ")}`);
  else if (gate.textsHash !== textsHash(episodeTexts(id, dir))) blockers.push("the story changed after the safety check; rerun from safety");
  if (!readStep(id, "letter", dir)) blockers.push("the pages are not lettered yet");

  const review = readStep<{ reviews: PanelReview[] }>(id, "review", dir);
  const failed = review?.reviews.filter((r) => !r.pass) ?? [];
  if (!review) warnings.push("the panels were not self-reviewed");
  else if (failed.length) warnings.push(`panels that failed self-review: ${failed.map((r) => `${r.n} (${r.issues.map((i) => i.problem).join("; ")})`).join(", ")}`);
  const letter = readStep<{ pages: Array<{ n: number; overflow: number }> }>(id, "letter", dir);
  const overflow = letter?.pages.filter((p) => p.overflow > 0) ?? [];
  if (overflow.length) warnings.push(`lettering overflows on page ${overflow.map((p) => p.n).join(", ")}`);
  const edited = editedSteps(episodeDir(id, dir), ["episode", ...EPISODE_STEPS]);
  if (edited.length) warnings.push(`changed outside the pipeline: ${edited.map((s) => `${s}.json`).join(", ")}`);
  return { blockers, warnings };
}

export function approveEpisode(id: string, opts: ApproveOptions = {}): Approval {
  const folder = episodeDir(id, opts.dir);
  if (!existsSync(join(folder, "episode.json"))) throw new Error(`no episode ${id}`);
  const { blockers, warnings } = checkForApproval(id, opts.dir);
  if (blockers.length) throw new Error(`${id} cannot be approved:\n  - ${blockers.join("\n  - ")}`);
  if (warnings.length && !opts.despiteWarnings) throw new Error(`${id} has warnings; look at them, then approve with --despite-warnings:\n  - ${warnings.join("\n  - ")}`);

  const steps = ["episode", ...EPISODE_STEPS].map((s) => `${s}.json`).filter((f) => existsSync(join(folder, f)));
  const pages = existsSync(join(folder, "final")) ? readdirSync(join(folder, "final")).sort().map((f) => `final/${f}`) : [];
  const postFile = opts.postFile ?? (existsSync(join(folder, "post.json")) ? join(folder, "post.json") : undefined);
  const post = postFile ? (JSON.parse(readFileSync(postFile, "utf8")) as EpisodePost) : undefined;
  if (post && post.episodeId !== id) throw new Error(`${postFile} is for ${post.episodeId}, not ${id}`);

  const by = opts.by ?? whoAmI();
  const approval: Approval = {
    episodeId: id,
    approvedBy: by,
    approvedAt: (opts.now ?? new Date()).toISOString(),
    files: hashFiles(folder, [...steps, ...pages]),
    ...(post ? { post: postHash(post) } : {}),
    ...(warnings.length ? { notes: warnings } : {}),
  };
  writeFileSync(join(folder, APPROVAL_FILE), JSON.stringify(approval, null, 2) + "\n");
  logProvenance(folder, { event: "approved", by, detail: post ? "episode and post" : "episode only, no post file yet" });
  return approval;
}
