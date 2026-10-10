// Run explicitly with `node tests/live-structure-smoke.mjs`; this calls the configured paid model.
import assert from 'node:assert/strict';

const base = process.env.STRUCTURE_TEST_URL || 'http://127.0.0.1:4173';
const evidence = [
  ['component', '拟议组成', '壳体、驱动电机、输入轴、太阳轮、行星轮、固定内齿圈、行星架和输出轴。'],
  ['relationship', '拟议连接', '电机带动输入轴；太阳轮固定在输入轴；行星轮与太阳轮及内齿圈啮合并装在行星架上；内齿圈固定于壳体，输出轴固定在行星架上。'],
  ['motion', '拟议传动', '输入轴与太阳轮同速自转，固定内齿圈使行星轮自转及公转，行星架带动输出轴回转。'],
  ['geometry', '参数化示意', '拟议直齿轮模数2mm，太阳轮20齿、行星轮20齿、内齿圈60齿；其他部件按圆柱和圆管作示意，尺寸待实物核对。'],
].map(([category, label, detail], index) => ({ id: `E0${index + 1}`, category, label, detail, technicalMeaning: detail }));
const name = '一种固定内齿圈行星减速传动机构';
const candidate = { id: 'confirmed-name', name, innovationDirection: '固定内齿圈与行星架输出的传动构造',
  solvedProblem: '通过齿轮传动降低输出转速。', coreInnovationStructure: '固定内齿圈、太阳轮、行星轮与行星架啮合传动。',
  mainComponents: ['太阳轮', '行星轮', '固定内齿圈', '行星架'], implementation: '电机驱动输入轴，固定齿圈约束行星轮，行星架输出。' };
const brief = { productName: '行星齿轮减速机构', introduction: '拟议用于机械减速传动，待实物核对。', usageScene: '动力传递。',
  existingStructure: '仅测试用拟议方案，不代表已核实的实物构造。', existingFunctions: '固定齿圈约束行星传动。', improvementType: 'structure',
  structureEvidence: { version: 1, options: evidence, selectedIds: evidence.map(item => item.id), confirmed: true },
  confirmedFacts: [
    { question: '太阳轮和行星架如何配合？', answer: '拟议太阳轮与行星轮啮合，行星轮由行星架支承；二者不是固定连接。', origin: 'model_proposal' },
    { question: '输入轮的驱动及行星架约束是什么？', answer: '拟议增加电机和输入轴驱动太阳轮，内齿圈固定在壳体上约束行星轮，行星架与输出轴固定连接。', origin: 'model_proposal' },
  ] };

async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(260000) });
  const result = await response.json();
  const requestId = response.headers.get('X-Structure-Request-Id');
  if (!response.ok) throw new Error(`${path}: ${result.error?.code || response.status} (${requestId || 'no request ID'}); categories: ${(result.error?.details || []).join('; ').slice(0, 750)}`);
  return result;
}

const result = await post('/api/utility/structure-draft', { brief, candidate, requireEvidence: true });
assert.ok(result.draft, `Model returned ${result.status || 'unknown'} instead of a draft: ${result.summary || ''}`);
const compiled = await post('/api/utility/compile-structure', result.draft);
assert.equal(compiled.success, true, `Compiler rejected model: ${(compiled.errors || []).join('; ')}`);
const model = compiled.model;
assert.equal(model.productTitle, name);
assert.equal(model.figureSpecs.length, 3);
const componentIds = new Set(model.components.map(component => component.id));
for (const view of model.figureSpecs) for (const id of view.componentIds) assert.ok(componentIds.has(id));
for (const motion of model.motions) if (motion.type !== 'static') assert.ok(componentIds.has(motion.drivenBy) && motion.drivenBy !== motion.componentId);
assert.ok(model.components.some(component => component.geometry.shape === 'spur_gear'));
assert.ok(model.components.some(component => component.geometry.shape === 'ring_gear'));
console.log(JSON.stringify({ status: 'PATENT STRUCTURE MODEL compiled', providerModel: result.providerModel,
  components: model.components.length, connections: model.connections.length, figureSpecs: model.figureSpecs.length }));
