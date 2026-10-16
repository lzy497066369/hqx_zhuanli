import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { readCompletion, callJSON } from '../ai.mjs';
import { checkPlan, checkDocument, formatDocument, applyPatches } from '../pipeline.mjs';
import { createApp } from '../server.mjs';
import { planForWriting, documentForWriting } from '../structure.mjs';
import { boxPlan, boxDocument } from './fixtures.mjs';

const plan = {
  title: '一种便于更换止水条的闸门', scenario: '小型渠道', problem: '止水条更换不便', goal: '便于更换', assumptions: ['采用手动启闭'], verificationNeeds: ['验证密封压紧量'],
  parts: [
    { id: '1', name: '门架', role: '固定支承', position: '过水口周围', motion: '固定' },
    { id: '2', name: '门叶', role: '挡水', position: '门架内', motion: '沿竖向移动' },
    { id: '3', name: '止水条', role: '止水', position: '门叶底部', motion: '随门叶运动' },
    { id: '4', name: '压板', role: '固定止水条', position: '门叶底部迎水侧', motion: '随门叶运动' },
  ],
  connections: [
    { from: '1', to: '2', type: '滑动配合', detail: '门架两侧导槽导向门叶' },
    { from: '2', to: '3', type: '接触', detail: '止水条安装部贴合门叶' },
    { from: '2', to: '4', type: '可拆卸连接', detail: '压板通过螺栓连接门叶' },
    { from: '3', to: '4', type: '压持', detail: '压板夹持止水条安装部' },
  ],
  workingSteps: [{ step: '门叶沿门架升降', partIds: ['1', '2'] }, { step: '拆卸压板后取出止水条', partIds: ['3', '4'] }],
  improvements: [{ partIds: ['3', '4'], mechanism: '压板可拆卸', effect: '止水条可更换' }],
};
const document = {
  title: plan.title, abstract: '一种便于更换止水条的闸门，包括门架、门叶、止水条和可拆卸压板，拆卸压板后能够取下止水条。',
  claims: [
    { number: 1, dependsOn: null, text: '一种闸门，包括门架（1）、门叶（2）、止水条（3）和压板（4），压板（4）可拆卸地连接门叶（2）并夹持止水条（3）。', partIds: ['1', '2', '3', '4'] },
    { number: 2, dependsOn: 1, text: '根据权利要求1所述的闸门，其特征在于：所述止水条（3）位于门叶（2）的底部。', partIds: ['2', '3'] },
  ], technicalField: '本实用新型涉及水工闸门技术领域。', background: '止水条安装空间受限时，更换操作较为不便。', technicalProblem: '解决止水条更换不便的问题。', solution: '压板（4）可拆卸地连接门叶（2）。', benefits: ['拆下压板后能够取下止水条。'], embodiment: '门叶（2）沿门架（1）的导槽滑动，止水条（3）的安装部由压板（4）夹持。', operation: '门叶升起至检修位置，卸下压板后沿迎水方向取下止水条。',
};
const problems = { scenario: '小型渠道', problems: ['更换止水条', '防止松动', '减少偏斜'].map((title, i) => ({ id: `p${i + 1}`, title, problem: title, goal: `改善${title}`, approach: '通过可拆连接结构改进' })) };
const config = { providers: [{ baseUrl: 'https://model.invalid/v1', apiKey: 'TEST_ONLY_SECRET', model: 'test-model' }], timeoutMs: 10000 };
const review = () => ({ partEdits: [], patches: [], findings: [{ location: '连接关系', issue: '明确配合', resolution: '已核对配合描述' }], unresolved: [] });
const completion = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });

async function waitFor(get, condition) {
  for (let i = 0; i < 100; i++) { const result = await get(); if (condition(result)) return result; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Timed out waiting for test job');
}
async function setup(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'patent-text-test-'));
  const app = createApp(config, { dataDir, ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    for (const c of app.controllers.values()) c.abort();
    await new Promise(resolve => app.server.close(resolve));
    // dataDir is the exact isolated directory returned by mkdtempSync above.
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { ...app, base, dataDir };
}

test('SSE handles split UTF-8 and refuses interrupted or truncated completions', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"闸门结构"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
  assert.equal(await readCompletion(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })), '闸门结构');
  await assert.rejects(readCompletion(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })), /提前断开/);
  await assert.rejects(readCompletion(new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }))), /截断/);
});

