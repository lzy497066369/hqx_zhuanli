import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAiMiddleware } from '../server/drawingAi';
import { compileStructureDraft, bindCompiledIds } from '../src/features/utility/structureCompiler';
import { modelToComponents } from '../src/features/utility/patentStructure';
import { nextDraftComponent } from '../src/features/utility/structureDraft';
import type { StructureDraft } from '../src/features/utility/structureDraft';
import { confirmSkeleton, generateStructure, mockStructure, openNamedWorkspace, savedProject } from './fixtures/structureFlow';

// 尺寸 10 的方块按 10 的间距排列，相邻面恰好贴合：装配几何校验要求声明相连的
// 部件在几何上接触，不能存在间隙或穿插。
const geometry = (name: string, x: number) => ({ name, shape: 'box' as const, position: [x, 0, 0] as [number, number, number], size: [10, 10, 10] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] });
const component = (id: string, name: string, kind: 'base' | 'innovation' = 'base') => ({ id, name, kind, purpose: `设置${name}`, position: `主体旁${id}`, whyNeeded: `用于${name}`, geometry: geometry(name, (Number(id.slice(1)) - 1) * 10) });
const draft: StructureDraft = {
  version: 1, title: '一种具有快拆结构的轴流风机', technicalField: '风机结构技术领域', baseStructure: '壳体和支架连接，支架设置可拆罩。',
  components: [component('D01', '壳体'), component('D02', '支架'), component('D03', '快拆罩', 'innovation')],
  relationships: [
    { id: 'R01', from: 'D01', to: 'D02', relation: 'fixed_to', description: '支架固定在壳体上' },
    { id: 'R02', from: 'D02', to: 'D03', relation: 'connected_to', description: '快拆罩安装在支架上' },
  ],
  motions: [
    { id: 'M01', componentId: 'D01', type: 'static', path: '固定', purpose: '支撑' },
    { id: 'M02', componentId: 'D02', type: 'static', path: '固定', purpose: '连接' },
    { id: 'M03', componentId: 'D03', type: 'static', path: '安装位置固定', purpose: '防护' },
  ], innovationPoints: ['快拆罩通过支架连接'], problemSolved: '更换防护罩不方便', workingPrinciple: '快拆罩安装在支架上并由支架保持定位', nextDraftNumber: 4, nextModelNumber: 1,
};
const compile = (d: StructureDraft) => {
  const result = compileStructureDraft(d);
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  if (!result.success) throw new Error(result.errors.join('；'));
  return result;
};

test('离线手工草案可编译、映射保存、顺序改变后 C 编号不漂移', () => {
  const first = compile(draft);
  expect(first.mapping).toEqual({ D01: 'C01', D02: 'C02', D03: 'C03' });
  expect(first.model.components[2]).toMatchObject({ id: 'C03', sourceDraftId: 'D03' });
  const bound = bindCompiledIds(draft, first.mapping);
  expect(compile({ ...bound, components: [...bound.components].reverse() }).mapping).toEqual(first.mapping);
  expect(compile({ ...draft, components: [...draft.components].reverse() }).mapping).toEqual(first.mapping);
  expect(compile({ ...bound, components: bound.components.map(c => c.id === 'D03' ? { ...c, name: '新快拆罩' } : c) }).mapping.D03).toBe('C03');
});

test('删除中间部件不回收 ID，新部件使用 C04；再次编译仍稳定', () => {
  const bound = bindCompiledIds(draft, compile(draft).mapping);
  const withoutMiddle = { ...bound, components: bound.components.filter(c => c.id !== 'D02'), relationships: [{ id: 'R03', from: 'D01', to: 'D03', relation: 'connected_to' as const, description: '快拆罩直接与壳体连接' }], motions: bound.motions.filter(m => m.componentId !== 'D02') };
  expect(compile(withoutMiddle).mapping).toEqual({ D01: 'C01', D03: 'C03' });
  const { id, nextDraftNumber } = nextDraftComponent(withoutMiddle);
  expect(id).toBe('D04');
  const added: StructureDraft = { ...withoutMiddle, nextDraftNumber, components: [...withoutMiddle.components, component(id, '新卡扣')], relationships: [...withoutMiddle.relationships, { id: 'R04', from: 'D03', to: id, relation: 'fixed_to', description: '卡扣固定在罩上' }], motions: [...withoutMiddle.motions, { id: 'M04', componentId: id, type: 'static', path: '固定', purpose: '限位' }] };
  expect(compile(added).mapping).toEqual({ D01: 'C01', D03: 'C03', D04: 'C04' });
});

