import { callJSON } from './ai.mjs';
import * as prompts from './prompts.mjs';
import { checkStructureDetails, planForWriting, documentForWriting } from './structure.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(text);
const list = value => Array.isArray(value) ? value : [];

export function checkProblems(value) {
  const items = list(value?.problems);
  if (!text(value?.scenario) || items.length < 3 || items.length > 6) return ['需要具体应用场景和3至6个候选问题。'];
  const ids = new Set();
  for (const item of items) {
    if (!item || !['id', 'title', 'problem', 'goal', 'approach'].every(k => text(item[k])) || ids.has(item.id)) return ['候选问题字段缺失或编号重复。'];
    ids.add(item.id);
  }
  return [];
}

export function checkPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['缺少结构方案。'];
  for (const key of ['title', 'scenario', 'problem', 'goal']) if (!text(plan[key])) errors.push(`结构方案缺少${key}。`);
  for (const key of ['assumptions', 'verificationNeeds']) if (!strings(plan[key])) errors.push(`${key}必须是文字数组。`);
  const parts = list(plan.parts);
  if (parts.length < 1 || parts.length > 30) errors.push('部件及结构特征数量必须为1至30项，按实际需要确定。');
  const ids = new Set();
  const names = new Set();
  for (const part of parts) {
    if (!part || !['id', 'name', 'role', 'position', 'motion'].every(k => text(part[k]))) { errors.push('零件缺少名称、位置、作用或运动状态。'); continue; }
    if (!/^[1-9]\d*$/.test(part.id) || !Number.isSafeInteger(Number(part.id))) errors.push('部件编号应为正整数字符串。');
    if (ids.has(part.id) || names.has(part.name)) errors.push('零件编号或名称重复。');
    ids.add(part.id); names.add(part.name);
  }
  const graph = new Map([...ids].map(id => [id, new Set()]));
  for (const p of parts) {
    if (p && ids.has(p.id) && ids.has(p.parentId) && p.id !== p.parentId) {
      graph.get(p.id).add(p.parentId); graph.get(p.parentId).add(p.id);
    }
  }
  for (const c of list(plan.connections)) {
    if (!c || !ids.has(c.from) || !ids.has(c.to) || c.from === c.to || !text(c.type) || !text(c.detail)) { errors.push('连接关系引用不存在的零件或缺少具体连接方式。'); continue; }
    graph.get(c.from).add(c.to); graph.get(c.to).add(c.from);
  }
  const visited = new Set();
  const queue = ids.size ? [ids.values().next().value] : [];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    queue.push(...(graph.get(id) || []));
  }
  if (visited.size !== ids.size) errors.push('有零件未通过连接关系接入整机。');
  function refs(items, fields, label) {
    if (!Array.isArray(items) || !items.length) { errors.push(`缺少${label}。`); return; }
    for (const item of items) if (!item || !fields.every(k => text(item[k])) || !Array.isArray(item.partIds) || !item.partIds.length || item.partIds.some(id => !ids.has(id))) errors.push(`${label}内容不完整或引用未知零件。`);
  }
  refs(plan.workingSteps, ['step'], '工作过程');
  refs(plan.improvements, ['mechanism', 'effect'], '结构与效果对应关系');
  errors.push(...checkStructureDetails(plan));
  return [...new Set(errors)];
}

