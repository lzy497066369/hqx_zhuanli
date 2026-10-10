import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { initialProjects, makeDocument, makeUtilityMaterials } from '../src/data';
import { FIGURE_NAMES, SVG_FRAME } from '../src/features/utility/drawingModel';
import type { Figure } from '../src/features/utility/drawingModel';
import { drawingFixture } from './fixtures/drawing';
import { generateMaterialsV2, mockMaterialsV2 } from './fixtures/materialsV2';
import { confirmSkeleton, generateStructure, mockStructure, openNamedWorkspace, savedProject } from './fixtures/structureFlow';

test('材料门禁：旧绘图不能生成文案', () => {
  const project = { ...initialProjects.find(p => p.category === 'utility')!, name: '一种光伏组件安装支架' };
  expect(() => makeUtilityMaterials(project, drawingFixture())).toThrow(/Patent Structure Model/);
  expect(() => makeDocument({ ...project, utilityDrawing: drawingFixture() })).toThrow(/请先生成并校验 V2 文案/);
});

test('V2 主链：显式生成、冻结并持久化同一份 Word 文案', async ({ page }) => {
  const contexts = await mockMaterialsV2(page);
  await mockStructure(page);
  const title = await openNamedWorkspace(page);
  await generateStructure(page);
  const before = await savedProject(page, title);
  expect(before.utilityMaterials).toBeUndefined();
  await page.getByRole('tab', { name: '申请材料' }).click();
  await expect(page.getByRole('button', { name: '下载 Word' })).toBeDisabled();
  await generateMaterialsV2(page);
  expect(contexts).toHaveLength(1);
  const after = await savedProject(page, title);
  expect(after.utilityMaterials.generationSource).toBe('materials-v2');
  expect(after.utilityMaterials.sourceModelVersion).toBe(after.utilityDrawing.patentStructureModel.modelVersion);
  await page.reload();
  await page.getByRole('button', { name: '进入结构与材料工作区' }).click();
  await page.getByRole('tab', { name: '申请材料' }).click();
  await expect(page.getByText('当前结构模型的 V2 校验文案。')).toBeVisible();
  await expect(page.getByRole('button', { name: '下载 Word' })).toBeEnabled();
  expect((await savedProject(page, title)).utilityMaterials).toEqual(after.utilityMaterials);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Word' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
});

for (const [label, inject, expected] of [
  ['未建模部件', (materials: ReturnType<typeof import('./fixtures/materialsV2').materialsForContext>) => {
    materials.content += '\n壳体侧面设有排水槽，排水槽与外侧连通。';
    return materials;
  }, /新增结构“排水槽”不在结构模型中/u],
  ['无证据数值', (materials: ReturnType<typeof import('./fixtures/materialsV2').materialsForContext>) => {
    materials.content += '\n该结构的效率提高30%。';
    return materials;
  }, /数值陈述缺少原文依据/u],
  ['无依据效果', (materials: ReturnType<typeof import('./fixtures/materialsV2').materialsForContext>) => {
    materials.content += '\n该结构显著改善使用效果。';
    return materials;
  }, /技术效果缺少对应机制与来源/u],
] as const) test(`V2 冻结失败：${label}不得保存或导出`, async ({ page }) => {
  await mockMaterialsV2(page, inject);
  await mockStructure(page);
  const title = await openNamedWorkspace(page);
  await generateStructure(page);
  await page.getByRole('tab', { name: '申请材料' }).click();
  await page.getByRole('button', { name: '重新生成文案' }).click();
  await expect(page.getByRole('alert').last()).toContainText(expected);
  expect((await savedProject(page, title)).utilityMaterials).toBeUndefined();
  await expect(page.getByRole('button', { name: '下载 Word' })).toBeDisabled();
});

