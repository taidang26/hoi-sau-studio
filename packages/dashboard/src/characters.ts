/**
 * Create and edit a character from the dashboard. A new one comes either from
 * one line of idea (Muse Spark writes the profile) or from this form. Edits
 * go into profile.yaml in place, so hand-written comments survive.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, type Scalar, type YAMLMap } from "yaml";
import { nameVi, slugify, validateProfile, writeProfile, type Profile } from "@hoi-sau/studio";
import { lang, t } from "./i18n.js";
import { esc, layout } from "./views.js";

const lines = (v: string | null) =>
  (v ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

const STATUSES: Array<[Profile["status"], string]> = [
  ["candidate", "Đang thử"],
  ["active", "Đang dùng"],
  ["retired", "Tạm nghỉ"],
];

/** The name for the current language. */
const shown = (p: Profile) => (lang() === "vi" ? nameVi(p) : p.name);

/** What the form changes, checked with messages a person can act on. */
function readForm(form: URLSearchParams) {
  const text = (k: string) => (form.get(k) ?? "").trim();
  const palette = form
    .getAll("swatch_hex")
    .map((hex, i) => ({ name: (form.getAll("swatch_name")[i] ?? "").trim(), hex: hex.trim().toUpperCase() }))
    .filter((s) => /^#[0-9A-F]{6}$/.test(s.hex) && s.name);
  const v = {
    name: text("name"),
    name_vi: text("name_vi"),
    species: text("species"),
    role: text("role"),
    office_type: text("office_type"),
    core_gag: text("core_gag"),
    status: (text("status") || "candidate") as Profile["status"],
    want: text("want"),
    fear: text("fear"),
    contradiction: text("contradiction"),
    life: lines(form.get("life")),
    comic_engine: lines(form.get("comic_engine")),
    personality: lines(form.get("personality")),
    catchphrases: lines(form.get("catchphrases")),
    never_says: lines(form.get("never_says")),
    description: text("description"),
    signature: lines(form.get("signature")),
    props: lines(form.get("props")),
    palette,
  };
  const problems: string[] = [];
  if (!v.name) problems.push(t("Cần tên nhân vật."));
  if (!v.species) problems.push(t("Cần loài vật."));
  if (!v.role || !v.office_type || !v.core_gag) problems.push(t("Cần vai trò, kiểu người và miếng hài chính."));
  if (!v.description) problems.push(t("Cần mô tả ngoại hình để AI vẽ."));
  if (v.signature.length < 2) problems.push(t("Cần ít nhất 2 nét nhận diện."));
  if (!v.palette.length) problems.push(t("Cần ít nhất 1 màu."));
  if (v.personality.length < 3) problems.push(t("Cần ít nhất 3 nét tính cách."));
  if (!v.catchphrases.length) problems.push(t("Cần ít nhất 1 câu cửa miệng."));
  if (v.never_says.length < 3) problems.push(t("Cần ít nhất 3 điều không bao giờ nói."));
  if (!STATUSES.some(([s]) => s === v.status)) problems.push("status");
  if (problems.length) throw new Error(problems.join(" "));
  return v;
}

/** Saves the form as a new character, or into an existing profile. Returns the slug. */
export function saveCharacter(form: URLSearchParams, dir: string, slug?: string): string {
  const v = readForm(form);
  const optional = (k: "want" | "fear" | "contradiction") => (v[k] ? v[k] : undefined);
  if (!slug) {
    const id = slugify(v.species.replace(/\(.*\)/, "") || v.name) || slugify(v.name);
    if (!id) throw new Error(t("Cần tên nhân vật."));
    if (existsSync(join(dir, id))) throw new Error(t("Đã có nhân vật {name}.", { name: id }));
    const profile = validateProfile(
      {
        slug: id,
        name: v.name,
        name_vi: v.name_vi || undefined,
        species: v.species,
        status: v.status,
        office_type: v.office_type,
        core_gag: v.core_gag,
        role: v.role,
        want: optional("want"),
        fear: optional("fear"),
        contradiction: optional("contradiction"),
        life: v.life.length ? v.life : undefined,
        comic_engine: v.comic_engine.length ? v.comic_engine : undefined,
        look: {
          style: "flat 2D comic, thick black outline, flat colors, minimal shading, simple shapes",
          description: v.description,
          signature: v.signature,
          palette: v.palette,
          props: v.props,
          expressions: { default: "neutral, calm" },
          character_sheet: null,
        },
        personality: v.personality,
        voice: { register: v.office_type, speech_pattern: v.core_gag, catchphrases: v.catchphrases, sample_lines: v.catchphrases },
        never_says: v.never_says,
        memory: { episodes: [] },
      },
      id,
    );
    writeProfile(JSON.parse(JSON.stringify(profile)) as Profile, dir);
    return id;
  }

  const file = join(dir, slug, "profile.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  const set = (path: Array<string | number>, value: unknown) => {
    if (value === undefined || (Array.isArray(value) && !value.length)) {
      if (doc.hasIn(path)) doc.deleteIn(path);
    } else doc.setIn(path, value);
  };
  for (const k of ["name", "species", "role", "office_type", "core_gag", "status"] as const) set([k], v[k]);
  if (v.name_vi) {
    if (doc.hasIn(["name_vi"])) doc.setIn(["name_vi"], v.name_vi);
    else {
      // Right under `name`, where a person looks for it.
      const items = (doc.contents as YAMLMap).items;
      const at = items.findIndex((i) => (i.key as Scalar).value === "name");
      items.splice(at + 1, 0, doc.createPair("name_vi", v.name_vi));
    }
  } else set(["name_vi"], undefined);
  for (const k of ["want", "fear", "contradiction"] as const) set([k], optional(k));
  set(["life"], v.life);
  set(["comic_engine"], v.comic_engine);
  set(["personality"], v.personality);
  set(["voice", "catchphrases"], v.catchphrases);
  set(["never_says"], v.never_says);
  set(["look", "description"], v.description);
  set(["look", "signature"], v.signature);
  set(["look", "props"], v.props.length ? v.props : []);
  set(["look", "palette"], doc.createNode(v.palette, { flow: true }));
  // Refuse to write anything Studio could not read back.
  validateProfile(doc.toJS(), slug);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return slug;
}

const field = (name: string, label: string, value: string | undefined, hint = "", required = false) =>
  `<label>${esc(t(label))}${hint ? `<small>${esc(t(hint))}</small>` : ""}<input name="${name}" value="${esc(value ?? "")}"${required ? " required" : ""}></label>`;
const area = (name: string, label: string, value: string | string[] | undefined, hint = "", rows = 3, required = false) =>
  `<label>${esc(t(label))}${hint ? `<small>${esc(t(hint))}</small>` : ""}<textarea name="${name}" rows="${rows}"${required ? " required" : ""}>${esc(Array.isArray(value) ? value.join("\n") : (value ?? ""))}</textarea></label>`;

function paletteRows(p?: Profile): string {
  const swatches = [...(p?.look.palette ?? [])];
  while (swatches.length < 6) swatches.push({ name: "", hex: "" });
  return swatches
    .map(
      (s, i) =>
        `<div class="swatch-row"><input type="color" name="swatch_hex" value="${esc(s.hex || ["#E3B23C", "#B07A4F", "#F3E2C7", "#5A3A24", "#7FB7E6", "#E86A5C"][i])}" aria-label="${esc(t("Màu"))} ${i + 1}"><input name="swatch_name" value="${esc(s.name)}" placeholder="${esc(t(i ? "Phần nào? (để trống nếu không dùng)" : "Phần nào? Ví dụ: lông, áo"))}"></div>`,
    )
    .join("");
}

/** The full profile as a form, empty for a new character. */
export function profileForm(p: Profile | undefined, action: string): string {
  return `<form class="form char-form" method="post" action="${esc(action)}">
<section class="card"><h2>${t("Cơ bản")}</h2><div class="row2">
${field("name_vi", "Tên tiếng Việt", p?.name_vi, "Dùng trong bài đăng và lời thoại tiếng Việt")}
${field("name", "Tên quốc tế", p?.name, "Dùng cho bản tiếng Anh", true)}
</div><div class="row2">${field("species", "Loài vật", p?.species, "Ví dụ: cu li, cá nóc, tê tê", true)}
<label>${t("Trạng thái")}<select name="status">${STATUSES.map(([s, l]) => `<option value="${s}"${(p?.status ?? "candidate") === s ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label></div>
<div class="row3">${field("role", "Công việc", p?.role, "Làm gì trong văn phòng", true)}${field("office_type", "Kiểu người", p?.office_type, "Một cụm từ", true)}${field("core_gag", "Miếng hài chính", p?.core_gag, "Chuyện gì lặp lại là buồn cười", true)}</div></section>
<section class="card"><h2>${t("Ngoại hình")}</h2><div class="row2">
${area("description", "Mô tả để AI vẽ", p?.look.description, "Viết tiếng Anh thì AI vẽ đúng hơn", 6, true)}
<div class="stack">${area("signature", "Nét nhận diện, không được vẽ sai", p?.look.signature, "Mỗi dòng một nét, ít nhất 2", 4, true)}${area("props", "Đồ vật hay cầm", p?.look.props, "Mỗi dòng một món", 2)}</div></div>
<fieldset class="palette"><legend>${t("Bảng màu")}</legend>${paletteRows(p)}</fieldset></section>
<section class="card"><h2>${t("Tính cách và giọng")}</h2><div class="row2">
${area("personality", "Tính cách", p?.personality, "Mỗi dòng một nét, ít nhất 3", 4, true)}
${area("catchphrases", "Câu cửa miệng", p?.voice.catchphrases, "Mỗi dòng một câu", 4, true)}
${area("never_says", "Không bao giờ nói", p?.never_says, "Mỗi dòng một điều, ít nhất 3", 4, true)}
${area("comic_engine", "Tình huống gây cười", p?.comic_engine, "Mỗi dòng một tình huống", 4)}</div></section>
<section class="card"><h2>${t("Con người")}</h2><div class="row3">${field("want", "Muốn", p?.want)}${field("fear", "Sợ", p?.fear)}${field("contradiction", "Mâu thuẫn", p?.contradiction)}</div>
${area("life", "Đời sống ngoài giờ làm", p?.life, "Mỗi dòng một chi tiết", 3)}</section>
<div class="sticky-save"><button class="btn on">${t(p ? "Lưu thay đổi" : "Tạo nhân vật")}</button>${p ? `<a class="btn" href="/characters/${esc(p.slug)}">${t("Huỷ")}</a>` : ""}</div></form>`;
}

export function editCharacterPage(p: Profile, portrait: string, error?: string): string {
  const body = `<p><a href="/characters/${esc(p.slug)}">← ${esc(shown(p))}</a></p><header class="page-head"><div class="b-top"><img class="b-ava" src="${esc(portrait)}" alt=""><div><h1>${t("Sửa {name}", { name: esc(shown(p)) })}</h1><p class="muted">${t("Đổi xong bấm Lưu. Ngoại hình đổi nhiều thì nên vẽ lại model sheet.")}</p></div></div></header>
${error ? `<div class="warn small">${esc(error)}</div>` : ""}${profileForm(p, `/characters/${p.slug}/edit`)}`;
  return layout(t("Sửa {name}", { name: shown(p) }), "/characters", body);
}

/** Two ways to start: one line for the AI, or the whole form. */
export function newCharacterPage(mock: boolean, aiReady: boolean, error?: string, manual = false): string {
  const ai = `<form class="card form ai-start" method="post" action="/characters/new">
<div class="ai-head"><span class="spark">✦</span><div><h2>${t("Nhờ AI viết hồ sơ")}</h2><p class="muted small">${t("Một câu ý tưởng là đủ. Muse Spark viết ngoại hình, bảng màu, tính cách, giọng nói, và giữ khác hẳn dàn nhân vật đang có.")}</p></div></div>
<textarea name="idea" rows="3" required placeholder="${esc(t("Ví dụ: một con vượn đen má trắng làm thiết kế, luôn đến muộn đúng 5 phút nhưng lý do nào cũng thuyết phục"))}"></textarea>
<div class="row-actions"><button class="btn on"${aiReady ? "" : " disabled"}>${t("Viết hồ sơ")}</button>${aiReady ? (mock ? `<span class="muted small">${t("Bản thử: hồ sơ là mẫu cố định.")}</span>` : "") : `<span class="muted small">${t("Cần khoá AI Muse.")} <a href="/settings">${t("Mở Cài đặt")}</a></span>`}</div></form>`;
  const steps = `<ol class="flow"><li><b>1</b>${t("Hồ sơ")}</li><li><b>2</b>${t("Vẽ model sheet")}</li><li><b>3</b>${t("Khoá sheet")}</li><li><b>4</b>${t("Lên tập")}</li></ol>`;
  const body = `<p><a href="/characters">← ${t("Nhân vật")}</a></p><header class="page-head"><div><h1>${t("Tạo nhân vật")}</h1></div>${steps}</header>
${error ? `<div class="warn small">${esc(error)}</div>` : ""}
<div class="tabs"><a class="${manual ? "" : "on"}" href="/characters/new">✦ ${t("AI viết")}</a><a class="${manual ? "on" : ""}" href="/characters/new?manual=1">✎ ${t("Tự điền")}</a></div>
${manual ? profileForm(undefined, "/characters/new/manual") : ai}`;
  return layout(t("Tạo nhân vật"), "/characters", body);
}
