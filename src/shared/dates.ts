/**
 * Ad Library start dates are unix timestamps at midnight Pacific time, and the Ad Library
 * itself displays them in Pacific time. We do the same so dates match what users see on Facebook.
 */
export const AD_LIBRARY_TZ = 'America/Los_Angeles';

function ymdInTz(ms: number, tz = AD_LIBRARY_TZ): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return [get('year'), get('month'), get('day')];
}

/** Whole calendar days between the start date and `nowMs` (both evaluated in Ad Library time). */
export function daysBetween(startSec: number, nowMs: number = Date.now()): number {
  const [y1, m1, d1] = ymdInTz(startSec * 1000);
  const [y2, m2, d2] = ymdInTz(nowMs);
  return Math.max(0, Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000));
}

/** Running duration in days: until today for active ads, until the end date for stopped ads. */
export function runningDays(
  ad: { startDate: number | null; endDate: number | null; isActive: boolean | null },
  nowMs: number = Date.now(),
): number | null {
  if (!ad.startDate) return null;
  if (ad.isActive === false && ad.endDate) return daysBetween(ad.startDate, ad.endDate * 1000);
  return daysBetween(ad.startDate, nowMs);
}

export function formatDate(sec: number | null): string {
  if (!sec) return 'Unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: AD_LIBRARY_TZ,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(sec * 1000));
}

export function isoDate(sec: number | null): string {
  if (!sec) return '';
  const [y, m, d] = ymdInTz(sec * 1000);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parse the English "Started running on …" label rendered by the Ad Library
 * ("30 Oct 2026" or "Oct 30, 2026"). Returns unix seconds at noon UTC of that date
 * (which falls on the same calendar day in Pacific time), or null if not reliably parseable.
 */
export function parseStartedLabel(text: string): number | null {
  const m1 = text.match(/Started running on\s+(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/i);
  const m2 = text.match(/Started running on\s+([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  let d: number, mon: string, y: number;
  if (m1) [d, mon, y] = [Number(m1[1]), m1[2], Number(m1[3])];
  else if (m2) [d, mon, y] = [Number(m2[2]), m2[1], Number(m2[3])];
  else return null;
  const mi = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
  if (mi < 0 || d < 1 || d > 31 || y < 2010 || y > 2100) return null;
  const ms = Date.UTC(y, mi, d, 12);
  if (new Date(ms).getUTCDate() !== d) return null;
  return ms / 1000;
}
