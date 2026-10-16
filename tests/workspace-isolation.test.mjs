import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAuthMiddleware } from '../server/auth.ts';
import { createStorageMiddleware } from '../server/storageApi.ts';
import { readStorageConfig } from '../server/mysql/database.ts';
import { createAiMiddleware, readAiConfig } from '../server/drawingAi.ts';

test('real MySQL: multiple private workspaces, cross-account denial, CRUD and cascading deletion', async () => {
  const config = { ...readStorageConfig(process.env), workspace: `isolation-test-${randomUUID()}` };
  const auth = createAuthMiddleware(config, { AUTH_REQUIRED: 'true' });
  const storage = createStorageMiddleware(config);
  const ai = createAiMiddleware(readAiConfig({}));
  const server = createServer((req,res) => { void auth.middleware(req,res,() => { void storage.middleware(req,res,() => { void ai(req,res,() => { res.writeHead(200, { 'Content-Type':'application/json' }); res.end('{}'); }); }); }); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const users = [];
  const request = async (path, cookie, space, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? {Cookie:cookie} : {}), ...(space ? {'X-Workspace-Id':space} : {}), ...(body ? {'Content-Type':'application/json'} : {}), ...headers }, body:body ? JSON.stringify(body) : undefined });
    return { status:response.status, cookie:response.headers.get('set-cookie')?.split(';')[0], data:await response.json() };
  };
  try {
    for (const prefix of ['a','b']) {
      const username = `${prefix}_${randomUUID().replaceAll('-','').slice(0,20)}`;
      const registered = await request('/api/auth/register',undefined,undefined,'POST',{username,password:'Isolation-Password123!'});
      assert.equal(registered.status,201); users.push({ id:registered.data.user.id,cookie:registered.cookie,username });
    }
    const [a,b] = users;
    const spacesA = await request('/api/workspaces',a.cookie);
    const spacesB = await request('/api/workspaces',b.cookie);
    assert.equal(spacesA.data.workspaces.length,1); assert.equal(spacesB.data.workspaces.length,1);
    const first = spacesA.data.workspaces[0].id, foreign = spacesB.data.workspaces[0].id;
    assert.notEqual(first,foreign);
    const created = await request('/api/workspaces',a.cookie,undefined,'POST',{ name:'第二个空间',description:'独立研发',owner_user_id:b.id,id:foreign });
    assert.equal(created.status,201); const second = created.data.workspace.id;
    const [owner] = await auth.database.pool.execute('SELECT owner_user_id FROM workspaces WHERE id = ?',[second]);
    assert.equal(owner[0].owner_user_id,a.id);
    assert.equal((await request('/api/workspaces',a.cookie)).data.workspaces.length,2);
    assert.equal((await request('/api/workspaces',b.cookie)).data.workspaces.length,1);
    const reservation = await request('/api/generation/begin',a.cookie,first,'POST',{});
    assert.equal(reservation.status,200);
    const tokenHeader = { 'X-Generation-Token':reservation.data.token };
    assert.equal((await request('/api/generation/heartbeat',a.cookie,second,'POST',{},tokenHeader)).status,409);
    assert.equal((await request('/api/generation/heartbeat',b.cookie,foreign,'POST',{},tokenHeader)).status,409);
    assert.equal((await request('/api/generation/heartbeat',a.cookie,first,'POST',{},tokenHeader)).status,200);
    assert.equal((await request('/api/generation/end',a.cookie,first,'POST',{},tokenHeader)).status,200);
    assert.equal((await request('/api/storage/projects',a.cookie)).status,400);
    assert.equal((await request('/api/storage/projects',a.cookie,config.workspace)).status,404);
    for (const path of ['/api/storage/companies','/api/storage/projects','/api/storage/materials','/api/storage/naming-drafts/new','/api/product/review','/api/generation/begin']) {
      assert.equal((await request(path,b.cookie,first)).status,404);
    }
    for (const method of ['PATCH','DELETE']) assert.equal((await request(`/api/workspaces/${first}`,b.cookie,undefined,method,{name:'窃取',confirmName:'我的工作空间'})).status,404);
    const project = {id:'same-id',name:'A空间项目',category:'software',owner:'账号A',description:'保密内容',status:'draft',updatedAt:new Date().toISOString()};
    assert.equal((await request('/api/storage/projects',a.cookie,first,'PUT',{revision:0,projects:[project]})).status,200);
    const company = { id:'company-a', name:'A企业', mainProducts:['闸门'], updatedAt:new Date().toISOString() };
    assert.equal((await request('/api/storage/companies',a.cookie,first,'PUT',{revision:0,companies:[company]})).status,200);
    assert.deepEqual((await request('/api/storage/companies',a.cookie,second)).data.companies,[]);
    assert.deepEqual((await request('/api/storage/companies',b.cookie,foreign)).data.companies,[]);
    assert.equal((await request('/api/storage/companies',b.cookie,first,'PUT',{revision:1,companies:[]})).status,404);
    assert.deepEqual((await request('/api/storage/companies',a.cookie,first)).data.companies,[company]);
    assert.deepEqual((await request('/api/storage/projects',a.cookie,second)).data.projects,[]);
    assert.deepEqual((await request('/api/storage/projects',b.cookie,foreign)).data.projects,[]);
    const draft = {version:1,profile:{company:'A企业',business:'',product:'',features:'',excludedTerms:''},candidates:[],selectedName:'',confirmed:false};
    assert.equal((await request('/api/storage/naming-drafts/new',a.cookie,first,'PUT',{revision:0,draft})).status,200);
    assert.equal((await request('/api/storage/naming-drafts/new',a.cookie,second)).data.draft,null);
    const material = {id:'same-id',name:'A资料.txt',size:12,mimeType:'text/plain',lastModified:1};
    assert.equal((await request('/api/storage/materials',a.cookie,first,'PUT',{revision:0,materials:[material]})).status,200);
    assert.deepEqual((await request('/api/storage/materials',a.cookie,second)).data.materials,[]);
    assert.equal((await request('/api/storage/projects',b.cookie,first,'PUT',{revision:1,projects:[]})).status,404);
    assert.equal((await request('/api/storage/materials',b.cookie,first,'PUT',{revision:1,materials:[]})).status,404);
    assert.equal((await request('/api/storage/naming-drafts/new',b.cookie,first,'DELETE',{revision:1})).status,404);
    assert.deepEqual((await request('/api/storage/projects',a.cookie,first)).data.projects,[project]);
    assert.equal((await request('/api/storage/projects',a.cookie,second,'PUT',{revision:0,projects:[{...project,name:'第二空间项目'}]})).status,200);
    const renamed = await request(`/api/workspaces/${second}`,a.cookie,undefined,'PATCH',{name:'研发空间',description:'已修改'});
    assert.equal(renamed.status,200); assert.equal(renamed.data.workspace.name,'研发空间');
    assert.equal((await request(`/api/workspaces/${first}`,a.cookie,undefined,'DELETE',{confirmName:'错误名称'})).status,400);
    assert.equal((await request(`/api/workspaces/${first}`,a.cookie,undefined,'DELETE',{confirmName:'我的工作空间'})).status,200);
    for (const table of ['projects','materials','naming_drafts','company_directories']) {
      const [rows] = await auth.database.pool.execute(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`,[first]);
      assert.equal(rows[0].count,0);
    }
    assert.equal((await request('/api/storage/projects',a.cookie,first)).status,404);
    assert.equal((await request('/api/storage/projects',a.cookie,second)).data.projects[0].name,'第二空间项目');
    assert.equal((await request(`/api/workspaces/${second}`,a.cookie,undefined,'DELETE',{confirmName:'研发空间'})).status,200);
    const fallback = (await request('/api/workspaces',a.cookie)).data.workspaces;
    assert.equal(fallback.length,1); assert.notEqual(fallback[0].id,second);
    assert.deepEqual((await request('/api/storage/projects',a.cookie,fallback[0].id)).data.projects,[]);
  } finally {
    await auth.database.ready();
    for (const user of users) await auth.database.pool.execute('DELETE FROM users WHERE id = ?',[user.id]);
    await auth.database.pool.execute('DELETE FROM workspaces WHERE id = ?',[config.workspace]);
    await Promise.all([auth.close(),storage.close()]); await new Promise(resolve => server.close(resolve));
  }
});
