import { expect, test } from '@playwright/test';
import { assemblyGeometryIssues } from '../src/features/utility/assemblyGeometry';
import type { StructureSkeleton } from '../src/features/utility/structureSkeleton';
import { sampleDraft, sampleSkeleton } from './fixtures/structureFlow';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';

const beam = (): StructureSkeleton => ({
  ...sampleSkeleton('一种截面呈H形的H型钢梁段'),
  subjectComponent: '下翼缘',
  components: [
    { name: '下翼缘', kind: 'base', purpose: '承载', position: '底部', visualFeature: '板状', geometryShape: 'box', geometry: { shape: 'box', position: [0, 0, 0], size: [100, 40, 4], rotation: [0, 0, 0] } },
    { name: '腹板', kind: 'innovation', purpose: '连接', position: '居中', visualFeature: '板状', geometryShape: 'box', geometry: { shape: 'box', position: [0, 18, 4], size: [100, 4, 32], rotation: [0, 0, 0] } },
    { name: '上翼缘', kind: 'base', purpose: '承载', position: '顶部', visualFeature: '板状', geometryShape: 'box', geometry: { shape: 'box', position: [0, 0, 36], size: [100, 40, 4], rotation: [0, 0, 0] } },
  ],
  relationships: [
    { from: '下翼缘', to: '腹板', relation: 'fixed_to', description: '一体连接' },
    { from: '腹板', to: '上翼缘', relation: 'fixed_to', description: '一体连接' },
  ],
});

test('装配：H 截面三板齐平接触，不把正常一体连接视为穿插', () => {
  expect(assemblyGeometryIssues(beam())).toEqual([]);
  const welded = beam();
  welded.components[1].geometry!.position[2] = 3.5;
  expect(assemblyGeometryIssues(welded).map(issue => issue.code)).toContain('h_contact');
});

test('装配：分别报告端部突出、偏心、接触间隙及额外连接间隙', () => {
  const skeleton = beam();
  skeleton.components[1].geometry!.position = [6, 25, 8];
  const codes = assemblyGeometryIssues(skeleton).map(issue => issue.code);
  expect(codes).toEqual(expect.arrayContaining(['disconnected_boxes', 'h_length', 'h_web_center', 'h_contact']));
});

test('装配：旋转后的长方体依实际空间检测，不以轴对齐包围盒误判', () => {
  const skeleton = sampleSkeleton('一种支架');
  skeleton.components = skeleton.components.slice(0, 2);
  skeleton.relationships = skeleton.relationships.slice(0, 1);
  skeleton.components[0].geometry = { shape: 'box', position: [0, 0, 0], size: [10, 2, 2], rotation: [0, 0, 45] };
  skeleton.components[1].geometry = { shape: 'box', position: [7.5, -5, 0], size: [10, 2, 2], rotation: [0, 0, 45] };
  expect(assemblyGeometryIssues(skeleton).map(issue => issue.code)).toContain('disconnected_boxes');
  skeleton.components[1].geometry.position = [7, 7, 0];
  expect(assemblyGeometryIssues(skeleton)).toEqual([]);
});

test('装配：宽语义连接的间隙仅警告，H 截面接触错误仍阻断', () => {
  const skeleton = beam();
  skeleton.relationships[0].relation = 'connected_to';
  skeleton.components[1].geometry!.position[2] = 6;
  const issue = assemblyGeometryIssues(skeleton).find(item => item.code === 'disconnected_boxes');
  expect(issue).toMatchObject({ severity: 'warning', components: ['下翼缘', '腹板'] });
  expect(assemblyGeometryIssues(skeleton).some(item => item.code === 'h_contact' && item.severity === 'error')).toBe(true);
});

test('装配：正常面接触不判为穿插，明显重叠的固定连接报告穿插', () => {
  const skeleton = beam();
  expect(assemblyGeometryIssues(skeleton).some(item => item.code === 'intersecting_boxes')).toBe(false);
  skeleton.components[1].geometry!.position[2] = 2;
  const issue = assemblyGeometryIssues(skeleton).find(item => item.code === 'intersecting_boxes');
  expect(issue).toMatchObject({ severity: 'error', relation: 'fixed_to', components: ['下翼缘', '腹板'] });
  expect(issue?.recommendation).toContain('避免一个部件进入另一个部件内部');
});

test('装配：不对名称不明确的结构套用 H 截面规则', () => {
  const skeleton = beam();
  skeleton.title = '一种加强支架';
  skeleton.components[1].geometry!.position[0] = 6;
  expect(assemblyGeometryIssues(skeleton).some(issue => issue.code.startsWith('h_'))).toBe(false);
});

test('装配：第四部件仅提示核对，不凭名称删除真实加强件', () => {
  const skeleton = beam();
  skeleton.components.push({ name: '加强板', kind: 'base', purpose: '加强', position: '端部', visualFeature: '板状', geometryShape: 'box', geometry: { shape: 'box', position: [100, 0, 0], size: [4, 40, 40], rotation: [0, 0, 0] } });
  expect(assemblyGeometryIssues(skeleton)).toMatchObject([{ code: 'h_extra', severity: 'warning', components: ['加强板'] }]);
});

test('编译：H 梁草案即使绕过骨架确认仍须端面对齐', () => {
  const skeleton = beam();
  const base = sampleDraft(skeleton.title);
  const draft = { ...base,
    components: base.components.map((item, index) => ({ ...item, name: skeleton.components[index].name, geometry: skeleton.components[index].geometry! })),
    relationships: base.relationships.map((item, index) => ({ ...item, from: index ? 'D02' : 'D01', to: index ? 'D03' : 'D02' })),
  };
  expect(compileStructureDraft(draft).success).toBe(true);
  draft.components[1].geometry = { ...draft.components[1].geometry, position: [8, 18, 4] };
  expect(compileStructureDraft(draft).errors.join()).toContain('同长且两端对齐');
});
