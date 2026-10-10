import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseResearch, researchPatents } from '../server/patentResearch';
import type { ResponsesResearchStageDiagnostics, ResponsesResearchStageObserver } from '../server/patentResearch';
import { extractResearchFacts, isPatentResearch, isSourcedPatentResearchFact } from '../src/features/utility/patentResearch';
import { buildResearchEvidence, isEvidencePackage } from '../src/features/utility/patentEvidence';
import { providerResearchFixture } from './fixtures/research';
import { offlinePatentFetch, patentPageHtml } from './fixtures/verifiedPatentPage';

const input = { title: 'Offline research fixture', technicalField: 'Mechanical fixture', structure: '', workingPrinciple: '' };
const unknownCoverage = { status: 'UNKNOWN', coveredQueryCount: null, coverageRatio: null,
  reason: 'RESPONSES_WEB_SEARCH_NO_RELIABLE_QUERY_ATTRIBUTION' };
const matrix: Record<string, unknown>[] = [];
const pageResponse = (html = patentPageHtml()) => new Response(html, { headers: { 'content-type': 'text/html' } });
function observer() {
  const stages: Array<{ stage: string; diagnostics: ResponsesResearchStageDiagnostics }> = [];
  const observe: ResponsesResearchStageObserver = (stage, diagnostics) => { stages.push({ stage, diagnostics }); };
  return { stages, observe };
}
async function failureCase(name: string, payload: unknown, fetcher: typeof fetch, failedStage: string, code = 'RESEARCH_UNVERIFIED') {
  const { stages, observe } = observer();
  await expect(parseResearch(payload, input, fetcher, new AbortController().signal, observe)).rejects.toMatchObject({ code });
  const failure = stages.find(entry => entry.stage === failedStage && entry.diagnostics.gateStatus === 'FAIL');
  expect(failure).toBeDefined();
  const coverage = failure!.diagnostics.queryCoverage;
  expect(coverage.coveredQueryCount).toBeNull(); expect(coverage.coverageRatio).toBeNull();
  expect(coverage.status).toBe(['search-action', 'search-results'].includes(failedStage) ? 'NOT_EVALUABLE' : 'UNKNOWN');
  expect(stages.at(-1)?.stage).toBe(failedStage);
  matrix.push({ name, evidenceClass: 'PRODUCTION_PARSED', input: 'OFFLINE_SYNTHETIC_FIXTURE', research: 'FAIL', failedStage, stages });
  // Independently prove the production failure without ANY observer installed.
  await expect(parseResearch(payload, input, fetcher, new AbortController().signal)).rejects.toMatchObject({ code });
}

test('UNKNOWN coverage permits only verified Original Page → Fact → Evidence → Research', async () => {
  const payload = providerResearchFixture();
  const { stages, observe } = observer();
  const requests: Array<{ url: string; method?: string; redirect?: string; auth: boolean }> = [];
  const research = await parseResearch(payload, input, async (target, init) => {
    requests.push({ url: String(target), method: init?.method, redirect: init?.redirect, auth: new Headers(init?.headers).has('Authorization') });
    return offlinePatentFetch(target, init);
  }, new AbortController().signal, observe);
  expect(requests).toEqual([{ url: 'https://patents.google.com/patent/CN217307583U/en', method: 'GET', redirect: 'error', auth: false }]);
  expect(research.queryCoverage).toEqual({ ...unknownCoverage, queryCount: 1 });
  expect(research.sources[0].evidence).toBe('opened');
  expect(research.sources[0].originalPage?.publication).toBe(research.sources[0].publication);
  const fact = research.facts![0];
  expect(fact.originalText).toContain('OFFLINE ORIGINAL:');
  expect(fact.originalText).toContain('Claims:'); expect(fact.originalText).toContain('Description:');
  expect(fact.originalText).not.toContain(research.summary);
  expect(fact.originalText).toContain(fact.extractedFact);
  expect(fact).toMatchObject({ status: 'INFERRED', factType: 'PRIOR_ART_FEATURE', sourceType: 'PATENT', evidenceScope: 'PATENT_ORIGINAL_TEXT',
    relatedComponentIds: [], relatedConnectionIds: [], relatedMotionIds: [], relatedFigureIds: [] });
  const evidence = buildResearchEvidence(research);
  expect(isEvidencePackage(evidence)).toBe(true);
  expect(evidence.research?.queryCoverage).toEqual(research.queryCoverage);
  expect(evidence.items[0]).toMatchObject({ researchFactId: fact.id, sourceId: fact.sourceId, sourceUrl: fact.sourceUrl,
    originalText: fact.originalText, fact: fact.extractedFact, extractedFact: fact.extractedFact, evidenceScope: 'PATENT_ORIGINAL_TEXT' });
  for (const stage of ['search-action', 'search-results', 'original-page', 'fact', 'evidence']) {
    expect(stages.find(entry => entry.stage === stage)?.diagnostics.gateStatus).toBe('PASS');
  }
  expect(stages.find(entry => entry.stage === 'query-coverage')?.diagnostics.gateStatus).toBe('NOT_RUN');
  matrix.push({ name: 'valid-original-chain-with-unknown-coverage', evidenceClass: 'PRODUCTION_PARSED', input: 'OFFLINE_SYNTHETIC_FIXTURE',
    research: 'PASS', coverage: research.queryCoverage, traceability: 'PASS', stages });
  writeFileSync(resolve(process.env.PHASE16B_ARTIFACT_DIR!, 'phase17-provenance-example.json'), JSON.stringify({ research, evidence }, null, 2));
  // No observer dependency on the acceptance path either.
  expect(isPatentResearch(await parseResearch(payload, input, offlinePatentFetch, new AbortController().signal))).toBe(true);
});

