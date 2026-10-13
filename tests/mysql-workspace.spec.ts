import { test, expect } from '@playwright/test';
import { readStorageConfig, MysqlDatabase } from '../server/mysql/database.ts';
import { loadEnv } from 'vite';
import { makeWorkflow, productProject } from './fixtures/productWorkflow';

test('MySQL JSON 调整键顺序后完整成品仍可恢复和导出，不重复生成', async ({ page }) => {
  const response = await page.request.get('/api/storage/projects');
  const snapshot = await response.json();
  const saved = await page.request.put('/api/storage/projects', { data: {
    projects: [{ ...productProject, productWorkflow: makeWorkflow(true) }], revision: snapshot.revision,
  } });
  expect(saved.ok()).toBeTruthy();
  let modelCalls = 0;
  await page.route('**/api/product/**', route => { modelCalls++; return route.abort(); });
  await page.goto(`/#utility/${productProject.id}`);
  await expect(page.getByRole('button', { name: '下载 Word 成品（.docx）', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: '下载 Word 成品（.docx）', exact: true })).toBeEnabled();
  expect(modelCalls).toBe(0);
});

test('MySQL 页面：旧项目迁移、跨浏览器读取、刷新、草稿和资料库恢复、冲突提示', async ({ page, browser }) => {
  const config = await page.request.get('/api/storage/config');
  expect((await config.json()).driver).toBe('mysql');
  const project = { id: 'legacy-test', name: '旧浏览器项目', category: 'software', owner: '企业', description: '迁移资料', status: 'draft', updatedAt: new Date().toISOString() };
  await page.addInitScript(p => { if (!localStorage.getItem('test-seeded')) { localStorage.setItem('zhichuang-projects-v1', JSON.stringify([p])); localStorage.setItem('test-seeded', '1'); } }, project);
  await page.goto('/#projects');
  await expect(page.getByText('旧浏览器项目', { exact: true })).toBeVisible();
  const second = await browser.newContext();
  const another = await second.newPage();
  try {
    await another.goto('http://127.0.0.1:5209/#projects');
    await expect(another.getByText('旧浏览器项目', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称').fill('MySQL 软件项目');
    await page.getByLabel('申请人 / 著作权人').fill('数据库测试企业');
    const saved = page.waitForResponse(r => r.url().endsWith('/api/storage/projects') && r.request().method() === 'PUT' && r.status() === 200);
    await page.getByRole('button', { name: '保存并预览' }).click();
    await saved;
    await page.getByRole('button', { name: '关闭弹窗' }).click();
    await page.reload();
    await expect(page.getByText('MySQL 软件项目', { exact: true })).toBeVisible();
    // Stale browser snapshot must not delete the project just created above.
    await another.getByRole('button', { name: '新建项目', exact: true }).click();
    await another.getByLabel('项目名称').fill('过期页面修改');
    await another.getByRole('button', { name: '保存并预览' }).click();
    await expect(another.getByRole('alert')).toContainText('其他页面已修改数据');
    await expect(another.getByRole('button', { name: '导出备份' })).toBeVisible();
    await page.getByRole('link', { name: '资料库', exact: true }).click();
    const materialSaved = page.waitForResponse(r => r.url().endsWith('/api/storage/materials') && r.request().method() === 'PUT' && r.status() === 200);
    await page.locator('input[type=file]').setInputFiles({ name: 'MySQL资料.txt', mimeType: 'text/plain', buffer: Buffer.from('文件内容不上传') });
    await materialSaved;
    await page.reload();
    await expect(page.getByText('MySQL资料.txt', { exact: true })).toBeVisible();
    await page.goto('/#utility');
    await page.getByLabel('企业名称').fill('MySQL草稿企业');
    await expect.poll(async () => (await (await page.request.get('/api/storage/naming-drafts/new')).json()).draft?.profile.company).toBe('MySQL草稿企业');
    await page.reload();
    await expect(page.getByLabel('企业名称')).toHaveValue('MySQL草稿企业');
  } finally { await second.close(); }
});

test.afterEach(async () => {
  const config = readStorageConfig({ ...loadEnv('test', process.cwd(), ''), ...process.env });
  const database = new MysqlDatabase(config);
  try {
    const workspace = process.env.MYSQL_TEST_WORKSPACE_ID;
    if (!workspace?.startsWith('browser-test-')) throw new Error('Missing isolated test workspace');
    await database.pool.execute('DELETE FROM projects WHERE workspace_id = ?', [workspace]);
    await database.pool.execute('DELETE FROM materials WHERE workspace_id = ?', [workspace]);
    await database.pool.execute('DELETE FROM naming_drafts WHERE workspace_id = ?', [workspace]);
    await database.pool.execute('UPDATE workspaces SET projects_initialized = FALSE WHERE id = ?', [workspace]);
  } finally { await database.close(); }
});

test.afterAll(async () => {
  const workspace = process.env.MYSQL_TEST_WORKSPACE_ID;
  if (!workspace?.startsWith('browser-test-')) throw new Error('Missing isolated test workspace');
  const database = new MysqlDatabase(readStorageConfig({ ...loadEnv('test', process.cwd(), ''), ...process.env }));
  try { await database.pool.execute('DELETE FROM workspaces WHERE id = ?', [workspace]); }
  finally { await database.close(); }
});
