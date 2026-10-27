/**
 * Direct messages to the Page (Messenger) and the linked Instagram account,
 * pulled by polling the Page's conversations and answered through the Send
 * API. Both use the Page token.
 *
 * A normal reply is only allowed within 24 hours of the customer's last
 * message. Outside that window Meta rejects it, so the window is checked
 * before calling the API and shown in the UI instead of failing on send.
 */

import type { GraphClient } from "./graph.js";
import type { Platform } from "./index.js";

export interface InboxMessage {
  id: string;
  from: "customer" | "page";
  text: string;
  createdAt: string;
  /** Number of attachments (images, stickers…). Their content is not stored. */
  attachments?: number;
}

export interface Conversation {
  id: string;
  platform: Platform;
  customer: { id: string; name: string };
  updatedAt: string;
  /** Oldest first. */
  messages: InboxMessage[];
  /** Brand whose Page got the message; left out for the main brand. */
  brand?: string;
}

export const REPLY_WINDOW_MS = 24 * 3600_000;

export class InboxError extends Error {
  constructor(
    message: string,
    readonly code: "OUTSIDE_WINDOW" | "EMPTY" | "TOO_LONG" | "NOT_FOUND",
  ) {
    super(message);
    this.name = "InboxError";
  }
}

/** When the reply window closes, or null if the customer has never written. */
export function windowClosesAt(c: Conversation): Date | null {
  const last = [...c.messages].reverse().find((m) => m.from === "customer");
  return last ? new Date(Date.parse(last.createdAt) + REPLY_WINDOW_MS) : null;
}

export function canReply(c: Conversation, now = new Date()): boolean {
  const closes = windowClosesAt(c);
  return closes !== null && closes.getTime() > now.getTime();
}

interface RawMessage {
  id: string;
  message?: string;
  created_time: string;
  from?: { id: string; name?: string; username?: string };
  attachments?: { data: unknown[] };
}

interface RawConversation {
  id: string;
  updated_time: string;
  participants?: { data: Array<{ id: string; name?: string; username?: string }> };
  messages?: { data: RawMessage[] };
}

/**
 * Recent conversations for one platform. `ownIds` are the Page ID and the
 * Instagram account ID, used to tell the page's own messages apart.
 */
export async function fetchConversations(page: GraphClient, pageId: string, platform: Platform, ownIds: string[], max = 50): Promise<Conversation[]> {
  const raw = await page.getAll<RawConversation>(
    `${pageId}/conversations`,
    {
      platform: platform === "instagram" ? "instagram" : "messenger",
      fields: "id,updated_time,participants,messages.limit(25){id,message,created_time,from,attachments}",
      limit: 25,
    },
    max,
  );
  return raw.map((c) => {
    const customer = c.participants?.data.find((p) => !ownIds.includes(p.id)) ?? { id: "unknown" };
    const messages = (c.messages?.data ?? [])
      .map((m) => ({
        id: m.id,
        from: m.from && ownIds.includes(m.from.id) ? ("page" as const) : ("customer" as const),
        text: m.message ?? "",
        createdAt: m.created_time,
        attachments: m.attachments?.data.length || undefined,
      }))
      // Graph returns newest first.
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      id: c.id,
      platform,
      customer: { id: customer.id, name: customer.name ?? customer.username ?? (platform === "instagram" ? "Instagram user" : "Facebook user") },
      updatedAt: c.updated_time,
      messages,
    };
  });
}

/** Merge a fresh pull into what is stored: messages are unioned by ID, so history older than the pull survives. */
export function mergeConversations(existing: Conversation[], incoming: Conversation[]): { all: Conversation[]; newMessages: number } {
  const byId = new Map(existing.map((c) => [c.id, c]));
  let newMessages = 0;
  for (const c of incoming) {
    const old = byId.get(c.id);
    const seen = new Map((old?.messages ?? []).map((m) => [m.id, m]));
    for (const m of c.messages) {
      if (!seen.has(m.id)) newMessages++;
      seen.set(m.id, m);
    }
    byId.set(c.id, { ...c, messages: [...seen.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
  }
  const all = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { all, newMessages };
}

const MAX_TEXT = 2000;

/** Send a text reply. Checks the 24-hour window first; returns the message as stored. */
export async function sendReply(page: GraphClient, pageId: string, c: Conversation, text: string, now = new Date()): Promise<InboxMessage> {
  const body = text.trim();
  if (!body) throw new InboxError("Tin nhắn trống.", "EMPTY");
  if (body.length > MAX_TEXT) throw new InboxError(`Tin nhắn dài quá ${MAX_TEXT} ký tự.`, "TOO_LONG");
  if (!canReply(c, now)) throw new InboxError("Đã quá 24 giờ kể từ tin cuối của khách, Meta không cho gửi tin thường.", "OUTSIDE_WINDOW");

  const res = await page.post<{ message_id: string }>(`${pageId}/messages`, {
    recipient: JSON.stringify({ id: c.customer.id }),
    messaging_type: "RESPONSE",
    message: JSON.stringify({ text: body }),
  });
  return { id: res.message_id, from: "page", text: body, createdAt: now.toISOString() };
}