test('较高历史编号与多个新部件同时编译时按 DID 分配，不依赖数组顺序', () => {
  const base = bindCompiledIds(draft, compile(draft).mapping);
  // D03 占 x 20–30、y -5–5；两个新部件都声明与 D03 相连，故各贴其一侧面。
  const extra = [
    { ...component('D04', '新卡扣'), geometry: { ...geometry('新卡扣', 20), position: [20, -10, 0] as [number, number, number] } },
    { ...component('D05', '新搭扣'), geometry: { ...geometry('新搭扣', 20), position: [20, 10, 0] as [number, number, number] } },
  ];
  const extended: StructureDraft = { ...base, nextDraftNumber: 6, nextModelNumber: 10,
    components: [...base.components, ...extra],
    relationships: [...base.relationships,
      { id: 'R03', from: 'D03', to: 'D04', relation: 'fixed_to', description: '卡扣安装在罩上' },
      { id: 'R04', from: 'D03', to: 'D05', relation: 'fixed_to', description: '搭扣安装在罩上' }],
    motions: [...base.motions,
      { id: 'M04', componentId: 'D04', type: 'static', path: '罩上', purpose: '锁止' },
      { id: 'M05', componentId: 'D05', type: 'static', path: '罩上', purpose: '锁止' }],
  };
  const mapping = compile(extended).mapping;
  expect(mapping).toEqual({ D01: 'C01', D02: 'C02', D03: 'C03', D04: 'C10', D05: 'C11' });
  expect(compile({ ...extended, components: [...extended.components].reverse() }).mapping).toEqual(mapping);
});

test('正式附图编号独立于内部 C 编号，支持标准文案中的 201、206、210', () => {
  const numbered = {
    ...draft,
    components: draft.components.map((item, index) => ({ ...item, referenceNo: ['201', '206', '210'][index] })),
  };
  const result = compile(numbered);
  expect(result.model.components.map(component => ({ id: component.id, referenceNo: component.referenceNo }))).toEqual([
    { id: 'C01', referenceNo: '201' },
    { id: 'C02', referenceNo: '206' },
    { id: 'C03', referenceNo: '210' },
  ]);
  expect(modelToComponents(result.model).map(component => component.referenceNo)).toEqual(['201', '206', '210']);
});

test('未填写正式附图编号时按部件顺序生成数字编号，重复编号直接拒绝', () => {
  expect(compile(draft).model.components.map(component => component.referenceNo)).toEqual(['1', '2', '3']);
  const duplicate = { ...draft, components: draft.components.map(component => ({ ...component, referenceNo: '206' })) };
  const result = compileStructureDraft(duplicate);
  expect(result.success).toBe(false);
  expect(result.errors.join('；')).toContain('附图标号 206 与其他部件重复');
});

test('无效连接和无效运动返回明确错误；不猜缺失关系', () => {
  expect(compileStructureDraft({ ...draft, relationships: [{ ...draft.relationships[0], to: 'D99' }, draft.relationships[1]] }).errors.join()).toContain('R01 连接端点 D01 → D99 无效');
  expect(compileStructureDraft({ ...draft, motions: draft.motions.map(m => m.id === 'M03' ? { ...m, type: 'rotary', drivenBy: 'D99' } : m) }).errors.join()).toContain('M03 驱动部件 D99 不存在');
  expect(compileStructureDraft({ ...draft, motions: [] }).errors.join()).toContain('D01 缺少运动或静止关系');
  expect(compileStructureDraft({ ...draft, components: draft.components.map(c => c.id === 'D03' ? { ...c, geometry: undefined } : c) }).errors.join()).toContain('D03 缺少有效的示意几何');
});

test('装配几何对所有产品生效；推断出的占位几何豁免接触校验', () => {
  // 本条草案标题不是 H 型钢：装配几何校验不能只在 H 型钢路径上跑。
  const far = compileStructureDraft({ ...draft, components: draft.components.map(c => c.id === 'D02'
    ? { ...c, geometry: { ...c.geometry!, position: [500, 0, 0] } } : c) });
  expect(far.success).toBe(false);
  expect(far.errors.join('；')).toContain('声明相连');
  // 人工或模型提供的几何必须照常受检，不能被豁免。
  const penetrating = compileStructureDraft({ ...draft, components: draft.components.map(c => c.id === 'D02'
    ? { ...c, geometry: { ...c.geometry!, position: [0, 0, 0] } } : c) });
  expect(penetrating.success).toBe(false);
  // 归一化器按名称推断出的占位几何（缺几何的旧草案）不代表真实装配位置，
  // 必须豁免，否则这些记录会永久无法编译。
  const inferred = compileStructureDraft({ ...draft, components: draft.components.map(c => c.id === 'D02'
    ? { ...c, geometry: { ...c.geometry!, position: [500, 0, 0] }, inferredGeometry: true } : c) });
  expect(inferred.success, JSON.stringify(inferred.errors)).toBe(true);
});

