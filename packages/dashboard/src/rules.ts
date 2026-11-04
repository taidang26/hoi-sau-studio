/**
 * Luật nhà: the owner's standing rules, the ones he used to repeat in chat. Each line is
 * read by the AI that writes, draws and captions (see @hoi-sau/studio house-rules), so
 * adding one here, or ticking "áp dụng từ giờ" on a fix, changes every post after it.
 */

import { addHouseRule, loadHouseRules, removeHouseRule, RULE_AREAS, type HouseRule, type RuleArea } from "@hoi-sau/studio";
import { button, esc, flash, layout } from "./views.js";
import { t } from "./i18n.js";

export const AREA_LABEL: Record<RuleArea, string> = { caption: "Caption", art: "Hình vẽ", dialogue: "Thoại", video: "Video", post: "Đăng bài" };
const AREA_HINT: Record<RuleArea, string> = {
  caption: "Chú thích và hashtag khi đăng",
  art: "Nhân vật, bối cảnh, đồ vật trong tranh",
  dialogue: "Lời thoại trong bong bóng",
  video: "Độ dài, số cảnh, phụ đề",
  post: "Duyệt và giờ đăng",
};

export const isArea = (v: unknown): v is RuleArea => (RULE_AREAS as readonly string[]).includes(String(v));

export function rulesPage(rules: HouseRule[] = loadHouseRules(), ok?: string, err?: string): string {
  const groups = RULE_AREAS.map((a) => {
    const mine = rules.filter((r) => r.area === a);
    return `<section class="card rules-card"><div class="card-head"><h2>${esc(t(AREA_LABEL[a]))}</h2><span class="muted small">${esc(t(AREA_HINT[a]))}</span></div>
${mine.length ? `<ul class="rules">${mine.map((r) => `<li><span>${esc(r.text)}</span>${button(`/rules/${encodeURIComponent(r.id)}/delete`, "✕", "btn ghost", {})}</li>`).join("")}</ul>` : `<p class="muted small">${esc(t("Chưa có luật nào."))}</p>`}</section>`;
  }).join("");
  const form = `<form class="card form rules-add" method="post" action="/rules"><h2>${esc(t("Thêm luật"))}</h2>
<div class="row"><select name="area" aria-label="${esc(t("Loại"))}">${RULE_AREAS.map((a) => `<option value="${a}">${esc(t(AREA_LABEL[a]))}</option>`).join("")}</select>
<input name="text" required maxlength="300" placeholder="${esc(t("vd: không dùng chữ \"sếp\" trong caption"))}"><button class="btn on">${esc(t("Thêm"))}</button></div></form>`;
  const body = `<header class="page-head"><div><h1>${esc(t("Luật nhà"))}</h1><p class="muted">${esc(t("Những điều anh muốn máy luôn nhớ. Máy đọc danh sách này mỗi lần viết thoại, vẽ tranh, làm video và viết caption."))}</p></div></header>
${flash(ok, err)}${form}<div class="rules-grid">${groups}</div>`;
  return layout(t("Luật nhà"), "/rules", body);
}

export { addHouseRule, removeHouseRule };
