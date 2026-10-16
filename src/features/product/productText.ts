// Technical source and prose are separate persisted artifacts. This module is shared
// by the server, browser and exports; it has no model, filesystem or secret access.
import { sha256Sync } from './digest.ts';
import type { ProblemSelection } from './productProblems.ts';
export type TechnicalPart = {
  id: string; name: string; kind: 'part' | 'assembly' | 'region' | 'opening' | 'surface';
  parentId: string | null; importance: 'core' | 'support'; necessity: string;
  role: string; position: string; motion: string;
  form?: { name: string; detail: string; basis: string };
};
export type ClaimFeature = { feature: string; partIds: string[]; reason: string };
export type TechnicalPlan = {
  schemaVersion: 3; title: string; scenario: string; problem: string; goal: string;
  technicalField: string; overview: string; appearance: string;
  choiceCoverage: { choiceId: string; description: string }[];
  focus: { improvement: string; corePartIds: string[]; boundary: string };
  parts: TechnicalPart[];
  connections: { from: string; to: string; type: string; detail: string }[];
  coreActions: { name: string; partIds: string[]; trigger: string; before: string; constraint: string; sequence: string[]; after: string; clearance: string; basis: string }[];
  workingSteps: { step: string; partIds: string[] }[];
  improvements: { partIds: string[]; mechanism: string; effect: string }[];
  claimPlan: { focus: string; independent: ClaimFeature[]; dependent: ClaimFeature[]; embodimentOnly: ClaimFeature[] };
  assumptions: string[]; verificationNeeds: string[];
};
export type TextDocument = {
  title: string; abstract: string; technicalField: string; background: string; technicalProblem: string;
  solution: string; benefits: string[]; embodiment: string; operation: string;
  claims: { number: number; dependsOn: number | null; text: string; partIds: string[] }[];
};
export type JsonPatch = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown };
export type ReviewFinding = { location: string; issue: string; resolution: string };
export type TextReview = { patches: JsonPatch[]; findings: ReviewFinding[]; unresolved: string[] };
export type PartEdit = { op: 'update' | 'add' | 'remove'; partId: string; partName: string; changes?: Partial<Omit<TechnicalPart, 'id'>>; value?: TechnicalPart };
export type StructureReview = TextReview & { partEdits: PartEdit[] };
export const TEXT_RULES_VERSION = '2026-10-14-v2';
export type TextStructure = { reviewId: string; rulesVersion: string; plan: TechnicalPlan; createdAt: string; signature: string };
export type FrozenTechnicalSource = { version: string; rulesVersion?: string; initialPlan: TechnicalPlan; plan: TechnicalPlan; review: StructureReview };
export type TextDraft = { briefId: string; sourceVersion: string; document: TextDocument; createdAt: string; signature: string };
export type TextRecord = { sourceVersion: string; draft: TextDocument; review: TextReview; document: TextDocument; status: 'completed' | 'needs_review' };

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 30000;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const list = (v: unknown): any[] => Array.isArray(v) ? v : [];
const fields = (v: unknown, keys: string[]): v is Record<string, any> => object(v) && keys.every(key => text(v[key]));
const id = (v: unknown) => typeof v === 'string' && /^[1-9]\d{0,2}$/.test(v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const select = (v: Record<string, any>, keys: readonly string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(v || {}, key)).map(key => [key, structuredClone(v[key])]));
const partFields = ['name', 'kind', 'parentId', 'importance', 'necessity', 'role', 'position', 'motion', 'form'];
const planFields = ['schemaVersion', 'title', 'scenario', 'problem', 'goal', 'technicalField', 'overview', 'appearance', 'choiceCoverage', 'focus', 'parts', 'connections', 'coreActions', 'workingSteps', 'improvements', 'claimPlan', 'assumptions', 'verificationNeeds'];
const documentFields = ['title', 'abstract', 'technicalField', 'background', 'technicalProblem', 'solution', 'benefits', 'embodiment', 'operation', 'claims'];
const exactKeys = (v: Record<string, any>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(v);
}
export function textSourceVersion(source: unknown, rulesVersion = TEXT_RULES_VERSION): string {
  return Array.from(sha256Sync(new TextEncoder().encode(rulesVersion + ':' + canonical(source))), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function frozenSourceVersion(source: FrozenTechnicalSource): string {
  const writing = technicalPlanForWriting(source.plan);
  // v1 records did not persist the rules version. Preserve their content identity.
  if (!source.rulesVersion && source.version === textSourceVersion(writing, '2026-10-14-v1')) return source.version;
  return textSourceVersion(writing, source.rulesVersion || TEXT_RULES_VERSION);
}

export function checkTechnicalPlan(value: unknown, selection?: { proposedName: string; choices: { id: string }[]; selectedProblem?: ProblemSelection }): string[] {
  if (!object(value)) return ['缺少结构方案对象。'];
  const p = value, errors: string[] = [];
  if (p.schemaVersion !== 3 || !exactKeys(p, planFields)) errors.push('结构字段或 schemaVersion 无效，应为版本3。');
  if (!fields(p, ['title', 'scenario', 'problem', 'goal', 'technicalField', 'overview', 'appearance'])) errors.push('缺少名称、场景、问题、目标或产品说明。');
  if (!strings(p.assumptions) || !strings(p.verificationNeeds)) errors.push('设计记录与工程验证任务必须分别为文字数组。');
  const parts = list(p.parts), ids = new Set(parts.map(part => part?.id));
  const refs = (v: unknown) => strings(v) && v.length > 0 && new Set(v).size === v.length && v.every(n => ids.has(n));
  const names = new Map<string, string>();
  if (!parts.length || parts.length > 30 || ids.size !== parts.length) errors.push('结构标记应为1至30项，编号不可重复。');
  const physical = parts.filter(part => part?.kind === 'part' || part?.kind === 'assembly');
  if (!physical.length || physical.length > 12) errors.push('请在现有产品接口支持的1至12个实体部件内组织设计，孔槽等在所属部件上表达。');
  const graph = new Map(parts.map(part => [part?.id, new Set<string>()]));
  for (const part of parts) {
    if (!fields(part, ['id', 'name', 'necessity', 'role', 'position', 'motion']) || !id(part.id) || !exactKeys(part, ['id', ...partFields]) ||
      !['part', 'assembly', 'region', 'opening', 'surface'].includes(part.kind) || !['core', 'support'].includes(part.importance)) { errors.push('部件编号、名称、类型、位置、运动或保留理由无效。'); continue; }
    if (part.form !== undefined && (!fields(part.form, ['name', 'detail', 'basis']) || !exactKeys(part.form, ['name', 'detail', 'basis']))) errors.push(`部件${part.id}的具体形式须有名称、具体结构和上位概括依据。`);
    for (const name of [part.name, part.form?.name].filter(Boolean)) {
      if (names.has(name) && names.get(name) !== part.id) errors.push(`术语“${name}”对应多个部件。`);
      names.set(name, part.id);
    }
    if (part.parentId !== null && (!ids.has(part.parentId) || part.parentId === part.id)) errors.push(`部件${part.id}的所属编号无效。`);
    if (['region', 'opening', 'surface'].includes(part.kind) && part.parentId === null) errors.push(`局部特征${part.id}必须有所属部件。`);
    const ancestors = new Set([part.id]); let parent = part.parentId;
    while (parent != null && ids.has(parent)) {
      if (ancestors.has(parent)) { errors.push('所属关系不能循环。'); break; }
      ancestors.add(parent); parent = parts.find(part => part.id === parent)?.parentId;
    }
    if (ids.has(part.parentId)) { graph.get(part.id)?.add(part.parentId); graph.get(part.parentId)?.add(part.id); }
  }
  if (!Array.isArray(p.connections)) errors.push('缺少连接表。');
  for (const c of list(p.connections)) {
    if (!fields(c, ['from', 'to', 'type', 'detail']) || !ids.has(c.from) || !ids.has(c.to) || c.from === c.to || !exactKeys(c, ['from', 'to', 'type', 'detail'])) { errors.push('连接关系引用无效或缺少具体方式。'); continue; }
    graph.get(c.from)?.add(c.to); graph.get(c.to)?.add(c.from);
  }
  const visited = new Set<string>(), queue = parts.length ? [parts[0]?.id] : [];
  while (queue.length) { const n = queue.shift(); if (visited.has(n)) continue; visited.add(n); queue.push(...(graph.get(n) || [])); }
  if (visited.size !== ids.size) errors.push('存在未接入整机的结构。');
  if (!fields(p.focus, ['improvement', 'boundary']) || !refs(p.focus?.corePartIds) || !exactKeys(p.focus, ['improvement', 'boundary', 'corePartIds'])) errors.push('核心改进或边界、引用缺失。');
  else if (p.focus.corePartIds.some((n: string) => parts.find(part => part.id === n)?.importance !== 'core')) errors.push('核心引用对应的结构必须为core。');
  for (const [key, required] of [['coreActions', ['name', 'trigger', 'before', 'constraint', 'after', 'clearance', 'basis']], ['workingSteps', ['step']], ['improvements', ['mechanism', 'effect']]] as const) {
    const items = list(p[key]);
    if (!items.length || items.some(item => !fields(item, [...required]) || !refs(item.partIds) || !exactKeys(item, [...required, 'partIds', ...(key === 'coreActions' ? ['sequence'] : [])]) ||
      (key === 'coreActions' && (!strings(item.sequence) || !item.sequence.length)))) errors.push(`${key}缺少具体内容、动作约束或有效引用。`);
  }
  if (!fields(p.claimPlan, ['focus']) || !exactKeys(p.claimPlan, ['focus', 'independent', 'dependent', 'embodimentOnly'])) errors.push('保护对象或保护方案字段缺失。');
  for (const group of ['independent', 'dependent', 'embodimentOnly']) {
    const items = p.claimPlan?.[group];
    if (!Array.isArray(items) || (group === 'independent' && !items.length)) { errors.push(`claimPlan.${group}必须为数组，独立项至少包含一组必要特征。`); continue; }
    for (const [index, item] of items.entries()) {
      const location = `claimPlan.${group}[${index}]`;
      if (!object(item)) { errors.push(`${location}须为包含feature、partIds、reason的对象。`); continue; }
      for (const field of ['feature', 'reason']) if (!text(item[field])) errors.push(`${location}.${field}须为非空文字，不能只在findings记录取舍。`);
      if (!refs(item.partIds)) errors.push(`${location}.partIds引用无效：${JSON.stringify(item.partIds)}；可用编号为${[...ids].join('、')}，新增或删除部件后须同步引用。`);
      if (!exactKeys(item, ['feature', 'reason', 'partIds'])) errors.push(`${location}只允许feature、partIds、reason字段，删除${Object.keys(item).filter(k => !['feature', 'reason', 'partIds'].includes(k)).join('、')}。`);
    }
  }
  if (!Array.isArray(p.choiceCoverage) || p.choiceCoverage.some(c => !fields(c, ['choiceId', 'description']) || !exactKeys(c, ['choiceId', 'description'])) || new Set(list(p.choiceCoverage).map(c => c?.choiceId)).size !== list(p.choiceCoverage).length) errors.push('已选要求的落实记录无效。');
  if (selection && (p.title !== selection.proposedName || !same(list(p.choiceCoverage).map(c => c?.choiceId).sort(), selection.choices.map(c => c.id).sort()))) errors.push('名称或已选要求与用户选择不一致。');
  if (selection?.selectedProblem && (p.scenario !== selection.selectedProblem.scenario || p.problem !== selection.selectedProblem.problem.problem || p.goal !== selection.selectedProblem.problem.goal)) errors.push('场景、技术问题和目标必须保持用户选择的原文，不能改题。');
  return [...new Set(errors)];
}

// Whitelists are applied at every level, including records loaded from old jobs.
export function technicalPlanForWriting(plan: TechnicalPlan) {
  return {
    ...select(plan, ['schemaVersion', 'title', 'scenario', 'problem', 'goal', 'technicalField']),
    focus: select(plan.focus, ['improvement', 'corePartIds']),
    parts: plan.parts.map(part => ({ ...select(part, ['id', 'name', 'kind', 'parentId', 'role', 'position', 'motion']),
      ...(part.form ? { form: select(part.form, ['name', 'detail', 'basis']) } : {}) })),
    connections: plan.connections.map(c => select(c, ['from', 'to', 'type', 'detail'])),
    coreActions: plan.coreActions.map(a => select(a, ['name', 'partIds', 'trigger', 'before', 'constraint', 'sequence', 'after', 'clearance', 'basis'])),
    workingSteps: plan.workingSteps.map(s => select(s, ['step', 'partIds'])),
    improvements: plan.improvements.map(i => select(i, ['partIds', 'mechanism', 'effect'])),
    claimPlan: { focus: plan.claimPlan.focus, ...Object.fromEntries((['independent', 'dependent', 'embodimentOnly'] as const).map(group => [group, plan.claimPlan[group].map(f => select(f, ['feature', 'partIds']))])) },
  };
}
export function documentForWriting(doc: TextDocument): TextDocument {
  return { ...select(doc, documentFields.filter(k => k !== 'claims')), claims: list(doc.claims).map(c => select(c, ['number', 'dependsOn', 'text', 'partIds'])) } as TextDocument;
}
export function documentContent(doc: TextDocument) {
  const d = documentForWriting(doc);
  return { abstract: d.abstract, claims: d.claims.map(c => `${c.number}. ${c.text}`), technicalField: d.technicalField, background: d.background,
    content: [d.technicalProblem, d.solution, ...d.benefits].join('\n\n'), embodiment: [d.embodiment, d.operation].join('\n\n') };
}
export function checkTextDocument(value: unknown, plan: Pick<TechnicalPlan, 'title' | 'parts'>): string[] {
  if (!object(value)) return ['缺少正文对象。'];
  const d = value, errors: string[] = [];
  if (!exactKeys(d, documentFields) || !fields(d, documentFields.filter(k => !['benefits', 'claims'].includes(k)))) errors.push('正文字段缺失或包含非正文字段。');
  if (d.title !== plan.title) errors.push('正文标题与冻结方案不一致。');
  if (typeof d.abstract === 'string' && [...d.abstract].length > 300) errors.push('摘要超过300字。');
  if (!strings(d.benefits) || !d.benefits.length) errors.push('有益效果必须为完整自然句数组。');
  const claims = list(d.claims), ids = new Set(plan.parts.map(p => p.id));
  if (!claims.length || claims.length > 20) errors.push('权利要求缺失或超过接口上限20项，不要求凑从属项数量。');
  for (const [i, c] of claims.entries()) {
    if (!fields(c, ['text']) || c.number !== i + 1 || !exactKeys(c, ['number', 'dependsOn', 'text', 'partIds'])) { errors.push('权利要求编号或字段无效。'); continue; }
    if (i === 0 ? c.dependsOn !== null : !Number.isInteger(c.dependsOn) || c.dependsOn < 1 || c.dependsOn >= c.number) errors.push(`权利要求${i + 1}引用无效。`);
    const mentions = [...c.text.matchAll(/权利要求\s*(\d+)/g)].map(m => Number(m[1]));
    if (i > 0 && (!new RegExp(`根据权利要求\\s*${c.dependsOn}\\s*所述`).test(c.text) || mentions.some(n => n !== c.dependsOn))) errors.push(`权利要求${i + 1}文字引用与dependsOn不一致。`);
    if ((c.text.match(/。/g) || []).length !== 1 || !c.text.endsWith('。')) errors.push(`权利要求${i + 1}仅在结尾使用一个句号。`);
    const markers = [...c.text.matchAll(/[（(](\d+)[）)]/g)].map(m => m[1]);
    if (!strings(c.partIds) || !c.partIds.length || new Set(c.partIds).size !== c.partIds.length || c.partIds.some(n => !ids.has(n)) || !same([...new Set(markers)].sort(), [...c.partIds].sort())) errors.push(`权利要求${i + 1}的partIds须与正文标号对应。`);
  }
  const body = [d.abstract, d.technicalField, d.background, d.technicalProblem, d.solution, ...list(d.benefits), d.embodiment, d.operation, ...claims.map(c => c?.text)].join('\n');
  if (/如图\s*[一二三四五六七八九十\d]|图\s*\d+|附图说明/.test(body)) errors.push('文本阶段不得虚构图号；附图说明由原附图模块提供。');
  for (const match of body.matchAll(/([^\s，。；：、（）()]{1,80})[（(](\d+)[）)]/g)) {
    const part = plan.parts.find(p => p.id === match[2]);
    if (!part) { errors.push(`未知结构标号${match[2]}。`); continue; }
    if (![part.name, part.form?.name].filter(Boolean).some(name => match[1].endsWith(name!))) errors.push(`标号${part.id}前须使用登记名称“${part.name}”或有依据的具体形式名称。`);
  }
  for (const m of body.matchAll(/[（(](\d+)[）)]/g)) if (!ids.has(m[1])) errors.push(`未知结构标号${m[1]}。`);
  return [...new Set(errors)];
}

export function applyTextPatches<T>(original: T, patches: unknown, roots: readonly string[]): T {
  if (!Array.isArray(patches) || patches.length > 80) throw new Error('补丁列表无效。');
  const result: any = structuredClone(original);
  for (const p of patches) {
    if (!object(p) || !['add', 'replace', 'remove'].includes(p.op) || typeof p.path !== 'string' || !p.path.startsWith('/') || /~(?:[^01]|$)/.test(p.path)) throw new Error('补丁操作或JSON Pointer无效。');
    const keys = p.path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!roots.includes(keys[0]) || keys.some(k => !k || ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('补丁字段范围不允许；parts只能使用partEdits。');
    let parent = result;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key) || (Array.isArray(parent) && !/^(0|[1-9]\d*)$/.test(key))) throw new Error('补丁路径不存在。');
      parent = parent[key];
    }
    if (!parent || typeof parent !== 'object') throw new Error('补丁父节点无效。');
    const key = keys.at(-1)!;
    if (p.op !== 'remove' && !Object.hasOwn(p, 'value')) throw new Error('缺少补丁值。');
    if (Array.isArray(parent)) {
      const i = key === '-' && p.op === 'add' ? parent.length : /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
      if (!Number.isSafeInteger(i) || i < 0 || i > parent.length || (p.op !== 'add' && i === parent.length)) throw new Error('补丁数组位置越界。');
      if (p.op === 'add') parent.splice(i, 0, structuredClone(p.value));
      else if (p.op === 'remove') parent.splice(i, 1);
      else parent[i] = structuredClone(p.value);
    } else {
      if (p.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error('补丁字段不存在。');
      if (p.op === 'remove') delete parent[key]; else parent[key] = structuredClone(p.value);
    }
  }
  return result;
}
export function checkReviewEnvelope(value: unknown, structure = false): string[] {
  if (!object(value) || !exactKeys(value, ['patches', 'findings', 'unresolved', ...(structure ? ['partEdits'] : [])]) || !Array.isArray(value.patches) ||
    !Array.isArray(value.findings) || value.findings.some(f => !fields(f, ['location', 'issue', 'resolution']) || !exactKeys(f, ['location', 'issue', 'resolution'])) || !strings(value.unresolved) ||
    (structure && !Array.isArray(value.partEdits))) return ['复核结果须包含修改、发现记录和未解决问题数组。'];
  return [];
}
export function applyTechnicalReview(original: TechnicalPlan, value: unknown): TechnicalPlan {
  const envelopeErrors = checkReviewEnvelope(value, true);
  if (envelopeErrors.length) throw new Error(envelopeErrors.join('；'));
  const review = value as StructureReview, result = structuredClone(original);
  const byId = new Map(result.parts.map(p => [p.id, p])), edited = new Set<string>();
  if (byId.size !== result.parts.length || review.partEdits.length > 80) throw new Error('部件编号重复或修改条数超限。');
  for (const edit of review.partEdits) {
    if (!object(edit) || !id(edit.partId) || !text(edit.partName) || !['add', 'update', 'remove'].includes(edit.op) || edited.has(edit.partId)) throw new Error('部件修改编号、名称、操作无效或重复修改。');
    edited.add(edit.partId);
    const target = byId.get(edit.partId);
    if (edit.op === 'add') {
      if (target) throw new Error(`新增编号${edit.partId}已占用。`);
      if (!object(edit.value) || edit.value.id !== edit.partId || edit.value.name !== edit.partName || !exactKeys(edit.value, ['id', ...partFields])) throw new Error('新增部件完整value与编号、名称不一致。');
      result.parts.push(structuredClone(edit.value)); continue;
    }
    if (!target || target.name !== edit.partName) throw new Error(`部件${edit.partId}编号与原名称不匹配；整轮未应用。`);
    if (edit.op === 'remove') { result.parts = result.parts.filter(p => p.id !== edit.partId); continue; }
    if (!object(edit.changes) || !Object.keys(edit.changes).length || !exactKeys(edit.changes, partFields)) throw new Error('changes不能修改编号，只允许部件内容字段。');
    Object.assign(target, structuredClone(edit.changes));
  }
  const patched = applyTextPatches(result, review.patches, planFields.filter(k => !['parts', 'schemaVersion', 'title', 'problem', 'goal', 'scenario'].includes(k)));
  const errors = checkTechnicalPlan(patched);
  // Renames must update references in technical prose too. A name belonging to a
  // second identity is never treated as an arbitrary synonym for this part.
  for (const old of original.parts) {
    const next = patched.parts.find(p => p.id === old.id);
    if (next && next.name !== old.name && next.form?.name !== old.name) {
      const relationships = JSON.stringify(select(patched, ['connections', 'coreActions', 'workingSteps', 'improvements', 'claimPlan']));
      if (relationships.replaceAll(next.name, '').includes(old.name)) errors.push(`部件${old.id}改名后仍有旧术语“${old.name}”，须同步关联描述。`);
    }
  }
  if (errors.length) throw new Error(errors.join('；'));
  return patched;
}
export function applyDocumentReview(original: TextDocument, review: unknown, plan: Pick<TechnicalPlan, 'title' | 'parts'>): TextDocument {
  const errors = checkReviewEnvelope(review);
  if (errors.length) throw new Error(errors.join('；'));
  const result = applyTextPatches(original, (review as TextReview).patches, documentFields);
  const failures = checkTextDocument(result, plan);
  if (failures.length) throw new Error(failures.join('；'));
  return documentForWriting(result);
}
export function isTextStructure(v: unknown): v is TextStructure {
  return fields(v, ['reviewId', 'rulesVersion', 'createdAt', 'signature']) && !checkTechnicalPlan(v.plan).length;
}
export function isTextDraft(v: unknown): v is TextDraft {
  return fields(v, ['briefId', 'sourceVersion', 'createdAt', 'signature']) && isDocumentShape(v.document);
}
function isDocumentShape(v: unknown): v is TextDocument {
  return fields(v, documentFields.filter(k => !['benefits', 'claims'].includes(k))) && exactKeys(v, documentFields) && strings(v.benefits) && v.benefits.length > 0 &&
    Array.isArray(v.claims) && v.claims.length > 0 && v.claims.every(c => fields(c, ['text']) && Number.isInteger(c.number) && (c.dependsOn === null || Number.isInteger(c.dependsOn)) && strings(c.partIds));
}
export function isFrozenTechnicalSource(v: unknown): v is FrozenTechnicalSource {
  if (!fields(v, ['version']) || !/^[a-f0-9]{64}$/.test(v.version) || checkTechnicalPlan(v.initialPlan).length || checkTechnicalPlan(v.plan).length) return false;
  if (v.rulesVersion !== undefined && !['2026-10-14-v1', TEXT_RULES_VERSION].includes(v.rulesVersion)) return false;
  try { return !v.review.unresolved.length && same(applyTechnicalReview(v.initialPlan, v.review), v.plan) && v.version === frozenSourceVersion(v as FrozenTechnicalSource); } catch { return false; }
}
export function isTextRecord(v: unknown): v is TextRecord {
  if (!fields(v, ['sourceVersion']) || !['completed', 'needs_review'].includes(v.status) || checkReviewEnvelope(v.review).length || !isDocumentShape(v.draft) || !isDocumentShape(v.document)) return false;
  try { return v.status === (v.review.unresolved.length ? 'needs_review' : 'completed') && same(applyTextPatches(v.draft, v.review.patches, documentFields), v.document); } catch { return false; }
}
