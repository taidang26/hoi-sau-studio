/**
 * An offline stand-in for Muse Spark, so listening and recap run end to end
 * without META_API_KEY. It answers with simple keyword rules: good enough to
 * show the flow and to test it, not to replace the model.
 */

import { COACH_TASK } from "./coach.js";
import { FIRST_COMMENT_TASK, REPLY_TASK } from "./engage.js";
import { SAFETY_TASK } from "./safety.js";
import { RECAP_TASK } from "./recap.js";
import { SCORE_TASK } from "./listen.js";
import type { Llm, LlmRequest, LlmResult } from "./llm.js";
import { fold, hasPhrase, jaccard, keywords } from "./text.js";

/** Topic words (folded) → cluster label. First match wins. */
const TOPICS: Array<[string[], string]> = [
  [["ngu gat", "ngu quen", "ngu tren ban", "ngap"], "ngu-gat"],
  [["tang luong", "luong", "thuong tet", "thuong"], "tang-luong"],
  [["team building", "du lich", "da ngoai"], "team-building"],
  [["may in", "ket giay"], "may-in"],
  [["sinh nhat", "banh kem"], "sinh-nhat"],
  [["crush", "hen ho", "to tinh", "thich tham"], "crush-van-phong"],
  [["ca phe", "cafe", "pantry"], "may-ca-phe"],
  [["hop", "meeting", "sync"], "cuoc-hop"],
  [["deadline", "tre", "gap"], "deadline"],
  [["sep", "boss", "truong phong"], "sep"],
  [["tet", "du an tet"], "du-an-tet"],
];

const IDEA_CUES = ["cho", "tap sau", "de", "nen", "hay la", "gia ma", "muon xem", "thu", "neu", "lam sao", "bat", "phai"];
const UNSAFE_CUES = ["chinh tri", "ton giao", "san", "an thit", "danh nhau", "danh", "beo", "xau", "bac ky", "nam ky"];
const OFF_CUES = ["bo viec", "nghi viec", "chui sep", "tu bo", "cai sep"];

/** What the model would do: drop emoji, "tập sau", "đi ad", and start with a capital. */
function cleanIdea(text: string): string {
  const t = text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/^\s*(\+1|ad ơi|admin ơi|ad|admin)[,: ]*/i, "")
    .replace(/^\s*tập sau\s*/i, "")
    .replace(/\s*(đi ad|nhé|nha|đi|ad)?\s*[!.]*\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function scoreOne(text: string, leadName: string, told: Set<string>[]) {
  const f = fold(text);
  const unsafe = UNSAFE_CUES.some((c) => hasPhrase(f, c));
  const off = OFF_CUES.some((c) => hasPhrase(f, c));
  const ideaLike = IDEA_CUES.some((c) => hasPhrase(f, c)) && f.split(" ").length >= 4;
  const verdict = unsafe ? "unsafe" : off ? "off-character" : ideaLike ? "idea" : text.trim().endsWith("?") ? "question" : "reaction";
  const cluster = TOPICS.find(([cues]) => cues.some((c) => hasPhrase(f, c)))?.[1] ?? f.split(" ").slice(0, 2).join("-");
  const fun = Math.min(5, 2 + (/(haha|kkk|=\)\)|:\)\)|🤣|😂)/i.test(text) ? 1 : 0) + (text.includes("!") ? 1 : 0) + (cluster !== f.split(" ").slice(0, 2).join("-") ? 1 : 0));
  const fit = Math.min(5, 3 + (hasPhrase(f, fold(leadName)) ? 1 : 0) + (cluster === "deadline" || cluster === "du-an-tet" ? 1 : 0));
  const fresh = told.some((t) => jaccard(t, keywords(text)) >= 0.3) ? 1 : 3;
  const idea = verdict === "idea" ? cleanIdea(text) : "";
  return { verdict, idea, cluster, scores: { fun, fit, fresh }, reason: `mock: ${verdict}` };
}

