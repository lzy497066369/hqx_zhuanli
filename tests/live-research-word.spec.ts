// Explicit opt-in: paid, real provider requests. No route interception or AI fixtures.
import { expect, test } from '@playwright/test';
import { loadEnv } from 'vite';
import { STORAGE_KEY, type Project } from '../src/data';
import type { StructureEvidenceOption } from '../src/features/utility/structureEvidence';
import { TEST_CONFIRMED_STRUCTURE, confirmTestStructure } from './fixtures/testConfirmedStructure';

test.describe.configure({ retries: 0 });

const title = '一种可调节定位夹具';
const options: StructureEvidenceOption[] = [
  { id: 'E01', category: 'component', label: '基座、导向座、固定夹块、滑动夹块、调节螺杆、手柄、锁紧螺母、限位块', detail: '夹具由基座、导向座、固定夹块、滑动夹块、调节螺杆、手柄、锁紧螺母和限位块组成。', technicalMeaning: '本次测试明确提供的部件' },
  { id: 'E02', category: 'relationship', label: '基座固定支承并形成导向与夹持关系', detail: '基座与导向座固定连接，固定夹块与基座固定连接，滑动夹块与导向座滑动连接，调节螺杆相对导向座转动连接，手柄驱动调节螺杆，锁紧螺母用于锁定调节位置，限位块限制滑动夹块的行程。', technicalMeaning: '本次测试明确提供的固定、滑动、转动和限位关系' },
  { id: 'E03', category: 'motion', label: '手柄驱动螺杆使滑动夹块线性移动', detail: '转动手柄带动调节螺杆相对导向座转动，调节螺杆推动滑动夹块沿导向座线性移动，使滑动夹块与固定夹块共同定位工件。', technicalMeaning: '本次测试明确提供的旋转和线性运动' },
  { id: 'E04', category: 'geometry', label: '基座与导向结构尺寸', detail: '基座约为180×80×20 mm，导向结构长度约为120 mm；其余部件形状以可核对的机械结构示意表达，未提供的尺寸不得推断为实测值。', technicalMeaning: '本次测试明确提供的尺寸事实和示意边界' },
  { id: 'E05', category: 'problem', label: '适配不同尺寸工件并保持定位', detail: '需要通过可调节夹持位置适配不同尺寸工件，并在调节后保持稳定定位。', technicalMeaning: '用户要解决的问题，不是未经验证的性能结论' },
];

function userProject(): Project {
  return { id: 'phase4-live-user-input', category: 'utility', name: title, owner: '联网验收', description: '明确提供的可调节定位夹具用户输入，无预设结构模型或研究结果。', status: 'draft', updatedAt: new Date().toISOString(),
    naming: { version: 1, confirmed: true, selectedName: title,
      profile: { company: '联网验收', business: '工件定位与夹持', product: '可调节定位夹具', features: '基座、导向座、固定夹块、滑动夹块、调节螺杆、手柄、锁紧螺母和限位块；手柄驱动螺杆使滑动夹块线性移动，与固定夹块共同定位工件', excludedTerms: '', improvementType: 'structure' },
      candidates: [{ name: title, product: '可调节定位夹具', feature: '基座、导向座、固定夹块、滑动夹块、调节螺杆、手柄、锁紧螺母和限位块', basis: '测试明确提供的产品名称、部件和工作关系，不是模拟 AI 返回值', inferred: false }],
      structureSelection: { version: 1, options, selectedIds: options.map(option => option.id), confirmed: true } } };
}

