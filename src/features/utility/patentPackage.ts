import type { Project, UtilityDrawing, UtilityMaterials } from '../../data.ts';
import { buildReasoningPackage } from './patentReasoning.ts';
import { createPatentGenerationContext } from './claimPlan.ts';
import { sanitizeFinalPatentDocument } from './finalDocumentSanitizer.ts';
import { validatePatentDocument } from './patentValidator.ts';
import type { ValidationReport } from './patentValidator.ts';
import { getModelVersion, isPatentStructureModel } from './patentStructure.ts';
import type { PatentGenerationContext } from './claimPlan.ts';

/** Persisted consistency record, not a signature or a client trust boundary. */
export type GenerationProof = {
  version: 1;
  contextSnapshot: string;
  documentSnapshot: string;
  reviews: Array<{ issues: Array<{ id: string; severity: string }>; fixedIssueIds: string[] }>;
  polish: { before: string; after: string };
  validation: { readyForExport: boolean; issues: Array<{ severity: string }>; qualityScore: number; qualityThreshold: number };
};

export function generationSnapshot(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export function generationDocumentSnapshot(document: Pick<UtilityMaterials, 'abstract' | 'technicalField' | 'background' | 'content' | 'drawings' | 'embodiment' | 'claimReferences'> & { claims: string | string[] }): string {
  const { abstract, technicalField, background, content, drawings, embodiment, claimReferences } = document;
  return generationSnapshot({ abstract, claims: Array.isArray(document.claims) ? document.claims.join('\n') : document.claims,
    technicalField, background, content, drawings, embodiment, claimReferences });
}

export function assertGenerationProof(materials: UtilityMaterials, context: PatentGenerationContext): void {
  const proof = materials.generationProof;
  if (!proof || proof.version !== 1 || proof.contextSnapshot !== generationSnapshot(context) ||
      proof.documentSnapshot !== generationDocumentSnapshot(materials) ||
      !Array.isArray(proof.reviews) || proof.reviews.length < 2 ||
      proof.reviews.some((review, index) => !Array.isArray(review.issues) || !Array.isArray(review.fixedIssueIds) ||
        review.issues.some(issue => !['error', 'warning', 'suggestion'].includes(issue.severity) ||
          (issue.severity === 'error' && !review.fixedIssueIds.includes(issue.id))) ||
        (index === proof.reviews.length - 1 && (review.issues.some(issue => issue.severity === 'error') || review.fixedIssueIds.length > 0))) ||
      !proof.polish?.before || proof.polish.before !== proof.polish.after ||
      proof.validation?.readyForExport !== true || !Array.isArray(proof.validation.issues) ||
      proof.validation.issues.some(issue => !['warning', 'suggestion'].includes(issue.severity)) ||
      !Number.isFinite(proof.validation.qualityScore) || !Number.isFinite(proof.validation.qualityThreshold) ||
      proof.validation.qualityThreshold < 75 || proof.validation.qualityScore < proof.validation.qualityThreshold) {
    throw new Error('缺少有效的 V2 审核、润色和验证记录，或生成事实/正文已变化，请重新生成文案');
  }
}

export class PatentValidationError extends Error {
  readonly report: ValidationReport;

  constructor(report: ValidationReport) {
    super(`最终校验未通过，无法导出：${report.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('；')}`);
    this.report = report;
    this.name = 'PatentValidationError';
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Clone before freezing: never freeze UI state, and never render mutable input. */
export function freezePatentPackage(project: Project, drawing: UtilityDrawing, materials: UtilityMaterials) {
  const snapshot = structuredClone({ project, drawing, materials });
  const model = snapshot.drawing.patentStructureModel;
  const evidence = snapshot.drawing.evidencePackage;
  if (materials.generationSource !== 'materials-v2' || !model || materials.sourceModelVersion !== getModelVersion(model)) throw new Error('文案不是当前结构模型的 V2 校验结果，请重新生成文案');
  if (!isPatentStructureModel(model) || model.productTitle !== project.name) throw new Error('结构模型尚未确认或名称已变化，请重新确认结构');
  if (!evidence) throw new Error('缺少证据包，请重新确认结构后再导出');
  if (!snapshot.drawing.design?.structureModel) throw new Error('缺少模型驱动的附图，请重新生成附图');
  const reasoning = buildReasoningPackage(model, evidence);
  const context = createPatentGenerationContext(model, evidence, reasoning);
  assertGenerationProof(snapshot.materials, context);
  const document = sanitizeFinalPatentDocument(project.name, model, snapshot.materials, project.category === 'invention' ? 'invention' : 'utility', true);
  const validationReport = validatePatentDocument({ context, document, design: snapshot.drawing.design,
    claimReferences: snapshot.materials.claimReferences, sourceModelVersion: snapshot.materials.sourceModelVersion });
  if (!validationReport.readyForExport) throw new PatentValidationError(validationReport);
  return deepFreeze({ version: 1 as const, frozenAt: new Date().toISOString(), context,
    document, figureSpecs: model.figureSpecs, validationReport, drawing: snapshot.drawing, project: snapshot.project });
}
