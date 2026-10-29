/**
 * Platform rules checked locally before publishing. A post that would be
 * rejected fails here with a readable reason, not halfway through a publish
 * with some media already uploaded.
 */

import type { Platform } from "./index.js";
import type { EpisodePost } from "./publish.js";
import { TIKTOK_PHOTO } from "./tiktok.js";

export interface RuleViolation {
  code: string;
  message: string;
}

export const LIMITS = {
  facebook: { caption: 63206, carouselMin: 2, carouselMax: 10 },
  instagram: { caption: 2200, hashtags: 30, carouselMin: 2, carouselMax: 10 },
  threads: { caption: 500, carouselMin: 2, carouselMax: 20 },
  tiktok: { caption: 2200 },
} as const;

type Rule = (platform: Platform, post: EpisodePost, caption: string) => RuleViolation | RuleViolation[] | undefined;

const HASHTAG = /(?:^|\s)#[\p{L}\p{N}_]+/gu;

const rules: Rule[] = [
  // Length in code points of the NFC form, the way Meta counts.
  (platform, _post, caption) => {
    const max = LIMITS[platform].caption;
    if (Array.from(caption).length > max) return { code: "CAPTION_TOO_LONG", message: `Caption is over ${max} characters.` };
  },

  (platform, _post, caption) => {
    if (platform !== "instagram") return;
    const max = LIMITS.instagram.hashtags;
    if ((caption.match(HASHTAG)?.length ?? 0) > max) {
      return { code: "TOO_MANY_HASHTAGS", message: `Instagram allows at most ${max} hashtags.` };
    }
  },

  (platform, post) => {
    const count = post.mediaUrls.length;
    if (platform === "tiktok") {
      if (post.format === "reels-9x16") return count === 1 ? undefined : { code: "REELS_ONE_VIDEO", message: "A TikTok post takes exactly one video." };
      if (count < 1 || count > TIKTOK_PHOTO.max) return { code: "CAROUSEL_SIZE", message: `A TikTok photo post takes 1–${TIKTOK_PHOTO.max} images, got ${count}.` };
      const bad = post.mediaUrls.filter((u) => !TIKTOK_PHOTO.formats.test(new URL(u, "https://x/").pathname));
      if (bad.length) return { code: "TIKTOK_PHOTO_FORMAT", message: `TikTok photos must be JPEG or WebP: ${bad.join(", ")}` };
      return;
    }
    switch (post.format) {
      case "carousel-4x5": {
        const { carouselMin: min, carouselMax: max } = LIMITS[platform];
        if (count < min || count > max) {
          return { code: "CAROUSEL_SIZE", message: `A carousel needs ${min}–${max} images, got ${count}.` };
        }
        return;
      }
      case "image-4x5":
        if (count !== 1) return { code: "IMAGE_ONE_FILE", message: "An image post takes exactly one image." };
        return;
      case "reels-9x16":
        if (count !== 1) return { code: "REELS_ONE_VIDEO", message: "A Reels post takes exactly one video." };
    }
  },

  // Meta downloads the media itself, so every file needs a public HTTPS URL.
  (_platform, post) =>
    post.mediaUrls
      .filter((url) => !url.startsWith("https://"))
      .map((url) => ({ code: "MEDIA_NOT_HTTPS", message: `Media must be a public HTTPS URL: ${url}` })),
];

export function validatePost(platform: Platform, post: EpisodePost): RuleViolation[] {
  const caption = post.caption.normalize("NFC");
  return rules.flatMap((rule) => rule(platform, post, caption) ?? []);
}