test('structure checks catch disconnected or unknown parts; text checks catch unsupported references', () => {
  assert.deepEqual(checkPlan(plan), []);
  assert.deepEqual(checkDocument(document, plan), []);
  const disconnected = structuredClone(plan);
  disconnected.connections = disconnected.connections.filter(c => c.from !== '4' && c.to !== '4');
  assert(checkPlan(disconnected).some(e => e.includes('接入整机')));
  const bad = structuredClone(document);
  bad.abstract = '字'.repeat(301); bad.claims[1].dependsOn = 2; bad.embodiment += '如图1所示，锁销（99）。';
  const errors = checkDocument(bad, plan);
  assert(errors.some(e => e.includes('300')));
  assert(errors.some(e => e.includes('引用关系')));
  assert(errors.some(e => e.includes('附图')));
  assert(errors.some(e => e.includes('99')));
});

test('local features connect through ownership without invented assembly joints', () => {
  assert.deepEqual(checkPlan(boxPlan), []);
  assert.deepEqual(checkDocument(boxDocument, boxPlan), []);
  const missing = structuredClone(boxPlan);
  missing.parts[1].parentId = null;
  assert(checkPlan(missing).some(e => e.includes('所属部件')));
  const cyclic = structuredClone(boxPlan);
  cyclic.parts[0].parentId = '2';
  assert(checkPlan(cyclic).some(e => e.includes('循环')));
  const fewer = structuredClone(boxPlan);
  fewer.parts = fewer.parts.slice(0, 2);
  fewer.connections = [];
  fewer.focus.corePartIds = ['1', '2'];
  for (const key of ['workingSteps', 'improvements', 'coreActions']) for (const item of fewer[key]) item.partIds = ['1', '2'];
  for (const group of ['independent', 'dependent', 'embodimentOnly']) for (const item of fewer.claimPlan[group]) item.partIds = ['1', '2'];
  assert.deepEqual(checkPlan(fewer), [], 'A simple two-feature model should not need artificial parts');
});

test('core action and protection data require valid structure references', () => {
  const incomplete = structuredClone(boxPlan);
  incomplete.coreActions[0].constraint = '';
  incomplete.claimPlan.independent[0].partIds = ['99'];
  const errors = checkPlan(incomplete);
  assert(errors.some(e => e.includes('核心动作')));
  assert(errors.some(e => e.includes('independent')));
});

test('writing inputs and exports separate design records without deleting technical facts', () => {
  const p = structuredClone(boxPlan);
  p.parts[0].position = '盒体侧壁具有20度的设计倾角';
  p.parts[0].privateNote = '不要输出这条设计记录';
  const writing = planForWriting(p);
  const serialized = JSON.stringify(writing);
  assert(!serialized.includes('设计记录专用标记'));
  assert(!serialized.includes('verificationNeeds'));
  assert(!serialized.includes('privateNote'));
  assert(!Object.hasOwn(writing.claimPlan.independent[0], 'reason'));
  assert(serialized.includes('20度'));
  assert.deepEqual(writing.coreActions, p.coreActions);
  const d = documentForWriting({ ...boxDocument, assumptions: ['设计记录'], verificationNeeds: ['验证任务'] });
  assert(!Object.hasOwn(d, 'assumptions'));
  assert.equal(formatDocument(d), formatDocument(boxDocument));
});

test('review patches are validated and cannot modify prototypes or missing paths', () => {
  const updated = applyPatches(plan, [{ op: 'replace', path: '/parts/0/position', value: '渠道过水口周围' }]);
  assert.equal(updated.parts[0].position, '渠道过水口周围');
  assert.equal(plan.parts[0].position, '过水口周围');
  assert.throws(() => applyPatches(plan, [{ op: 'add', path: '/parts/__proto__/polluted', value: true }]));
  assert.throws(() => applyPatches(plan, [{ op: 'replace', path: '/parts/99/name', value: '未知' }]));
});

