/**
 * @hoi-sau/channel: the series' presence on Facebook, Instagram and Threads.
 * Publishes episodes for each brand, pulls comments back for listening, and
 * keeps the inbox. Characters answer comments once a person approves.
 */

export type Platform = "facebook" | "instagram" | "threads";

/**
 * - carousel-4x5: two or more 4:5 panels, swiped
 * - image-4x5: a single 4:5 page (the three-panel strip)
 * - reels-9x16: one vertical video (the motion comic)
 */
export type Format = "carousel-4x5" | "image-4x5" | "reels-9x16";

export * from "./graph.js";
export * from "./auth.js";
export * from "./login.js";
export * from "./validate.js";
export * from "./publish.js";
export * from "./threads.js";
export * from "./comments.js";
export * from "./inbox.js";
export * from "./store.js";
export * from "./brands.js";
export * from "./engage.js";
export * from "./approval.js";
