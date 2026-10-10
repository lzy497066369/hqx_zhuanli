import { expect, test } from '@playwright/test';
import { defaultUtilityDrawing, hasConfirmedUtilityStructure, makeUtilityMaterials, makeUtilityDocument } from '../src/data';
import type { Project, UtilityDrawing } from '../src/data';
import { buildContentAssembly, CONTENT_MODEL_REVISION, drawingSource } from '../src/features/utility/contentDrawing';
import { actualFigureMarkers } from '../src/features/utility/figureConsistency';
import { validatePatentConsistency } from '../src/features/utility/patentConsistency';
import { getModelVersion, modelToComponents } from '../src/features/utility/patentStructure';
import { confirmStructureEvidence } from '../src/features/utility/patentEvidence';
import { bindCompiledIds, compileStructureDraft } from '../src/features/utility/structureCompiler';
import type { StructureDraft } from '../src/features/utility/structureDraft';
import { createPatentGenerationContext } from '../src/features/utility/claimPlan';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning';
import { materialsForContext } from './fixtures/materialsV2';

const box = (x: number) => ({ shape: 'box' as const, position: [x, 0, 0] as [number, number, number], size: [10, 10, 10] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] });
const draft: StructureDraft = {
  version: 1, title: '一种风机防护结构', technicalField: '风机技术领域', baseStructure: '风机本体、电机和防护网构成主体。',
  components: ['风机本体', '电机', '防护网'].map((name, index) => ({ id: `D0${index + 1}`, name, kind: index === 2 ? 'innovation' as const : 'base' as const, purpose: `支撑${name}`, position: `安装位${index + 1}`, whyNeeded: `需要${name}`, geometry: box(index * 10) })),
  relationships: [{ id: 'R01', from: 'D01', to: 'D02', relation: 'fixed_to', description: '电机固定于本体' }, { id: 'R02', from: 'D02', to: 'D03', relation: 'connected_to', description: '防护网与电机连接' }],
  motions: ['D01', 'D02', 'D03'].map((componentId, index) => ({ id: `M0${index + 1}`, componentId, type: 'static', path: '固定', purpose: '保持位置' })),
  innovationPoints: ['防护网改善安全性'], problemSolved: '防护不足', workingPrinciple: '电机工作，防护网提供保护。', nextDraftNumber: 4, nextModelNumber: 1,
};
function compiled(input = draft) {
  const result = compileStructureDraft(input);
  if (!result.success) throw new Error(result.errors.join('；'));
  return result;
}
function project(model = compiled().model): Project {
  const base: Project = { id: 'test', category: 'utility', name: model.productTitle, description: '', owner: '', status: 'draft', updatedAt: new Date().toISOString() };
  const initial = defaultUtilityDrawing(base);
  const confirmed = confirmStructureEvidence(model, { productName: base.name, introduction: '', usageScene: '', existingStructure: '', existingFunctions: '' });
  const confirmedModel = confirmed.model;
  const components = modelToComponents(confirmedModel);
  const detailComponentId = confirmedModel.figureSpecs[2].highlightComponentIds![0];
  const drawing: UtilityDrawing = { ...initial, patentStructureModel: confirmedModel, evidencePackage: confirmed.evidence, structureDraft: bindCompiledIds(draft, { D01: 'C01', D02: 'C02', D03: 'C03' }), parts: components.map(({ id, componentId, name }) => ({ id, componentId, name })) };
  drawing.design = { revision: CONTENT_MODEL_REVISION, title: base.name, source: drawingSource(base.name, drawing), generatedAt: new Date().toISOString(), components, detailPartId: Number(detailComponentId.slice(1)), detailComponentId, sourceModelVersion: getModelVersion(confirmedModel), structureModel: confirmedModel };
  return { ...base, utilityDrawing: drawing };
}

