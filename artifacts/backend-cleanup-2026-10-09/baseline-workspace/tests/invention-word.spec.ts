import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { makeInventionMaterials, validateInventionMaterials } from '../src/features/invention/invention';
import type { InventionFacts } from '../src/features/invention/invention';
import { generateStructure, mockStructure, savedProject } from './fixtures/structureFlow';
import { mockNaming } from './fixtures/namingAi';
import { generateMaterialsV2, mockMaterialsV2 } from './fixtures/materialsV2';

const legacyFacts: InventionFacts = {
  technicalField: '纺织面料技术领域', background: '已有面料整理时固着不足。', problem: '改善整理剂在面料上的固着',
  solution: '采用预处理、浸轧及后处理工序', steps: '水洗坯布并烘干\n对坯布进行浸轧处理', limitations: '浸轧处理采用两次浸轧',
  effects: '两次浸轧使整理剂接触坯布表面', embodiment: '实施例一：将坯布水洗后烘干，再进行两次浸轧和后处理。', confirmed: true,
};

test('发明旧规则仍可校验历史草稿，但不再作为新流程入口', () => {
  const materials = makeInventionMaterials('一种面料整理方法', legacyFacts);
  expect(() => validateInventionMaterials('一种面料整理方法', legacyFacts, materials)).not.toThrow();
  expect(() => validateInventionMaterials('一种面料整理方法', { ...legacyFacts, steps: `${legacyFacts.steps}\n新增步骤` }, materials)).toThrow('不一致');
});

test('发明从属项支持链式和分支引用', () => {
  const facts = { ...legacyFacts, limitations: '根据权利要求1所述：先进行预固定\n根据权利要求2所述：再进行热压\n根据权利要求1所述：采用指定温度' };
  const materials = makeInventionMaterials('一种面料整理方法', facts);
  expect(materials.claims.slice(1).map(claim => claim.match(/根据权利要求(\d+)所述/u)?.[1])).toEqual(['1', '2', '1']);
  expect(() => validateInventionMaterials('一种面料整理方法', facts, materials)).not.toThrow();
});

test('验收：发明专利复用实用新型四步流程并导出发明 Word', async ({ page }, testInfo) => {
  await mockNaming(page);
  await mockStructure(page);
  const contexts = await mockMaterialsV2(page, materials => ({
    ...materials,
    abstract: materials.abstract.replaceAll('本实用新型', '本发明'),
    technicalField: materials.technicalField.replaceAll('本实用新型', '本发明'),
    content: materials.content.replaceAll('本实用新型', '本发明'),
  }));
  await page.goto('/');
  await page.locator('.category-card').filter({ hasText: '发明专利' }).getByRole('button', { name: '开始创作' }).click();
  await expect(page).toHaveURL(/#invention\//);
  await expect(page.locator('.un-steps')).toBeVisible();
  await expect(page.getByText('技术领域', { exact: true })).toHaveCount(0);
  await expect(page.getByText('背景技术', { exact: true })).toHaveCount(0);
  await expect(page.getByText('解决的技术问题', { exact: true })).toHaveCount(0);
  await page.getByLabel('企业名称', { exact: false }).fill('测试设备有限公司');
  await page.getByLabel('产品名称', { exact: false }).fill('光伏组件安装支架');
  await page.getByRole('button', { name: '生成产品建议' }).click();
  await page.getByRole('button', { name: '光伏组件安装支架', exact: true }).click();
  await page.getByLabel('H型截面').check();
  await page.getByRole('radio', { name: '构造改进' }).check();
  await page.getByRole('button', { name: '生成结构资料选项' }).click();
  for (const label of ['壳体与支架', '固定连接', '部件相对固定', '平板与方壳']) await page.getByRole('checkbox', { name: new RegExp(label) }).check();
  await page.getByRole('button', { name: '确认所选结构资料' }).click();
  await page.getByRole('button', { name: '确认选项并生成名称' }).click();
  await page.locator('.un-candidate').first().click();
  await page.getByRole('checkbox', { name: /我已确认名称/ }).check();
  await page.getByRole('button', { name: '确认名称并保存' }).click();
  await expect(page.locator('.uw-patent-flow')).toBeVisible();
  await expect(page.locator('.invention-workspace')).toHaveCount(0);
  await generateStructure(page);
  const title = await page.locator('.uw-heading h1').textContent();
  expect(title).toBeTruthy();
  await generateMaterialsV2(page);
  expect(contexts).toHaveLength(1);
  const project = await savedProject(page, title!);
  expect(project.category).toBe('invention');
  expect(project.utilityMaterials.generationSource).toBe('materials-v2');
  expect(project.utilityMaterials.content).toContain('本发明');
  await expect(page.getByRole('heading', { name: '发明专利申请材料整理初稿' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载 Word' })).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Word' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${title}-发明专利申请材料.docx`);
  const path = testInfo.outputPath('invention-shared.docx');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  writeFileSync(path, Buffer.concat(chunks));
  execFileSync('unzip', ['-t', path]);
  const xml = execFileSync('unzip', ['-p', path, 'word/document.xml'], { encoding: 'utf8' });
  const texts = Array.from(xml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs), match => match[1]).join('');
  expect(texts).toContain('发明内容');
  expect(texts).toContain('本发明');
  expect(texts).toContain('1. 一种带可拆卸连接结构的光伏组件安装支架');
  expect(texts).not.toContain('本实用新型');
  const headers = execFileSync('sh', ['-c', `for f in $(unzip -Z1 "${path}" "word/header*.xml"); do unzip -p "${path}" "$f"; done`], { encoding: 'utf8' });
  expect(headers).toContain('说明书附图');
});