export function checkDocument(doc, plan) {
  if (!doc || typeof doc !== 'object') return ['缺少专利正文。'];
  const errors = [];
  for (const k of ['title', 'abstract', 'technicalField', 'background', 'technicalProblem', 'solution', 'embodiment', 'operation']) if (!text(doc[k])) errors.push(`正文缺少${k}。`);
  if (doc.title !== plan.title) errors.push('正文名称与结构方案不一致。');
  if (typeof doc.abstract === 'string' && [...doc.abstract].length > 300) errors.push('摘要超过300个字符。');
  if (!strings(doc.benefits) || !doc.benefits.length) errors.push('缺少有益效果。');
  const claims = list(doc.claims), ids = new Set(plan.parts.map(p => p.id));
  if (claims.length < 2 || claims.length > 10) errors.push('权利要求应有1项独立项及适量从属项，总数2至10项。');
  for (const [index, claim] of claims.entries()) {
    if (!claim || claim.number !== index + 1 || !text(claim.text)) { errors.push('权利要求编号或正文不完整。'); continue; }
    if (index === 0 ? claim.dependsOn !== null : !Number.isInteger(claim.dependsOn) || claim.dependsOn < 1 || claim.dependsOn >= claim.number) errors.push(`权利要求${index + 1}引用关系无效。`);
    if (index > 0 && !new RegExp(`根据权利要求\\s*${claim.dependsOn}\\s*所述`).test(claim.text)) errors.push(`权利要求${index + 1}文字引用与引用编号不一致。`);
    if (!Array.isArray(claim.partIds) || !claim.partIds.length || claim.partIds.some(id => !ids.has(id))) errors.push(`权利要求${index + 1}缺少有效的零件依据。`);
    if ((claim.text.match(/。/g) || []).length !== 1 || !claim.text.endsWith('。')) errors.push(`权利要求${index + 1}应仅在结尾使用一个句号。`);
  }
  const body = [doc.abstract, doc.technicalField, doc.background, doc.technicalProblem, doc.solution, ...list(doc.benefits), doc.embodiment, doc.operation, ...claims.map(c => c?.text)].join('\n');
  if (/如图\s*[一二三四五六七八九十\d]|图\s*\d+|附图说明/.test(body)) errors.push('纯文本版本出现了不存在的附图引用。');
  for (const match of body.matchAll(/[（(](\d+)[）)]/g)) if (!ids.has(match[1])) errors.push(`正文使用了未知零件标号${match[1]}。`);
  for (const part of plan.parts) {
    const escaped = part.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of body.matchAll(new RegExp(`([^\\s，。；：、（）()]{1,30})[（(]${escaped}[）)]`, 'g'))) {
      if (!m[1].endsWith(part.name)) errors.push(`标号${part.id}前的名称与零件表“${part.name}”不一致。`);
    }
  }
  return [...new Set(errors)];
}

