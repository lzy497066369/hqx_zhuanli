import type { PatentShape } from './geometrySpec.ts';
import type { ConnectionRelation, ProductBrief, InnovationNameCandidate, PatentGeometry } from './patentStructure.ts';
import { isProductBrief, isInnovationNameCandidate } from './patentStructure.ts';
import { isPatentGeometry } from './patentStructure.ts';
import type { StructureDraft } from './structureDraft.ts';
import type { GeometryRevision } from './structureEvidence.ts';
import type { PatentResearch } from './patentResearch.ts';
import { normalizeStructureDraft } from './structureDraftNormalizer.ts';
import { assemblyGeometryIssues } from './assemblyGeometry.ts';

export type StructureSkeletonComponent = {
  name: string;
  /** Optional user-entered patent-facing number; AI must not invent it. */
  referenceNo?: string;
  kind: 'base' | 'innovation';
  purpose: string;
  position: string;
  geometryShape?: PatentShape;
  visualFeature?: string;
  geometry?: PatentGeometry;
};

export type StructureSkeletonRelationship = {
  from: string;
  to: string;
  relation: ConnectionRelation;
  description: string;
};

export type StructureSkeletonMotion = {
  component: string;
  type: 'rotary' | 'linear';
  drivenBy: string;
  path: string;
  purpose: string;
};

export type StructureSkeleton = {
  version: 1;
  title: string;
  visualSubject?: string;
  subjectComponent?: string;
  summary: string;
  components: StructureSkeletonComponent[];
  relationships: StructureSkeletonRelationship[];
  motions: StructureSkeletonMotion[];
  problemSolved: string;
  innovationPoints: string[];
};

export type StructureSkeletonResponse =
  | { status: 'ready'; skeleton: StructureSkeleton; candidate: InnovationNameCandidate; source: string; research: PatentResearch; providerModel: string; generatedAt: string }
  | { status: 'needs_information' | 'unsupported'; summary: string; questions: string[]; unsupportedReason?: string; geometryRevision?: GeometryRevision; options: []; candidate: InnovationNameCandidate };

const relationTypes = new Set<ConnectionRelation>(['connected_to', 'fixed_to', 'slidably_connected', 'rotatably_connected', 'driven_by', 'supported_by', 'limited_by']);
const shapeTypes = new Set<PatentShape>(['box', 'cylinder', 'tube', 'spur_gear', 'ring_gear', 'cone', 'sphere', 'ellipsoid', 'prism', 'torus', 'spring', 'threaded_cylinder']);
const text = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const isWholeSolarPanel = (title: string) => /光伏板(?:组件)?$/u.test(title.trim());

export function solarPanelAccessoryErrors(title: string, components: { name: string; geometry?: PatentGeometry }[]): string[] {
  if (!isWholeSolarPanel(title) || components[0]?.geometry?.shape !== 'box') return [];
  const [length, width] = components[0].geometry.size;
  return components.slice(1).filter(component =>
    /连接件|紧固件|螺栓|卡扣/u.test(component.name) && component.geometry?.shape === 'box' &&
    component.geometry.size[0] * component.geometry.size[1] > length * width / 4,
  ).map(component => `${component.name} 在板面上的投影过大，图1会喧宾夺主；请核对配件尺寸和朝向。`);
}

