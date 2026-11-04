/**
 * Sample data for trying the dashboard before the real Page is connected.
 * Written to a separate folder (data-demo by default) so it never mixes with
 * real comments. Everything here is made up.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment, Conversation, JournalEntry } from "@hoi-sau/channel";

// [episode index, author, text]. Index: 0 cu-li, 1 ca-noc, 2 te-te, 3 sao-la.
const LINES: Array<[number, string, string]> = [
  [0, "Minh Anh", "Tập sau cho Cu Li bị sếp gọi họp lúc 6h sáng đi 😂"],
  [1, "Quang Huy", "Cá Nóc phồng lên mà vẫn đeo kính là chi tiết đỉnh nhất"],
  [2, "Thảo Vy", "Cho Tê Tê với Sao La chung một dự án đi, xem ai né giỏi hơn"],
  [0, "Đức Long", "Cu Li deadline là thứ Sáu nhưng thứ Sáu tuần nào?"],
  [1, "Hà My", "Mình làm kế toán, Cá Nóc chính là mình lúc 4h59 chiều"],
  [3, "Tuấn Kiệt", "Tập sau Sao La xuất hiện đúng hôm chia thưởng Tết nhé"],
  [3, "Ngọc Trâm", "Có ai thấy Sao La làm việc chưa, mình nghe kể thôi"],
  [2, "Bảo Nam", "Cho Tê Tê cuộn tròn trong buổi review lương luôn"],
  [0, "Lan Chi", "Ước gì có Cu Li ngoài đời để đổ lỗi chuyện trễ deadline"],
  [1, "Hoàng Phúc", "Tập sau cho cả phòng đi team building, Cá Nóc phải chèo thuyền"],
  [0, "Thu Hằng", "Cu Li gửi file final_v7 làm mình cười cả buổi"],
  [2, "Việt Anh", "Tê Tê nói 'để anh check lại' y chang sếp mình"],
  [1, "Khánh Linh", "Cho Cá Nóc gặp khách hàng gọi lúc 5h chiều thứ Sáu đi"],
  [0, "Gia Bảo", "Tập sau Cu Li đi làm đúng giờ một lần thử xem cả phòng phản ứng sao"],
];

export function writeDemoData(dir: string, now = new Date()): void {
  mkdirSync(dir, { recursive: true });
  const hour = 3600_000;
  const at = (h: number) => new Date(now.getTime() - h * hour).toISOString();
  const episodes = [
    { id: "cu-li-ep-001", h: 30 },
    { id: "ca-noc-ep-001", h: 29 },
    { id: "te-te-ep-001", h: 28 },
    { id: "sao-la-ep-001", h: 27 },
  ];

  const journal: Record<string, JournalEntry> = {};
  const posts: string[] = [];
  episodes.forEach((e, i) => {
    const fb = `100000000000001_9000${i}`;
    const ig = `1790000000000${i}`;
    journal[`${e.id}:facebook:carousel-4x5`] = { state: "published", platform: "facebook", postId: fb, permalink: `https://www.facebook.com/${fb}`, publishedAt: at(e.h) };
    journal[`${e.id}:instagram:carousel-4x5`] = { state: "published", platform: "instagram", postId: ig, permalink: `https://www.instagram.com/p/demo${i}/`, publishedAt: at(e.h - 0.2) };
    posts.push(fb, ig);
  });
  journal["cu-li-ep-002:instagram:reels-9x16"] = { state: "publishing", startedAt: at(0.5), containerId: "demo-container" };
  // Lolo leads cu-li-ep-001, so the episode also went to Lolo's own Page and Instagram.
  const loloFb = "200000000000002_9100";
  const loloIg = "17900000000100";
  journal["cu-li-ep-001:facebook:carousel-4x5:lolo"] = { state: "published", platform: "facebook", postId: loloFb, permalink: `https://www.facebook.com/${loloFb}`, publishedAt: at(29.8), brand: "lolo" };
  journal["cu-li-ep-001:instagram:carousel-4x5:lolo"] = { state: "published", platform: "instagram", postId: loloIg, permalink: "https://www.instagram.com/p/demololo/", publishedAt: at(29.7), brand: "lolo" };

  const loloComments: Comment[] = [
    { id: "demo_lolo_1", platform: "instagram", postId: loloIg, text: "Lolo ôm đầu y hệt mình lúc sếp nhắn 'em ơi' 😭", author: { name: "an.nhien" }, createdAt: at(20) },
    { id: "demo_lolo_2", platform: "facebook", postId: loloFb, text: "Follow Lolo vì khung suy nghĩ to gấp ba khung thoại", author: { name: "Phương Thảo" }, createdAt: at(12) },
  ];
  const comments: Comment[] = LINES.map(([ep, name, text], i) => {
    const postIndex = ep * 2 + (i % 2);
    return {
      id: `demo_${i + 1}`,
      platform: postIndex % 2 === 0 ? "facebook" : "instagram",
      postId: posts[postIndex],
      text,
      author: { name },
      createdAt: at(26 - i * 1.8),
    };
  });

  const msg = (id: string, from: "customer" | "page", text: string, h: number) => ({ id, from, text, createdAt: at(h) });
  const inbox: Conversation[] = [
    {
      id: "demo_t1", platform: "facebook", customer: { id: "psid_demo_1", name: "Minh Anh" }, updatedAt: at(0.3),
      messages: [
        msg("d1", "customer", "Page ơi, Cu Li có bán sticker không ạ?", 3),
        msg("d2", "page", "Chưa có bạn ơi, nhưng nhiều người hỏi lắm, tụi mình đang tính 😄", 2.8),
        msg("d3", "customer", "Có thì báo mình với nhé, mình mua cả bộ", 0.3),
      ],
    },
    {
      id: "demo_t2", platform: "instagram", customer: { id: "igsid_demo_2", name: "thaovy.office" }, updatedAt: at(1.5),
      messages: [msg("d4", "customer", "Tập Tê Tê đi họp hôm qua y hệt phòng mình luôn. Cho mình gửi ý tưởng tập sau được không?", 1.5)],
    },
    {
      id: "demo_t3", platform: "facebook", customer: { id: "psid_demo_3", name: "Đức Long" }, updatedAt: at(5),
      messages: [
        msg("d5", "customer", "Admin vẽ bằng gì vậy?", 6),
        msg("d6", "page", "Tụi mình dùng Muse Image của Meta, lời thoại thì ghép riêng để giữ dấu tiếng Việt nha", 5),
      ],
    },
    {
      id: "demo_t4", platform: "instagram", customer: { id: "igsid_demo_4", name: "hamy.ketoan" }, updatedAt: at(30),
      messages: [msg("d7", "customer", "Cá Nóc là mình lúc 4h59 chiều 😭", 30)],
    },
  ];

  // Short clips posted at different hours, with numbers, for the Hiệu suất page.
  const metrics: Record<string, unknown>[] = [];
  const day0 = new Date(now.getTime() + 7 * hour);
  day0.setUTCHours(0, 0, 0, 0);
  const clipAt = (daysAgo: number, h: number, m: number) => new Date(day0.getTime() - daysAgo * 24 * hour + (h - 7) * hour + m * 60_000).toISOString();
  const clips: [string, number, number, number, number][] = [
    ["pilot-sepvohan-1", 3, 8, 40, 80], ["pilot-luongthap-2", 3, 14, 49, 305], ["pilot-chikhang-3", 3, 20, 2, 94],
    ["pilot-trasua-4", 2, 12, 2, 55], ["pilot-luoi-5", 2, 21, 34, 120], ["pilot-gui500k-6", 1, 12, 32, 370], ["pilot-luatien-7", 1, 20, 19, 143],
  ];
  for (const [id, d, h, m, views] of clips) {
    const when = clipAt(d, h, m);
    for (const [platform, share] of [["facebook", 0.6], ["instagram", 1], ["threads", 0.1]] as const) {
      const postId = `demo_${id}_${platform}`;
      journal[`${id}${platform === "threads" ? "-still" : ""}:${platform}:${platform === "threads" ? "image-4x5" : "reels-9x16"}`] = { state: "published", platform, postId, permalink: `https://example.com/${postId}`, publishedAt: when };
      metrics.push({ postId, platform, views: Math.round(views * share), reach: Math.round(views * share * 0.8), reactions: Math.round(views * share * 0.02), shares: platform === "threads" ? 0 : 1, fetchedAt: at(1) });
    }
  }
  writeFileSync(join(dir, "insights.json"), JSON.stringify(metrics, null, 2) + "\n");
  writeFileSync(join(dir, "inbox.json"), JSON.stringify(inbox, null, 2) + "\n");
  writeFileSync(join(dir, "publish-journal.json"), JSON.stringify(journal, null, 2) + "\n");
  writeFileSync(join(dir, "comments.json"), JSON.stringify([...comments, ...loloComments], null, 2) + "\n");
  writeFileSync(join(dir, "directions.json"), JSON.stringify([{ commentId: "demo_3", pickedAt: at(2) }], null, 2) + "\n");
}

/** Sample coach lessons in a demo series folder, unless the story coach already wrote some. */
export function seedLessons(seriesDir: string, now = new Date()): void {
  const file = join(seriesDir, "story-memory.json");
  const memory = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { episodes: [], threads: [], cameos: [], gagsUsed: {} };
  if (memory.lessons?.length) return;
  memory.lessons = [
    { id: "l1", kind: "do", text: "Tập có khung cuối không thoại được share nhiều gấp đôi; giữ punchline bằng hình.", evidence: ["ca-noc-ep-001"] },
    { id: "l2", kind: "avoid", text: "Tránh mở đầu bằng cảnh họp dài; người xem lướt qua ngay khung 1.", evidence: ["te-te-ep-001"] },
    { id: "l3", kind: "test", text: "Thử để khán giả chọn giữa hai kết ở khung cuối.", evidence: [] },
  ];
  memory.lessonsAt = now.toISOString();
  mkdirSync(seriesDir, { recursive: true });
  writeFileSync(file, JSON.stringify(memory, null, 2) + "\n");
}

