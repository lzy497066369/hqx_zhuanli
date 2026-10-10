// Paid real-provider smoke test. No mocked search, citations or provider responses.
import { expect, test } from '@playwright/test';
import { loadEnv } from 'vite';
import { readAiConfig } from '../server/drawingAi';
import { researchPatents } from '../server/patentResearch';
import { buildResearchEvidence } from '../src/features/utility/patentEvidence';

test('REAL Research smoke → non-empty sourced Evidence', async ({ browserName }, testInfo) => {
  test.skip(process.env.LIVE_RESEARCH_SMOKE !== '1', 'Set LIVE_RESEARCH_SMOKE=1 for a paid real Research request.');
  test.setTimeout(200_000);
  const config = readAiConfig({ ...loadEnv('development', process.cwd(), 'AI_'), ...process.env });
  const metrics: Record<string, unknown> = {
    browser: browserName,
    provider: (() => { try { return new URL(config.baseUrl).hostname; } catch { return 'not-configured'; } })(),
    model: config.researchModel || config.model, protocol: config.researchProtocol || 'responses',
    searchActionCount: null, searchResultCount: null, qualifiedPatentResultCount: null,
    queryCount: null, coveredQueryCount: null, citationCount: null,
    originalPageCount: null, verifiedSourceCount: null,
    httpStatus: null, sourceCount: null, factCount: null, evidenceCount: null,
    evidenceScopes: null, supportedCount: null, inferredCount: null,
  };
  let passed = false;
  let errorType = 'UNKNOWN';
  try {
    if (!config.apiKey || !config.baseUrl || !config.model) {
      errorType = 'AI_NOT_CONFIGURED';
      throw new Error(errorType);
    }
    const title = process.env.LIVE_RESEARCH_TITLE || '可调节夹持装置';
    const research = await researchPatents(
      { title, technicalField: process.env.LIVE_RESEARCH_TITLE ? `涉及${title}的产品结构与机械装配技术领域。` : '机械夹持', structure: '', workingPrinciple: '' },
      config, AbortSignal.timeout(180_000), fetch,
      attempt => { metrics.httpStatus = attempt.httpStatus; metrics.model = attempt.model; metrics.outcome = attempt.outcome;
        metrics.searchActionCount = attempt.searchActionCount; metrics.searchResultCount = attempt.searchResultCount;
        metrics.qualifiedPatentResultCount = attempt.qualifiedPatentResultCount;
        metrics.queryCount = attempt.queryCount; metrics.coveredQueryCount = attempt.coveredQueryCount;
        metrics.citationCount = attempt.citationCount; metrics.originalPageCount = attempt.originalPageCount;
        metrics.verifiedSourceCount = attempt.verifiedSourceCount; metrics.factCount = attempt.factCount;
        metrics.failureStage = attempt.failureStage; metrics.failureReason = attempt.failureReason; },
    );
    const evidence = buildResearchEvidence(research);
    Object.assign(metrics, {
      sourceCount: research.sources.length, factCount: research.facts?.length || 0, evidenceCount: evidence.items.length,
      evidenceScopes: evidence.items.reduce((counts: Record<string, number>, item) => {
        const scope = item.evidenceScope || 'UNSPECIFIED'; counts[scope] = (counts[scope] || 0) + 1; return counts;
      }, {}),
      supportedCount: evidence.items.filter(item => item.status === 'SUPPORTED').length,
      inferredCount: evidence.items.filter(item => item.status === 'INFERRED').length,
      originalTextEvidenceCount: evidence.items.filter(item => item.evidenceScope?.startsWith('PATENT_')).length,
    });
    expect(research.sources.length).toBeGreaterThan(0);
    expect(research.facts?.length).toBeGreaterThan(0);
    expect(evidence.items.length).toBeGreaterThan(0);
    expect(evidence.items.every(item => item.sourceId && item.sourceUrl && item.originalText && item.evidenceScope)).toBe(true);
    passed = true;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && /^[A-Z_]{2,80}$/u.test(code)) errorType = code;
    else if (error instanceof Error && error.name === 'TimeoutError') errorType = 'RESEARCH_TIMEOUT';
    else if (errorType === 'UNKNOWN') errorType = 'RESEARCH_SMOKE_FAILED';
    throw new Error(`REAL E2E BLOCKED: stage=research; errorType=${errorType}`);
  } finally {
    // No upstream response bodies, credentials or headers are logged or attached.
    const report = JSON.stringify({ result: passed ? 'PASS' : 'REAL E2E BLOCKED', stage: 'research', errorType: passed ? null : errorType, ...metrics }, null, 2);
    await testInfo.attach('research-smoke-summary', { body: report, contentType: 'application/json' });
    console.log(report);
  }
});

test('REAL production API stops at missing human structure confirmation', async ({ request }, testInfo) => {
  test.skip(process.env.LIVE_RESEARCH_SMOKE !== '1', 'Run with the real configured production middleware.');
  // Protocol-valid, explicitly unconfirmed input. No confirmed fixture, storage
  // seeding, UI checkbox automation, route interception or generated model.
  const response = await request.post('/api/utility/structure-skeleton', { data: {
    requireEvidence: true,
    brief: { productName: '可调节夹持装置', introduction: '', usageScene: '', existingStructure: '', existingFunctions: '' },
    candidate: { id: 'unconfirmed-input', name: '可调节夹持装置', innovationDirection: '未确认的临时输入', solvedProblem: '未确认的临时输入',
      coreInnovationStructure: '未确认的临时输入', mainComponents: ['待补充'], implementation: '未确认的临时输入' },
  } });
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.status).toBe('needs_information');
  expect(result.research).toBeUndefined();
  expect(result.skeleton).toBeUndefined();
  const report = JSON.stringify({ result: 'REAL E2E BLOCKED', stage: 'human-structure-confirmation',
    httpStatus: response.status(), gateTest: 'PASS', fakeConfirmation: false, structure: null, document: null, freeze: null, word: null }, null, 2);
  await testInfo.attach('human-confirmation-gate', { body: report, contentType: 'application/json' });
  console.log(report);
});
