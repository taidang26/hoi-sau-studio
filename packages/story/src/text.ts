/**
 * Vietnamese text helpers for matching: comments arrive with and without
 * diacritics ("deadline trễ" / "deadline tre"), so most rules match on a
 * folded form, and the few words that are only rude with their marks match on
 * the original.
 */

/** Lowercase, no diacritics, đ → d, punctuation to spaces, single spaces. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9@#\s]/g, " ")
    .replace(/(.)\1{2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export const words = (text: string) => fold(text).split(" ").filter(Boolean);

const STOP = new Set(
  "va la cua cho co khong the nay kia thi ma de voi o tren duoi mot nhung cac di den roi nua lai cung da dang se rat qua lam bi duoc ra vao ai gi sao nao nhe nha a oi ha hay".split(" "),
);

/** Words that carry meaning: folded, no stop words, at least 2 letters. */
export const keywords = (text: string) => new Set(words(text).filter((w) => w.length > 1 && !STOP.has(w)));

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** Phrase match on whole folded words: "ib" matches "check ib" but not "ibis". */
export function hasPhrase(foldedText: string, phrase: string): boolean {
  return ` ${foldedText} `.includes(` ${phrase} `);
}

export const kebab = (text: string) =>
  fold(text)
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 4)
    .join("-") || "khac";

/**
 * The name to show in the comic: a Vietnamese full name is family name first,
 * so the given name is the last word ("Nguyễn Thị Lan" → "Lan"). Handles stay
 * as they are, without the @.
 */
export function displayName(authorName: string): string {
  const name = authorName.trim().replace(/^@/, "");
  if (!name.includes(" ")) return name.slice(0, 24);
  return name.split(/\s+/).pop()!;
}

/** Stable small hash, for picking a deterministic option from a list. */
export function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
