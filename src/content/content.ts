/**
 * Isolated-world content script on Ad Library pages. Holds the ads observed on this page,
 * answers popup/background queries, and performs the "load everything" auto-scroll scan.
 */
import { parseStartedLabel } from '../shared/dates';
import { extractFromJson, mediaKey, mergeAd } from '../shared/parse';
import type { AdRecord, Creative, PageInfo, ScanProgress, TabState } from '../shared/types';

declare global {
  interface Window {
    __advaultContent?: boolean;
  }
}

const MSG = '__advault_ads__';
const MAX_ADS = 5000;
const SCAN_STEP_MS = 1500;
const SCAN_IDLE_LIMIT = 8; // consecutive scroll steps without new ads before we stop
const SCAN_MAX_MS = 15 * 60_000;
const KEY_CHANGE_GRACE_MS = 4000;

if (!window.__advaultContent) {
  window.__advaultContent = true;
  init();
}

function init() {
  const lateInjection = document.readyState === 'complete';
  const store = new Map<string, AdRecord>();
  let pageInfo: PageInfo | null = null;
  let urlKey = keyFor(location.href);
  let keyChangedAt = 0;
  let scanning: Promise<ScanProgress> | null = null;
  let cancelScan = false;

  const add = (ads: AdRecord[]) => {
    for (const ad of ads) store.set(ad.id, mergeAd(store.get(ad.id), ad));
  };

  // 1) Records forwarded by the MAIN-world hook (GraphQL pagination responses).
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[MSG] !== true) return;
    if (Array.isArray(e.data.ads)) add(e.data.ads as AdRecord[]);
    if (e.data.pageInfo) {
      const next = e.data.pageInfo as PageInfo;
      // Later pages may omit the total count; keep the one we already have.
      pageInfo = { ...next, count: next.count ?? pageInfo?.count ?? null };
    }
  });

  // 2) The first page of results is server-rendered as JSON inside <script> tags.
  const readEmbedded = () => {
    for (const s of Array.from(document.querySelectorAll('script[type="application/json"]'))) {
      const t = s.textContent || '';
      if (!t.includes('ad_archive_id')) continue;
      try {
        const r = extractFromJson(JSON.parse(t));
        add(r.ads);
        if (r.pageInfo && !pageInfo) pageInfo = r.pageInfo;
      } catch {
        /* ignore malformed blobs */
      }
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', readEmbedded, { once: true });
  else readEmbedded();

  // 3) Track in-page navigation (new search / filter changes) so stale results are not mixed in.
  setInterval(() => {
    const k = keyFor(location.href);
    if (k !== urlKey) {
      urlKey = k;
      keyChangedAt = Date.now();
      pageInfo = null;
    }
  }, 500);

  const context = () => {
    const u = new URL(location.href);
    const p = u.searchParams;
    const pageId = p.get('view_all_page_id');
    const singleId = p.get('id');
    const query = p.get('q');
    const mode: TabState['mode'] = pageId ? 'advertiser' : singleId ? 'single' : query ? 'search' : 'none';
    return { pageId, singleId, query, mode };
  };

  const currentAds = (): AdRecord[] => {
    const ctx = context();
    const since = keyChangedAt ? keyChangedAt - KEY_CHANGE_GRACE_MS : 0;
    const out: AdRecord[] = [];
    for (const ad of store.values()) {
      if (ad.seenAt < since) continue;
      if (ctx.mode === 'advertiser' && ad.pageId && ad.pageId !== ctx.pageId) continue;
      if (ctx.mode === 'single' && ad.id !== ctx.singleId) continue;
      if (ctx.mode === 'none') continue;
      out.push(ad);
    }
    return out;
  };

  const currentPageInfo = () => (pageInfo && pageInfo.at >= (keyChangedAt ? keyChangedAt - KEY_CHANGE_GRACE_MS : 0) ? pageInfo : null);

  /** Rebuild records for ads visible in the page that we have no structured data for. */
  function collectFromDom(onlyCount = false): number {
    const ids = new Map<string, HTMLElement>();
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const m = n.nodeValue?.match(/Library ID:?\s*(\d{6,})/);
      if (m && n.parentElement && !ids.has(m[1])) ids.set(m[1], n.parentElement);
    }
    if (onlyCount) return ids.size;
    for (const [id, el] of ids) {
      if (store.has(id)) continue;
      // Climb to the ad card: the largest ancestor that still contains only this one Library ID.
      let card: HTMLElement = el;
      while (card.parentElement && (card.parentElement.innerText.match(/Library ID/g) || []).length <= 1) card = card.parentElement;
      const text = card.innerText || '';
      const start = parseStartedLabel(text);
      const creatives: Creative[] = [];
      const seen = new Set<string>();
      const push = (url: string | null | undefined, type: Creative['type'], quality: string, poster?: string) => {
        if (!url || !/^https?:\/\//.test(url)) return;
        const key = mediaKey(url);
        if (seen.has(key)) return;
        seen.add(key);
        creatives.push({ url, type, quality, poster, key });
      };
      card.querySelectorAll('video').forEach((v) => push(v.currentSrc || v.src, 'video', 'page', v.poster || undefined));
      card.querySelectorAll('img').forEach((img) => {
        if (img.naturalWidth && img.naturalWidth < 120) return; // skip avatars / icons
        push(img.currentSrc || img.src, 'image', 'page');
      });
      const ctx = context();
      add([
        {
          id,
          pageId: ctx.pageId,
          pageName: null,
          isActive: /\bActive\b/.test(text) ? true : /\bInactive\b/.test(text) ? false : null,
          startDate: start,
          startDateSource: start ? 'dom' : null,
          endDate: null,
          displayFormat: null,
          body: null,
          title: null,
          linkUrl: null,
          creatives,
          seenAt: Date.now(),
          fromDom: true,
        },
      ]);
    }
    return ids.size;
  }

  const state = (): TabState => {
    const ctx = context();
    const ads = currentAds();
    const names = new Map<string, number>();
    for (const a of ads) if (a.pageName) names.set(a.pageName, (names.get(a.pageName) || 0) + 1);
    const top = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const pageIds = new Set(ads.map((a) => a.pageId).filter(Boolean));
    const pi = currentPageInfo();
    return {
      ok: true,
      onAdLibrary: true,
      mode: ctx.mode,
      pageId: ctx.pageId,
      query: ctx.query,
      advertiserName: ctx.mode === 'search' && pageIds.size > 1 ? null : top,
      advertiserCount: pageIds.size,
      adsLoaded: ads.length,
      totalReported: pi?.count ?? null,
      hasNextPage: pi?.hasNextPage ?? null,
      domAdCount: collectFromDom(true),
      lateInjection,
      url: location.href,
    };
  };

  const progress = (done: boolean, reason?: string): ScanProgress => {
    const pi = currentPageInfo();
    const p: ScanProgress = { adsLoaded: currentAds().length, totalReported: pi?.count ?? null, done, reason };
    chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', progress: p }).catch(() => {});
    return p;
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function scan(): Promise<ScanProgress> {
    cancelScan = false;
    const startedAt = Date.now();
    let idle = 0;
    let last = currentAds().length;
    let reason = 'all results loaded';
    progress(false);
    for (;;) {
      if (cancelScan) {
        reason = 'cancelled';
        break;
      }
      const pi = currentPageInfo();
      if (pi && pi.hasNextPage === false) break;
      const el = document.scrollingElement || document.documentElement;
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      window.dispatchEvent(new Event('scroll'));
      await sleep(SCAN_STEP_MS);
      if (lateInjection) collectFromDom();
      const count = currentAds().length;
      if (count > last) {
        last = count;
        idle = 0;
      } else idle++;
      progress(false);
      if (idle >= SCAN_IDLE_LIMIT) {
        reason = pi ? 'no more results loaded' : 'end of page reached';
        break;
      }
      if (count >= MAX_ADS) {
        reason = `stopped at the ${MAX_ADS}-ad safety limit`;
        break;
      }
      if (Date.now() - startedAt > SCAN_MAX_MS) {
        reason = 'stopped after 15 minutes';
        break;
      }
    }
    if (lateInjection) collectFromDom();
    return progress(true, reason);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'PING':
        sendResponse({ ok: true });
        return false;
      case 'GET_STATE':
        sendResponse(state());
        return false;
      case 'GET_ADS':
        if (lateInjection) collectFromDom();
        sendResponse({ ads: currentAds(), state: state() });
        return false;
      case 'SCAN':
        if (!scanning) scanning = scan().finally(() => (scanning = null));
        scanning.then((p) => sendResponse({ progress: p, ads: currentAds(), state: state() }));
        return true;
      case 'CANCEL_SCAN':
        cancelScan = true;
        sendResponse({ ok: true });
        return false;
    }
    return false;
  });
}

function keyFor(href: string): string {
  try {
    const u = new URL(href);
    const p = new URLSearchParams(u.search);
    // Facebook rewrites these after load; they don't change which ads match.
    for (const k of [...p.keys()]) if (k === 'is_targeted_country' || k.startsWith('sort_data')) p.delete(k);
    p.sort();
    return u.pathname + '?' + p.toString();
  } catch {
    return href;
  }
}
