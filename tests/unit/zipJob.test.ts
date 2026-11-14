import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { normalizeAd } from '../../src/shared/parse';
import type { AdRecord, MediaType } from '../../src/shared/types';
import { FetchError, runZipJob, type ZipJobDeps } from '../../src/shared/zipJob';
import { carouselAd, imageAd, videoAd } from './fixtures';

const OCT30 = 1793343600;
const NOW = Date.UTC(2026, 10, 10, 20);

async function sha(blob: Blob) {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

type Handler = (url: string, type: MediaType, attempt: number) => { body: string; type: string } | Error;

function harness(handler: Handler, extra: Partial<ZipJobDeps> = {}) {
  const zips: { name: string; blob: Blob }[] = [];
  const attempts = new Map<string, number>();
  const ctrl = new AbortController();
  const deps: ZipJobDeps = {
    signal: ctrl.signal,
    retryDelayMs: 1,
    nowMs: NOW,
    hash: sha,
    async fetchMedia(url, type) {
      const n = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, n);
      const r = handler(url, type, n);
      if (r instanceof Error) throw r;
      return { blob: new Blob([r.body], { type: r.type }), contentType: r.type };
    },
    async emitZip(blob, name) {
      zips.push({ name, blob });
    },
    onProgress() {},
    ...extra,
  };
  return { deps, zips, attempts, ctrl };
}

const ok: Handler = (url, type) => ({ body: `bytes:${url.split('?')[0]}`, type: type === 'video' ? 'video/mp4' : 'image/jpeg' });

async function open(blob: Blob) {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\r') continue;
    else if (ch === '\n') row.push(cell), rows.push(row), (row = []), (cell = '');
    else cell += ch;
  }
  return rows;
}

const ads = (): AdRecord[] =>
  [
    videoAd('1001', OCT30 - 100 * 86400),
    imageAd('1002', OCT30, ['a_n.jpg', 'b_n.png']),
    imageAd('1003', null, ['a_n.jpg']), // same image as ad 1002 (URL duplicate)
    carouselAd('1004', OCT30),
    imageAd('1005', OCT30, []), // no media
  ].map((a) => normalizeAd(a)!);

