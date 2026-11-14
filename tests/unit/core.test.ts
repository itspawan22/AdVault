import { describe, expect, it } from 'vitest';
import { daysBetween, formatDate, isoDate, parseStartedLabel, runningDays } from '../../src/shared/dates';
import { csvCell, extensionFor, sanitizeName, toCsv } from '../../src/shared/files';
import { extractFromJson, extractFromText, mediaKey, mergeAd, normalizeAd } from '../../src/shared/parse';
import { rankOldest } from '../../src/shared/rank';
import type { AdRecord } from '../../src/shared/types';
import { carouselAd, imageAd, searchResponse, videoAd } from './fixtures';

// 30 Oct 2026 00:00 PDT — the exact value seen for a real ad labelled "Started running on 30 Oct 2026".
const OCT30 = 1793343600;
// 10 Nov 2026 12:00 PST
const NOW = Date.UTC(2026, 10, 10, 20);

describe('parsing Ad Library data', () => {
  it('extracts ads and paging info from a search response', () => {
    const r = extractFromJson(searchResponse([videoAd('1427624875595700', OCT30), imageAd('2', OCT30, ['a_n.jpg'])], true));
    expect(r.ads.map((a) => a.id)).toEqual(['1427624875595700', '2']);
    expect(r.pageInfo).toMatchObject({ count: 68, hasNextPage: true });
    const v = r.ads[0];
    expect(v.pageName).toBe('Allbirds');
    expect(v.startDate).toBe(OCT30);
    expect(v.startDateSource).toBe('api');
    expect(v.title).toBe("Men's Cruiser Dark Navy");
    expect(v.body).toMatch(/Super fuzzy/);
  });

  it('picks the highest quality media', () => {
    const v = normalizeAd(videoAd('1', OCT30))!;
    expect(v.creatives).toHaveLength(1);
    expect(v.creatives[0]).toMatchObject({ type: 'video', quality: 'hd' });
    expect(v.creatives[0].url).toContain('HD_1');
    expect(v.creatives[0].poster).toContain('poster_1');
    const i = normalizeAd(imageAd('2', OCT30, ['a_n.jpg']))!;
    expect(i.creatives[0]).toMatchObject({ type: 'image', quality: 'original' });
    expect(i.creatives[0].url).not.toContain('resized_');
  });

  it('falls back to SD video when HD is missing', () => {
    const raw = videoAd('1', OCT30);
    raw.snapshot.videos[0].video_hd_url = null as unknown as string;
    expect(normalizeAd(raw)!.creatives[0]).toMatchObject({ quality: 'sd' });
  });

  it('handles carousel / DCO cards, de-duplicates repeated cards, drops template text', () => {
    const c = normalizeAd(carouselAd('3', OCT30))!;
    expect(c.creatives.map((x) => x.type)).toEqual(['image', 'video']);
    expect(c.body).toBe(null); // "{{product.brand}}" is a template placeholder
    expect(c.title).toBe('Card title');
  });

  it('never uses creation_time as a start date', () => {
    const raw = videoAd('4', OCT30);
    (raw as Record<string, unknown>).start_date = null;
    const ad = normalizeAd(raw)!;
    expect(ad.startDate).toBe(null);
    expect(ad.startDateSource).toBe(null);
  });

  it('parses prefixed and multi-document response bodies', () => {
    const a = JSON.stringify(searchResponse([videoAd('10', OCT30)], true));
    const b = JSON.stringify({ label: 'extra', data: { x: [videoAd('11', OCT30)] } });
    expect(extractFromText(`for (;;);${a}`).ads).toHaveLength(1);
    const multi = extractFromText(`${a}\n${b}\n`);
    expect(multi.ads.map((x) => x.id)).toEqual(['10', '11']);
    expect(extractFromText('{"data":{}}').ads).toHaveLength(0);
  });

  it('builds URL keys that ignore CDN host and signature params', () => {
    const a = 'https://scontent.a.fbcdn.net/v/t39/123_456_n.jpg?oh=1&oe=2';
    const b = 'https://scontent.b.fbcdn.net/v/t39/123_456_n.jpg?oh=9&oe=8';
    expect(mediaKey(a)).toBe(mediaKey(b));
  });

  it('prefers structured data over DOM-reconstructed records', () => {
    const api = normalizeAd(videoAd('5', OCT30))!;
    const dom: AdRecord = { ...api, fromDom: true, startDate: OCT30 + 86400, startDateSource: 'dom', creatives: [] };
    expect(mergeAd(dom, api)).toBe(api);
    expect(mergeAd(api, dom)).toBe(api);
  });
});

