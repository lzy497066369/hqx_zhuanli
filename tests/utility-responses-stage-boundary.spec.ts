import { expect, test } from '@playwright/test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import type { AiConfig } from '../server/aiSupport.ts';
import { parseOfflineResearch as parseResearch } from './fixtures/verifiedPatentPage';
import type { ResponsesResearchStageDiagnostics } from '../server/patentResearch.ts';
import { summarizeResponsesResearchToolResult } from '../server/researchProvider.ts';
import { poisonAssistantContent, responsesStageFixture, stageFixtureSecrets, stageSearchCall } from './fixtures/responsesStageBoundary.ts';
import { createResponsesStageBoundary, ResponsesStageStop } from './support/responsesStageBoundary.ts';
import { createStrictResearchInvocation } from './support/strictResearchPolicy.ts';

const input = { title: 'Offline fixture', technicalField: 'Offline mechanical fixture', structure: '', workingPrinciple: '' };
const config: AiConfig = { baseUrl: 'https://provider.invalid/v1', apiKey: 'OFFLINE_KEY', model: 'gpt-6.1-sol',
  researchModel: 'gpt-6.1-sol', researchProtocol: 'responses', fallbackModel: 'gpt-6-sol', secondFallbackModel: 'gpt-6-astra',
  fallbackBaseUrl: 'https://fallback.invalid/v1', fallbackApiKey: 'OFFLINE_FALLBACK_KEY',
  secondFallbackBaseUrl: 'https://second.invalid/v1', secondFallbackApiKey: 'OFFLINE_SECOND_KEY' };
type Boundary = ReturnType<typeof createResponsesStageBoundary>;
const initial = { 'search-action': 'NOT_RUN', 'search-results': 'NOT_RUN', 'query-coverage': 'NOT_RUN' };

function assertNoDownstream(boundary: Boundary) {
  expect(boundary.invocations).toEqual({ citation: 0, source: 0, fact: 0 });
  expect(boundary.stages.map(item => item.stage)).not.toContain('citation');
  expect(boundary.stages.map(item => item.stage)).not.toContain('source');
  expect(boundary.stages.map(item => item.stage)).not.toContain('fact');
}
async function stoppedFixture(payload: ReturnType<typeof responsesStageFixture>, stage = 'query-coverage') {
  const boundary = createResponsesStageBoundary();
  const trap = poisonAssistantContent(payload);
  await expect(parseResearch(payload, input, boundary.observer)).rejects.toThrow(expect.objectContaining({
    code: 'TEST_RESPONSES_STAGE_STOP', stage,
  }));
  expect(trap.reads).toBe(0);
  assertNoDownstream(boundary);
  return boundary;
}
function last(boundary: Boundary): ResponsesResearchStageDiagnostics {
  return boundary.stages[boundary.stages.length - 1].diagnostics;
}
function noSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of [...Object.values(stageFixtureSecrets), 'Authorization', 'Bearer', 'Cookie', 'token=', 'api_key=', 'https://']) {
    expect(serialized).not.toContain(secret);
  }
}

test('A: test observer stops parser after Coverage observation, not a production Coverage gate', async () => {
  const boundary = await stoppedFixture(responsesStageFixture());
  expect(boundary.status).toEqual({ 'search-action': 'PASS', 'search-results': 'PASS', 'query-coverage': 'NOT_IMPLEMENTED_FOR_RESPONSES' });
  expect(boundary.stages.map(item => item.stage)).toEqual(['search-action', 'search-results', 'query-coverage']);
  expect(last(boundary)).toMatchObject({ measurement: 'OBSERVED_ONLY', searchActionCount: 1, searchResultCount: 2,
    qualifiedPatentResultCount: 1, observedQueryCount: 1, observedCoveredQueryCount: null, coverageGate: 'NOT_IMPLEMENTED_FOR_RESPONSES' });
});

test('B: no search action fails test observation and leaves later measurements unknown', async () => {
  const fixture = responsesStageFixture(); fixture.output.shift();
  const boundary = await stoppedFixture(fixture, 'search-action');
  expect(boundary.status).toEqual({ ...initial, 'search-action': 'FAIL' });
  expect(last(boundary)).toMatchObject({ searchActionCount: 0, searchResultCount: null,
    qualifiedPatentResultCount: null, observedQueryCount: null, observedCoveredQueryCount: null, coverageGate: 'NOT_RUN' });
});

test('C: search without results stops before Coverage', async () => {
  const fixture = responsesStageFixture();
  fixture.output[0] = stageSearchCall({ type: 'search', query: stageFixtureSecrets.query });
  const boundary = await stoppedFixture(fixture, 'search-results');
  expect(boundary.status).toEqual({ ...initial, 'search-action': 'PASS', 'search-results': 'FAIL' });
  expect(last(boundary)).toMatchObject({ searchResultCount: 0, qualifiedPatentResultCount: 0, observedQueryCount: null, coverageGate: 'NOT_RUN' });
});