test('编译 API 在 AI 配置失效、网络完全断开时仍可用，且不调用 AI', async () => {
  let upstreamCalls = 0;
  const middleware = createAiMiddleware({ baseUrl: 'https://unavailable.invalid/v1', apiKey: '', model: '' }, async () => { upstreamCalls++; throw new Error('offline'); });
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/utility/compile-structure`;
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
    expect(response.status).toBe(200);
    expect((await response.json()).mapping.D03).toBe('C03');
    const legacy = { ...draft, components: draft.components.map(c => c.id === 'D02' ? { ...c, geometry: undefined } : c), motions: draft.motions.filter(m => m.componentId === 'D03') };
    const repaired = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(legacy) });
    const repairedBody = await repaired.json();
    expect(repairedBody.success, JSON.stringify(repairedBody.errors)).toBe(true);
    expect(repairedBody.normalizedDraft.components.every((c: StructureDraft['components'][number]) => c.geometry)).toBe(true);
    expect(repairedBody.normalizedDraft.motions.map((m: StructureDraft['motions'][number]) => m.componentId)).toEqual(['D01', 'D02', 'D03']);
    expect(repairedBody.normalizedDraft.components[2].modelId).toBeUndefined();
    const invalid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, relationships: [] }) });
    const invalidBody = await invalid.json();
    expect(invalidBody.success).toBe(false);
    expect(invalidBody.code).toBe('STRUCTURE_VALIDATION_FAILED');
    expect(invalidBody.category).toBe('relationship');
    expect(invalidBody.errors).toContain('连接关系不足，结构必须整体连通。');
    expect(invalidBody.errors).not.toContain('至少需要一个部件');
    expect(upstreamCalls).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(done)); }
});

test('失败草案不覆盖已确认模型；旧模型与文案/附图引用保持不变', () => {
  const previous = compile(draft).model;
  const saved = { structureDraft: bindCompiledIds(draft, { D01: 'C01', D02: 'C02', D03: 'C03' }), patentStructureModel: previous, utilityMaterials: { claims: '既有权利要求' }, design: { structureModel: previous } };
  const editing = { ...saved, structureDraft: { ...saved.structureDraft, components: saved.structureDraft.components.map(c => c.id === 'D03' ? { ...c, name: '待确认罩' } : c) } };
  expect(editing.patentStructureModel).toBe(previous);
  const failed = compileStructureDraft({ ...editing.structureDraft, relationships: [] });
  expect(failed.success).toBe(false);
  expect(editing.patentStructureModel).toBe(previous);
  expect(editing.utilityMaterials.claims).toBe('既有权利要求');
  expect(editing.design.structureModel).toBe(previous);
});

test('验收：AI 失败保留旧模型和文案，重试成功才替换', async ({ page }) => {
  await mockStructure(page);
  const title = await openNamedWorkspace(page);
  await generateStructure(page);
  const before = await savedProject(page, title);
  await page.unroute('**/api/utility/structure-skeleton');
  await page.route('**/api/utility/structure-skeleton', route => route.fulfill({ status: 503, json: { error: { message: 'AI offline' } } }));
  await page.getByRole('button', { name: '按名称重新生成结构' }).click();
  await expect(page.getByTestId('patent-structure-flow').getByRole('alert')).toContainText('结构自动生成失败');
  await expect(page.getByTestId('patent-structure-flow').getByRole('alert')).not.toContainText('AI offline');
  const after = await savedProject(page, title);
  expect(after.utilityDrawing.patentStructureModel).toEqual(before.utilityDrawing.patentStructureModel);
  expect(after.utilityDrawing.design).toEqual(before.utilityDrawing.design);
  expect(after.utilityMaterials).toEqual(before.utilityMaterials);
  await page.unroute('**/api/utility/structure-skeleton');
  await mockStructure(page);
  await page.getByRole('button', { name: '按名称重新生成结构' }).click();
  await confirmSkeleton(page);
  await expect(page.getByTestId('patent-structure-flow').getByRole('alert')).toHaveCount(0);
  await expect(page.locator('[data-structure-model="determined"]')).toBeVisible();
});
