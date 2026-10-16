import { drawingManifestDigest, drawingMarks } from '../src/features/product/productDrawing';
import { makeVerifiedCad } from './fixtures/productWorkflow';
import { makeTextStructure, makeTextDraft, makeTextBrief, makeTextMaterials } from './fixtures/productText';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { signProductArtifact } from '../server/productProof';
import { createProductWorkflow, applyConflictChoices } from '../src/features/product/productWorkflow';
import type { ProductSelection, ProductWorkflow } from '../src/features/product/productWorkflow';
import { makeBrief, makeImage, makeMaterials, makePreview, makeReview, makeWorkflow, productConfig, productProject } from './fixtures/productWorkflow';
import { mockNaming } from './fixtures/namingAi';

async function seed(page: Page, workflow: ProductWorkflow = createProductWorkflow(productProject)) {
  await page.addInitScript(project => { localStorage.setItem('zhichuang-projects-v1', JSON.stringify([project])); }, { ...productProject, productWorkflow: workflow });
}
async function mockFlow(page: Page, options: { conflict?: boolean; textPipeline?: boolean; briefFailures?: number; briefProofFailures?: number; previewFailures?: number; materialFailures?: number; drawingReviewFailures?: number; cadFailures?: number; clarificationRounds?: number; holdPreview?: Promise<void>; holdCad?: Promise<void>; holdRepairCad?: Promise<void> } = {}) {
  const counts: Record<string, number> = {};
  const inputs: { stage: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/**', route => /^\/api\/(storage|auth)\//.test(new URL(route.request().url()).pathname) ? route.continue() : route.abort());
  await page.route('**/api/generation/**', route => {
    const stage = new URL(route.request().url()).pathname.split('/').at(-1)!;
    counts[`generation-${stage}`] = (counts[`generation-${stage}`] || 0) + 1;
    return route.fulfill({ json: stage === 'begin' ? { token: 'test-generation-token' } : { success: true } });
  });
  await page.route('**/api/product/**', async route => {
    const stage = new URL(route.request().url()).pathname.split('/').at(-1)!;
    counts[stage] = (counts[stage] || 0) + 1;
    const body = route.request().postDataJSON(); inputs.push({ stage, body });
    expect(route.request().headers()['x-generation-token']).toBe('test-generation-token');
    let result: unknown;
    if (stage === 'review') {
      const selection: ProductSelection = body.review ? applyConflictChoices(body.review, body.resolutions) : body.selection;
      result = makeReview(selection, !!options.conflict && counts.review === 1, `api-review-${counts.review}`);
    } else if (stage === 'structure') result = makeTextStructure(body.review);
    else if (stage === 'draft') result = makeTextDraft(body.brief);
    else if (stage === 'brief') {
      if (counts.brief <= (options.briefFailures || 0)) { await route.fulfill({ status: 502, json: { error: { code: 'AI_UPSTREAM', message: '结构复核暂时失败。' } } }); return; }
      if (counts.brief <= (options.briefProofFailures || 0)) { await route.fulfill({ status: 409, json: { error: { code: 'PRODUCT_PROOF_INVALID', message: '签名已过期，请重新校验。' } } }); return; }
      result = options.textPipeline ? makeTextBrief(body.review, `api-brief-${counts.brief}`) : makeBrief(body.review, `api-brief-${counts.brief}`);
    }
    else if (stage === 'preview') {
      if (options.holdPreview) await options.holdPreview;
      if (counts.preview <= (options.previewFailures || 0)) { await route.fulfill({ status: 502, json: { error: { code: 'IMAGE_NETWORK', message: '测试生图网络故障，未自动重试。' } } }); return; }
      result = makePreview(body.brief, `api-preview-${counts.preview}`);
    } else if (stage === 'confirm') result = signProductArtifact('confirmation', { briefId: body.brief.id, previewId: body.preview.id, previewDigest: body.preview.digest, confirmedAt: '2026-10-09T08:00:00.000Z' }, productConfig);
    else if (stage === 'cad') {
      if (options.holdCad) await options.holdCad;
      if (counts.cad > 1 && options.holdRepairCad) await options.holdRepairCad;
      if (counts.cad <= (options.cadFailures || 0)) { await route.fulfill({ status: 503, json: { error: { code: 'FREECAD_UNAVAILABLE', message: '测试：本机未找到 FreeCAD 命令行程序。' } } }); return; }
      result = makeVerifiedCad(body.brief);
    }
    else if (stage === 'materials') {
      if (counts.materials <= (options.drawingReviewFailures || 0)) { await route.fulfill({ status: 502, json: { error: { code: 'CAD_VISUAL_MISMATCH', message: '测试：图2连接关系需要修正。', details: ['图2连接关系需要修正。'] } } }); return; }
      if (counts.materials <= (options.materialFailures || 0)) { await route.fulfill({ status: 502, json: { error: { code: 'AI_UPSTREAM', message: '测试文案生成故障。' } } }); return; }
      const materials = options.textPipeline ? makeTextMaterials(body.brief) : makeMaterials(body.brief);
      const { signature: _signature, ...content } = materials;
      result = signProductArtifact('materials', { ...content, drawingDigest: drawingManifestDigest(body.cad),
        drawings: body.cad.views.map((v: {title:string}, i:number) => `图${i+1}为本产品的${v.title}。`).join('\n')+'\n附图标记：'+drawingMarks(body.brief).map(m=>`${m.number}、${m.name}`).join('；')+'。' }, productConfig);
    } else if (stage === 'figure') result = makeImage(body.brief, 'patent');
    else if (stage === 'revise') {
      if (counts.revise <= (options.clarificationRounds || 0)) result = { status: 'needs_information', dialogue: signProductArtifact('revision', { briefId: body.brief.id,
        intent: '保留已经确认的改动，明确本次连接方式。', summary: '还需要明确连接方式。', questions: [{ id: 'connection', question: '希望保留哪种连接？', options: ['保留螺栓连接', '改成卡扣连接'] }] }, productConfig) };
      else result = { status: 'ready', summary: '结构保持不变，已明确视觉调整。', selection: { ...body.brief.selection, visualPreferences: `第${counts.revise}轮：主体蓝色，重点表达锁紧连接。` } };
    } else { await route.fulfill({ status: 404, json: { error: { message: '未知测试接口' } } }); return; }
    await route.fulfill({ json: result }).catch(() => {});
  });
  return { counts, inputs };
}

for (const category of ['utility', 'invention'] as const) test(`${category} 切换项目管理后继续生成，进度更新且返回不重复请求`, async ({ page }, testInfo) => {
  let release!: () => void;
  const holdPreview = new Promise<void>(resolve => { release = resolve; });
  const project = { ...productProject, category };
  await page.addInitScript(project => localStorage.setItem('zhichuang-projects-v1', JSON.stringify([project])), {
    ...project, productWorkflow: createProductWorkflow(project),
  });
  const mock = await mockFlow(page, { holdPreview });
  await page.goto(`/#${category}/${project.id}`);
  await expect.poll(() => mock.counts.preview).toBe(1);
  await backToProjects(page);
  const progress = page.getByTestId('project-generation-progress');
  await expect(progress).toContainText('生成四张彩色预览');
  await expect(progress).toContainText('已完成 2/6 阶段');
  expect(mock.counts['generation-end'] || 0).toBe(0);
  // Reopening the same in-flight project must preserve its request and state.
  await page.locator('.project-name').click();
  await expect(page.getByTestId('product-workflow')).toBeVisible();
  await backToProjects(page);
  release();
  await expect(progress).toContainText('待确认彩色预览');
  await expect(progress).toContainText('已完成 3/6 阶段');
  expect(mock.counts).toMatchObject({ review: 1, brief: 1, preview: 1, 'generation-begin': 1 });
  expect(mock.counts.confirm || 0).toBe(0);
  await expect.poll(async () => (await storedWorkflow(page))?.generation?.state).toBe('completed');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`project-progress-${category}-mobile.png`), fullPage: true });
  await page.reload();
  await expect(progress).toContainText('待确认彩色预览');
});

test('确认后切换项目管理，附图与文案继续生成并显示完成', async ({ page }) => {
  let release!: () => void;
  const holdCad = new Promise<void>(resolve => { release = resolve; });
  await seed(page, makeWorkflow(false)); const mock = await mockFlow(page, { holdCad }); await open(page);
  await expect(confirmButton(page)).toBeEnabled(); await confirmButton(page).click();
  await expect.poll(() => mock.counts.cad).toBe(1);
  await backToProjects(page);
  const progress = page.getByTestId('project-generation-progress');
  await expect(progress).toContainText('生成模型与专利附图');
  await expect(progress).toContainText('已完成 4/6 阶段');
  release();
  await expect(progress).toContainText('生成完成');
  await expect(progress).toContainText('已完成 6/6 阶段');
  await expect.poll(() => mock.counts['generation-end']).toBe(1);
  await page.locator('.project-name').click();
  await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts).toMatchObject({ confirm: 1, cad: 1, materials: 1 });
});

test('离开生成页面后失败原因在项目管理显示并持久保存', async ({ page }) => {
  let release!: () => void;
  const holdPreview = new Promise<void>(resolve => { release = resolve; });
  await seed(page); const mock = await mockFlow(page, { holdPreview, previewFailures: 1 }); await open(page);
  await expect.poll(() => mock.counts.preview).toBe(1);
  await backToProjects(page); release();
  const progress = page.getByTestId('project-generation-progress');
  await expect(progress).toContainText('生成失败');
  await expect(progress).toContainText('测试生图网络故障');
  await expect.poll(async () => (await storedWorkflow(page))?.generation?.state).toBe('failed');
  await page.reload();
  await expect(progress).toContainText('测试生图网络故障');
  await page.locator('.project-name').click();
  await expect(page.getByRole('alert')).toContainText('测试生图网络故障');
  expect(mock.counts.preview).toBe(1);
});

test('刷新后的历史运行状态标为中断，保留成果且不会重新收费生成', async ({ page }) => {
  const workflow = makeWorkflow(false);
  workflow.generation = { state: 'running', label: '生成彩色预览', detail: '正在处理', steps: [], startedAt: workflow.updatedAt, updatedAt: workflow.updatedAt };
  await seed(page, workflow); const mock = await mockFlow(page); await page.goto('/#projects/all');
  const progress = page.getByTestId('project-generation-progress');
  await expect(progress).toContainText('已停止');
  await expect(progress).toContainText('页面已重新加载');
  await page.locator('.project-name').click();
  await expect(confirmButton(page)).toBeEnabled();
  expect(mock.counts['generation-begin'] || 0).toBe(0);
});

test('多个项目同时生成时进度独立，停止一个项目不影响另一个', async ({ page }) => {
  let release!: () => void;
  const holdPreview = new Promise<void>(resolve => { release = resolve; });
  const projects = [productProject, { ...productProject, id: 'second-product-flow-test' }]
    .map(project => ({ ...project, productWorkflow: createProductWorkflow(project) }));
  await page.addInitScript(projects => localStorage.setItem('zhichuang-projects-v1', JSON.stringify(projects)), projects);
  const mock = await mockFlow(page, { holdPreview }); await open(page);
  await expect.poll(() => mock.counts.preview).toBe(1);
  await backToProjects(page);
  await page.locator('tbody tr').nth(1).locator('.project-name').click();
  await expect.poll(() => mock.counts.preview).toBe(2);
  await page.getByRole('button', { name: '停止等待', exact: true }).filter({ visible: true }).click();
  await backToProjects(page);
  const progress = page.getByTestId('project-generation-progress');
  await expect(progress.nth(0)).toContainText('生成四张彩色预览');
  await expect(progress.nth(1)).toContainText('已停止');
  release();
  await expect(progress.nth(0)).toContainText('待确认彩色预览');
  await expect(progress.nth(1)).toContainText('已停止');
  expect(mock.counts.preview).toBe(2);
});
async function backToProjects(page: Page) { await page.getByRole('button', { name: '返回项目列表', exact: true }).click(); }
async function open(page: Page) { await page.goto(`/#utility/${productProject.id}`); await expect(page.getByTestId('product-workflow')).toBeVisible(); }
const confirmButton = (page: Page) => page.getByRole('button', { name: '确认预览并生成成品', exact: true });
const exportButton = (page: Page) => page.getByRole('button', { name: '下载 Word 成品（.docx）', exact: true });
async function storedWorkflow(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('zhichuang-workshop'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const projects = await new Promise<Array<{ productWorkflow?: ProductWorkflow }>>((resolve, reject) => { const request = db.transaction('kv', 'readonly').objectStore('kv').get('projects'); request.onsuccess = () => resolve(request.result?.value || []); request.onerror = () => reject(request.error); });
      return projects[0]?.productWorkflow;
    } finally { db.close(); }
  });
}

test('完整链路：校验后自动生成简介和四张预览，明确确认之前不生成 CAD、文案或黑白图', async ({ page }) => {
  await seed(page); const mock = await mockFlow(page); await open(page);
  await expect(confirmButton(page)).toBeEnabled(); await expect(exportButton(page)).toBeDisabled();
  await expect(page.locator('.pw-previews img')).toHaveCount(4);
  expect(mock.counts).toMatchObject({ review: 1, brief: 1, preview: 1 }); expect(mock.counts.materials || 0).toBe(0); expect(mock.counts.cad || 0).toBe(0); expect(mock.counts.figure || 0).toBe(0);
  await confirmButton(page).click(); await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts).toMatchObject({ confirm: 1, cad: 1, materials: 1 }); expect(mock.counts.figure || 0).toBe(0);
  expect(mock.counts['generation-begin']).toBe(1);
  await expect.poll(() => mock.counts['generation-end']).toBe(1);
  const materialInput = mock.inputs.find(input => input.stage === 'materials')!.body;
  const cadInput = mock.inputs.find(input => input.stage === 'cad')!.body;
  expect(materialInput.brief).toEqual(cadInput.brief);
  expect(materialInput.figureIds).toEqual(['cad-figure-1', 'cad-figure-2']);
  expect((cadInput.images as { templateId: string; dataUrl: string }[]).map(image => image.templateId)).toEqual(['color-hero', 'color-front', 'color-top', 'color-right']);
  expect((cadInput.images as { dataUrl: string }[]).every(image => image.dataUrl.startsWith('data:image/jpeg;base64,'))).toBe(true);
  await expect.poll(async () => (await storedWorkflow(page))?.confirmation?.briefId).toBe('api-brief-1');
});
test('FreeCAD 不可用时保存参考图，但未经标号结构核对不能作为成品；可重试正式附图', async ({ page }) => {
  await seed(page); const mock = await mockFlow(page, { cadFailures: 1 }); await open(page);
  await expect(confirmButton(page)).toBeEnabled(); await confirmButton(page).click();
  await expect(page.getByRole('alert').filter({ hasText: '未找到 FreeCAD' })).toBeVisible();
  await page.getByRole('button', { name: '生成 AI 黑白参考图', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '尚未通过完整标号和结构核对' })).toBeVisible();
  await expect(exportButton(page)).toBeDisabled(); expect(mock.counts.materials || 0).toBe(0);
  await page.getByRole('button', { name: '重试未完成的文案或附图', exact: true }).click();
  await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts).toMatchObject({ confirm: 1, cad: 2, figure: 1, materials: 1 });
});

test('发现矛盾时阻断简介和生图，明确选择取舍后再次校验并继续', async ({ page }) => {
  await seed(page); const mock = await mockFlow(page, { conflict: true }); await open(page);
  await expect(page.getByRole('heading', { name: '请先消除这些产品矛盾' })).toBeVisible();
  expect(mock.counts.brief || 0).toBe(0); expect(mock.counts.preview || 0).toBe(0);
  const resolve = page.getByRole('button', { name: '应用选择并重新校验' }); await expect(resolve).toBeDisabled();
  await page.getByRole('radio', { name: /保留固定式结构，去掉滑动要求/ }).check(); await resolve.click(); await expect(confirmButton(page)).toBeEnabled();
  expect(mock.counts.review).toBe(2); expect(mock.counts.brief).toBe(1);
  const lastBrief = mock.inputs.find(input => input.stage === 'brief')!.body.review as ReturnType<typeof makeReview>;
  expect(lastBrief.selection.choices.some(choice => choice.id === 'feature-2')).toBe(false);
  await expect(page.getByTestId('product-workflow').getByRole('heading', { level: 1 })).toHaveText('一种带固定连接结构的光伏组件安装支架');
});
test('重画先追问关键取舍，明确后自动再校验；完成后仍可不限次数重画', async ({ page }) => {
  await seed(page, makeWorkflow(true)); const mock = await mockFlow(page, { clarificationRounds: 1 }); await open(page);
  await expect(exportButton(page)).toBeEnabled(); await page.getByRole('button', { name: '重新画', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '告诉我们这次想怎么改', exact: true }); await dialog.getByLabel('修改说明').fill('调整连接方式和外观'); await dialog.getByRole('button', { name: '提交修改并重画' }).click();
  await expect(dialog.getByText('还需要明确连接方式。')).toBeVisible(); expect(mock.counts.preview || 0).toBe(0);
  await dialog.getByRole('radio', { name: '保留螺栓连接', exact: true }).check(); await dialog.getByRole('button', { name: '提交补充并继续' }).click();
  await expect(dialog).not.toBeVisible(); await expect(confirmButton(page)).toBeEnabled(); await expect(exportButton(page)).toBeDisabled();
  for (let index = 0; index < 5; index++) {
    await page.getByRole('button', { name: '重新画', exact: true }).click();
    await page.getByRole('dialog', { name: '告诉我们这次想怎么改', exact: true }).getByRole('checkbox', { name: '重点结构表达更清晰', exact: true }).check();
    await page.getByRole('dialog', { name: '告诉我们这次想怎么改', exact: true }).getByRole('button', { name: '提交修改并重画' }).click();
    await expect(page.getByRole('dialog', { name: '告诉我们这次想怎么改', exact: true })).not.toBeVisible(); await expect(confirmButton(page)).toBeEnabled();
  }
  expect(mock.counts.preview).toBe(6); expect(mock.counts.review).toBe(6);
  await confirmButton(page).click(); await expect(exportButton(page)).toBeEnabled();
  const final = mock.inputs.find(input => input.stage === 'materials')!.body.brief as ReturnType<typeof makeBrief>;
  expect(final.id).toBe('api-brief-6'); expect(final.selection.visualPreferences).toContain('第7轮');
  await page.getByRole('button', { name: '重新画', exact: true }).click(); await expect(page.getByRole('dialog', { name: '告诉我们这次想怎么改', exact: true })).toBeVisible();
});
test('图片失败不自动重复付费，重试沿用已经生成的校验与简介', async ({ page }) => {
  await seed(page); const mock = await mockFlow(page, { previewFailures: 1 }); await open(page);
  await expect(page.getByRole('alert').filter({ hasText: '测试生图网络故障' })).toBeVisible();
  expect(mock.counts.preview).toBe(1); await expect(confirmButton(page)).toHaveCount(0);
  await page.getByRole('button', { name: '继续生成预览', exact: true }).click(); await expect(confirmButton(page)).toBeEnabled();
  expect(mock.counts).toMatchObject({ review: 1, brief: 1, preview: 2 });
});
test('最终图文核对失败后自动修图并复核，复用确认和正文草稿', async ({ page }) => {
  await seed(page, makeWorkflow(false)); const mock = await mockFlow(page, { drawingReviewFailures: 1 }); await open(page);
  await confirmButton(page).click();
  await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts).toMatchObject({ confirm: 1, cad: 2, draft: 1, materials: 2 });
  const drafts = mock.inputs.filter(input => input.stage === 'materials').map(input => input.body.draft);
  expect(drafts[1]).toEqual(drafts[0]);
  expect((await storedWorkflow(page))?.generation?.state).toBe('completed');
  expect(mock.counts['generation-begin']).toBe(1);
  await expect.poll(() => mock.counts['generation-end']).toBe(1);
});

test('最终图文核对连续失败时有界停止，保留草稿、附图与具体原因', async ({ page }) => {
  await seed(page, makeWorkflow(false)); const mock = await mockFlow(page, { drawingReviewFailures: 99 }); await open(page);
  await confirmButton(page).click();
  await expect(page.getByRole('alert')).toContainText('图2连接关系需要修正');
  await expect(exportButton(page)).toBeDisabled();
  expect(mock.counts).toMatchObject({ confirm: 1, cad: 2, draft: 1, materials: 2 });
  const saved = await storedWorkflow(page);
  // 失败的那一轮不清空任何成果：附图仍在页面上，检查点保留失败原因，重试接着修。
  expect(saved?.cad).toBeTruthy(); expect(saved?.materials).toBeUndefined(); expect(saved?.textDraft).toBeTruthy();
  expect(saved?.generation?.state).toBe('failed');
  expect(mock.counts['generation-begin']).toBe(1);
  await expect.poll(() => mock.counts['generation-end']).toBe(1);
});

test('最终图文修正期间停止，不再复核或导出失效附图', async ({ page }) => {
  let release!: () => void;
  const holdRepairCad = new Promise<void>(resolve => { release = resolve; });
  await seed(page, makeWorkflow(false)); const mock = await mockFlow(page, { drawingReviewFailures: 1, holdRepairCad }); await open(page);
  await confirmButton(page).click();
  await expect.poll(() => mock.counts.cad).toBe(2);
  await page.getByRole('button', { name: '停止等待', exact: true }).click(); release();
  await expect(page.locator('.pw-notice[role="status"]')).toContainText('已停止');
  await expect(exportButton(page)).toBeDisabled();
  expect(mock.counts.materials).toBe(1); expect(mock.counts.draft).toBe(1);
  expect((await storedWorkflow(page))?.generation?.state).toBe('cancelled');
});

test('成品部分失败时保留已生成的 CAD 附图，重试只补缺失文案', async ({ page }) => {
  await seed(page); const mock = await mockFlow(page, { materialFailures: 1 }); await open(page); await expect(confirmButton(page)).toBeEnabled();
  await confirmButton(page).click(); await expect(page.getByRole('alert').filter({ hasText: '测试文案生成故障' })).toBeVisible();
  expect(mock.counts.cad).toBe(1); await expect(exportButton(page)).toBeDisabled();
  await page.getByRole('button', { name: '重试未完成的文案或附图' }).click(); await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts.materials).toBe(2); expect(mock.counts.draft).toBe(1); expect(mock.counts.cad).toBe(1); expect(mock.counts.confirm).toBe(1);
});

test('新文本结构复核失败后刷新，只重试复核；正文复核失败后刷新，只重试文本复核', async ({ page }) => {
  await seed(page); const mock = await mockFlow(page, { textPipeline: true, briefFailures: 1, materialFailures: 1 }); await open(page);
  await expect(page.getByRole('alert').filter({ hasText: '结构复核暂时失败' })).toBeVisible();
  expect((await storedWorkflow(page))?.textStructure?.plan.schemaVersion).toBe(3);
  await page.reload(); await page.locator('.project-name').click(); await page.getByRole('button', { name: '继续生成预览', exact: true }).click();
  await expect(confirmButton(page)).toBeEnabled();
  expect(mock.counts.structure).toBe(1); expect(mock.counts.brief).toBe(2);
  await confirmButton(page).click(); await expect(page.getByRole('alert').filter({ hasText: '测试文案生成故障' })).toBeVisible();
  expect((await storedWorkflow(page))?.textDraft?.document.claims.length).toBe(1);
  await page.reload(); await page.locator('.project-name').click(); await page.getByRole('button', { name: '重试未完成的文案或附图' }).click();
  await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts.draft).toBe(1); expect(mock.counts.materials).toBe(2); expect(mock.counts.cad).toBe(1);
  const saved = await storedWorkflow(page);
  expect(saved?.materials?.textRecord?.sourceVersion).toBe(saved?.brief?.technicalSource?.version);
  await page.getByText('查看申请材料正文', { exact: true }).click();
  await expect(page.locator('.pw-details').filter({ hasText: '查看申请材料正文' })).not.toContainText('内部设计选择记录');
});
test('刷新持久化结果不重复调用模型，改动后的失败版本可以恢复上一版', async ({ page }) => {
  await seed(page, makeWorkflow(true)); const mock = await mockFlow(page, { previewFailures: 1 }); await open(page);
  await expect(exportButton(page)).toBeEnabled(); await page.reload(); await page.locator('.project-name').click(); await expect(exportButton(page)).toBeEnabled(); expect(mock.inputs).toHaveLength(0);
  await page.getByRole('button', { name: '重新画', exact: true }).click(); await page.getByRole('dialog', { name: '告诉我们这次想怎么改', exact: true }).getByLabel('修改说明').fill('换一种更清晰的配色');
  await page.getByRole('dialog', { name: '告诉我们这次想怎么改', exact: true }).getByRole('button', { name: '提交修改并重画' }).click(); await expect(page.getByRole('alert').filter({ hasText: '测试生图网络故障' })).toBeVisible();
  await page.getByRole('button', { name: '放弃本次修改，恢复上一版预览' }).click(); await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts.preview).toBe(1);
});
test('关闭详情后生成继续，结果回到项目管理且不自动打开详情', async ({ page }) => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  await seed(page); const mock = await mockFlow(page, { holdPreview: hold }); await open(page);
  await expect.poll(() => mock.counts.preview || 0).toBe(1);
  await backToProjects(page); release();
  await expect(page.getByRole('heading', { name: '全部专利', exact: true })).toBeVisible();
  await expect.poll(async () => !!(await storedWorkflow(page))?.previews).toBe(true);
  await expect(page.getByRole('dialog', { name: '项目详情与生成成果' })).not.toBeVisible();
});
test('Word 只含摘要、权利要求书、说明书和 4 张统一模型投影的黑白附图，不含交底附件，不引用临时图片URL', async ({ page }, testInfo) => {
  await seed(page, makeWorkflow(true)); await mockFlow(page); await open(page); await expect(exportButton(page)).toBeEnabled();
  const downloadPromise = page.waitForEvent('download'); await exportButton(page).click(); const download = await downloadPromise;
  const file = testInfo.outputPath('product-with-cad-figures.docx'); await download.saveAs(file);
  const zip = await JSZip.loadAsync(await readFile(file)); const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('具体实施方式'); expect(xml).toContain('权利要求1');
  for (const excluded of ['产品交底', 'FreeCAD', '建模脚本', '提示词', '产品整体介绍', '网格摘要', '{{']) expect(xml, excluded).not.toContain(excluded);
  const headers = await Promise.all(Object.keys(zip.files).filter(name => /^word\/header\d*\.xml$/.test(name)).map(name => zip.file(name)!.async('string')));
  expect(headers.join('')).not.toContain('交 底');
  // 四张附图各自嵌入；固定长方体的前视图与右视图栅格化后像素相同，docx 会按内容去重媒体文件，因此按图片引用计数。
  expect(xml.match(/<pic:pic\b/g)).toHaveLength(4);
  const media = Object.keys(zip.files).filter(name => /^word\/media\/.+\.png$/.test(name)); expect(media.length).toBeGreaterThanOrEqual(3);
  const rels = await zip.file('word/_rels/document.xml.rels')!.async('string'); expect(rels).not.toMatch(/TargetMode="External"/);
  const png = await zip.file(media[0])!.async('base64');
  const colours = await page.evaluate(async b64 => {
    const image = new window.Image(); image.src = `data:image/png;base64,${b64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data; const found = new Set<string>(); for (let index = 0; index < data.length; index += 4) found.add(`${data[index]},${data[index + 1]},${data[index + 2]},${data[index + 3]}`); return [...found].sort();
  }, png);
  expect(colours).toEqual(['0,0,0,255', '255,255,255,255']);
});

test('可变附图清单的页面展示、附图说明与Word图片及图号严格同序', async ({ page }, testInfo) => {
  await seed(page); await mockFlow(page); await open(page);
  await expect(confirmButton(page)).toBeEnabled(); await confirmButton(page).click();
  await expect(exportButton(page)).toBeEnabled();
  await expect(page.locator('.pw-deliverables')).toContainText('图1 整体结构示意图');
  await expect(page.locator('.pw-deliverables')).toContainText('图2 正面结构示意图');
  const downloadPromise = page.waitForEvent('download'); await exportButton(page).click();
  const file = testInfo.outputPath('dynamic-patent-drawings.docx'); await (await downloadPromise).saveAs(file);
  const zip = await JSZip.loadAsync(await readFile(file)), xml = await zip.file('word/document.xml')!.async('string');
  expect(xml.match(/<pic:pic\b/g)).toHaveLength(2);
  expect(xml).toContain('图1为本产品的整体结构示意图'); expect(xml).toContain('图2为本产品的正面结构示意图');
  expect(xml).not.toContain('图3');
  expect(xml.indexOf('name="图1 整体结构示意图"')).toBeLessThan(xml.indexOf('name="图2 正面结构示意图"'));
});
test('移动端无横向溢出，产品工作区与重画弹窗通过基础无障碍检查', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await seed(page, makeWorkflow(true)); await mockFlow(page); await open(page);
  await expect(exportButton(page)).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const result = await new AxeBuilder({ page }).include('.product-workflow').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(result.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('product-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '重新画', exact: true }).click();
  const modalResult = await new AxeBuilder({ page }).include('dialog').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(modalResult.violations).toEqual([]);
});
for (const category of ['invention'] as const) test(`${category} 从企业和产品名称开始，全部特征与初步名称都进入独立逻辑检查`, async ({ page }) => {
  const mock = await mockFlow(page); await mockNaming(page);
  if (category === 'invention') {
    await page.addInitScript(project => localStorage.setItem('zhichuang-projects-v1', JSON.stringify([project])),
      { ...productProject, id: 'invention-new-test', category: 'invention', name: '未命名发明专利', owner: '', naming: undefined });
    await page.goto('/#invention/invention-new-test');
  } else {
    await page.addInitScript(() => localStorage.setItem('zhichuang-projects-v1', '[]'));
    await page.goto('/#utility');
  }
  await page.getByRole('button', { name: '使用已有特征拟名' }).click();
  await page.getByLabel('企业名称', { exact: false }).fill('明远设备有限公司'); await page.getByLabel('产品名称', { exact: false }).fill('光伏组件安装支架');
  await page.getByRole('button', { name: '生成产品建议' }).click(); await page.getByRole('button', { name: '光伏组件安装支架', exact: true }).click();
  await expect(page.locator('.un-structure-actions button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '下一步', exact: true })).toBeDisabled();
  await page.getByLabel('H型截面').check(); await page.getByRole('radio', { name: '构造改进' }).check();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  for (const label of ['壳体与支架', '固定连接', '部件相对固定', '平板与方壳']) await page.getByRole('checkbox', { name: new RegExp(label) }).check();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.locator('.un-candidate').first().click();
  await page.getByRole('button', { name: '确认名称并检查产品逻辑' }).click(); await expect(confirmButton(page)).toBeEnabled();
  const selection = mock.inputs.find(input => input.stage === 'review')!.body.selection as ProductSelection;
  expect(selection.company).toBe('明远设备有限公司'); expect(selection.choices).toHaveLength(5); expect(selection.proposedName).toContain('光伏组件安装支架'); expect(selection.patentType).toBe(category);
});

test('旧签名或文本密钥轮换后可以从逻辑检查重新开始，不会陷入复用过期报告的循环', async ({ page }) => {
  const workflow = createProductWorkflow(productProject); workflow.review = makeReview();
  await seed(page, workflow); const mock = await mockFlow(page, { briefProofFailures: 1 }); await open(page);
  await page.getByRole('button', { name: '继续生成预览', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: '签名已过期' })).toBeVisible();
  await page.getByRole('button', { name: '从逻辑校验重新生成', exact: true }).click(); await expect(confirmButton(page)).toBeEnabled();
  expect(mock.counts.review).toBe(1); expect(mock.counts.brief).toBe(2); expect(mock.counts.preview).toBe(1);
});

test('恢复未确认的旧预览必须清空新版的确认、文案和澄清记录', async ({ page }) => {
  await seed(page, makeWorkflow(false)); await mockFlow(page); await open(page);
  await page.getByRole('button', { name: '重新画', exact: true }).click();
  await page.getByRole('dialog', { name: '告诉我们这次想怎么改', exact: true }).getByLabel('修改说明').fill('改为蓝色主体');
  await page.getByRole('dialog', { name: '告诉我们这次想怎么改', exact: true }).getByRole('button', { name: '提交修改并重画' }).click();
  await expect(confirmButton(page)).toBeEnabled(); await confirmButton(page).click(); await expect(exportButton(page)).toBeEnabled();
  await page.getByRole('button', { name: '放弃本次修改，恢复上一版预览' }).click();
  await expect(exportButton(page)).toBeDisabled(); await expect(confirmButton(page)).toBeEnabled();
  await expect.poll(async () => (await storedWorkflow(page))?.brief?.id).toBe('brief-1');
  const restored = await storedWorkflow(page);
  expect(restored?.confirmation).toBeUndefined(); expect(restored?.materials).toBeUndefined(); expect(restored?.revision).toBeUndefined(); expect(restored?.cad).toBeUndefined(); expect(restored?.figures).toEqual({});
});

// 局域网 http://192.168.x.x 访问时浏览器处于「非安全上下文」：crypto.randomUUID 与 crypto.subtle 都是 undefined。
// 这里在 localhost 上模拟该环境，保证保存名称、确认预览和 Word 导出不依赖这两个 API。
async function simulateInsecureContext(page: Page) {
  await page.addInitScript(() => {
    delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID;
    Object.defineProperty(crypto, 'subtle', { value: undefined, configurable: true });
  });
}
test('非安全上下文（局域网 http）下没有 crypto.randomUUID，弹窗创建仍能保存并自动生成', async ({ page }) => {
  await simulateInsecureContext(page); await mockFlow(page);
  await page.route('**/api/product/problems', route => route.fulfill({ json: {
    product: '光伏组件安装支架', context: '', scenario: '安装位置调节', problems: [1,2,3].map(index => ({ id: `p${index}`,
      title: `定位方向${index}`, problem: `不同安装场景${index}的位置调节不便`, goal: '方便调节安装位置', approach: '滑槽导向并通过螺栓锁紧',
      suggestedName: '一种带滑槽锁紧结构的光伏组件安装支架' })),
  } }));
  await page.addInitScript(() => localStorage.setItem('zhichuang-projects-v1', '[]'));
  await page.goto('/#projects/all');
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await page.getByRole('button', { name: '新增专利', exact: true }).first().click();
  await page.getByLabel('项目名称').fill('光伏支架项目');
  await page.getByLabel('公司名称').fill('明远设备有限公司');
  await page.getByLabel('基础产品名称').fill('光伏组件安装支架');
  await page.getByRole('button', { name: '选择问题', exact: true }).click();
  await page.getByRole('radio').first().check(); await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page).toHaveURL(/#projects\/all$/);
  await expect(page.getByTestId('project-generation-progress')).toContainText('待确认彩色预览');
  await page.locator('.project-name').click(); await expect(confirmButton(page)).toBeEnabled();
});

test('非安全上下文（局域网 http）下没有 crypto.subtle，确认预览与 Word 导出仍能校验图片摘要', async ({ page }, testInfo) => {
  await simulateInsecureContext(page); await seed(page, makeWorkflow(false)); await mockFlow(page); await open(page);
  expect(await page.evaluate(() => typeof crypto.subtle)).toBe('undefined');
  await expect(confirmButton(page)).toBeEnabled(); await confirmButton(page).click(); await expect(exportButton(page)).toBeEnabled();
  const downloadPromise = page.waitForEvent('download'); await exportButton(page).click(); const download = await downloadPromise;
  const file = testInfo.outputPath('product-insecure-context.docx'); await download.saveAs(file);
  const zip = await JSZip.loadAsync(await readFile(file)); expect(await zip.file('word/document.xml')!.async('string')).toContain('权利要求1');
});
