import JSZip from 'jszip';
import { isoDate, runningDays } from './dates';
import { extensionFor, isAcceptableContentType, sanitizeName, toCsv } from './files';
import { adLibraryUrl } from './parse';
import type { AdRecord, Creative, DownloadStats, FailedItem, MediaType } from './types';

export class FetchError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

export interface FetchedMedia {
  blob: Blob;
  contentType: string | null;
}

export interface ZipJobDeps {
  fetchMedia(url: string, type: MediaType, signal: AbortSignal): Promise<FetchedMedia>;
  hash(blob: Blob): Promise<string>;
  emitZip(blob: Blob, filename: string): Promise<void>;
  onProgress(stats: DownloadStats, message: string): void;
  signal: AbortSignal;
  concurrency?: number;
  partLimitBytes?: number;
  retries?: number;
  retryDelayMs?: number;
  nowMs?: number;
}

export interface ZipJobResult {
  stats: DownloadStats;
  failed: FailedItem[];
  zipNames: string[];
  cancelled: boolean;
}

interface Task {
  creative: Creative;
  adId: string;
  index: number;
  /** Resolved archive path (or null on failure). */
  path: string | null;
  status: string;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export async function runZipJob(advertiser: string, ads: AdRecord[], deps: ZipJobDeps): Promise<ZipJobResult> {
  const concurrency = deps.concurrency ?? 4;
  const partLimit = deps.partLimitBytes ?? 1024 * 1024 * 1024;
  const retries = deps.retries ?? 2;
  const retryDelay = deps.retryDelayMs ?? 1500;
  const base = `AdVault_${sanitizeName(advertiser)}`;

  // ---- Plan: one task per unique creative URL (URL-level de-duplication across ads). ----
  const byKey = new Map<string, Task>();
  const perAd = new Map<string, Task[]>();
  let urlDuplicates = 0;
  for (const ad of ads) {
    const list: Task[] = [];
    ad.creatives.forEach((creative, i) => {
      const existing = byKey.get(creative.key);
      if (existing) {
        urlDuplicates++;
        list.push(existing);
        return;
      }
      const t: Task = { creative, adId: ad.id, index: i + 1, path: null, status: 'pending' };
      byKey.set(creative.key, t);
      list.push(t);
    });
    perAd.set(ad.id, list);
  }
  const tasks = [...byKey.values()];

  const stats: DownloadStats = {
    adsScanned: ads.length,
    creativesFound: tasks.length,
    images: tasks.filter((t) => t.creative.type === 'image').length,
    videos: tasks.filter((t) => t.creative.type === 'video').length,
    processed: 0,
    imagesDone: 0,
    videosDone: 0,
    succeeded: 0,
    failed: 0,
    duplicates: urlDuplicates,
    bytes: 0,
    zipPercent: 0,
    part: 1,
    parts: 1,
  };
  const failed: FailedItem[] = [];
  const zipNames: string[] = [];
  const report = (msg: string) => deps.onProgress({ ...stats }, msg);

  // ---- Writer: single sequential chain so part splitting is race-free. ----
  let zip = new JSZip();
  let folder = zip.folder(base)!;
  let partBytes = 0;
  let writer: Promise<void> = Promise.resolve();
  const hashes = new Map<string, string>();

  const finalizePart = async (name: string) => {
    report(`Building ZIP${stats.parts > 1 || zipNames.length ? ` part ${stats.part}` : ''}…`);
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'STORE', streamFiles: true, mimeType: 'application/zip' },
      (meta) => {
        const p = Math.floor(meta.percent);
        if (p !== stats.zipPercent) {
          stats.zipPercent = p;
          report(`Building ZIP… ${p}%`);
        }
      },
    );
    zipNames.push(name);
    await deps.emitZip(blob, name);
  };

  const write = (task: Task, media: FetchedMedia) =>
    (writer = writer.then(async () => {
      const digest = await deps.hash(media.blob);
      const dup = hashes.get(digest);
      if (dup) {
        // Identical bytes already stored under another URL: reuse that file.
        task.path = dup;
        task.status = 'duplicate of existing file';
        stats.duplicates++;
        return;
      }
      if (partBytes > 0 && partBytes + media.blob.size > partLimit) {
        stats.parts++;
        await finalizePart(`${base}_part${stats.part}.zip`);
        stats.part++;
        zip = new JSZip();
        folder = zip.folder(base)!;
        partBytes = 0;
      }
      const ext = extensionFor(media.contentType, task.creative.url, task.creative.type);
      const dir = task.creative.type === 'video' ? 'Videos' : 'Images';
      const path = `${dir}/${task.adId}_${task.index}.${ext}`;
      folder.file(path, media.blob, { binary: true });
      partBytes += media.blob.size;
      stats.bytes += media.blob.size;
      hashes.set(digest, path);
      task.path = path;
      task.status = 'downloaded';
    }));

  // ---- Fetch pool ----
  const fetchWithRetry = async (task: Task): Promise<FetchedMedia> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (deps.signal.aborted) throw new FetchError('cancelled', false);
      try {
        const m = await deps.fetchMedia(task.creative.url, task.creative.type, deps.signal);
        if (!m.blob.size) throw new FetchError('empty response', true);
        if (!isAcceptableContentType(m.contentType, task.creative.type))
          throw new FetchError(`unexpected content type ${m.contentType}`, false);
        return m;
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof FetchError ? e.retryable : true;
        if (!retryable || attempt === retries) break;
        await sleep(retryDelay * (attempt + 1), deps.signal);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !deps.signal.aborted) {
      const task = tasks[next++];
      const isVideo = task.creative.type === 'video';
      try {
        const media = await fetchWithRetry(task);
        await write(task, media);
        if (task.status === 'downloaded') stats.succeeded++;
      } catch (e) {
        if (deps.signal.aborted) break;
        const reason = e instanceof Error ? e.message : String(e);
        task.status = `failed: ${reason}`;
        stats.failed++;
        failed.push({ adId: task.adId, url: task.creative.url, type: task.creative.type, reason });
      }
      stats.processed++;
      if (isVideo) stats.videosDone++;
      else stats.imagesDone++;
      report(`Downloading creatives… ${stats.processed}/${tasks.length}`);
    }
  };

  report(`Downloading ${tasks.length} creatives…`);
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, worker));
  await writer;
  if (deps.signal.aborted) return { stats, failed, zipNames, cancelled: true };

  // ---- Metadata ----
  const now = deps.nowMs ?? Date.now();
  const header = [
    'Advertiser',
    'Ad ID',
    'Ad Library URL',
    'Start Date',
    'Start Date Source',
    'Status',
    'Running Duration (days)',
    'Creative Filename',
    'Media Type',
    'Quality',
    'Download Status',
    'Headline',
    'Primary Text',
    'Destination URL',
  ];
  const rows: unknown[][] = [];
  for (const ad of ads) {
    const common = (c: Partial<Record<'file' | 'type' | 'quality' | 'status', string>>) => [
      ad.pageName ?? advertiser,
      ad.id,
      adLibraryUrl(ad.id),
      ad.startDate ? isoDate(ad.startDate) : 'Unavailable',
      ad.startDateSource === 'api' ? 'Ad Library data' : ad.startDateSource === 'dom' ? 'Ad Library page text' : '',
      ad.isActive === true ? 'Active' : ad.isActive === false ? 'Inactive' : 'Unknown',
      runningDays(ad, now) ?? 'Unavailable',
      c.file ?? '',
      c.type ?? '',
      c.quality ?? '',
      c.status ?? '',
      ad.title ?? '',
      ad.body ?? '',
      ad.linkUrl ?? '',
    ];
    const list = perAd.get(ad.id) ?? [];
    if (!list.length) rows.push(common({ type: 'none', status: 'no accessible media' }));
    for (const t of list) {
      rows.push(
        common({
          file: t.path ? `${t.creative.type === 'video' ? 'Videos' : 'Images'}/${t.path.split('/').pop()}` : '',
          type: t.creative.type,
          quality: t.creative.quality,
          status: t.adId !== ad.id && t.path ? `shared with ad ${t.adId}` : t.status,
        }),
      );
    }
  }
  folder.file('Metadata/ads_metadata.csv', toCsv(header, rows));
  if (failed.length) {
    folder.file(
      'Metadata/failed_downloads.csv',
      toCsv(['Ad ID', 'Ad Library URL', 'Media Type', 'Reason', 'Source URL'], failed.map((f) => [f.adId, adLibraryUrl(f.adId), f.type, f.reason, f.url])),
    );
  }
  folder.folder('Images');
  folder.folder('Videos');

  await finalizePart(zipNames.length ? `${base}_part${stats.part}.zip` : `${base}.zip`);
  stats.zipPercent = 100;
  report('Done');
  return { stats, failed, zipNames, cancelled: false };
}
