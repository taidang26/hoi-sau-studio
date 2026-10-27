/**
 * A small stateful Meta: one Page ("Hồi Sau") with a linked Instagram
 * account and a Threads profile, answering the calls this package makes.
 * The tests use it, and so does the CLI when META_GRAPH_MOCK=1, so the whole
 * flow runs before any real account exists.
 */

import { createMockGraph, graphError, type MockCall } from "./mock.js";
import { REQUIRED_SCOPES } from "./auth.js";

export const DEMO = {
  pageId: "100000000000001",
  pageName: "Hồi Sau",
  pageToken: "demo-page-token",
  igUserId: "17841400000000001",
  igUsername: "hoisau.demo",
  threadsUserId: "27000000000000001",
  threadsUsername: "hoisau.demo",
};

const at = (hhmm: string) => `2026-10-27T${hhmm}:00+0000`;

/** Sample comments on a Facebook post: two people and one reply from the Page. */
function facebookComments(post: string) {
  const person = (id: string, name: string) => ({ id, name });
  return [
    { id: `${post}_c1`, message: "Lolo mà xin nghỉ phép thì ai trực máy in?", created_time: at("01:00"), from: person("u1", "Hà") },
    { id: `${post}_c2`, message: "Cảm ơn mọi người đã đọc!", created_time: at("01:05"), from: person(DEMO.pageId, DEMO.pageName) },
    { id: `${post}_c3`, message: "Cho Poppy trực luôn", created_time: at("01:06"), from: person("u2", "Quân"), parent: { id: `${post}_c1` } },
  ];
}

/** Sample Instagram comments: one from a follower, with our reply nested under it. */
function instagramComments(media: string) {
  const own = { id: DEMO.igUserId, username: DEMO.igUsername };
  return [
    {
      id: `${media}_ig1`,
      text: "Tập sau cho Pango đi họp phụ huynh công ty 😂",
      timestamp: at("02:00"),
      username: "thu.vp",
      from: { id: "ig-u1", username: "thu.vp" },
      replies: { data: [{ id: `${media}_ig2`, text: "Ghi nhận!", timestamp: at("02:01"), username: own.username, from: own }] },
    },
  ];
}

function threadsConversation(post: string) {
  return [
    { id: `${post}_t1`, text: "Cho sao la làm sếp đi", timestamp: at("03:00"), username: "an.ng", replied_to: { id: post } },
    { id: `${post}_t2`, text: "Chuẩn!", timestamp: at("03:02"), username: "binh.t", replied_to: { id: `${post}_t1` } },
    { id: `${post}_t3`, text: "Cảm ơn bạn nha", timestamp: at("03:03"), username: DEMO.threadsUsername, replied_to: { id: `${post}_t1` } },
    { id: `${post}_t4`, text: "spam link", timestamp: at("03:04"), username: "spam.bot", replied_to: { id: post }, hide_status: "HIDDEN" },
  ];
}

function conversations(platform: string | undefined) {
  if (platform === "instagram") {
    const customer = { id: "igsid_1", username: "linh.vp" };
    return [
      {
        id: "ig_conv_1",
        updated_time: at("03:10"),
        participants: { data: [{ id: DEMO.igUserId, username: DEMO.igUsername }, customer] },
        messages: {
          data: [
            { id: "ig_m2", message: "Khi nào có tập Tê Tê vậy?", created_time: at("03:10"), from: customer },
            { id: "ig_m1", message: "Hi page", created_time: at("03:00"), from: customer },
          ],
        },
      },
    ];
  }
  const page = { id: DEMO.pageId, name: DEMO.pageName };
  const customer = { id: "psid_1", name: "Lan" };
  return [
    {
      id: "t_conv_1",
      updated_time: at("02:05"),
      participants: { data: [customer, page] },
      messages: {
        data: [
          { id: "m_3", message: "Dạ cảm ơn bạn!", created_time: at("02:05"), from: page },
          { id: "m_2", message: "Cu li dễ thương quá", created_time: at("02:00"), from: customer, attachments: { data: [{}] } },
        ],
      },
    },
  ];
}

/** Media that Meta processes in the background, done after a few status checks. */
class Processing {
  private readonly polls = new Map<string, number>();
  constructor(private readonly needed: number) {}
  add(id: string) {
    this.polls.set(id, 0);
  }
  has(id: string) {
    return this.polls.has(id);
  }
  /** Counts one status check; true once the item is done. */
  check(id: string): boolean {
    const n = (this.polls.get(id) ?? 0) + 1;
    this.polls.set(id, n);
    return n >= this.needed;
  }
}

