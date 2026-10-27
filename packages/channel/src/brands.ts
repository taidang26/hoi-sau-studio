/**
 * Brands: who owns which accounts, and which episodes go where.
 *
 * Hồi Sau is the main brand and posts every episode. Each character is a
 * brand with its own Facebook Page, Instagram and Threads, and posts the
 * episodes it leads. `channels.yaml` at the repo root lists them, with the
 * names of the .env variables that hold each account's ids and tokens.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { GraphClient } from "./graph.js";
import type { Format, Platform } from "./index.js";
import type { Targets } from "./publish.js";

export const BRANDS_FILE = fileURLToPath(new URL("../../../channels.yaml", import.meta.url));

/** The brand whose journal keys and .env names predate brands; its keys stay as they were. */
export const MAIN_BRAND = "hoi-sau";

export type ChannelStatus = "live" | "paused" | "planned";

export interface ChannelEnv {
  /** Facebook: the Page id and Page token. */
  pageId?: string;
  token?: string;
  /** Instagram and Threads account id. */
  userId?: string;
  /** Threads handle, used to tell the brand's own replies apart. */
  username?: string;
}

export interface Channel {
  platform: Platform;
  status: ChannelStatus;
  /** Names of .env variables, never their values. */
  env: ChannelEnv;
}

export interface Brand {
  id: string;
  name: string;
  kind: "series" | "character";
  /** Character slug, for kind "character". */
  character?: string;
  tagline?: string;
  /** all: every episode. lead: episodes this character leads. cast: episodes it appears in. */
  posts: "all" | "lead" | "cast";
  channels: Channel[];
}

const PLATFORMS: Platform[] = ["facebook", "instagram", "threads"];
const STATUSES: ChannelStatus[] = ["live", "paused", "planned"];

export class BrandsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandsError";
  }
}

export function parseBrands(text: string): Brand[] {
  const doc = parse(text) as { brands?: unknown };
  if (!Array.isArray(doc?.brands)) throw new BrandsError("channels.yaml needs a top-level `brands:` list.");
  const seen = new Set<string>();
  return doc.brands.map((raw, i) => {
    const b = raw as Partial<Brand>;
    const where = `brands[${i}]${b?.id ? ` (${b.id})` : ""}`;
    if (!b?.id || !/^[a-z0-9-]+$/.test(b.id)) throw new BrandsError(`${where}: id must be lowercase letters, digits and dashes.`);
    if (seen.has(b.id)) throw new BrandsError(`${where}: id is used twice.`);
    seen.add(b.id);
    if (b.kind !== "series" && b.kind !== "character") throw new BrandsError(`${where}: kind must be series or character.`);
    if (b.kind === "character" && !b.character) throw new BrandsError(`${where}: a character brand needs a character slug.`);
    const posts = b.posts ?? (b.kind === "series" ? "all" : "lead");
    if (!["all", "lead", "cast"].includes(posts)) throw new BrandsError(`${where}: posts must be all, lead or cast.`);
    const channels = (b.channels ?? []).map((c, j) => {
      if (!PLATFORMS.includes(c.platform)) throw new BrandsError(`${where}.channels[${j}]: unknown platform ${c.platform}.`);
      if (!STATUSES.includes(c.status)) throw new BrandsError(`${where}.channels[${j}]: status must be live, paused or planned.`);
      return { platform: c.platform, status: c.status, env: { ...c.env } };
    });
    return { id: b.id, name: b.name ?? b.id, kind: b.kind, character: b.character, tagline: b.tagline, posts, channels };
  });
}

export const loadBrands = (file = BRANDS_FILE): Brand[] => parseBrands(readFileSync(file, "utf8"));

export function findBrand(brands: Brand[], id: string): Brand {
  const b = brands.find((x) => x.id === id);
  if (!b) throw new BrandsError(`No brand "${id}" in channels.yaml. Known: ${brands.map((x) => x.id).join(", ")}.`);
  return b;
}

/** The brand of a character, if it has one. */
export const brandOfCharacter = (brands: Brand[], slug: string) => brands.find((b) => b.kind === "character" && b.character === slug);

