import type { ComponentSpec } from './contentDrawing.ts';
import { geometryDimensions, geometryShapeLabels, isGeometrySpec } from './geometrySpec.ts';
import type { PatentShape } from './geometrySpec.ts';
import type { PatentResearch } from './patentResearch.ts';
import { improvementTypes } from './naming.ts';
import type { ImprovementType } from './naming.ts';
import type { StructureEvidenceSelection } from './structureEvidence.ts';
import { isStructureEvidenceSelection } from './structureEvidence.ts';

export type ProductBrief = {
  productName: string;
  introduction: string;
  usageScene: string;
  existingStructure: string;
  existingFunctions: string;
  imageData?: string;
  improvementType?: ImprovementType;
  structureEvidence?: StructureEvidenceSelection;
  confirmedFacts?: ConfirmedStructureFact[];
};

export type ConfirmedStructureFact = { question: string; answer: string; origin?: 'model_proposal' };

const factTopicPatterns = {
  ringPresence: /内齿圈|齿圈|无齿圈|不设齿圈|不设置齿圈/u,
  ringMounting: /内齿圈.*(?:顶盖|法兰|支座|固定)|(?:顶盖|法兰|支座).*内齿圈|中分面|轴向安装/u,
  gearParameters: /模数|齿数|分度圆|轴距|齿轮参数/u,
  planetaryConstraint: /行星架.*(?:约束|公转|转速|驱动|传动)|(?:约束|公转|转速|驱动|传动).*行星架|第二路输入|输出约束/u,
} as const;

function factText(fact: ConfirmedStructureFact) {
  return `${fact.question} ${fact.answer}`;
}

function hasFactTopic(fact: ConfirmedStructureFact, topic: keyof typeof factTopicPatterns) {
  return factTopicPatterns[topic].test(factText(fact));
}

function saysNoRingGear(fact: ConfirmedStructureFact) {
  return /(?:暂不|不|未|无|没有|取消|不含).{0,8}(?:设置|设|加入|采用)?内齿圈|(?:暂不|不|未|无|没有|取消|不含)内齿圈/u.test(fact.answer);
}

function saysRingGear(fact: ConfirmedStructureFact) {
  return /(?:固定|加入|设置|设有|采用|配置).{0,12}内齿圈|内齿圈.{0,12}(?:固定|加入|设置|设有|采用|配置)/u.test(fact.answer) && !saysNoRingGear(fact);
}

function factsConflict(previous: ConfirmedStructureFact, next: ConfirmedStructureFact) {
  if (previous.question.trim() === next.question.trim()) return true;

  const previousText = factText(previous);
  const nextText = factText(next);
  const ringConflict = hasFactTopic(previous, 'ringPresence') && hasFactTopic(next, 'ringPresence') &&
    ((saysNoRingGear(previous) && saysRingGear(next)) || (saysRingGear(previous) && saysNoRingGear(next)));
  if (ringConflict) return true;

  const sameTopic = (topic: keyof typeof factTopicPatterns) => hasFactTopic(previous, topic) && hasFactTopic(next, topic);
  if (sameTopic('ringMounting')) return true;
  if (sameTopic('gearParameters') && /模数|齿数|分度圆|轴距/u.test(previousText) && /模数|齿数|分度圆|轴距/u.test(nextText)) return true;
  if (sameTopic('planetaryConstraint')) return true;
  return false;
}

/**
 * Keeps the latest adopted proposal for a disputed structural topic while
 * never replacing a fact that was confirmed from the product or drawings.
 */
export function mergeStructureFacts(current: ConfirmedStructureFact[], additions: ConfirmedStructureFact[] = []) {
  const merged: ConfirmedStructureFact[] = [];
  for (const fact of [...current, ...additions]) {
    const normalized = { ...fact, question: fact.question.trim(), answer: fact.answer.trim() };
    const isConfirmed = normalized.origin === undefined;
    const conflictingConfirmed = merged.some(item => !item.origin && factsConflict(item, normalized));
    if (!isConfirmed && conflictingConfirmed) continue;
    for (let index = merged.length - 1; index >= 0; index--) {
      if (!factsConflict(merged[index], normalized)) continue;
      if (!isConfirmed && !merged[index].origin) continue;
      merged.splice(index, 1);
    }
    merged.push(normalized);
  }
  return merged.slice(-16);
}

export function normalizeStructureFacts(facts: ConfirmedStructureFact[] | undefined) {
  return mergeStructureFacts(facts || []);
}

export function isConfirmedStructureFacts(value: unknown): value is ConfirmedStructureFact[] {
  return Array.isArray(value) && value.length <= 16 && value.every(fact =>
    !!fact && typeof fact === 'object' && typeof fact.question === 'string' && !!fact.question.trim() && fact.question.length <= 300 &&
    typeof fact.answer === 'string' && !!fact.answer.trim() && fact.answer.length <= 1000 &&
    (fact.origin === undefined || fact.origin === 'model_proposal')) &&
    new Set(value.map(fact => fact.question.trim())).size === value.length;
}

