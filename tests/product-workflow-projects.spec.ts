import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Project } from '../src/data';
import { makeWorkflow, makeReview, makeBrief, makePreview, productProject } from './fixtures/productWorkflow';
import { makeTextStructure } from './fixtures/productText';

function proposal(product: string, context = '') {
  return { product, context, scenario: `${product}在日常使用中的定位和维护`, problems: [1, 2, 3].map(index => ({
    id: `p${index}`, title: `定位改进方向${index}`, problem: `${product}在场景${index}中定位不便`, goal: '便于调节与固定',
    approach: '通过导向部件和可解除的锁紧连接调整位置', suggestedName: `一种带导向锁紧结构的${product}`,
  })) };
}
async function seed(page: Page, projects: Project[]) {
  await page.addInitScript(projects => localStorage.setItem('zhichuang-projects-v1', JSON.stringify(projects)), projects);
}
async function savedProjects(page: Page): Promise<Project[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('zhichuang-workshop'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<Project[]>((resolve, reject) => { const request = db.transaction('kv').objectStore('kv').get('projects'); request.onsuccess = () => resolve(request.result?.value || []); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  });
}
async function mockCreation(page: Page, holdReview?: Promise<void>) {
  const calls: { stage: string; body: any }[] = [];
  await page.route('**/api/generation/**', route => route.fulfill({ json: route.request().url().endsWith('/begin') ? { token: `token-${calls.length}` } : { success: true } }));
  await page.route('**/api/product/**', async route => {
    const stage = route.request().url().split('/').at(-1)!;
    const body = route.request().postDataJSON(); calls.push({ stage, body });
    let data: unknown;
    if (stage === 'problems') data = proposal(body.product, body.context);
    else if (stage === 'review') { if (holdReview) await holdReview; data = makeReview(body.selection, false, `review-${calls.length}`); }
    else if (stage === 'structure') data = makeTextStructure(body.review);
    else if (stage === 'brief') data = makeBrief(body.review, `brief-${calls.length}`);
    else if (stage === 'preview') data = makePreview(body.brief, `preview-${calls.length}`);
    else { await route.fulfill({ status: 503, json: { error: { message: '测试不调用真实生成服务' } } }).catch(() => {}); return; }
    await route.fulfill({ json: data }).catch(() => {});
  });
  return calls;
}
async function create(page: Page, name: string, company: string, product: string) {
  await page.getByRole('button', { name: '新增专利', exact: true }).first().click();
  await expect(page.getByLabel('知识产权类型', { exact: true })).toHaveValue('utility');
  await page.getByLabel('项目名称').fill(name);
  await page.getByLabel('公司名称').fill(company);
  await page.getByLabel('基础产品名称').fill(product);
  await page.getByRole('button', { name: '选择问题', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('选择要解决的问题');
  await expect(page.getByRole('radio')).toHaveCount(3);
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page).toHaveURL(/#projects\/all$/);
}

test('类型默认实用新型，切换类型保留输入且不跳转，旧入口改为项目管理弹窗', async ({ page }) => {
  await seed(page, []); await page.goto('/#projects/all');
  await page.getByRole('button', { name: '新增专利', exact: true }).first().click();
  await expect(page.getByLabel('知识产权类型', { exact: true })).toHaveValue('utility');
  await page.getByLabel('项目名称').fill('闸门改进项目');
  await page.getByLabel('知识产权类型', { exact: true }).selectOption('software');
  await page.getByLabel('知识产权类型', { exact: true }).selectOption('utility');
  await expect(page.getByLabel('项目名称')).toHaveValue('闸门改进项目');
  await expect(page).toHaveURL(/#projects\/all$/);
  page.once('dialog', dialog => dialog.accept()); await page.keyboard.press('Escape');
  await page.goto('/#utility');
  await expect(page).toHaveURL(/#projects\/all$/);
  await expect(page.getByRole('dialog', { name: '新建项目' })).toBeVisible();
  await expect(page.locator('.utility-naming')).toHaveCount(0);
});

test('连续新建独立后台任务，填写和选题均在弹窗完成，生成不覆盖项目名和基础产品名', async ({ page }) => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  await seed(page, []); const calls = await mockCreation(page, hold); await page.goto('/#projects/all');
  await create(page, '闸门项目一', '甲公司', '闸门');
  await expect.poll(() => calls.filter(call => call.stage === 'review').length).toBe(1);
  await create(page, '屏幕项目二', '乙公司', '屏幕');
  await expect.poll(() => calls.filter(call => call.stage === 'review').length).toBe(2);
  const rows = page.locator('tbody tr'); await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: '闸门项目一' })).toContainText('逻辑校验');
  await expect(rows.filter({ hasText: '屏幕项目二' })).toContainText('逻辑校验');
  expect(calls.filter(call => call.stage === 'review').map(call => call.body.selection.product)).toEqual(['闸门', '屏幕']);
  release(); await expect(page.locator('tbody').getByText('待确认彩色预览', { exact: true })).toHaveCount(2);
  await expect.poll(async () => (await savedProjects(page)).every(project => project.productWorkflow?.previews)).toBe(true);
  const stored = await savedProjects(page);
  expect(stored.map(project => project.name)).toEqual(['屏幕项目二', '闸门项目一']);
  expect(stored.map(project => project.baseProductName)).toEqual(['屏幕', '闸门']);
  await page.reload(); await expect(rows).toHaveCount(2); await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('公司、基础产品名、类型、状态和关键词组合筛选，编辑不会丢失成果，删除可取消', async ({ page }) => {
  const complete = { ...productProject, name: '闸门项目一', baseProductName: '闸门', owner: '甲公司', status: 'ready' as const, productWorkflow: makeWorkflow(true) };
  await seed(page, [complete, { ...productProject, id: 'p2', name: '屏幕项目', baseProductName: '屏幕', owner: '甲公司' },
    { ...productProject, id: 'p3', name: '其他闸门', baseProductName: '闸门', owner: '乙公司' }]);
  await page.goto('/#projects/all');
  await page.getByLabel('按公司筛选').selectOption('甲公司');
  await page.getByLabel('按基础产品名筛选').selectOption('闸门');
  await page.getByLabel('按知识产权类型筛选').selectOption('utility');
  await page.getByRole('button', { name: '已整理', exact: true }).click();
  await page.getByLabel('查询项目', { exact: true }).fill('闸门项目');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '编辑闸门项目一', exact: true }).click();
  await page.getByLabel('项目名称').fill('闸门项目改名');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await expect.poll(async () => (await savedProjects(page)).find(project => project.id === complete.id)?.name).toBe('闸门项目改名');
  const stored = (await savedProjects(page)).find(project => project.id === complete.id)!;
  expect(stored.status).toBe('ready'); expect(stored.productWorkflow).toEqual(complete.productWorkflow);
  await page.getByRole('button', { name: '删除闸门项目改名', exact: true }).click();
  await page.getByRole('button', { name: '保留项目' }).click(); await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: '删除闸门项目改名', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect.poll(async () => (await savedProjects(page)).length).toBe(2);
  await page.reload(); await expect(page.locator('tbody tr')).toHaveCount(2);
});

test('生成完毕才显示三个申报按钮，可任意切换、单独保存、筛选及刷新恢复', async ({ page }, testInfo) => {
  const complete = { ...productProject, name: '完成的专利', baseProductName: '闸门', productWorkflow: makeWorkflow(true) };
  const unfinished = { ...productProject, id: 'not-generated', name: '仅标记已整理', status: 'ready' as const };
  await seed(page, [complete, unfinished]); await page.goto('/#projects/all');
  const row = page.locator('tbody tr').filter({ hasText: complete.name });
  await expect(row.getByRole('button', { name: '未提交申报', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('tbody tr').filter({ hasText: unfinished.name }).getByRole('button', { name: '申报中', exact: true })).toHaveCount(0);
  for (const [label, status] of [['申报中', 'in_progress'], ['申报完毕', 'completed'], ['未提交申报', 'not_submitted'], ['申报完毕', 'completed']]) {
    await row.getByRole('button', { name: label, exact: true }).click();
    await expect(row.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await savedProjects(page))[0].filingStatus).toBe(status);
  }
  await page.reload();
  await expect(row.getByRole('button', { name: '申报完毕', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('project-management-desktop.png'), fullPage: true });
  await page.getByLabel('按申报状态筛选').selectOption('completed'); await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('按申报状态筛选').selectOption('in_progress'); await expect(page.getByText('没有找到相关项目')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click(); await expect(page.locator('tbody tr')).toHaveCount(2);
});

test('生成期间编辑项目信息保留新结果，删除在途项目不会重新出现或影响其他项目', async ({ page }) => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  await seed(page, []); const calls = await mockCreation(page, hold); await page.goto('/#projects/all');
  await create(page, '保留的闸门', '甲公司', '闸门');
  await create(page, '删除的屏幕', '乙公司', '屏幕');
  await expect.poll(() => calls.filter(call => call.stage === 'review').length).toBe(2);
  await page.getByRole('button', { name: '删除删除的屏幕', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await page.getByRole('button', { name: '编辑保留的闸门', exact: true }).click();
  await page.getByLabel('项目名称').fill('编辑后的闸门');
  release();
  await expect.poll(async () => !!(await savedProjects(page))[0]?.productWorkflow?.previews).toBe(true);
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('编辑后的闸门');
  await expect(page.locator('tbody tr')).toContainText('待确认彩色预览');
  await expect.poll(async () => (await savedProjects(page))[0]?.name).toBe('编辑后的闸门');
  expect((await savedProjects(page))[0].productWorkflow?.previews).toBeTruthy();
  expect(calls.filter(call => call.stage === 'review')).toHaveLength(2);
  expect(calls.filter(call => call.stage === 'preview')).toHaveLength(1);
});

test('生成问题失败可重试，返回修改基础产品后不会使用上一个产品的问题', async ({ page }) => {
  await seed(page, []); let attempts = 0;
  await page.route('**/api/product/problems', route => { attempts++; return route.fulfill(attempts === 1
    ? { status: 503, json: { error: { message: '候选问题服务暂时不可用' } } }
    : { json: proposal(route.request().postDataJSON().product) }); });
  await page.goto('/#projects/all'); await page.getByRole('button', { name: '新增专利', exact: true }).first().click();
  await page.getByLabel('项目名称').fill('产品项目'); await page.getByLabel('基础产品名称').fill('闸门');
  await page.getByRole('button', { name: '选择问题', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('候选问题服务暂时不可用');
  await page.getByRole('button', { name: '选择问题', exact: true }).click(); await expect(page.getByRole('radio')).toHaveCount(3);
  await page.getByRole('button', { name: '返回修改信息' }).click(); await page.getByLabel('基础产品名称').fill('屏幕');
  await page.getByRole('button', { name: '选择问题', exact: true }).click();
  await expect(page.getByRole('radiogroup')).toContainText('屏幕'); await expect(page.getByRole('radiogroup')).not.toContainText('闸门');
  await expect(page.getByRole('button', { name: '下一步', exact: true })).toBeDisabled();
});

test('移动端项目列表与选题弹窗无横向溢出并通过无障碍检查', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, [{ ...productProject, baseProductName: '闸门', productWorkflow: makeWorkflow(true) }]); await mockCreation(page);
  await page.goto('/#projects/all');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('project-management-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '新增专利', exact: true }).click();
  await page.getByLabel('项目名称').fill('屏幕项目'); await page.getByLabel('基础产品名称').fill('屏幕');
  await page.getByRole('button', { name: '选择问题', exact: true }).click(); await expect(page.getByRole('radio')).toHaveCount(3);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('project-problems-mobile.png'), fullPage: true });
});