for (const kind of ['no-search', 'no-results', 'unqualified-results', 'open-page-only']) {
  test(`production ${kind} blocks before any page access, Coverage NOT_EVALUABLE`, async () => {
    const payload = providerResearchFixture();
    if (kind === 'no-search') payload.output = payload.output.filter(item => item.type === 'message');
    else if (kind === 'open-page-only') payload.output = payload.output.slice(1);
    else payload.output[0].action!.sources = kind === 'no-results' ? [] : [{ type: 'url', url: 'https://example.invalid/nonpatent' }];
    let pages = 0;
    await failureCase(kind, payload, async () => { pages++; throw new Error('PAGE_MUST_NOT_RUN'); },
      kind === 'no-search' || kind === 'open-page-only' ? 'search-action' : 'search-results');
    expect(pages).toBe(0);
  });
}
for (const kind of ['http', 'redirect', 'wrong-content-type', 'identity', 'missing-title', 'missing-abstract', 'missing-claims', 'missing-description', 'network', 'oversized']) {
  test(`Original Page failure (${kind}) blocks Research with UNKNOWN coverage`, async () => {
    const fetcher: typeof fetch = async () => {
      if (kind === 'http') return new Response('Unavailable', { status: 503 });
      if (kind === 'redirect') { const r = pageResponse(); Object.defineProperty(r, 'redirected', { value: true }); return r; }
      if (kind === 'wrong-content-type') return new Response(patentPageHtml(), { headers: { 'content-type': 'application/json' } });
      if (kind === 'network') throw new Error('OFFLINE_PAGE_FETCH_FAILURE');
      if (kind === 'oversized') return pageResponse('x'.repeat(2 * 1024 * 1024 + 1));
      let html = patentPageHtml();
      if (kind === 'identity') html = html.replace('CN217307583U', 'CN217307584U');
      if (kind === 'missing-title') html = html.replace('name="DC.title"', 'name="NOT_A_TITLE"');
      if (kind.startsWith('missing-') && kind !== 'missing-title') html = html.replace(`itemprop="${kind.slice(8)}"`, 'itemprop="missing"');
      return pageResponse(html);
    };
    await failureCase(kind, providerResearchFixture(), fetcher, 'original-page', 'EVIDENCE_FETCH_FAILED');
  });
}

test('Original Page PASS but invalid Fact source metadata blocks Research', async () => {
  // Existing verifyPatentPage accepts a title, whereas sourced facts require <=500 chars.
  await failureCase('fact-validation-failure', providerResearchFixture(), async () =>
    pageResponse(patentPageHtml().replace('Offline verified patent fixture', 'x'.repeat(501))), 'fact');
});

test('UNKNOWN + verified page + facts cannot bypass a failing Evidence package', async () => {
  const payload = providerResearchFixture();
  payload.output[2].content![0].text = 'x'.repeat(12001); // Research summary exceeds the existing package bound.
  await failureCase('evidence-package-validation-failure', payload, offlinePatentFetch, 'evidence');
});

test('open_page metadata without an actual verified GET never establishes ORIGINAL_PAGE', async () => {
  const payload = providerResearchFixture();
  expect(payload.output.some(item => item.action?.type === 'open_page')).toBe(true);
  await expect(parseResearch(payload, input, async () => pageResponse('<html>assistant summary only</html>'), new AbortController().signal))
    .rejects.toMatchObject({ code: 'EVIDENCE_FETCH_FAILED' });
});