/** Every .env name a channel needs. Instagram also needs its brand's Page token. */
export function requiredEnv(brand: Brand, channel: Channel): string[] {
  const fb = brand.channels.find((c) => c.platform === "facebook")?.env ?? {};
  const names =
    channel.platform === "facebook"
      ? [channel.env.pageId, channel.env.token]
      : channel.platform === "instagram"
        ? [channel.env.userId, fb.pageId, fb.token]
        : [channel.env.userId, channel.env.token, channel.env.username];
  return names.filter((n): n is string => Boolean(n));
}

export interface ChannelState extends Channel {
  /** .env names that are empty. Only names, so this is safe to show. */
  missing: string[];
  /** Live and every variable set: the pipeline will post here. */
  ready: boolean;
}

export function channelStates(brand: Brand, env: Record<string, string | undefined>): ChannelState[] {
  return brand.channels.map((c) => {
    const missing = requiredEnv(brand, c).filter((n) => !env[n]);
    return { ...c, missing, ready: c.status === "live" && missing.length === 0 };
  });
}

export interface EpisodeCast {
  lead: string;
  characters?: string[];
}

/** Brands that should get this episode, with their live platforms. Brands with no live channel are left out. */
export function routeEpisode(brands: Brand[], ep: EpisodeCast): { brand: Brand; platforms: Platform[] }[] {
  return brands
    .filter((b) => b.posts === "all" || b.character === ep.lead || (b.posts === "cast" && !!b.character && (ep.characters ?? []).includes(b.character)))
    .map((brand) => ({ brand, platforms: brand.channels.filter((c) => c.status === "live").map((c) => c.platform) }))
    .filter((r) => r.platforms.length > 0);
}

/**
 * Publish targets for a brand from .env. Platforms with missing variables are
 * left out and listed in `skipped`, so one missing token never blocks the rest.
 */
export function brandTargets(
  brand: Brand,
  env: Record<string, string | undefined>,
  client: (token: string, platform: Platform) => GraphClient,
  opts: { includePaused?: boolean } = {},
): { targets?: Targets; platforms: Platform[]; skipped: { platform: Platform; reason: string }[] } {
  const skipped: { platform: Platform; reason: string }[] = [];
  const platforms: Platform[] = [];
  for (const s of channelStates(brand, env)) {
    if (s.status === "planned" || (s.status === "paused" && !opts.includePaused)) skipped.push({ platform: s.platform, reason: s.status });
    else if (s.missing.length) skipped.push({ platform: s.platform, reason: `missing ${s.missing.join(", ")}` });
    else platforms.push(s.platform);
  }
  const fb = brand.channels.find((c) => c.platform === "facebook")?.env ?? {};
  const pageId = fb.pageId && env[fb.pageId];
  const pageToken = fb.token && env[fb.token];
  const ig = brand.channels.find((c) => c.platform === "instagram")?.env;
  const th = brand.channels.find((c) => c.platform === "threads")?.env;
  const threadsToken = th?.token && env[th.token];
  const targets: Targets | undefined =
    pageId && pageToken
      ? {
          page: client(pageToken, "facebook"),
          pageId,
          igUserId: (ig?.userId && env[ig.userId]) || undefined,
          threads: threadsToken && th?.userId && env[th.userId] ? { client: client(threadsToken, "threads"), userId: env[th.userId]! } : undefined,
        }
      : undefined;
  // Without a Page token there is no client for Facebook or Instagram.
  return { targets, platforms: targets ? platforms.filter((p) => p !== "threads" || targets.threads) : [], skipped };
}

/** Journal key of one post. The main brand keeps the key it had before brands existed. */
export const journalKey = (episodeId: string, platform: Platform, format: Format, brand = MAIN_BRAND) =>
  `${episodeId}:${platform}:${format}${brand === MAIN_BRAND ? "" : `:${brand}`}`;

export function parseJournalKey(key: string): { episodeId: string; platform: Platform; format: Format; brand: string } {
  const [episodeId, platform, format, brand] = key.split(":");
  return { episodeId, platform: platform as Platform, format: format as Format, brand: brand || MAIN_BRAND };
}
