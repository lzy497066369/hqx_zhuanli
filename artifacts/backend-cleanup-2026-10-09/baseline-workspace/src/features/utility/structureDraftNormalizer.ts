import { isPatentGeometry } from './patentStructure.ts';
import type { PatentGeometry } from './patentStructure.ts';
import { isStructureDraft } from './structureDraft.ts';
import type { StructureDraft, StructureDraftComponent, StructureDraftMotion, StructureDraftRelationship } from './structureDraft.ts';

/**
 * Deterministic boundary between the AI/user editable draft and the compiler.
 * This module is deliberately offline: it contains no fetch, LLM or provider
 * integration. It may only normalize fields that have an unambiguous meaning.
 */
export type NormalizeResult =
  | { success: true; draft: StructureDraft; errors: [] }
  | { success: false; draft: null; errors: string[] };

const relationTypes = new Set(['connected_to', 'fixed_to', 'slidably_connected', 'rotatably_connected', 'driven_by', 'supported_by', 'limited_by']);
const motionTypes = new Set(['static', 'rotary', 'linear']);
const fixedKeywords = /主体|本体|壳体|阀体|风筒|电机|马达|箱体|支架|支撑架|固定板|底座|连接块|安装座|防护网|网罩|隔音罩|罩体|弹簧座|外壳|导向套|导向座|轴承座|固定套|阀盖|操作杆/u;
const rotaryKeywords = /叶轮|风轮|叶片|转轴|传动轴|刷辊|旋转架|转盘|滚轮/u;
const linearKeywords = /滑轴|滑杆|滑块|滑座|推杆|导轨|移动架|阀芯|阀杆|活塞|柱塞/u;

const numberOf = (id: string) => Number(id.slice(1)) || 0;
const stableOffset = (id: string) => Math.max(0, numberOf(id) - 1) * 80;
const geometry = (shape: PatentGeometry['shape'], position: [number, number, number], size: [number, number, number], rotation: [number, number, number] = [0, 0, 0]): PatentGeometry => ({ shape, position, size, rotation });

function semanticGeometry(component: StructureDraftComponent): PatentGeometry | undefined {
  const name = component.name.trim();
  const offset = stableOffset(component.id);
  if (/风筒|风管|通风管|圆筒/u.test(name)) return geometry('tube', [offset, 0, 0], [50, 220, 40]);
  if (/阀体|阀盖|导向套|导向座|轴承座|固定套|阀芯|操作杆/u.test(name)) return geometry('cylinder', [offset, 0, 0], [18, 60, 0]);
  if (/电机|马达/u.test(name)) return geometry('cylinder', [offset, 0, 90], [22, 70, 0]);
  if (/叶轮|风轮|叶片/u.test(name)) return geometry('cylinder', [offset, 0, 150], [38, 18, 0]);
  if (/转轴|传动轴|刷辊|转盘|旋转架/u.test(name)) return geometry('cylinder', [offset, 0, 105], [6, 95, 0]);
  if (/防护网|网罩/u.test(name)) return geometry('tube', [offset, 0, 0], [58, 14, 48]);
  if (/支架|支撑架|固定板|底座|连接块|安装座/u.test(name)) return geometry('box', [offset, 0, 10], [32, 24, 10]);
  if (/隔音罩|罩体|箱体|外壳/u.test(name)) return geometry('box', [offset, 0, 55], [48, 48, 76]);
  if (/毛刷|刷体/u.test(name)) return geometry('box', [offset, 0, 18], [10, 34, 8]);
  if (/滑轴|滑杆/u.test(name)) return geometry('cylinder', [offset, 0, 22], [4, 48, 0]);
  if (/滑块|滑座|推杆|导轨|移动架/u.test(name)) return geometry('box', [offset, 0, 22], [18, 18, 12]);
  if (/配重块/u.test(name)) return geometry('box', [offset, 0, 12], [14, 14, 14]);
  if (/内齿圈|齿圈/u.test(name)) return geometry('ring_gear', [offset, 0, 0], [2, 60, 10]);
  if (/齿轮|齿盘/u.test(name)) return geometry('spur_gear', [offset, 0, 0], [2, 20, 10]);
  if (/弹簧|螺旋簧/u.test(name)) return geometry('spring', [offset, 0, 0], [12, 60, 2]);
  if (/螺纹杆|螺纹轴|丝杆|螺杆/u.test(name)) return geometry('threaded_cylinder', [offset, 0, 0], [8, 60, 3]);
  if (/球头|球体|滚珠/u.test(name)) return geometry('sphere', [offset, 0, 20], [12, 0, 0]);
  if (/锥体|锥头|锥形/u.test(name)) return geometry('cone', [offset, 0, 0], [16, 50, 4]);
  if (/棱柱|多棱柱/u.test(name)) return geometry('prism', [offset, 0, 0], [16, 6, 50]);
  if (/环面|圆环/u.test(name)) return geometry('torus', [offset, 0, 30], [18, 5, 0]);
  // Unknown freeform shapes must be described by the user rather than
  // silently represented by an unrelated primitive.
  return undefined;
}

