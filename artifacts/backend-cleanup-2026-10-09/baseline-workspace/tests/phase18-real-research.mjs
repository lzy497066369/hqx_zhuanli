// Explicit one-shot Research probe, not discovered by any Playwright test glob.
import { register } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, openSync, closeSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createPhase18NetworkGuard } from './support/phase18NetworkGuard.mjs';

const mode = process.argv[2], directory = realpathSync(process.argv[3] || '.');
if (!['--preflight', '--real'].includes(mode) || !/^\/(?:private\/)?tmp\/phase18-[0-9-]+$/.test(directory)) {
  throw new Error('PHASE18_EXPLICIT_MODE_AND_EXTERNAL_ARTIFACTS_REQUIRED');
}
const root = process.cwd();
const hash = value => createHash('sha256').update(value).digest('hex');
const sensitive = new Set();
const nativeFetch = globalThis.fetch.bind(globalThis);
const audit = { phase: '18', startedAt: new Date().toISOString(), mode: mode.slice(2), preflight: 'NOT_COMPLETED',
  researchProviderRequests: 0, generationProviderRequests: 0, totalExternalAiRequests: 0, patentPageRequests: 0,
  fallbackCount: 0, rotationCount: 0, retryCount: 0, maxProviderRequests: 1, maxAttempts: 1,
  allowFallback: false, allowRotation: false, rawRequestSaved: false, rawResponseSaved: false,
  fullPatentPageSaved: false, applicationStarted: false, phase19: 'NOT_STARTED', events: [], stages: [] };
