/**
 * Tokens for our own Page and Instagram account, with the Meta app in
 * Development mode: no login screen. A short-lived user token from Graph API
 * Explorer is swapped for a long-lived one, and the Page token derived from
 * that has no fixed expiry.
 */

import type { GraphClient } from "./graph.js";

/** What the build asks for, and nothing more. */
export const REQUIRED_SCOPES = [
  // Page and its posts
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_posts",
  // Instagram publishing and comments
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  // Inbox (Messenger and Instagram direct)
  "pages_messaging",
  "instagram_manage_messages",
] as const;

export interface LongLivedToken {
  accessToken: string;
  /** Seconds left, when Meta says (around 60 days). */
  expiresIn?: number;
}

export interface ManagedPage {
  id: string;
  name: string;
  /** Page access token. */
  accessToken: string;
  /** The Instagram professional account linked to this Page, if any. */
  instagram?: { id: string; username?: string };
}

export interface TokenStatus {
  valid: boolean;
  /** Missing when the token never expires. */
  expiresAt?: Date;
  scopes: string[];
}

/** fb_exchange_token only accepts query parameters, so this is a GET without a bearer token. */
export async function exchangeLongLivedUserToken(
  graph: GraphClient,
  appId: string,
  appSecret: string,
  shortLivedToken: string,
): Promise<LongLivedToken> {
  const { access_token, expires_in } = await graph.get<{ access_token: string; expires_in?: number }>(
    "oauth/access_token",
    {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    },
  );
  return { accessToken: access_token, expiresIn: expires_in };
}

/** Pages the token's user manages, each with its Page token and linked Instagram account. */
export async function listManagedPages(userGraph: GraphClient): Promise<ManagedPage[]> {
  type Row = {
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string; username?: string };
  };
  const rows = await userGraph.getAll<Row>("me/accounts", {
    fields: ["id", "name", "access_token", "instagram_business_account{id,username}"].join(","),
  });
  return rows.map(({ id, name, access_token, instagram_business_account }) => ({
    id,
    name,
    accessToken: access_token,
    ...(instagram_business_account ? { instagram: instagram_business_account } : {}),
  }));
}

/** /debug_token, called with an app token (`appId|appSecret`). */
export async function inspectToken(appGraph: GraphClient, token: string): Promise<TokenStatus> {
  const res = await appGraph.get<{ data: { is_valid: boolean; expires_at?: number; scopes?: string[] } }>(
    "debug_token",
    { input_token: token },
  );
  const { is_valid, expires_at, scopes = [] } = res.data;
  // Meta reports expires_at = 0 for tokens that do not expire.
  return { valid: is_valid, expiresAt: expires_at ? new Date(expires_at * 1000) : undefined, scopes };
}

export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return REQUIRED_SCOPES.filter((scope) => !have.has(scope));
}
