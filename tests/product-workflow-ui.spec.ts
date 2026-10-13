import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { signProductArtifact } from '../server/productProof';
import { createProductWorkflow, applyConflictChoices } from '../src/features/product/productWorkflow';
import type { ProductSelection, ProductWorkflow } from '../src/features/product/productWorkflow';
import { makeBrief, makeCad, makeImage, makeMaterials, makePreview, makeReview, makeWorkflow, productConfig, productProject } from './fixtures/productWorkflow';
import { mockNaming } from './fixtures/namingAi';

async function seed(page: Page, workflow: ProductWorkflow = createProductWorkflow(productProject)) {
  await page.addInitScript(project => { localStorage.setItem('zhichuang-projects-v1', JSON.stringify([project])); }, { ...productProject, productWorkflow: workflow });
}
async function mockFlow(page: Page, options: { conflict?: boolean; briefProofFailures?: number; previewFailures?: number; materialFailures?: number; cadFailures?: number; clarificationRounds?: number; holdPreview?: Promise<void> } = {}) {
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
    } else if (stage === 'brief') {
      if (counts.brief <= (options.briefProofFailures || 0)) { await route.fulfill({ status: 409, json: { error: { code: 'PRODUCT_PROOF_INVALID', message: '签名已过期，请重新校验。' } } }); return; }
      result = makeBrief(body.review, `api-brief-${counts.brief}`);
    }
    else if (stage === 'preview') {
      if (options.holdPreview) await options.holdPreview;
      if (counts.preview <= (options.previewFailures || 0)) { await route.fulfill({ status: 502, json: { error: { code: 'IMAGE_NETWORK', message: '测试生图网络故障，未自动重试。' } } }); return; }
      result = makePreview(body.brief, `api-preview-${counts.preview}`);
    } else if (stage === 'confirm') result = signProductArtifact('confirmation', { briefId: body.brief.id, previewId: body.preview.id, previewDigest: body.preview.digest, confirmedAt: '2026-10-09T08:00:00.000Z' }, productConfig);
    else if (stage === 'cad') {
      if (counts.cad <= (options.cadFailures || 0)) { await route.fulfill({ status: 503, json: { error: { code: 'FREECAD_UNAVAILABLE', message: '测试：本机未找到 FreeCAD 命令行程序。' } } }); return; }
      result = makeCad(body.brief);
    }
    else if (stage === 'materials') {
      if (counts.materials <= (options.materialFailures || 0)) { await route.fulfill({ status: 502, json: { error: { code: 'AI_UPSTREAM', message: '测试文案生成故障。' } } }); return; }
      result = makeMaterials(body.brief);
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
  expect(materialInput.figureIds).toEqual(['cad-iso', 'cad-front', 'cad-top', 'cad-right']);
  expect((cadInput.images as { templateId: string; dataUrl: string }[]).map(image => image.templateId)).toEqual(['color-hero', 'color-front', 'color-top', 'color-right']);
  expect((cadInput.images as { dataUrl: string }[]).every(image => image.dataUrl.startsWith('data:image/jpeg;base64,'))).toBe(true);
  await expect.poll(async () => (await storedWorkflow(page))?.confirmation?.briefId).toBe('api-brief-1');
});
test('FreeCAD 不可用时报错保留确认结果，可明确改用 AI 黑白结构图并按该附图清单生成文案', async ({ page }) => {
  await seed(page); const mock = await mockFlow(page, { cadFailures: 1 }); await open(page);
  await expect(confirmButton(page)).toBeEnabled(); await confirmButton(page).click();
  await expect(page.getByRole('alert').filter({ hasText: '未找到 FreeCAD' })).toBeVisible(); await expect(exportButton(page)).toBeDisabled();
  expect(mock.counts.materials || 0).toBe(0);
  await page.getByRole('button', { name: '改用 AI 黑白结构图', exact: true }).click(); await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts).toMatchObject({ confirm: 1, cad: 1, figure: 1, materials: 1 });
  expect(mock.inputs.find(input => input.stage === 'materials')!.body.figureIds).toEqual(['patent-structure']);
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('一种带固定连接结构的光伏组件安装支架');
});
test('重画先追问关键取舍，明确后自动再校验；完成后仍可不限次数重画', async ({ page }) => {
  await seed(page, makeWorkflow(true)); const mock = await mockFlow(page, { clarificationRounds: 1 }); await open(page);
  await expect(exportButton(page)).toBeEnabled(); await page.getByRole('button', { name: '重新画', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('修改说明').fill('调整连接方式和外观'); await dialog.getByRole('button', { name: '提交修改并重画' }).click();
  await expect(dialog.getByText('还需要明确连接方式。')).toBeVisible(); expect(mock.counts.preview || 0).toBe(0);
  await dialog.getByRole('radio', { name: '保留螺栓连接', exact: true }).check(); await dialog.getByRole('button', { name: '提交补充并继续' }).click();
  await expect(dialog).not.toBeVisible(); await expect(confirmButton(page)).toBeEnabled(); await expect(exportButton(page)).toBeDisabled();
  for (let index = 0; index < 5; index++) {
    await page.getByRole('button', { name: '重新画', exact: true }).click();
    await page.getByRole('dialog').getByRole('checkbox', { name: '重点结构表达更清晰', exact: true }).check();
    await page.getByRole('dialog').getByRole('button', { name: '提交修改并重画' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(confirmButton(page)).toBeEnabled();
  }
  expect(mock.counts.preview).toBe(6); expect(mock.counts.review).toBe(6);
  await confirmButton(page).click(); await expect(exportButton(page)).toBeEnabled();
  const final = mock.inputs.find(input => input.stage === 'materials')!.body.brief as ReturnType<typeof makeBrief>;
  expect(final.id).toBe('api-brief-6'); expect(final.selection.visualPreferences).toContain('第7轮');
  await page.getByRole('button', { name: '重新画', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
});
test('图片失败不自动重复付费，重试沿用已经生成的校验与简介', async ({ page }) => {
  await seed(page); const mock = await mockFlow(page, { previewFailures: 1 }); await open(page);
  await expect(page.getByRole('alert').filter({ hasText: '测试生图网络故障' })).toBeVisible();
  expect(mock.counts.preview).toBe(1); await expect(confirmButton(page)).toHaveCount(0);
  await page.getByRole('button', { name: '继续生成预览', exact: true }).click(); await expect(confirmButton(page)).toBeEnabled();
  expect(mock.counts).toMatchObject({ review: 1, brief: 1, preview: 2 });
});
test('成品部分失败时保留已生成的 CAD 附图，重试只补缺失文案', async ({ page }) => {
  await seed(page); const mock = await mockFlow(page, { materialFailures: 1 }); await open(page); await expect(confirmButton(page)).toBeEnabled();
  await confirmButton(page).click(); await expect(page.getByRole('alert').filter({ hasText: '测试文案生成故障' })).toBeVisible();
  expect(mock.counts.cad).toBe(1); await expect(exportButton(page)).toBeDisabled();
  await page.getByRole('button', { name: '重试未完成的文案或附图' }).click(); await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts.materials).toBe(2); expect(mock.counts.cad).toBe(1); expect(mock.counts.confirm).toBe(1);
});
test('刷新持久化结果不重复调用模型，改动后的失败版本可以恢复上一版', async ({ page }) => {
  await seed(page, makeWorkflow(true)); const mock = await mockFlow(page, { previewFailures: 1 }); await open(page);
  await expect(exportButton(page)).toBeEnabled(); await page.reload(); await expect(exportButton(page)).toBeEnabled(); expect(mock.inputs).toHaveLength(0);
  await page.getByRole('button', { name: '重新画', exact: true }).click(); await page.getByRole('dialog').getByLabel('修改说明').fill('换一种更清晰的配色');
  await page.getByRole('dialog').getByRole('button', { name: '提交修改并重画' }).click(); await expect(page.getByRole('alert').filter({ hasText: '测试生图网络故障' })).toBeVisible();
  await page.getByRole('button', { name: '放弃本次修改，恢复上一版预览' }).click(); await expect(exportButton(page)).toBeEnabled();
  expect(mock.counts.preview).toBe(1);
});
test('离开页面取消在途结果，迟到的图片不覆盖已保存状态', async ({ page }) => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  await seed(page); const mock = await mockFlow(page, { holdPreview: hold }); await open(page);
  await expect.poll(() => mock.counts.preview || 0).toBe(1);
  await page.getByRole('button', { name: '返回修改名称与特征' }).click(); release();
  await expect(page.locator('.utility-naming')).toBeVisible();
  expect((await storedWorkflow(page))?.previews).toBeUndefined();
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
test('移动端无横向溢出，产品工作区与重画弹窗通过基础无障碍检查', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await seed(page, makeWorkflow(true)); await mockFlow(page); await open(page);
  await expect(exportButton(page)).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const result = await new AxeBuilder({ page }).include('.product-workflow').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(result.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('product-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '重新画', exact: true }).click();
  const modalResult = await new AxeBuilder({ page }).include('dialog').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(modalResult.violations).toEqual([]);
});
for (const category of ['utility', 'invention'] as const) test(`${category} 从企业和产品名称开始，全部特征与初步名称都进入独立逻辑检查`, async ({ page }) => {
  const mock = await mockFlow(page); await mockNaming(page);
  if (category === 'invention') {
    await page.addInitScript(project => localStorage.setItem('zhichuang-projects-v1', JSON.stringify([project])),
      { ...productProject, id: 'invention-new-test', category: 'invention', name: '未命名发明专利', owner: '', naming: undefined });
    await page.goto('/#invention/invention-new-test');
  } else {
    await page.addInitScript(() => localStorage.setItem('zhichuang-projects-v1', '[]'));
    await page.goto('/#utility');
  }
  await page.getByLabel('企业名称', { exact: false }).fill('明远设备有限公司'); await page.getByLabel('产品名称', { exact: false }).fill('光伏组件安装支架');
  await page.getByRole('button', { name: '生成产品建议' }).click(); await page.getByRole('button', { name: '光伏组件安装支架', exact: true }).click();
  await page.getByLabel('H型截面').check(); await page.getByRole('radio', { name: '构造改进' }).check();
  await page.getByRole('button', { name: '生成结构资料选项' }).click();
  for (const label of ['壳体与支架', '固定连接', '部件相对固定', '平板与方壳']) await page.getByRole('checkbox', { name: new RegExp(label) }).check();
  await page.getByRole('button', { name: '确认所选结构资料' }).click(); await page.getByRole('button', { name: '确认选项并生成名称' }).click();
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
  await page.getByRole('dialog').getByLabel('修改说明').fill('改为蓝色主体');
  await page.getByRole('dialog').getByRole('button', { name: '提交修改并重画' }).click();
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
test('非安全上下文（局域网 http）下没有 crypto.randomUUID，确认名称仍能保存并进入产品工作区', async ({ page }) => {
  await simulateInsecureContext(page); await mockFlow(page); await mockNaming(page);
  await page.addInitScript(() => localStorage.setItem('zhichuang-projects-v1', '[]'));
  await page.goto('/#utility');
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await page.getByLabel('企业名称', { exact: false }).fill('明远设备有限公司'); await page.getByLabel('产品名称', { exact: false }).fill('光伏组件安装支架');
  await page.getByRole('button', { name: '生成产品建议' }).click(); await page.getByRole('button', { name: '光伏组件安装支架', exact: true }).click();
  await page.getByLabel('H型截面').check(); await page.getByRole('radio', { name: '构造改进' }).check();
  await page.getByRole('button', { name: '生成结构资料选项' }).click();
  for (const label of ['壳体与支架', '固定连接', '部件相对固定', '平板与方壳']) await page.getByRole('checkbox', { name: new RegExp(label) }).check();
  await page.getByRole('button', { name: '确认所选结构资料' }).click(); await page.getByRole('button', { name: '确认选项并生成名称' }).click();
  await page.locator('.un-candidate').first().click();
  const nameInput = page.locator('.un-results').getByRole('textbox', { name: '实用新型名称', exact: true });
  const saveName = page.locator('.un-results').getByRole('button', { name: '确认名称并检查产品逻辑' });
  await expect(page.locator('.un-confirm')).toHaveCount(0);
  await expect(nameInput).toBeVisible();
  const chosenName = await nameInput.inputValue();
  await nameInput.fill('');
  await expect(saveName).toBeDisabled();
  await nameInput.fill(chosenName);
  await expect(saveName).toBeEnabled();
  await page.getByRole('button', { name: '确认名称并检查产品逻辑' }).click();
  await expect(page.getByTestId('product-workflow')).toBeVisible(); expect(page.url()).toMatch(/#utility\/[0-9a-f-]{36}$/);
  await expect(confirmButton(page)).toBeEnabled();
});
test('非安全上下文（局域网 http）下没有 crypto.subtle，确认预览与 Word 导出仍能校验图片摘要', async ({ page }, testInfo) => {
  await simulateInsecureContext(page); await seed(page, makeWorkflow(false)); await mockFlow(page); await open(page);
  expect(await page.evaluate(() => typeof crypto.subtle)).toBe('undefined');
  await expect(confirmButton(page)).toBeEnabled(); await confirmButton(page).click(); await expect(exportButton(page)).toBeEnabled();
  const downloadPromise = page.waitForEvent('download'); await exportButton(page).click(); const download = await downloadPromise;
  const file = testInfo.outputPath('product-insecure-context.docx'); await download.saveAs(file);
  const zip = await JSZip.loadAsync(await readFile(file)); expect(await zip.file('word/document.xml')!.async('string')).toContain('权利要求1');
});
