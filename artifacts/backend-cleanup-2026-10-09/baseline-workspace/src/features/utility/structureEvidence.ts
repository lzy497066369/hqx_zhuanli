import { isPatentShape } from './geometrySpec.ts';
import type { PatentShape } from './geometrySpec.ts';

export type StructureEvidenceCategory = 'component' | 'relationship' | 'motion' | 'geometry' | 'problem';

export const structureEvidenceCategoryLabels: Record<StructureEvidenceCategory, string> = {
  component: '产品结构',
  relationship: '部件连接',
  motion: '运动关系',
  geometry: '可表达几何',
  problem: '待解决问题',
};

export type StructureEvidenceOption = {
  id: string;
  category: StructureEvidenceCategory;
  label: string;
  detail: string;
  technicalMeaning: string;
};

export type StructureEvidenceSelection = {
  version: 1;
  options: StructureEvidenceOption[];
  selectedIds: string[];
  confirmed: boolean;
};

export type StructureAssistanceStatus = 'ready' | 'needs_information' | 'unsupported';

export type GeometryAlternativeShape = Extract<PatentShape, 'box' | 'cylinder' | 'tube'>;

const geometryAlternativeShapes = new Set<GeometryAlternativeShape>(['box', 'cylinder', 'tube']);

export type GeometryAlternative = {
  id: string;
  component: string;
  shape: GeometryAlternativeShape;
  description: string;
  condition: string;
};

export type GeometryRevision = {
  component: string;
  shape: PatentShape;
  change: string;
  preservedInnovation: string;
  condition: string;
};

export function isGeometryRevision(value: unknown): value is GeometryRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as GeometryRevision;
  return typeof item.component === 'string' && !!item.component.trim() && item.component.length <= 100 &&
    isPatentShape(item.shape) &&
    [item.change, item.preservedInnovation, item.condition].every(text => typeof text === 'string' && !!text.trim() && text.length <= 500);
}

export function isGeometryAlternatives(value: unknown): value is GeometryAlternative[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3 &&
    value.every(item => !!item && typeof item === 'object' &&
      typeof item.id === 'string' && /^G0[1-3]$/u.test(item.id) &&
      typeof item.component === 'string' && !!item.component.trim() && item.component.length <= 100 &&
      geometryAlternativeShapes.has(item.shape) &&
      typeof item.description === 'string' && !!item.description.trim() && item.description.length <= 500 &&
      typeof item.condition === 'string' && !!item.condition.trim() && item.condition.length <= 500) &&
    new Set(value.map(item => item.id)).size === value.length;
}

export type StructureAssistanceResponse = {
  status: Exclude<StructureAssistanceStatus, 'ready'>;
  summary: string;
  questions: string[];
  options: StructureEvidenceOption[];
  unsupportedReason?: string;
  geometryAlternatives?: GeometryAlternative[];
  geometryRevision?: GeometryRevision;
};

const categories = new Set<StructureEvidenceCategory>(Object.keys(structureEvidenceCategoryLabels) as StructureEvidenceCategory[]);

export function isStructureEvidenceOption(value: unknown): value is StructureEvidenceOption {
  if (!value || typeof value !== 'object') return false;
  const option = value as StructureEvidenceOption;
  return typeof option.id === 'string' && /^E\d{2,3}$/u.test(option.id) &&
    categories.has(option.category) && typeof option.label === 'string' && option.label.trim().length > 0 && option.label.length <= 120 &&
    typeof option.detail === 'string' && option.detail.trim().length > 0 && option.detail.length <= 500 &&
    typeof option.technicalMeaning === 'string' && option.technicalMeaning.trim().length > 0 && option.technicalMeaning.length <= 500;
}

export function isStructureEvidenceSelection(value: unknown): value is StructureEvidenceSelection {
  if (!value || typeof value !== 'object') return false;
  const selection = value as StructureEvidenceSelection;
  return selection.version === 1 && Array.isArray(selection.options) && selection.options.length >= 4 && selection.options.length <= 30 &&
    selection.options.every(isStructureEvidenceOption) && new Set(selection.options.map(option => option.id)).size === selection.options.length &&
    Array.isArray(selection.selectedIds) && selection.selectedIds.length <= selection.options.length &&
    selection.selectedIds.every(id => typeof id === 'string') &&
    new Set(selection.selectedIds).size === selection.selectedIds.length && selection.selectedIds.every(id => selection.options.some(option => option.id === id)) &&
    typeof selection.confirmed === 'boolean';
}

export function isStructureEvidenceOptions(value: unknown, required: StructureEvidenceCategory[] = []): value is StructureEvidenceOption[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 30 &&
    value.every(isStructureEvidenceOption) && new Set(value.map(option => option.id)).size === value.length &&
    required.every(category => value.some(option => option.category === category));
}

export function selectedStructureEvidence(selection?: StructureEvidenceSelection) {
  if (!selection) return [];
  const chosen = new Set(selection.selectedIds);
  return selection.options.filter(option => chosen.has(option.id));
}

export function missingStructureEvidenceCategories(selection?: StructureEvidenceSelection): StructureEvidenceCategory[] {
  const selected = selectedStructureEvidence(selection);
  return (['component', 'relationship', 'motion', 'geometry'] as StructureEvidenceCategory[]).filter(category => !selected.some(option => option.category === category));
}