function motionKind(name: string): 'static' | 'rotary' | 'linear' | undefined {
  if (rotaryKeywords.test(name)) return 'rotary';
  if (linearKeywords.test(name)) return 'linear';
  if (fixedKeywords.test(name)) return 'static';
  return undefined;
}

function canonicalId(value: string, prefix: 'D' | 'R' | 'M'): string {
  const trimmed = value.trim().toUpperCase();
  const match = trimmed.match(new RegExp(`^${prefix}(\\d+)$`, 'u'));
  return match ? `${prefix}${match[1].padStart(2, '0')}` : trimmed;
}

function normalizeGeometry(component: StructureDraftComponent, errors: string[]): { geometry: PatentGeometry | undefined; inferred: boolean } {
  if (component.geometry !== undefined) {
    if (!isPatentGeometry(component.geometry)) {
      errors.push(`${component.id} 的示意几何格式无效；请使用受支持的参数化几何，并填写位置、尺寸和旋转角度。`);
      return { geometry: undefined, inferred: false };
    }
    return {
      geometry: { shape: component.geometry.shape, position: [...component.geometry.position] as PatentGeometry['position'], size: [...component.geometry.size] as PatentGeometry['size'], rotation: [...component.geometry.rotation] as PatentGeometry['rotation'], ...(component.geometry.surfaceGrid ? { surfaceGrid: [...component.geometry.surfaceGrid] as [number, number] } : {}) },
      inferred: false,
    };
  }
  const inferred = semanticGeometry(component);
  if (!inferred) errors.push(`${component.id}（${component.name || '未命名部件'}）缺少示意几何，且无法根据明确部件语义安全补全；请明确形状、位置、尺寸和旋转角度。`);
  return { geometry: inferred, inferred: !!inferred };
}

function normalizeMotion(component: StructureDraftComponent, motions: StructureDraftMotion[], componentIds: Set<string>, nextMotion: () => string, errors: string[]): StructureDraftMotion | undefined {
  const existing = motions.find(motion => motion.componentId === component.id);
  if (existing) {
    const type = existing.type.trim().toLowerCase();
    const drivenBy = existing.drivenBy ? canonicalId(existing.drivenBy, 'D') : undefined;
    if (!motionTypes.has(type)) {
      errors.push(`${existing.id} 的运动类型无效：只能使用 static、rotary 或 linear。`);
      return undefined;
    }
    if (drivenBy && (!componentIds.has(drivenBy) || drivenBy === component.id)) errors.push(`${existing.id} 驱动部件 ${drivenBy} 不存在或指向自身，不能自动猜测驱动部件。`);
    if (type !== 'static' && !drivenBy) errors.push(`${existing.id}（${component.name}）为${type}运动，但未明确 drivenBy；不能自动猜测驱动部件。`);
    return { ...existing, id: canonicalId(existing.id, 'M'), componentId: component.id, type, drivenBy: drivenBy || undefined, path: existing.path.trim(), purpose: existing.purpose.trim() };
  }
  const inferredType = motionKind(component.name);
  if (!inferredType) {
    errors.push(`${component.id}（${component.name || '未命名部件'}）缺少运动或静止关系，无法根据部件语义安全补全。`);
    return undefined;
  }
  if (inferredType !== 'static') {
    errors.push(`${component.id}（${component.name}）为${inferredType}部件，但没有明确 drivenBy；不能自动猜测驱动部件。`);
    return undefined;
  }
  return { id: nextMotion(), componentId: component.id, type: inferredType, path: '固定于安装位置', purpose: '保持结构定位' };
}

/** Validate the structural invariants required before compilation. */
export function validateStructureDraft(value: unknown): string[] {
  if (!isStructureDraft(value)) return ['草案格式无效，请检查部件 ID、字段和数量。'];
  const draft = value;
  const errors: string[] = [];
  const componentIds = new Set(draft.components.map(component => component.id));
  const motionComponents = new Set<string>();
  if (draft.components.length < 1) errors.push('草案至少需要一个部件。');
  for (const component of draft.components) {
    if (!isPatentGeometry(component.geometry)) errors.push(`${component.id} 缺少有效的示意几何；请明确形状、位置、尺寸和旋转角度。`);
    if (component.parentId && (!componentIds.has(component.parentId) || component.parentId === component.id)) errors.push(`${component.id} 的父部件 ${component.parentId} 不存在或指向自己。`);
  }
  const relationshipIds = new Set<string>();
  for (const relationship of draft.relationships) {
    if (!/^R\d{2,3}$/u.test(relationship.id) || relationshipIds.has(relationship.id)) errors.push(`${relationship.id} 连接关系 ID 无效或重复。`);
    relationshipIds.add(relationship.id);
    if (!componentIds.has(relationship.from) || !componentIds.has(relationship.to) || relationship.from === relationship.to) errors.push(`${relationship.id} 连接端点无效。`);
    if (!relationTypes.has(relationship.relation) || !relationship.description.trim()) errors.push(`${relationship.id} 请填写有效连接类型及实际连接方式。`);
  }
  const motionIds = new Set<string>();
  for (const motion of draft.motions) {
    if (!/^M\d{2,3}$/u.test(motion.id) || motionIds.has(motion.id)) errors.push(`${motion.id} 运动 ID 无效或重复。`);
    motionIds.add(motion.id);
    if (!componentIds.has(motion.componentId) || motionComponents.has(motion.componentId)) errors.push(`${motion.id} 部件不存在或已有运动记录。`);
    motionComponents.add(motion.componentId);
    if (!motionTypes.has(motion.type) || !motion.path.trim() || !motion.purpose.trim()) errors.push(`${motion.id} 请填写静止/运动类型、轨迹及作用。`);
    if (motion.drivenBy && (!componentIds.has(motion.drivenBy) || motion.drivenBy === motion.componentId)) errors.push(`${motion.id} 驱动部件 ${motion.drivenBy} 不存在或指向自身。`);
    if (motion.type === 'static' && motion.drivenBy) errors.push(`${motion.id} 静止部件不应设置驱动部件。`);
    if (motion.type !== 'static' && !motion.drivenBy) errors.push(`${motion.id} 运动部件须明确驱动部件；静止部件请使用 static。`);
  }
  for (const component of draft.components) if (!motionComponents.has(component.id)) errors.push(`${component.id} 缺少运动或静止关系。`);
  return [...new Set(errors)];
}

