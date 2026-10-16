import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadEnv } from 'vite';
import { MysqlDatabase, readStorageConfig } from '../server/mysql/database';
const usernames: string[] = [];

test('注册、普通用户、刷新、退出和重新登录，登录界面无障碍与手机布局', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '欢迎回到知创工坊' })).toBeVisible();
  expect((await page.request.get('/api/storage/projects')).status()).toBe(401);
  await page.screenshot({ path: 'artifacts/auth-login-desktop.png', fullPage: true });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByLabel('昵称', { exact: false }).fill('登录测试用户');
  const username = `ui_${Date.now()}`; usernames.push(username);
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('TestPassword123!');
  await page.getByLabel('确认密码', { exact: true }).fill('WrongPassword123!');
  await page.getByRole('button', { name: '创建账号并进入' }).click();
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致');
  await page.getByLabel('确认密码', { exact: true }).fill('TestPassword123!');
  await page.screenshot({ path: 'artifacts/auth-register-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '创建账号并进入' }).click();
  await expect(page.getByRole('link', { name: /项目管理/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目管理' })).toBeVisible();
  await expect(page).toHaveURL(/#projects$/);
  await page.goto('/');
  await expect(page).toHaveURL(/#projects$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: '项目管理' })).toBeVisible();
  await page.getByRole('link', { name: '工作台', exact: true }).click();
  await page.reload();
  await expect(page).toHaveURL(/#dashboard$/);
  await expect(page.locator('.category-card')).toHaveCount(4);
  await page.getByRole('button', { name: '个人工作空间信息' }).click();
  await expect(page.getByText(`@${username} · 普通用户`, { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '欢迎回到知创工坊' })).toBeVisible();
  expect((await page.request.get('/api/storage/projects')).status()).toBe(401);
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('WrongPassword123!');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('alert')).toContainText('账号或密码错误');
  await page.getByLabel('密码', { exact: true }).fill('TestPassword123!');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('link', { name: /项目管理/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目管理' })).toBeVisible();
  await expect(page).toHaveURL(/#projects$/);
});

test('手机布局、重复账号提示和账号服务故障重试', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(page.getByRole('heading', { name: '欢迎回到知创工坊' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/auth-login-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  const username = `mobile_${Date.now()}`; usernames.push(username);
  const created = await page.request.post('/api/auth/register', { data: { username, password: 'TestPassword123!' } });
  expect(created.status()).toBe(201);
  await page.request.post('/api/auth/logout', { data: {} });
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('TestPassword123!');
  await page.getByLabel('确认密码', { exact: true }).fill('TestPassword123!');
  await page.getByRole('button', { name: '创建账号并进入' }).click();
  await expect(page.getByRole('alert')).toContainText('这个账号已经注册');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/auth-register-mobile.png', fullPage: true });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.route('**/api/auth/me', route => route.abort()); await page.reload();
  await expect(page.getByRole('alert')).toContainText('无法连接账号服务');
  await page.unroute('**/api/auth/me'); await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByRole('heading', { name: '欢迎回到知创工坊' })).toBeVisible();
});

test.afterAll(async () => {
  const database = new MysqlDatabase(readStorageConfig({ ...loadEnv('test', process.cwd(), ''), ...process.env }));
  try {
    for (const username of usernames) await database.pool.execute('DELETE FROM users WHERE username = ?', [username]);
    const workspace = process.env.AUTH_TEST_WORKSPACE_ID;
    if (!workspace?.startsWith('auth-browser-test-')) throw new Error('Missing isolated auth workspace');
    await database.pool.execute('DELETE FROM workspaces WHERE id = ?', [workspace]);
  } finally { await database.close(); }
});
