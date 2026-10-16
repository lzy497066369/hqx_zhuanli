import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStructureReview, checkPlan, runPipeline } from '../pipeline.mjs';
import { boxPlan, boxDocument } from './fixtures.mjs';

const review = (partEdits = [], patches = []) => ({ partEdits, patches, findings: [], unresolved: [] });
const update = (partId, partName, changes) => ({ op: 'update', partId, partName, changes });

test('regression: six observed one-row shifts target the intended IDs, not their neighbours', () => {
  const cases = [
    { names: ['底座', '固定钳口', '活动钳口', '驱动丝杆', '铰接半螺母', '偏心操作手柄', '抬升扭簧'], edits: [
      update('1', '底座', { position: '后端设置可拆丝杆支承座' }),
      update('5', '铰接半螺母', { position: '非铰接侧具有弹性承压舌' }),
    ] },
    { names: ['底座', '纵向燕尾导轨', '固定钳口', '活动钳口', '夹紧丝杆', '铰接半螺母', '偏心手柄', '抬升扭簧'], edits: [
      update('6', '铰接半螺母', { position: '铰轴位于内螺纹后方' }),
      update('7', '偏心手柄', { position: '凸轮轴安装于弹性压板上方' }),
    ] },
    { names: ['闸框', '闸板', '斜面刮砂块', '排砂缺口', '槽底承砂面', '密封条', '启闭螺杆'], edits: [
      update('6', '密封条', { position: '连续设置于两侧立柱及底横梁的密封座面' }),
    ] },
    { names: ['闸框', '矩形闸板', '手轮螺杆驱动组件'], edits: [
      update('1', '闸框', { role: '支承闸板、驱动组件及密封条' }),
    ] },
  ];
  for (const fixture of cases) {
    const source = { parts: fixture.names.map((name, i) => ({ id: String(i + 1), name, position: `原位置${i}`, role: `原作用${i}` })) };
    const before = structuredClone(source);
    const result = applyStructureReview(source, review(fixture.edits));
    for (const p of source.parts) {
      const edit = fixture.edits.find(e => e.partId === p.id);
      assert.deepEqual(result.parts.find(v => v.id === p.id), { ...p, ...(edit?.changes || {}) });
    }
    assert.deepEqual(source, before);
    // Same IDs in a different order still receive exactly the same edits.
    const reversed = { parts: [...source.parts].reverse() };
    const reordered = applyStructureReview(reversed, review(fixture.edits));
    for (const edit of fixture.edits) assert.deepEqual(reordered.parts.find(p => p.id === edit.partId), result.parts.find(p => p.id === edit.partId));
  }
});

test('old numeric paths and whole-table replacement cannot bypass identity checks', () => {
  for (const patch of [
    { op: 'replace', path: '/parts/2/position', value: '错误位置' },
    { op: 'replace', path: '/parts', value: [] },
    { op: 'add', path: '/parts/-', value: { id: '5' } },
    { op: 'remove', path: '/parts/0' },
  ]) assert.throws(() => applyStructureReview(boxPlan, review([], [patch])), /禁止.*parts/);
});

test('identity mismatch rejects the entire review without partial mutation', () => {
  const before = structuredClone(boxPlan);
  assert.throws(() => applyStructureReview(boxPlan, review([
    update('1', '盒体', { position: '已改位置' }),
    update('2', '导气槽', { position: '该内容属于3号部件' }),
  ])), /名称.*不符/);
  assert.deepEqual(boxPlan, before);
  assert.throws(() => applyStructureReview(boxPlan, review([update('99', '未知', { role: '作用' })])), /未找到/);
  assert.throws(() => applyStructureReview(boxPlan, review([update('2', '进气口', { id: '8' })])), /不得修改编号/);
  assert.throws(() => applyStructureReview(boxPlan, review([update('2', '进气口', JSON.parse('{"__proto__":{"polluted":true}}'))])), /changes/);
});

test('add/remove preserves IDs and later edits do not depend on changing array positions', () => {
  const result = applyStructureReview(boxPlan, review([
    { op: 'remove', partId: '2', partName: '进气口' },
    update('3', '导气槽', { position: '新位置' }),
    { op: 'add', partId: '5', partName: '支脚', value: { ...boxPlan.parts[0], id: '5', name: '支脚' } },
  ]));
  assert.deepEqual(result.parts.map(p => p.id), ['1', '3', '4', '5']);
  assert.equal(result.parts.find(p => p.id === '3').position, '新位置');
  assert.deepEqual(result.parts.find(p => p.id === '4'), boxPlan.parts[3]);
  assert(checkPlan(result).some(e => /引用|连接/.test(e)), 'Dangling references still go through the existing validator');
  assert(!checkPlan(result).some(e => /连续|编号应/.test(e)), 'Unchanged IDs may have gaps');
  assert.throws(() => applyStructureReview(boxPlan, review([{ op: 'add', partId: '2', partName: '压板', value: { id: '2', name: '压板' } }])), /已存在/);
  assert.throws(() => applyStructureReview(boxPlan, review([{ op: 'add', partId: '5', partName: '支脚', value: { id: '6', name: '支脚' } }])), /必须.*一致/);
  assert.throws(() => applyStructureReview(boxPlan, review([update('2', '进气口', { role: '一' }), update('2', '进气口', { motion: '二' })])), /重复修改/);
});

test('pipeline requests a correction for an old index patch and only passes identity-resolved edits to the writer', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const changedPosition = '贯通盒体侧壁底部并朝向侧方';
  const responses = [
    { ...review(), patches: [{ op: 'replace', path: '/parts/2/position', value: changedPosition }] },
    review([update('2', '进气口', { position: changedPosition })]),
    boxDocument,
    { patches: [], findings: [], unresolved: [] },
  ];
  const inputs = [];
  globalThis.fetch = async (_url, options) => {
    inputs.push(JSON.parse(JSON.parse(options.body).messages[1].content));
    const value = responses.shift();
    assert(value, 'Unexpected extra model call');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const job = { product: '收纳盒', scenario: boxPlan.scenario, problem: { title: boxPlan.problem }, initialPlan: structuredClone(boxPlan), events: [] };
  const events = [];
  await runPipeline({ providers: [{ baseUrl: 'https://identity-test.invalid/v1', apiKey: 'test-only', model: 'test' }], timeoutMs: 1000 }, job, new AbortController().signal, message => { if (message) events.push(message); });
  assert.equal(job.status, 'completed');
  assert.equal(responses.length, 0);
  assert(inputs[1].correction.errors.some(e => e.includes('partId')));
  assert.equal(inputs[2].plan.parts.find(p => p.id === '2').position, changedPosition);
  assert.equal(inputs[2].plan.parts.find(p => p.id === '3').position, boxPlan.parts[2].position);
  assert.equal(job.structureReview.partEdits[0].partId, '2');
  assert.equal(events.filter(e => e.startsWith('自动修正')).length, 1);
});
