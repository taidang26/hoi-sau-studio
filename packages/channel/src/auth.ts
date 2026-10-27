/**
 * Tokens for our own Page and Instagram account, with the Meta app in
 * Development mode. A short-lived user token, from the `login` command or from
 * Graph API Explorer, is swapped for a long-lived one, and the Page token
 * derived from that has no fixed expiry.
 */

import { GraphError, type GraphClient } from "./graph.js";

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
  // Replying to and hiding comments as the Page, reading post reach and engagement
  "pages_manage_engagement",
  "read_insights",
  "instagram_manage_insights",
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

export interface LoginDialogOptions {
  appId: string;
  redirectUri: string;
  /** Random value checked on the way back, against CSRF. */
  state: string;
  version: string;
  scopes?: readonly string[];
  /** Facebook Login for Business configuration; replaces `scopes` when set. */
  configId?: string;
}

/** The Facebook Login dialog the user approves in the browser. */
export function loginDialogUrl(o: LoginDialogOptions): string {
  const params = new URLSearchParams({
    client_id: o.appId,
    redirect_uri: o.redirectUri,
    state: o.state,
    response_type: "code",
  });
  if (o.configId) params.set("config_id", o.configId);
  else params.set("scope", (o.scopes ?? REQUIRED_SCOPES).join(","));
  return `https://www.facebook.com/${o.version}/dialog/oauth?${params}`;
}

/** Swaps the code from the login redirect for a short-lived user token. */
export async function exchangeCodeForUserToken(
  graph: GraphClient,
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string,
): Promise<string> {
  const { access_token } = await graph.get<{ access_token: string }>("oauth/access_token", {
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code,
  });
  return access_token;
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

/**
 * Pages the token's user manages, each with its Page token and linked Instagram account.
 *
 * A Page owned by a business portfolio can be missing from /me/accounts. Then the
 * portfolio's owned and client Pages are read (needs business_management), and
 * finally `pageId` itself is asked for directly.
 */
export async function listManagedPages(userGraph: GraphClient, opts: { pageId?: string } = {}): Promise<ManagedPage[]> {
  type Row = {
    id: string;
    name: string;
    access_token?: string;
    instagram_business_account?: { id: string; username?: string };
  };
  const fields = ["id", "name", "access_token", "instagram_business_account{id,username}"].join(",");
  let rows = await userGraph.getAll<Row>("me/accounts", { fields });

  if (!rows.length) {
    try {
      for (const biz of await userGraph.getAll<{ id: string }>("me/businesses", { fields: "id" })) {
        rows.push(...(await userGraph.getAll<Row>(`${biz.id}/owned_pages`, { fields })));
        rows.push(...(await userGraph.getAll<Row>(`${biz.id}/client_pages`, { fields })));
      }
    } catch (e) {
      // Without business_management this edge is refused; fall through to the direct lookup.
      if (!(e instanceof GraphError) || (e.kind !== "permission" && e.kind !== "invalid")) throw e;
    }
  }
  if (!rows.length && opts.pageId) {
    try {
      rows = [await userGraph.get<Row>(opts.pageId, { fields })];
    } catch (e) {
      if (!(e instanceof GraphError) || (e.kind !== "permission" && e.kind !== "invalid")) throw e;
    }
  }

  const seen = new Set<string>();
  return rows
    .filter((r) => r.access_token && !seen.has(r.id) && seen.add(r.id))
    .map(({ id, name, access_token, instagram_business_account }) => ({
      id,
      name,
      accessToken: access_token!,
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
