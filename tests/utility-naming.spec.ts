import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { checkName, checkProduct, emptyProfile, isNamingRecord, validateProfile } from '../src/features/utility/naming';
import { mockNaming } from './fixtures/namingAi';

const company = '明远设备有限公司';

test('规则：禁用宣传语和软件客体，支持多选结构特征及旧草稿', () => {
  const profile = { ...emptyProfile, company, business: '钢材', product: 'H型钢梁', features: 'H型截面、螺栓连接板、带滑槽限位结构' };
  expect(validateProfile(profile)).toEqual({});
  expect(checkName('一种带螺栓连接板的H型钢梁', profile).errors).toEqual([]);
  expect(checkName('一种高效H型钢梁', profile).errors.length).toBeGreaterThan(0);
  expect(checkName('一种数据处理方法', profile).errors.length).toBeGreaterThan(0);
  expect(isNamingRecord({ version: 1, profile, candidates: [], selectedName: '', confirmed: false })).toBe(true);
});

test('规则：名称主体必须是所填产品本身，不能改成它的配件或加工设备', () => {
  // 用户填的是材料「钢材」，细化为 H型钢梁 是正确的；改成连接组件/夹具/机床则不是保护客体本身。
  expect(checkName('一种H型钢梁', { ...emptyProfile, company, business: '钢材' }).errors).toEqual([]);
  expect(checkName('一种带腹板两侧对称夹持板的H型钢梁', { ...emptyProfile, company, business: '钢材' }).errors).toEqual([]);
  expect(checkName('一种H型钢梁连接组件', { ...emptyProfile, company, business: '钢材' }).errors.join('')).toContain('名称主体必须是所填产品');
  expect(checkName('一种带腹板两侧对称夹持板的H型钢梁连接组件', { ...emptyProfile, company, business: '钢材' }).errors.join('')).toContain('名称主体必须是所填产品');
  expect(checkName('一种钢梁定位夹具', { ...emptyProfile, company, business: '钢材' }).errors.join('')).toContain('名称主体必须是所填产品');
  // 用户产品本身就是配件时，以该配件收尾才是正确的。
  expect(checkName('一种带边框的光伏组件安装支架', { ...emptyProfile, company, business: '光伏组件安装支架' }).errors).toEqual([]);
  // 具体产品必须原样收尾，不能被替换成别的客体。
  expect(checkName('一种带滑槽的H型钢梁', { ...emptyProfile, company, business: 'H型钢梁' }).errors).toEqual([]);
  expect(checkName('一种带滑槽的H型钢梁连接组件', { ...emptyProfile, company, business: 'H型钢梁' }).errors.join('')).toContain('名称主体必须是所填产品');
});

test('规则：识别具体导轨和叶片，阻断原材料、空泛客体及效果特征', () => {
  const profile = { ...emptyProfile, company, business: 'H型钢梁', product: 'H型钢梁', features: '螺栓连接板' };
  expect(checkName('一种带定位孔的导轨', { ...emptyProfile, company, business: '导轨' }).errors).toEqual([]);
  expect(checkName('一种弧形叶片', { ...emptyProfile, company, business: '叶片' }).errors).toEqual([]);
  expect(checkProduct('无纺布')).toEqual([]);
  expect(checkProduct('光伏板')).toEqual([]);
  expect(validateProfile(profile)).toEqual({});
  expect(validateProfile({ ...profile, product: '钢材' }).product).toContain('具体的实体产品');
  expect(validateProfile({ ...profile, product: '装置' }).product).toContain('具体的实体产品');
  expect(validateProfile({ ...profile, features: '耐腐蚀' }).features).toContain('形状、部件或连接特征');
});

test('规则：保护客体必须是带有具体限定的实体装置或组件', () => {
  for (const product of ['未识别到明确的产品客体', '未识别到明确的产品客体连接组件', '待确认的定位机构', '钢结构', '机械设备', '支架', '装置', '组件', '连接件']) {
    expect(checkProduct(product)).not.toEqual([]);
  }
  for (const product of ['H型钢梁', '管道安装支架', '输送设备导向机构']) {
    expect(checkProduct(product)).toEqual([]);
  }
  expect(validateProfile({ ...emptyProfile, company, business: '钢材', product: 'H型钢梁', features: '待确认的螺栓连接板' }).features).toContain('形状、部件或连接特征');
});