export function isStructureSkeleton(value: unknown): value is StructureSkeleton {
  if (!record(value) || value.version !== 1 || !text(value.title, 100) || !text(value.summary, 600) || !text(value.problemSolved, 1500) ||
      !Array.isArray(value.components) || value.components.length < 2 || value.components.length > 30 ||
      !Array.isArray(value.relationships) || value.relationships.length < 1 || value.relationships.length > 80 ||
      !Array.isArray(value.motions) || value.motions.length > 30 || !Array.isArray(value.innovationPoints) ||
      value.innovationPoints.length < 1 || value.innovationPoints.length > 20 || !value.innovationPoints.every(point => text(point, 500)) || 'model' in value || 'draft' in value) return false;
  const names = new Set<string>();
  for (const component of value.components) {
    if (!record(component) || (component.referenceNo !== undefined && !/^\d{1,3}$/u.test(component.referenceNo as string)) || !text(component.name, 40) || names.has(String(component.name).trim()) || !['base', 'innovation'].includes(String(component.kind)) || !text(component.purpose, 500) || !text(component.position, 500) ||
        (component.geometryShape !== undefined && !shapeTypes.has(component.geometryShape as PatentShape)) ||
        (component.visualFeature !== undefined && !text(component.visualFeature, 300)) ||
        (component.geometry !== undefined && (!isPatentGeometry(component.geometry) || component.geometry.shape !== component.geometryShape))) return false;
    names.add(String(component.name).trim());
    if ('id' in component || 'modelId' in component || 'parentId' in component) return false;
  }
  if (![...value.components].some(component => record(component) && component.kind === 'innovation')) return false;
  const hasName = (item: unknown) => typeof item === 'string' && names.has(item.trim());
  for (const relationship of value.relationships) {
    if (!record(relationship) || !hasName(relationship.from) || !hasName(relationship.to) || relationship.from === relationship.to ||
        !relationTypes.has(relationship.relation as ConnectionRelation) || !text(relationship.description, 500)) return false;
    if ('id' in relationship || 'modelId' in relationship) return false;
  }
  const motionNames = new Set<string>();
  for (const motion of value.motions) {
    if (!record(motion) || !hasName(motion.component) || motionNames.has(motion.component as string) || !['rotary', 'linear'].includes(String(motion.type)) ||
        !hasName(motion.drivenBy) || motion.component === motion.drivenBy || !text(motion.path, 500) || !text(motion.purpose, 500)) return false;
    motionNames.add(motion.component as string);
    if ('id' in motion || 'modelId' in motion) return false;
  }
  return (value.visualSubject === undefined || text(value.visualSubject, 300)) &&
    (value.subjectComponent === undefined || (typeof value.subjectComponent === 'string' && names.has(value.subjectComponent)));
}

const skeletonEnvelopeKeys = ['status', 'skeleton'];
const skeletonKeys = ['version', 'title', 'visualSubject', 'subjectComponent', 'summary', 'components', 'relationships', 'motions', 'problemSolved', 'innovationPoints'];
const skeletonComponentKeys = ['name', 'referenceNo', 'kind', 'purpose', 'position', 'geometryShape', 'visualFeature', 'geometry'];
const skeletonRelationshipKeys = ['from', 'to', 'relation', 'description'];
const skeletonMotionKeys = ['component', 'type', 'drivenBy', 'path', 'purpose'];

const stripUnknownKeys = (item: unknown, keys: string[]) => {
  if (!record(item)) return;
  for (const key of Object.keys(item)) if (!keys.includes(key)) delete item[key];
};

/**
 * 整理模型返回的结构骨架信封：只保留轻量骨架协议字段，剥离模型多带的协议外字段
 * （部件/连接/运动上的 id、modelId、parentId，顶层的 model/draft 等）。
 * 就地修改并返回传入对象（输入为当轮 JSON 解析产生的新对象，无外部别名）。
 * 整理后仍须通过 isStructureSkeleton / skeletonValidationErrors 的严格内容校验，
 * 内容问题（数量、引用、连通性、形状白名单等）不会被掩盖。
 */
/** 模型高频自创的 relation 别名 → 协议标准值。仅收敛语义明确的同义词，不放宽校验。 */
const relationAlias: Record<string, string> = {
  contact: 'connected_to',
  pivots_on: 'rotatably_connected',
  fastened_by: 'fixed_to',
};

export function sanitizeStructureSkeletonEnvelope(value: unknown): unknown {
  if (!record(value) || value.status !== 'ready') return value;
  const skeleton = value.skeleton;
  if (!record(skeleton)) return value;
  stripUnknownKeys(value, skeletonEnvelopeKeys);
  stripUnknownKeys(skeleton, skeletonKeys);
  if (Array.isArray(skeleton.components)) for (const component of skeleton.components) stripUnknownKeys(component, skeletonComponentKeys);
  if (Array.isArray(skeleton.relationships)) for (const relationship of skeleton.relationships) {
    stripUnknownKeys(relationship, skeletonRelationshipKeys);
    // 模型高频自创 relation 别名（contact=相接、pivots_on=枢转、fastened_by=紧固），语义明确时归一化为协议值；其他非法值仍由严格校验拦截。
    if (record(relationship) && typeof relationship.relation === 'string' && relationAlias[relationship.relation]) {
      relationship.relation = relationAlias[relationship.relation];
    }
  }
  if (Array.isArray(skeleton.motions)) for (const motion of skeleton.motions) stripUnknownKeys(motion, skeletonMotionKeys);
  return value;
}

