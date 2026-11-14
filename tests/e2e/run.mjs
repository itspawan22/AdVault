/**
 * End-to-end test: loads the built extension into a real Chromium, opens a live Ad Library
 * advertiser page, drives the popup, and verifies the downloaded ZIP and the oldest-ads ranking.
 *
 *   node tests/e2e/run.mjs [adLibraryUrl] [--oldest-only] [--headed]
 *
 * Requires a Chromium build that still allows --load-extension (Playwright's Chromium does);
 * set CHROMIUM_PATH to override the executable.
 */
import { chromium } from 'playwright-core';
import JSZip from 'jszip';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const url =
  args.find((a) => a.startsWith('http')) ??
  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&view_all_page_id=778794852137593&search_type=page&media_type=all';
const oldestOnly = args.includes('--oldest-only');
const headed = args.includes('--headed');
const outDir = resolve(process.env.E2E_OUT ?? join(tmpdir(), 'advault-e2e'));

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  if (existsSync(chrome)) return chrome;
  const root = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = join(root, d, 'chrome-win64', 'chrome.exe');
    if (existsSync(p)) return p;
  }
  throw new Error('No Chromium found; set CHROMIUM_PATH');
}

const ext = resolve('dist');
const profile = join(outDir, 'profile');
const downloads = join(outDir, 'downloads');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });
// Use Chrome's normal download handling (so extension-chosen filenames apply) into a temp folder.
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findChromium(),
  headless: !headed,
  viewport: { width: 1280, height: 900 },
  acceptDownloads: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  // Branded Chrome ≥137 ignores --load-extension; load the unpacked build over CDP instead.
  args: ['--enable-unsafe-extension-debugging'],
});

