import type { AdRecord, Creative, PageInfo } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

/** Stable de-duplication key for a CDN URL: host-independent path, without signed query params. */
export function mediaKey(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
    return base.toLowerCase();
  } catch {
    return url;
  }
}

function pushCreative(list: Creative[], seen: Set<string>, c: Omit<Creative, 'key'> | null) {
  if (!c || !/^https?:\/\//.test(c.url)) return;
  const key = mediaKey(c.url);
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ ...c, key });
}

/** Pick the highest-quality accessible video URL from an Ad Library media object. */
function pickVideo(o: any): Omit<Creative, 'key'> | null {
  if (!o || typeof o !== 'object') return null;
  const order: [string, string][] = [
    ['video_hd_url', 'hd'],
    ['video_sd_url', 'sd'],
    ['watermarked_video_hd_url', 'hd-watermarked'],
    ['watermarked_video_sd_url', 'sd-watermarked'],
  ];
  for (const [field, quality] of order) {
    const url = str(o[field]);
    if (url) return { url, type: 'video', quality, poster: str(o.video_preview_image_url) ?? undefined };
  }
  return null;
}

/** Pick the highest-quality accessible image URL from an Ad Library media object. */
function pickImage(o: any): Omit<Creative, 'key'> | null {
  if (!o || typeof o !== 'object') return null;
  const order: [string, string][] = [
    ['original_image_url', 'original'],
    ['resized_image_url', 'resized'],
    ['watermarked_resized_image_url', 'resized-watermarked'],
  ];
  for (const [field, quality] of order) {
    const url = str(o[field]);
    if (url) return { url, type: 'image', quality };
  }
  return null;
}

export function extractCreatives(snapshot: any): Creative[] {
  const list: Creative[] = [];
  const seen = new Set<string>();
  if (!snapshot || typeof snapshot !== 'object') return list;
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

  for (const v of [...arr(snapshot.videos), ...arr(snapshot.extra_videos)]) pushCreative(list, seen, pickVideo(v));
  for (const i of [...arr(snapshot.images), ...arr(snapshot.extra_images)]) pushCreative(list, seen, pickImage(i));
  for (const card of arr(snapshot.cards)) {
    // A carousel/DCO card carries either a video or an image (video wins).
    pushCreative(list, seen, pickVideo(card) ?? pickImage(card));
  }
  return list;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/** Convert one raw Ad Library ad node (has ad_archive_id + snapshot) into an AdRecord. */
export function normalizeAd(node: any, seenAt = Date.now()): AdRecord | null {
  if (!node || typeof node !== 'object') return null;
  const id = node.ad_archive_id != null ? String(node.ad_archive_id) : null;
  if (!id || !/^\d+$/.test(id) || !node.snapshot) return null;
  const s = node.snapshot;
  const firstCard = Array.isArray(s.cards) && s.cards.length ? s.cards[0] : null;
  // `start_date` is the date the ad started delivering. We deliberately never fall back
  // to `snapshot.creation_time` or similar fields, which describe ad creation, not delivery.
  const startDate = num(node.start_date);
  return {
    id,
    pageId: node.page_id != null ? String(node.page_id) : s.page_id != null ? String(s.page_id) : null,
    pageName: str(node.page_name) ?? str(s.page_name),
    isActive: typeof node.is_active === 'boolean' ? node.is_active : null,
    startDate,
    startDateSource: startDate ? 'api' : null,
    endDate: num(node.end_date),
    displayFormat: str(s.display_format),
    body: cleanText(str(s.body?.text) ?? str(firstCard?.body)),
    title: cleanText(str(s.title) ?? str(firstCard?.title)),
    linkUrl: str(s.link_url) ?? str(firstCard?.link_url),
    creatives: extractCreatives(s),
    seenAt,
  };
}

/** Dynamic-creative ads use template placeholders like {{product.name}}; treat those as unavailable. */
function cleanText(t: string | null): string | null {
  if (!t) return null;
  if (/^\s*\{\{[^}]+\}\}\s*$/.test(t)) return null;
  return t;
}

export interface ExtractResult {
  ads: AdRecord[];
  pageInfo: PageInfo | null;
}

/** Walk any parsed JSON payload, collecting ad nodes and the search connection's paging info. */
export function extractFromJson(root: unknown, seenAt = Date.now()): ExtractResult {
  const ads: AdRecord[] = [];
  let pageInfo: PageInfo | null = null;
  const stack: unknown[] = [root];
  let guard = 0;
  while (stack.length && guard++ < 2_000_000) {
    const o = stack.pop() as any;
    if (!o || typeof o !== 'object') continue;
    if (Array.isArray(o)) {
      for (let i = o.length - 1; i >= 0; i--) stack.push(o[i]);
      continue;
    }
    if (o.ad_archive_id != null && o.snapshot) {
      const ad = normalizeAd(o, seenAt);
      if (ad) ads.push(ad);
      continue;
    }
    const conn = o.search_results_connection;
    if (conn && typeof conn === 'object' && conn.page_info) {
      pageInfo = {
        count: typeof conn.count === 'number' ? conn.count : null,
        hasNextPage: typeof conn.page_info.has_next_page === 'boolean' ? conn.page_info.has_next_page : null,
        at: seenAt,
      };
    }
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return { ads, pageInfo };
}

/** Parse a Facebook network response body, which may be prefixed and/or contain several JSON documents. */
export function parseResponseText(text: string): unknown[] {
  let t = text.trim();
  if (t.startsWith('for (;;);')) t = t.slice(9);
  try {
    return [JSON.parse(t)];
  } catch {
    const out: unknown[] = [];
    for (const line of t.split(/\r?\n/)) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        /* skip partial lines */
      }
    }
    return out;
  }
}

export function extractFromText(text: string, seenAt = Date.now()): ExtractResult {
  const ads: AdRecord[] = [];
  let pageInfo: PageInfo | null = null;
  if (!text.includes('ad_archive_id')) return { ads, pageInfo };
  for (const doc of parseResponseText(text)) {
    const r = extractFromJson(doc, seenAt);
    ads.push(...r.ads);
    if (r.pageInfo) pageInfo = r.pageInfo;
  }
  return { ads, pageInfo };
}

/** Merge a newly-seen record into an existing one, keeping the most complete data. */
export function mergeAd(prev: AdRecord | undefined, next: AdRecord): AdRecord {
  if (!prev) return next;
  // Structured (API) data always supersedes records rebuilt from the rendered page.
  if (prev.fromDom && !next.fromDom) return next;
  if (next.fromDom && !prev.fromDom) return prev;
  const keys = new Set(prev.creatives.map((c) => c.key));
  const creatives = [...prev.creatives];
  for (const c of next.creatives) if (!keys.has(c.key)) creatives.push(c);
  // Prefer API-verified start dates over DOM-parsed ones.
  const useNextDate = next.startDateSource === 'api' || (!prev.startDate && next.startDate);
  return {
    ...prev,
    ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null && v !== undefined)),
    startDate: useNextDate ? next.startDate : prev.startDate,
    startDateSource: useNextDate ? next.startDateSource : prev.startDateSource,
    creatives,
    seenAt: Math.max(prev.seenAt, next.seenAt),
  } as AdRecord;
}

export const adLibraryUrl = (id: string) => `https://www.facebook.com/ads/library/?id=${id}`;