for (const failure of ['start', 'task', 'claimed-success'] as const) test(`V2 ${failure} 失败不回退旧材料`, async ({ page }) => {
  if (failure === 'start') {
    await page.route('**/api/utility/materials-v2', route => route.fulfill({ status: 503, json: { message: '生成服务不可用' } }));
  } else {
    await page.route('**/api/utility/materials-v2', route => route.fulfill({ json: { taskId: 'failed-v2' } }));
    await page.route('**/api/utility/materials-v2/status/failed-v2', route => route.fulfill({ json: failure === 'task'
      ? { status: 'failed', error: '最终校验未通过' }
      : { status: 'completed', result: { readyForExport: true }, materials: { generationSource: 'materials-v2', sourceModelVersion: 'stale' } },
    }));
  }
  await mockStructure(page);
  const title = await openNamedWorkspace(page);
  await generateStructure(page);
  await page.getByRole('tab', { name: '申请材料' }).click();
  await page.getByRole('button', { name: '重新生成文案' }).click();
  await expect(page.getByRole('alert').last()).toContainText(failure === 'start' ? '生成服务不可用'
    : failure === 'task' ? '最终校验未通过' : 'V2 结果未通过最终校验');
  expect((await savedProject(page, title)).utilityMaterials).toBeUndefined();
  await expect(page.getByRole('button', { name: '下载 Word' })).toBeDisabled();
});

test('验收：名称驱动结构、附图和材料，后三步无输入和高级编辑', async ({ page }) => {
  const seen: string[] = [];
  await mockMaterialsV2(page);
  await mockStructure(page, name => seen.push(name));
  const title = await openNamedWorkspace(page);
  await expect(page.locator('.uw-workflow strong')).toHaveText(['确定名称', '确认结构', '绘图与部件', '申请材料']);
  await expect(page.getByRole('tab', { name: '申请材料' })).toBeDisabled();
  await expect(page.locator('.uw-svg')).toHaveCount(0);
  await generateStructure(page);
  expect(seen).toEqual([title]);
  const stored = await savedProject(page, title);
  expect(stored.utilityDrawing.patentStructureModel.productTitle).toBe(title);
  expect(stored.utilityDrawing.design.sourceModelVersion).toBe(stored.utilityDrawing.patentStructureModel.modelVersion);
  expect(stored.utilityMaterials).toBeUndefined();
  await expect(page.locator('.uw-canvas .uw-svg metadata')).toContainText(title);
  await expect(page.locator('.uw-parts')).toContainText('3');
  await generateMaterialsV2(page);
  expect((await savedProject(page, title)).utilityMaterials.sourceModelVersion).toBe(stored.utilityDrawing.patentStructureModel.modelVersion);
  await expect(page.locator('.uw-materials-grid')).toContainText(title);
  await expect(page.locator('.uw-materials-grid')).toContainText('快拆罩（3）');
  await expect(page.locator('.utility-workspace').getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('.uw-advanced, .uw-flow-optional')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '进入结构与材料工作区' }).click();
  await expect(page.locator('.uw-canvas .uw-svg')).toBeVisible();
});

test('导航：从确定名称进入结构工作区时回到页面顶部', async ({ page }) => {
  await mockStructure(page);
  await openNamedWorkspace(page, undefined, false);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' }));
  await expect(page.locator('.un-save-row')).toBeVisible();
  await page.getByRole('button', { name: '进入结构与材料工作区' }).click();
  await expect(page.locator('.uw-patent-flow')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole('heading', { name: '根据名称生成结构' })).toBeInViewport();
});

