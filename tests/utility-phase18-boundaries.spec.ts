import { test, expect } from '@playwright/test';
import https from 'node:https';
import net from 'node:net';
import { createStrictTransport } from './support/strictE2eTransport.mjs';
import { createStrictResearchInvocation } from './support/strictResearchPolicy.ts';
import { createPhase18NetworkGuard } from './support/phase18NetworkGuard.mjs';
import { providerResearchFixture } from './fixtures/research.ts';
import { offlinePatentFetch } from './fixtures/verifiedPatentPage.ts';
import { buildResearchEvidence } from '../src/features/utility/patentEvidence.ts';
const config = { baseUrl: 'https://api.psydo.top/v1', model: 'gpt-6.1-sol', researchModel: 'gpt-6.1-sol',
  researchProtocol: 'responses' as const, apiKey: 'OFFLINE_ONLY', fallbackModel: 'gpt-6-sol', secondFallbackModel: 'gpt-6-astra' };
const input = { title: '机械夹具', technicalField: '可调夹持 夹持机构 夹紧结构', structure: '', workingPrinciple: '' };
const page = 'https://patents.google.com/patent/CN217307583U/en';
const post = { method: 'POST', redirect: 'error' as const, headers: { Authorization: 'Bearer OFFLINE_ONLY' },
  body: JSON.stringify({ model: 'gpt-6.1-sol', stream: false, tool_choice: 'required',
    tools: [{ type: 'web_search', filters: { allowed_domains: ['patents.google.com'] } }], include: ['web_search_call.action.sources'] }) };
const get = { method: 'GET', redirect: 'error' as const };
const provider = config.baseUrl + '/responses';

test('opt-in strict Research delegates one mock provider then verified mock page, never Generation', async () => {
  const calls: string[] = [];
  const invocation = createStrictResearchInvocation({ config, allowPatentPages: true,
    fetcher: async (url, init) => { calls.push(String(url)); return init?.method === 'GET' ? offlinePatentFetch(url, init) : Response.json(providerResearchFixture()); } });
  const research = await invocation.run(input, new AbortController().signal);
  expect(calls).toEqual([provider, page]);
  expect(invocation.state).toMatchObject({ researchRequests: 1, generationRequests: 0, pageFetches: 1, violations: 0, halted: true });
  expect(buildResearchEvidence(research).items[0]).toMatchObject({ factType: 'PRIOR_ART_FEATURE', status: 'INFERRED', evidenceScope: 'PATENT_ORIGINAL_TEXT' });
  expect(research.queryCoverage).toMatchObject({ status: 'UNKNOWN', coveredQueryCount: null, coverageRatio: null });
  await expect(invocation.run(input, new AbortController().signal)).rejects.toThrow('STRICT_RESEARCH_INVOCATION_REUSED');
});
for (const mode of ['default-denies-page', 'opt-in-denies-generation', 'opt-in-denies-second-provider', 'opt-in-denies-credential-url', 'opt-in-denies-query-string']) {
  test(`strict policy ${mode}`, async () => {
    const calls: string[] = [];
    const transport = createStrictTransport({ ...config, researchOnly: true, allowPatentPages: mode !== 'default-denies-page',
      fetcher: async (url: RequestInfo | URL) => { calls.push(String(url)); return Response.json({}); } });
    await transport.fetch(provider, post);
    const target = mode === 'opt-in-denies-generation' ? config.baseUrl + '/chat/completions' : mode === 'opt-in-denies-second-provider' ? provider :
      mode === 'opt-in-denies-credential-url' ? page.replace('https://', 'https://user:secret@') : mode === 'opt-in-denies-query-string' ? page + '?x=1' : page;
    await expect(transport.fetch(target, target.includes('/patent/') ? get : post)).rejects.toThrow();
    expect(calls).toEqual([provider]);
  });
}
for (const status of [429, 500, 502, 503]) test(`HTTP ${status} stops without page/fallback/retry`, async () => {
  let calls = 0;
  const invocation = createStrictResearchInvocation({ config, allowPatentPages: true, fetcher: async () => { calls++; return Response.json({}, { status }); } });
  await expect(invocation.run(input, new AbortController().signal)).rejects.toThrow();
  expect(calls).toBe(1); expect(invocation.state).toMatchObject({ researchRequests: 1, generationRequests: 0, pageFetches: 0, halted: true });
});
test('page failure halts with one provider request and no fallback', async () => {
  let calls = 0;
  const invocation = createStrictResearchInvocation({ config, allowPatentPages: true, fetcher: async (_url, init) => {
    calls++; return init?.method === 'GET' ? new Response('failed', { status: 503 }) : Response.json(providerResearchFixture());
  } });
  await expect(invocation.run(input, new AbortController().signal)).rejects.toMatchObject({ code: 'EVIDENCE_FETCH_FAILED' });
  expect(calls).toBe(2); expect(invocation.state).toMatchObject({ researchRequests: 1, generationRequests: 0, pageFetches: 1, halted: true });
});
test('guard plus production parser integrates offline; generated artifacts need no raw response', async () => {
  const events: unknown[] = [];
  const guard = createPhase18NetworkGuard({ record: (e: unknown) => events.push(e), nativeFetch: async (url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'GET' ? offlinePatentFetch(url, init) : Response.json(providerResearchFixture()) });
  guard.install();
  try {
    const invocation = createStrictResearchInvocation({ config, allowPatentPages: true, fetcher: guard.fetch });
    const research = await invocation.run(input, new AbortController().signal);
    expect(buildResearchEvidence(research).items).toHaveLength(1);
    expect(guard.state).toMatchObject({ researchProviderRequests: 1, totalExternalAiRequests: 1, patentPageRequests: 1, blockedAttempts: 0 });
    expect(JSON.stringify(events)).not.toContain('OFFLINE_ONLY');
  } finally { guard.restore(); }
});
for (const mode of ['stream', 'second-provider', 'credential-to-page', 'other-host', 'global-fetch', 'direct-https', 'direct-socket', 'page-before-research']) {
  test(`network guard rejects ${mode} before fake native delegate`, async () => {
    let calls = 0;
    const guard = createPhase18NetworkGuard({ nativeFetch: async () => { calls++; return Response.json({}); } });
    guard.install();
    try {
      if (['second-provider', 'credential-to-page'].includes(mode)) await guard.fetch(provider, post);
      if (mode === 'global-fetch') await expect(globalThis.fetch('https://offline.invalid')).rejects.toThrow();
      else if (mode === 'direct-https') expect(() => https.get('https://offline.invalid')).toThrow();
      else if (mode === 'direct-socket') expect(() => net.connect(443, 'offline.invalid')).toThrow();
      else {
        const target = mode === 'other-host' ? 'https://other.invalid' : ['credential-to-page', 'page-before-research'].includes(mode) ? page : provider;
        const options = mode === 'stream' ? { ...post, body: JSON.stringify({ ...JSON.parse(post.body), stream: true }) } : mode === 'credential-to-page' ?
          { ...get, headers: post.headers } : mode === 'page-before-research' ? get : post;
        await expect(guard.fetch(target, options)).rejects.toThrow();
      }
      expect(calls).toBe(['second-provider', 'credential-to-page'].includes(mode) ? 1 : 0);
      expect(guard.state).toMatchObject({ blockedAttempts: 1, closed: true });
    } finally { guard.restore(); }
  });
}