export function demoGraph(opts: { containerPolls?: number } = {}) {
  let counter = 900000;
  const newId = () => String(++counter);
  const needed = opts.containerPolls ?? 2;
  const igContainers = new Processing(needed);
  const threadsContainers = new Processing(needed);

  const objectRead = (c: MockCall, id: string) => {
    const fields = c.params.fields ?? "";
    if (threadsContainers.has(id) && fields.startsWith("status")) {
      return { status: threadsContainers.check(id) ? "FINISHED" : "IN_PROGRESS" };
    }
    if (igContainers.has(id) && fields === "status_code") {
      return { status_code: igContainers.check(id) ? "FINISHED" : "IN_PROGRESS" };
    }
    switch (fields) {
      case "status":
        return { status: { video_status: "ready" } };
      case "permalink_url":
        return { permalink_url: `https://www.facebook.com/${id}` };
      case "permalink":
        return c.headers.Authorization?.includes("threads")
          ? { permalink: `https://www.threads.net/@${DEMO.threadsUsername}/post/${id}` }
          : { permalink: `https://www.instagram.com/p/${id}/` };
      default:
        return { id };
    }
  };

  return createMockGraph({
    // Login and token checks
    "GET oauth/access_token": (c) =>
      c.params.grant_type === "fb_exchange_token" && c.params.fb_exchange_token
        ? { access_token: "demo-long-user-token", token_type: "bearer", expires_in: 60 * 86_400 }
        : c.params.code && c.params.redirect_uri && c.params.client_secret
          ? { access_token: "demo-short-user-token", token_type: "bearer", expires_in: 3600 }
          : graphError(400, 100, "Missing fb_exchange_token or code"),
    "GET me/accounts": () => ({
      data: [
        {
          id: DEMO.pageId,
          name: DEMO.pageName,
          access_token: DEMO.pageToken,
          instagram_business_account: { id: DEMO.igUserId, username: DEMO.igUsername },
        },
      ],
    }),
    "GET debug_token": () => ({ data: { is_valid: true, expires_at: 0, scopes: [...REQUIRED_SCOPES] } }),

    // Facebook: photos (unpublished ones wait to be attached), feed, Reels
    "POST :page/photos": (c, a) => {
      const id = newId();
      return c.params.published === "false" ? { id } : { id, post_id: `${a.page}_${id}` };
    },
    "POST :page/feed": (_c, a) => ({ id: `${a.page}_${newId()}` }),
    "POST :page/video_reels": (c) =>
      c.params.upload_phase === "start" ? { video_id: newId(), upload_url: "https://rupload.facebook.com/video-upload/demo" } : { success: true },
    "POST rupload/video-upload/:ver/:video": (c) => (c.headers.file_url ? { success: true } : graphError(400, 100, "file_url header missing")),

    // Instagram: containers, publish, quota
    "POST :ig/media": () => {
      const id = newId();
      igContainers.add(id);
      return { id };
    },
    "POST :ig/media_publish": (c) =>
      igContainers.has(c.params.creation_id) ? { id: newId() } : graphError(400, 9007, "Media ID is not available"),
    "GET :ig/content_publishing_limit": () => ({ data: [{ quota_usage: 1, config: { quota_total: 50 } }] }),

    // Threads
    "GET access_token": (c) =>
      c.params.grant_type === "th_exchange_token" && c.params.access_token && c.params.client_secret
        ? { access_token: "demo-threads-long-token", token_type: "bearer", expires_in: 5_183_944 }
        : graphError(400, 100, "Missing exchange parameters"),
    "GET refresh_access_token": (c) =>
      c.params.grant_type === "th_refresh_token" ? { access_token: "demo-threads-refreshed", expires_in: 5_183_944 } : graphError(400, 100),
    "GET me": () => ({ id: DEMO.threadsUserId, username: DEMO.threadsUsername }),
    "POST :user/threads": () => {
      const id = newId();
      threadsContainers.add(id);
      return { id };
    },
    "POST :user/threads_publish": (c) =>
      threadsContainers.has(c.params.creation_id) ? { id: newId() } : graphError(400, 24, "Container not found"),
    "GET :post/conversation": (_c, a) => ({ data: threadsConversation(a.post) }),

    // Comments: Facebook post IDs look like "<page>_<post>", Instagram media IDs do not.
    "GET :post/comments": (_c, a) => ({ data: a.post.includes("_") ? facebookComments(a.post) : instagramComments(a.post) }),

    // Inbox
    "GET :page/conversations": (c) => ({ data: conversations(c.params.platform) }),
    "POST :page/messages": (c) => {
      const recipient = JSON.parse(c.params.recipient ?? "{}") as { id?: string };
      return recipient.id ? { recipient_id: recipient.id, message_id: `mid.${newId()}` } : graphError(400, 100, "recipient required");
    },

    // Single objects: container and video status, permalinks
    "GET :id": (c, a) => objectRead(c, a.id),
  });
}
