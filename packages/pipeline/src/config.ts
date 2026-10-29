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
import { type Brand, brandTargets, DEFAULT_GRAPH_VERSION, GraphClient, loadBrands, type Platform, THREADS_BASE_URL } from "@hoi-sau/channel";
import { DEMO, demoGraph } from "@hoi-sau/channel/dist/demo.js";
import { CHARACTERS_DIR, EPISODES_DIR, openStudio, SERIES_DIR } from "@hoi-sau/studio";
import { hostFromEnv, MockHost } from "./host.js";
import { type BrandSetup, type ChannelSetup, parsePlan, type PipelineDeps } from "./pipeline.js";

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
    const client = (token: string, platform: Platform) =>
      new GraphClient({ token, baseUrl: platform === "threads" ? THREADS_BASE_URL : undefined, fetch: graph.fetch, backoffMs: 1 });
    return {
      ...common,
      mode: "mock",
      dataDir,
      episodesDir: dirs.episodesDir,
      studio: openStudio({ mock: true, ...dirs, log: flags.log }),
      channel: (() => { const brands = loadBrands(); return brandSetups(brands, demoEnv(brands), client); })(),
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

export function liveChannel(env: NodeJS.ProcessEnv, brands: Brand[] = loadBrands()): ChannelSetup {
  const version = env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  return brandSetups(brands, env, (token, platform) =>
    platform === "threads" ? new GraphClient({ token, baseUrl: THREADS_BASE_URL }) : new GraphClient({ token, version }),
  );
}

function brandSetups(brands: Brand[], env: Record<string, string | undefined>, client: (token: string, platform: Platform) => GraphClient): ChannelSetup {
  return {
    brands: brands.map((brand): BrandSetup => {
      const found = brandTargets(brand, env, client);
      const username = brand.channels.find((c) => c.platform === "threads")?.env.username;
      return { brand, ...found, threadsUsername: (username && env[username]) || undefined };
    }),
  };
}

/** Every account in channels.yaml pointed at the demo Meta, so mock runs post wherever a live run would. */
function demoEnv(brands: Brand[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const b of brands)
    for (const c of b.channels) {
      const e = c.env;
      if (e.pageId) env[e.pageId] = DEMO.pageId;
      if (e.token) env[e.token] = c.platform === "threads" ? "demo-threads-token" : DEMO.pageToken;
      if (e.userId) env[e.userId] = c.platform === "threads" ? DEMO.threadsUserId : DEMO.igUserId;
      if (e.username) env[e.username] = DEMO.threadsUsername;
    }
  return env;
}