/**
 * Normalize only deterministic, semantically safe omissions. It never adds a
 * component, connection, innovation point or guessed driver.
 */
export function normalizeStructureDraft(input: unknown): NormalizeResult {
  if (!isStructureDraft(input)) return { success: false, draft: null, errors: ['草案格式无效，请检查部件 ID、字段和数量。'] };
  const source = input as StructureDraft;
  const errors: string[] = [];
  const components = source.components.map(component => ({ ...component, id: canonicalId(component.id, 'D') }));
  const componentIds = new Set(components.map(component => component.id));
  if (componentIds.size !== components.length) errors.push('部件 ID 重复，无法安全编译。');
  const relationships: StructureDraftRelationship[] = source.relationships.map(relationship => ({ ...relationship, id: canonicalId(relationship.id, 'R'), from: canonicalId(relationship.from, 'D'), to: canonicalId(relationship.to, 'D'), relation: relationship.relation.trim() as StructureDraftRelationship['relation'], description: relationship.description.trim() }));
  const motionsInput = source.motions.map(motion => ({ ...motion, id: canonicalId(motion.id, 'M'), componentId: canonicalId(motion.componentId, 'D'), drivenBy: motion.drivenBy ? canonicalId(motion.drivenBy, 'D') : undefined }));
  const seenMotions = new Set<string>();
  for (const motion of motionsInput) {
    if (!componentIds.has(motion.componentId)) errors.push(`${motion.id} 引用不存在的部件 ${motion.componentId}。`);
    if (seenMotions.has(motion.componentId)) errors.push(`${motion.componentId} 存在重复的运动或静止关系。`);
    seenMotions.add(motion.componentId);
  }
  // 推断几何的部件带 inferredGeometry 标记：编译器据此豁免装配接触校验，
  // 否则缺几何的旧草案会因为「推断位置彼此不相接」而永久无法编译。
  const normalizedComponents = components.map(component => {
    const normalized = normalizeGeometry(component, errors);
    return { ...component, name: component.name.trim(), purpose: component.purpose.trim(), position: component.position.trim(), whyNeeded: component.whyNeeded.trim(), parentId: component.parentId ? canonicalId(component.parentId, 'D') : undefined, geometry: normalized.geometry, ...(normalized.inferred ? { inferredGeometry: true } : {}) };
  });
  let motionSerial = Math.max(1, source.motions.length ? Math.max(...source.motions.map(motion => numberOf(canonicalId(motion.id, 'M')))) + 1 : 1);
  const nextMotion = () => `M${String(motionSerial++).padStart(2, '0')}`;
  const motions: StructureDraftMotion[] = [];
  for (const component of normalizedComponents) {
    const motion = normalizeMotion(component, motionsInput, componentIds, nextMotion, errors);
    if (motion) motions.push(motion);
  }
  const draft: StructureDraft = {
    ...source,
    title: source.title.trim(),
    technicalField: source.technicalField.trim(),
    baseStructure: source.baseStructure.trim(),
    problemSolved: source.problemSolved.trim(),
    workingPrinciple: source.workingPrinciple.trim(),
    nextDraftNumber: Math.max(source.nextDraftNumber, ...normalizedComponents.map(component => numberOf(component.id) + 1), 1),
    nextModelNumber: Math.max(source.nextModelNumber, 1, ...normalizedComponents.map(component => component.modelId ? numberOf(component.modelId) + 1 : 1)),
    components: normalizedComponents,
    relationships,
    motions,
    innovationPoints: source.innovationPoints.map(point => point.trim()).filter(Boolean),
  };
  if (errors.length) return { success: false, draft: null, errors: [...new Set(errors)] };
  const validationErrors = validateStructureDraft(draft);
  if (validationErrors.length) return { success: false, draft: null, errors: validationErrors };
  return { success: true, draft, errors: [] };
}
