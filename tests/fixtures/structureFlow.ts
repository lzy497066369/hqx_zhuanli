import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { patentStructureSource } from '../../src/features/utility/patentStructure';
import type { StructureDraft } from '../../src/features/utility/structureDraft';
import type { StructureSkeleton } from '../../src/features/utility/structureSkeleton';
import { mockNaming } from './namingAi';
import { researchFixture } from './research';

export function sampleDraft(title: string, innovationName = '快拆罩'): StructureDraft {
  return {
    version: 1, title, technicalField: '机械装配技术领域', baseStructure: `壳体连接支架，支架连接${innovationName}。`,
    components: [
      { id: 'D01', name: '壳体', kind: 'base', purpose: '承载', position: '主体', whyNeeded: '固定支架', geometry: { shape: 'box', position: [0, 0, 0], size: [120, 80, 40], rotation: [0, 0, 0] } },
      { id: 'D02', name: '支架', kind: 'base', purpose: '连接', position: '壳体上', whyNeeded: '支撑罩体', geometry: { shape: 'box', position: [20, 0, 40], size: [60, 40, 60], rotation: [0, 0, 0] } },
      { id: 'D03', name: innovationName, kind: 'innovation', purpose: '可拆防护', position: '支架上', whyNeeded: '便于维护', geometry: { shape: 'box', position: [15, -5, 100], size: [70, 50, 20], rotation: [0, 0, 0] } },
    ],
    relationships: [
      { id: 'R01', from: 'D01', to: 'D02', relation: 'fixed_to', description: '支架固定在壳体上' },
      { id: 'R02', from: 'D02', to: 'D03', relation: 'connected_to', description: `${innovationName}连接在支架上` },
    ],
    motions: [
      { id: 'M01', componentId: 'D01', type: 'static', path: '固定', purpose: '承载' },
      { id: 'M02', componentId: 'D02', type: 'static', path: '固定', purpose: '连接' },
      { id: 'M03', componentId: 'D03', type: 'static', path: '安装位置固定', purpose: '防护' },
    ],
    innovationPoints: [`${innovationName}通过支架连接`], problemSolved: '便于维护', workingPrinciple: `${innovationName}连接支架并提供防护。`,
    nextDraftNumber: 4, nextModelNumber: 1,
  };
}

export function sampleSkeleton(title: string, innovationName = '快拆罩'): StructureSkeleton {
  return {
    version: 1, title, visualSubject: '壳体为整体可见主体', subjectComponent: '壳体', summary: '拟议部件和连接，待实物核对。', problemSolved: '便于维护', innovationPoints: [`${innovationName}通过支架连接`],
    components: [
      { name: '壳体', kind: 'base', purpose: '承载', position: '主体', visualFeature: '方形壳体', geometryShape: 'box', geometry: { shape: 'box', position: [0, 0, 0], size: [120, 80, 40], rotation: [0, 0, 0] } },
      { name: '支架', kind: 'base', purpose: '连接', position: '壳体上', visualFeature: '直角支撑件', geometryShape: 'box', geometry: { shape: 'box', position: [20, 0, 40], size: [60, 40, 60], rotation: [0, 0, 0] } },
      { name: innovationName, kind: 'innovation', purpose: '可拆防护', position: '支架上', visualFeature: '可拆罩体', geometryShape: 'box', geometry: { shape: 'box', position: [15, -5, 100], size: [70, 50, 20], rotation: [0, 0, 0] } },
    ],
    relationships: [
      { from: '壳体', to: '支架', relation: 'fixed_to', description: '支架固定在壳体上' },
      { from: '支架', to: innovationName, relation: 'connected_to', description: `${innovationName}连接在支架上` },
    ], motions: [],
  };
}

export function skeletonResponse(brief: { improvementType?: string }, candidate: { name: string }, innovationName = '快拆罩') {
  const research = researchFixture({
    title: candidate.name,
    technicalField: '机械装配技术领域',
    structure: `${candidate.name}包括壳体、支架和${innovationName}。`,
    workingPrinciple: `${candidate.name}通过支架连接并提供防护。`,
  });
  return { status: 'ready', skeleton: sampleSkeleton(candidate.name, innovationName), candidate, source: patentStructureSource(brief as Parameters<typeof patentStructureSource>[0], candidate as Parameters<typeof patentStructureSource>[1]), research, providerModel: 'mock', generatedAt: new Date().toISOString() };
}

export async function mockStructure(page: Page, onRequest?: (title: string) => void, innovationName = '快拆罩') {
  await page.route('**/api/utility/structure-skeleton', async route => {
    const input = route.request().postDataJSON();
    expect(Object.keys(input).sort()).toEqual(['brief', 'candidate', 'requireEvidence']);
    expect(input.requireEvidence).toBe(true);
    expect(input.brief.structureEvidence.confirmed).toBe(true);
    expect(input.candidate.name).toBeTruthy();
    onRequest?.(input.candidate.name);
    await route.fulfill({ json: skeletonResponse(input.brief, input.candidate, innovationName) });
  });
}

export async function openNamedWorkspace(page: Page, product = '光伏组件安装支架', enterWorkspace = true) {
  await mockNaming(page, product);
  await page.goto('/#utility');
  await page.getByLabel('企业名称', { exact: false }).fill('测试设备有限公司');
  await page.getByLabel('产品名称', { exact: false }).fill(product);
  await page.getByRole('button', { name: '生成产品建议' }).click();
  await page.getByRole('button', { name: product, exact: true }).click();
  await page.getByLabel('H型截面').check();
  await page.getByRole('radio', { name: '构造改进' }).check();
  await page.getByRole('button', { name: '生成结构资料选项' }).click();
  for (const label of ['壳体与支架', '固定连接', '部件相对固定', '平板与方壳']) await page.getByRole('checkbox', { name: new RegExp(label) }).check();
  await page.getByRole('button', { name: '确认所选结构资料' }).click();
  await page.getByRole('button', { name: '确认选项并生成名称' }).click();
  await page.locator('.un-candidate').first().click();
  await page.getByRole('checkbox', { name: /我已确认名称/ }).check();
  await page.getByRole('button', { name: '确认名称并保存' }).click();
  const title = await page.getByLabel('实用新型名称', { exact: true }).inputValue();
  if (enterWorkspace) {
    await page.getByRole('button', { name: '进入结构与材料工作区' }).click();
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  }
  return title;
}

export async function generateStructure(page: Page) {
  await page.getByRole('button', { name: '按名称生成结构', exact: true }).click();
  await confirmSkeleton(page);
}

export async function confirmSkeleton(page: Page) {
  await expect(page.getByTestId('structure-skeleton')).toBeVisible();
  await page.getByRole('checkbox', { name: /我已核对部件、连接、运动和形状/ }).check();
  await page.getByRole('button', { name: '确认骨架并编译模型' }).click();
  await expect(page.locator('[data-structure-model="determined"]')).toBeVisible();
  await expect(page.locator('.uw-canvas .uw-svg')).toBeVisible();
}

export async function savedProject(page: Page, title: string) {
  return page.evaluate(async name => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('zhichuang-workshop');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const projects = await new Promise<Array<{ name: string }>>((resolve, reject) => {
        const request = db.transaction('kv', 'readonly').objectStore('kv').get('projects');
        request.onsuccess = () => resolve(request.result?.value || []);
        request.onerror = () => reject(request.error);
      });
      return projects.find(item => item.name === name);
    } finally { db.close(); }
  }, title);
}