async function fillAndGenerate(page: import('@playwright/test').Page) {
  await mockNaming(page, 'H型钢梁');
  await page.goto('/#utility');
  await page.getByLabel('企业名称', { exact: false }).fill(company);
  await page.getByLabel('产品名称', { exact: false }).fill('钢材');
  await page.getByRole('button', { name: '生成产品建议' }).click();
  await expect(page.locator('.un-option')).toHaveCount(5);
  await page.getByRole('button', { name: 'H型钢梁', exact: true }).click();
  await page.getByLabel('H型截面').check();
  await page.getByLabel('螺栓连接板').check();
  await page.getByRole('radio', { name: '形状与构造结合' }).check();
  await page.getByRole('button', { name: '生成结构资料选项' }).click();
  for (const label of ['壳体与支架', '固定连接', '部件相对固定', '平板与方壳']) await page.getByRole('checkbox', { name: new RegExp(label) }).check();
  await page.getByRole('button', { name: '确认所选结构资料' }).click();
  await page.getByRole('button', { name: '确认选项并生成名称' }).click();
  await expect(page.locator('.un-candidate')).toHaveCount(3);
}

test('集成：产品建议、结构多选、名称换批、确认保存与刷新', async ({ page }) => {
  await fillAndGenerate(page);
  const before = await page.locator('.un-candidate').allTextContents();
  await page.getByRole('button', { name: '换一批名称' }).click();
  await expect(page.locator('.un-candidate')).toHaveCount(3);
  await expect.poll(() => page.locator('.un-candidate').allTextContents()).not.toEqual(before);
  await page.locator('.un-candidate').first().click();
  await page.getByRole('checkbox', { name: /我已确认名称/ }).check();
  await page.getByRole('button', { name: '确认名称并保存' }).click();
  // 项目持久化已迁到 IndexedDB；localStorage 的旧键只读不写，不能再作为项目数据源。
  const projects = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('zhichuang-workshop');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction('kv', 'readonly').objectStore('kv').get('projects');
        request.onsuccess = () => resolve(request.result?.value || []);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
  expect(projects[0].description).toContain('产品名称：钢材');
  expect(projects[0].naming.profile.features).toBe('H型截面、螺栓连接板');
  expect(projects[0].naming.profile.improvementType).toBe('combined');
  expect(projects[0].naming.structureSelection.selectedIds).toEqual(['E01', 'E02', 'E03', 'E04']);
  await page.reload();
  await expect(page.getByLabel('产品名称', { exact: false })).toHaveValue('钢材');
  await expect(page.locator('.un-option')).toHaveCount(5);
  await expect(page.getByLabel('H型截面')).toBeChecked();
  await expect(page.getByRole('radio', { name: '形状与构造结合' })).toBeChecked();
});

test('系统：产品建议换批、输入变化使候选失效，失败后仍可重试', async ({ page }) => {
  await fillAndGenerate(page);
  await page.getByRole('button', { name: '换一批产品建议' }).click();
  await expect(page.locator('.un-option')).toHaveCount(5);
  await expect(page.locator('.un-candidate')).toHaveCount(0);
  await page.getByLabel('产品名称', { exact: false }).fill('建筑钢材');
  await expect(page.locator('.un-option')).toHaveCount(0);
  await page.route('**/api/utility/naming-options', route => route.fulfill({ status: 502, json: { error: { message: 'AI 暂时不可用' } } }));
  await page.getByRole('button', { name: '生成产品建议' }).click();
  await expect(page.getByText('AI 暂时不可用')).toBeVisible();
  await page.unroute('**/api/utility/naming-options');
  await mockNaming(page, 'H型钢梁');
  await page.getByRole('button', { name: '生成产品建议' }).click();
  await expect(page.locator('.un-option')).toHaveCount(5);
});

test('集成：产品建议与名称生成期间在按钮上显示进度，结束后恢复', async ({ page }) => {
  await mockNaming(page, 'H型钢梁');
  let releaseOptions: (() => void) | undefined;
  let releaseNames: (() => void) | undefined;
  await page.route('**/api/utility/naming-options', async route => {
    await new Promise<void>(resolve => { releaseOptions = resolve; });
    await route.fulfill({ json: { options: Array.from({ length: 5 }, (_, index) => ({ product: index ? `H型钢梁${index}` : 'H型钢梁', features: ['H型截面'] })) } });
  });
  await page.route('**/api/utility/naming-names', async route => {
    await new Promise<void>(resolve => { releaseNames = resolve; });
    await route.fulfill({ json: { candidates: Array.from({ length: 3 }, (_, index) => ({ name: `一种带${index}号连接板的H型钢梁`, product: 'H型钢梁', feature: 'H型截面', basis: '结构特征', inferred: false })) } });
  });
  await page.goto('/#utility');
  await page.getByLabel('企业名称', { exact: false }).fill(company);
  await page.getByLabel('产品名称', { exact: false }).fill('钢材');
  await page.getByRole('button', { name: '生成产品建议' }).click();
  const optionsProgress = page.getByRole('progressbar', { name: '产品建议生成进度' });
  await expect(optionsProgress).toBeVisible();
  await expect(optionsProgress).not.toHaveAttribute('aria-valuenow');
  await expect(page.getByRole('button', { name: '正在生成产品建议…' })).toBeDisabled();
  releaseOptions?.();
  await expect(optionsProgress).toHaveCount(0);
  await page.getByRole('button', { name: 'H型钢梁', exact: true }).click();
  await page.getByLabel('H型截面').check();
  await page.getByRole('radio', { name: '构造改进' }).check();
  await page.getByRole('button', { name: '生成结构资料选项' }).click();
  for (const label of ['壳体与支架', '固定连接', '部件相对固定', '平板与方壳']) await page.getByRole('checkbox', { name: new RegExp(label) }).check();
  await page.getByRole('button', { name: '确认所选结构资料' }).click();
  await page.getByRole('button', { name: '确认选项并生成名称' }).click();
  const namesProgress = page.getByRole('progressbar', { name: '名称生成进度' });
  await expect(namesProgress).toBeVisible();
  await expect(page.getByRole('button', { name: '正在生成名称…' })).toBeDisabled();
  releaseNames?.();
  await expect(namesProgress).toHaveCount(0);
  await expect(page.locator('.un-candidate')).toHaveCount(3);
});