test('文案只引用模型 ID；未知部件、错误名称编号和运动关系被拒绝', () => {
  const p = project(), model = p.utilityDrawing!.patentStructureModel!;
  const document = makeUtilityMaterials(p);
  expect(document.sourceModelVersion).toBe(getModelVersion(model));
  expect(document.claimReferences?.[0].componentIds).toEqual(['C01', 'C02', 'C03']);
  expect(document.claimReferences).toHaveLength(6);
  expect(document.claimReferences?.[1].connectionIds).toEqual(['R01']);
  expect(document.claimReferences?.[2].connectionIds).toEqual(['R02']);
  expect(document.claims).toContain('2. 根据权利要求1所述的');
  expect(document.claims).toContain('所述防护网（3）设置于安装位3');
  expect(document.claims).toContain('3. 根据权利要求2所述的');
  expect(document.claimReferences?.find(reference => reference.claimNo === 3)?.parentClaimNo).toBe(2);
  expect(document.claims).not.toContain('C04');
  const check = (text: string) => validatePatentConsistency({ model, text, claimsText: text, claimReferences: document.claimReferences, documentSourceModelVersion: document.sourceModelVersion });
  expect(check(`${document.claims} C04`).map(issue => issue.code)).toContain('TEXT_COMPONENT_ID_MISSING');
  expect(check(`${document.claims} 防护网5`).map(issue => issue.code)).toContain('TEXT_COMPONENT_REFERENCE_MISMATCH');
  expect(check(`${document.claims} 防护网（C02）`).map(issue => issue.code)).toContain('TEXT_COMPONENT_NAME_MISMATCH');
  expect(check(`${document.claims} 未建模毛刷（C01）`).map(issue => issue.code)).toContain('TEXT_COMPONENT_NAME_MISMATCH');
  expect(check(`${document.claims} 防护网（C03）执行rotary`).map(issue => issue.code)).toContain('TEXT_MOTION_UNMODELED');
  expect(check(`${document.claims} 所述防护网（C03）与所述风机本体（C01）固定连接`).map(issue => issue.code)).toContain('TEXT_CONNECTION_UNMODELED');
  expect(validatePatentConsistency({ model, claimsText: `${document.claims} C04`, documentSourceModelVersion: document.sourceModelVersion }).map(issue => issue.code)).toContain('TEXT_COMPONENT_ID_MISSING');
});

test('正式文案紧跟部件使用 referenceNo，不把内部 C 编号输出给用户', () => {
  const numbered = compiled({
    ...draft,
    components: draft.components.map((component, index) => ({ ...component, referenceNo: ['201', '206', '210'][index] })),
  }).model;
  const materials = makeUtilityMaterials(project(numbered));
  expect(materials.claims).toContain('防护网（210）');
  expect(materials.claims).not.toContain('防护网（C03）');
  expect(materials.drawings).toContain('201、风机本体；206、电机；210、防护网');
  expect(materials.embodiment).toContain('防护网（210）');
});

test('从属权利要求按结构锚点形成链式和分支引用', () => {
  const model = compiled({
    ...draft,
    components: [...draft.components, { ...draft.components[2], id: 'D04', name: '密封圈', kind: 'innovation' }],
    relationships: [...draft.relationships, { id: 'R03', from: 'D01', to: 'D04', relation: 'connected_to' as const, description: '密封圈与本体连接' }],
    motions: [...draft.motions, { id: 'M04', componentId: 'D04', type: 'static' as const, path: '固定', purpose: '密封' }],
  }).model;
  const document = makeUtilityMaterials(project(model));
  const parents = document.claims.split('\n').map(claim => claim.match(/根据权利要求(\d+)所述/u)?.[1]);
  expect(parents.slice(1)).toEqual(['1', '2', '2', '4', '3', '3', '4']);
  expect(document.claims).toContain('3. 根据权利要求2所述的');
  expect(document.claims).toContain('4. 根据权利要求2所述的');
});

