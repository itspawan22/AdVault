/**
 * Offscreen document: downloads creatives and builds the ZIP. It lives as long as needed
 * (unlike the popup or an idle service worker) and can create blob: URLs for chrome.downloads.
 */
import { FetchError, runZipJob, type FetchedMedia } from '../shared/zipJob';
import type { AdRecord, MediaType } from '../shared/types';

const controllers = new Map<string, AbortController>();
let liveUrls: string[] = [];

const HASH_LIMIT = 300 * 1024 * 1024;

async function fetchMedia(url: string, type: MediaType, signal: AbortSignal): Promise<FetchedMedia> {
  const timeout = AbortSignal.timeout(type === 'video' ? 5 * 60_000 : 60_000);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.any([signal, timeout]),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  } catch (e) {
    if (signal.aborted) throw new FetchError('cancelled', false);
    if (timeout.aborted) throw new FetchError('timed out', true);
    throw new FetchError(`network error (${e instanceof Error ? e.message : e})`, true);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    const label = res.status === 403 ? 'access denied / link expired' : res.status === 404 ? 'not found' : res.statusText;
    throw new FetchError(`HTTP ${res.status}${label ? ` (${label})` : ''}`, retryable);
  }
  const blob = await res.blob();
  return { blob, contentType: res.headers.get('content-type') };
}

async function hash(blob: Blob): Promise<string> {
  // Very large files are not hashed (to bound memory); URL de-duplication still applies.
  if (blob.size > HASH_LIMIT) return `size:${blob.size}:${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function run(jobId: string, advertiser: string, ads: AdRecord[]) {
  // Release archives from any earlier job.
  liveUrls.forEach((u) => URL.revokeObjectURL(u));
  liveUrls = [];
  const ctrl = new AbortController();
  controllers.set(jobId, ctrl);
  let lastSent = 0;
  try {
    const result = await runZipJob(advertiser, ads, {
      signal: ctrl.signal,
      fetchMedia,
      hash,
      onProgress(stats, message) {
        const now = Date.now();
        if (now - lastSent < 150 && message !== 'Done') return;
        lastSent = now;
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROGRESS', jobId, stats, message }).catch(() => {});
      },
      async emitZip(blob, filename) {
        const url = URL.createObjectURL(blob);
        liveUrls.push(url);
        // Waits until Chrome has finished writing the file (or failed) before continuing.
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_ZIP', jobId, url, filename });
      },
    });
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_DONE', jobId, result });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', jobId, error: e instanceof Error ? e.message : String(e) });
  } finally {
    controllers.delete(jobId);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'OFFSCREEN_RUN') {
    void run(msg.jobId, msg.advertiser, msg.ads);
    sendResponse({ ok: true });
  } else if (msg?.type === 'OFFSCREEN_CANCEL') {
    controllers.get(msg.jobId)?.abort();
    sendResponse({ ok: true });
  }
  return false;
});