test('系统：模型更新后重建附图、清除旧文案，重新生成后版本一致', async ({ page }) => {
  await mockMaterialsV2(page);
  await mockStructure(page);
  const title = await openNamedWorkspace(page);
  await generateStructure(page);
  await generateMaterialsV2(page);
  const old = await savedProject(page, title);
  await page.unroute('**/api/utility/structure-skeleton');
  await mockStructure(page, undefined, '新防护罩');
  await page.getByRole('tab', { name: '绘图与部件' }).click();
  await page.getByRole('button', { name: '按名称重新生成结构' }).click();
  await confirmSkeleton(page);
  await expect(page.locator('.uw-structure-model')).toContainText('新防护罩');
  const updated = await savedProject(page, title);
  expect(updated.utilityDrawing.patentStructureModel.modelVersion).not.toBe(old.utilityDrawing.patentStructureModel.modelVersion);
  // 模型确认后附图按新模型重建，旧文案不得沿用。
  expect(updated.utilityDrawing.design.sourceModelVersion).toBe(updated.utilityDrawing.patentStructureModel.modelVersion);
  expect(updated.utilityMaterials).toBeUndefined();
  await expect(page.getByRole('button', { name: '导出当前附图 PNG' })).toBeEnabled();
  await page.getByRole('tab', { name: '申请材料' }).click();
  await expect(page.getByRole('button', { name: '下载 Word' })).toBeDisabled();
  await generateMaterialsV2(page);
  const regenerated = await savedProject(page, title);
  expect(regenerated.utilityMaterials.sourceModelVersion).toBe(updated.utilityDrawing.patentStructureModel.modelVersion);
  expect(regenerated.utilityMaterials.claims).toContain('新防护罩（3）');
  await expect(page.getByTestId('consistency-report')).not.toContainText('文案与附图不是来自同一 PatentStructureModel 版本');
});

test('系统：名称变更后旧模型不作为新名称成果呈现，重新生成后文案对应新名称', async ({ page }) => {
  await mockMaterialsV2(page);
  await mockStructure(page);
  const oldTitle = await openNamedWorkspace(page);
  await generateStructure(page);
  await generateMaterialsV2(page);
  const before = await savedProject(page, oldTitle);
  await page.getByRole('button', { name: '返回名称页' }).click();
  const changedTitle = '一种带防护结构的光伏组件安装支架';
  await page.getByLabel('实用新型名称', { exact: true }).fill(changedTitle);
  await page.getByRole('checkbox', { name: /我已确认名称/ }).check();
  await page.getByRole('button', { name: '确认名称并保存' }).click();
  await page.getByRole('button', { name: '进入结构与材料工作区' }).click();
  await expect(page.locator('.uw-heading h1')).toHaveText(changedTitle);
  // 模型标题与新名称不符：旧模型不得作为新名称的成果呈现。
  await expect(page.locator('[data-structure-model="determined"]')).toHaveCount(0);
  await expect(page.locator('.uw-svg')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '申请材料' })).toBeDisabled();
  const after = await savedProject(page, changedTitle);
  expect(after.utilityDrawing.patentStructureModel).toEqual(before.utilityDrawing.patentStructureModel);
  expect(after.utilityMaterials).toBeUndefined();
  await generateStructure(page);
  const regenerated = await savedProject(page, changedTitle);
  expect(regenerated.utilityDrawing.patentStructureModel.productTitle).toBe(changedTitle);
  expect(regenerated.utilityMaterials).toBeUndefined();
  await generateMaterialsV2(page);
  const generated = await savedProject(page, changedTitle);
  expect(generated.utilityMaterials.claims).toContain(changedTitle);
  expect(generated.utilityMaterials.claims).not.toContain(oldTitle);
});