let guard, invocation, failure = null, research = null, evidence = null, config;
let responseDiagnostic = null, httpStatus = null, classification = 'BLOCKED', security = 'PASS';
function safeSave(name, value) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  for (const secret of sensitive) if (serialized.includes(secret)) { security = 'FAIL'; throw new Error('PHASE18_SENSITIVE_ARTIFACT_BLOCKED'); }
  writeFileSync(resolve(directory, name), serialized, { mode: 0o600 });
}
function checkpoint() {
  if (guard) Object.assign(audit, {
    researchProviderRequests: guard.state.researchProviderRequests, generationProviderRequests: guard.state.generationProviderRequests,
    totalExternalAiRequests: guard.state.totalExternalAiRequests, patentPageRequests: guard.state.patentPageRequests,
    networkGuard: { ...guard.state },
  });
  safeSave(mode === '--real' ? 'real-execution-audit.json' : 'preflight-audit.json', audit);
}
function record(event) { audit.events.push(event); checkpoint(); }
function snapshot() {
  const result = {};
  function visit(path, prefix = '') {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['node_modules', '.git', '.DS_Store'].includes(entry.name)) continue;
      const rel = prefix + entry.name;
      if (entry.isDirectory()) visit(resolve(path, entry.name), rel + '/');
      else if (entry.isFile()) result[rel] = hash(readFileSync(resolve(path, entry.name)));
    }
  }
  visit(root); return result;
}
function safeDiagnostic(diagnostic) {
  const copy = structuredClone(diagnostic);
  for (const call of copy.webSearchCalls || []) for (const location of [...call.sources, ...(call.openedLocation ? [call.openedLocation] : [])]) {
    if (location.hostname !== 'patents.google.com') { location.hostname = '[other-host]'; location.pathname = '[redacted]'; }
    else if (!/^\/patent\/[A-Z]{2}\d+[A-Z]\d?(?:\/[A-Za-z]{2})?\/?$/u.test(location.pathname)) location.pathname = '[redacted]';
  }
  return copy;
}
const baseline = JSON.parse(readFileSync(resolve(directory, 'baseline-sha256.json'), 'utf8'));
const sourceBeforeRun = snapshot();
try {
  guard = createPhase18NetworkGuard({ nativeFetch, record });
  guard.install();
  register(new URL('./support/phase18TsLoader.mjs', import.meta.url));
  const { loadEnv } = await import('vite');
  const { readAiConfig } = await import('../server/drawingAi.ts');
  const { aiProviders } = await import('../server/aiSupport.ts');
  const { strictResearchConfig, strictResearchPolicy, createStrictResearchInvocation } = await import('./support/strictResearchPolicy.ts');
  const { buildResearchEvidence, isEvidencePackage } = await import('../src/features/utility/patentEvidence.ts');
  const { factMatchesOriginalPage } = await import('../src/features/utility/patentResearch.ts');
  config = readAiConfig({ ...loadEnv('development', root, 'AI_'), ...process.env });
  for (const key of [config.apiKey, config.fallbackApiKey, config.secondFallbackApiKey]) if (typeof key === 'string' && key.length > 3) sensitive.add(key);
  assert.equal(config.baseUrl, 'https://api.psydo.top/v1'); assert.equal(config.model, 'gpt-6-astra');
  assert.equal(config.researchModel, 'gpt-6-astra'); assert.equal(config.researchProtocol, 'responses');
  assert.equal(config.fallbackModel, 'gpt-6-sol'); assert.equal(config.secondFallbackModel, 'gpt-5.6-sol');
  assert(config.apiKey.trim());
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  assert.notEqual(process.env.NODE_USE_ENV_PROXY, '1');
  const pinned = strictResearchConfig(config);
  assert.equal(aiProviders(pinned, pinned.researchModel).length, 1);
  assert.deepEqual(strictResearchPolicy, { maxProviderRequests: 1, allowFallback: false, allowRotation: false, maxAttempts: 1 });
  const changedProduction = Object.keys(baseline).filter(file => !file.startsWith('tests/') && baseline[file] !== sourceBeforeRun[file]);
  assert.deepEqual(changedProduction, []);
  audit.configuration = { provider: 'api.psydo.top', model: 'gpt-6-astra', protocol: 'responses',
    credentialsPresent: true, pinnedProviderCount: 1, productionConfigUnmodified: true,
    patentPagesOptIn: true, generation: 'DISABLED', fallback: 'DISABLED', rotation: 'DISABLED', retry: 'DISABLED' };
  if (mode === '--real') {
    assert.equal(process.env.PHASE18_APPROVED_SINGLE_REQUEST, '1');
    const preflight = JSON.parse(readFileSync(resolve(directory, 'preflight-verification.json'), 'utf8'));
    assert.equal(preflight.status, 'PASS'); assert.deepEqual(preflight.hashes, sourceBeforeRun);
    const offline = JSON.parse(readFileSync(resolve(directory, 'offline-tests/results.json'), 'utf8'));
    assert(offline.stats.expected > 0 && offline.stats.unexpected === 0 && offline.stats.flaky === 0 && !offline.errors.length);
    // Persistent, phase-specific tripwire: later launches cannot dispatch another request.
    const lock = openSync('/tmp/phase18-real-research-once.lock', 'wx', 0o600);
    writeFileSync(lock, JSON.stringify({ directory, startedAt: audit.startedAt })); closeSync(lock);
    audit.dispatchLockAcquired = true;
  }
  audit.preflight = 'PASS'; checkpoint();
  console.log(['Provider: api.psydo.top', 'Model: gpt-6-astra', 'Protocol: responses', 'Research requests: 0 / 1',
    'Fallback: DISABLED', 'Rotation: DISABLED', 'Retry: DISABLED', 'Generation: DISABLED',
    `Mode: ${mode.slice(2)}`].join('\n'));
  if (mode === '--preflight') {
    safeSave('preflight-verification.json', { status: 'PASS', hashes: sourceBeforeRun, providerRequests: 0, configuration: audit.configuration });
    classification = 'PREFLIGHT_PASS';
  } else {
    invocation = createStrictResearchInvocation({ config, allowPatentPages: true,
      fetcher: (target, init) => guard.fetch(target, { ...init,
        signal: init.method === 'POST' ? AbortSignal.any([init.signal, AbortSignal.timeout(90_000)]) : init.signal }),
      record,
      onStage(stage, diagnostics) { audit.stages.push({ stage, diagnostics, at: new Date().toISOString() }); checkpoint(); },
      onAttempt(attempt) {
        httpStatus = attempt.httpStatus;
        if (attempt.responsesToolResultDiagnostics) responseDiagnostic = safeDiagnostic(attempt.responsesToolResultDiagnostics);
        audit.attempt = { model: attempt.model, protocol: attempt.protocol, httpStatus: attempt.httpStatus,
          elapsedMs: attempt.elapsedMs, outcome: attempt.outcome, failureKind: attempt.failureKind || null };
        checkpoint();
      },
    });
    research = await invocation.run({ title: '一种具有可调夹持机构的机械夹具',
      technicalField: '机械夹具；检索关键词至少覆盖：机械夹具、可调夹持、夹持机构、夹紧结构。仅研究公开专利，不生成用户产品方案。',
      structure: '', workingPrinciple: '' }, AbortSignal.timeout(180_000));
    evidence = buildResearchEvidence(research);
    assert(isEvidencePackage(evidence));
    assert.equal(httpStatus, 200); assert.equal(responseDiagnostic?.responseStatus, 'completed');
    assert(research.sources.length >= 1 && research.facts.length >= 1 && evidence.items.length >= 1);
    assert.deepEqual(research.queryCoverage, { status: 'UNKNOWN', queryCount: research.queries.length,
      coveredQueryCount: null, coverageRatio: null, reason: 'RESPONSES_WEB_SEARCH_NO_RELIABLE_QUERY_ATTRIBUTION' });
    for (const fact of research.facts) {
      assert(factMatchesOriginalPage(fact, research.sources)); assert.equal(fact.evidenceScope, 'PATENT_ORIGINAL_TEXT');
      assert.equal(fact.factType, 'PRIOR_ART_FEATURE'); assert.equal(fact.status, 'INFERRED');
      for (const name of ['relatedComponentIds', 'relatedConnectionIds', 'relatedMotionIds', 'relatedFigureIds']) assert.deepEqual(fact[name], []);
      const item = evidence.items.find(item => item.researchFactId === fact.id);
      assert(item && item.originalText === fact.originalText && item.extractedFact === fact.extractedFact);
    }
    assert.equal(guard.state.researchProviderRequests, 1); assert.equal(guard.state.generationProviderRequests, 0);
    assert.equal(guard.state.blockedAttempts, 0); assert.equal(invocation.state.violations, 0);
    classification = 'PASS';
  }
} catch (error) {
  const safeCodes = ['RESEARCH_UNAVAILABLE', 'RESEARCH_UNVERIFIED', 'EVIDENCE_FETCH_FAILED', 'AI_TOO_LARGE', 'AI_EMPTY',
    'ERR_ASSERTION', 'EEXIST', 'PHASE18_SENSITIVE_ARTIFACT_BLOCKED'];
  failure = { errorType: ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'Error',
    code: safeCodes.includes(error?.code) ? error.code : error?.message === 'PHASE18_SENSITIVE_ARTIFACT_BLOCKED' ? error.message : 'UNKNOWN',
    lastObservedStage: audit.stages.at(-1)?.stage || null };
  classification = guard?.state.researchProviderRequests ? 'REAL_RESEARCH_FAILED' : 'BLOCKED';
} finally {
  guard?.close();
  audit.finishedAt = new Date().toISOString(); audit.classification = classification; audit.failure = failure;
  if (invocation) audit.strictTransport = { ...invocation.state };
  checkpoint();
  const after = snapshot();
  safeSave(mode === '--real' ? 'final-sha256.json' : 'preflight-sha256.json', after);
  const modified = [...new Set([...Object.keys(baseline), ...Object.keys(after)])].filter(file => baseline[file] !== after[file]);
  const unexpected = modified.filter(file => !file.startsWith('tests/'));
  if (unexpected.length) classification = 'BLOCKED';
  if (mode === '--real') {
    const stage = name => audit.stages.filter(entry => entry.stage === name).at(-1)?.diagnostics;
    const state = name => stage(name)?.gateStatus === 'PASS' ? 'PASS' : stage(name)?.gateStatus === 'FAIL' ? 'FAIL' : 'NOT_RUN';
    const facts = classification === 'PASS' ? research.facts.map(fact => {
      const source = research.sources.find(source => source.publication === fact.sourceId);
      const item = evidence.items.find(item => item.researchFactId === fact.id);
      const url = new URL(source.url);
      return { evidenceClass: ['REAL_OBSERVED', 'PRODUCTION_PARSED'], publicationNumber: source.publication,
        hostname: url.hostname, pathname: url.pathname, originalPageFetched: true, verified: true,
        originalSection: 'abstract', verifiedSections: ['abstract', 'claims', 'description'],
        sections: Object.fromEntries(['abstract', 'claims', 'description'].map(name => [name,
          { boundedLength: source.originalPage[name].length, sha256: hash(source.originalPage[name]) }])),
        boundedExcerpt: { length: fact.extractedFact.length, sha256: hash(fact.extractedFact), textSaved: false },
        factId: fact.id, factType: fact.factType, status: fact.status, evidenceScope: fact.evidenceScope,
        factTextEqualsPageAbstractPrefix: fact.extractedFact === source.originalPage.abstract.slice(0, 2000).trim(),
        originalTextSha256: hash(fact.originalText), originalTextLength: fact.originalText.length,
        evidenceId: item.id, researchFactId: item.researchFactId, evidenceMatchesFact: true,
        assistantSummaryUsedAsOriginal: false, userStructureIds: [],
        trace: ['Evidence', 'Fact', 'Original Page', 'Qualified Patent Result', 'Search'] };
    }) : [];
    const queryCoverage = stage('query-coverage')?.queryCoverage || stage('search-results')?.queryCoverage || stage('search-action')?.queryCoverage ||
      { status: 'NOT_RUN', coveredQueryCount: null, coverageRatio: null };
    const chain = { research: classification === 'PASS' ? 'PASS' : 'FAIL', search: state('search-action'), qualifiedResults: state('search-results'),
      queryCoverage, originalPage: state('original-page'), fact: state('fact'), evidence: state('evidence'),
      traceability: classification === 'PASS' ? 'PASS' : 'NOT_ESTABLISHED', facts,
      rawResponseSaved: false, fullPageSaved: false, boundedExcerptTextSaved: false,
      sourceOfNewRealObservations: 'PHASE18_SINGLE_RESEARCH_RUN', historicalObservationsReusedAsNew: false };
    safeSave('real-responses-diagnostic.json', { evidenceClass: 'REAL_OBSERVED', httpStatus, response: responseDiagnostic,
      searchActionCount: stage('search-action')?.searchActionCount ?? null,
      searchResultCount: stage('search-results')?.searchResultCount ?? null,
      qualifiedPatentResultCount: stage('search-results')?.qualifiedPatentResultCount ?? null,
      queryCount: stage('query-coverage')?.observedQueryCount ?? null, queryCoverage });
    safeSave('real-evidence-chain.json', chain);
    safeSave('verification.json', { classification, finalStatus: classification === 'PASS' ? 'PHASE18_PASS' : classification,
      provider: 'api.psydo.top', model: 'gpt-6-astra', protocol: 'responses', security,
      networkGuard: guard?.state.installed && guard.state.blockedAttempts === 0 ? 'PASS' : 'FAIL',
      modifiedFiles: modified, unexpectedChanges: unexpected, productionFilesUnchanged: unexpected.length === 0,
      failure, history: 'unchanged', phase19: 'NOT_STARTED', chain });
  }
  console.log(JSON.stringify({ phase: 18, mode, classification, researchRequests: audit.researchProviderRequests,
    generationRequests: audit.generationProviderRequests, pageRequests: audit.patentPageRequests, failure }));
  // Process exits immediately after the probe; do not restore/open a networking path.
  process.exitCode = ['PASS', 'PREFLIGHT_PASS'].includes(classification) ? 0 : 2;
}
