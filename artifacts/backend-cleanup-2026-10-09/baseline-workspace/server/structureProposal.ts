import type { StructureDraft } from '../src/features/utility/structureDraft.ts';
import type { PatentGeometry } from '../src/features/utility/patentStructure.ts';
import { isPatentGeometry } from '../src/features/utility/patentStructure.ts';

const relations = new Set(['connected_to', 'fixed_to', 'slidably_connected', 'rotatably_connected', 'driven_by', 'supported_by', 'limited_by']);
const movingPart = /叶轮|风轮|转轴|传动轴|输入轴|输出轴|太阳轮|行星轮|行星架|刷辊|旋转架|转盘|滚轮|滑轴|滑杆|滑块|滑座|推杆|移动架|阀芯|阀杆|活塞|柱塞/u;
const stationarySupport = /壳体|阀体|箱体|外壳|底座|固定座|固定架|固定内齿圈|机架|导向套|导向座|轴承座|固定套|阀盖|支架|支撑架/u;
const text = (value: unknown, limit = 300): value is string => typeof value === 'string' && !!value.trim() && value.length <= limit;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (prefix: string, index: number) => `${prefix}${String(index + 1).padStart(2, '0')}`;

function needsMotion(name: string, relationships: unknown[]) {
  // A sliding/rotating connection describes relative motion, not which endpoint
  // moves. Only explicit motion semantics or a directed driven_by edge can
  // require a motion record; fixed guides and covers must remain stationary.
  return movingPart.test(name) || (!stationarySupport.test(name) && !/^(?:驱动)?电机$/u.test(name) && relationships.some(relationship => record(relationship) &&
    relationship.relation === 'driven_by' && relationship.from === name));
}

function motionErrors(motion: unknown, path: string, part: (name: unknown) => boolean): string[] {
  if (!record(motion)) return [`${path} 须为对象。`];
  const errors: string[] = [];
  if (!part(motion.component)) errors.push(`${path}.component 须逐字引用 components 中已有部件。`);
  if (!['static', 'rotary', 'linear'].includes(String(motion.type))) errors.push(`${path}.type 只能填写 static、rotary 或 linear。`);
  if (!text(motion.path)) errors.push(`${path}.path 须填写运动轨迹或固定状态。`);
  if (!text(motion.purpose)) errors.push(`${path}.purpose 须填写运动或固定作用。`);
  if (motion.type === 'static') {
    if (motion.drivenBy !== undefined) errors.push(`${path}.drivenBy：static 部件不应填写驱动部件。`);
  } else if (!part(motion.drivenBy)) {
    errors.push(`${path}.drivenBy：非static运动的drivenBy必须逐字引用另一个已有部件。`);
  } else if (motion.drivenBy === motion.component) {
    errors.push(`${path}.drivenBy 不能指向自身，必须填写非自身驱动部件。`);
  }
  return errors;
}

export function proposalValidationErrors(value: unknown): string[] {
  if (!record(value)) return ['proposal 必须是对象。'];
  const errors: string[] = [];
  if (value.version !== 1) errors.push('proposal.version 必须为 1。');
  for (const key of ['model', 'modelId', 'modelVersion', 'title', 'improvementType', 'nextDraftNumber', 'nextModelNumber'])
    if (key in value) errors.push(`proposal 不得包含 ${key}，名称和编号由服务端生成。`);
  for (const [key, limit] of [['technicalField', 300], ['baseStructure', 3000], ['problemSolved', 1500], ['workingPrinciple', 3000]] as const)
    if (!text(value[key], limit)) errors.push(`proposal.${key} 须为非空字符串（最多 ${limit} 字）。`);
  if (!Array.isArray(value.innovationPoints) || !value.innovationPoints.length || !value.innovationPoints.every(point => text(point))) errors.push('proposal.innovationPoints 须为非空字符串数组。');
  if (!Array.isArray(value.components) || value.components.length < 2 || value.components.length > 30) errors.push('proposal.components 须包含 2 至 30 个部件。');
  else {
    const names = new Set<string>();
    value.components.forEach((component, index) => {
      const path = `components[${index}]`;
      if (!record(component)) { errors.push(`${path} 须为对象。`); return; }
      if (['id', 'modelId', 'parentId'].some(key => key in component)) errors.push(`${path} 不得包含 ID 或父部件编号。`);
      if (!text(component.name, 40)) errors.push(`${path}.name 须为非空字符串（最多 40 字）。`);
      else if (names.has(component.name.trim())) errors.push(`${path}.name 与其他部件重复。`);
      else names.add(component.name.trim());
      if (!['base', 'innovation'].includes(String(component.kind))) errors.push(`${path}.kind 须为 base 或 innovation。`);
      for (const key of ['purpose', 'position', 'whyNeeded']) if (!text(component[key])) errors.push(`${path}.${key} 须为非空字符串。`);
      if (component.visualFeature !== undefined && !text(component.visualFeature)) errors.push(`${path}.visualFeature 须为有效的外观特征。`);
      if (!isPatentGeometry(component.geometry)) errors.push(`${path}.geometry 须为受支持的参数化几何，并填写合法位置、尺寸及旋转。`);
    });
  }
  const names = Array.isArray(value.components) ? value.components.filter(record).map(component => typeof component.name === 'string' ? component.name.trim() : '') : [];
  const part = (name: unknown) => typeof name === 'string' && names.includes(name.trim());
  if (!Array.isArray(value.relationships) || value.relationships.length < 1 || value.relationships.length > 80) errors.push('proposal.relationships 须包含 1 至 80 条连接。');
  else value.relationships.forEach((relationship, index) => {
    const path = `relationships[${index}]`;
    if (!record(relationship)) { errors.push(`${path} 须为对象。`); return; }
    const invalid = [!part(relationship.from) ? `from=${JSON.stringify(relationship.from)}` : '',
      !part(relationship.to) ? `to=${JSON.stringify(relationship.to)}` : '',
      relationship.from === relationship.to ? 'from/to 相同' : '',
      !relations.has(String(relationship.relation)) ? `relation=${JSON.stringify(relationship.relation)}` : '',
      !text(relationship.description) ? 'description 缺失' : ''].filter(Boolean);
    if (invalid.length) errors.push(`${path} 无效：${invalid.join('、')}；端点必须逐字引用两个不同的已有部件。`);
  });
  if (!Array.isArray(value.motions) || value.motions.length > 30) errors.push('proposal.motions 须为最多 30 条运动记录的数组。');
  else {
    const seen = new Set<unknown>();
    value.motions.forEach((motion, index) => {
      const path = `motions[${index}]`;
      const fieldErrors = motionErrors(motion, path, part);
      errors.push(...fieldErrors);
      if (record(motion) && part(motion.component)) {
        if (seen.has(motion.component)) errors.push(`${path}.component 不得重复。`);
        else seen.add(motion.component);
      }
    });
    const missing = names.filter(name => !seen.has(name) && needsMotion(name, Array.isArray(value.relationships) ? value.relationships : []));
    if (missing.length) errors.push(`运动部件或带运动连接的部件缺少 motions 记录及驱动部件：${missing.join('、')}。`);
  }
  return errors.slice(0, 12);
}

