import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { MysqlDatabase, readStorageConfig } from '../server/mysql/database.ts';
import { writeAiLog } from '../server/adminApi.ts';

test('administrator manages users, views full projects and AI logs on desktop and mobile', async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const database = new MysqlDatabase({ ...readStorageConfig(process.env), database: process.env.ADMIN_TEST_DATABASE || 'zhichuang_admin_test' });
  const username = `ui_${randomUUID().replaceAll('-','').slice(0,15)}`, password = 'Ui-Test-Password-890!';
  let userId: string | undefined;
  const logId = randomUUID();
  try {
    await page.goto('/');
    await page.getByLabel('账号',{exact:true}).fill('admin'); await page.getByLabel('密码',{exact:true}).fill('admin123');
    await page.getByRole('button',{name:'登录工作台'}).click();
    await expect(page.getByRole('heading',{name:'AI 请求日志',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'用户管理',exact:true}).click();
    await page.getByRole('button',{name:'新增用户',exact:true}).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('账号',{exact:true}).fill(username);await dialog.getByLabel('昵称',{exact:true}).fill('管理界面测试用户');await dialog.getByLabel('初始密码').fill(password);await dialog.getByRole('button',{name:'保存用户'}).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('textbox',{name:'搜索',exact:true}).fill(username);await page.getByRole('button',{name:'搜索',exact:true}).click();
    const row = page.getByRole('row').filter({hasText:username});await expect(row).toBeVisible();
    await row.getByRole('button',{name:'禁用',exact:true}).click();await expect(row.getByText('已禁用',{exact:true})).toBeVisible();
    await row.getByRole('button',{name:'启用',exact:true}).click();await expect(row.getByText('正常',{exact:true})).toBeVisible();
    await row.getByRole('button',{name:'编辑信息'}).click();await dialog.getByLabel('昵称',{exact:true}).fill('更新后的用户昵称');await dialog.getByRole('button',{name:'保存用户'}).click();await expect(row.getByText('更新后的用户昵称')).toBeVisible();
    const login = await request.post('/api/auth/login',{data:{username,password}});expect(login.ok()).toBeTruthy();
    const loginData=await login.json();userId=loginData.user.id;
    const spaces=await (await request.get('/api/workspaces')).json();const workspaceId=spaces.workspaces[0].id;
    const projectId=randomUUID();const project={id:projectId,name:'管理员项目详情验收',category:'utility',owner:'测试申请人',description:'管理员可以阅读用户资料',status:'draft',updatedAt:new Date().toISOString(),productWorkflow:{document:{claims:'项目完整权利要求内容'}}};
    await database.ready();
    await database.pool.execute('INSERT INTO projects (workspace_id,id,name,category,owner,description,status,position,data) VALUES (?,?,?,?,?,?,?,?,?)',[workspaceId,projectId,project.name,project.category,project.owner,project.description,project.status,0,JSON.stringify(project)]);
    await row.getByRole('button',{name:'查看项目'}).click();await page.getByRole('button',{name:'项目详情'}).click();
    await expect(dialog.getByRole('heading',{name:project.name})).toBeVisible();
    await dialog.locator('summary').filter({hasText:'专利文档'}).click();await dialog.locator('summary').filter({hasText:'权利要求书'}).click();await expect(dialog.getByText('项目完整权利要求内容',{exact:true})).toBeVisible();await dialog.getByRole('button',{name:'关闭弹窗'}).click();
    await writeAiLog(database,{id:logId,requestId:randomUUID(),userId:userId!,username,workspaceId,route:'/api/product/text/materials',model:'验收模型',provider:'https://provider.test/v1/chat/completions',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),status:'success',streaming:true,httpStatus:200,durationMs:2400,firstTokenMs:300,inputTokens:120,outputTokens:80,totalTokens:200,details:{username,request:{messages:[{role:'user',content:'完整 AI 输入参数'}]},output:'完整 AI 输出内容',response:'data: ...',responseStreaming:true,outputMs:1900,usage:{prompt_tokens:120,completion_tokens:80,total_tokens:200}}});
    await page.getByRole('button',{name:'AI 请求日志',exact:true}).click();await page.getByRole('textbox',{name:'搜索',exact:true}).fill(username);await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.getByRole('cell',{name:'验收模型 流式'})).toBeVisible();
    await mkdir('artifacts/admin-console',{recursive:true});await page.screenshot({path:'artifacts/admin-console/ai-requests-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'查看详情',exact:true}).click();await expect(dialog.getByText('完整 AI 输出内容',{exact:true})).toBeVisible();await expect(dialog.locator('pre').filter({hasText:'完整 AI 输入参数'})).toBeVisible();
    await page.screenshot({path:'artifacts/admin-console/ai-request-detail.png',fullPage:true});await dialog.getByRole('button',{name:'关闭弹窗'}).click();
    await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'AI 请求日志',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();await page.screenshot({path:'artifacts/admin-console/ai-requests-mobile.png',fullPage:true});
    await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'用户管理',exact:true}).click();await page.getByRole('textbox',{name:'搜索',exact:true}).fill(username);await page.getByRole('button',{name:'搜索',exact:true}).click();await expect(row).toBeVisible();await page.screenshot({path:'artifacts/admin-console/users-desktop.png',fullPage:true});
    await row.getByRole('button',{name:'删除',exact:true}).click();await dialog.getByRole('textbox').fill(username);await dialog.getByRole('button',{name:'永久删除用户及项目'}).click();await expect(dialog).not.toBeVisible();await expect(row).not.toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await database.ready();
    await database.pool.execute('DELETE FROM users WHERE username=?',[username]);await database.pool.execute('DELETE FROM ai_request_logs WHERE id=?',[logId]);await database.close();
  }
});
