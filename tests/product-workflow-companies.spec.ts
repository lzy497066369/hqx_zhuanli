import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Project } from '../src/data';
import type { Company } from '../src/features/projects/company';
import { productProject, makeWorkflow, makeReview, makeBrief, makePreview } from './fixtures/productWorkflow';
import { makeTextStructure } from './fixtures/productText';

const when = '2026-10-15T07:00:00.000Z';
const companies: Company[] = [
  { id: 'company-a', name: '甲设备有限公司', mainProducts: ['闸门', '屏幕'], updatedAt: when },
  { id: 'company-b', name: '乙科技有限公司', mainProducts: ['夹具'], updatedAt: when },
];
const patents: Project[] = [
  { ...productProject, name: '甲公司闸门专利', companyId: 'company-a', owner: companies[0].name, baseProductName: '闸门', productWorkflow: makeWorkflow(true) },
  { ...productProject, id: 'patent-a2', name: '甲公司屏幕专利', companyId: 'company-a', owner: companies[0].name, baseProductName: '屏幕' },
  { ...productProject, id: 'patent-b', name: '乙公司夹具专利', companyId: 'company-b', owner: companies[1].name, baseProductName: '夹具' },
];
async function seed(page: Page, projects: Project[] = [], directory?: Company[]) {
  await page.addInitScript(({ projects, directory }) => {
    localStorage.setItem('zhichuang-projects-v1', JSON.stringify(projects));
    if (!directory) return;
    const request = indexedDB.open('zhichuang-workshop', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv', { keyPath: 'key' }); };
    request.onsuccess = () => { const db = request.result; const transaction = db.transaction('kv', 'readwrite'); transaction.objectStore('kv').put({ key: 'companies:local', value: directory }); transaction.oncomplete = () => db.close(); };
  }, { projects, directory });
}
async function stored<T>(page: Page, key: string): Promise<T> {
  return page.evaluate(async key => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('zhichuang-workshop'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<T>((resolve, reject) => { const request = db.transaction('kv').objectStore('kv').get(key); request.onsuccess = () => resolve(request.result?.value); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  }, key);
}
async function createCompany(page: Page, name: string, products: string) {
  await page.getByRole('button', { name: '新增企业', exact: true }).first().click();
  await page.getByLabel('公司名称', { exact: false }).fill(name);
  await page.getByRole('dialog').getByLabel('主营产品', { exact: false }).fill(products);
  await page.getByRole('button', { name: '创建企业', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page).toHaveURL(/#projects$/);
}

test('新增企业后留在企业列表，主营产品去重，支持搜索、编辑、删除与持久保存', async ({ page }, testInfo) => {
  await seed(page); await page.goto('/#projects');
  await createCompany(page, '明远设备有限公司', '闸门、屏幕，闸门');
  await createCompany(page, '海川科技有限公司', '夹具\n支架');
  await expect(page.locator('.company-card')).toHaveCount(2);
  await expect(page.locator('.company-card').filter({ hasText: '明远设备有限公司' }).locator('.company-products > span')).toHaveCount(2);
  await expect.poll(async () => (await stored<Company[]>(page, 'companies:local'))?.length).toBe(2);
  await page.getByLabel('查询企业', { exact: true }).fill('明远'); await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await page.getByLabel('按主营产品筛选企业').selectOption('夹具'); await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await page.getByRole('button', { name: '编辑企业明远设备有限公司', exact: true }).click();
  await page.getByLabel('公司名称', { exact: false }).fill('明远制造有限公司');
  await page.getByRole('dialog').getByLabel('主营产品', { exact: false }).fill('闸门、屏幕、传感器');
  await page.getByRole('button', { name: '保存企业', exact: true }).click();
  await expect.poll(async () => (await stored<Company[]>(page, 'companies:local'))?.some(company => company.name === '明远制造有限公司')).toBe(true);
  await page.reload(); await expect(page.locator('.company-card').filter({ hasText: '明远制造有限公司' })).toContainText('传感器');
  await page.screenshot({ path: testInfo.outputPath('companies-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '删除企业海川科技有限公司', exact: true }).click();
  await page.getByRole('button', { name: '保留企业', exact: true }).click(); await expect(page.locator('.company-card')).toHaveCount(2);
  await page.getByRole('button', { name: '删除企业海川科技有限公司', exact: true }).click();
  await page.getByRole('button', { name: '确认删除企业', exact: true }).click();
  await expect.poll(async () => (await stored<Company[]>(page, 'companies:local'))?.length).toBe(1);
  await page.reload(); await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByRole('button', { name: '删除企业明远制造有限公司', exact: true }).click();
  await page.getByRole('button', { name: '确认删除企业', exact: true }).click();
  await expect.poll(async () => (await stored<Company[]>(page, 'companies:local'))?.length).toBe(0);
  await page.reload(); await expect(page.locator('.company-card')).toHaveCount(0);
});

test('旧项目按原公司归类，企业改名后专利关联和成果保留，企业页刷新和返回有效', async ({ page }) => {
  await seed(page, patents.map(({ companyId: _companyId, ...project }) => project)); await page.goto('/#projects');
  await expect(page.locator('.company-card')).toHaveCount(2);
  const company = page.locator('.company-card').filter({ hasText: companies[0].name }); await expect(company).toContainText('2 项专利');
  await company.locator('.company-open').click(); await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('tbody')).not.toContainText('乙公司夹具专利');
  const companyUrl = page.url();
  await page.reload(); await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: '返回企业列表', exact: true }).click();
  await page.getByRole('button', { name: `编辑企业${companies[0].name}`, exact: true }).click();
  await page.getByLabel('公司名称', { exact: false }).fill('甲设备集团有限公司');
  await page.getByRole('dialog').getByLabel('主营产品', { exact: false }).fill('闸门、屏幕'); await page.getByRole('button', { name: '保存企业' }).click();
  await page.locator('.company-card').filter({ hasText: '甲设备集团有限公司' }).locator('.company-open').click();
  expect(page.url()).toBe(companyUrl); await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('tbody')).toContainText('甲设备集团有限公司');
  const saved = await stored<Project[]>(page, 'projects'); expect(saved[0].productWorkflow).toEqual(patents[0].productWorkflow);
  await page.goBack(); await expect(page.locator('.company-directory')).toBeVisible();
});

test('企业页新增专利自动关联公司，选题后留在企业页，切换企业后继续生成且相互隔离', async ({ page }) => {
  await seed(page, []); await page.goto('/#projects');
  await createCompany(page, '甲公司', '闸门'); await createCompany(page, '乙公司', '屏幕');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const calls: string[] = [];
  await page.route('**/api/generation/**', route => route.fulfill({ json: route.request().url().endsWith('/begin') ? { token: 'company-task' } : {} }));
  await page.route('**/api/product/**', async route => {
    const stage = route.request().url().split('/').at(-1)!; calls.push(stage); const body = route.request().postDataJSON();
    let data: unknown;
    if (stage === 'problems') data = { product: body.product, context: body.context, scenario: '闸门位置调节', problems: [1,2,3].map(index => ({ id: `p${index}`, title: `调节方向${index}`, problem: `场景${index}位置调节不便`, goal: '便于调节', approach: '导向和锁紧连接', suggestedName: '一种带导向锁紧结构的闸门' })) };
    else if (stage === 'review') { await held; data = makeReview(body.selection); }
    else if (stage === 'structure') data = makeTextStructure(body.review);
    else if (stage === 'brief') data = makeBrief(body.review);
    else if (stage === 'preview') data = makePreview(body.brief);
    else { await route.abort(); return; }
    await route.fulfill({ json: data }).catch(() => {});
  });
  await page.locator('.company-card').filter({ hasText: '甲公司' }).locator('.company-open').click(); const companyUrl = page.url();
  await page.getByRole('button', { name: '新增专利', exact: true }).click();
  await expect(page.getByLabel('公司名称', { exact: false })).toHaveValue('甲公司');
  await expect(page.getByLabel('基础产品名称')).toHaveValue('闸门');
  await page.getByLabel('项目名称').fill('甲公司新专利'); await page.getByRole('button', { name: '选择问题', exact: true }).click();
  await page.getByRole('radio').first().check(); await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page).toHaveURL(companyUrl); await expect.poll(() => calls.includes('review')).toBe(true);
  await page.getByRole('button', { name: '返回企业列表', exact: true }).click();
  await expect(page.locator('.company-card').filter({ hasText: '甲公司' })).toContainText('正在生成');
  await page.locator('.company-card').filter({ hasText: '乙公司' }).locator('.company-open').click(); await expect(page.locator('tbody tr')).toHaveCount(0);
  release(); await expect.poll(async () => !!(await stored<Project[]>(page, 'projects'))[0]?.productWorkflow?.previews).toBe(true);
  await page.goto(companyUrl); await expect(page.locator('tbody tr')).toHaveCount(1); await expect(page.locator('tbody')).toContainText('待确认彩色预览');
  const saved = (await stored<Project[]>(page, 'projects'))[0]; expect(saved.companyId).toBeTruthy(); expect(saved.owner).toBe('甲公司');
});

test('删除企业保留专利，刷新不重建企业，可在未归属列表重新指定企业', async ({ page }) => {
  await seed(page, patents); await page.goto('/#projects');
  await page.getByRole('button', { name: `删除企业${companies[0].name}`, exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('已有专利会保留'); await page.getByRole('button', { name: '确认删除企业' }).click();
  await expect.poll(async () => (await stored<Company[]>(page, 'companies:local')).length).toBe(1);
  await page.reload(); await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByRole('button', { name: /未归属企业的专利/ }).click(); await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: '编辑甲公司闸门专利', exact: true }).click();
  const registry = await stored<Company[]>(page, 'companies:local');
  await page.getByLabel('公司名称', { exact: false }).selectOption(registry[0].id);
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect.poll(async () => (await stored<Project[]>(page, 'projects')).find(project => project.id === productProject.id)?.companyId).toBe(registry[0].id);
  await page.getByRole('button', { name: '返回企业列表', exact: true }).click();
  await page.locator('.company-card').first().locator('.company-open').click(); await expect(page.locator('tbody tr')).toHaveCount(2);
});

test('企业名称和主营产品校验，拒绝重复企业且关闭未保存表单可取消', async ({ page }) => {
  await seed(page); await page.goto('/#projects'); await createCompany(page, '甲公司', '闸门');
  await page.getByRole('button', { name: '新增企业', exact: true }).first().click();
  await page.getByLabel('公司名称', { exact: false }).fill(' 甲公司 '); await page.getByRole('dialog').getByLabel('主营产品', { exact: false }).fill('屏幕');
  await page.getByRole('button', { name: '创建企业', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('该企业已存在');
  page.once('dialog', dialog => dialog.dismiss()); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.company-card')).toHaveCount(1);
});

test('企业列表和企业专利页适配手机，新增弹窗可访问', async ({ page }, testInfo) => {
  await seed(page, patents); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/#projects');
  await expect(page.locator('.company-card')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('companies-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '新增企业', exact: true }).first().click();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape'); await page.locator('.company-card').first().locator('.company-open').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('company-patents-mobile.png'), fullPage: true });
});
