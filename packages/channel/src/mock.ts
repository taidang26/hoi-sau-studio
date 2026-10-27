/**
 * Fake Graph API transport. Hand it to GraphClient as `fetch` and it answers
 * from a route table instead of the network, recording every call so tests
 * can check what was sent.
 *
 * Route keys look like "POST :page/photos": a method, then a path whose
 * `:name` segments match any single segment. The version prefix (/v24.0/) is
 * stripped before matching; rupload.facebook.com calls start with "rupload/".
 */

import type { FetchLike } from "./graph.js";

export interface MockCall {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: Record<string, string>;
}

/** Return a body (sent as 200) or `{ status, body }` for anything else. */
type Handler = (call: MockCall, args: Record<string, string>) => unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

function matchSegments(pattern: string[], path: string[]): Record<string, string> | null {
  if (pattern.length !== path.length) return null;
  const args: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(":")) args[pattern[i].slice(1)] = decodeURIComponent(path[i]);
    else if (pattern[i] !== path[i]) return null;
  }
  return args;
}

function normalisePath(url: URL): string {
  const path = url.pathname.replace(/^\/+/, "");
  if (url.hostname === "rupload.facebook.com") return `rupload/${path}`;
  return path.replace(/^v\d+(\.\d+)?\//, "");
}

function readParams(url: URL, init: RequestInit): Record<string, string> {
  const source = init.method === "POST" ? new URLSearchParams(String(init.body ?? "")) : url.searchParams;
  return Object.fromEntries(source.entries());
}

const isReply = (x: unknown): x is { status: number; body: unknown } =>
  typeof x === "object" && x !== null && "status" in x && "body" in x;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createMockGraph(table: Record<string, Handler>): { fetch: FetchLike; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const routes: Route[] = Object.entries(table).map(([key, handler]) => {
    const [method, pattern] = key.split(" ", 2);
    return { method, segments: pattern.split("/"), handler };
  });

  const fakeFetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const call: MockCall = {
      method,
      path: normalisePath(url),
      params: readParams(url, { ...init, method }),
      headers: { ...((init.headers ?? {}) as Record<string, string>) },
    };
    calls.push(call);

    const segments = call.path.split("/");
    for (const route of routes) {
      if (route.method !== method) continue;
      const args = matchSegments(route.segments, segments);
      if (!args) continue;
      const out = route.handler(call, args);
      return isReply(out) ? json(out.status, out.body) : json(200, out);
    }
    return json(400, { error: { message: `No mock for ${method} ${call.path}`, code: 100 } });
  };

  return { fetch: fakeFetch, calls };
}

/** A Graph-shaped error reply for a route handler. */
export function graphError(status: number, code: number, message = "mock error", error_subcode?: number) {
  return { status, body: { error: { message, code, error_subcode } } };
}