test('REAL Research → Evidence → confirmed Compiler → V2 → Freeze → Word', async ({ page }, testInfo) => {
  test.skip(process.env.LIVE_RESEARCH_WORD !== '1', 'Paid real-network E2E: set LIVE_RESEARCH_WORD=1.');
  test.setTimeout(900_000);
  page.setDefaultTimeout(30_000);
  const metrics: Record<string, unknown> = Object.fromEntries([
    'researchSourceCount', 'researchFactCount', 'evidenceCount', 'evidenceScopes', 'supportedCount', 'inferredCount',
    'priorArtFeatureCount', 'priorArtStructureRelationCount', 'structureComponentCount', 'structureConnectionCount', 'structureMotionCount',
    'reasoningChainCount', 'claimPlanCount', 'draftStatus', 'reviewIssueCount', 'fixRounds', 'secondReviewStatus',
    'polishStatus', 'fingerprintStatus', 'validatorStatus', 'freezeStatus', 'wordExportStatus',
  ].map(key => [key, null]));
  let stage = 'configuration';
  let errorType = 'UNKNOWN';
  let pass = false;
  const stages: Record<string, string> = Object.fromEntries([
    'Research', 'Evidence', 'StructureSkeleton', TEST_CONFIRMED_STRUCTURE, 'StructureDraft', 'StructureCompiler',
    'PatentStructureModel', 'PriorArt', 'Reasoning', 'ClaimPlan', 'Draft', 'Review', 'Fix',
    'Second Review', 'Polish', 'Fingerprint', 'Validator', 'Freeze', 'Word',
  ].map(name => [name, 'NOT EXECUTED']));
  const env = { ...loadEnv('development', process.cwd(), 'AI_'), ...process.env };
  const provider = (() => { try { return new URL(env.AI_BASE_URL || '').hostname; } catch { return 'not-configured'; } })();
  metrics.provider = provider;
  metrics.model = env.AI_MODEL || 'not-configured';
  metrics.researchModel = env.AI_RESEARCH_MODEL || env.AI_MODEL || 'not-configured';
  const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Z_]{2,80}$/u.test(value) ? value : 'PROVIDER_OR_PROTOCOL_FAILURE';
  try {
    if (!env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) { errorType = 'AI_NOT_CONFIGURED'; throw new Error(errorType); }
    stage = 'user-input';
    // Seed user input before app hydration; writing IndexedDB while App's initial
    // load/save effects run can race and overwrite the test project. The normal
    // production migration reads this input in an isolated browser context.
    await page.addInitScript(({ key, project }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify([project]));
    }, { key: STORAGE_KEY, project: userProject() });
    await page.goto('/#utility/phase4-live-user-input');
    await page.getByRole('button', { name: '进入产品预览与材料工作区' }).click();
    const close = page.getByRole('button', { name: '关闭提示', exact: true });
    if (await close.isVisible()) await close.click();
    stage = 'research-and-skeleton';
    const pendingSkeleton = page.waitForResponse(response => response.url().endsWith('/api/utility/structure-skeleton') && response.request().method() === 'POST', { timeout: 520_000 });
    await page.getByRole('button', { name: '按名称生成结构', exact: true }).click();
    const response = await pendingSkeleton;
    metrics.skeletonHttpStatus = response.status();
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      // The production stream reader cancels its request on an error event;
      // Chromium may then discard the response body. Diagnose the actual UI
      // failure, never turn an unreadable response into a successful result.
      const alert = page.getByRole('alert').filter({ hasText: /检索工具、来源和引用未通过核对|未取得带可核对来源|公开专利检索暂不可用/ });
      const visible = await alert.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
      const message = visible ? await alert.textContent() : '';
      errorType = message?.includes('公开专利检索暂不可用') ? 'RESEARCH_UNAVAILABLE'
        : message?.includes('检索工具、来源和引用未通过核对') || message?.includes('未取得带可核对来源') ? 'RESEARCH_UNVERIFIED'
          : 'RESPONSE_BODY_UNAVAILABLE';
      if (errorType.startsWith('RESEARCH')) stage = 'research';
      throw new Error(errorType);
    }
    const events = response.headers()['content-type']?.includes('application/x-ndjson') ? raw.trim().split('\n').map(line => JSON.parse(line)) : [];
    const failure = events.find(event => event.type === 'error');
    const skeleton = events.length ? events.find(event => event.type === 'result')?.data : JSON.parse(raw);
    if (failure || !response.ok() || skeleton?.status !== 'ready') {
      errorType = safeCode(failure?.error?.code || skeleton?.error?.code);
      if (errorType.startsWith('RESEARCH')) stage = 'research';
      throw new Error(errorType);
    }
    metrics.researchSourceCount = skeleton.research.sources.length;
    metrics.researchFactCount = skeleton.research.facts?.length || 0;
    expect(metrics.researchSourceCount).toBeGreaterThan(0);
    expect(metrics.researchFactCount).toBeGreaterThan(0);
    stages.Research = 'PASS';
    stages.StructureSkeleton = 'PASS';
    stage = 'structure-confirmation-and-compiler';
    const compileRequest = page.waitForRequest(request => request.url().endsWith('/api/utility/compile-structure') && request.method() === 'POST');
    const compileResponse = page.waitForResponse(response => response.url().endsWith('/api/utility/compile-structure') && response.request().method() === 'POST');
    await confirmTestStructure(page);
    const draft = (await compileRequest).postDataJSON() as {
      components?: unknown[];
      relationships?: Array<{ relation?: string }>;
      motions?: unknown[];
    };
    const compiledResponse = await compileResponse;
    const compiled = await compiledResponse.json() as { success?: boolean; model?: unknown };
    expect(draft.components?.length).toBeGreaterThanOrEqual(5);
    expect(draft.components?.length).toBeLessThanOrEqual(8);
    expect(draft.relationships?.some(relationship => relationship.relation === 'fixed_to')).toBe(true);
    expect(draft.relationships?.some(relationship => relationship.relation === 'slidably_connected')).toBe(true);
    expect(draft.relationships?.some(relationship => relationship.relation === 'rotatably_connected')).toBe(true);
    expect(draft.motions?.length).toBeGreaterThan(0);
    expect(compiledResponse.ok()).toBe(true);
    expect(compiled.success).toBe(true);
    expect(compiled.model).toBeTruthy();
    stages[TEST_CONFIRMED_STRUCTURE] = 'PASS';
    stages.StructureDraft = 'PASS';
    stages.StructureCompiler = 'PASS';
    stages.PatentStructureModel = 'PASS';
    stage = 'materials-v2';
    const pendingGeneration = page.waitForResponse(async response => {
      if (!response.url().includes('/api/utility/materials-v2/status/') || response.request().method() !== 'GET') return false;
      const status = await response.json();
      const progress = status.progress;
      // These thresholds are the production generator's actual stage transitions.
      if (progress >= 32) stages.Draft = 'PASS';
      if (progress >= 46) stages.Review = 'PASS';
      if (progress >= 68) stages['Second Review'] = 'PASS';
      if (progress >= 90) { stages.Polish = 'PASS'; stages.Fingerprint = 'PASS'; }
      if (status.status === 'failed') {
        stage = progress < 32 ? 'Draft' : progress < 46 ? 'Review' : progress < 56 ? 'Fix'
          : progress < 68 ? 'Second Review' : progress < 90 ? 'Polish / Fingerprint' : 'Validator';
        stages[stage] = 'BLOCKED';
      }
      return status.status === 'completed' || status.status === 'failed';
    }, { timeout: 650_000 });
    // Attach a rejection handler before awaiting other UI operations.
    void pendingGeneration.catch(() => {});
    const pendingContext = page.waitForRequest(request => request.url().endsWith('/api/utility/materials-v2') && request.method() === 'POST');
    await page.getByRole('tab', { name: '申请材料' }).click();
    await page.getByRole('button', { name: '重新生成文案' }).click();
    const context = (await pendingContext).postDataJSON().context;
    const items = context.evidence.items;
    Object.assign(metrics, {
      evidenceCount: items.length,
      evidenceScopes: items.reduce((counts: Record<string, number>, item: { evidenceScope?: string }) => { const scope = item.evidenceScope || 'UNSPECIFIED'; counts[scope] = (counts[scope] || 0) + 1; return counts; }, {}),
      supportedCount: items.filter((item: { status: string }) => item.status === 'SUPPORTED').length,
      inferredCount: items.filter((item: { status: string }) => item.status === 'INFERRED').length,
      priorArtFeatureCount: items.filter((item: { factType?: string }) => item.factType === 'PRIOR_ART_FEATURE').length,
      priorArtStructureRelationCount: context.reasoning.priorArtRelations.length,
      structureComponentCount: context.model.components.length, structureConnectionCount: context.model.connections.length, structureMotionCount: context.model.motions.length,
      reasoningChainCount: context.reasoning.chains.length, claimPlanCount: context.claimPlan.claims.length,
    });
    expect(context.model.components.length).toBeGreaterThanOrEqual(5);
    expect(context.model.components.length).toBeLessThanOrEqual(8);
    expect(context.model.connections.some((connection: { relation?: string }) => connection.relation === 'fixed_to')).toBe(true);
    expect(context.model.connections.some((connection: { relation?: string }) => connection.relation === 'slidably_connected')).toBe(true);
    expect(context.model.connections.some((connection: { relation?: string }) => connection.relation === 'rotatably_connected')).toBe(true);
    expect(context.model.motions.length).toBeGreaterThan(0);
    expect(context.model.components.some((component: { geometry?: { size?: number[] } }) => component.geometry?.size?.some((size: number) => size > 0))).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(metrics.priorArtFeatureCount).toBeGreaterThan(0);
    expect(metrics.priorArtStructureRelationCount).toBeGreaterThan(0);
    expect(metrics.reasoningChainCount).toBeGreaterThan(0);
    expect(metrics.claimPlanCount).toBeGreaterThan(0);
    stages.Evidence = 'PASS'; stages.PriorArt = 'PASS'; stages.Reasoning = 'PASS'; stages.ClaimPlan = 'PASS';
    const generation = await (await pendingGeneration).json();
    if (generation.status !== 'completed') {
      errorType = 'GENERATION_FAILED';
      throw new Error(errorType);
    }
    await expect(page.getByText('V2 文案已生成并通过最终校验。')).toBeVisible();
    stage = 'freeze';
    const proof = await page.evaluate(async () => {
      const storagePath = '/src/storage/projectStorage.ts';
      const packagePath = '/src/features/utility/patentPackage.ts';
      const { loadProjectsAsync } = await import(/* @vite-ignore */ storagePath);
      const { freezePatentPackage } = await import(/* @vite-ignore */ packagePath);
      const project = (await loadProjectsAsync()).find((entry: { id: string }) => entry.id === 'phase4-live-user-input');
      const frozen = freezePatentPackage(project, project.utilityDrawing, project.utilityMaterials);
      if (!Object.isFrozen(frozen.document)) throw new Error('FREEZE_FAILED');
      return project.utilityMaterials.generationProof;
    });
    expect(proof.reviews.length).toBeGreaterThanOrEqual(2);
    expect(proof.reviews.at(-1).issues.some((issue: { severity: string }) => issue.severity === 'error')).toBe(false);
    expect(proof.polish.before).toBe(proof.polish.after);
    expect(proof.validation.readyForExport).toBe(true);
    expect(proof.validation.issues.some((issue: { severity: string }) => issue.severity === 'error')).toBe(false);
    expect(proof.validation.qualityScore).toBeGreaterThanOrEqual(proof.validation.qualityThreshold);
    Object.assign(metrics, { draftStatus: stages.Draft, reviewIssueCount: proof.reviews.map((review: { issues: unknown[] }) => review.issues.length),
      fixRounds: proof.reviews.filter((review: { fixedIssueIds: string[] }) => review.fixedIssueIds.length > 0).length,
      secondReviewStatus: 'PASS', polishStatus: 'PASS', fingerprintStatus: proof.polish.before === proof.polish.after ? 'PASS' : 'FAILED',
      validatorStatus: proof.validation.readyForExport ? 'PASS' : 'FAILED', freezeStatus: 'PASS' });
    stages.Review = 'PASS'; stages['Second Review'] = 'PASS';
    stages.Fix = Number(metrics.fixRounds) > 0 ? 'PASS' : 'NOT EXECUTED';
    stages.Polish = 'PASS'; stages.Fingerprint = 'PASS'; stages.Validator = 'PASS'; stages.Freeze = 'PASS';
    stage = 'word-export';
    const pendingDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 Word' }).click();
    const download = await pendingDownload;
    expect(download.suggestedFilename()).toMatch(/\.docx$/u);
    await download.saveAs(testInfo.outputPath('real-network.docx'));
    metrics.wordExportStatus = 'PASS';
    stages.Word = 'PASS';
    pass = Object.values(stages).every(value => value === 'PASS');
    if (!pass) { stage = 'Fix'; errorType = 'REQUIRED_STAGE_NOT_EXECUTED'; throw new Error(errorType); }
  } catch (error) {
    if (errorType === 'UNKNOWN') errorType = error instanceof Error && error.name === 'TimeoutError' ? 'STAGE_TIMEOUT' : 'STAGE_ASSERTION_OR_VALIDATION_FAILED';
    throw new Error(`REAL E2E BLOCKED: stage=${stage}; errorType=${errorType}`);
  } finally {
    // Never persist provider response bodies, request headers, env maps or exception messages.
    const report = JSON.stringify({ result: pass ? 'PASS' : 'REAL E2E BLOCKED', stage, errorType: pass ? null : errorType, stages, ...metrics }, null, 2);
    await testInfo.attach('real-network-summary', { body: report, contentType: 'application/json' });
    console.log(report);
  }
});
