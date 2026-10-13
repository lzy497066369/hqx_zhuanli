import { test, expect } from '@playwright/test';
import { loadEnv } from 'vite';
import { MysqlDatabase, readStorageConfig } from '../server/mysql/database';
import AxeBuilder from '@axe-core/playwright';
const usernames: string[] = [];

test('个人多空间：新建、切换、项目和草稿隔离、账号隔离、重命名和删除', async ({ page, browser }) => {
  const username = `spaces_${Date.now()}`; usernames.push(username);
  await page.request.post('/api/auth/register', { data:{ username,password:'WorkspaceTest123!' } });
  // Old browser data must never be imported automatically into private spaces.
  await page.addInitScript(() => localStorage.setItem('zhichuang-projects-v1', JSON.stringify([{id:'old',name:'不属于账号的旧数据',category:'software',description:'',owner:'',status:'draft',updatedAt:new Date().toISOString()}])));
  await page.goto('/#projects');
  await expect(page.getByRole('button',{name:'切换工作空间'})).toContainText('我的工作空间');
  await expect(page.getByText('不属于账号的旧数据',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'新建项目',exact:true}).first().click();
  await page.getByLabel('项目名称').fill('仅第一空间项目');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/storage/projects') && response.request().method()==='PUT' && response.status()===200);
  await page.getByRole('button',{name:'保存并预览'}).click(); await saved;
  await page.getByRole('button',{name:'关闭弹窗'}).click();
  await page.getByRole('button',{name:'切换工作空间'}).click();
  await page.getByRole('button',{name:'新建工作空间',exact:true}).click();
  await page.getByLabel('空间名称',{exact:true}).fill('研发空间');
  await page.getByLabel('空间简介').fill('研发成果专用');
  await page.getByRole('button',{name:'创建空间',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('研发空间');
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:'artifacts/private-workspaces-desktop.png',fullPage:true});
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'进入',exact:true}).click();
  await expect(page.getByRole('button',{name:'切换工作空间'})).toContainText('研发空间');
  await expect(page.getByText('仅第一空间项目',{exact:true})).toHaveCount(0);
  await page.goto('/#utility');
  await page.getByLabel('企业名称').fill('研发草稿企业');
  // Switch immediately, before the naming form's debounce completes.
  await page.getByRole('button',{name:'切换工作空间'}).click();
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('.workspace-menu').getByRole('button',{name:'我的工作空间',exact:true}).click();
  await expect(page.getByRole('button',{name:'切换工作空间'})).toContainText('我的工作空间');
  await expect(page.getByText('仅第一空间项目',{exact:true})).toBeVisible();
  await page.goto('/#utility'); await expect(page.getByLabel('企业名称')).toHaveValue('');
  await page.getByRole('button',{name:'切换工作空间'}).click(); page.once('dialog',dialog=>dialog.accept());
  await page.locator('.workspace-menu').getByRole('button',{name:'研发空间',exact:true}).click();
  await expect(page.getByRole('button',{name:'切换工作空间'})).toContainText('研发空间');
  await page.goto('/#utility'); await expect(page.getByLabel('企业名称')).toHaveValue('研发草稿企业');
  const second = await browser.newContext();
  try {
    const another = await second.newPage(); const otherName=`other_${Date.now()}`; usernames.push(otherName);
    await second.request.post('http://127.0.0.1:5210/api/auth/register',{data:{username:otherName,password:'WorkspaceTest123!'}});
    await another.goto('http://127.0.0.1:5210/#projects');
    await expect(another.getByRole('button',{name:'切换工作空间'})).toContainText('我的工作空间');
    await expect(another.getByText('仅第一空间项目',{exact:true})).toHaveCount(0);
    const list=await (await second.request.get('http://127.0.0.1:5210/api/workspaces')).json();
    expect(list.workspaces).toHaveLength(1);
  } finally { await second.close(); }
  await page.getByRole('button',{name:'切换工作空间'}).click();
  await page.getByRole('button',{name:'管理工作空间'}).click();
  const row=page.locator('.workspace-row').filter({hasText:'研发空间'});
  await row.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByLabel('空间名称',{exact:true}).fill('研发归档');
  await page.getByRole('button',{name:'保存空间'}).click();
  await page.getByRole('button',{name:'删除工作空间研发归档'}).click();
  await page.getByLabel('输入空间名称确认').fill('研发归档');
  await page.getByRole('button',{name:'确认删除空间'}).click();
  await expect(page.getByRole('button',{name:'切换工作空间'})).toContainText('我的工作空间');
  await expect(page.getByText('仅第一空间项目',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'打开导航'}).click();
  await page.getByRole('button',{name:'切换工作空间'}).click();
  await page.getByRole('button',{name:'管理工作空间'}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/private-workspaces-mobile.png',fullPage:true});
});

test.afterAll(async()=>{
  const db=new MysqlDatabase(readStorageConfig({...loadEnv('test',process.cwd(),''),...process.env}));
  try { for(const username of usernames) await db.pool.execute('DELETE FROM users WHERE username = ?',[username]); }
  finally { await db.close(); }
});
