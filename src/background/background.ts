/**
 * Service worker: orchestrates scans (via the content script), ZIP jobs (via the offscreen
 * document) and saves archives with the Downloads API. Job state lives in chrome.storage.session
 * so the popup can be closed and reopened at any time.
 */
import { rankOldest } from '../shared/rank';
import { AD_LIBRARY_RE, JOB_KEY, LAST_SCAN_KEY } from '../shared/messages';
import type { AdRecord, JobKind, JobState, LastScan, TabState } from '../shared/types';

let job: JobState | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const pendingDownloads = new Map<number, (r: { ok: boolean; error?: string }) => void>();
const zipUrls = new Map<string, string>(); // filename -> blob URL (kept for retry)

async function loadJob(): Promise<JobState | null> {
  if (!job) job = ((await chrome.storage.session.get(JOB_KEY))[JOB_KEY] as JobState) ?? null;
  return job;
}

function saveJob(immediate = false) {
  if (!job) return;
  if (saveTimer) clearTimeout(saveTimer);
  const write = () => {
    saveTimer = null;
    chrome.storage.session.set({ [JOB_KEY]: job });
  };
  if (immediate) write();
  else saveTimer = setTimeout(write, 200);
}

function update(patch: Partial<JobState>, immediate = false) {
  if (!job) return;
  job = { ...job, ...patch };
  saveJob(immediate);
}

const isActiveJob = (j: JobState | null) => !!j && ['scanning', 'downloading', 'zipping', 'saving'].includes(j.phase);

async function ensureContent(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['hook.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return true;
    } catch {
      return false;
    }
  }
}

async function getTabState(tabId: number): Promise<TabState | { ok: false; onAdLibrary: boolean; url: string }> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url ?? '';
  if (!AD_LIBRARY_RE.test(url)) return { ok: false, onAdLibrary: false, url };
  if (!(await ensureContent(tabId))) return { ok: false, onAdLibrary: true, url };
  return (await chrome.tabs.sendMessage(tabId, { type: 'GET_STATE' })) as TabState;
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Download ad creatives and package them into a ZIP archive.',
    });
  } catch (e) {
    if (!String(e).includes('single offscreen')) throw e;
  }
}

async function recordLastScan(state: TabState, kind: JobKind, ads: AdRecord[]) {
  const key = state.pageId ?? state.query ?? 'unknown';
  const all = ((await chrome.storage.local.get(LAST_SCAN_KEY))[LAST_SCAN_KEY] as Record<string, LastScan>) ?? {};
  all[key] = {
    advertiser: job?.advertiser ?? '',
    ads: ads.length,
    creatives: ads.reduce((n, a) => n + a.creatives.length, 0),
    kind,
    at: Date.now(),
  };
  // Keep the 30 most recent entries.
  const trimmed = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 30));
  await chrome.storage.local.set({ [LAST_SCAN_KEY]: trimmed });
}

async function startJob(kind: JobKind, tabId: number) {
  if (isActiveJob(await loadJob())) throw new Error('Another AdVault job is already running.');
  const state = await getTabState(tabId);
  if (!state.ok) throw new Error('Open an advertiser in the Facebook Ad Library first.');
  const s = state as TabState;
  const advertiser = s.advertiserName ?? (s.query ? `Search ${s.query}` : 'Advertiser');
  job = {
    id: crypto.randomUUID(),
    kind,
    tabId,
    advertiser,
    phase: 'scanning',
    message: 'Loading all ads from the Ad Library…',
    startedAt: Date.now(),
    scan: { adsLoaded: s.adsLoaded, totalReported: s.totalReported, done: false },
  };
  saveJob(true);
  void runJob(job.id, kind, tabId);
}

async function runJob(jobId: string, kind: JobKind, tabId: number) {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'SCAN' })) as {
      ads: AdRecord[];
      state: TabState;
      progress: JobState['scan'];
    };
    if (!job || job.id !== jobId || job.phase === 'cancelled') return;
    const ads = res.ads;
    const advertiser = res.state.advertiserName ?? job.advertiser;
    update({ advertiser, scan: res.progress });
    if (res.progress.reason === 'cancelled') return;
    await recordLastScan(res.state, kind, ads);

    if (!ads.length) {
      update({ phase: 'error', message: 'No accessible ads were found on this page.', finishedAt: Date.now() }, true);
      return;
    }

    if (kind === 'oldest') {
      const oldest = rankOldest(ads, 10);
      update({ phase: 'done', oldest, message: `Ranked ${oldest.ranked.length} ads`, finishedAt: Date.now() }, true);
      return;
    }

    update({ phase: 'downloading', message: 'Preparing downloads…' }, true);
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_RUN', jobId, advertiser, ads });
  } catch (e) {
    if (job && job.id === jobId && isActiveJob(job))
      update({ phase: 'error', message: e instanceof Error ? e.message : String(e), finishedAt: Date.now() }, true);
  }
}

