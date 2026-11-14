/**
 * Runs in the page's MAIN world on Ad Library pages. It observes the Ad Library's own
 * GraphQL responses (the same data the page renders) and forwards the ad records it finds
 * to the AdVault content script. It never issues requests of its own or alters responses.
 */
import { extractFromText } from '../shared/parse';

declare global {
  interface Window {
    __advaultHooked?: boolean;
  }
}

const MSG = '__advault_ads__';

function forward(text: string) {
  try {
    if (!text || !text.includes('ad_archive_id')) return;
    const { ads, pageInfo } = extractFromText(text);
    if (ads.length || pageInfo) window.postMessage({ [MSG]: true, ads, pageInfo }, location.origin);
  } catch {
    /* never break the page */
  }
}

const isGraphql = (url: string) => /\/api\/graphql\/?/.test(url);

if (!window.__advaultHooked) {
  window.__advaultHooked = true;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __advaultUrl?: string }, ...args: unknown[]) {
    this.__advaultUrl = String(args[1] ?? '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origOpen as any).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __advaultUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    if (this.__advaultUrl && isGraphql(this.__advaultUrl)) {
      this.addEventListener('load', () => {
        if (this.responseType === '' || this.responseType === 'text') forward(this.responseText);
      });
    }
    return origSend.call(this, body);
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isGraphql(url)) res.clone().text().then(forward, () => {});
    } catch {
      /* ignore */
    }
    return res;
  };
}
