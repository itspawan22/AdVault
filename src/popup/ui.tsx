export const Logo = () => (
  <svg className="logo" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
    <rect x="2" y="2" width="28" height="28" rx="8" fill="var(--accent)" />
    <circle cx="16" cy="16" r="7" fill="none" stroke="#fff" strokeWidth="2.4" />
    <path d="M16 9v3M16 20v3M9 16h3M20 16h3" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

const I = (d: string) => () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const IconDownload = I('M12 3v12m0 0-5-5m5 5 5-5M4 21h16');
export const IconClock = I('M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z');
export const IconBack = I('M15 18l-6-6 6-6');
export const IconExternal = I('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5');
export const IconPlay = I('M7 4l13 8-13 8z');
export const IconEye = I('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z');

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function Bar({ value, indeterminate }: { value: number; indeterminate?: boolean }) {
  return (
    <div className={`bar${indeterminate ? ' indeterminate' : ''}`} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
