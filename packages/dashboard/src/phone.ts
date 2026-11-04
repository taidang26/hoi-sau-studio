/**
 * The site address in one place, and the "Mở trên điện thoại" box: the dashboard runs only on
 * this computer, so the phone opens the clip on the Hồi Sau site's /tai page (save the video,
 * the cover, copy the caption for TikTok) by scanning a QR code drawn here.
 */

import QRCode from "qrcode";
import { esc } from "./views.js";
import { t } from "./i18n.js";

/** The one site everything links to; TikTok only pulls pictures from this verified host. */
export const SITE_DEFAULT = "https://hoisau.dangtrantai.com";

/** MEDIA_BASE_URL's site (its origin), else SITE_DEFAULT. */
export function siteUrl(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return env.MEDIA_BASE_URL ? new URL(env.MEDIA_BASE_URL).origin : SITE_DEFAULT;
  } catch {
    return SITE_DEFAULT;
  }
}

export const mediaBaseUrl = (env: NodeJS.ProcessEnv = process.env) => (env.MEDIA_BASE_URL || `${SITE_DEFAULT}/media/`).replace(/\/?$/, "/");

/** The /tai page, at one clip's card when an id is given. */
export const taiUrl = (id?: string, env: NodeJS.ProcessEnv = process.env) => `${siteUrl(env)}/tai${id ? `#${encodeURIComponent(id)}` : ""}`;

/** A QR code as inline SVG, drawn from the code's modules (no script on the page). */
export function qrSvg(text: string, size = 168): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 2;
  const dim = n + quiet * 2;
  let path = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(y, x)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${size}" height="${size}" role="img" aria-label="${esc(t("Mã QR"))}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#111"/></svg>`;
}

/** A button that opens to the QR code and the link, for one clip or the whole page. */
export function phoneBox(id?: string, label = t("Mở trên điện thoại")): string {
  const url = taiUrl(id);
  return `<details class="phone-box"><summary class="btn">📱 ${esc(label)}</summary><div class="phone-pop">${qrSvg(url)}<p class="small">${esc(t("Quét bằng camera điện thoại: lưu video, ảnh bìa và chép caption để đăng TikTok."))}</p><a class="small" href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ""))}</a></div></details>`;
}