/**
 * 逐项报告结构骨架的结构性违规（与 isStructureSkeleton 的判定逐项对应），
 * 用于服务端日志与错误详情；判定语义本身仍以 isStructureSkeleton 为准。
 */
export function skeletonStructuralErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (!record(value)) return ['结构骨架不是有效的 JSON 对象。'];
  if (value.version !== 1) errors.push('version 必须为 1。');
  if (!text(value.title, 100)) errors.push('title 缺失、为空或超过 100 字。');
  if (value.visualSubject !== undefined && !text(value.visualSubject, 300)) errors.push('visualSubject 为空或超过 300 字。');
  if (value.subjectComponent !== undefined && !text(value.subjectComponent, 40)) errors.push('subjectComponent 无效。');
  if (!text(value.summary, 600)) errors.push('summary 缺失、为空或超过 600 字。');
  if (!text(value.problemSolved, 1500)) errors.push('problemSolved 缺失、为空或超过 1500 字。');
  const components = Array.isArray(value.components) ? value.components : null;
  const relationships = Array.isArray(value.relationships) ? value.relationships : null;
  const motions = Array.isArray(value.motions) ? value.motions : null;
  const innovationPoints = Array.isArray(value.innovationPoints) ? value.innovationPoints : null;
  if (!components || components.length < 2 || components.length > 30) errors.push(`components 数量为 ${components ? components.length : '非数组'}，须在 2 至 30 之间。`);
  if (!relationships || relationships.length < 1 || relationships.length > 80) errors.push(`relationships 数量为 ${relationships ? relationships.length : '非数组'}，须在 1 至 80 之间。`);
  if (!motions || motions.length > 30) errors.push(`motions 数量为 ${motions ? motions.length : '非数组'}，须不超过 30。`);
  if (!innovationPoints || innovationPoints.length < 1 || innovationPoints.length > 20) errors.push(`innovationPoints 数量为 ${innovationPoints ? innovationPoints.length : '非数组'}，须在 1 至 20 之间。`);
  else innovationPoints.forEach((point, index) => { if (!text(point, 500)) errors.push(`第 ${index + 1} 条 innovationPoints 为空或超过 500 字。`); });
  if ('model' in value || 'draft' in value) errors.push('顶层不应包含 model/draft 字段。');
  const names = new Set<string>();
  if (components) components.forEach((component, index) => {
    const label = `第 ${index + 1} 个部件`;
    if (!record(component)) { errors.push(`${label}不是有效对象。`); return; }
    const name = typeof component.name === 'string' ? component.name.trim() : '';
    if (component.referenceNo !== undefined && !/^\d{1,3}$/u.test(String(component.referenceNo))) errors.push(`${label}的 referenceNo 必须是 1 至 999 的数字。`);
    if (!text(component.name, 40)) errors.push(`${label}名称缺失、为空或超过 40 字。`);
    else if (names.has(name)) errors.push(`部件名称“${name}”重复。`);
    else names.add(name);
    if (!['base', 'innovation'].includes(String(component.kind))) errors.push(`部件“${name || label}”的 kind 须为 base 或 innovation。`);
    if (!text(component.purpose, 500)) errors.push(`部件“${name || label}”的 purpose 缺失、为空或超过 500 字。`);
    if (!text(component.position, 500)) errors.push(`部件“${name || label}”的 position 缺失、为空或超过 500 字。`);
    if (component.geometryShape !== undefined && !shapeTypes.has(component.geometryShape as PatentShape)) errors.push(`部件“${name || label}”的 geometryShape“${String(component.geometryShape)}”不在支持列表。`);
    if (component.visualFeature !== undefined && !text(component.visualFeature, 300)) errors.push(`部件“${name || label}”的 visualFeature 无效。`);
    if (component.geometry !== undefined && (!isPatentGeometry(component.geometry) || component.geometry.shape !== component.geometryShape)) errors.push(`部件“${name || label}”的 geometry 无效或与形状不一致。`);
    if ('id' in component || 'modelId' in component || 'parentId' in component) errors.push(`部件“${name || label}”带有协议外字段（id/modelId/parentId）。`);
  });
  if (value.subjectComponent !== undefined && !names.has(String(value.subjectComponent))) errors.push('subjectComponent 未指向已定义部件。');
  if (components && components.length && !components.some(component => record(component) && component.kind === 'innovation')) errors.push('至少需要一个 kind 为 innovation 的创新部件。');
  const referenceNumbers = components?.map(component => typeof component.referenceNo === 'string' ? component.referenceNo : '').filter(Boolean) || [];
  if (new Set(referenceNumbers).size !== referenceNumbers.length) errors.push('附图标号不能重复。');
  const hasName = (item: unknown) => typeof item === 'string' && names.has(item.trim());
  if (relationships) relationships.forEach((relationship, index) => {
    const label = `第 ${index + 1} 条连接`;
    if (!record(relationship)) { errors.push(`${label}不是有效对象。`); return; }
    if (!hasName(relationship.from)) errors.push(`${label}的 from“${String(relationship.from)}”不是已定义的部件名。`);
    if (!hasName(relationship.to)) errors.push(`${label}的 to“${String(relationship.to)}”不是已定义的部件名。`);
    if (relationship.from === relationship.to) errors.push(`${label}的 from 与 to 相同，不允许自连接。`);
    if (!relationTypes.has(relationship.relation as ConnectionRelation)) errors.push(`${label}的 relation“${String(relationship.relation)}”不在支持列表。`);
    if (!text(relationship.description, 500)) errors.push(`${label}的 description 缺失、为空或超过 500 字。`);
    if ('id' in relationship || 'modelId' in relationship) errors.push(`${label}带有协议外字段（id/modelId）。`);
  });
  const motionNames = new Set<string>();
  if (motions) motions.forEach((motion, index) => {
    const label = `第 ${index + 1} 条运动`;
    if (!record(motion)) { errors.push(`${label}不是有效对象。`); return; }
    if (!hasName(motion.component)) errors.push(`${label}的 component“${String(motion.component)}”不是已定义的部件名。`);
    else if (motionNames.has(motion.component as string)) errors.push(`部件“${String(motion.component)}”的运动记录重复。`);
    else motionNames.add(motion.component as string);
    if (!['rotary', 'linear'].includes(String(motion.type))) errors.push(`${label}的 type 须为 rotary 或 linear。`);
    if (!hasName(motion.drivenBy)) errors.push(`${label}的 drivenBy“${String(motion.drivenBy)}”不是已定义的部件名。`);
    if (motion.component === motion.drivenBy) errors.push(`${label}的驱动部件不能是自身。`);
    if (!text(motion.path, 500)) errors.push(`${label}的 path 缺失、为空或超过 500 字。`);
    if (!text(motion.purpose, 500)) errors.push(`${label}的 purpose 缺失、为空或超过 500 字。`);
    if ('id' in motion || 'modelId' in motion) errors.push(`${label}带有协议外字段（id/modelId）。`);
  });
  return errors;
}

