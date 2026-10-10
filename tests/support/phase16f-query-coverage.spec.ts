import { expect, test } from '@playwright/test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { parseOfflineResearch as parseResearch } from '../fixtures/verifiedPatentPage';
import type { ResponsesResearchStageDiagnostics } from '../../server/patentResearch.ts';
import { summarizeResponsesResearchToolResult } from '../../server/researchProvider.ts';
import historical from '../fixtures/phase16eResponsesCoverage.json' with { type: 'json' };
import { coverageFixtureCounts, responsesCoverageFixture } from '../fixtures/responsesQueryCoverage.ts';
import type { CoverageFixtureName } from '../fixtures/responsesQueryCoverage.ts';
import { poisonAssistantContent, stageFixtureSecrets } from '../fixtures/responsesStageBoundary.ts';
import { createResponsesStageBoundary, ResponsesStageStop } from './responsesStageBoundary.ts';
import { observeUnresolvedResponsesQueryCoverage } from './responsesQueryCoverage.ts';

const input = { title: 'Offline coverage fixture', technicalField: 'Offline mechanical fixture', structure: '', workingPrinciple: '' };

function noSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of [...Object.values(stageFixtureSecrets), 'Authorization', 'Bearer', 'Cookie', 'token=', 'api_key=', 'https://']) {
    expect(serialized).not.toContain(secret);
  }
}

// Measurement-only callback, not an acceptance gate; D's strict search-results boundary still fails.
async function observeFixture(payload: ReturnType<typeof responsesCoverageFixture>, qualified = true) {
  const trap = poisonAssistantContent(payload);
  const stages: Array<{ stage: string; diagnostics: ResponsesResearchStageDiagnostics }> = [];
  await expect(parseResearch(payload, input, (stage, diagnostics) => {
    stages.push({ stage, diagnostics });
    if (stage === 'query-coverage') throw new ResponsesStageStop(stage);
    if (stage === 'citation' || stage === 'source' || stage === 'fact') throw new Error('DOWNSTREAM_FORBIDDEN');
  })).rejects.toThrow(expect.objectContaining(qualified ? { code: 'TEST_RESPONSES_STAGE_STOP', stage: 'query-coverage' } : { code: 'RESEARCH_UNVERIFIED' }));
  expect(trap.reads).toBe(0);
  expect(stages.map(item => item.stage)).toEqual(qualified ? ['search-action', 'search-results', 'query-coverage'] : ['search-action', 'search-results']);
  noSecrets(stages);
  return stages[stages.length - 1].diagnostics;
}

function assertUnknown(diagnostics: Pick<ResponsesResearchStageDiagnostics, 'observedQueryCount'>) {
  const coverage = observeUnresolvedResponsesQueryCoverage(diagnostics);
  expect(coverage).toMatchObject({ measurement: 'OBSERVED_ONLY', coveredQueryCount: null, coverageRatio: null,
    gate: 'NOT_EVALUABLE', reason: 'QUERY_RESULT_ASSOCIATION_NOT_ESTABLISHED' });
  expect(coverage.statuses).toEqual(Array.from({ length: diagnostics.observedQueryCount ?? 0 }, (_, queryIndex) => ({ queryIndex, status: 'UNKNOWN' })));
  noSecrets(coverage);
  return coverage;
}

