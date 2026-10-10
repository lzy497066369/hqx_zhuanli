import type { ComponentKind, ConnectionRelation, PatentGeometry } from './patentStructure.ts';
import { improvementTypes } from './naming.ts';
import type { ImprovementType } from './naming.ts';

export type StructureStatus = 'DRAFT' | 'AI_GENERATING' | 'STRUCTURE_REVIEW' | 'STRUCTURE_CONFIRMED' | 'MODEL_COMPILED' | 'FAILED';
export type StructureDraftComponent = {
  id: string; // Persistent draft identity; never derived from array position.
  modelId?: string; // Allocated on successful compilation, never recycled.
  referenceNo?: string; // Patent-facing drawing/text number, separate from modelId.
  name: string;
  kind: ComponentKind;
  parentId?: string;
  purpose: string;
  position: string;
  whyNeeded: string;
  visualFeature?: string;
  geometry?: PatentGeometry;
  /**
   * 该几何是按部件名称推断出的占位值，不是用户或模型给出的实际装配位置。
   * 编译时豁免装配接触校验：占位位置只用于避免部件叠在同一点，无从核对接触，
   * 若不豁免，缺少几何的旧草案会因「推断位置彼此不相接」而永久无法编译。
   * 仅存在于草案层；编译器构造模型时逐字段挑选，不会写入 PatentStructureModel。
   */
  inferredGeometry?: boolean;
};
export type StructureDraftRelationship = {
  id: string;
  from: string;
  to: string;
  relation: ConnectionRelation;
  description: string;
};
export type StructureDraftMotion = {
  id: string;
  componentId: string;
  type: string; // 'static' for a stationary component.
  drivenBy?: string;
  path: string;
  purpose: string;
};
export type StructureDraft = {
  version: 1;
  improvementType?: ImprovementType;
  title: string;
  technicalField: string;
  baseStructure: string;
  components: StructureDraftComponent[];
  relationships: StructureDraftRelationship[];
  motions: StructureDraftMotion[];
  innovationPoints: string[];
  problemSolved: string;
  workingPrinciple: string;
  nextDraftNumber: number;
  nextModelNumber: number;
};

export function emptyStructureDraft(title: string): StructureDraft {
  return { version: 1, title, technicalField: '', baseStructure: '', components: [], relationships: [], motions: [], innovationPoints: [], problemSolved: '', workingPrinciple: '', nextDraftNumber: 1, nextModelNumber: 1 };
}
export function nextDraftComponent(draft: StructureDraft): { id: string; nextDraftNumber: number } {
  const used = Math.max(0, ...draft.components.map(c => Number(c.id.slice(1)) || 0));
  const next = Math.max(draft.nextDraftNumber, used + 1);
  return { id: `D${String(next).padStart(2, '0')}`, nextDraftNumber: next + 1 };
}
export function isStructureDraft(value: unknown): value is StructureDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as StructureDraft;
  if (draft.version !== 1 || (draft.improvementType !== undefined && !Object.hasOwn(improvementTypes, draft.improvementType)) || typeof draft.title !== 'string' || typeof draft.technicalField !== 'string' || typeof draft.baseStructure !== 'string' ||
      typeof draft.problemSolved !== 'string' || typeof draft.workingPrinciple !== 'string' ||
      !Number.isInteger(draft.nextDraftNumber) || draft.nextDraftNumber < 1 || !Number.isInteger(draft.nextModelNumber) || draft.nextModelNumber < 1 ||
      !Array.isArray(draft.components) || draft.components.length > 30 || !Array.isArray(draft.relationships) || draft.relationships.length > 80 ||
      !Array.isArray(draft.motions) || draft.motions.length > 30 || !Array.isArray(draft.innovationPoints) || !draft.innovationPoints.every(p => typeof p === 'string')) return false;
  const ids = draft.components.map(c => c?.id);
  return ids.every(id => typeof id === 'string' && /^D\d{2,3}$/u.test(id)) && new Set(ids).size === ids.length &&
    draft.components.every(c => (c.referenceNo === undefined || /^\d{1,3}$/u.test(c.referenceNo)) && typeof c.name === 'string' && typeof c.purpose === 'string' && typeof c.position === 'string' && typeof c.whyNeeded === 'string' && (c.visualFeature === undefined || typeof c.visualFeature === 'string' && c.visualFeature.length <= 300) && ['base', 'innovation'].includes(c.kind) &&
      (c.modelId === undefined || /^C\d{2,3}$/u.test(c.modelId)) && (c.parentId === undefined || typeof c.parentId === 'string')) &&
    draft.relationships.every(r => r && typeof r.id === 'string' && typeof r.from === 'string' && typeof r.to === 'string' && typeof r.description === 'string' && typeof r.relation === 'string') &&
    draft.motions.every(m => m && typeof m.id === 'string' && typeof m.componentId === 'string' && typeof m.type === 'string' && (m.drivenBy === undefined || typeof m.drivenBy === 'string') && typeof m.path === 'string' && typeof m.purpose === 'string');
}
