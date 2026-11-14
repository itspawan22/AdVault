import { useState } from 'react';
import type { JobState } from '../shared/types';
import { Bar, IconBack, formatBytes } from './ui';

interface Props {
  job: JobState;
  onCancel(): void;
  onBack(): void;
}

const PHASES: Record<JobState['phase'], string> = {
  scanning: 'Collecting ads',
  downloading: 'Downloading',
  zipping: 'Building ZIP',
  saving: 'Saving',
  done: 'Complete',
  error: 'Stopped',
  cancelled: 'Cancelled',
};

export function ProgressView({ job, onCancel, onBack }: Props) {
  const [showFailed, setShowFailed] = useState(false);
  const s = job.stats;
  const active = ['scanning', 'downloading', 'zipping', 'saving'].includes(job.phase);
  const dlPct = s && s.creativesFound ? (s.processed / s.creativesFound) * 100 : 0;
  const scanPct = job.scan.totalReported ? (job.scan.adsLoaded / job.scan.totalReported) * 100 : 0;

  return (
    <div className="progress-view">
      <div className="topbar">
        {!active && (
          <button className="icon-btn" onClick={onBack} aria-label="Back">
            <IconBack />
          </button>
        )}
        <div className="topbar-title">
          <div className="label">Download all creatives</div>
          <div className="adv-name small">{job.advertiser}</div>
        </div>
        <span className={`pill ${job.phase}`}>{PHASES[job.phase]}</span>
      </div>

      <section className="card">
        <div className="row-between">
          <span className="label">Advertisements scanned</span>
          <span className="num">{s?.adsScanned ?? job.scan.adsLoaded}</span>
        </div>
        {job.phase === 'scanning' && <Bar value={scanPct} indeterminate={!job.scan.totalReported} />}
      </section>

      {s && (
        <>
          <section className="card">
            <div className="row-between">
              <span className="label">Creatives downloaded</span>
              <span className="num">
                {s.succeeded}
                <span className="of"> / {s.creativesFound}</span>
              </span>
            </div>
            <Bar value={dlPct} />
            <div className="grid">
              <Stat label="Images" value={`${s.imagesDone} / ${s.images}`} />
              <Stat label="Videos" value={`${s.videosDone} / ${s.videos}`} />
              <Stat label="Successful" value={s.succeeded} tone="ok" />
              <Stat label="Failed" value={s.failed} tone={s.failed ? 'bad' : undefined} />
              <Stat label="Duplicates skipped" value={s.duplicates} />
              <Stat label="Size" value={formatBytes(s.bytes)} />
            </div>
          </section>

          <section className="card">
            <div className="row-between">
              <span className="label">ZIP generation{s.parts > 1 ? ` · part ${s.part} of ${s.parts}` : ''}</span>
              <span className="num small">{s.zipPercent}%</span>
            </div>
            <Bar value={s.zipPercent} />
          </section>
        </>
      )}

      <div className={`status-line ${job.phase}`}>{job.message}</div>

      {job.phase === 'done' && s && (
        <section className="card result ok">
          <div className="result-title">ZIP saved to your Downloads folder</div>
          {(job.zipNames ?? []).map((n) => (
            <div key={n} className="mono">
              {n}
            </div>
          ))}
          <div className="muted">
            {s.succeeded} of {s.creativesFound} creatives downloaded
            {s.failed ? ` · ${s.failed} could not be downloaded (listed in Metadata/failed_downloads.csv)` : ''}.
          </div>
          <button className="link" onClick={() => chrome.downloads.showDefaultFolder()}>
            Show in folder
          </button>
        </section>
      )}

      {job.downloadError && (
        <section className="card result bad">
          <div className="result-title">Saving the ZIP failed</div>
          <div className="muted">{job.downloadError}</div>
          <button className="btn secondary" onClick={() => chrome.runtime.sendMessage({ type: 'RETRY_SAVE' })}>
            Retry save
          </button>
        </section>
      )}

      {!!job.failed?.length && (
        <section className="card">
          <button className="link" onClick={() => setShowFailed((v) => !v)}>
            {showFailed ? 'Hide' : 'Show'} {job.failed.length} failed item{job.failed.length > 1 ? 's' : ''}
          </button>
          {showFailed && (
            <ul className="failed">
              {job.failed.slice(0, 100).map((f, i) => (
                <li key={i}>
                  <a href={`https://www.facebook.com/ads/library/?id=${f.adId}`} target="_blank" rel="noreferrer">
                    {f.adId}
                  </a>{' '}
                  · {f.type} · {f.reason}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="actions">
        {active ? (
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button className="btn secondary" onClick={onBack}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'bad' }) {
  return (
    <div className="stat">
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
