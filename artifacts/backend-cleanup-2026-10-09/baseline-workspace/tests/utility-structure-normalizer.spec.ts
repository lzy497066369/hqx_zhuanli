import { expect, test } from '@playwright/test';
import { normalizeStructureDraft, validateStructureDraft } from '../src/features/utility/structureDraftNormalizer';
import { compileStructureDraft, bindCompiledIds } from '../src/features/utility/structureCompiler';
import { nextDraftComponent } from '../src/features/utility/structureDraft';
import type { StructureDraft } from '../src/features/utility/structureDraft';

const baseDraft = (names: string[]): StructureDraft => ({
  version: 1,
  title: '一种具有自清洁结构的轴流风机',
  technicalField: '风机结构技术领域',
  baseStructure: '风筒内设置电机和叶轮，外侧设置防护网。',
  components: names.map((name, index) => ({ id: `D${String(index + 1).padStart(2, '0')}`, name, kind: index === names.length - 1 ? 'innovation' : 'base', purpose: `用于${name}`, position: `安装于结构位置${index + 1}`, whyNeeded: `因为需要${name}` })),
  relationships: names.slice(1).map((_, index) => ({ id: `R${String(index + 1).padStart(2, '0')}`, from: `D${String(index + 1).padStart(2, '0')}`, to: `D${String(index + 2).padStart(2, '0')}`, relation: 'connected_to' as const, description: '相邻部件连接' })),
  motions: [],
  innovationPoints: ['通过新增结构改善清洁效果'],
  problemSolved: '解决防护网积尘问题',
  workingPrinciple: '部件协同工作并实现清洁。',
  nextDraftNumber: names.length + 1,
  nextModelNumber: 1,
});

test('缺失几何和静止关系时，只对明确语义做确定性补全', () => {
  const result = normalizeStructureDraft(baseDraft(['风筒', '电机', '支架', '防护网', '连接块']));
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.draft.components.map(component => component.geometry?.shape)).toEqual(['tube', 'cylinder', 'box', 'tube', 'box']);
  expect(result.draft.motions.map(motion => motion.type)).toEqual(['static', 'static', 'static', 'static', 'static']);
  expect(new Set(result.draft.components.map(component => JSON.stringify(component.geometry))).size).toBe(5);
});

test('阀门支承件自动归一化为 static，阀芯仍要求明确驱动', () => {
  const result = normalizeStructureDraft(baseDraft(['阀体', '导向套', '阀盖', '阀芯', '操作杆']));
  expect(result.success).toBe(false);
  expect(result.errors.join('；')).toContain('阀芯');
  expect(result.errors.join('；')).toContain('不能自动猜测驱动部件');
  expect(result.errors.join('；')).not.toContain('导向套缺少运动或静止关系');
  expect(result.errors.join('；')).not.toContain('阀盖缺少运动或静止关系');

  const withMotion = baseDraft(['阀体', '导向套', '阀盖', '阀芯', '操作杆']);
  withMotion.motions = [{ id: 'M04', componentId: 'D04', type: 'linear', drivenBy: 'D05', path: '沿阀体轴向往复移动', purpose: '控制阀口启闭' }];
  const normalized = normalizeStructureDraft(withMotion);
  expect(normalized.success, normalized.errors.join(';')).toBe(true);
  if (!normalized.success) return;
  expect(normalized.draft.components.map(component => component.geometry?.shape)).toEqual(['cylinder', 'cylinder', 'cylinder', 'cylinder', 'cylinder']);
  expect(normalized.draft.motions.map(motion => [motion.componentId, motion.type])).toEqual([
    ['D01', 'static'], ['D02', 'static'], ['D03', 'static'], ['D04', 'linear'], ['D05', 'static'],
  ]);
});

test('运动部件缺少驱动部件时失败，不自动猜测', () => {
  const draft = baseDraft(['风筒', '叶轮']);
  const result = normalizeStructureDraft(draft);
  expect(result.success).toBe(false);
  expect(result.errors.join('；')).toContain('不能自动猜测驱动部件');
});

test('已有运动关系保留稳定 ID，并检查驱动部件引用', () => {
  const draft = baseDraft(['风筒', '电机', '叶轮']);
  draft.motions = [
    { id: 'M01', componentId: 'D01', type: 'static', path: '固定', purpose: '支撑' },
    { id: 'M02', componentId: 'D02', type: 'static', path: '固定', purpose: '安装' },
    { id: 'M03', componentId: 'D03', type: 'rotary', drivenBy: 'D02', path: '绕轴旋转', purpose: '形成气流' },
  ];
  const result = normalizeStructureDraft(draft);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.draft.motions[2]).toMatchObject({ id: 'M03', componentId: 'D03', drivenBy: 'D02', type: 'rotary' });
});

test('无效驱动引用、非法几何和未知部件不会被静默修复', () => {
  const draft = baseDraft(['风筒', '自由曲面件']);
  draft.components[0].geometry = { shape: 'box', position: [0, 0, 0], size: [0, 0, 0], rotation: [0, 0, 0] };
  draft.motions = [{ id: 'M01', componentId: 'D02', type: 'rotary', drivenBy: 'D99', path: '旋转', purpose: '复位' }];
  const result = normalizeStructureDraft(draft);
  expect(result.success).toBe(false);
  expect(result.errors.join('；')).toContain('示意几何格式无效');
  expect(result.errors.join('；')).toContain('无法根据明确部件语义安全补全');
  expect(result.errors.join('；')).toContain('驱动部件 D99 不存在');
});

