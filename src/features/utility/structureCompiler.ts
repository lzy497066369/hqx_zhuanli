import { isPatentGeometry, isPatentStructureModel } from './patentStructure.ts';
import { createModelVersion } from './patentStructure.ts';
import type { PatentStructureModel, PatentConnection } from './patentStructure.ts';
import { isStructureDraft } from './structureDraft.ts';
import type { StructureDraft } from './structureDraft.ts';
import { assemblyGeometryIssues } from './assemblyGeometry.ts';

export type CompileResult = { success: true; model: PatentStructureModel; mapping: Record<string, string>; errors: [] } |
  { success: false; model: null; mapping: Record<string, string>; errors: string[] };
const fail = (errors: string[]): CompileResult => ({ success: false, model: null, mapping: {}, errors });
const valid = (text: string) => text.trim().length > 0;
const relations = new Set(['connected_to', 'fixed_to', 'slidably_connected', 'rotatably_connected', 'driven_by', 'supported_by', 'limited_by']);

// Pure, deterministic, offline: never infer missing geometry, connections or motion.
export function compileStructureDraft(input: unknown): CompileResult {
  if (!isStructureDraft(input)) return fail(['草案格式无效，请检查部件 ID、字段和数量。']);
  const draft: StructureDraft = input;
  const errors: string[] = [];
  if (!valid(draft.title) || draft.title.length > 100) errors.push('请填写有效的实用新型名称。');
  for (const [label, text] of [['技术领域', draft.technicalField], ['基础结构', draft.baseStructure], ['解决的问题', draft.problemSolved], ['工作原理', draft.workingPrinciple]] as const) if (!valid(text)) errors.push(`请填写${label}。`);
  if (draft.components.length < 2) errors.push('至少需要两个部件。');
  if (!draft.components.some(c => c.kind === 'innovation')) errors.push('至少需要一个创新部件。');
  if (!draft.innovationPoints.some(valid)) errors.push('请填写创新点。');
  const ids = new Set(draft.components.map(c => c.id));
  const names = new Set<string>();
  const existingModels = new Set<string>();
  const referenceNumbers = new Set<string>();
  for (const c of draft.components) {
    if (!valid(c.name) || c.name.length > 40 || names.has(c.name)) errors.push(`${c.id} 部件名称为空、过长或重复。`);
    names.add(c.name);
    if (!valid(c.purpose) || !valid(c.position) || !valid(c.whyNeeded)) errors.push(`${c.id} 必须填写作用、位置及设置理由。`);
    if (!isPatentGeometry(c.geometry)) errors.push(`${c.id} 缺少有效的示意几何；请明确形状、位置、尺寸和旋转角度。`);
    if (c.parentId && (!ids.has(c.parentId) || c.parentId === c.id)) errors.push(`${c.id} 的父部件 ${c.parentId} 不存在或指向自己。`);
    if (c.modelId) {
      if (existingModels.has(c.modelId)) errors.push(`${c.id} 的模型标号 ${c.modelId} 已被其他部件占用。`);
      existingModels.add(c.modelId);
    }
    if (c.referenceNo !== undefined) {
      if (!/^\d{1,3}$/u.test(c.referenceNo)) errors.push(`${c.id} 的附图标号必须是 1 至 999 的数字。`);
      else if (referenceNumbers.has(c.referenceNo)) errors.push(`${c.id} 的附图标号 ${c.referenceNo} 与其他部件重复。`);
      referenceNumbers.add(c.referenceNo);
    }
  }
  const mapped = new Map<string, string>();
  const reserved = new Set(existingModels);
  // Allocate unbound components in stable DID order, not the mutable array order.
  // The persisted high-water mark prevents IDs removed after compilation from being reused.
  for (const c of draft.components) if (c.modelId) mapped.set(c.id, c.modelId);
  let serial = Math.max(draft.nextModelNumber, 1, ...[...existingModels].map(id => Number(id.slice(1)) + 1));
  const unbound = draft.components.filter(c => !c.modelId).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  for (const c of unbound) {
    const number = Math.max(serial, Number(c.id.slice(1)));
    if (number > 999) { errors.push('部件标号超过 C999。'); break; }
    const id = `C${String(number).padStart(2, '0')}`;
    mapped.set(c.id, id); reserved.add(id); serial = number + 1;
  }
  const relationIds = new Set<string>();
  for (const r of draft.relationships) {
    if (!/^R\d{2,3}$/u.test(r.id) || relationIds.has(r.id)) errors.push(`${r.id} 连接关系 ID 无效或重复。`);
    relationIds.add(r.id);
    if (!ids.has(r.from) || !ids.has(r.to) || r.from === r.to) errors.push(`${r.id} 连接端点 ${r.from} → ${r.to} 无效。`);
    if (!relations.has(r.relation) || !valid(r.description)) errors.push(`${r.id} 请填写有效连接类型及实际连接方式。`);
  }
  if (draft.relationships.length < draft.components.length - 1) errors.push('连接关系不足，结构必须整体连通。');
  const motionIds = new Set<string>();
  const motionComponents = new Set<string>();
  for (const m of draft.motions) {
    if (!/^M\d{2,3}$/u.test(m.id) || motionIds.has(m.id)) errors.push(`${m.id} 运动 ID 无效或重复。`);
    motionIds.add(m.id);
    if (!ids.has(m.componentId) || motionComponents.has(m.componentId)) errors.push(`${m.id} 部件不存在或已有运动记录。`);
    motionComponents.add(m.componentId);
    if (!valid(m.type) || !valid(m.path) || !valid(m.purpose)) errors.push(`${m.id} 请填写静止/运动类型、轨迹及作用。`);
    if (m.drivenBy && !ids.has(m.drivenBy)) errors.push(`${m.id} 驱动部件 ${m.drivenBy} 不存在。`);
    if (m.type !== 'static' && !m.drivenBy) errors.push(`${m.id} 运动部件须明确驱动部件；静止部件请使用 static。`);
  }
  for (const c of draft.components) if (!motionComponents.has(c.id)) errors.push(`${c.id} 缺少运动或静止关系。`);
  if (errors.length) return fail(errors);
  // 装配几何对所有产品生效：声明相连却相隔或穿插，是可审查员直接质疑的缺陷，
  // 不能只在 H 型钢这条路径上拦截。h_ 前缀的截面专有检查由 assemblyGeometryIssues
  // 自行按标题判断（非 H 标题内部即返回），此处统一按 error 级拦截。
  // 例外：几何是按名称推断出的占位值时，其位置不代表真实装配位置，接触无从核对，
  // 故不参与接触校验；用户或模型提供的几何一律照常受检。
  {
    const byId = new Map(draft.components.map(component => [component.id, component.name]));
    const inferred = new Set(draft.components.filter(component => component.inferredGeometry).map(component => component.id));
    const checked = draft.relationships.filter(relation => !inferred.has(relation.from) && !inferred.has(relation.to));
    const geometryIssues = assemblyGeometryIssues({ title: draft.title, components: draft.components,
      relationships: checked.map(relation => ({ from: byId.get(relation.from)!, to: byId.get(relation.to)!, relation: relation.relation })) });
    const geometryErrors = geometryIssues.filter(issue => issue.severity === 'error').map(issue => issue.message);
    if (geometryErrors.length) return fail(geometryErrors);
  }
  const connections: PatentConnection[] = draft.relationships.map(r => ({ ...r, from: mapped.get(r.from)!, to: mapped.get(r.to)! }));
  const connected = new Set<string>([draft.components[0].id]);
  let size = -1;
  while (size !== connected.size) { size = connected.size; for (const r of draft.relationships) { if (connected.has(r.from)) connected.add(r.to); if (connected.has(r.to)) connected.add(r.from); } }
  if (connected.size !== ids.size) return fail(['结构未连通：请为每个部件填写通往主体的连接关系。']);
  const innovation = draft.components.find(c => c.kind === 'innovation')!;
  const detailIds = new Set([innovation.id]);
  for (const r of draft.relationships) { if (r.from === innovation.id) detailIds.add(r.to); if (r.to === innovation.id) detailIds.add(r.from); }
  const allIds = draft.components.map(c => mapped.get(c.id)!);
  const allConnections = connections.map(r => r.id);
  const model: PatentStructureModel = {
    version: 1, improvementType: draft.improvementType, modelVersion: createModelVersion(), productTitle: draft.title, technicalField: draft.technicalField, baseStructure: draft.baseStructure,
    components: draft.components.map((c, index) => ({ id: mapped.get(c.id)!, referenceNo: c.referenceNo || String(Number(mapped.get(c.id)!.slice(1)) || index + 1), sourceDraftId: c.id, name: c.name, kind: c.kind, purpose: c.purpose, position: c.position, whyNeeded: c.whyNeeded, ...(c.visualFeature ? { visualFeature: c.visualFeature } : {}), geometry: c.geometry! })),
    connections, motions: draft.motions.map(m => ({ ...m, componentId: mapped.get(m.componentId)!, drivenBy: m.drivenBy ? mapped.get(m.drivenBy) : undefined })),
    functions: draft.components.map(c => c.purpose), innovationPoints: draft.innovationPoints.filter(valid), problemSolved: draft.problemSolved, workingPrinciple: draft.workingPrinciple,
    figureSpecs: [
      { id: 'F01', figureId: 'F01', title: '整体结构图', kind: 'overall', viewType: 'overall', componentIds: allIds, highlightComponentIds: [], connectionIds: allConnections },
      { id: 'F02', figureId: 'F02', title: '侧视结构图', kind: 'side', viewType: 'side', componentIds: allIds, highlightComponentIds: [], connectionIds: allConnections },
      { id: 'F03', figureId: 'F03', title: '创新结构局部放大图', kind: 'detail', viewType: 'detail', componentIds: [...detailIds].map(id => mapped.get(id)!), highlightComponentIds: [mapped.get(innovation.id)!], connectionIds: connections.filter(r => detailIds.has(draft.relationships.find(d => d.id === r.id)!.from) && detailIds.has(draft.relationships.find(d => d.id === r.id)!.to)).map(r => r.id) },
    ],
  };
  if (!isPatentStructureModel(model)) return fail(['编译结果未通过 Patent Structure Model 校验，请检查字段长度、示意几何及视图引用。']);
  return { success: true, model, mapping: Object.fromEntries(mapped), errors: [] };
}

export function bindCompiledIds(draft: StructureDraft, mapping: Record<string, string>): StructureDraft {
  const components = draft.components.map(c => ({ ...c, modelId: mapping[c.id] }));
  return { ...draft, components, nextModelNumber: Math.max(draft.nextModelNumber, ...Object.values(mapping).map(id => Number(id.slice(1)) + 1)) };
}
