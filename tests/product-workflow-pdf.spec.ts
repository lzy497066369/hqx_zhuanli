import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Project } from '../src/data';
import { makeWorkflow, productProject, makeVerifiedCad, productConfig } from './fixtures/productWorkflow';
import { namingFingerprint } from '../src/features/product/productWorkflow';
import { drawingManifestDigest } from '../src/features/product/productDrawing';
import { signProductArtifact } from '../server/productProof';
import { makeInventionMaterials } from '../src/features/invention/invention';
import { PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { clearPdfMetadata } from '../src/features/export/pdfMetadata';

const pdfButton = (page: Page) => page.getByRole('button', { name: '下载 PDF 成品（.pdf）', exact: true });
const wordButton = (page: Page) => page.getByRole('button', { name: '下载 Word 成品（.docx）', exact: true });
const compact = (text: string) => text.replace(/\s/g, '');

function completedProject(category: 'utility' | 'invention' = 'utility'): Project {
  const project = structuredClone({ ...productProject, category });
  const workflow = makeWorkflow(true);
  workflow.selection.patentType = category;
  workflow.review!.selection.patentType = category;
  workflow.brief!.selection.patentType = category;
  workflow.sourceFingerprint = namingFingerprint(project);
  workflow.cad = makeVerifiedCad(workflow.brief);
  const { signature: _signature, ...materials } = workflow.materials!;
  workflow.materials = signProductArtifact('materials', { ...materials, drawingDigest: drawingManifestDigest(workflow.cad),
    drawings: workflow.cad.views.map((view, index) => `图${index + 1}为本产品的${view.title}。`).join('\n') }, productConfig);
  return { ...project, productWorkflow: workflow };
}

async function seed(page: Page, project: Project) {
  await page.route('**/api/**', route => /^\/api\/(storage|auth)\//.test(new URL(route.request().url()).pathname) ? route.continue() : route.abort());
  await page.addInitScript(value => localStorage.setItem('zhichuang-projects-v1', JSON.stringify([value])), project);
}

async function openProjects(page: Page) {
  await page.goto('/#projects/all');
}

async function inspectPdf(path: string) {
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const structure = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(structure.context.trailerInfo.Info).toBeUndefined();
  expect(structure.context.trailerInfo.ID).toBeUndefined();
  expect(structure.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
  for (const [, object] of structure.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFStream ? object.dict : object;
    if (dict instanceof PDFDict) for (const key of ['Metadata', 'PieceInfo', 'LastModified', 'CreationDate', 'ModDate', 'Producer', 'Creator', 'Author', 'Subject', 'Keywords']) expect(dict.has(PDFName.of(key)), key).toBe(false);
  }
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, standardFontDataUrl: pathToFileURL(resolve('node_modules/pdfjs-dist/standard_fonts') + sep).href });
  const pdf = await loading.promise;
  const metadata = await pdf.getMetadata();
  expect(metadata.metadata).toBeNull();
  for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Custom']) expect(metadata.info[key]).toBeUndefined();
  const pages: string[] = [];
  const body: string[] = [];
  const images: number[] = [];
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    const viewport = page.getViewport({ scale: 1 });
    expect(viewport.width).toBeCloseTo(595.28, 1); expect(viewport.height).toBeCloseTo(841.89, 1);
    const text = await page.getTextContent();
    pages.push(text.items.map(item => 'str' in item ? item.str : '').join(''));
    body.push(text.items.filter(item => 'str' in item && item.transform[5] > 40 && item.transform[5] < viewport.height - 60).map(item => 'str' in item ? item.str : '').join(''));
    const ops = await page.getOperatorList();
    images.push(ops.fnArray.filter(op => op === OPS.paintImageXObject).length);
  }
  await loading.destroy();
  return { pages: pages.map(compact), images, text: compact(body.join('')) };
}