test('D: all raw results are counted, qualified publications deduplicate without citation attribution', async () => {
  const fixture = responsesStageFixture();
  fixture.output[0] = stageSearchCall({ type: 'search', query: stageFixtureSecrets.query, sources: [
    { url: 'https://patents.google.com/patent/CN217307583U/zh' },
    { url: 'https://patents.google.com/patent/CN217307583U/en' },
    { url: 'https://patents.google.com/patent/CN218307583U/zh' },
    { url: 'https://patents.google.com/patent/CN219307583U/zh' },
    { url: 'https://example.com/reference' },
  ] });
  expect(last(await stoppedFixture(fixture))).toMatchObject({ searchResultCount: 5, qualifiedPatentResultCount: 3 });
});

test('E: sensitive URL components, query, id and provider error message never enter diagnostics', async () => {
  const fixture = responsesStageFixture(); const secrets = stageFixtureSecrets;
  const url = `https://${secrets.username}:${secrets.password}@example.com/path?token=${secrets.token}&api_key=${secrets.apiKey}#${secrets.fragment}`;
  fixture.output[0] = stageSearchCall({ type: 'search', query: secrets.query, sources: [
    { type: 'url', url }, { type: 'url', url: 'https://patents.google.com/patent/CN217307583U/zh' },
  ] }, { error: { type: 'server_error', code: 'unavailable', message: secrets.error } });
  const diagnostics = summarizeResponsesResearchToolResult(fixture);
  expect(diagnostics.webSearchCalls[0].sources[0]).toEqual({ hostname: 'example.com', pathname: '/path' });
  expect(diagnostics.webSearchCalls[0]).toMatchObject({ errorCode: 'unavailable', queryPresent: true, queryLength: secrets.query.length });
  expect(diagnostics.webSearchCallIdsPresent).toEqual([true]);
  expect(diagnostics.webSearchCallIdLengths).toEqual([secrets.id.length]);
  const boundary = await stoppedFixture(fixture);
  noSecrets({ diagnostics, stages: boundary.stages, status: boundary.status });
});

test('non-patent search results are observed but test boundary refuses qualification', async () => {
  const fixture = responsesStageFixture();
  fixture.output[0] = stageSearchCall({ type: 'search', query: stageFixtureSecrets.query, sources: [{ url: 'https://example.com/path' }] });
  expect(last(await stoppedFixture(fixture, 'search-results'))).toMatchObject({ searchResultCount: 1, qualifiedPatentResultCount: 0 });
});

for (const kind of ['in-progress', 'failed', 'missing-action', 'unknown-action', 'open-only']) {
  test(`completed search-action observation ignores ${kind}`, async () => {
    const fixture = responsesStageFixture();
    fixture.output[0] = stageSearchCall(kind === 'missing-action' ? {} : kind === 'open-only'
      ? { type: 'open_page', url: 'https://patents.google.com/patent/CN217307583U/zh' } : { type: kind === 'unknown-action' ? 'unknown' : 'search' },
    kind === 'in-progress' || kind === 'failed' ? { status: kind } : kind === 'missing-action' ? { action: null } : {});
    expect(last(await stoppedFixture(fixture, 'search-action')).searchActionCount).toBe(0);
  });
}

test('open_page cannot inflate qualified search-result measurements', async () => {
  const fixture = responsesStageFixture();
  fixture.output.splice(1, 0, stageSearchCall({ type: 'open_page', url: 'https://patents.google.com/patent/CN218307583U/zh' }));
  expect(last(await stoppedFixture(fixture))).toMatchObject({ searchActionCount: 1, searchResultCount: 2, qualifiedPatentResultCount: 1 });
});

test('query observation reuses production uniqueness, length and maximum count rules without coverage inference', async () => {
  const fixture = responsesStageFixture();
  fixture.output[0] = stageSearchCall({ type: 'search', query: stageFixtureSecrets.query,
    queries: [stageFixtureSecrets.query, '', ' ', null, 42, 'x'.repeat(1001), ...Array.from({ length: 15 }, (_, i) => `fixture-${i}`)],
    sources: [{ url: 'https://patents.google.com/patent/CN217307583U/zh' }] });
  expect(last(await stoppedFixture(fixture))).toMatchObject({ observedQueryCount: 10, observedCoveredQueryCount: null,
    coverageGate: 'NOT_IMPLEMENTED_FOR_RESPONSES' });
});

test('zero observed queries is not misreported as Coverage PASS or a new production gate', async () => {
  const fixture = responsesStageFixture();
  fixture.output[0] = stageSearchCall({ type: 'search', sources: [{ url: 'https://patents.google.com/patent/CN217307583U/zh' }] });
  const boundary = await stoppedFixture(fixture);
  expect(boundary.status['query-coverage']).toBe('NOT_IMPLEMENTED_FOR_RESPONSES');
  expect(last(boundary)).toMatchObject({ observedQueryCount: 0, observedCoveredQueryCount: null });
});