export type InnovationNameCandidate = {
  id: string;
  name: string;
  innovationDirection: string;
  solvedProblem: string;
  coreInnovationStructure: string;
  mainComponents: string[];
  implementation: string;
};

export type PatentGeometry = Omit<ComponentSpec, 'id' | 'name'> & { shape: PatentShape };
export type ComponentKind = 'base' | 'innovation';
export type ConnectionRelation =
  | 'connected_to'
  | 'fixed_to'
  | 'slidably_connected'
  | 'rotatably_connected'
  | 'driven_by'
  | 'supported_by'
  | 'limited_by';

export type PatentComponent = {
  id: string;
  evidenceRefs?: string[];
  /** Patent-facing reference number shared by drawings and formal text. */
  referenceNo?: string;
  sourceDraftId?: string;
  name: string;
  kind: ComponentKind;
  purpose: string;
  position: string;
  whyNeeded: string;
  visualFeature?: string;
  geometry: PatentGeometry;
};

export type PatentConnection = {
  id: string;
  evidenceRefs?: string[];
  from: string;
  to: string;
  relation: ConnectionRelation;
  description: string;
};

export type PatentMotion = {
  id: string;
  evidenceRefs?: string[];
  componentId: string;
  type: string;
  drivenBy?: string;
  path: string;
  purpose: string;
};

export type PatentFigureSpec = {
  id: string;
  /** Alias retained for imported/legacy records. */
  figureId?: string;
  title: string;
  kind: 'overall' | 'side' | 'detail';
  viewType?: 'overall' | 'side' | 'detail';
  componentIds: string[];
  highlightComponentIds?: string[];
  connectionIds: string[];
};

export type PatentStructureModel = {
  version: 1;
  improvementType?: ImprovementType;
  /** Instance version. `version` above is only the persisted schema version. */
  modelVersion?: string;
  productTitle: string;
  technicalField: string;
  baseStructure: string;
  components: PatentComponent[];
  connections: PatentConnection[];
  motions: PatentMotion[];
  functions: string[];
  innovationPoints: string[];
  problemSolved: string;
  workingPrinciple: string;
  figureSpecs: PatentFigureSpec[];
};

export type InnovationCandidatesResponse = {
  candidates: InnovationNameCandidate[];
  source: string;
  researchSummary: string;
  providerModel: string;
  generatedAt: string;
};

export type StructurePlanInput = {
  brief: ProductBrief;
  candidate: InnovationNameCandidate;
  /** New UI flows set this. Omitted for compatibility with legacy callers. */
  requireEvidence?: boolean;
};

export type PatentStructureResponse = {
  model: PatentStructureModel;
  candidate: InnovationNameCandidate;
  source: string;
  researchSummary: string;
  research: PatentResearch;
  providerModel: string;
  generatedAt: string;
};

export type PatentStructureBuildInput = {
  title: string;
  technicalField: string;
  structure: string;
  workingPrinciple: string;
  components: Array<{ name: string; geometry: PatentGeometry; purpose: string; whyNeeded: string; referenceNo?: string }>;
  innovationPoints?: string[];
  problemSolved: string;
  innovationName: string;
  connections: Array<Pick<PatentConnection, 'from' | 'to' | 'relation' | 'description'>>;
};

/**
 * Creates the reviewable Patent Structure Model that gates all downstream
 * drafting and drawing. This is a structured design record, not a novelty or
 * legal conclusion; the user must review the generated assumptions before it
 * can be used downstream.
 */
export function createModelVersion(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `model-${uuid}`;
}

export function getModelVersion(model: PatentStructureModel): string {
  return model.modelVersion || 'legacy-model';
}

