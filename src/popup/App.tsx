import { useCallback, useEffect, useState } from 'react';
import { AD_LIBRARY_HOME, JOB_KEY, LAST_SCAN_KEY } from '../shared/messages';
import type { JobState, LastScan, TabState } from '../shared/types';
import { Home } from './Home';
import { OldestView } from './OldestView';
import { ProgressView } from './ProgressView';
import { Logo } from './ui';

type TabInfo = TabState | { ok: false; onAdLibrary: boolean; url: string } | null;

async function activeTabId(): Promise<number | null> {
  const fromQuery = new URLSearchParams(location.search).get('tabId');
  if (fromQuery) return Number(fromQuery);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [tab, setTab] = useState<TabInfo>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [lastScans, setLastScans] = useState<Record<string, LastScan>>({});
  const [error, setError] = useState<string | null>(null);

  const refreshTab = useCallback(async (id: number | null) => {
    if (id == null) return setTab({ ok: false, onAdLibrary: false, url: '' });
    try {
      setTab(await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE', tabId: id }));
    } catch (e) {
      setTab({ ok: false, onAdLibrary: false, url: '' });
    }
  }, []);

  useEffect(() => {
    (async () => {
      const id = await activeTabId();
      setTabId(id);
      const [s, l] = await Promise.all([chrome.storage.session.get(JOB_KEY), chrome.storage.local.get(LAST_SCAN_KEY)]);
      setJob((s[JOB_KEY] as JobState) ?? null);
      setLastScans((l[LAST_SCAN_KEY] as Record<string, LastScan>) ?? {});
      await refreshTab(id);
    })();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && JOB_KEY in changes) setJob((changes[JOB_KEY].newValue as JobState) ?? null);
      if (area === 'local' && LAST_SCAN_KEY in changes) setLastScans(changes[LAST_SCAN_KEY].newValue ?? {});
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [refreshTab]);

  // Keep the "ads found" counter live while the popup is open on the home screen.
  useEffect(() => {
    if (job || tabId == null) return;
    const t = setInterval(() => refreshTab(tabId), 2000);
    return () => clearInterval(t);
  }, [job, tabId, refreshTab]);

  const start = async (kind: 'download' | 'oldest') => {
    if (tabId == null) return;
    setError(null);
    const r = await chrome.runtime.sendMessage({ type: 'START', kind, tabId });
    if (r && r.ok === false) setError(r.error);
  };

  const back = async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_JOB' });
    setJob(null);
    refreshTab(tabId);
  };

  const cancel = () => chrome.runtime.sendMessage({ type: 'CANCEL' });

  let body: JSX.Element;
  if (job && job.kind === 'download') body = <ProgressView job={job} onCancel={cancel} onBack={back} />;
  else if (job && job.kind === 'oldest') body = <OldestView job={job} onCancel={cancel} onBack={back} />;
  else body = <Home tab={tab} lastScans={lastScans} error={error} onStart={start} tabId={tabId} />;

  return (
    <div className="app">
      <header className="header">
        <Logo />
        <div>
          <div className="brand">ADVAULT</div>
          <div className="tagline">Facebook Ad Library Intelligence</div>
        </div>
      </header>
      <main className="screen" key={job ? job.kind : 'home'}>
        {body}
      </main>
      <footer className="footer">
        <a href={AD_LIBRARY_HOME} target="_blank" rel="noreferrer">
          Open Ad Library ↗
        </a>
      </footer>
    </div>
  );
}
