import { hasConfirmedUtilityStructure } from '../../data';
import type { Project } from '../../data';
import { validateInventionMaterials } from '../invention/invention';
import { createInventionWordBlob, inventionWordFilename, prepareInventionPatentExport } from '../invention/wordExport';
import { isProductWorkflowComplete, namingFingerprint } from '../product/productWorkflow';
import type { ProductWorkflow } from '../product/productWorkflow';
import { createProductWordBlob, prepareProductPatentExport, productWordFilename } from '../product/productWordExport';
import { createUtilityWordBlob, prepareUtilityPatentExport, utilityWordFilename } from '../utility/wordExport';

export type PatentExportFormat = 'word' | 'pdf';
const filename = (wordFilename: string, format: PatentExportFormat) => format === 'pdf' ? wordFilename.replace(/\.docx$/, '.pdf') : wordFilename;

export async function exportProductPatent(workflow: ProductWorkflow, format: PatentExportFormat) {
  const blob = format === 'word' ? await createProductWordBlob(workflow)
    : await (await import('./patentPdf')).createPatentPdfBlob(await prepareProductPatentExport(workflow));
  return { blob, filename: filename(productWordFilename(workflow), format) };
}

export function canExportPatent(project: Project): boolean {
  if (project.productWorkflow) return project.productWorkflow.sourceFingerprint === namingFingerprint(project) && isProductWorkflowComplete(project.productWorkflow);
  if (project.category !== 'invention' && project.category !== 'utility') return false;
  if (hasConfirmedUtilityStructure(project)) return !!project.utilityDrawing && project.utilityMaterials?.generationSource === 'materials-v2';
  if (project.category === 'invention') {
    try { validateInventionMaterials(project.name, project.inventionFacts, project.inventionMaterials); return true; } catch { return false; }
  }
  return false;
}

export async function exportProjectPatent(project: Project, format: PatentExportFormat) {
  if (project.productWorkflow) {
    if (project.productWorkflow.sourceFingerprint !== namingFingerprint(project)) throw new Error('名称或特征已改变，请重新完成当前产品的预览确认。');
    return exportProductPatent(project.productWorkflow, format);
  }
  if (project.category !== 'utility' && project.category !== 'invention') throw new Error('此项目不是专利申请材料。');
  if (hasConfirmedUtilityStructure(project)) {
    if (!project.utilityDrawing || !project.utilityMaterials) throw new Error('请先生成并校验当前结构的 V2 文案，不能导出旧版材料');
    const blob = format === 'word' ? await createUtilityWordBlob(project, project.utilityDrawing, project.utilityMaterials)
      : await (await import('./patentPdf')).createPatentPdfBlob(await prepareUtilityPatentExport(project, project.utilityDrawing, project.utilityMaterials));
    return { blob, filename: filename(utilityWordFilename(project.name, project.category), format) };
  }
  if (project.category === 'utility') throw new Error('请先确定 Patent Structure Model，才能导出申请材料');
  const blob = format === 'word' ? await createInventionWordBlob(project)
    : await (await import('./patentPdf')).createPatentPdfBlob(prepareInventionPatentExport(project));
  return { blob, filename: filename(inventionWordFilename(project.name), format) };
}

export function downloadExport(file: { blob: Blob; filename: string }) {
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