export function mockLlm(): Llm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    model: "mock-muse-spark",
    calls,
    async complete(req: LlmRequest): Promise<LlmResult> {
      calls.push(req);
      if (req.task === SCORE_TASK) {
        const comments = JSON.parse(/COMMENTS_JSON: (.*)$/m.exec(req.user)![1]) as Array<{ id: string; text: string }>;
        const leadName = /Nhân vật chính tập tới: ([^(]+)\(/.exec(req.system)?.[1].trim() ?? "";
        const toldLine = /Đã kể rồi[^:]*: (.*)\.$/m.exec(req.system)?.[1] ?? "";
        const told = toldLine ? toldLine.split("; ").map((t) => keywords(t)) : [];
        return { text: JSON.stringify({ items: comments.map((c) => ({ commentId: c.id, ...scoreOne(c.text, leadName, told) })) }) };
      }
      if (req.task === RECAP_TASK) {
        const open = JSON.parse(/OPEN_THREADS_JSON: (.*)$/m.exec(req.user)![1]) as Array<{ id: string; text: string }>;
        const body = req.user.split("EPISODE:\n")[1] ?? "";
        const lines = body.split("\n").filter(Boolean);
        const kw = keywords(body);
        return {
          text: JSON.stringify({
            summary: lines.slice(1, 3).join(" ") || lines[0] || "Một ngày ở văn phòng.",
            threads_closed: open.filter((t) => jaccard(keywords(t.text), kw) >= 0.08 && [...keywords(t.text)].filter((w) => kw.has(w)).length >= 3).map((t) => t.id),
            threads_opened: [],
          }),
        };
      }
      if (req.task === COACH_TASK) {
        // Rows arrive best first. Compare the top and bottom halves by lead and by audience origin.
        const rows = JSON.parse(/EPISODES_JSON: (.*)$/m.exec(req.user)![1]) as Array<{ id: string; lead?: string; title?: string; from_audience: boolean }>;
        const half = Math.ceil(rows.length / 2);
        const top = rows.slice(0, half);
        const bottom = rows.slice(half);
        const lessons = [];
        const lead = top[0].lead;
        const leadTop = top.filter((r) => r.lead === lead);
        if (lead) lessons.push({ kind: "do", text: `Tập có ${lead} làm nhân vật chính được nhiều người bình luận nhất; giữ ${lead} ở vai chính.`, evidence: leadTop.map((r) => r.id) });
        const fromAudience = rows.filter((r) => r.from_audience);
        if (fromAudience.length && top.some((r) => r.from_audience))
          lessons.push({ kind: "do", text: "Tập viết từ ý của khán giả kéo thêm người bình luận; tiếp tục ghi công người góp ý.", evidence: fromAudience.map((r) => r.id) });
        const worst = bottom[bottom.length - 1];
        if (worst) lessons.push({ kind: "avoid", text: `Tình huống kiểu "${worst.title ?? worst.id}" ít người hưởng ứng; tránh lặp lại.`, evidence: bottom.map((r) => r.id) });
        lessons.push({ kind: "test", text: "Thử kết tập bằng một câu hỏi hai lựa chọn để khán giả dễ bình luận.", evidence: [] });
        return { text: JSON.stringify({ lessons }) };
      }
      if (req.task === REPLY_TASK) {
        // Skip bare laughs and tags; thank ideas; answer questions with a shrug in the character's catchphrase.
        const comments = JSON.parse(/COMMENTS_JSON: (.*)$/m.exec(req.user)![1]) as Array<{ id: string; text: string; name?: string }>;
        const catchphrase = /Câu cửa miệng \(dùng ít\): ([^/.]+?)(?: \/|\.)/.exec(req.system)?.[1].replace(/…$/, "").trim();
        return {
          text: JSON.stringify({
            items: comments.map((c) => {
              const f = fold(c.text);
              if (f.split(" ").filter((w) => !/^(ha)+$|^k+$/.test(w)).length < 3) return { commentId: c.id, reply: "", skip: true, reason: "mock: nothing to answer" };
              const idea = IDEA_CUES.some((x) => hasPhrase(f, x));
              const reply = idea
                ? `Ý này hay quá, để em ghi vào sổ. Mai ghé xem nha!`
                : c.text.trim().endsWith("?")
                  ? `${catchphrase ?? "Dạ"}… bí mật tới hồi sau ạ.`
                  : `Bị nói trúng tim đen luôn rồi ạ.`;
              return { commentId: c.id, reply, skip: false, reason: idea ? "mock: idea" : "mock: reaction" };
            }),
          }),
        };
      }
      if (req.task === FIRST_COMMENT_TASK) {
        const question = /QUESTION: (.*)$/m.exec(req.user)?.[1].trim() || "Tập sau nên thế nào?";
        return { text: JSON.stringify({ text: `${question} Trả lời một chữ thôi, hồi sau em vẽ.` }) };
      }
      if (req.task === SAFETY_TASK) {
        // Flags what the keyword rules for scoring would call unsafe.
        const texts = JSON.parse(/TEXTS_JSON: (.*)$/m.exec(req.user)![1]) as Array<{ where: string; text: string }>;
        const issues = texts
          .filter((t) => UNSAFE_CUES.some((c) => hasPhrase(fold(t.text), c)))
          .map((t) => ({ where: t.where, topic: "unsafe", detail: `mock: "${UNSAFE_CUES.find((c) => hasPhrase(fold(t.text), c))}"` }));
        return { text: JSON.stringify({ pass: !issues.length, issues }) };
      }
      throw new Error(`mock has no answer for task ${req.task}`);
    },
  };
}