test('验收：三张附图及 TXT/Word/SVG/PNG 可以下载', async ({ page }) => {
  await mockMaterialsV2(page);
  await mockStructure(page);
  const title = await openNamedWorkspace(page);
  await generateStructure(page);
  for (const key of Object.keys(FIGURE_NAMES) as Figure[]) {
    await page.getByRole('tab', { name: FIGURE_NAMES[key] }).click();
    await expect(page.locator('.uw-svg .uw-part-marker text').first()).toHaveText(/^\d{1,3}$/);
    for (const format of ['SVG', 'PNG']) {
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: `导出当前附图 ${format}` }).click();
      const download = await pending;
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (format === 'PNG') {
        expect(buffer.subarray(1, 4).toString()).toBe('PNG');
        expect(buffer.readUInt32BE(16)).toBe(SVG_FRAME.width * 2);
      } else expect(buffer.toString()).toContain(title);
    }
  }
  await generateMaterialsV2(page);
  const txt = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 TXT' }).click();
  expect((await txt).suggestedFilename()).toContain('.txt');
  const word = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Word' }).click();
  await expect(page.getByRole('alert')).not.toContainText('正在生成 Word 文件', { timeout: 10000 });
  const file = await word;
  expect(file.suggestedFilename()).toMatch(/实用新型申请材料\.docx$/);
  const docxPath = (await file.path())!;
  if (process.env.QA_DOCX_PATH) await file.saveAs(process.env.QA_DOCX_PATH);
  const documentXml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8' });
  const stylesXml = execFileSync('unzip', ['-p', docxPath, 'word/styles.xml'], { encoding: 'utf8' });
  expect(documentXml).not.toContain('一种新型擦拭用无纺布');
  expect(documentXml).toContain(title);
  expect(documentXml).toContain('具体实施方式');
  for (const heading of ['技术领域', '背景技术', '实用新型内容', '附图说明', '具体实施方式']) expect(documentXml).toContain(heading);
  expect(documentXml).toContain('快拆罩（3）');
  expect(documentXml).toContain('壳体（1）');
  expect(documentXml).toContain('本实用新型涉及光伏组件安装支架技术领域。');
  expect(documentXml).toContain('1. 一种');
  expect(documentXml).not.toMatch(/结构模型驱动初稿|公开网页检索仅作|待结合真实测试|本文件为申请材料整理初稿/);
  expect(documentXml).not.toMatch(/未识别到明确的产品客体|待用户补充|待人工核对|AI生成|工作原理分析/);
  expect(documentXml).not.toMatch(/。；|，。|；。/);
  expect([...documentXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(([, text]) => text).join('')).toMatch(/图1[\s\S]*图2[\s\S]*图3/);
  const imageWidths = [...documentXml.matchAll(/<wp:extent\b[^>]*\bcx="(\d+)"/g)].map(([, width]) => Number(width));
  expect(imageWidths).toHaveLength(4);
  expect(imageWidths.every(width => width <= (11906 - 1418 - 851) * 635)).toBe(true);
  const sections = [...documentXml.matchAll(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g)].map(([xml]) => xml);
  expect(sections).toHaveLength(5);
  for (const section of sections) {
    expect(section).toMatch(/<w:pgSz\b[^>]*w:w="11906"[^>]*w:h="16838"/);
    const margins = section.match(/<w:pgMar\b([^>]*)\/>/)?.[1] || '';
    for (const setting of ['w:top="1417"', 'w:bottom="850"', 'w:left="1418"', 'w:right="851"']) expect(margins).toContain(setting);
  }
  expect(stylesXml).toContain('w:eastAsia="SimSun"');
  expect(stylesXml).toContain('w:sz w:val="28"');
  expect(documentXml).toContain('w:linePitch="312"');
  expect(stylesXml).toContain('w:firstLineChars="200"');
  const headers = execFileSync('unzip', ['-Z1', docxPath], { encoding: 'utf8' }).split('\n').filter(path => /^word\/header\d+\.xml$/.test(path));
  expect(headers).toHaveLength(5);
  const headerText = headers.map(path => execFileSync('unzip', ['-p', docxPath, path], { encoding: 'utf8' })).join('');
  for (const label of ['说明书摘要', '摘要附图', '权利要求书', '说明书', '说明书附图']) expect(headerText).toContain(label);
  for (const path of headers) {
    const headerXml = execFileSync('unzip', ['-p', docxPath, path], { encoding: 'utf8' });
    expect(headerXml).toContain('w:sz w:val="32"');
    expect(headerXml).not.toMatch(/<w:b\b/);
  }
  expect(documentXml).toMatch(/<w:t[^>]*>[^<]*一种[^<]*<\/w:t>/);
  expect(documentXml).toContain('w:sz w:val="36"');
  const footer = execFileSync('unzip', ['-p', docxPath, 'word/footer1.xml'], { encoding: 'utf8' });
  expect(footer).toMatch(/PAGE/);
  const mediaFiles = execFileSync('unzip', ['-Z1', docxPath], { encoding: 'utf8' }).split('\n').filter(path => path.startsWith('word/media/') && path.endsWith('.png'));
  // 摘要附图复用整体结构图的图像数据，docx 按字节哈希命名 media，两份相同数据合并为一个文件：
  // 故为 3 个 PNG 文件承载 4 个图片实例（见 docs/utility-word-acceptance.md「四个图片实例」）。
  expect(mediaFiles).toHaveLength(3);
});