test('元数据清理同时移除自定义属性、文档及页面 XMP、编辑记录，输出不保留旧对象', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const source = await PDFDocument.create();
  source.setTitle('private-title'); source.setAuthor('private-author'); source.setSubject('private-subject');
  source.setKeywords(['private-keyword']); source.setCreator('private-creator'); source.setProducer('private-producer');
  source.setCreationDate(new Date('2020-01-01T00:00:00Z')); source.setModificationDate(new Date('2021-01-01T00:00:00Z'));
  const info = source.context.lookup(source.context.trailerInfo.Info!, PDFDict);
  info.set(PDFName.of('Custom'), source.context.obj('private-custom'));
  const metadata = source.context.register(source.context.stream('<x:xmpmeta>private-xmp</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }));
  source.catalog.set(PDFName.of('Metadata'), metadata);
  const page = source.addPage([595.28, 841.89]); page.drawText('Visible page content', { x: 70, y: 740 });
  page.node.set(PDFName.of('Metadata'), metadata);
  page.node.set(PDFName.of('PieceInfo'), source.context.obj({ Editor: { LastModified: 'private-edit-time' } }));
  const clean = await clearPdfMetadata(new Uint8Array(await source.save()).buffer);
  const { writeFile } = await import('node:fs/promises');
  const path = testInfo.outputPath('metadata-clean.pdf'); await writeFile(path, clean);
  expect((await inspectPdf(path)).text).toContain('Visiblepagecontent');
});

for (const category of ['utility', 'invention'] as const) test(`${category} 完成页下载可搜索中文 PDF，正文完整且动态附图逐页同序`, async ({ page }, testInfo) => {
  const project = completedProject(category), materials = project.productWorkflow!.materials!;
  if (category === 'utility') materials.embodiment = Array.from({ length: 70 }, (_, i) => `实施段落${i + 1}：轨道底座固定在安装面，夹持座沿滑槽移动后通过锁紧螺栓锁紧。组件保持滑动配合以适应安装位置。`).join('\n');
  await seed(page, project);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/#${category}/${project.id}`);
  await expect(pdfButton(page)).toBeEnabled(); await expect(wordButton(page)).toBeEnabled();
  const downloadPromise = page.waitForEvent('download'); await pdfButton(page).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${project.name}-${category === 'utility' ? '实用新型' : '发明专利'}申请初稿.pdf`);
  const path = testInfo.outputPath(`${category}-patent.pdf`); await download.saveAs(path);
  const pdf = await inspectPdf(path);
  for (const text of [project.name, materials.abstract, ...materials.claims, materials.technicalField, materials.background, materials.content, materials.drawings, materials.embodiment]) expect(pdf.text).toContain(compact(text));
  for (const excluded of ['建模脚本', 'FreeCAD', '提示词', 'tokenUsage', '\uFFFD', '{{']) expect(pdf.text).not.toContain(excluded);
  expect(pdf.images.filter(Boolean)).toEqual([1, 1]);
  expect(pdf.pages.at(-2)).toContain('图1'); expect(pdf.pages.at(-1)).toContain('图2'); expect(pdf.text).not.toContain('图3');
  if (category === 'utility') expect(pdf.pages.length).toBeGreaterThan(7);
  for (const [index, text] of pdf.pages.entries()) if (!pdf.images[index]) expect(text.replace('专利申请材料', '').replace(/\d+$/, '').length).toBeGreaterThan(1);
  await expect(pdfButton(page)).toBeEnabled(); await expect(wordButton(page)).toBeEnabled(); expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('pdf-export-mobile.png'), fullPage: true });
});

test('项目材料预览可直接下载 PDF，保留 Word 入口', async ({ page }, testInfo) => {
  const project = completedProject(); await seed(page, project); await openProjects(page);
  await page.getByRole('button', { name: `查看${project.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '项目材料预览', exact: true });
  await expect(dialog.getByRole('button', { name: '下载 Word', exact: true })).toBeEnabled();
  const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载 PDF', exact: true }).click();
  const path = testInfo.outputPath('project-preview.pdf'); await (await pending).saveAs(path);
  expect((await inspectPdf(path)).images.filter(Boolean)).toEqual([1, 1]);
});