test('系统：生成失败会清除按钮进度并允许重试', async ({ page }) => {
  let releaseFailure: (() => void) | undefined;
  await page.route('**/api/utility/naming-options', async route => {
    await new Promise<void>(resolve => { releaseFailure = resolve; });
    await route.fulfill({ status: 502, json: { error: { message: 'AI 暂时不可用' } } });
  });
  await page.goto('/#utility');
  await page.getByLabel('企业名称', { exact: false }).fill(company);
  await page.getByLabel('产品名称', { exact: false }).fill('钢材');
  await page.getByRole('button', { name: '生成产品建议' }).click();
  await expect(page.getByRole('progressbar', { name: '产品建议生成进度' })).toBeVisible();
  releaseFailure?.();
  await expect(page.getByText('AI 暂时不可用')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '生成产品建议' })).toBeEnabled();
});

test('验收：四阶段中命名页三项进度展示真实服务端节点', async ({ page }) => {
  await mockNaming(page, 'H型钢梁');
  const stream = (route: import('@playwright/test').Route, label: string, data: unknown) => route.fulfill({
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: [
      { type: 'progress', step: { label: '核对输入', detail: '正在检查已提交资料' } },
      { type: 'progress', step: { label, detail: '模型结果正在进行规则核对' } },
      { type: 'result', data },
    ].map(event => JSON.stringify(event)).join('\n') + '\n',
  });
  await page.route('**/api/utility/naming-options', route => stream(route, '筛选模型输出', { options: [{ product: 'H型钢梁', features: ['H型截面', '螺栓连接板'] }] }));
  await page.route('**/api/utility/structure-evidence-options', route => stream(route, '核对结构资料', { options: [
    { id: 'E01', category: 'component', label: '壳体与支架', detail: '壳体安装支架', technicalMeaning: '部件' },
    { id: 'E02', category: 'relationship', label: '固定连接', detail: '支架固定壳体', technicalMeaning: '连接' },
    { id: 'E03', category: 'motion', label: '部件相对固定', detail: '无相对运动', technicalMeaning: '运动' },
    { id: 'E04', category: 'geometry', label: '平板与方壳', detail: '可用长方体示意', technicalMeaning: '几何' },
    { id: 'E05', category: 'problem', label: '装配定位', detail: '需要确定位置', technicalMeaning: '问题' },
  ] }));
  await page.route('**/api/utility/naming-names', route => stream(route, '筛选模型输出', { candidates: [
    { name: '一种带螺栓连接板的H型钢梁', product: 'H型钢梁', feature: '螺栓连接板', basis: '结构资料', inferred: false },
  ] }));
  await page.goto('/#utility');
  await page.getByLabel('企业名称', { exact: false }).fill(company);
  await page.getByLabel('产品名称', { exact: false }).fill('钢材');
  await page.getByRole('button', { name: '生成产品建议' }).click();
  await expect(page.getByRole('button', { name: 'H型钢梁', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'H型钢梁', exact: true }).click();
  await page.getByLabel('螺栓连接板').check();
  await page.getByRole('radio', { name: '构造改进' }).check();
  await page.getByRole('button', { name: '生成结构资料选项' }).click();
  await expect(page.getByText('壳体与支架', { exact: true })).toBeVisible();
  for (const label of ['壳体与支架', '固定连接', '部件相对固定', '平板与方壳']) await page.getByRole('checkbox', { name: new RegExp(label) }).check();
  await page.getByRole('button', { name: '确认所选结构资料' }).click();
  await page.getByRole('button', { name: '确认选项并生成名称' }).click();
  await expect(page.locator('.un-candidate')).toHaveCount(1);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
});

for (const width of [390, 768, 1440]) {
  test(`验收：${width}px 可选择并确认，页面无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fillAndGenerate(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations).toEqual([]);
  });
}