export function buildPatentStructureModel(input: PatentStructureBuildInput): PatentStructureModel {
  const components: PatentComponent[] = input.components.map((component, index) => ({
    id: `C${String(index + 1).padStart(2, '0')}`,
    referenceNo: component.referenceNo || String(index + 1),
    name: component.name,
    kind: component.name === input.innovationName ? 'innovation' : 'base',
    purpose: component.purpose,
    position: `坐标 ${component.geometry.position.join(',')}，旋转 ${component.geometry.rotation.join(',')} 度`,
    whyNeeded: component.whyNeeded,
    geometry: component.geometry,
  }));
  const connections: PatentConnection[] = input.connections.map((connection, index) => ({
    ...connection,
    id: `R${String(index + 1).padStart(2, '0')}`,
  }));
  const allComponentIds = components.map(component => component.id);
  const allConnectionIds = connections.map(connection => connection.id);
  return {
    version: 1,
    modelVersion: createModelVersion(),
    productTitle: input.title,
    technicalField: input.technicalField.trim() || `本实用新型涉及${input.title.replace(/^一种/u, '')}技术领域。`,
    baseStructure: input.structure,
    components,
    connections,
    motions: [],
    functions: [input.workingPrinciple.trim()],
    innovationPoints: input.innovationPoints?.filter(Boolean).slice(0, 20) || [input.problemSolved.trim()],
    problemSolved: input.problemSolved.trim(),
    workingPrinciple: input.workingPrinciple.trim(),
    figureSpecs: [
      { id: 'F01', title: '整体结构图', kind: 'overall', componentIds: allComponentIds, connectionIds: allConnectionIds },
      { id: 'F02', title: '侧视结构图', kind: 'side', componentIds: allComponentIds, connectionIds: allConnectionIds },
      { id: 'F03', title: '创新结构局部放大图', kind: 'detail', componentIds: [components.find(component => component.kind === 'innovation')?.id || ''], connectionIds: [] },
    ],
  };
}

const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value: unknown, maxItems: number, maxText = 1000): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.length <= maxItems && value.every(item => text(item, maxText));
const evidenceRefs = (value: unknown) => value === undefined ||
  (Array.isArray(value) && value.length <= 30 && value.every(ref => typeof ref === 'string' && /^EVID-\d{3}$/u.test(ref)) && new Set(value).size === value.length);
export function isProductBrief(value: unknown): value is ProductBrief {
  if (!value || typeof value !== 'object') return false;
  const brief = value as ProductBrief;
  return text(brief.productName, 100) && typeof brief.introduction === 'string' && brief.introduction.length <= 4000 &&
    typeof brief.usageScene === 'string' && brief.usageScene.length <= 2000 &&
    typeof brief.existingStructure === 'string' && brief.existingStructure.length <= 6000 &&
    typeof brief.existingFunctions === 'string' && brief.existingFunctions.length <= 4000 &&
    (brief.improvementType === undefined || Object.hasOwn(improvementTypes, brief.improvementType)) &&
    (brief.structureEvidence === undefined || isStructureEvidenceSelection(brief.structureEvidence)) &&
    (brief.confirmedFacts === undefined || isConfirmedStructureFacts(brief.confirmedFacts)) &&
    (brief.imageData === undefined || (typeof brief.imageData === 'string' && brief.imageData.length <= 2_000_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(brief.imageData)));
}

export function isInnovationNameCandidate(value: unknown): value is InnovationNameCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as InnovationNameCandidate;
  return text(candidate.id, 40) && text(candidate.name, 60) && text(candidate.innovationDirection, 1000) &&
    text(candidate.solvedProblem, 1000) && text(candidate.coreInnovationStructure, 1500) &&
    list(candidate.mainComponents, 20, 100) && text(candidate.implementation, 1500) &&
    !/新型|改进型/u.test(candidate.name);
}

export function isPatentGeometry(value: unknown): value is PatentGeometry {
  return isGeometrySpec(value);
}

