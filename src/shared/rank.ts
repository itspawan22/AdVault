import { daysBetween, formatDate } from './dates';
import type { AdRecord, OldestResult } from './types';

/**
 * Rank the oldest currently-running ads by verified start date.
 * - Ads without a verified start date are excluded (and counted).
 * - Ads known to be inactive are excluded (and counted): they are no longer running.
 */
export function rankOldest(ads: AdRecord[], limit = 10, nowMs = Date.now()): OldestResult {
  let excludedNoDate = 0;
  let excludedInactive = 0;
  const eligible: AdRecord[] = [];
  for (const ad of ads) {
    if (!ad.startDate || !ad.startDateSource) {
      excludedNoDate++;
      continue;
    }
    if (ad.isActive === false) {
      excludedInactive++;
      continue;
    }
    eligible.push(ad);
  }
  eligible.sort((a, b) => a.startDate! - b.startDate! || a.id.localeCompare(b.id));
  return {
    ranked: eligible.slice(0, limit).map((ad) => ({
      ad,
      days: daysBetween(ad.startDate!, nowMs),
      startedLabel: formatDate(ad.startDate),
    })),
    excludedNoDate,
    excludedInactive,
    totalAds: ads.length,
  };
}
