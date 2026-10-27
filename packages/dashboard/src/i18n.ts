/**
 * Two languages for the interface. Vietnamese is written in place and is the
 * key; English comes from EN below. The language is per request (a cookie),
 * carried through async work by AsyncLocalStorage, so views just call t().
 * Content (profiles, comments, scripts) is shown as written.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { EN } from "./i18n-en.js";

export type Lang = "vi" | "en";
export const LANGS: Lang[] = ["vi", "en"];

const current = new AsyncLocalStorage<Lang>();

export const withLang = <T>(lang: Lang, fn: () => T): T => current.run(lang, fn);
export const lang = (): Lang => current.getStore() ?? "vi";

/** `{name}` placeholders are filled from vars. */
export function t(vi: string, vars?: Record<string, string | number>): string {
  const s = lang() === "en" ? (EN[vi] ?? vi) : vi;
  return vars ? s.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Language from the `lang` cookie; Vietnamese until someone switches. */
export const pickLang = (cookie?: string): Lang => (cookie?.match(/(?:^|;\s*)lang=(vi|en)\b/)?.[1] as Lang | undefined) ?? "vi";

export const locale = () => (lang() === "en" ? "en-GB" : "vi-VN");