test('provider fallback never exposes upstream credentials in error messages', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return attempts === 1 ? new Response('SECRET_UPSTREAM_BODY', { status: 401 }) : completion({ ok: true }); };
  const result = await callJSON({ ...config, providers: [...config.providers, { ...config.providers[0], model: 'fallback' }] }, { system: 'test', input: {} });
  assert.equal(result.model, 'fallback'); assert.equal(attempts, 2);
  globalThis.fetch = async () => new Response('SECRET_UPSTREAM_BODY', { status: 401 });
  await assert.rejects(callJSON(config, { system: 'test', input: {} }), error => !error.message.includes('SECRET') && error.message.includes('授权'));
});

test('full API workflow persists results, downloads text, rejects forged choices and protects secrets', async t => {
  const original = globalThis.fetch;
  const sequence = [problems, boxPlan, review(), { ...boxDocument, assumptions: ['多余设计记录'] }, review()];
  const inputs = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://model.invalid')) return original(url, options);
    inputs.push(JSON.parse(JSON.parse(options.body).messages[1].content));
    return completion(sequence.shift());
  };
  const { base } = await setup(t);
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const status = await (await fetch(base + '/api/status')).text();
  assert(!status.includes('TEST_ONLY_SECRET'));
  assert.equal((await fetch(base + '/.env.local')).status, 404);
  assert.equal((await post('/api/problems', { product: '' })).status, 400);
  assert.equal((await fetch(base + '/api/jobs', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' }, body: '{}' })).status, 403);
  assert.equal((await post('/api/jobs', { proposalId: 'forged', problemId: 'p1' })).status, 400);
  const proposal = await (await post('/api/problems', { product: '闸门' })).json();
  const created = await (await post('/api/jobs', { proposalId: proposal.id, problemId: 'p1' })).json();
  const job = await waitFor(async () => (await fetch(`${base}/api/jobs/${created.id}`)).json(), j => j.status !== 'running');
  assert.equal(job.status, 'completed', job.error);
  assert.equal(sequence.length, 0);
  assert.equal(job.document.title, boxPlan.title);
  assert.equal(job.plan.connections.length, boxPlan.connections.length);
  assert.equal(job.text, formatDocument(boxDocument));
  assert.deepEqual(job.plan.assumptions, boxPlan.assumptions);
  for (const input of inputs.slice(3)) {
    assert(!Object.hasOwn(input.plan, 'assumptions'));
    assert(!Object.hasOwn(input.plan, 'verificationNeeds'));
  }
  assert(!Object.hasOwn(inputs[4].document, 'assumptions'));
  assert(!Object.hasOwn(job.document, 'assumptions'));
  const download = await fetch(`${base}/api/jobs/${created.id}/download`);
  assert.equal(download.status, 200);
  assert(download.headers.get('content-disposition').includes('attachment'));
  assert((await download.text()).includes('具体实施方式'));
  const history = await (await fetch(`${base}/api/jobs`)).json();
  assert.equal(history.jobs[0].id, created.id);
});

test('cancel and retry reuse saved intermediate structure', async t => {
  let calls = 0;
  const app = await setup(t, { problemGenerator: async () => problems, pipeline: async (_config, job, signal, update) => {
    calls++;
    if (calls === 1) {
      job.initialPlan = structuredClone(plan); update('结构已保存');
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    } else {
      assert.equal(job.initialPlan.title, plan.title);
      job.plan = job.initialPlan; job.document = document; job.status = 'completed'; job.stage = 'done'; update('继续完成');
    }
  } });
  const post = async (path, body) => (await fetch(app.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const proposal = await post('/api/problems', { product: '闸门' });
  const { id } = await post('/api/jobs', { proposalId: proposal.id, problemId: 'p1' });
  const get = async () => (await fetch(`${app.base}/api/jobs/${id}`)).json();
  await waitFor(get, job => !!job.initialPlan);
  await post(`/api/jobs/${id}/cancel`, {});
  await waitFor(get, job => job.status === 'cancelled');
  await post(`/api/jobs/${id}/retry`, {});
  const job = await waitFor(get, job => job.status === 'completed');
  assert.equal(job.document.title, plan.title); assert.equal(calls, 2);
});