export function isPatentStructureModel(value: unknown): value is PatentStructureModel {
  if (!value || typeof value !== 'object') return false;
  const model = value as PatentStructureModel;
  if (model.version !== 1 || (model.improvementType !== undefined && !Object.hasOwn(improvementTypes, model.improvementType)) || (model.modelVersion !== undefined && !text(model.modelVersion, 120)) || !text(model.productTitle, 100) || !text(model.technicalField, 2000) ||
      !text(model.baseStructure, 8000) || !text(model.problemSolved, 3000) || !text(model.workingPrinciple, 8000) ||
      !list(model.functions, 20) || !list(model.innovationPoints, 20) || !Array.isArray(model.components) ||
      model.components.length < 2 || model.components.length > 30 || !Array.isArray(model.connections) ||
      model.connections.length > 80 || !Array.isArray(model.motions) || model.motions.length > 30 ||
      !Array.isArray(model.figureSpecs) || model.figureSpecs.length < 3 || model.figureSpecs.length > 8) return false;

  const ids = new Set<string>();
  for (const component of model.components) {
    if (!evidenceRefs(component.evidenceRefs) || (component.referenceNo !== undefined && !/^\d{1,3}$/u.test(component.referenceNo)) || (component.sourceDraftId !== undefined && !/^D\d{2,3}$/u.test(component.sourceDraftId)) || model.components.filter(other => other.name === component.name).length > 1 || !text(component.id, 10) || !/^C\d{2,3}$/u.test(component.id) || ids.has(component.id) ||
        !text(component.name, 40) || !['base', 'innovation'].includes(component.kind) ||
        !text(component.purpose, 1000) || !text(component.position, 1000) || !text(component.whyNeeded, 1000) || (component.visualFeature !== undefined && !text(component.visualFeature, 300)) ||
        !isPatentGeometry(component.geometry)) return false;
    ids.add(component.id);
  }
  const referenceNumbers = model.components.map((component, index) => component.referenceNo || String(Number(component.id.slice(1)) || index + 1));
  if (new Set(referenceNumbers).size !== referenceNumbers.length) return false;
  const connectionIds = new Set<string>();
  for (const connection of model.connections) {
    if (!evidenceRefs(connection.evidenceRefs) || !text(connection.id, 10) || !/^R\d{2,3}$/u.test(connection.id) || connectionIds.has(connection.id) ||
        !ids.has(connection.from) || !ids.has(connection.to) || connection.from === connection.to ||
        !['connected_to', 'fixed_to', 'slidably_connected', 'rotatably_connected', 'driven_by', 'supported_by', 'limited_by'].includes(connection.relation) ||
        !text(connection.description, 1500)) return false;
    connectionIds.add(connection.id);
  }
  const motionIds = new Set<string>();
  for (const motion of model.motions) {
    if (!evidenceRefs(motion.evidenceRefs) || !text(motion.id, 10) || motionIds.has(motion.id) || !ids.has(motion.componentId) ||
        !text(motion.type, 200) || !text(motion.path, 1000) || !text(motion.purpose, 1000) ||
        (motion.drivenBy !== undefined && !ids.has(motion.drivenBy))) return false;
    motionIds.add(motion.id);
  }
  const figureIds = new Set<string>();
  for (const figure of model.figureSpecs) {
    if (!text(figure.id, 10) || figureIds.has(figure.id) || !text(figure.title, 100) ||
        !['overall', 'side', 'detail'].includes(figure.kind) || (figure.figureId !== undefined && figure.figureId !== figure.id) || (figure.viewType !== undefined && figure.viewType !== figure.kind) ||
        !Array.isArray(figure.componentIds) || figure.componentIds.length === 0 ||
        !figure.componentIds.every(id => ids.has(id)) || (figure.highlightComponentIds !== undefined && (!Array.isArray(figure.highlightComponentIds) || !figure.highlightComponentIds.every(id => ids.has(id)))) || !Array.isArray(figure.connectionIds) ||
        !figure.connectionIds.every(id => connectionIds.has(id))) return false;
    figureIds.add(figure.id);
  }
  const linked = new Set([model.components[0].id]);
  let previousSize = 0;
  while (linked.size !== previousSize) {
    previousSize = linked.size;
    for (const connection of model.connections) {
      if (linked.has(connection.from)) linked.add(connection.to);
      if (linked.has(connection.to)) linked.add(connection.from);
    }
  }
  const illustrated = new Set(model.figureSpecs.flatMap(figure => figure.componentIds));
  return linked.size === ids.size && illustrated.size === ids.size &&
    model.components.some(component => component.kind === 'innovation') &&
    model.figureSpecs.length === 3 && model.figureSpecs.every((figure, index) => figure.kind === (['overall', 'side', 'detail'] as const)[index]) &&
    model.figureSpecs.some(figure => figure.kind === 'detail' && figure.componentIds.some(id => model.components.some(component => component.id === id && component.kind === 'innovation')));
}

export function patentStructureSource(brief: ProductBrief, candidate: InnovationNameCandidate) {
  // A compact change token avoids persisting the user's image or placing it in logs.
  let hash = 2166136261;
  for (const char of brief.imageData || '') hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return JSON.stringify({ brief: { ...brief, imageData: brief.imageData ? `image-${(hash >>> 0).toString(16)}` : undefined }, candidate });
}

export function structureToGeometryText(model: PatentStructureModel) {
  return model.components.map(component => {
    const { geometry } = component;
    const dimensions = geometryDimensions(geometry.shape, geometry.size);
    return `${component.name} | ${geometryShapeLabels[geometry.shape]} | ${geometry.position.join(',')} | ${dimensions.join(',')} | ${geometry.rotation.join(',')}`;
  }).join('\n');
}

export function modelToComponents(model: PatentStructureModel): ComponentSpec[] {
  return model.components.map(component => {
    const geometry = component.geometry;
    const number = Number(component.id.slice(1));
    return { id: number, componentId: component.id, referenceNo: component.referenceNo || String(number), name: component.name, ...(component.visualFeature ? { visualFeature: component.visualFeature } : {}), ...geometry };
  });
}

/** Returns the stable patent-facing number, including for legacy models. */
export function getReferenceNo(component: Pick<PatentComponent, 'id' | 'referenceNo'>, fallbackIndex = 0) {
  return component.referenceNo || String(Number(component.id.slice(1)) || fallbackIndex + 1);
}