export function isEditableStructureSkeleton(value: unknown): value is StructureSkeleton {
  if (!record(value) || value.version !== 1 || !text(value.title, 100) || typeof value.summary !== 'string' || value.summary.length > 600 ||
      typeof value.problemSolved !== 'string' || value.problemSolved.length > 1500 || !Array.isArray(value.components) || value.components.length < 2 || value.components.length > 30 ||
      !Array.isArray(value.relationships) || value.relationships.length > 80 || !Array.isArray(value.motions) || value.motions.length > 30 ||
      !Array.isArray(value.innovationPoints) || value.innovationPoints.length > 20 || !value.innovationPoints.every(item => typeof item === 'string' && item.length <= 500)) return false;
  return (value.visualSubject === undefined || text(value.visualSubject, 300)) && (value.subjectComponent === undefined || typeof value.subjectComponent === 'string') &&
    value.components.every(item => record(item) && (item.referenceNo === undefined || /^\d{1,3}$/u.test(item.referenceNo as string)) && typeof item.name === 'string' && item.name.length <= 40 && ['base', 'innovation'].includes(String(item.kind)) && typeof item.purpose === 'string' && item.purpose.length <= 500 && typeof item.position === 'string' && item.position.length <= 500 && (item.geometryShape === undefined || shapeTypes.has(item.geometryShape as PatentShape)) && (item.visualFeature === undefined || typeof item.visualFeature === 'string' && item.visualFeature.length <= 300) && (item.geometry === undefined || isPatentGeometry(item.geometry))) &&
    value.relationships.every(item => record(item) && typeof item.from === 'string' && item.from.length <= 40 && typeof item.to === 'string' && item.to.length <= 40 && relationTypes.has(item.relation as ConnectionRelation) && typeof item.description === 'string' && item.description.length <= 500) &&
    value.motions.every(item => record(item) && typeof item.component === 'string' && item.component.length <= 40 && ['rotary', 'linear'].includes(String(item.type)) && typeof item.drivenBy === 'string' && item.drivenBy.length <= 40 && typeof item.path === 'string' && item.path.length <= 500 && typeof item.purpose === 'string' && item.purpose.length <= 500);
}