for (const name of Object.keys(coverageFixtureCounts) as CoverageFixtureName[]) {
  test(`Fixture ${name}: observed counts cannot establish per-query attribution`, async () => {
    const expected = coverageFixtureCounts[name];
    const diagnostics = await observeFixture(responsesCoverageFixture(name), name !== 'D');
    expect(diagnostics).toMatchObject({ searchActionCount: 1, searchResultCount: expected.results,
      qualifiedPatentResultCount: expected.qualified, observedQueryCount: name === 'D' ? null : expected.queries,
      observedCoveredQueryCount: null, coverageGate: name === 'D' ? 'NOT_RUN' : 'NOT_IMPLEMENTED_FOR_RESPONSES' });
    expect(assertUnknown(diagnostics).queryCount).toBe(name === 'D' ? null : expected.queries);
    expect(diagnostics.queryCoverage.status).toBe(name === 'D' ? 'NOT_EVALUABLE' : 'UNKNOWN');

    const boundary = createResponsesStageBoundary();
    const payload = responsesCoverageFixture(name);
    const trap = poisonAssistantContent(payload);
    await expect(parseResearch(payload, input, boundary.observer)).rejects.toThrow(expect.objectContaining({
      code: 'TEST_RESPONSES_STAGE_STOP', stage: name === 'D' ? 'search-results' : 'query-coverage',
    }));
    expect(boundary.invocations).toEqual({ citation: 0, source: 0, fact: 0 });
    expect(trap.reads).toBe(0);
    expect(boundary.status['search-results']).toBe(name === 'D' ? 'FAIL' : 'PASS');
    if (name === 'D') {
      expect(boundary.status['query-coverage']).toBe('NOT_RUN');
      expect(boundary.stages[1].diagnostics.observedQueryCount).toBeNull();
    }
  });
}

test('one observed query with twelve results is not coverage 1/1', async () => {
  const payload = responsesCoverageFixture('C');
  const action = payload.output[0].action as Record<string, unknown>;
  action.query = stageFixtureSecrets.query;
  action.queries = [stageFixtureSecrets.query];
  const sources = action.sources as Record<string, unknown>[];
  sources.push({ url: 'https://patents.google.com/patent/CN220000011U/zh' }, { url: 'https://patents.google.com/patent/CN220000012U/zh' });
  const diagnostics = await observeFixture(payload);
  expect(diagnostics).toMatchObject({ observedQueryCount: 1, searchResultCount: 12, qualifiedPatentResultCount: 12 });
  assertUnknown(diagnostics);
});

test('two observed queries with ten results cannot imply covered count 1 or 2', async () => {
  const diagnostics = await observeFixture(responsesCoverageFixture('C'));
  expect(diagnostics).toMatchObject({ observedQueryCount: 2, searchResultCount: 10 });
  const coverage = assertUnknown(diagnostics);
  expect(coverage.coveredQueryCount).not.toBe(1);
  expect(coverage.coveredQueryCount).not.toBe(2);
});

test('unknown and zero query counts never become zero coverage or vacuous PASS', async () => {
  for (const observedQueryCount of [null, 0]) {
    const coverage = assertUnknown({ observedQueryCount });
    expect(coverage.queryCount).toBe(observedQueryCount);
    expect(coverage.statuses).toEqual([]);
  }
});

test('observed queries use production uniqueness, validity and cap, not an exhaustive query claim', async () => {
  const payload = responsesCoverageFixture('A');
  const action = payload.output[0].action as Record<string, unknown>;
  action.queries = [action.query, '', ' ', null, 123, 'x'.repeat(1001),
    ...Array.from({ length: 12 }, (_, index) => `${stageFixtureSecrets.query}_extra_${index}`)];
  const diagnostics = await observeFixture(payload);
  expect(diagnostics.observedQueryCount).toBe(10);
  expect(assertUnknown(diagnostics).statuses).toHaveLength(10);
});

test('observations reject malformed counts without reflecting unsafe input', async () => {
  for (const observedQueryCount of [-1, 11, 1.5, NaN, Infinity, undefined, stageFixtureSecrets.query]) {
    expect(() => observeUnresolvedResponsesQueryCoverage({ observedQueryCount: observedQueryCount as number }))
      .toThrow('INVALID_OBSERVED_QUERY_COUNT');
  }
});

test('coverage summary is immutable and ignores result count or invented metadata', async () => {
  const observation = { observedQueryCount: 2, searchResultCount: 1000,
    coveredQueryCount: 2, query_id: stageFixtureSecrets.id, resultQueryMap: stageFixtureSecrets.query };
  const coverage = assertUnknown(observation);
  expect(Object.isFrozen(coverage)).toBe(true);
  expect(Object.isFrozen(coverage.statuses)).toBe(true);
  for (const status of coverage.statuses) expect(Object.isFrozen(status)).toBe(true);
  expect(Object.keys(coverage).sort()).toEqual(['measurement', 'queryCount', 'coveredQueryCount', 'coverageRatio', 'statuses', 'gate', 'reason'].sort());
});

