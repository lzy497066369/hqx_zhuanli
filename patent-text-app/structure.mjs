// Version 2 enriches the technical source. Existing version 1 jobs stay readable.
export const FEATURE_KINDS = ['part', 'assembly', 'region', 'opening', 'surface'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const array = value => Array.isArray(value) ? value : [];
const select = (source, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(source || {}, key)).map(key => [key, structuredClone(source[key])]));

export function checkStructureDetails(plan) {
  if (plan.schemaVersion !== 2) return [];
  const errors = [], parts = array(plan.parts);
  const ids = new Set(parts.map(p => p?.id)), byId = new Map(parts.map(p => [p?.id, p]));
  const validRefs = refs => Array.isArray(refs) && refs.length > 0 && refs.every(id => ids.has(id));
  for (const p of parts) {
    if (!p || !FEATURE_KINDS.includes(p.kind) || !['core', 'support'].includes(p.importance) || !nonempty(p.necessity)) { errors.push('每项结构需明确类型、核心或配套归属及保留理由。'); continue; }
    if (p.parentId !== null && (!ids.has(p.parentId) || p.parentId === p.id)) errors.push(`结构${p.id}的所属编号无效。`);
    if (['region', 'opening', 'surface'].includes(p.kind) && p.parentId === null) errors.push(`结构${p.id}为局部特征，必须明确所属部件。`);
    const ancestors = new Set([p.id]);
    let parent = p.parentId;
    while (parent != null && ids.has(parent)) {
      if (ancestors.has(parent)) { errors.push('结构所属关系不能循环。'); break; }
      ancestors.add(parent); parent = byId.get(parent)?.parentId;
    }
  }
  if (!nonempty(plan.focus?.improvement) || !nonempty(plan.focus?.boundary) || !validRefs(plan.focus?.corePartIds)) errors.push('缺少核心改进、方案边界或关联结构。');
  if (validRefs(plan.focus?.corePartIds) && plan.focus.corePartIds.some(id => byId.get(id)?.importance !== 'core')) errors.push('核心改进引用的结构应标记为core。');
  if (!array(plan.coreActions).length) errors.push('缺少核心动作或静态配合依据。');
  for (const action of array(plan.coreActions)) {
    if (!action || !['name', 'trigger', 'before', 'constraint', 'after', 'clearance', 'basis'].every(k => nonempty(action[k])) || !validRefs(action.partIds) || !Array.isArray(action.sequence) || !action.sequence.length || !action.sequence.every(nonempty)) errors.push('核心动作需含触发、前后状态、约束、过程、避让或通路及结构依据。');
  }
  if (!nonempty(plan.claimPlan?.focus)) errors.push('缺少保护方案的核心组合。');
  for (const group of ['independent', 'dependent', 'embodimentOnly']) {
    const items = plan.claimPlan?.[group];
    if (!Array.isArray(items) || (group === 'independent' && !items.length)) { errors.push(`缺少权利要求取舍记录${group}。`); continue; }
    if (items.some(item => !item || !nonempty(item.feature) || !nonempty(item.reason) || !validRefs(item.partIds))) errors.push(`${group}中的特征需有对应结构及取舍理由。`);
  }
  return [...new Set(errors)];
}

// Deliberately omit assumptions/verification tasks and private notes from writer inputs.
// Do not strip words out of technical sentences: missing design information needs design work.
export function planForWriting(plan) {
  const result = select(plan, ['schemaVersion', 'title', 'scenario', 'problem', 'goal']);
  if (plan.focus) result.focus = select(plan.focus, ['improvement', 'corePartIds']);
  result.parts = array(plan.parts).map(p => select(p, ['id', 'name', 'kind', 'parentId', 'importance', 'role', 'position', 'motion']));
  result.connections = array(plan.connections).map(c => select(c, ['from', 'to', 'type', 'detail']));
  result.workingSteps = array(plan.workingSteps).map(s => select(s, ['step', 'partIds']));
  result.improvements = array(plan.improvements).map(i => select(i, ['partIds', 'mechanism', 'effect']));
  if (plan.coreActions) result.coreActions = plan.coreActions.map(a => select(a, ['name', 'partIds', 'trigger', 'before', 'constraint', 'sequence', 'after', 'clearance', 'basis']));
  if (plan.claimPlan) {
    result.claimPlan = { focus: plan.claimPlan.focus };
    for (const group of ['independent', 'dependent', 'embodimentOnly']) result.claimPlan[group] = array(plan.claimPlan[group]).map(f => select(f, ['feature', 'partIds']));
  }
  return result;
}

export function documentForWriting(document) {
  const result = select(document, ['title', 'abstract', 'technicalField', 'background', 'technicalProblem', 'solution', 'benefits', 'embodiment', 'operation']);
  result.claims = array(document.claims).map(c => select(c, ['number', 'dependsOn', 'text', 'partIds']));
  return result;
}