try {
  const browserCdp = await ctx.browser()?.newBrowserCDPSession();
  if (!browserCdp) throw new Error('no browser CDP session');
  const extId = (await browserCdp.send('Extensions.loadUnpacked', { path: ext })).id;
  const sw =
    ctx.serviceWorkers().find((w) => w.url().includes(extId)) ??
    (await ctx.waitForEvent('serviceworker', { predicate: (w) => w.url().includes(extId), timeout: 15000 }));
  check('extension service worker started', !!extId, extId);

  // Route Chrome downloads into our folder so we can inspect the ZIP.
  await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'default' });

  const fb = await ctx.newPage();
  await fb.goto(url, { waitUntil: 'domcontentloaded' });
  await fb.waitForFunction(() => /Library ID/.test(document.body?.innerText ?? ''), null, { timeout: 60_000 });
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.includes('/ads/library'))?.id, url);

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  await popup.waitForSelector('.adv-name');
  await popup.waitForFunction(() => Number(document.querySelector('.loaded span')?.textContent) > 0, null, { timeout: 30_000 });
  const advName = await popup.textContent('.adv-name');
  const loadedBefore = Number(await popup.textContent('.loaded span'));
  check('advertiser detected', !!advName && advName !== 'Unknown advertiser', advName);
  check('initial ads captured from page data', loadedBefore > 0, `${loadedBefore} ads`);
  await popup.screenshot({ path: join(outDir, '1-home.png') });

  // ---------- Oldest running ads ----------
  await fb.bringToFront();
  await popup.click('text=Find oldest running ads');
  await popup.waitForSelector('.oldest-item, .empty-title, .status-line.error', { timeout: 15 * 60_000 });
  await popup.waitForTimeout(500);
  const job = await popup.evaluate(async () => (await chrome.storage.session.get('job')).job);
  check('scan finished', job.phase === 'done', `${job.scan.adsLoaded} ads, reason: ${job.scan.reason}`);
  const domIds = await fb.evaluate(() => new Set(document.body.innerText.match(/Library ID:?\s*\d+/g)).size);
  check('dynamic loading collected beyond first page', job.scan.adsLoaded > loadedBefore || job.scan.reason === 'all results loaded', `${loadedBefore} → ${job.scan.adsLoaded} (page shows ${domIds} cards, reported ~${job.scan.totalReported})`);
  check('collected at least every card rendered on the page', job.scan.adsLoaded >= domIds, `${job.scan.adsLoaded} ≥ ${domIds}`);

  const r = job.oldest;
  const ranked = r.ranked;
  check('oldest list has 1–10 entries', ranked.length > 0 && ranked.length <= 10, `${ranked.length} ranked, ${r.excludedNoDate} without date, ${r.excludedInactive} inactive`);
  const sorted = ranked.every((e, i) => i === 0 || ranked[i - 1].ad.startDate <= e.ad.startDate);
  check('ranked by ascending start date / descending duration', sorted);
  const daysOk = ranked.every((e) => {
    const start = new Date(e.ad.startDate * 1000);
    const pt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
    const diff = Math.round((Date.parse(pt(new Date())) - Date.parse(pt(start))) / 86400000);
    return diff === e.days;
  });
  check('running days = today − verified start date', daysOk, ranked.map((e) => `${e.ad.id}:${e.days}d`).join(' '));
  check('all ranked ads have API-verified start dates', ranked.every((e) => e.ad.startDateSource === 'api'));

  // Cross-check the #1 ad's start date against the date Facebook renders for it.
  const top = ranked[0];
  const fbLabel = await fb.evaluate((id) => {
    const text = document.body.innerText;
    const i = text.indexOf(id);
    const m = text.slice(i, i + 300).match(/Started running on ([^\n·]+)/);
    return m ? m[1].trim() : null;
  }, top.ad.id);
  const ourLabel = top.startedLabel;
  const norm = (s) => s?.replace(/,/g, '').toLowerCase().split(/\s+/).map((w) => w.slice(0, 3)).join(' ');
  check('top ad start date matches Facebook’s label', !fbLabel || norm(fbLabel) === norm(ourLabel), `FB "${fbLabel}" vs AdVault "${ourLabel}"`);
  await popup.screenshot({ path: join(outDir, '2-oldest.png'), fullPage: true });

  // Preview modal + per-ad download.
  await popup.click('.oldest-item >> nth=0 >> text=Preview');
  await popup.waitForSelector('.modal img, .modal video');
  await popup.screenshot({ path: join(outDir, '3-preview.png') });
  await popup.click('.modal .btn');
  const before = await sw.evaluate(async () => (await chrome.downloads.search({})).length);
  await popup.click('.oldest-item >> nth=0 >> text=Download');
  await popup.waitForTimeout(4000);
  const single = await sw.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'] }))[0]);
  check('individual creative download (named AdVault_<advertiser>/<adId>_<n>)', /AdVault_[^\\/]+[\\/]\d+_1\.\w+$/.test(single?.filename ?? '') && (await sw.evaluate(async () => (await chrome.downloads.search({})).length)) > before && single.state !== 'interrupted', `${single?.filename} (${single?.state}, ${single?.mime})`);

  await popup.click('.icon-btn'); // back
  await popup.waitForSelector('text=Download all creatives');

  if (!oldestOnly) {
    // ---------- Download all ----------
    await fb.bringToFront();
    await popup.click('text=Download all creatives');
    const t0 = Date.now();
    let dj;
    let shot = false;
    for (;;) {
      dj = await popup.evaluate(async () => (await chrome.storage.session.get('job')).job);
      if (dj && ['done', 'error', 'cancelled'].includes(dj.phase)) break;
      if (!shot && dj?.phase === 'downloading' && dj.stats?.processed > 3) {
        await popup.screenshot({ path: join(outDir, '4-download-progress.png'), fullPage: true });
        shot = true;
      }
      if (Date.now() - t0 > 60 * 60_000) throw new Error('download timed out');
      await popup.waitForTimeout(1000);
    }
    await popup.screenshot({ path: join(outDir, '5-download-done.png'), fullPage: true });
    check('download job completed', dj.phase === 'done', `${dj.message} in ${Math.round((Date.now() - t0) / 1000)}s`);
    const st = dj.stats;
    console.log('       stats', JSON.stringify(st));
    check('stats are consistent', st.processed === st.creativesFound && st.succeeded + st.failed <= st.processed && st.imagesDone + st.videosDone === st.processed);

    const items = await sw.evaluate(async () => (await chrome.downloads.search({ filenameRegex: 'AdVault_.*\\.zip$' })).filter((d) => d.state === 'complete'));
    check('ZIP saved via Downloads API', items.length >= 1, items.map((d) => d.filename).join(', '));
    const zipPath = items[0]?.filename;
    if (zipPath && existsSync(zipPath)) {
      const zip = await JSZip.loadAsync(readFileSync(zipPath));
      const names = Object.keys(zip.files);
      const root = names[0].split('/')[0];
      check('ZIP root folder named after advertiser', /^AdVault_/.test(root) && zipPath.includes(root), root);
      for (const sub of ['Images/', 'Videos/', 'Metadata/']) check(`ZIP has ${sub}`, names.includes(`${root}/${sub}`));
      const media = names.filter((n) => /\/(Images|Videos)\/.+/.test(n));
      check('every successful creative is in the ZIP', media.length === st.succeeded, `${media.length} files vs ${st.succeeded}`);
      let badMagic = 0;
      for (const n of media) {
        const head = Buffer.from(await zip.file(n).async('uint8array')).subarray(0, 12);
        const isJpg = head[0] === 0xff && head[1] === 0xd8;
        const isPng = head.subarray(1, 4).toString() === 'PNG';
        const isWebp = head.subarray(8, 12).toString() === 'WEBP';
        const isMp4 = head.subarray(4, 8).toString() === 'ftyp';
        if (n.includes('/Videos/') ? !isMp4 : !(isJpg || isPng || isWebp || head.subarray(0, 3).toString() === 'GIF')) badMagic++;
      }
      check('files are real images / MP4 videos (magic bytes)', badMagic === 0, `${badMagic} mismatched`);
      const csv = await zip.file(`${root}/Metadata/ads_metadata.csv`).async('string');
      const lines = csv.trim().split(/\r\n(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      const adIdsInCsv = new Set(lines.slice(1).map((l) => l.split(',')[1]));
      check('metadata CSV covers every ad', adIdsInCsv.size === st.adsScanned, `${adIdsInCsv.size} ads, ${lines.length - 1} rows`);
      check('metadata CSV header', lines[0].replace(/^﻿/, '').startsWith('Advertiser,Ad ID,Ad Library URL,Start Date'));
      const hashes = new Map();
      const { createHash } = await import('node:crypto');
      let dupFiles = 0;
      for (const n of media) {
        const h = createHash('sha256').update(await zip.file(n).async('uint8array')).digest('hex');
        if (hashes.has(h)) dupFiles++;
        hashes.set(h, n);
      }
      check('no duplicate files inside the ZIP', dupFiles === 0, `${dupFiles} duplicates`);
    }
  }
} catch (e) {
  check('unexpected error', false, e.stack);
} finally {
  await ctx.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${outDir}`);
process.exit(failed.length ? 1 : 0);
