import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAuthMiddleware } from '../server/auth.ts';
import { readStorageConfig } from '../server/mysql/database.ts';
import { auditedFetch } from '../server/aiAudit.ts';
import { readChatChoice } from '../server/aiSupport.ts';

// Use a separately provisioned test database; never migrate the running application's database.
const testDatabase = process.env.ADMIN_TEST_DATABASE || 'zhichuang_admin_test';
if (!/^zhichuang_admin_test[a-z0-9_]*$/.test(testDatabase)) throw new Error('ADMIN_TEST_DATABASE must be an isolated zhichuang_admin_test* database');

test('real MySQL admin: bootstrap, roles, CRUD, disabled sessions, project details and durable AI audit', async () => {
  const config = { ...readStorageConfig(process.env), database:testDatabase,workspace:`admin-test-${randomUUID()}` };
  let auth = createAuthMiddleware(config,{ AUTH_REQUIRED:'true' }), current = auth;
  const fetcher = auditedFetch(async () => new Response('data: {"choices":[{"delta":{"content":"audit output"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}));
  const server = createServer((req,res) => { void current.middleware(req,res,() => { void (async () => {
    if (req.url === '/api/test/ai') await readChatChoice(await fetcher('https://audit.test/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'admin-test-model',stream:true,messages:[{role:'user',content:'audit input'}]})}));
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
  })().catch(error=>{res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}); }); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path,method='GET',data,cookie,headers={}) => { const response = await fetch(base+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:data?JSON.stringify(data):undefined});return {status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],data:await response.json()}; };
  const suffix = randomUUID().replaceAll('-','').slice(0,12), username = `admin_test_${suffix}`, password = 'Test-Password-890!';
  let createdId, cookie;
  try {
    assert.equal((await request('/api/admin/users')).status,401);
    const login = await request('/api/auth/login','POST',{username:'admin',password:'admin123'}); assert.equal(login.status,200); assert.equal(login.data.user.role,'admin'); cookie=login.cookie;
    assert.equal((await request('/api/admin/users','GET',undefined,cookie,{Origin:'https://evil.test'})).status,403);
    const created = await request('/api/admin/users','POST',{username,password,displayName:'审计测试用户'},cookie); assert.equal(created.status,201); createdId=created.data.id;
    const ordinary = await request('/api/auth/login','POST',{username,password}); assert.equal(ordinary.status,200); assert.equal(ordinary.data.user.role,'user');
    for (const path of ['/api/admin/users','/api/admin/projects','/api/admin/ai-requests']) assert.equal((await request(path,'GET',undefined,ordinary.cookie)).status,403);
    const spaces = await request(`/api/admin/workspaces?userId=${createdId}`,'GET',undefined,cookie); assert.equal(spaces.status,200); assert.equal(spaces.data.items.length,1);
    const workspaceId = spaces.data.items[0].id, projectId = randomUUID();
    const project = {id:projectId,name:'管理员可见的测试项目',category:'utility',owner:'测试申请人',description:'完整项目资料',status:'draft',updatedAt:new Date().toISOString(),productWorkflow:{document:{claims:'完整权利要求文本'},previewImages:[{dataUrl:'data:image/png;base64,aGVsbG8='}]}};
    await auth.database.pool.execute('INSERT INTO projects (workspace_id,id,name,category,owner,description,status,position,data) VALUES (?,?,?,?,?,?,?,?,?)',[workspaceId,projectId,project.name,project.category,project.owner,project.description,project.status,0,JSON.stringify(project)]);
    const list = await request(`/api/admin/projects?userId=${createdId}`,'GET',undefined,cookie); assert.equal(list.status,200); assert.equal(list.data.total,1); assert.equal(list.data.items[0].username,username); assert.equal(list.data.items[0].data,undefined);
    const detailPath = `/api/admin/project?workspaceId=${workspaceId}&id=${projectId}`;
    assert.deepEqual((await request(detailPath,'GET',undefined,cookie)).data.data,project);
    assert.equal((await request(detailPath,'GET',undefined,ordinary.cookie)).status,403);
    assert.equal((await request('/api/test/ai','POST',{},ordinary.cookie,{'X-Workspace-Id':workspaceId})).status,200);
    const logs = await request(`/api/admin/ai-requests?userId=${createdId}&status=success&streaming=true`,'GET',undefined,cookie);
    assert.equal(logs.data.total,1); assert.equal(logs.data.summary.tokens,10); assert.equal(logs.data.items[0].details,undefined);
    const log = await request(`/api/admin/ai-requests/${logs.data.items[0].id}`,'GET',undefined,cookie);
    assert.equal(log.data.details.request.messages[0].content,'audit input'); assert.equal(log.data.details.output,'audit output'); assert.equal(log.data.inputTokens,8);
    assert.equal((await request('/api/admin/ai-requests?pageSize=1%20OR%201=1','GET',undefined,cookie)).status,400);
    assert.equal((await request(`/api/admin/users/${createdId}`,'PATCH',{username,displayName:'已禁用',role:'user',disabled:true},cookie)).status,200);
    assert.equal((await request('/api/auth/me','GET',undefined,ordinary.cookie)).data.user,null);
    assert.equal((await request('/api/auth/login','POST',{username,password})).status,403);
    assert.equal((await request(`/api/admin/users/${createdId}`,'PATCH',{username,displayName:'重新启用',role:'user',disabled:false,password:'New-Password-890!'},cookie)).status,200);
    assert.equal((await request('/api/auth/login','POST',{username,password})).status,401);
    assert.equal((await request('/api/auth/login','POST',{username,password:'New-Password-890!'})).status,200);
    assert.equal((await request(`/api/admin/users/${login.data.user.id}`,'DELETE',{confirmUsername:'admin'},cookie)).status,400);
    assert.equal((await request(`/api/admin/users/${login.data.user.id}`,'PATCH',{username:'admin',displayName:'管理员',role:'user'},cookie)).status,400);
    assert.equal((await request(`/api/admin/users/${createdId}`,'DELETE',{confirmUsername:'wrong'},cookie)).status,400);
    await auth.close(); auth=createAuthMiddleware(config,{AUTH_REQUIRED:'true'});current=auth;
    assert.equal((await request(`/api/admin/ai-requests/${log.data.id}`,'GET',undefined,cookie)).status,200);
    const [admins] = await auth.database.pool.execute("SELECT COUNT(*) count FROM users WHERE role='admin'"); assert.equal(Number(admins[0].count),1);
    assert.equal((await request(`/api/admin/users/${createdId}`,'DELETE',{confirmUsername:username},cookie)).status,200);createdId=undefined;
    assert.equal((await request(detailPath,'GET',undefined,cookie)).status,404);
    assert.equal((await request(`/api/admin/ai-requests/${log.data.id}`,'GET',undefined,cookie)).status,200);
  } finally {
    if(createdId) await auth.database.pool.execute('DELETE FROM users WHERE id=?',[createdId]);
    await auth.database.pool.execute('DELETE FROM ai_request_logs WHERE model=?',['admin-test-model']);
    await auth.database.pool.execute('DELETE FROM workspaces WHERE id=?',[config.workspace]);
    await auth.close();await new Promise(resolve=>server.close(resolve));
  }
});

test('admin routes remain closed when global authentication is disabled',async()=>{
  const auth=createAuthMiddleware(readStorageConfig(process.env),{AUTH_REQUIRED:'false'});
  const server=createServer((req,res)=>{void auth.middleware(req,res,()=>{res.writeHead(200);res.end('{}');});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/users`);assert.equal(response.status,403);}finally{await auth.close();await new Promise(resolve=>server.close(resolve));}
});
