import { useState } from 'react';
import { extensionFor, sanitizeName } from '../shared/files';
import { adLibraryUrl } from '../shared/parse';
import type { Creative, JobState, OldestEntry } from '../shared/types';
import { Bar, IconBack, IconDownload, IconExternal, IconEye, IconPlay } from './ui';

interface Props {
  job: JobState;
  onCancel(): void;
  onBack(): void;
}

const typeLabel = (e: OldestEntry) => {
  const c = e.ad.creatives;
  if (!c.length) return 'No media';
  const v = c.some((x) => x.type === 'video');
  const i = c.some((x) => x.type === 'image');
  const base = v && i ? 'Mixed' : v ? 'Video' : 'Image';
  return c.length > 1 ? `${base} · ${c.length} creatives` : base;
};

export function OldestView({ job, onCancel, onBack }: Props) {
  const [preview, setPreview] = useState<Creative | null>(null);
  const active = job.phase === 'scanning';
  const r = job.oldest;

  return (
    <div className="oldest-view">
      <div className="topbar">
        <button className="icon-btn" onClick={active ? onCancel : onBack} aria-label={active ? 'Cancel' : 'Back'}>
          <IconBack />
        </button>
        <div className="topbar-title">
          <div className="label">Oldest running ads</div>
          <div className="adv-name small">{job.advertiser}</div>
        </div>
      </div>

      {active && (
        <section className="card">
          <div className="row-between">
            <span className="label">Scanning all ads</span>
            <span className="num">{job.scan.adsLoaded}</span>
          </div>
          <Bar value={job.scan.totalReported ? (job.scan.adsLoaded / job.scan.totalReported) * 100 : 0} indeterminate={!job.scan.totalReported} />
          <div className="muted small-text">Ranking by verified start date once every ad is loaded.</div>
        </section>
      )}

      {(job.phase === 'error' || job.phase === 'cancelled') && <div className={`status-line ${job.phase}`}>{job.message}</div>}

      {r && (
        <>
          <div className="muted small-text sub">
            Top {r.ranked.length} of {r.totalAds} ads · ranked by verified start date
          </div>
          {r.ranked.length === 0 && <div className="empty-title center pad">No running ads with a verified start date.</div>}
          <ol className="oldest-list">
            {r.ranked.map((e, i) => (
              <OldestItem key={e.ad.id} rank={i + 1} entry={e} advertiser={job.advertiser} onPreview={setPreview} />
            ))}
          </ol>
          {(r.excludedNoDate > 0 || r.excludedInactive > 0) && (
            <div className="excluded">
              {r.excludedNoDate > 0 && <div>{r.excludedNoDate} ad{r.excludedNoDate > 1 ? 's' : ''} excluded — no verified start date</div>}
              {r.excludedInactive > 0 && <div>{r.excludedInactive} inactive ad{r.excludedInactive > 1 ? 's' : ''} not ranked — no longer running</div>}
            </div>
          )}
          {job.scan.reason && job.scan.reason !== 'all results loaded' && <div className="muted small-text">Scan: {job.scan.reason}</div>}
        </>
      )}

      {preview && (
        <div className="modal" onClick={() => setPreview(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            {preview.type === 'video' ? (
              <video src={preview.url} poster={preview.poster} controls autoPlay muted playsInline />
            ) : (
              <img src={preview.url} alt="Creative preview" />
            )}
            <button className="btn ghost" onClick={() => setPreview(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OldestItem({ rank, entry, advertiser, onPreview }: { rank: number; entry: OldestEntry; advertiser: string; onPreview(c: Creative): void }) {
  const { ad } = entry;
  const c = ad.creatives[0];
  const thumb = c ? (c.type === 'video' ? c.poster : c.url) : undefined;
  const [thumbFailed, setThumbFailed] = useState(false);

  const download = () => {
    ad.creatives.forEach((cr, i) => {
      const ext = extensionFor(null, cr.url, cr.type);
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_SINGLE',
        url: cr.url,
        filename: `AdVault_${sanitizeName(advertiser)}/${ad.id}_${i + 1}.${ext}`,
      });
    });
  };

  return (
    <li className="oldest-item" style={{ animationDelay: `${rank * 35}ms` }}>
      <button className="thumb" onClick={() => c && onPreview(c)} disabled={!c} aria-label="Preview creative">
        {thumb && !thumbFailed ? <img src={thumb} alt="" loading="lazy" onError={() => setThumbFailed(true)} /> : <span className="thumb-empty">{c ? 'Preview' : 'No media'}</span>}
        {c?.type === 'video' && (
          <span className="play">
            <IconPlay />
          </span>
        )}
        <span className="rank">{rank}</span>
      </button>
      <div className="item-body">
        <div className="days">
          {entry.days.toLocaleString()} <span>day{entry.days === 1 ? '' : 's'} running</span>
        </div>
        <div className="item-meta">
          Started {entry.startedLabel} · {typeLabel(entry)}
        </div>
        {ad.title && <div className="headline">{ad.title}</div>}
        {ad.body && <div className="body-text">{ad.body}</div>}
        <div className="item-id">ID {ad.id}{ad.startDateSource === 'dom' ? ' · date read from page' : ''}</div>
        <div className="item-actions">
          <a className="chip" href={adLibraryUrl(ad.id)} target="_blank" rel="noreferrer">
            <IconExternal /> Open
          </a>
          <button className="chip" onClick={() => c && onPreview(c)} disabled={!c}>
            <IconEye /> Preview
          </button>
          <button className="chip" onClick={download} disabled={!c}>
            <IconDownload /> Download
          </button>
        </div>
      </div>
    </li>
  );
}