test('已纳入协议的弹簧和螺纹杆可以按明确语义补全几何', () => {
  const draft = baseDraft(['风筒', '弹簧', '螺纹杆']);
  draft.motions = draft.components.map(component => ({
    id: `M${component.id.slice(1)}`,
    componentId: component.id,
    type: 'static' as const,
    path: '固定于安装位置',
    purpose: `保持${component.name}定位`,
  }));
  const result = normalizeStructureDraft(draft);
  expect(result.success, result.errors.join(';')).toBe(true);
  if (!result.success) return;
  expect(result.draft.components.map(component => component.geometry?.shape)).toEqual(['tube', 'spring', 'threaded_cylinder']);
});

test('D 编号不依赖数组顺序，验证器不调用外部服务', () => {
  const draft = baseDraft(['风筒', '支架', '防护网']);
  const result = normalizeStructureDraft({ ...draft, components: [...draft.components].reverse(), relationships: draft.relationships.map(r => ({ ...r, from: r.from, to: r.to })) });
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.draft.components.map(component => component.id)).toEqual(['D03', 'D02', 'D01']);
  expect(validateStructureDraft(result.draft)).toEqual([]);
});

test('D01-D07 的已有几何和逐部件运动关系贯穿归一化及编译', () => {
  const draft = baseDraft(['风筒', '电机', '转轴', '叶轮', '支架', '防护网', '隔音罩']);
  draft.motions = draft.components.map((component, index) => ({
    id: `M${String(index + 1).padStart(2, '0')}`, componentId: component.id,
    type: index === 2 || index === 3 ? 'rotary' : 'static',
    ...(index === 2 ? { drivenBy: 'D02' } : index === 3 ? { drivenBy: 'D03' } : {}),
    path: index === 2 || index === 3 ? '绕轴旋转' : '固定于安装位置', purpose: `保持${component.name}工作`,
  }));
  const normalized = normalizeStructureDraft(draft);
  expect(normalized.success, normalized.errors.join(';')).toBe(true);
  if (!normalized.success) return;
  expect(normalized.draft.components.every(c => !!c.geometry)).toBe(true);
  expect(new Set(normalized.draft.components.map(c => c.geometry!.position.join(','))).size).toBe(7);
  expect(normalized.draft.motions.map(m => m.componentId)).toEqual(draft.components.map(c => c.id));
  const compiled = compileStructureDraft(normalized.draft);
  expect(compiled.success, compiled.errors.join(';')).toBe(true);
  if (!compiled.success) return;
  expect(compiled.mapping).toEqual(Object.fromEntries(draft.components.map((c, i) => [c.id, `C${String(i + 1).padStart(2, '0')}`])));
  expect(compiled.model.motions.find(m => m.componentId === 'C03')?.drivenBy).toBe('C02');
  const bound = bindCompiledIds(normalized.draft, compiled.mapping);
  const removed = { ...bound, components: bound.components.filter(c => c.id !== 'D04') };
  expect(nextDraftComponent(removed).id).toBe('D08');
  expect(removed.nextModelNumber).toBe(8);
});

test('缺失驱动、错误引用、自驱、重复运动及未知运动均失败', () => {
  const draft = baseDraft(['电机', '转轴']);
  draft.motions = [{ id: 'M01', componentId: 'D01', type: 'static', path: '固定', purpose: '驱动' }, { id: 'M02', componentId: 'D02', type: 'rotary', path: '旋转', purpose: '传动' }];
  expect(normalizeStructureDraft(draft).errors.join()).toContain('未明确 drivenBy');
  draft.motions[1].drivenBy = '电机';
  expect(normalizeStructureDraft(draft).errors.join()).toContain('电机 不存在');
  draft.motions[1].drivenBy = 'D02';
  expect(normalizeStructureDraft(draft).errors.join()).toContain('指向自身');
  draft.motions[1].drivenBy = 'D01';
  draft.motions[1].type = 'linear';
  expect(normalizeStructureDraft(draft).success).toBe(true);
  draft.motions.push({ ...draft.motions[1], id: 'M03' });
  expect(normalizeStructureDraft(draft).errors.join()).toContain('重复的运动');
  draft.motions[2].componentId = 'D99';
  expect(normalizeStructureDraft(draft).errors.join()).toContain('不存在的部件 D99');
});

test('未知部件不会被默认成矩形或静止，非法几何也不会被覆盖', () => {
  const draft = baseDraft(['未知机构', '支架']);
  expect(normalizeStructureDraft(draft).errors.join()).toContain('无法根据明确部件语义安全补全');
  draft.components[0].geometry = { shape: 'box', position: [0, 0, 0], size: [0, 10, 10], rotation: [0, 0, 0] };
  expect(normalizeStructureDraft(draft).errors.join()).toContain('示意几何格式无效');
  draft.components[0].geometry = { shape: 'cylinder', position: [10, 0, 0], size: [5, 20, 0], rotation: [0, 0, 0] };
  expect(normalizeStructureDraft(draft).errors.join()).toContain('缺少运动或静止关系');
});

test('归一化是离线确定性的，不调用 fetch', () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('network'); }) as typeof fetch;
  try {
    const draft = baseDraft(['风筒', '支架']);
    expect(normalizeStructureDraft(draft)).toEqual(normalizeStructureDraft(draft));
    expect(calls).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
});

test('非法驱动字段被拒绝，保留已绑定模型 ID 高水位', () => {
  const draft = baseDraft(['风筒', '支架']);
  draft.components[0].modelId = 'C12';
  const result = normalizeStructureDraft(draft);
  expect(result.success).toBe(true);
  if (result.success) expect(result.draft.nextModelNumber).toBe(13);
  expect(normalizeStructureDraft({ ...draft, motions: [{ id: 'M01', componentId: 'D01', type: 'rotary', drivenBy: 42, path: '旋转', purpose: '驱动' }] }).errors).toContain('草案格式无效，请检查部件 ID、字段和数量。');
});