test('invented attribution fields are ignored by production observations and sanitized diagnostics', async () => {
  const payload = responsesCoverageFixture('B');
  const action = payload.output[0].action as Record<string, unknown>;
  action.query_id = stageFixtureSecrets.id;
  action.resultQueryMap = { [stageFixtureSecrets.query]: 'COVERED' };
  const diagnostics = await observeFixture(payload);
  assertUnknown(diagnostics);
  const summary = summarizeResponsesResearchToolResult(payload);
  noSecrets(summary);
  expect(JSON.stringify(summary)).not.toContain('resultQueryMap');
  expect(JSON.stringify(summary)).not.toContain('query_id');
});

test('URL credentials, query, fragment, full tool ID and raw error text stay out of diagnostics', async () => {
  const payload = responsesCoverageFixture('A');
  const action = payload.output[0].action as Record<string, unknown>;
  action.sources = [{ type: 'url', url: `https://${stageFixtureSecrets.username}:${stageFixtureSecrets.password}@patents.google.com/patent/CN220000001U/zh?token=${stageFixtureSecrets.token}&api_key=${stageFixtureSecrets.apiKey}#${stageFixtureSecrets.fragment}` }];
  payload.output[0].error = { type: 'provider_private_error', code: 'provider_private_code', message: stageFixtureSecrets.error };
  const diagnostics = await observeFixture(payload, false);
  expect(diagnostics.queryCoverage.status).toBe('NOT_EVALUABLE');
  const summary = summarizeResponsesResearchToolResult(payload);
  noSecrets({ summary, coverage: assertUnknown(diagnostics) });
  expect(summary.webSearchCalls[0].sources).toEqual([{ hostname: 'patents.google.com', pathname: '/patent/CN220000001U/zh' }]);
});

test('Phase 16E historical sanitized diagnostic remains UNKNOWN without reconstructing a raw payload', async () => {
  expect(historical.fixtureSource).toBe('Phase 16E REAL RESPONSE - SANITIZED DIAGNOSTIC EXCERPT');
  expect(historical.rawPayloadAvailable).toBe(false);
  expect(historical.classification).toBe('RESEARCH_RECOVERY_PARTIAL');
  expect(historical.observedResearchDiagnostics).toEqual({ searchActionCount: 1, searchResultCount: 12,
    qualifiedPatentResultCount: 12, queryCount: 1, coveredQueryCount: null });
  const stage = historical.stageSnapshots.find(item => item.stage === 'query-coverage');
  expect(stage).toBeDefined();
  const coverage = assertUnknown({ observedQueryCount: stage!.diagnostics.observedQueryCount });
  expect(coverage.queryCount).toBe(1);
  expect(coverage.statuses).toEqual([{ queryIndex: 0, status: 'UNKNOWN' }]);
  expect(historical.stageSnapshots.map(item => item.stage)).toEqual(['search-action', 'search-results', 'query-coverage']);
  expect(historical.response.webSearchCalls[0]).toMatchObject({ queryPresent: true, queryLength: 36, sourceCount: 12 });
  expect(historical.stageStop).toBe('query-coverage');
  noSecrets(historical);
});

test('offline network guard is installed without issuing even a blocked connection probe', async () => {
  expect(process.env.PHASE10_MODE).toBe('local');
  expect(process.env.NODE_OPTIONS).toContain('offlineNetworkGuard.mjs');
  expect(globalThis.fetch.toString()).toContain('block()');
  const block = http.request;
  expect(block.toString()).toContain('PHASE16B_OUTBOUND_FORBIDDEN');
  for (const method of [http.get, https.request, https.get, net.connect, net.createConnection,
    net.Socket.prototype.connect, tls.connect, dgram.Socket.prototype.send]) expect(method).toBe(block);
});
