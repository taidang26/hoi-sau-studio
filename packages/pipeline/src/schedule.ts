/**
 * Daily timing in Hanoi time (UTC+7, no daylight saving), whatever the
 * machine's own time zone is.
 */

const HANOI_OFFSET_MS = 7 * 3600_000;

/** "2026-11-01" for the Hanoi calendar day containing `now`. */
export const hanoiDate = (now: Date) => new Date(now.getTime() + HANOI_OFFSET_MS).toISOString().slice(0, 10);

export function parseTime(hhmm: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Time must be HH:MM, got "${hhmm}"`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

/** Today's slot at `hhmm` Hanoi time, as an instant. */
export function slotOn(date: string, hhmm: string): Date {
  const { h, m } = parseTime(hhmm);
  return new Date(Date.parse(`${date}T00:00:00Z`) - HANOI_OFFSET_MS + (h * 60 + m) * 60_000);
}

/** The next slot strictly after `now`. */
export function nextSlot(now: Date, hhmm: string): Date {
  const today = slotOn(hanoiDate(now), hhmm);
  return today.getTime() > now.getTime() ? today : new Date(today.getTime() + 86_400_000);
}

/**
 * Whether a scheduler that starts at `now` should run straight away: today's
 * slot has passed and today has no successful run yet (the machine was off).
 */
export const missedToday = (now: Date, hhmm: string, ranToday: boolean) => !ranToday && slotOn(hanoiDate(now), hhmm).getTime() <= now.getTime();
