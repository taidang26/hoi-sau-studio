/**
 * Builds the pipeline's dependencies from .env and flags.
 *
 * Mock mode touches nothing real: fake Muse models, fake Graph API, made-up
 * media URLs, and its own copies of characters/ and series/ under
 * data-demo/studio/ (the same place the dashboard's --demo mode uses), so the
 * episode memory it writes never lands in the repo's profiles.
 */

import { cpSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GRAPH_VERSION, GraphClient, THREADS_BASE_URL } from "@hoi-sau/channel";
import { DEMO, demoGraph } from "@hoi-sau/channel/dist/demo.js";
import { CHARACTERS_DIR, EPISODES_DIR, openStudio, SERIES_DIR } from "@hoi-sau/studio";
import { hostFromEnv, MockHost } from "./host.js";
import { type ChannelSetup, parsePlan, type PipelineDeps } from "./pipeline.js";

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export function loadDotEnv(file = join(ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(ROOT, p));

export interface ConfigFlags {
  mock?: boolean;
  /** Full-size video even in mock mode. */
  final?: boolean;
  publish?: boolean;
  lead?: string;
  direction?: string;
  log?: (s: string) => void;
}

export function buildDeps(flags: ConfigFlags, env: NodeJS.ProcessEnv = process.env): PipelineDeps {
  const mock = flags.mock ?? env.PIPELINE_MOCK === "1";
  const plan = env.PIPELINE_POSTS ? parsePlan(env.PIPELINE_POSTS) : undefined;
  const motion = {
    quality: mock && !flags.final ? ("draft" as const) : ("final" as const),
    audio: env.PIPELINE_MUSIC ? fromRoot(env.PIPELINE_MUSIC) : undefined,
  };
  const common = {
    plan,
    motion,
    lead: flags.lead ?? (env.PIPELINE_LEAD || undefined),
    direction: flags.direction,
    publish: flags.publish,
    publishFailedReview: env.PIPELINE_PUBLISH_FAILED_REVIEW === "1",
    log: flags.log,
  };

  if (mock) {
    const dataDir = fromRoot(env.PIPELINE_DEMO_DIR || "data-demo");
    const dirs = {
      charactersDir: join(dataDir, "studio", "characters"),
      seriesDir: join(dataDir, "studio", "series"),
      episodesDir: join(dataDir, "studio", "episodes"),
    };
    if (!existsSync(dirs.charactersDir)) cpSync(CHARACTERS_DIR, dirs.charactersDir, { recursive: true });
    if (!existsSync(dirs.seriesDir)) cpSync(SERIES_DIR, dirs.seriesDir, { recursive: true });
    const graph = demoGraph({ containerPolls: 1 });
    const page = new GraphClient({ token: DEMO.pageToken, fetch: graph.fetch, backoffMs: 1 });
    const threads = new GraphClient({ token: "demo-threads-token", baseUrl: THREADS_BASE_URL, fetch: graph.fetch, backoffMs: 1 });
    return {
      ...common,
      mode: "mock",
      dataDir,
      episodesDir: dirs.episodesDir,
      studio: openStudio({ mock: true, ...dirs, log: flags.log }),
      channel: {
        targets: { page, pageId: DEMO.pageId, igUserId: DEMO.igUserId, threads: { client: threads, userId: DEMO.threadsUserId } },
        threadsUsername: DEMO.threadsUsername,
      },
      host: new MockHost(),
      pollIntervalMs: 1,
    };
  }

  return {
    ...common,
    mode: "live",
    dataDir: fromRoot(env.CHANNEL_DATA_DIR || "data"),
    episodesDir: EPISODES_DIR,
    studio: openStudio({ env, log: flags.log }),
    channel: liveChannel(env),
    host: hostFromEnv(env),
  };
}

function liveChannel(env: NodeJS.ProcessEnv): ChannelSetup | undefined {
  if (!env.FB_PAGE_ID || !env.FB_PAGE_TOKEN) return undefined;
  const page = new GraphClient({ token: env.FB_PAGE_TOKEN, version: env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION });
  const threads =
    env.THREADS_USER_ID && env.THREADS_TOKEN
      ? { client: new GraphClient({ token: env.THREADS_TOKEN, baseUrl: THREADS_BASE_URL }), userId: env.THREADS_USER_ID }
      : undefined;
  return {
    targets: { page, pageId: env.FB_PAGE_ID, igUserId: env.IG_USER_ID || undefined, threads },
    threadsUsername: env.THREADS_USERNAME || undefined,
  };
}