test('未完成项目禁用 PDF；底层导出也拒绝过期或被改动的附图', async ({ page }) => {
  const project = completedProject(); project.productWorkflow!.confirmation = undefined;
  await seed(page, project); await page.goto(`/#utility/${project.id}`);
  await expect(pdfButton(page)).toBeDisabled(); await expect(wordButton(page)).toBeDisabled();
  const results = await page.evaluate(async workflow => {
    const { exportProductPatent } = await import('/src/features/export/patentExport.ts');
    const failures: string[] = [];
    for (const value of [workflow, { ...workflow, confirmation: { briefId: 'old' } }]) {
      try { await exportProductPatent(value, 'pdf'); } catch (cause) { failures.push(String(cause)); }
    }
    return failures;
  }, project.productWorkflow);
  expect(results).toHaveLength(2);
  const altered = completedProject(); altered.productWorkflow!.cad!.views[0].svg += ' ';
  const failure = await page.evaluate(async value => {
    const { exportProductPatent } = await import('/src/features/export/patentExport.ts');
    try { await exportProductPatent(value, 'pdf'); return ''; } catch (cause) { return String(cause); }
  }, altered.productWorkflow);
  expect(failure).toContain('附图数据与生成结果不一致');
});

test('名称变化后项目预览禁用 PDF，底层导出同样拒绝旧版材料', async ({ page }) => {
  const renamed = completedProject(); renamed.naming!.selectedName += '改名';
  await seed(page, renamed); await openProjects(page);
  await page.getByRole('button', { name: `查看${renamed.name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: '下载 PDF', exact: true })).toBeDisabled();
  const failure = await page.evaluate(async value => {
    const { exportProjectPatent } = await import('/src/features/export/patentExport.ts');
    try { await exportProjectPatent(value, 'pdf'); return ''; } catch (cause) { return String(cause); }
  }, renamed);
  expect(failure).toContain('名称或特征已改变');
});

test('字体加载失败后恢复按钮并允许重试，生成期间两个下载按钮均禁用', async ({ page }, testInfo) => {
  let requests = 0;
  await page.route('**/fonts/NotoSerifSC-Regular.otf', route => ++requests === 1 ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue());
  const project = completedProject(); await seed(page, project); await page.goto(`/#utility/${project.id}`);
  await pdfButton(page).click(); await expect(page.getByRole('alert')).toContainText('PDF 中文字体加载失败');
  await expect(pdfButton(page)).toBeEnabled(); await expect(wordButton(page)).toBeEnabled();
  const pending = page.waitForEvent('download'); await pdfButton(page).click();
  await (await pending).saveAs(testInfo.outputPath('pdf-font-retry.pdf'));
  expect(requests).toBe(2); await expect(pdfButton(page)).toBeEnabled();
});

test('历史无附图发明材料也支持 PDF', async ({ page }, testInfo) => {
  const facts = { technicalField: '纺织面料技术领域', background: '已有面料整理时固着不足。', problem: '改善整理剂在面料上的固着',
    solution: '采用预处理、浸轧及后处理工序', steps: '水洗坯布并烘干\n对坯布进行浸轧处理', limitations: '浸轧处理采用两次浸轧',
    effects: '两次浸轧使整理剂接触坯布表面', embodiment: '实施例一：将坯布水洗后烘干，再进行两次浸轧和后处理。', confirmed: true };
  const project: Project = { id: 'legacy-invention', name: '一种面料整理方法', category: 'invention', owner: '', description: '', status: 'ready', updatedAt: '2026-10-15T00:00:00Z',
    inventionFacts: facts, inventionMaterials: makeInventionMaterials('一种面料整理方法', facts) };
  await seed(page, project); await openProjects(page); await page.getByRole('button', { name: `查看${project.name}`, exact: true }).click();
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 PDF', exact: true }).click();
  const path = testInfo.outputPath('legacy-invention.pdf'); await (await pending).saveAs(path);
  const pdf = await inspectPdf(path); expect(pdf.text).toContain(project.name); expect(pdf.images.every(count => count === 0)).toBe(true);
  expect(pdf.text).toContain(compact(project.inventionMaterials!.abstract));
});
