/**
 * Hồi Sau may swear the way Threads does, but never spelled out: "đ*m",
 * "v*l". Every swear in a published text is masked here, whatever the model
 * wrote, so an unmasked one never reaches a bubble or a headline.
 */

/** Whole words, lowercase. Abbreviations count: they are read as the word. */
const SWEARS = ["địt", "đụ", "đéo", "đếch", "đm", "đmm", "đcm", "dm", "dmm", "dcm", "vcl", "vkl", "vl", "vãi", "lồn", "cặc", "buồi", "cứt"];
const WORD = new RegExp(`(^|[^\\p{L}*])(${SWEARS.join("|")})(?=$|[^\\p{L}*])`, "giu");

/** "đm" → "đ*m", "địt" → "đ*t", "vcl" → "v*l"; the first and last letters stay so it still reads. */
export function maskSwears(text: string): string {
  return text.replace(WORD, (_m, pre: string, w: string) => `${pre}${w[0]}*${w.length > 2 ? w.slice(-1) : w.slice(1)}`);
}