describe('dates', () => {
  it('formats start dates in Ad Library (Pacific) time', () => {
    expect(formatDate(OCT30)).toBe('30 October 2026');
    expect(isoDate(OCT30)).toBe('2026-10-30');
    expect(formatDate(null)).toBe('Unavailable');
  });

  it('counts whole calendar days running', () => {
    expect(daysBetween(OCT30, NOW)).toBe(11);
    expect(daysBetween(OCT30, OCT30 * 1000)).toBe(0);
    // across a DST change (1 Nov 2026) and a leap year
    expect(daysBetween(Date.UTC(2024, 1, 28, 8) / 1000, Date.UTC(2025, 1, 28, 20))).toBe(366);
  });

  it('uses the end date for stopped ads', () => {
    expect(runningDays({ startDate: OCT30, endDate: OCT30 + 5 * 86400 + 3600 /* midnight PST after DST ends */, isActive: false }, NOW)).toBe(5);
    expect(runningDays({ startDate: OCT30, endDate: OCT30 + 5 * 86400, isActive: true }, NOW)).toBe(11);
    expect(runningDays({ startDate: null, endDate: null, isActive: true }, NOW)).toBe(null);
  });

  it('parses the English "Started running on" label, rejects junk', () => {
    expect(isoDate(parseStartedLabel('Started running on 30 Oct 2026')!)).toBe('2026-10-30');
    expect(isoDate(parseStartedLabel('Started running on Sep 24, 2025 · Total active time 2 hrs')!)).toBe('2025-09-24');
    expect(parseStartedLabel('Started running on 31 Feb 2025')).toBe(null);
    expect(parseStartedLabel('Commencé le 30 oct. 2026')).toBe(null);
  });
});

describe('oldest ranking', () => {
  const day = 86400;
  const ads = [
    normalizeAd(videoAd('100', OCT30 - 400 * day))!,
    normalizeAd(imageAd('101', OCT30 - 365 * day, ['x_n.jpg']))!,
    normalizeAd(imageAd('102', null, ['y_n.jpg']))!,
    normalizeAd(videoAd('103', OCT30 - 900 * day, { is_active: false }))!,
    ...Array.from({ length: 12 }, (_, i) => normalizeAd(videoAd(String(200 + i), OCT30 - i * day))!),
  ];

  it('ranks by earliest verified start date and caps at 10', () => {
    const r = rankOldest(ads, 10, NOW);
    expect(r.ranked).toHaveLength(10);
    expect(r.ranked[0].ad.id).toBe('100');
    expect(r.ranked[1].ad.id).toBe('101');
    expect(r.ranked[0].days).toBe(411);
    for (let i = 1; i < r.ranked.length; i++) expect(r.ranked[i - 1].days).toBeGreaterThanOrEqual(r.ranked[i].days);
  });

  it('excludes and counts ads without verified dates and inactive ads', () => {
    const r = rankOldest(ads, 10, NOW);
    expect(r.excludedNoDate).toBe(1);
    expect(r.excludedInactive).toBe(1);
    expect(r.ranked.find((e) => e.ad.id === '102' || e.ad.id === '103')).toBeUndefined();
    expect(r.totalAds).toBe(ads.length);
  });

  it('returns fewer results when fewer valid ads exist', () => {
    expect(rankOldest(ads.slice(0, 3), 10, NOW).ranked).toHaveLength(2);
  });
});

describe('files and CSV', () => {
  it('sanitizes advertiser names', () => {
    expect(sanitizeName('Allbirds')).toBe('Allbirds');
    expect(sanitizeName('L’Oréal Paris / Beauté!')).toBe('L_Oreal_Paris_Beaute');
    expect(sanitizeName('???')).toBe('Advertiser');
  });

  it('chooses extensions from content type, then URL', () => {
    expect(extensionFor('image/webp', 'https://x/a.jpg', 'image')).toBe('webp');
    expect(extensionFor(null, 'https://x/a_n.png?x=1', 'image')).toBe('png');
    expect(extensionFor('application/octet-stream', 'https://x/blob', 'video')).toBe('mp4');
  });

  it('quotes CSV cells and neutralises formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"\nok')).toBe('"say ""hi""\nok"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(toCsv(['h'], [[1]])).toBe('﻿h\r\n1\r\n');
  });
});
