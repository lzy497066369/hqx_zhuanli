import type { Project } from '../../data.ts';
import { CAD_VIEWS, PATENT_FIGURE_TEMPLATES, PREVIEW_VIEWS } from './productPrompts.ts';
import { drawingCoverageErrors, drawingManifestDigest, drawingPlanErrors } from './productDrawing.ts';
import type { DrawingPlan, DrawingAnnotation } from './productDrawing.ts';
import { isTokenUsage } from './tokenUsage.ts';
import type { TokenUsage } from './tokenUsage.ts';
import { isTextStructure, isTextDraft, isFrozenTechnicalSource, isTextRecord, checkTextDocument, documentContent } from './productText.ts';
import type { FrozenTechnicalSource, TextStructure, TextDraft, TextRecord } from './productText.ts';
import { isProblemSelection } from './productProblems.ts';
import type { ProblemSelection } from './productProblems.ts';

export const LOGIC_DIMENSIONS = {
  identity: '名称与保护客体', structure: '部件与连接', motion: '固定与运动',
  geometry: '空间与装配', materials: '材料与使用环境', function: '功能实现条件', safety: '安全与制造边界',
} as const;
export type LogicDimension = keyof typeof LOGIC_DIMENSIONS;
export type ProductChoice = { id: string; category: string; text: string };
export type ProductSelection = {
  company: string; business: string; product: string; proposedName: string;
  patentType: 'utility' | 'invention'; improvementType: string;
  choices: ProductChoice[]; visualPreferences: string;
  selectedProblem?: ProblemSelection;
};
export type ChoiceChanges = { removeIds: string[]; replacements: { id: string; text: string }[]; proposedName?: string };
export type ConflictOption = ChoiceChanges & { id: string; label: string; explanation: string };
export type LogicConflict = { id: string; title: string; reason: string; affectedChoiceIds: string[]; options: ConflictOption[] };
export type LogicCheck = { dimension: LogicDimension; status: 'pass' | 'assumption' | 'conflict'; explanation: string };
export type LogicResult = {
  verdict: 'feasible' | 'conflicts'; summary: string; checks: LogicCheck[];
  conflicts: LogicConflict[]; assumptions: string[];
};
export type ProductReview = LogicResult & { id: string; selection: ProductSelection; createdAt: string; signature: string };
export type ProductComponent = { number: string; name: string; structure: string; connection: string; purpose: string };
export type ProductDesign = {
  title: string; technicalField: string; useCase: string; overview: string; appearance: string;
  components: ProductComponent[]; workingPrinciple: string; innovation: string; assumptions: string[];
  choiceCoverage: { choiceId: string; description: string }[];
};
export type ProductBrief = {
  id: string; reviewId: string; selection: ProductSelection; design: ProductDesign; description: string;
  technicalSource?: FrozenTechnicalSource;
  createdAt: string; signature: string;
};
export type ProductImageRef = {
  id: string; briefId: string; kind: 'preview' | 'patent'; templateId: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; digest: string; createdAt: string; signature: string;
};
export type ProductImage = ProductImageRef & { dataUrl: string; prompt: string; model: string };
// 彩色预览先生成主体图，再以它为参考依次生成三个视图；视角定义集中在 productPrompts.ts。
export { PREVIEW_VIEWS, CAD_VIEWS, FIGURE_CATALOG } from './productPrompts.ts';
export type { CadViewId } from './productPrompts.ts';
export type ProductPreviewRef = {
  id: string; briefId: string; viewIds: string[]; digest: string; createdAt: string; signature: string;
};
export type ProductPreview = ProductPreviewRef & { images: ProductImage[] };
export type CadViewDrawing = { view: string; annotations?: DrawingAnnotation[]; title: string; svg: string; width: number; height: number; digest: string };
/** 部件标号锚点：视觉模型在脚本坐标系中给出的部件外表面一点，投影时吸附到模型表面。 */
export type CadLabel = { number: string; name: string; point: [number, number, number] };
export type ProductCad = {
  drawingVersion?: 1; drawingPlan?: DrawingPlan;
  generationModel?: string;
  visualReview?: { status: 'passed'; summary: string; figureIds: string[] };
  id: string; briefId: string; script: string; summary: string; assumptions: string[];
  labels: CadLabel[]; keyStructure?: { point: [number, number, number]; radius: number };
  meshDigest: string; vertexCount: number; triangleCount: number; freecadVersion: string;
  views: CadViewDrawing[]; createdAt: string; signature: string;
};
export type PreviewConfirmation = {
  briefId: string; previewId: string; previewDigest: string; confirmedAt: string; signature: string;
};
export type ProductDocumentContent = {
  abstract: string; claims: string[]; technicalField: string; background: string;
  content: string; drawings: string; embodiment: string;
};
export type ProductMaterials = ProductDocumentContent & { briefId: string; title: string; createdAt: string; signature: string; drawingDigest?: string; textRecord?: TextRecord };
export type RevisionQuestion = { id: string; question: string; options: string[] };
export type RevisionDialogue = {
  briefId: string; intent: string; summary: string; questions: RevisionQuestion[]; signature: string;
};
export type RevisionInput = { text: string; directions: string[]; answers: { questionId: string; text: string }[] };
export type RevisionResponse =
  | { status: 'needs_information'; dialogue: RevisionDialogue }
  | { status: 'ready'; selection: ProductSelection; summary: string };
