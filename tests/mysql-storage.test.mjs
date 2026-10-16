import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createStorageMiddleware } from '../server/storageApi.ts';
import { readStorageConfig } from '../server/mysql/database.ts';

test('real MySQL storage: CRUD, images, revisions, isolation, validation and restart', async () => {
  const config = { ...readStorageConfig(process.env), driver: 'mysql', workspace: `test-${randomUUID()}` };
  let storage = createStorageMiddleware(config);
  let current = storage;
  const server = createServer((req, res) => { void current.middleware(req, res, () => { res.writeHead(404); res.end(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/storage/`;
  const request = async (path, method = 'GET', value, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: value ? JSON.stringify(value) : undefined });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await request('health')).status, 200);
    assert.deepEqual((await request('projects')).data, { revision: 0, initialized: false, projects: [] });
    assert.deepEqual((await request('companies')).data, { revision: 0, initialized: false, companies: [] });
    const company = { id: 'company-test', name: '测试企业', mainProducts: ['闸门', '屏幕'], updatedAt: new Date().toISOString() };
    assert.equal((await request('companies', 'PUT', { companies: [company], revision: 0 })).status, 200);
    assert.deepEqual((await request('companies')).data.companies, [company]);
    assert.equal((await request('companies', 'PUT', { companies: [], revision: 0 })).status, 409);
    assert.equal((await request('companies', 'PUT', { companies: [company, company], revision: 1 })).status, 400);
    assert.equal((await request('companies', 'PUT', { companies: [company, { ...company, id: 'other', name: ' 测试企业 ' }], revision: 1 })).status, 400);
    assert.equal((await request('companies', 'PUT', { companies: [{ ...company, mainProducts: ['屏'.repeat(101)] }], revision: 1 })).status, 400);
    assert.equal((await request('companies', 'PUT', { companies: [], revision: 1 }, { Origin: 'https://attacker.example' })).status, 403);
    const project = { id: 'test-project', name: "中文名称 ' ; DROP TABLE projects; --", category: 'utility', owner: '企业', baseProductName: '闸门', filingStatus: 'in_progress', description: '结构资料', status: 'draft', updatedAt: new Date().toISOString(), productWorkflow: { preview: 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024) } };
    assert.equal((await request('projects', 'PUT', { projects: [project], revision: 0 })).status, 200);
    const loaded = await request('projects');
    assert.equal(loaded.status, 200);
    assert.deepEqual(loaded.data.projects, [project]);
    assert.equal((await request('projects', 'PUT', { projects: [], revision: 0 })).status, 409);
    assert.equal((await request('projects', 'PUT', { projects: [project, project], revision: 1 })).status, 400);
    assert.equal((await request('projects', 'PUT', { projects: [{ ...project, category: 'invalid' }], revision: 1 })).status, 400);
    assert.equal((await request('projects', 'PUT', { projects: [{ ...project, filingStatus: 'invalid' }], revision: 1 })).status, 400);
    assert.equal((await request('projects', 'PUT', { projects: [{ ...project, baseProductName: '闸'.repeat(101) }], revision: 1 })).status, 400);
    const draft = { version: 1, profile: { company: '企业', business: '', product: '', features: '', excludedTerms: '' }, candidates: [], selectedName: '', confirmed: false };
    assert.equal((await request('naming-drafts/test-project', 'PUT', { draft, revision: 0 })).status, 200);
    assert.deepEqual((await request('naming-drafts/test-project')).data.draft, draft);
    assert.equal((await request('naming-drafts/test-project', 'PUT', { draft, revision: 0 })).status, 409);
    assert.equal((await request('naming-drafts/new', 'PUT', { draft, revision: 0 })).status, 200);
    assert.equal((await request('naming-drafts/new', 'DELETE', { revision: 1 })).status, 200);
    assert.deepEqual((await request('naming-drafts/new')).data, { draft: null, revision: 2 });
    assert.equal((await request('naming-drafts/new', 'PUT', { draft, revision: 0 })).status, 409);
    const material = { id: 'file-1', name: '技术说明.txt', size: 123, mimeType: 'text/plain', lastModified: 123456789 };
    assert.equal((await request('materials', 'PUT', { materials: [material], revision: 0 })).status, 200);
    assert.deepEqual((await request('materials')).data.materials, [material]);
    assert.equal((await request('materials', 'PUT', { materials: [{ ...material, size: -1 }], revision: 1 })).status, 400);
    assert.equal((await request('projects', 'PUT', { projects: [], revision: 1 }, { Origin: 'https://attacker.example' })).status, 403);
    await storage.close();
    storage = createStorageMiddleware(config); current = storage;
    assert.deepEqual((await request('companies')).data.companies, [company]);
    const renamedCompany = { ...company, name: '已改名企业' };
    assert.equal((await request('companies', 'PUT', { companies: [renamedCompany], revision: 1 })).status, 200);
    assert.deepEqual((await request('companies')).data.companies, [renamedCompany]);
    assert.equal((await request('companies', 'PUT', { companies: [], revision: 2 })).status, 200);
    assert.equal((await request('projects')).data.projects.length, 1);
    assert.deepEqual((await request('companies')).data, { companies: [], revision: 3, initialized: true });
    assert.equal((await request('projects')).data.projects[0].name, project.name);
    const concurrency = await Promise.all([request('projects', 'PUT', { projects: [{ ...project, name: '版本 A' }], revision: 1 }), request('projects', 'PUT', { projects: [{ ...project, name: '版本 B' }], revision: 1 })]);
    assert.deepEqual(concurrency.map(result => result.status).sort(), [200, 409]);
    assert.equal((await request('projects', 'PUT', { projects: [], revision: 2 })).status, 200);
    assert.equal((await request('naming-drafts/test-project')).data.draft, null);
    assert.equal((await request('projects')).data.initialized, true);
    assert.deepEqual((await request('projects')).data.projects, []);
    assert.equal((await request('materials', 'PUT', { materials: [], revision: 1 })).status, 200);
    const isolated = createStorageMiddleware({ ...config, workspace: `isolated-${randomUUID()}` });
    current = isolated;
    try {
      assert.deepEqual((await request('projects')).data.projects, []);
      assert.deepEqual((await request('companies')).data, { companies: [], revision: 0, initialized: false });
      await isolated.database.pool.execute('DELETE FROM workspaces WHERE id = ?', [isolated.database.workspace]);
    } finally { await isolated.close(); current = storage; }
    const broken = createStorageMiddleware({ ...config, port: 1 });
    current = broken;
    try { const result = await request('projects'); assert.equal(result.status, 503); assert.equal(result.data.error.code, 'MYSQL_UNAVAILABLE'); assert.ok(!JSON.stringify(result).includes(config.password)); }
    finally { await broken.close(); current = storage; }
  } finally {
    await storage.database.pool.execute('DELETE FROM workspaces WHERE id = ?', [config.workspace]);
    await storage.close();
    await new Promise(resolve => server.close(resolve));
  }
});