test('重排和删除组件后图纸仍按模型 ID 绘制，不能注入额外部件', () => {
  const p = project(), drawing = p.utilityDrawing!, model = drawing.patentStructureModel!;
  const reordered = { ...model, components: [...model.components].reverse() };
  expect(modelToComponents(reordered).map(c => c.componentId)).toEqual(['C03', 'C02', 'C01']);
  expect(new Set(actualFigureMarkers(drawing.design!, model)[2])).toEqual(new Set(model.figureSpecs[2].componentIds));
  const assembly = buildContentAssembly(drawing.design!);
  expect(assembly.parts.map(part => part.componentId)).toEqual(['C01', 'C02', 'C03']);
  const tampered = { ...drawing.design!, components: [...drawing.design!.components, { ...drawing.design!.components[0], id: 4, componentId: 'C04', name: '额外部件' }] };
  expect(() => buildContentAssembly(tampered)).toThrow(/来源结构模型不一致/);
  expect(validatePatentConsistency({ model, design: tampered }).map(issue => issue.code)).toContain('DRAWING_COMPONENT_MISSING');
  const bound = bindCompiledIds(draft, compiled().mapping);
  const reduced = { ...bound, components: bound.components.filter(c => c.id !== 'D02'), relationships: [{ id: 'R03', from: 'D01', to: 'D03', relation: 'connected_to' as const, description: '直接连接' }], motions: bound.motions.filter(m => m.componentId !== 'D02') };
  expect(compiled(reduced).model.components.map(c => c.id)).toEqual(['C01', 'C03']);
});

test('新模型不修改旧文案和图纸；跨版本组合与旧报告均报错', () => {
  const p = project(), oldDrawing = p.utilityDrawing!;
  const model = oldDrawing.patentStructureModel!, evidence = oldDrawing.evidencePackage!;
  const oldDocument = materialsForContext(createPatentGenerationContext(model, evidence, buildReasoningPackage(model, evidence)));
  const original = makeUtilityDocument({ ...p, utilityMaterials: oldDocument });
  expect(original).toContain(oldDocument.content);
  const newer = compiled({ ...draft, problemSolved: '改善防护和拆装' }).model;
  const changed = { ...p, utilityDrawing: { ...oldDrawing, patentStructureModel: newer }, utilityMaterials: oldDocument };
  expect(hasConfirmedUtilityStructure(changed)).toBe(true);
  expect(changed.utilityMaterials).toBe(oldDocument);
  expect(changed.utilityDrawing.design).toBe(oldDrawing.design);
  expect(changed.utilityDrawing.design?.sourceModelVersion).toBe(getModelVersion(oldDrawing.patentStructureModel!));
  expect(() => makeUtilityDocument(changed)).toThrow(/当前结构模型/);
  const issues = validatePatentConsistency({ model: newer, design: oldDrawing.design, claimsText: oldDocument.claims, claimReferences: oldDocument.claimReferences,
    documentSourceModelVersion: oldDocument.sourceModelVersion, drawingSourceModelVersion: getModelVersion(newer), consistencySourceModelVersion: oldDocument.sourceModelVersion });
  expect(issues.map(issue => issue.code)).toContain('DOCUMENT_DRAWING_VERSION_MISMATCH');
  expect(issues.filter(issue => issue.code === 'DOCUMENT_DRAWING_VERSION_MISMATCH')).toHaveLength(1);
  expect(issues.filter(issue => issue.severity === 'error')).toHaveLength(2);
  expect(issues.map(issue => issue.code)).not.toContain('CONSISTENCY_REPORT_STALE');
});

test('数量和相似部件名不误报，明确错号和跨版本仍阻止导出', () => {
  const p = project(), model = p.utilityDrawing!.patentStructureModel!, materials = makeUtilityMaterials(p);
  const input = { model, claimReferences: materials.claimReferences, claimsText: materials.claims,
    documentSourceModelVersion: materials.sourceModelVersion };
  const clean = validatePatentConsistency({ ...input, text: `${materials.claims}\n防护网3个，防护网共3处。` });
  expect(clean.filter(issue => issue.severity === 'error')).toEqual([]);
  const wrong = validatePatentConsistency({ ...input, text: `${materials.claims}\n防护网（5），防护网（C01）。` });
  expect(wrong.map(issue => issue.code)).toContain('TEXT_COMPONENT_REFERENCE_MISMATCH');
  expect(wrong.map(issue => issue.code)).toContain('TEXT_COMPONENT_NAME_MISMATCH');
  const similar = compiled({ ...draft, components: draft.components.map((component, index) => index === 2 ? { ...component, name: '电机防护网' } : component) }).model;
  const similarProject = project(similar), similarMaterials = makeUtilityMaterials(similarProject);
  expect(validatePatentConsistency({ model: similar, claimsText: similarMaterials.claims, claimReferences: similarMaterials.claimReferences,
    documentSourceModelVersion: similarMaterials.sourceModelVersion }).filter(issue => issue.severity === 'error')).toEqual([]);
});