/** 配件／加工设备类尾词：主体部件落到这些词上，说明整体图画的是产品的配件而不是产品。 */
const accessorySubject = /连接组件|连接件|连接器|安装支架|紧固件|螺栓|卡扣|配件|附件|夹具|定位件|加工设备|生产设备|生产线|机床/u;
export const isAccessorySubjectName = (name: string) => accessorySubject.test(name.trim().replace(/^一种/u, ''));

/**
 * 整体图主体是否是可接受的产品主体。
 * 受保护客体是用户所填产品本身，因此主体部件不能是它的配件或加工设备；
 * 但产品本身即配件时（如光伏板边框连接件），以配件名作主体是正确的。
 * 不要求主体部件名逐字包含产品名：轴流风机的主体是风筒，这是正常结构。
 */
export function subjectMatchesProduct(mainName: string, productName: string): boolean {
  const main = mainName.trim().replace(/^一种/u, '');
  const product = productName.trim().replace(/^一种/u, '');
  if (!main || !product) return false;
  if (isAccessorySubjectName(main)) return isAccessorySubjectName(product);
  return true;
}

export function skeletonValidationErrors(value: unknown): string[] {
  if (!isStructureSkeleton(value)) return ['结构骨架格式无效：需要 2 至 30 个唯一部件、有效连接关系和运动记录。'];
  const names = new Set(value.components.map(component => component.name.trim()));
  const linked = new Set([value.components[0].name.trim()]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const relationship of value.relationships) {
      if (linked.has(relationship.from) && !linked.has(relationship.to)) { linked.add(relationship.to); changed = true; }
      if (linked.has(relationship.to) && !linked.has(relationship.from)) { linked.add(relationship.from); changed = true; }
    }
  }
  const errors: string[] = [];
  if (linked.size !== names.size) errors.push('连接关系未覆盖全部部件，结构不能整体连通。');
  if (!value.visualSubject?.trim() || !value.subjectComponent || value.components[0].name.trim() !== value.subjectComponent) errors.push('请先回答产品从外面看最主要、最显眼的主体，并将该主体置于首位；首位只是内部关联顺序，不是正式附图标号。');
  if (isWholeSolarPanel(value.title) &&
      (!/光伏板|光伏组件|板体|电池板/u.test(value.components[0].name) || /连接件|支架|紧固件/u.test(value.components[0].name) || value.components[0].geometry?.shape !== 'box')) errors.push('光伏板整体图的主体应为薄板板体，不能以支架或连接件替代。');
  errors.push(...solarPanelAccessoryErrors(value.title, value.components));
  for (const component of value.components) {
    if (!component.geometryShape) errors.push(`${component.name} 缺少已核对的形状。`);
    if (!component.visualFeature?.trim()) errors.push(`${component.name} 缺少外观特征。`);
    if (!component.geometry || component.geometry.shape !== component.geometryShape || !isPatentGeometry(component.geometry)) errors.push(`${component.name} 缺少有效的示意尺寸、位置及旋转。`);
  }
  const main = value.components[0];
  if (main.geometry?.shape === 'box') {
    const [length, width, height] = main.geometry.size;
    if (/(?:板|片|膜|布)/u.test(main.name) && height > Math.min(length, width) / 5) errors.push(`${main.name} 的厚度相对板面过大，请核对主体比例及朝向。`);
  }
  return errors;
}