test('stage snapshots are frozen, independent, and early counts never backfill', async () => {
  const boundary = await stoppedFixture(responsesStageFixture());
  expect(new Set(boundary.stages.map(item => item.diagnostics)).size).toBe(3);
  for (const { diagnostics } of boundary.stages) expect(Object.isFrozen(diagnostics)).toBe(true);
  expect(boundary.stages[0].diagnostics).toMatchObject({ searchResultCount: null, observedQueryCount: null, coverageGate: 'NOT_RUN' });
  expect(boundary.stages[1].diagnostics).toMatchObject({ searchResultCount: 2, observedQueryCount: null });
  noSecrets(boundary.stages);
});

for (const payload of [null, {}, { status: 'failed', output: [] }, { status: 'completed', output: {} }]) {
  test(`invalid root ${JSON.stringify(payload)} keeps existing early rejection`, async () => {
    const boundary = createResponsesStageBoundary();
    await expect(parseResearch(payload, input, boundary.observer)).rejects.toThrow(expect.objectContaining({ code: 'RESEARCH_UNVERIFIED' }));
    expect(boundary.stages).toEqual([]); expect(boundary.status).toEqual(initial); assertNoDownstream(boundary);
  });
}

test('strict invocation passes observer to actual parser before late onAttempt and never returns Research success', async () => {
  const boundary = createResponsesStageBoundary(); let delegates = 0;
  const attempts: unknown[] = []; const sequence: string[] = [];
  const invocation = createStrictResearchInvocation({ config,
    onStage: (stage, diagnostics) => { sequence.push(stage); boundary.observer(stage, diagnostics); },
    onAttempt: attempt => { sequence.push('attempt'); attempts.push(attempt); },
    fetcher: async (url, init) => {
      delegates++; expect(String(url)).toBe('https://provider.invalid/v1/responses');
      expect(init?.redirect).toBe('error');
      expect(JSON.parse(init?.body as string)).toMatchObject({ model: 'gpt-6.1-sol', tool_choice: 'required',
        tools: [{ type: 'web_search', filters: { allowed_domains: ['patents.google.com'] } }], include: ['web_search_call.action.sources'] });
      return new Response(JSON.stringify(responsesStageFixture()), { status: 200 });
    } });
  await expect(invocation.run(input, new AbortController().signal)).rejects.toBeInstanceOf(ResponsesStageStop);
  expect(sequence).toEqual(['search-action', 'search-results', 'query-coverage', 'attempt']);
  expect(invocation.state).toMatchObject({ researchRequests: 1, generationRequests: 0, pageFetches: 0, halted: true });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ outcome: 'TEST_RESPONSES_STAGE_STOP', responsesToolResultDiagnostics: { webSearchCallCount: 1 } });
  // Legacy zero attempt counters are not the observed stage measurements.
  expect(attempts[0]).toMatchObject({ searchActionCount: 0, searchResultCount: 0, coveredQueryCount: null });
  expect(last(boundary)).toMatchObject({ searchActionCount: 1, searchResultCount: 2, observedCoveredQueryCount: null });
  assertNoDownstream(boundary); noSecrets(attempts);
  await expect(invocation.run(input, new AbortController().signal)).rejects.toThrow('STRICT_RESEARCH_INVOCATION_REUSED');
  expect(delegates).toBe(1);
});

for (const kind of ['http', 'malformed-json', 'mock-failure']) {
  test(`strict offline ${kind} failure has no retry, fallback or downstream stage`, async () => {
    const boundary = createResponsesStageBoundary(); let delegates = 0;
    const invocation = createStrictResearchInvocation({ config, onStage: boundary.observer, fetcher: async () => {
      delegates++;
      if (kind === 'mock-failure') throw new Error('OFFLINE_MOCK_FAILURE');
      return kind === 'http' ? new Response('{"error":{"code":"unavailable"}}', { status: 502 }) : new Response('not-json');
    } });
    await expect(invocation.run(input, new AbortController().signal)).rejects.toThrow();
    expect(delegates).toBe(1); expect(boundary.stages).toEqual([]); assertNoDownstream(boundary);
    expect(invocation.state).toMatchObject({ researchRequests: 1, generationRequests: 0, pageFetches: 0, halted: true });
  });
}

test('network guard blocks all external paths before native dispatch', async () => {
  expect(process.env.PHASE10_MODE).toBe('local');
  expect(process.env.NODE_OPTIONS).toContain('offlineNetworkGuard.mjs');
  await expect(globalThis.fetch('https://offline.invalid')).rejects.toThrow('PHASE16B_OUTBOUND_FORBIDDEN');
  for (const attempt of [() => http.get('http://offline.invalid'), () => https.get('https://offline.invalid'),
    () => net.connect(443, 'offline.invalid'), () => tls.connect(443, 'offline.invalid'),
    () => new net.Socket().connect(443, 'offline.invalid')]) {
    expect(attempt).toThrow('PHASE16B_OUTBOUND_FORBIDDEN');
  }
  const socket = dgram.createSocket('udp4');
  expect(() => socket.send('offline', 443, 'offline.invalid')).toThrow('PHASE16B_OUTBOUND_FORBIDDEN');
  socket.close();
});
