import { expect, test } from '@playwright/test';
import { defaultUtilityDrawing, makeUtilityMaterials } from '../src/data';
import type { Project, UtilityDrawing } from '../src/data';
import { drawingSource, CONTENT_MODEL_REVISION } from '../src/features/utility/contentDrawing';
import { validatePatentConsistency } from '../src/features/utility/patentConsistency';
import { getModelVersion, modelToComponents } from '../src/features/utility/patentStructure';
import { bindCompiledIds, compileStructureDraft } from '../src/features/utility/structureCompiler';
import type { StructureDraft } from '../src/features/utility/structureDraft';

const box = (x: number) => ({ shape: 'box' as const, position: [x, 0, 0] as [number, number, number], size: [10, 10, 10] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] });
const draft: StructureDraft = {
  version: 1, title: '一种风机防护结构', technicalField: '风机技术领域', baseStructure: '风机本体、电机和防护网构成主体。',
  components: ['风机本体', '电机', '防护网'].map((name, index) => ({ id: `D0${index + 1}`, name, kind: index === 2 ? 'innovation' as const : 'base' as const, purpose: `支撑${name}`, position: `安装位${index + 1}`, whyNeeded: `需要${name}`, geometry: box(index * 10) })),
  relationships: [{ id: 'R01', from: 'D01', to: 'D02', relation: 'fixed_to', description: '电机固定于本体' }, { id: 'R02', from: 'D02', to: 'D03', relation: 'connected_to', description: '防护网与电机连接' }],
  motions: ['D01', 'D02', 'D03'].map((componentId, index) => ({ id: `M0${index + 1}`, componentId, type: 'static', path: '固定', purpose: '保持位置' })),
  innovationPoints: ['防护网改善安全性'], problemSolved: '防护不足', workingPrinciple: '电机工作，防护网提供保护。', nextDraftNumber: 4, nextModelNumber: 1,
};

function project(): Project {
  const result = compileStructureDraft(draft);
  if (!result.success) throw new Error(result.errors.join('；'));
  const model = result.model;
  const base: Project = { id: 'test', category: 'utility', name: model.productTitle, description: '', owner: '', status: 'draft', updatedAt: new Date().toISOString() };
  const initial = defaultUtilityDrawing(base);
  const components = modelToComponents(model);
  const detailComponentId = model.figureSpecs[2].highlightComponentIds![0];
  const drawing: UtilityDrawing = { ...initial, patentStructureModel: model, structureDraft: bindCompiledIds(draft, { D01: 'C01', D02: 'C02', D03: 'C03' }), parts: components.map(({ id, componentId, name }) => ({ id, componentId, name })) };
  drawing.design = { revision: CONTENT_MODEL_REVISION, title: base.name, source: drawingSource(base.name, drawing), generatedAt: new Date().toISOString(), components, detailPartId: Number(detailComponentId.slice(1)), detailComponentId, sourceModelVersion: getModelVersion(model), structureModel: model };
  return { ...base, utilityDrawing: drawing };
}

// 生成器产出的是“所述壳体（1）与所述支架（2）固定连接”——名称在前、编号在括号里。
// 旧的连接校验要求编号紧贴“与所述”，完全匹配不到这个句式，于是模型里没有的连接方式
// 也能一路通过校验并导出。这条测试把生成器真实句式喂回校验器，确保它真的被比对。
test('生成器自产句式的连接关系必须被比对，模型未记录的连接方式要报错', () => {
  const p = project(), model = p.utilityDrawing!.patentStructureModel!, materials = makeUtilityMaterials(p);
  const input = { model, claimReferences: materials.claimReferences, claimsText: materials.claims, documentSourceModelVersion: materials.sourceModelVersion };

  // 原样文案：连接方式与模型一致，不应产生连接类错误。
  const clean = validatePatentConsistency(input);
  expect(clean.filter(issue => issue.code === 'TEXT_CONNECTION_UNMODELED')).toEqual([]);

  // 模型记录 R01 是“固定连接”（风机本体—电机），文案却写成“滑动连接”。
  // 句式与生成器一致，只是关系词被替换；校验必须识别并报错。
  const drifted = validatePatentConsistency({
    ...input,
    text: `${materials.claims}\n所述风机本体（1）与所述电机（2）滑动连接，电机可相对本体移动。`,
  });
  expect(drifted.map(issue => issue.code)).toContain('TEXT_CONNECTION_UNMODELED');

  // 反向：模型里不存在的两个部件之间声明连接，也要报错。
  const phantom = validatePatentConsistency({
    ...input,
    text: `${materials.claims}\n所述风机本体（1）与所述防护网（3）固定连接。`,
  });
  expect(phantom.map(issue => issue.code)).toContain('TEXT_CONNECTION_UNMODELED');

  // 人工撰写的纯编号句式仍须被识别，不能被这次放宽正则漏掉。
  const coded = validatePatentConsistency({
    ...input,
    text: `${materials.claims}\nC01（风机本体）与所述C03（防护网）固定连接。`,
  });
  expect(coded.map(issue => issue.code)).toContain('TEXT_CONNECTION_UNMODELED');
});