function saveZip(url: string, filename: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'Download could not start' });
        return;
      }
      pendingDownloads.set(id, resolve);
    });
  });
}

chrome.downloads.onChanged.addListener((d) => {
  const done = pendingDownloads.get(d.id);
  if (!done) return;
  if (d.state?.current === 'complete') {
    pendingDownloads.delete(d.id);
    done({ ok: true });
  } else if (d.state?.current === 'interrupted') {
    pendingDownloads.delete(d.id);
    done({ ok: false, error: d.error?.current ?? 'interrupted' });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'GET_TAB_STATE':
        return getTabState(msg.tabId);
      case 'START':
        await startJob(msg.kind, msg.tabId);
        return { ok: true };
      case 'CANCEL': {
        const j = await loadJob();
        if (!j || !isActiveJob(j)) return { ok: true };
        if (j.phase === 'scanning') chrome.tabs.sendMessage(j.tabId, { type: 'CANCEL_SCAN' }).catch(() => {});
        else chrome.runtime.sendMessage({ type: 'OFFSCREEN_CANCEL', jobId: j.id }).catch(() => {});
        update({ phase: 'cancelled', message: 'Cancelled', finishedAt: Date.now() }, true);
        return { ok: true };
      }
      case 'CLEAR_JOB':
        if (!isActiveJob(await loadJob())) {
          job = null;
          await chrome.storage.session.remove(JOB_KEY);
        }
        return { ok: true };
      case 'DOWNLOAD_SINGLE': {
        const id = await chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: 'uniquify' });
        return { ok: true, id };
      }
      case 'RETRY_SAVE': {
        const j = await loadJob();
        const errors: string[] = [];
        for (const name of j?.zipNames ?? []) {
          const url = zipUrls.get(name);
          if (!url) {
            errors.push(`${name}: archive no longer in memory, run the download again`);
            continue;
          }
          const r = await saveZip(url, name);
          if (!r.ok) errors.push(`${name}: ${r.error}`);
        }
        update({ downloadError: errors.length ? errors.join('; ') : undefined }, true);
        return { ok: !errors.length };
      }

      // ---- From the content script ----
      case 'SCAN_PROGRESS': {
        const j = await loadJob();
        if (j && j.phase === 'scanning' && sender.tab?.id === j.tabId) {
          update({ scan: msg.progress, message: `Loading ads… ${msg.progress.adsLoaded} found` });
        }
        return undefined;
      }

      // ---- From the offscreen document ----
      case 'OFFSCREEN_PROGRESS': {
        const j = await loadJob();
        if (!j || j.id !== msg.jobId || !isActiveJob(j)) return undefined;
        const zipping = /ZIP/.test(msg.message);
        update({ stats: msg.stats, message: msg.message, phase: zipping ? 'zipping' : 'downloading' });
        return undefined;
      }
      case 'OFFSCREEN_ZIP': {
        const j = await loadJob();
        if (!j || j.id !== msg.jobId) return { ok: false, error: 'job no longer active' };
        zipUrls.set(msg.filename, msg.url);
        update({ phase: 'saving', message: `Saving ${msg.filename}…`, zipNames: [...(j.zipNames ?? []), msg.filename] }, true);
        const r = await saveZip(msg.url, msg.filename);
        if (!r.ok) update({ downloadError: `${msg.filename}: ${r.error}` }, true);
        return r;
      }
      case 'OFFSCREEN_DONE': {
        const j = await loadJob();
        if (!j || j.id !== msg.jobId) return undefined;
        const { stats, failed, cancelled } = msg.result;
        if (cancelled) return undefined;
        const savedOk = !j.downloadError;
        update(
          {
            phase: savedOk ? 'done' : 'error',
            stats,
            failed,
            message: savedOk
              ? `Saved ${stats.succeeded} of ${stats.creativesFound} creatives`
              : 'The ZIP was built but saving it failed',
            finishedAt: Date.now(),
          },
          true,
        );
        return undefined;
      }
      case 'OFFSCREEN_ERROR': {
        const j = await loadJob();
        if (j && j.id === msg.jobId && isActiveJob(j))
          update({ phase: 'error', message: msg.error, finishedAt: Date.now() }, true);
        return undefined;
      }
    }
    return undefined;
  })().then(
    (r) => sendResponse(r),
    (e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});
