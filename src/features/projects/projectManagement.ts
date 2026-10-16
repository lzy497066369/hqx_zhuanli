import type { Project } from '../../data';
import { hasConfirmedUtilityStructure } from '../../data';
import { validateInventionMaterials } from '../invention/invention';
import { isProductWorkflowComplete, namingFingerprint } from '../product/productWorkflow';

export const filingStatuses = {
  not_submitted: '未提交申报',
  in_progress: '申报中',
  completed: '申报完毕',
} as const;
export type FilingStatus = keyof typeof filingStatuses;

export function baseProductName(project: Partial<Project>): string {
  return project.baseProductName?.trim() || project.naming?.profile.business.trim() ||
    project.naming?.profile.product.trim() || project.productWorkflow?.selection.product.trim() || '';
}

export function isGeneratedPatent(project: Project): boolean {
  if (project.category !== 'utility' && project.category !== 'invention') return false;
  if (project.productWorkflow) return project.productWorkflow.sourceFingerprint === namingFingerprint(project) && isProductWorkflowComplete(project.productWorkflow);
  if (project.utilityMaterials && hasConfirmedUtilityStructure(project)) return true;
  if (project.category === 'invention' && project.inventionMaterials) {
    try { validateInventionMaterials(project.name, project.inventionFacts, project.inventionMaterials); return true; }
    catch { return false; }
  }
  return false;
}