/**
 * Sample post files for the demo clips (posted ones and a few approved, not yet posted), and a
 * schedule that already holds some of them. Covers borrow the sample comics' first pages.
 */
export function seedSchedule(dir: string, schedule: { save(slots: Array<{ id: string; at: string }>): unknown; list(): { slots: unknown[] } }, comics: Map<string, { cover?: string }>, now = new Date()): void {
  const posts = join(dir, "posts");
  const covers = [...comics.values()].map((c) => c.cover).filter((c): c is string => Boolean(c));
  const captions: Record<string, string> = {
    "pilot-sepvohan-1": "Sếp nghĩ vô hạn #danvanphong #hoisau",
    "pilot-luongthap-2": "Lương thấp nhưng tinh thần cao #danvanphong",
    "pilot-chikhang-3": "Chị Khang nói đúng quá #congso",
    "pilot-trasua-4": "Trà sữa là động lực #danvanphong",
    "pilot-luoi-5": "Lười có kế hoạch #hoisau",
    "pilot-gui500k-6": "Gửi 500k mừng cưới #danvanphong",
    "pilot-luatien-7": "Lừa tình cảm, không lừa tiền #hoisau",
    "pilot-trasua-13": "Trà sữa lúc 3 giờ chiều #danvanphong",
    "pilot-luatien-14": "Không thể kiếm nhiều tiền #hoisau",
    "pilot-gui500k-15": "Gửi 500k lần hai #congso",
    "pilot-luoi-16": "Lười nhưng đúng deadline #danvanphong",
    "pilot-meme-17": "Cơm tự nấu #danvanphong #hoisau",
  };
  if (!existsSync(posts)) {
    mkdirSync(posts, { recursive: true });
    Object.entries(captions).forEach(([id, caption], i) => {
      const still = covers[i % Math.max(1, covers.length)];
      writeFileSync(join(posts, `${id}.json`), JSON.stringify({ episodeId: id, format: "reels-9x16", caption, mediaUrls: [`https://hoisau.web.app/media/pilot/${id.replace(/^pilot-/, "")}.mp4`] }, null, 2) + "\n");
      if (still) writeFileSync(join(posts, `${id}-still.json`), JSON.stringify({ episodeId: `${id}-still`, format: "image-4x5", caption, mediaUrls: [still] }, null, 2) + "\n");
    });
  }
  if (!schedule.list().slots.length) {
    const hour = 3600_000;
    const base = Math.ceil(now.getTime() / hour) * hour;
    schedule.save([
      { id: "pilot-trasua-13", at: new Date(base + 2 * hour + 36 * 60_000).toISOString() },
      { id: "pilot-luatien-14", at: new Date(base + 7 * hour + 4 * 60_000).toISOString() },
      { id: "pilot-gui500k-15", at: new Date(base + 20 * hour + 44 * 60_000).toISOString() },
    ]);
  }
}
