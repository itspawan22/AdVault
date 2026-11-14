import { AD_LIBRARY_HOME } from '../shared/messages';
import type { LastScan, TabState } from '../shared/types';
import { IconClock, IconDownload, timeAgo } from './ui';

interface Props {
  tab: TabState | { ok: false; onAdLibrary: boolean; url: string } | null;
  lastScans: Record<string, LastScan>;
  error: string | null;
  tabId: number | null;
  onStart(kind: 'download' | 'oldest'): void;
}

export function Home({ tab, lastScans, error, tabId, onStart }: Props) {
  if (!tab) return <div className="muted center pad">Detecting advertiser…</div>;

  if (!tab.ok) {
    return (
      <div className="empty">
        <div className="empty-title">{tab.onAdLibrary ? 'Could not read this page' : 'Open the Facebook Ad Library'}</div>
        <p className="muted">
          {tab.onAdLibrary
            ? 'Reload the Ad Library tab and open AdVault again.'
            : 'Search for a brand, open the advertiser’s ads, then click AdVault.'}
        </p>
        <button
          className="btn primary"
          onClick={() =>
            tab.onAdLibrary && tabId != null ? chrome.tabs.reload(tabId) : chrome.tabs.create({ url: AD_LIBRARY_HOME })
          }
        >
          {tab.onAdLibrary ? 'Reload page' : 'Open Ad Library'}
        </button>
      </div>
    );
  }

  const s = tab;
  const noContext = s.mode === 'none';
  const multi = s.mode === 'search' && s.advertiserCount > 1;
  const name = s.advertiserName ?? (multi ? `Search: “${s.query}”` : s.adsLoaded ? 'Unknown advertiser' : 'Waiting for ads…');
  const last = lastScans[s.pageId ?? s.query ?? ''];
  const missing = s.lateInjection && s.domAdCount > s.adsLoaded;
  const disabled = noContext || s.adsLoaded === 0;

  let status = 'Ready';
  if (noContext) status = 'Search for an advertiser to begin';
  else if (s.adsLoaded === 0) status = 'Waiting for ads to load on the page…';
  else if (s.hasNextPage === false) status = 'All results loaded on the page';
  else status = 'More ads will be loaded automatically when you start';

  return (
    <div className="home">
      <section className="card advertiser">
        <div className="label">Advertiser</div>
        <div className="adv-name" title={name}>
          {name}
        </div>
        {multi && <div className="hint">{s.advertiserCount} advertisers in these results — open one advertiser’s page for a precise scan.</div>}
        <div className="count-row">
          <div>
            <div className="count">
              {s.totalReported != null && s.hasNextPage !== false && s.totalReported > s.adsLoaded
                ? `~${s.totalReported.toLocaleString()}`
                : s.adsLoaded.toLocaleString()}
            </div>
            <div className="label">Advertisements found</div>
          </div>
          <div className="loaded">
            <span>{s.adsLoaded}</span> loaded
          </div>
        </div>
      </section>

      {missing && (
        <div className="notice">
          AdVault was added after this page loaded. Reload the page so every ad’s data can be captured.
          <button className="link" onClick={() => tabId != null && chrome.tabs.reload(tabId)}>
            Reload
          </button>
        </div>
      )}

      <div className="actions">
        <button className="btn primary big" disabled={disabled} onClick={() => onStart('download')}>
          <IconDownload /> Download all creatives
        </button>
        <button className="btn secondary big" disabled={disabled} onClick={() => onStart('oldest')}>
          <IconClock /> Find oldest running ads
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      <dl className="meta">
        <div>
          <dt>Status</dt>
          <dd>{status}</dd>
        </div>
        <div>
          <dt>Last scan</dt>
          <dd>{last ? `${last.ads} ads · ${last.creatives} creatives · ${timeAgo(last.at)}` : 'None for this advertiser'}</dd>
        </div>
      </dl>
    </div>
  );
}
