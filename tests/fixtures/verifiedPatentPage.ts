import { parseResearch } from '../../server/patentResearch.ts';
import type { ResponsesResearchStageObserver } from '../../server/patentResearch.ts';
import type { DrawingPlanInput } from '../../src/features/utility/aiDrawing.ts';

// Synthetic fixture only: not REAL_OBSERVED patent content.
export function patentPageHtml(publication = 'CN217307583U', abstract = 'OFFLINE ORIGINAL: A base plate supports two brackets connected to an installation plate.') {
  return `<html><meta name="DC.title" content="Offline verified patent fixture">
    <dd itemprop="publicationNumber">${publication}</dd>
    <section itemprop="abstract"><h2>Abstract</h2><p>${abstract}</p></section>
    <section itemprop="claims"><h2>Claims</h2><p>A fixture comprising a base plate and connected brackets.</p></section>
    <section itemprop="description"><h2>Description</h2><p>The brackets support the installation plate.</p></section></html>`;
}
export const offlinePatentFetch: typeof fetch = async (target, init) => {
  const url = new URL(String(target));
  const match = /^\/patent\/([A-Z]{2}\d+[A-Z]\d?)\/en$/.exec(url.pathname);
  if (url.origin !== 'https://patents.google.com' || !match || init?.method !== 'GET' || init.redirect !== 'error' ||
      new Headers(init.headers).has('Authorization') || new Headers(init.headers).has('x-api-key')) {
    throw new Error('OFFLINE_PATENT_FETCH_CONTRACT');
  }
  return new Response(patentPageHtml(match[1]), { headers: { 'content-type': 'text/html' } });
};
export function parseOfflineResearch(payload: unknown, input: DrawingPlanInput, observer?: ResponsesResearchStageObserver) {
  return parseResearch(payload, input, offlinePatentFetch, new AbortController().signal, observer);
}