export function applyPatches(original, patches) {
  if (!Array.isArray(patches) || patches.length > 80) throw new Error('修改列表格式错误。');
  const result = structuredClone(original);
  for (const patch of patches) {
    if (!patch || !['add', 'replace', 'remove'].includes(patch.op) || typeof patch.path !== 'string' || !patch.path.startsWith('/')) throw new Error('修改操作或路径格式错误。');
    const keys = patch.path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (keys.some(k => !k || ['__proto__', 'prototype', 'constructor'].includes(k)) || !Object.hasOwn(result, keys[0])) throw new Error('修改路径不允许。');
    let parent = result;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('修改路径不存在。');
      parent = parent[key];
    }
    if (!parent || typeof parent !== 'object') throw new Error('修改路径的父节点无效。');
    const key = keys.at(-1);
    if (patch.op !== 'remove' && !Object.hasOwn(patch, 'value')) throw new Error('修改内容缺失。');
    if (Array.isArray(parent)) {
      const index = key === '-' && patch.op === 'add' ? parent.length : /^\d+$/.test(key) ? Number(key) : -1;
      if (index < 0 || index > parent.length || (patch.op !== 'add' && index === parent.length)) throw new Error('数组修改位置越界。');
      if (patch.op === 'add') parent.splice(index, 0, structuredClone(patch.value));
      else if (patch.op === 'remove') parent.splice(index, 1);
      else parent[index] = structuredClone(patch.value);
    } else {
      if (patch.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error('被修改的字段不存在。');
      if (patch.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(patch.value);
    }
  }
  return result;
}

// Resolve structural edits by identity, never by a model-supplied array offset.
// General JSON patches cannot replace parts or touch any descendant of parts.
export function applyStructureReview(original, review) {
  if (!Array.isArray(original?.parts) || !Array.isArray(review?.partEdits) || review.partEdits.length > 80 || !Array.isArray(review.patches)) {
    throw new Error('结构修改须包含partEdits和patches数组；部件修改使用编号和名称定位。');
  }
  for (const patch of review.patches) {
    const top = typeof patch?.path === 'string' ? patch.path.split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~') : undefined;
    if (top === 'parts') throw new Error('禁止通过数组下标或整体替换修改parts；请使用partEdits中的partId和partName。');
  }
  const result = structuredClone(original);
  const byId = new Map(result.parts.map(p => [p.id, p]));
  if (byId.size !== result.parts.length) throw new Error('原方案部件编号重复，无法定位修改对象。');
  const edited = new Set();
  const fields = new Set(['name', 'kind', 'parentId', 'importance', 'necessity', 'role', 'position', 'motion']);
  for (const edit of review.partEdits) {
    if (!edit || !['update', 'add', 'remove'].includes(edit.op) || typeof edit.partId !== 'string' || !/^[1-9]\d*$/.test(edit.partId) || !Number.isSafeInteger(Number(edit.partId)) || !text(edit.partName)) {
      throw new Error('部件修改需提供操作、partId编号和partName名称。');
    }
    if (edited.has(edit.partId)) throw new Error(`部件${edit.partId}重复修改，请将字段合并到同一条partEdits中。`);
    edited.add(edit.partId);
    const target = byId.get(edit.partId);
    if (edit.op === 'add') {
      if (target) throw new Error(`新增编号${edit.partId}已存在，不得覆盖现有部件。`);
      if (!edit.value || Array.isArray(edit.value) || edit.value.id !== edit.partId || edit.value.name !== edit.partName || Object.keys(edit.value).some(key => key !== 'id' && !fields.has(key))) {
        throw new Error('新增部件的完整value必须与partId、partName一致，且仅包含部件字段。');
      }
      result.parts.push(structuredClone(edit.value));
      byId.set(edit.partId, result.parts.at(-1));
      continue;
    }
    if (!target) throw new Error(`未找到编号${edit.partId}的部件，不接受数组位置作为编号。`);
    if (target.name !== edit.partName) throw new Error(`部件${edit.partId}名称应为“${target.name}”，与“${edit.partName}”不符；未应用本轮修改。`);
    if (edit.op === 'remove') {
      result.parts = result.parts.filter(part => part.id !== edit.partId);
      // Keep byId reserved so this review cannot re-use a removed identity.
      continue;
    }
    if (!edit.changes || Array.isArray(edit.changes) || typeof edit.changes !== 'object' || !Object.keys(edit.changes).length || Object.keys(edit.changes).some(key => !fields.has(key))) {
      throw new Error('changes只允许修改部件内容字段，不得修改编号或使用字段路径。');
    }
    Object.assign(target, structuredClone(edit.changes));
  }
  return applyPatches(result, review.patches);
}

function checkReview(value, kind, plan, original) {
  let updated;
  try { updated = kind === 'plan' ? applyStructureReview(original, value) : applyPatches(original, value?.patches); } catch (error) { return [error.message]; }
  const errors = kind === 'plan' ? checkPlan(updated) : checkDocument(updated, plan);
  if (!Array.isArray(value?.findings) || value.findings.some(f => !f || !['location', 'issue', 'resolution'].every(k => text(f[k])))) errors.push('审查记录字段不完整。');
  if (!strings(value?.unresolved)) errors.push('缺少未解决问题清单。');
  return errors;
}

async function generate(config, system, input, validate, options = {}) {
  let correction;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callJSON(config, { system, input: correction ? { ...input, correction } : input, ...options });
    const errors = validate(result.value);
    if (!errors.length) return result;
    correction = { errors, previousOutput: result.value, instruction: '仅修正这些格式或一致性问题，返回完整结果。' };
    options.onRepair?.(errors);
  }
  throw new Error(`生成结果仍未通过检查：${correction.errors.slice(0, 3).join('；')}`);
}

