/**
 * One shared password for a dashboard that is reachable from the internet.
 *
 * The cookie is named __session because Firebase Hosting, which fronts the
 * Cloud Run service, strips every other cookie before forwarding a request.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const COOKIE = "__session";
const MAX_AGE_S = 30 * 86_400;

/** Changes whenever the password does, so a new password logs everyone out. */
export function sessionToken(password: string): string {
  return createHmac("sha256", password).update("hoi-sau dashboard session").digest("base64url");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const passwordMatches = (password: string, given: string) => same(sessionToken(password), sessionToken(given));

export function isSignedIn(req: IncomingMessage, password: string): boolean {
  const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return cookie !== undefined && same(cookie.slice(COOKIE.length + 1), sessionToken(password));
}

export function sessionCookie(password: string | undefined): string {
  return password
    ? `${COOKIE}=${sessionToken(password)}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`
    : `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