for (const [index, product, innovation] of [
  [1, '光伏组件安装支架', '快拆罩'],
  [2, '可调节座椅', '限位套'],
  [3, '茶几桌', '连接托板'],
] as const) test(`端到端 Word 与藤编座椅参考版式对照 ${index}：${product}`, async ({ page }) => {
  await mockMaterialsV2(page);
  await mockStructure(page, undefined, innovation);
  const title = await openNamedWorkspace(page, product);
  await generateStructure(page);
  await generateMaterialsV2(page);
  await expect(page.getByTestId('consistency-report')).not.toContainText('错误：');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Word' }).click();
  const download = await pending;
  const output = `/tmp/zhichuang-consistency-e2e-${index}.docx`;
  await download.saveAs(output);
  const xml = execFileSync('unzip', ['-p', output, 'word/document.xml'], { encoding: 'utf8' });
  const styles = execFileSync('unzip', ['-p', output, 'word/styles.xml'], { encoding: 'utf8' });
  const parts = execFileSync('unzip', ['-Z1', output], { encoding: 'utf8' }).split('\n');
  expect(xml).toContain(title);
  expect(xml).toContain(innovation);
  expect(xml).not.toMatch(/一种吊椅|一种茶几桌-申请文件|藤编座椅|高强度座椅|待结合真实测试|结构模型驱动初稿/);
  expect([...xml.matchAll(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g)]).toHaveLength(5);
  for (const section of xml.match(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g) || []) {
    expect(section).toMatch(/<w:pgSz\b[^>]*w:w="11906"[^>]*w:h="16838"/);
    for (const margin of ['w:top="1417"', 'w:bottom="850"', 'w:left="1418"', 'w:right="851"']) expect(section).toContain(margin);
  }
  for (const heading of ['技术领域', '背景技术', '实用新型内容', '附图说明', '具体实施方式']) expect(xml).toContain(heading);
  expect(styles).toContain('w:eastAsia="SimSun"');
  expect(styles).toContain('w:sz w:val="28"');
  expect(styles).toContain('w:firstLineChars="200"');
  expect(parts.filter(part => /^word\/header\d+\.xml$/.test(part))).toHaveLength(5);
  // 3 个 PNG 文件承载 4 个图片实例：摘要附图复用整体结构图，docx 按字节哈希去重。
  expect(parts.filter(part => /^word\/media\/.*\.png$/.test(part))).toHaveLength(3);
  const headerText = parts.filter(part => /^word\/header\d+\.xml$/.test(part)).map(part => execFileSync('unzip', ['-p', output, part], { encoding: 'utf8' })).join('');
  for (const label of ['说明书摘要', '摘要附图', '权利要求书', '说明书', '说明书附图']) expect(headerText).toContain(label);
  expect(headerText.match(/w:sz w:val="32"/g)).toHaveLength(5);
  expect(xml.match(/<wp:extent\b/g)).toHaveLength(4);
  const claims = (await savedProject(page, title)).utilityMaterials.claims.split('\n');
  expect(claims.length).toBeGreaterThan(0);
  claims.forEach((claim: string, number: number) => expect(claim).toMatch(new RegExp(`^${number + 1}\\. `)));
});

for (const width of [390, 768, 1440]) test(`验收：${width}px 空态与生成态可访问且无页面溢出`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockStructure(page);
  await openNamedWorkspace(page);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await generateStructure(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `test-results/name-driven-${width}.png`, fullPage: true });
  expect(errors).toEqual([]);
});