test('assistant-only citation and citation to an open-only patent cannot seed page facts', async () => {
  for (const mutate of ['remove-citations', 'open-only-citation', 'empty-citation-text']) {
    const payload = providerResearchFixture();
    if (mutate === 'remove-citations') payload.output[2].content![0].annotations = [];
    if (mutate === 'empty-citation-text') Object.assign(payload.output[2].content![0].annotations![0], { start_index: 0, end_index: 0 });
    if (mutate === 'open-only-citation') payload.output[0].action!.sources![0].url = 'https://patents.google.com/patent/CN217307584U/en';
    let pages = 0;
    await expect(parseResearch(payload, input, async () => { pages++; return pageResponse(); }, new AbortController().signal)).rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
    expect(pages).toBe(0);
  }
});

test('summary extraction cannot upgrade scope even with opened source and a citation', async () => {
  const research = await parseResearch(providerResearchFixture(), input, offlinePatentFetch, new AbortController().signal);
  const entry = { source: research.sources[0], citedText: 'Invented assistant summary, not in the page.', citationId: 'summary-citation' };
  expect(extractResearchFacts([{ ...entry, evidenceScope: 'PATENT_ORIGINAL_TEXT' }])).toEqual([]);
  const summary = extractResearchFacts([entry])[0];
  expect(summary.evidenceScope).toBe('CITED_ASSISTANT_SUMMARY');
  expect(isPatentResearch({ ...research, facts: [{ ...summary, evidenceScope: 'PATENT_ORIGINAL_TEXT' }] })).toBe(false);
  const pkg = buildResearchEvidence({ ...research, facts: [summary] });
  pkg.items[0].evidenceScope = 'PATENT_ORIGINAL_TEXT';
  pkg.research!.facts![0].evidenceScope = 'PATENT_ORIGINAL_TEXT';
  expect(isEvidencePackage(pkg)).toBe(false);
});

test('Fact → Evidence binding rejects independently mutated source, text, scope and user IDs', async () => {
  const research = await parseResearch(providerResearchFixture(), input, offlinePatentFetch, new AbortController().signal);
  const valid = buildResearchEvidence(research);
  const changes = [
    { sourceUrl: 'https://patents.google.com/patent/CN217307584U/en' }, { sourceId: 'CN217307584U' },
    { sourceTitle: 'wrong title' }, { originalText: 'forged page' }, { extractedFact: 'forged fact' }, { fact: 'forged evidence' },
    { evidenceScope: 'CITED_ASSISTANT_SUMMARY' }, { researchFactId: 'RSF-999' }, { status: 'SUPPORTED' },
    { relatedComponentIds: ['C01'] }, { relatedConnectionIds: ['R01'] }, { relatedMotionIds: ['M01'] }, { relatedFigureIds: ['FIG01'] },
    { confidence: 0.99 }, { citationRefs: ['invented'] }, { sourceRefs: ['CN217307584U'] },
  ];
  for (const change of changes) {
    const pkg = structuredClone(valid); Object.assign(pkg.items[0], change);
    expect(isEvidencePackage(pkg), JSON.stringify(change)).toBe(false);
  }
  for (const change of [{ evidence: 'search_result' }, { originalPage: undefined },
    { originalPage: { ...research.sources[0].originalPage!, publication: 'CN217307584U' } }]) {
    const forged = structuredClone(research); Object.assign(forged.sources[0], change);
    expect(isPatentResearch(forged)).toBe(false); expect(() => buildResearchEvidence(forged)).toThrow();
  }
  const orphan = structuredClone(valid); delete orphan.research;
  expect(isEvidencePackage(orphan)).toBe(false);
  for (const change of [{ status: 'SUPPORTED' }, { factType: 'STRUCTURAL_RELATION' }, { relatedComponentIds: ['C01'] },
    { sourceUrl: research.sources[0].url.replace('/en', '/zh') }, { extractedFact: 'not from original' }]) {
    expect(isSourcedPatentResearchFact({ ...research.facts![0], ...change })).toBe(false);
  }
});

test('multiple sources fetch separately and cannot duplicate or swap the evidence-to-fact mapping', async () => {
  const payload = providerResearchFixture();
  const second = 'https://patents.google.com/patent/CN217307584U/en';
  payload.output[0].action!.sources!.push({ type: 'url', url: second });
  payload.output[2].content!.push({ type: 'output_text', text: 'Second assistant summary.', annotations: [{ type: 'url_citation', title: 'Second source', url: second }] });
  const requests: string[] = [];
  const research = await parseResearch(payload, input, async (target, init) => { requests.push(String(target)); return offlinePatentFetch(target, init); }, new AbortController().signal);
  expect(requests).toHaveLength(2); expect(research.facts).toHaveLength(2);
  const valid = buildResearchEvidence(research);
  const duplicate = structuredClone(valid); duplicate.items[1] = { ...duplicate.items[0], id: 'EVID-002' };
  expect(isEvidencePackage(duplicate)).toBe(false);
  const swapped = structuredClone(valid); swapped.items[0].researchFactId = swapped.items[1].researchFactId;
  expect(isEvidencePackage(swapped)).toBe(false);
  await expect(parseResearch(payload, input, async (target, init) => String(target) === second
    ? pageResponse('<html>unverified</html>') : offlinePatentFetch(target, init), new AbortController().signal)).rejects.toMatchObject({ code: 'EVIDENCE_FETCH_FAILED' });
});