// Only a fully specified proposal is expanded. Never guess a connection, driver or geometry.
export function expandStructureProposal(value: unknown, title: string): StructureDraft | undefined {
  if (record(value) && (['model', 'modelId', 'modelVersion', 'title', 'improvementType', 'nextDraftNumber', 'nextModelNumber'].some(key => key in value))) return undefined;
  if (!record(value) || value.version !== 1 || !Array.isArray(value.components) || value.components.length < 2 || value.components.length > 30 ||
      !Array.isArray(value.relationships) || value.relationships.length < 1 || value.relationships.length > 80 ||
      !Array.isArray(value.motions) || value.motions.length > 30 || !Array.isArray(value.innovationPoints) ||
      !value.innovationPoints.length || !value.innovationPoints.every(point => text(point)) ||
      !text(value.technicalField) || !text(value.baseStructure, 3000) || !text(value.problemSolved, 1500) || !text(value.workingPrinciple, 3000)) return undefined;
  const components = value.components;
  const relationships = value.relationships as Record<string, unknown>[];
  if (!components.every((component: unknown) => record(component) && !['id', 'modelId', 'parentId'].some(key => key in component) && text(component.name, 40) && text(component.purpose) && text(component.position) && text(component.whyNeeded) &&
      ['base', 'innovation'].includes(String(component.kind)) && (component.visualFeature === undefined || text(component.visualFeature)) && isPatentGeometry(component.geometry))) return undefined;
  const names = components.map((component: Record<string, unknown>) => (component.name as string).trim());
  if (new Set(names).size !== names.length) return undefined;
  const indexOf = (name: unknown) => typeof name === 'string' ? names.indexOf(name.trim()) : -1;
  if (!relationships.every((relationship: unknown) => record(relationship) && indexOf(relationship.from) >= 0 && indexOf(relationship.to) >= 0 &&
      relationship.from !== relationship.to && relations.has(String(relationship.relation)) && text(relationship.description))) return undefined;
  if (!value.motions.every((motion: unknown) => record(motion) && indexOf(motion.component) >= 0 && ['static', 'rotary', 'linear'].includes(String(motion.type)) &&
      text(motion.path) && text(motion.purpose) && (motion.type === 'static' ? motion.drivenBy === undefined : indexOf(motion.drivenBy) >= 0 && motion.drivenBy !== motion.component))) return undefined;
  const motions = value.motions as Record<string, unknown>[];
  if (new Set(motions.map(motion => motion.component)).size !== motions.length) return undefined;
  const missing = names.filter(name => !motions.some(motion => motion.component === name));
  if (missing.some(name => needsMotion(name, relationships))) return undefined;
  return {
    version: 1, title, technicalField: value.technicalField, baseStructure: value.baseStructure,
    components: components.map((component: Record<string, unknown>, index: number) => ({ id: id('D', index), name: (component.name as string).trim(), kind: component.kind as 'base' | 'innovation', purpose: component.purpose as string, position: component.position as string, whyNeeded: component.whyNeeded as string, ...(component.visualFeature ? { visualFeature: component.visualFeature as string } : {}), geometry: component.geometry as PatentGeometry })),
    relationships: relationships.map((relationship: Record<string, unknown>, index: number) => ({ id: id('R', index), from: id('D', indexOf(relationship.from)), to: id('D', indexOf(relationship.to)), relation: relationship.relation as StructureDraft['relationships'][number]['relation'], description: relationship.description as string })),
    motions: names.map((name, index) => {
      const motion = motions.find(item => item.component === name);
      return motion ? { id: id('M', index), componentId: id('D', index), type: motion.type as string, ...(motion.drivenBy ? { drivenBy: id('D', indexOf(motion.drivenBy)) } : {}), path: motion.path as string, purpose: motion.purpose as string } :
        { id: id('M', index), componentId: id('D', index), type: 'static', path: '固定于已确认的连接位置', purpose: components[index].purpose as string };
    }),
    innovationPoints: value.innovationPoints, problemSolved: value.problemSolved, workingPrinciple: value.workingPrinciple,
    nextDraftNumber: components.length + 1, nextModelNumber: 1,
  };
}