export async function generateProblems(config, product, signal) {
  return (await generate(config, prompts.PROBLEMS, { product }, checkProblems, { signal, maxTokens: 2500 })).value;
}

export const STAGES = [
  { id: 'structure', label: '确定核心方案、部件和结构关系' },
  { id: 'structureReview', label: '检查结构并自动修正' },
  { id: 'draft', label: '生成权利要求、说明书和摘要' },
  { id: 'textReview', label: '核对术语、保护依据和文本规范' },
];

export async function runPipeline(config, job, signal, update) {
  const common = { product: job.product, scenario: job.scenario, selectedProblem: job.problem };
  async function stage(id, prompt, input, validator, maxTokens) {
    signal.throwIfAborted();
    job.stage = id; job.progressChars = 0;
    update(`正在${STAGES.find(s => s.id === id).label}`);
    let lastTick = 0;
    const result = await generate(config, prompt, input, validator, { signal, maxTokens,
      onProvider: model => { job.model = model; update(); },
      onActivity: count => { job.progressChars = count; if (Date.now() - lastTick > 1500) { lastTick = Date.now(); update(); } },
      onRepair: errors => update(`自动修正：${errors.slice(0, 2).join('；')}`),
      onWarning: warning => update(`${warning} 正在尝试可用模型。`),
    });
    return result.value;
  }
  if (!job.initialPlan) job.initialPlan = await stage('structure', prompts.PLAN, common, value => [
    ...(value?.schemaVersion === 2 ? [] : ['新方案应使用schemaVersion 2，包含核心动作和保护取舍。']),
    ...checkPlan(value),
  ], 9000);
  update();
  if (!job.structureReview) {
    job.structureReview = await stage('structureReview', prompts.PLAN_REVIEW, { ...common, plan: job.initialPlan }, v => checkReview(v, 'plan', null, job.initialPlan), 5000);
    job.structureReview.plan = applyStructureReview(job.initialPlan, job.structureReview);
  }
  job.plan = job.structureReview.plan;
  update();
  if (job.structureReview.unresolved.length) {
    // Keep the proposed plan for inspection; never draft on a known unresolved structure.
    const issues = [...job.structureReview.unresolved];
    delete job.structureReview;
    job.initialPlan = job.plan;
    throw new Error(`结构仍有待解决问题：${issues.join('；')}。可点击重试继续修正。`);
  }
  const writingPlan = planForWriting(job.plan);
  if (!job.draft) job.draft = documentForWriting(await stage('draft', prompts.DRAFT, { ...common, plan: writingPlan }, v => checkDocument(v, job.plan), 11000));
  update();
  if (!job.textReview) {
    const writingDraft = documentForWriting(job.draft);
    job.textReview = await stage('textReview', prompts.TEXT_REVIEW, { ...common, plan: writingPlan, document: writingDraft }, v => checkReview(v, 'document', job.plan, writingDraft), 8000);
    job.textReview.document = documentForWriting(applyPatches(writingDraft, job.textReview.patches));
  }
  job.document = job.textReview.document;
  job.status = job.textReview.unresolved.length ? 'needs_review' : 'completed';
  job.stage = 'done'; job.progressChars = 0;
  update(job.status === 'completed' ? '文本草稿已生成，结构与文字检查已完成。' : '草稿已生成，仍有文本问题需查看审查记录。');
}

export function formatDocument(doc) {
  return `${doc.title}\n\n说明书摘要\n\n${doc.abstract}\n\n权利要求书\n\n${doc.claims.map(c => `${c.number}. ${c.text}`).join('\n\n')}\n\n说明书\n\n${doc.title}\n\n技术领域\n${doc.technicalField}\n\n背景技术\n${doc.background}\n\n实用新型内容\n${doc.technicalProblem}\n\n${doc.solution}\n\n${doc.benefits.join('\n\n')}\n\n具体实施方式\n${doc.embodiment}\n\n${doc.operation}\n`;
}