for (const order of ['normal', 'reverse']) {
  test(`single/multiple query and 1/12 results never establish attribution (${order})`, async () => {
    for (const queries of [['q1'], ['q1', 'q2']]) for (const count of [1, 12]) {
      const payload = providerResearchFixture();
      payload.output[0].action!.queries = queries;
      for (let i = 1; i < count; i++) payload.output[0].action!.sources!.push({ type: 'url', url: `https://patents.google.com/patent/CN2200000${String(i).padStart(2, '0')}U/en` });
      Object.assign(payload.output[0].action!, { coveredQueryCount: queries.length, query_id: 'fabricated', resultQueryMap: 'fabricated' });
      if (order === 'reverse') payload.output.reverse();
      const research = await parseResearch(payload, input, offlinePatentFetch, new AbortController().signal);
      expect(research.queryCoverage).toEqual({ ...unknownCoverage, queryCount: queries.length });
      expect(research.facts).toHaveLength(1); // Uncited results are neither page facts nor query coverage.
      const forged = structuredClone(research); Object.assign(forged.queryCoverage!, { status: 'MEASURED', coveredQueryCount: queries.length, coverageRatio: 1 });
      expect(isPatentResearch(forged)).toBe(false);
    }
  });
}

test('actual research caller wires the injected page fetch, preserving null Coverage in attempt diagnostics', async () => {
  const calls: string[] = [], attempts: unknown[] = [];
  const config = { baseUrl: 'https://phase17-provider.invalid/v1', apiKey: 'OFFLINE_ONLY', model: 'offline-research', researchProtocol: 'responses' as const };
  const research = await researchPatents(input, config, new AbortController().signal, async (target, init) => {
    calls.push(String(target));
    if (init?.method === 'GET') return offlinePatentFetch(target, init);
    expect(String(target)).toBe(`${config.baseUrl}/responses`);
    return Response.json(providerResearchFixture());
  }, result => attempts.push(result));
  expect(calls).toEqual([`${config.baseUrl}/responses`, 'https://patents.google.com/patent/CN217307583U/en']);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ outcome: 'completed', coveredQueryCount: null, coverageRatio: null,
    queryCoverageStatus: 'UNKNOWN', responsesStageDiagnostics: { queryCoverage: unknownCoverage } });
  expect(isEvidencePackage(buildResearchEvidence(research))).toBe(true);
});

test('cancellation between page GET and Fact extraction cannot complete Research', async () => {
  const controller = new AbortController();
  await expect(parseResearch(providerResearchFixture(), input, async () => {
    controller.abort(new Error('OFFLINE_CANCELLED')); return pageResponse();
  }, controller.signal)).rejects.toThrow('OFFLINE_CANCELLED');
});

test('long pages produce bounded verbatim excerpts, not model summaries or inferred full-page coverage', async () => {
  const abstract = 'Verified abstract sentence. '.repeat(300);
  const research = await parseResearch(providerResearchFixture(), input, async () => pageResponse(patentPageHtml('CN217307583U', abstract)), new AbortController().signal);
  expect(research.sources[0].originalPage!.abstract).toHaveLength(3500);
  expect(research.facts![0].extractedFact.length).toBeLessThanOrEqual(2000);
  expect(abstract).toContain(research.facts![0].extractedFact);
  expect(research.facts![0].originalText.length).toBeLessThanOrEqual(12000);
  expect(research.queryCoverage).toMatchObject(unknownCoverage);
});

test.afterAll(() => {
  writeFileSync(resolve(process.env.PHASE16B_ARTIFACT_DIR!, 'research-gate-matrix.json'), JSON.stringify(matrix, null, 2));
  writeFileSync(resolve(process.env.PHASE16B_ARTIFACT_DIR!, 'query-coverage-diagnostic.json'), JSON.stringify({ ...unknownCoverage,
    evidenceClass: 'PRODUCTION_PARSED', input: 'OFFLINE_SYNTHETIC_FIXTURE', queryToSourceInference: false, unknownBlocksEvidence: false,
    earlierSearchFailureStatus: 'NOT_EVALUABLE' }, null, 2));
});
