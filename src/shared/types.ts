export type MediaType = 'image' | 'video';

export interface Creative {
  /** Best accessible URL for this creative (highest quality available). */
  url: string;
  type: MediaType;
  /** Which source field the URL came from, e.g. "original", "hd", "sd". */
  quality: string;
  /** Poster frame for videos, if available. */
  poster?: string;
  /** Stable key used for URL-level duplicate detection. */
  key: string;
}

export interface AdRecord {
  id: string;
  pageId: string | null;
  pageName: string | null;
  isActive: boolean | null;
  /** Unix seconds. Only set when it comes from a verified start-date field. */
  startDate: number | null;
  startDateSource: 'api' | 'dom' | null;
  /** Unix seconds (for inactive ads this is when it stopped running). */
  endDate: number | null;
  displayFormat: string | null;
  body: string | null;
  title: string | null;
  linkUrl: string | null;
  creatives: Creative[];
  /** Time (ms) this record was captured in the page. */
  seenAt: number;
  /** True when the record was reconstructed from the rendered page rather than structured data. */
  fromDom?: boolean;
}

export interface PageInfo {
  count: number | null;
  hasNextPage: boolean | null;
  at: number;
}

export interface TabState {
  ok: boolean;
  onAdLibrary: boolean;
  mode: 'advertiser' | 'search' | 'single' | 'none';
  pageId: string | null;
  query: string | null;
  advertiserName: string | null;
  advertiserCount: number;
  adsLoaded: number;
  totalReported: number | null;
  hasNextPage: boolean | null;
  domAdCount: number;
  lateInjection: boolean;
  url: string;
}

export interface ScanProgress {
  adsLoaded: number;
  totalReported: number | null;
  done: boolean;
  reason?: string;
}

export interface FailedItem {
  adId: string;
  url: string;
  type: MediaType;
  reason: string;
}

export type JobKind = 'download' | 'oldest';
export type JobPhase =
  | 'scanning'
  | 'downloading'
  | 'zipping'
  | 'saving'
  | 'done'
  | 'error'
  | 'cancelled';

export interface DownloadStats {
  adsScanned: number;
  creativesFound: number;
  images: number;
  videos: number;
  processed: number;
  imagesDone: number;
  videosDone: number;
  succeeded: number;
  failed: number;
  duplicates: number;
  bytes: number;
  zipPercent: number;
  part: number;
  parts: number;
}

export interface OldestEntry {
  ad: AdRecord;
  days: number;
  startedLabel: string;
}

export interface OldestResult {
  ranked: OldestEntry[];
  excludedNoDate: number;
  excludedInactive: number;
  totalAds: number;
}

export interface JobState {
  id: string;
  kind: JobKind;
  tabId: number;
  advertiser: string;
  phase: JobPhase;
  message: string;
  startedAt: number;
  finishedAt?: number;
  scan: ScanProgress;
  stats?: DownloadStats;
  failed?: FailedItem[];
  zipNames?: string[];
  downloadError?: string;
  oldest?: OldestResult;
}

export interface LastScan {
  advertiser: string;
  ads: number;
  creatives: number;
  kind: JobKind;
  at: number;
}
