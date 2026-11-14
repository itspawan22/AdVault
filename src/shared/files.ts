import type { MediaType } from './types';

export function sanitizeName(name: string, max = 60): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, max)
    .replace(/_+$/, '');
  return cleaned || 'Advertiser';
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
};

const KNOWN_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'mp4', 'mov', 'webm', 'm4v']);

/** Pick a file extension from the response Content-Type, falling back to the URL path. */
export function extensionFor(contentType: string | null, url: string, type: MediaType): string {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXT[ct]) return MIME_EXT[ct];
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (m && KNOWN_EXT.has(m[1].toLowerCase())) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  } catch {
    /* ignore */
  }
  return type === 'video' ? 'mp4' : 'jpg';
}

/** True when a response's Content-Type is plausibly the media we asked for. */
export function isAcceptableContentType(contentType: string | null, type: MediaType): boolean {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream') return true;
  if (type === 'image') return ct.startsWith('image/');
  return ct.startsWith('video/') || ct === 'application/mp4';
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  // BOM so Excel opens UTF-8 text (emoji, accents) correctly.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