export type ProductGenerationStatus = {
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  label: string;
  detail: string;
  steps: { label: string; detail: string }[];
  startedAt: string;
  updatedAt: string;
  error?: string;
};
export type ProductWorkflow = {
  version: 2; sourceFingerprint: string; selection: ProductSelection; review?: ProductReview;
  brief?: ProductBrief; previews?: ProductPreview; cad?: ProductCad; confirmation?: PreviewConfirmation;
  materials?: ProductMaterials; figures: Record<string, ProductImage>; revision?: RevisionDialogue;
  textStructure?: TextStructure; textDraft?: TextDraft;
  previous?: ProductWorkflow;
  generation?: ProductGenerationStatus;
  tokenUsage?: TokenUsage[];
  tokenUsageIncomplete?: boolean;
  /** 旧版单张三视图预览；仅为保留历史数据，不能用于确认或生成成品。 */
  preview?: ProductImage;
  redrawCount: number; updatedAt: string;
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
// Explicitly reject invalid C0 text controls while allowing tabs and line breaks.
export const productText = (value: unknown, max = 4000, empty = false): value is string =>
  // oxlint-disable-next-line no-control-regex -- Reject invalid C0 controls, not user content.
  typeof value === 'string' && value.length <= max && (empty || !!value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const texts = (value: unknown, maxItems = 30, maxLength = 2000): value is string[] =>
  Array.isArray(value) && value.length <= maxItems && value.every(item => productText(item, maxLength));
const unique = (values: string[]) => new Set(values).size === values.length;
const signed = (value: Record<string, unknown>) => typeof value.signature === 'string' && /^[a-f0-9]{64}$/.test(value.signature);
const timestamp = (value: unknown) => productText(value, 40) && Number.isFinite(Date.parse(value));
export function isProductSelection(value: unknown): value is ProductSelection {
  if (!object(value)) return false;
  return productText(value.company, 100, true) && productText(value.business, 1000) && productText(value.product, 200) &&
    productText(value.proposedName, 100) && ['utility', 'invention'].includes(String(value.patentType)) &&
    productText(value.improvementType, 100, true) && productText(value.visualPreferences, 6000, true) &&
    Array.isArray(value.choices) && value.choices.length > 0 && value.choices.length <= 80 &&
    value.choices.every(item => object(item) && productText(item.id, 80) && /^[a-zA-Z0-9_-]+$/.test(item.id) && productText(item.category, 80) && productText(item.text, 3000)) &&
    unique(value.choices.map(item => item.id as string)) &&
    (value.selectedProblem === undefined || (isProblemSelection(value.selectedProblem) && value.selectedProblem.product === value.product));
}
export function isChoiceChanges(value: unknown, selection: ProductSelection): value is ChoiceChanges {
  if (!object(value)) return false;
  const ids = new Set(selection.choices.map(choice => choice.id));
  return texts(value.removeIds, 80, 80) && unique(value.removeIds) && value.removeIds.every(id => ids.has(id)) &&
    Array.isArray(value.replacements) && value.replacements.length <= 80 &&
    value.replacements.every(item => object(item) && productText(item.id, 80) && ids.has(item.id) && productText(item.text, 3000) && !(value.removeIds as string[]).includes(item.id)) &&
    unique(value.replacements.map(item => item.id as string)) &&
    (value.proposedName === undefined || productText(value.proposedName, 100));
}
export function isLogicResult(value: unknown, selection: ProductSelection): value is LogicResult {
  if (!object(value) || !['feasible', 'conflicts'].includes(String(value.verdict)) || !productText(value.summary, 3000) || !texts(value.assumptions)) return false;
  if (!Array.isArray(value.checks) || value.checks.length !== Object.keys(LOGIC_DIMENSIONS).length ||
    !value.checks.every(item => object(item) && Object.hasOwn(LOGIC_DIMENSIONS, String(item.dimension)) && ['pass', 'assumption', 'conflict'].includes(String(item.status)) && productText(item.explanation, 2000)) ||
    !unique(value.checks.map(item => item.dimension as string))) return false;
  if (!Array.isArray(value.conflicts) || value.conflicts.length > 12) return false;
  const ids = new Set([...selection.choices.map(choice => choice.id), 'name']);
  if (!value.conflicts.every(conflict => object(conflict) && productText(conflict.id, 80) && productText(conflict.title, 200) && productText(conflict.reason, 3000) &&
    texts(conflict.affectedChoiceIds, 80, 80) && conflict.affectedChoiceIds.length > 0 && conflict.affectedChoiceIds.every(id => ids.has(id)) &&
    Array.isArray(conflict.options) && conflict.options.length >= 2 && conflict.options.length <= 6 &&
    conflict.options.every(option => object(option) && productText(option.id, 80) && productText(option.label, 200) && productText(option.explanation, 2000) && isChoiceChanges(option, selection) &&
      (option.removeIds.length > 0 || option.replacements.length > 0 || !!option.proposedName) && option.removeIds.length < selection.choices.length) &&
    unique(conflict.options.map(option => option.id as string)))) return false;
  if (!unique(value.conflicts.map(conflict => conflict.id as string))) return false;
  const hasConflict = value.checks.some(item => item.status === 'conflict');
  return value.verdict === 'feasible' ? value.conflicts.length === 0 && !hasConflict : value.conflicts.length > 0 && hasConflict;
}
export function isProductReview(value: unknown): value is ProductReview {
  return object(value) && productText(value.id, 80) && timestamp(value.createdAt) && signed(value) &&
    isProductSelection(value.selection) && isLogicResult(value, value.selection);
}
export function applyConflictChoices(review: ProductReview, choices: Record<string, string>): ProductSelection {
  const removals = new Set<string>();
  const replacements = new Map<string, string>();
  let title: string | undefined;
  for (const conflict of review.conflicts) {
    const option = conflict.options.find(item => item.id === choices[conflict.id]);
    if (!option) throw new Error('请为每一项矛盾选择一个处理方案。');
    for (const id of option.removeIds) {
      if (replacements.has(id)) throw new Error('所选处理方案对同一特征既保留又删除，请调整选择。');
      removals.add(id);
    }
    for (const replacement of option.replacements) {
      if (removals.has(replacement.id) || (replacements.has(replacement.id) && replacements.get(replacement.id) !== replacement.text)) throw new Error('所选处理方案对同一特征的修改不一致，请调整选择。');
      replacements.set(replacement.id, replacement.text);
    }
    if (option.proposedName) {
      if (title && title !== option.proposedName) throw new Error('所选处理方案中的产品名称不一致，请调整选择。');
      title = option.proposedName;
    }
  }
  const selection: ProductSelection = { ...review.selection, proposedName: title || review.selection.proposedName,
    choices: review.selection.choices.filter(choice => !removals.has(choice.id)).map(choice => ({ ...choice, text: replacements.get(choice.id) ?? choice.text })) };
  if (!isProductSelection(selection)) throw new Error('调整后缺少有效的产品特征，请保留核心结构。');
  return selection;
}
export function isProductDesign(value: unknown, selection: ProductSelection): value is ProductDesign {
  if (!object(value) || !productText(value.title, 100) || value.title !== selection.proposedName ||
    !['technicalField', 'useCase', 'overview', 'appearance', 'workingPrinciple', 'innovation'].every(key => productText(value[key], 10000)) || !texts(value.assumptions)) return false;
  if (!Array.isArray(value.components) || value.components.length < 1 || value.components.length > 12 ||
    !value.components.every(part => object(part) && typeof part.number === 'string' && /^[1-9]\d{0,2}$/.test(part.number) && productText(part.name, 80) && ['structure', 'connection', 'purpose'].every(key => productText(part[key], 3000))) ||
    !unique(value.components.map(part => part.number as string)) ||
    !unique(value.components.map(part => part.name as string))) return false;
  return Array.isArray(value.choiceCoverage) && value.choiceCoverage.length === selection.choices.length &&
    value.choiceCoverage.every(item => object(item) && productText(item.choiceId, 80) && selection.choices.some(choice => choice.id === item.choiceId) && productText(item.description, 2000)) &&
    unique(value.choiceCoverage.map(item => item.choiceId as string));
}
export function renderProductDescription(design: ProductDesign): string {
  return [
    `产品名称：${design.title}`, `技术领域：${design.technicalField}`, `用途与使用场景：${design.useCase}`,
    `产品整体介绍：\n${design.overview}`, `外观、配色与视图表达：\n${design.appearance}`,
    '主体与结构：\n' + design.components.map(part => `${part.number} ${part.name}：${part.structure}；连接关系：${part.connection}；作用：${part.purpose}`).join('\n'),
    `工作原理：\n${design.workingPrinciple}`, `改进要点：\n${design.innovation}`,
    '已选特征落实：\n' + design.choiceCoverage.map(item => item.description).join('\n'),
    '合理推定与待核实事项：\n' + (design.assumptions.join('\n') || '具体尺寸、公差与工艺仍须工程核实。'),
  ].join('\n\n');
}
export function isProductBrief(value: unknown): value is ProductBrief {
  return object(value) && productText(value.id, 80) && productText(value.reviewId, 80) && timestamp(value.createdAt) && signed(value) &&
    (value.technicalSource === undefined || (isFrozenTechnicalSource(value.technicalSource) && object(value.design) && value.technicalSource.plan.title === value.design.title)) &&
    isProductSelection(value.selection) && isProductDesign(value.design, value.selection) && value.description === renderProductDescription(value.design);
}
export function imageReference(image: ProductImageRef): ProductImageRef {
  return { id: image.id, briefId: image.briefId, kind: image.kind, templateId: image.templateId, mimeType: image.mimeType,
    digest: image.digest, createdAt: image.createdAt, signature: image.signature };
}
/** 确认只上传预览集合的签名引用，不重复上传四张图片的 base64。 */
export function previewReference(preview: ProductPreviewRef): ProductPreviewRef {
  return { id: preview.id, briefId: preview.briefId, viewIds: [...preview.viewIds], digest: preview.digest, createdAt: preview.createdAt, signature: preview.signature };
}
export function isProductImageRef(value: unknown): value is ProductImageRef {
  return object(value) && ['id', 'briefId', 'templateId'].every(key => productText(value[key], 80)) &&
    ['preview', 'patent'].includes(String(value.kind)) && ['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mimeType)) &&
    typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest) && timestamp(value.createdAt) && signed(value);
}
export function isProductImage(value: unknown): value is ProductImage {
  if (!isProductImageRef(value)) return false;
  const image = value as ProductImage;
  return productText(image.prompt, 120000) && productText(image.model, 100) && typeof image.dataUrl === 'string' &&
    image.dataUrl.length <= 24 * 1024 * 1024 && image.dataUrl.startsWith(`data:${image.mimeType};base64,`) && /^[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl.split(',')[1] || '');
}
export function isProductPreviewRef(value: unknown): value is ProductPreviewRef {
  return object(value) && ['id', 'briefId'].every(key => productText(value[key], 80)) && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest) &&
    Array.isArray(value.viewIds) && value.viewIds.length > 0 && value.viewIds.length <= 8 &&
    value.viewIds.every(view => productText(view, 40) && PREVIEW_VIEWS.some(item => item.id === view)) && unique(value.viewIds as string[]) && timestamp(value.createdAt) && signed(value);
}
export function isProductPreview(value: unknown): value is ProductPreview {
  if (!object(value) || !isProductPreviewRef(value)) return false;
  const preview = value as unknown as ProductPreview;
  return Array.isArray(preview.images) && preview.images.length === preview.viewIds.length && preview.images.every(isProductImage) &&
    preview.images.every(image => image.briefId === preview.briefId && image.kind === 'preview') &&
    preview.viewIds.every(view => preview.images.filter(image => image.templateId === `color-${view}`).length === 1);
}
export function hasCompletePreviewViews(preview: ProductPreview | undefined, briefId: string | undefined): boolean {
  return !!preview && !!briefId && preview.briefId === briefId && preview.viewIds.length === PREVIEW_VIEWS.length &&
    PREVIEW_VIEWS.every(item => preview.images.some(image => image.templateId === item.templateId && image.briefId === briefId && image.kind === 'preview'));
}
const cadViews = new Set<string>(CAD_VIEWS.map(item => item.id));
const point3 = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e6);
export function isCadLabels(value: unknown): value is CadLabel[] {
  return Array.isArray(value) && value.length <= 30 && value.every(item => object(item) && productText(item.number, 4) && /^\d{1,3}$/.test(String(item.number)) && productText(item.name, 80) && point3(item.point)) &&
    unique(value.map(item => String((item as CadLabel).number)));
}
export function isProductCad(value: unknown): value is ProductCad {
  if (!object(value) || !productText(value.id, 80) || !productText(value.briefId, 80) || !timestamp(value.createdAt) || !signed(value)) return false;
  if (!productText(value.script, 30000) || !productText(value.summary, 4000) || !texts(value.assumptions, 20, 2000) || !productText(value.freecadVersion, 200)) return false;
  if (!isCadLabels(value.labels)) return false;
  if (value.generationModel !== undefined && !productText(value.generationModel, 200)) return false;
  if (value.visualReview !== undefined && (!object(value.visualReview) || value.visualReview.status !== 'passed' || !productText(value.visualReview.summary, 4000) || !texts(value.visualReview.figureIds, 8, 40))) return false;
  if (value.drawingVersion !== undefined && (value.drawingVersion !== 1 || drawingPlanErrors(value.drawingPlan).length)) return false;
  if (value.keyStructure !== undefined && !(object(value.keyStructure) && point3(value.keyStructure.point) && typeof value.keyStructure.radius === 'number' && value.keyStructure.radius >= 0.1 && value.keyStructure.radius <= 5000)) return false;
  if (typeof value.meshDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.meshDigest)) return false;
  if (!Number.isSafeInteger(value.vertexCount) || (value.vertexCount as number) < 3 || !Number.isSafeInteger(value.triangleCount) || (value.triangleCount as number) < 1) return false;
  if (!Array.isArray(value.views) || value.views.length < 1 || value.views.length > 8) return false;
  return value.views.every(view => object(view) && (value.drawingVersion === 1 ? /^figure-[1-8]$/.test(String(view.view)) && productText(view.title, 100) : cadViews.has(String(view.view)) && CAD_VIEWS.some(item => item.id === view.view && item.title === view.title)) &&
    (value.drawingVersion !== 1 || (Array.isArray(view.annotations) && view.annotations.length > 0 && view.annotations.length <= 30 &&
      view.annotations.every(a => object(a) && typeof a.number === 'string' && /^[1-9]\d{0,2}$/.test(a.number) && typeof a.owner === 'string' && /^[1-9]\d{0,2}$/.test(a.owner) &&
        [a.anchor, a.position].every(v => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 6000))))) &&
    productText(view.svg, 600000) && String(view.svg).startsWith('<svg') && String(view.svg).trimEnd().endsWith('</svg>') &&
    Number.isSafeInteger(view.width) && (view.width as number) >= 100 && (view.width as number) <= 6000 &&
    Number.isSafeInteger(view.height) && (view.height as number) >= 100 && (view.height as number) <= 6000 &&
    typeof view.digest === 'string' && /^[a-f0-9]{64}$/.test(view.digest)) && unique(value.views.map(view => String(view.view)));
}
export function isPreviewConfirmation(value: unknown): value is PreviewConfirmation {
  return object(value) && productText(value.briefId, 80) && productText(value.previewId, 80) &&
    typeof value.previewDigest === 'string' && /^[a-f0-9]{64}$/.test(value.previewDigest) && timestamp(value.confirmedAt) && signed(value);
}
export function isProductDocumentContent(value: unknown): value is ProductDocumentContent {
  return object(value) && ['abstract', 'technicalField', 'background', 'content', 'drawings', 'embodiment'].every(key => productText(value[key], 30000)) &&
    texts(value.claims, 20, 6000) && value.claims.length > 0 && value.claims.every((claim, index) => new RegExp(`^${index + 1}[.．、]`).test(claim.trim()));
}
export function isProductMaterials(value: unknown): value is ProductMaterials {
  if (!object(value) || !productText(value.briefId, 80) || !productText(value.title, 100) || !timestamp(value.createdAt) || !signed(value)) return false;
  const record = value;
  const hasContent = isProductDocumentContent(value);
  if (!hasContent) return false;
  if (record.textRecord === undefined) return true;
  if (!isTextRecord(record.textRecord)) return false;
  const content = documentContent(record.textRecord.document);
  return record.title === record.textRecord.document.title && Object.entries(content).every(([key, entry]) => JSON.stringify(record[key]) === JSON.stringify(entry));
}
export function isRevisionQuestions(value: unknown): value is RevisionQuestion[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 4 &&
    value.every(question => object(question) && productText(question.id, 80) && productText(question.question, 1000) && texts(question.options, 6, 500) && question.options.length >= 2 && unique(question.options)) && unique(value.map(question => question.id));
}
export function isRevisionDialogue(value: unknown): value is RevisionDialogue {
  return object(value) && productText(value.briefId, 80) && productText(value.intent, 12000) && productText(value.summary, 3000) && isRevisionQuestions(value.questions) && signed(value);
}
export function namingFingerprint(project: Project): string {
  const naming = project.naming;
  return JSON.stringify({ category: project.category, name: naming?.selectedName || project.name, profile: naming?.profile,
    evidence: naming?.structureSelection?.options.filter(option => naming.structureSelection!.selectedIds.includes(option.id)),
    selectedProblem: naming?.problemSelection });
}
export function selectionFromProject(project: Project): ProductSelection {
  const profile = project.naming?.profile;
  const selection = project.naming?.structureSelection;
  const selectedProblem = project.naming?.problemSelection;
  const features = profile?.features.split('、').map(text => text.trim()).filter(Boolean) || [];
  return { company: profile?.company.trim() || project.owner, business: profile?.business.trim() || project.name,
    product: profile?.product.trim() || project.baseProductName || project.name, proposedName: project.naming?.selectedName || project.name,
    patentType: project.category === 'invention' ? 'invention' : 'utility', improvementType: profile?.improvementType || '', visualPreferences: '',
    ...(selectedProblem ? { selectedProblem: structuredClone(selectedProblem) } : {}),
    choices: [ ...(selectedProblem ? [
      { id: 'selected-problem', category: '技术问题', text: selectedProblem.problem.problem },
      ...(selectedProblem.context ? [{ id: 'user-context', category: '用户已有描述', text: selectedProblem.context }] : []),
    ] : features.map((text, index) => ({ id: `feature-${index + 1}`, category: '结构特征', text }))),
      ...(selection?.options.filter(option => selection.selectedIds.includes(option.id)).map((option, index) => ({ id: `evidence-${index + 1}`, category: option.category, text: `${option.label}：${option.detail}；${option.technicalMeaning}` })) || []),
    ], };
}
export function createProductWorkflow(project: Project): ProductWorkflow {
  return { version: 2, sourceFingerprint: namingFingerprint(project), selection: selectionFromProject(project), figures: {}, tokenUsage: [], redrawCount: 0, updatedAt: new Date().toISOString() };
}
export function isProductWorkflow(value: unknown): value is ProductWorkflow {
  if (!object(value) || value.version !== 2 || !productText(value.sourceFingerprint, 200000) || !isProductSelection(value.selection) || !timestamp(value.updatedAt) ||
    !Number.isSafeInteger(value.redrawCount) || (value.redrawCount as number) < 0 || !object(value.figures) || Object.keys(value.figures).length > 12) return false;
  return (value.generation === undefined || isProductGenerationStatus(value.generation)) &&
    (value.tokenUsage === undefined || (Array.isArray(value.tokenUsage) && value.tokenUsage.every(isTokenUsage))) &&
    (value.tokenUsageIncomplete === undefined || typeof value.tokenUsageIncomplete === 'boolean') &&
    (value.review === undefined || isProductReview(value.review)) && (value.brief === undefined || isProductBrief(value.brief)) &&
    (value.previews === undefined || isProductPreview(value.previews)) && (value.cad === undefined || isProductCad(value.cad)) &&
    (value.preview === undefined || isProductImage(value.preview)) &&
    (value.confirmation === undefined || isPreviewConfirmation(value.confirmation)) &&
    (value.materials === undefined || isProductMaterials(value.materials)) && Object.values(value.figures).every(isProductImage) &&
    (value.textStructure === undefined || isTextStructure(value.textStructure)) && (value.textDraft === undefined || isTextDraft(value.textDraft)) &&
    (value.revision === undefined || isRevisionDialogue(value.revision)) &&
    (value.previous === undefined || (object(value.previous) && value.previous.previous === undefined && isProductWorkflow(value.previous)));
}
export function isProductGenerationStatus(value: unknown): value is ProductGenerationStatus {
  return object(value) && ['running', 'completed', 'failed', 'cancelled'].includes(String(value.state)) &&
    productText(value.label, 4000) && productText(value.detail, 10000, true) && timestamp(value.startedAt) && timestamp(value.updatedAt) &&
    (value.error === undefined || productText(value.error, 10000)) && Array.isArray(value.steps) && value.steps.length <= 6 &&
    value.steps.every(step => object(step) && productText(step.label, 4000) && productText(step.detail, 10000, true));
}
export function hasCurrentPreview(workflow: ProductWorkflow): boolean {
  return !!workflow.brief && !!workflow.review && workflow.review.verdict === 'feasible' && workflow.brief.reviewId === workflow.review.id &&
    JSON.stringify(workflow.selection) === JSON.stringify(workflow.review.selection) && JSON.stringify(workflow.selection) === JSON.stringify(workflow.brief.selection) &&
    hasCompletePreviewViews(workflow.previews, workflow.brief.id);
}
export function hasCurrentConfirmation(workflow: ProductWorkflow): boolean {
  return hasCurrentPreview(workflow) && workflow.confirmation?.briefId === workflow.brief!.id &&
    workflow.confirmation.previewId === workflow.previews!.id && workflow.confirmation.previewDigest === workflow.previews!.digest;
}
/** 由 FreeCAD 统一模型投影出的附图与当前简介同版本。 */
export function hasCurrentCad(workflow: ProductWorkflow): boolean {
  return !!workflow.brief && workflow.cad?.briefId === workflow.brief.id && workflow.cad.views.length >= 1 &&
    (workflow.cad.drawingVersion !== 1 || drawingCoverageErrors(workflow.cad, workflow.brief).length === 0);
}
export function hasCurrentImageFigures(workflow: ProductWorkflow, templateIds: string[]): boolean {
  return !!workflow.brief && templateIds.every(id => workflow.figures[id]?.briefId === workflow.brief!.id &&
    workflow.figures[id].kind === 'patent' && workflow.figures[id].templateId === id);
}
export function isProductWorkflowComplete(workflow: ProductWorkflow, templateIds: string[] = PATENT_FIGURE_TEMPLATES.map(template => template.id)): boolean {
  return hasCurrentConfirmation(workflow) && workflow.materials?.briefId === workflow.brief!.id && workflow.materials.title === workflow.brief!.design.title &&
    hasCurrentText(workflow) &&
    (workflow.cad?.drawingVersion === 1
      ? workflow.cad.visualReview?.status === 'passed' && workflow.materials.drawingDigest === drawingManifestDigest(workflow.cad)
      : !workflow.materials.drawingDigest) &&
    (hasCurrentCad(workflow) || hasCurrentImageFigures(workflow, templateIds));
}
export function hasCurrentText(workflow: ProductWorkflow): boolean {
  const source = workflow.brief?.technicalSource, materials = workflow.materials;
  if (!materials || materials.briefId !== workflow.brief?.id) return false;
  if (!source) return true; // Historical tasks retain their original reading/export behavior.
  return materials.textRecord?.sourceVersion === source.version && !checkTextDocument(materials.textRecord.document, source.plan).length;
}
export function productDocumentText(workflow: ProductWorkflow): string {
  if (!isProductWorkflowComplete(workflow)) throw new Error('请先确认当前彩色预览，并完成申请文案和黑白附图。');
  const content = workflow.materials!;
  return `${content.title}\n专利申请材料初稿\n\n说明书摘要\n${content.abstract}\n\n权利要求书\n${content.claims.join('\n\n')}\n\n技术领域\n${content.technicalField}\n\n背景技术\n${content.background}\n\n内容\n${content.content}\n\n附图说明\n${content.drawings}\n\n具体实施方式\n${content.embodiment}`;
}