describe('ZIP job', () => {
  it('builds the expected folder structure with media and metadata', async () => {
    const { deps, zips } = harness(ok);
    const res = await runZipJob('Allbirds', ads(), deps);
    expect(res.cancelled).toBe(false);
    expect(zips.map((z) => z.name)).toEqual(['AdVault_Allbirds.zip']);
    const zip = await open(zips[0].blob);
    const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort();
    expect(files).toEqual([
      'AdVault_Allbirds/Images/1002_1.jpg',
      'AdVault_Allbirds/Images/1002_2.jpg',
      'AdVault_Allbirds/Images/1004_1.jpg',
      'AdVault_Allbirds/Metadata/ads_metadata.csv',
      'AdVault_Allbirds/Videos/1001_1.mp4',
      'AdVault_Allbirds/Videos/1004_2.mp4',
    ]);
    expect(Object.keys(zip.files)).toContain('AdVault_Allbirds/Images/');
    expect(Object.keys(zip.files)).toContain('AdVault_Allbirds/Videos/');
    expect(await zip.file('AdVault_Allbirds/Videos/1001_1.mp4')!.async('string')).toContain('HD_1001');

    expect(res.stats).toMatchObject({ adsScanned: 5, creativesFound: 5, images: 3, videos: 2, succeeded: 5, failed: 0, duplicates: 1 });

    const csv = parseCsv(await zip.file('AdVault_Allbirds/Metadata/ads_metadata.csv')!.async('string'));
    const [header, ...rows] = csv;
    expect(header).toEqual([
      'Advertiser', 'Ad ID', 'Ad Library URL', 'Start Date', 'Start Date Source', 'Status',
      'Running Duration (days)', 'Creative Filename', 'Media Type', 'Quality', 'Download Status',
      'Headline', 'Primary Text', 'Destination URL',
    ]);
    const r1001 = rows.find((r) => r[1] === '1001')!;
    expect(r1001).toEqual(expect.arrayContaining(['Allbirds', 'https://www.facebook.com/ads/library/?id=1001', '2026-07-22', 'Active', '111', 'Videos/1001_1.mp4', 'video', 'hd', 'downloaded']));
    const r1003 = rows.find((r) => r[1] === '1003')!;
    expect(r1003[3]).toBe('Unavailable');
    expect(r1003[6]).toBe('Unavailable');
    expect(r1003[7]).toBe('Images/1002_1.jpg');
    expect(r1003[10]).toBe('shared with ad 1002');
    const r1005 = rows.find((r) => r[1] === '1005')!;
    expect(r1005[8]).toBe('none');
    expect(r1005[10]).toBe('no accessible media');
  });

  it('continues past failures, retries transient errors, and reports what failed', async () => {
    const { deps, zips, attempts } = harness((url, type, attempt) => {
      if (url.includes('HD_1001')) return new FetchError('HTTP 403 (access denied / link expired)', false);
      if (url.includes('b_n.png') && attempt < 2) return new FetchError('HTTP 503', true);
      if (url.includes('card2')) return { body: '<html>login</html>', type: 'text/html' };
      return ok(url, type, attempt);
    });
    const res = await runZipJob('Allbirds', ads(), deps);
    expect(res.stats.succeeded).toBe(3);
    expect(res.stats.failed).toBe(2);
    expect(res.failed.map((f) => f.adId).sort()).toEqual(['1001', '1004']);
    expect(res.failed.find((f) => f.adId === '1004')!.reason).toMatch(/content type text\/html/);
    expect([...attempts.entries()].find(([u]) => u.includes('b_n.png'))![1]).toBe(2);
    expect([...attempts.entries()].find(([u]) => u.includes('HD_1001'))![1]).toBe(1); // 403 is not retried
    const zip = await open(zips[0].blob);
    expect(zip.file('AdVault_Allbirds/Videos/1001_1.mp4')).toBeNull();
    const failedCsv = parseCsv(await zip.file('AdVault_Allbirds/Metadata/failed_downloads.csv')!.async('string'));
    expect(failedCsv).toHaveLength(3);
    const meta = parseCsv(await zip.file('AdVault_Allbirds/Metadata/ads_metadata.csv')!.async('string'));
    const r = meta.find((x) => x[1] === '1001')!;
    expect(r[7]).toBe('');
    expect(r[10]).toMatch(/^failed: HTTP 403/);
  });

  it('detects identical files served from different URLs', async () => {
    const { deps, zips } = harness((url, type) => ({ body: url.includes('b_n.png') || url.includes('a_n.jpg') ? 'SAME' : url, type: type === 'video' ? 'video/mp4' : 'image/jpeg' }));
    const res = await runZipJob('X', ads(), deps);
    expect(res.stats.duplicates).toBe(2);
    expect(res.stats.succeeded).toBe(4);
    const zip = await open(zips[0].blob);
    const imgs = Object.keys(zip.files).filter((f) => f.includes('/Images/') && !zip.files[f].dir);
    expect(imgs).toHaveLength(2);
  });

  it('splits very large downloads into multiple ZIP parts', async () => {
    const big = (url: string, type: MediaType) => ({ body: 'x'.repeat(1000) + url, type: type === 'video' ? 'video/mp4' : 'image/jpeg' });
    const { deps, zips } = harness(big, { partLimitBytes: 2500, concurrency: 1 });
    const res = await runZipJob('Allbirds', ads(), deps);
    expect(zips.length).toBeGreaterThan(1);
    expect(zips[0].name).toBe('AdVault_Allbirds_part1.zip');
    expect(zips.at(-1)!.name).toBe(`AdVault_Allbirds_part${zips.length}.zip`);
    let mediaCount = 0;
    for (const z of zips) {
      const zip = await open(z.blob);
      mediaCount += Object.keys(zip.files).filter((f) => /\/(Images|Videos)\/.+/.test(f)).length;
    }
    expect(mediaCount).toBe(res.stats.succeeded);
    const last = await open(zips.at(-1)!.blob);
    expect(last.file('AdVault_Allbirds/Metadata/ads_metadata.csv')).not.toBeNull();
  });

  it('stops cleanly when cancelled', async () => {
    let calls = 0;
    const h = harness(() => ({ body: 'x', type: 'image/jpeg' }));
    h.deps.fetchMedia = async () => {
      if (++calls === 2) h.ctrl.abort();
      return { blob: new Blob(['x' + calls]), contentType: 'image/jpeg' };
    };
    h.deps.concurrency = 1;
    const res = await runZipJob('X', ads(), h.deps);
    expect(res.cancelled).toBe(true);
    expect(h.zips).toHaveLength(0);
  });
});