export function buildStructureDraftFromSkeleton(input: { brief: ProductBrief; candidate: InnovationNameCandidate; skeleton: StructureSkeleton }): { success: true; draft: StructureDraft } | { success: false; errors: string[] } {
  if (!isProductBrief(input.brief) || !isInnovationNameCandidate(input.candidate)) return { success: false, errors: ['产品资料或名称候选无效。'] };
  const skeletonErrors = [...skeletonValidationErrors(input.skeleton), ...assemblyGeometryIssues(input.skeleton).filter(issue => issue.severity === 'error').map(issue => issue.message)];
  if (skeletonErrors.length) return { success: false, errors: skeletonErrors };
  if (input.skeleton.title !== input.candidate.name) return { success: false, errors: ['结构骨架名称与已确认名称不一致。'] };
  if (isWholeSolarPanel(input.candidate.name) &&
      !/光伏板|光伏组件|板体|电池板/u.test(input.skeleton.components[0].name)) return { success: false, errors: ['光伏板整体图必须以板体为主体。'] };
  const componentIds = new Map(input.skeleton.components.map((component, index) => [component.name.trim(), `D${String(index + 1).padStart(2, '0')}`]));
  const draft: StructureDraft = {
    version: 1,
    improvementType: input.brief.improvementType,
    title: input.candidate.name,
    technicalField: `${input.brief.productName}技术领域`,
    baseStructure: `${input.skeleton.components.map(component => `${component.name}用于${component.purpose}`).join('；')}。${input.skeleton.relationships.map(relationship => relationship.description).join('；')}。`,
    components: input.skeleton.components.map(component => ({
      id: componentIds.get(component.name.trim())!, referenceNo: component.referenceNo, name: component.name.trim(), kind: component.kind, purpose: component.purpose.trim(),
      position: component.position.trim(), whyNeeded: `用于实现${component.purpose.trim()}`,
      geometry: component.geometry,
      visualFeature: component.visualFeature,
    })),
    relationships: input.skeleton.relationships.map((relationship, index) => ({
      id: `R${String(index + 1).padStart(2, '0')}`, from: componentIds.get(relationship.from.trim())!, to: componentIds.get(relationship.to.trim())!, relation: relationship.relation, description: relationship.description.trim(),
    })),
    motions: input.skeleton.components.map((component, index) => {
      const motion = input.skeleton.motions.find(item => item.component.trim() === component.name.trim());
      return motion ? { id: `M${String(index + 1).padStart(2, '0')}`, componentId: componentIds.get(component.name.trim())!, type: motion.type, drivenBy: componentIds.get(motion.drivenBy.trim()), path: motion.path.trim(), purpose: motion.purpose.trim() } :
        { id: `M${String(index + 1).padStart(2, '0')}`, componentId: componentIds.get(component.name.trim())!, type: 'static', path: '固定于已确认的连接位置', purpose: '保持结构定位' };
    }),
    innovationPoints: input.skeleton.innovationPoints.map(point => point.trim()),
    problemSolved: input.skeleton.problemSolved,
    workingPrinciple: input.skeleton.motions.length ? input.skeleton.motions.map(motion => `${motion.drivenBy}驱动${motion.component}${motion.type === 'rotary' ? '旋转' : '直线运动'}，用于${motion.purpose}`).join('；') + '。' : `${input.skeleton.relationships.map(relationship => relationship.description.trim()).join('；')}。`,
    nextDraftNumber: input.skeleton.components.length + 1,
    nextModelNumber: 1,
  };
  const normalized = normalizeStructureDraft(draft);
  if (!normalized.success) return { success: false, errors: normalized.errors };
  return { success: true, draft: normalized.draft };
}
