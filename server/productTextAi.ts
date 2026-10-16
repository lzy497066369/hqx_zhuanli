import { randomUUID } from 'node:crypto';
import { AiFailure } from './aiSupport.ts';
import type { AiConfig } from './aiSupport.ts';
import type { ProgressReporter } from './patentStructureAi.ts';
import { productJson } from './productJson.ts';
import { signProductArtifact, verifyProductArtifact } from './productProof.ts';
import { PROBLEMS, PLAN, PLAN_REVIEW, DRAFT, TEXT_REVIEW } from './productTextPrompts.ts';
import { isProblemProposal } from '../src/features/product/productProblems.ts';
import type { ProblemProposal } from '../src/features/product/productProblems.ts';
import {
  TEXT_RULES_VERSION, applyTechnicalReview, applyDocumentReview, checkTechnicalPlan, checkTextDocument,
  documentForWriting, documentContent, technicalPlanForWriting, isTextStructure, isTextDraft,
  textSourceVersion,
  frozenSourceVersion,
} from '../src/features/product/productText.ts';
import type { TechnicalPlan, StructureReview, TextDocument, TextReview, TextStructure, TextDraft, TextRecord } from '../src/features/product/productText.ts';
import { renderProductDescription, isProductDesign } from '../src/features/product/productWorkflow.ts';
import type { ProductBrief, ProductDesign, ProductReview } from '../src/features/product/productWorkflow.ts';

export { textSourceVersion } from '../src/features/product/productText.ts';
const now = () => new Date().toISOString();
const failure = (error: unknown) => [error instanceof Error ? error.message : '复核补丁无效。'];
const selectionInput = (review: ProductReview) => {
  const { product, proposedName, patentType, improvementType, choices, visualPreferences, selectedProblem } = review.selection;
  return { selection: { product, proposedName, patentType, improvementType, choices, visualPreferences, ...(selectedProblem ? { selectedProblem } : {}) }, patentType };
};

export function designFromTechnicalPlan(plan: TechnicalPlan): ProductDesign {
  const physical = plan.parts.filter(p => ['part', 'assembly'].includes(p.kind));
  const owner = (id: string): string => {
    const p = plan.parts.find(p => p.id === id)!;
    return ['part', 'assembly'].includes(p.kind) || !p.parentId ? p.id : owner(p.parentId);
  };
  return {
    title: plan.title, technicalField: plan.technicalField, useCase: plan.scenario, appearance: plan.appearance,
    overview: [plan.overview, ...plan.claimPlan.embodimentOnly.map(f => f.feature)].join('\n'),
    // Keep the existing drawing contract: physical components only. Openings and
    // surfaces are described on their owner, never passed as separate CAD solids.
    components: physical.map(p => ({ number: p.id, name: p.name, purpose: p.role,
      structure: [p.position, p.form?.detail, ...plan.parts.filter(f => f.id !== p.id && owner(f.id) === p.id).map(f => `${f.name}：${f.position}；${f.motion}${f.form ? `；${f.form.detail}` : ''}`)].filter(Boolean).join('\n'),
      connection: [p.motion, ...plan.connections.filter(c => owner(c.from) === p.id || owner(c.to) === p.id).map(c => `${plan.parts.find(f => f.id === c.from)!.name}与${plan.parts.find(f => f.id === c.to)!.name}：${c.type}，${c.detail}`)].join('\n'),
    })),
    workingPrinciple: plan.coreActions.map(a => [a.trigger, a.before, a.constraint, ...a.sequence, a.after, a.clearance, a.basis].join('；')).join('\n\n'),
    innovation: plan.improvements.map(i => `${i.mechanism}，${i.effect}`).join('\n'),
    assumptions: [...plan.assumptions, ...plan.verificationNeeds], choiceCoverage: structuredClone(plan.choiceCoverage),
  };
}

// Old signed briefs remain usable. Their known structure is the frozen source;
// a text retry cannot invent a replacement product behind an existing preview.
export function writingSource(brief: ProductBrief) {
  if (brief.technicalSource) return technicalPlanForWriting(brief.technicalSource.plan);
  const d = brief.design;
  return { title: d.title, technicalField: d.technicalField, scenario: d.useCase, overview: d.overview,
    parts: d.components.map(p => ({ id: p.number, name: p.name, position: p.structure, motion: p.connection, role: p.purpose })),
    workingPrinciple: d.workingPrinciple, improvements: d.innovation,
    choiceCoverage: d.choiceCoverage.map(c => ({ choiceId: c.choiceId, description: c.description })),
  };
}
export function briefTextVersion(brief: ProductBrief): string {
  const version = brief.technicalSource ? frozenSourceVersion(brief.technicalSource) : textSourceVersion(writingSource(brief));
  if (brief.technicalSource && brief.technicalSource.version !== version) throw new AiFailure(409, 'PRODUCT_TEXT_STALE', '技术依据版本已变化，请重新生成受影响的文本。');
  return version;
}
const validationPlan = (brief: ProductBrief) => brief.technicalSource?.plan || {
  title: brief.design.title, parts: brief.design.components.map(p => ({ id: p.number, name: p.name })) as TechnicalPlan['parts'],
};

export function createProductTextService(config: AiConfig, fetcher: typeof fetch) {
  const structures = new Map<string, TextStructure>(), drafts = new Map<string, TextDraft>();
  const briefs = new Map<string, ProductBrief>();
  const pending = new Set<string>();
  async function problems(input: Record<string, unknown>, signal: AbortSignal, progress?: ProgressReporter): Promise<ProblemProposal> {
    const product = typeof input.product === 'string' ? input.product.trim() : '';
    const context = typeof input.context === 'string' ? input.context.trim() : '';
    if (!product || [...product].length > 100 || context.length > 3000 || (input.context !== undefined && typeof input.context !== 'string')) {
      throw new AiFailure(400, 'PRODUCT_PROBLEM_INPUT', '请输入100字以内的产品名称；补充描述最多3000字。');
    }
    progress?.('整理候选技术问题', '确定应用场景和可通过产品结构解决的具体困难');
    const result = await productJson<{ scenario: string; problems: ProblemProposal['problems'] }>(PROBLEMS,
      { product, context, patentType: input.patentType === 'invention' ? 'invention' : 'utility' }, config, signal, fetcher,
      (v): v is { scenario: string; problems: ProblemProposal['problems'] } => isProblemProposal({ ...(v as object), product, context }), progress, 2500);
    return { product, context, scenario: result.scenario, problems: result.problems.map(({ id, title, problem, goal, approach, suggestedName }) => ({ id, title, problem, goal, approach, suggestedName })) };
  }
  const remember = <T>(cache: Map<string, T>, key: string, value: T) => { cache.set(key, value); if (cache.size > 32) cache.delete(cache.keys().next().value!); return value; };
  async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (pending.has(key)) throw new AiFailure(409, 'PRODUCT_REQUEST_RUNNING', '同一版本的文本阶段正在生成，请等待完成。');
    pending.add(key); try { return await work(); } finally { pending.delete(key); }
  }
  function structureCheckpoint(review: ProductReview, checkpoint: unknown): TextStructure {
    if (!isTextStructure(checkpoint)) throw new AiFailure(400, 'PRODUCT_STRUCTURE_INVALID', '结构中间结果格式不正确。');
    verifyProductArtifact('text-structure', checkpoint, config);
    if (checkpoint.reviewId !== review.id || checkpoint.rulesVersion !== TEXT_RULES_VERSION || checkTechnicalPlan(checkpoint.plan, review.selection).length) throw new AiFailure(409, 'PRODUCT_TEXT_STALE', '结构中间结果不属于当前选择版本。');
    return checkpoint;
  }
  async function structure(review: ProductReview, signal: AbortSignal, progress?: ProgressReporter): Promise<TextStructure> {
    const key = review.signature;
    if (structures.has(key)) return structures.get(key)!;
    return exclusive(`structure:${key}`, async () => {
      progress?.('生成结构方案及保护层次', '确定核心问题、部件身份、动作依据和主从项分层');
      const plan = await productJson<TechnicalPlan>(PLAN, selectionInput(review), config, signal, fetcher,
        (v): v is TechnicalPlan => !checkTechnicalPlan(v, review.selection).length, progress, 9000, v => checkTechnicalPlan(v, review.selection));
      signal.throwIfAborted();
      return remember(structures, key, signProductArtifact('text-structure', { reviewId: review.id, rulesVersion: TEXT_RULES_VERSION, plan, createdAt: now() }, config));
    });
  }
  async function brief(review: ProductReview, checkpoint: unknown, signal: AbortSignal, progress?: ProgressReporter): Promise<ProductBrief> {
    const initial = checkpoint === undefined ? await structure(review, signal, progress) : structureCheckpoint(review, checkpoint);
    const key = textSourceVersion({ review: review.signature, initial: initial.signature });
    if (briefs.has(key)) return briefs.get(key)!;
    return exclusive(`brief:${key}`, async () => {
      const errors = (v: unknown) => { try {
        const plan = applyTechnicalReview(initial.plan, v);
        const errors = checkTechnicalPlan(plan, review.selection);
        if (!errors.length && !isProductDesign(designFromTechnicalPlan(plan), review.selection)) errors.push('结构说明超出既有简介接口字段上限，请精简重复表述并保留全部关键技术关系。');
        return errors;
      } catch (e) { return failure(e); } };
      progress?.('复核结构并冻结技术依据', '按稳定编号和原名称修正部件，同步核对连接、动作和保护关系');
      const reviewResult = await productJson<StructureReview>(PLAN_REVIEW, { ...selectionInput(review), plan: initial.plan }, config, signal, fetcher,
        (v): v is StructureReview => !errors(v).length, progress, 5000, errors);
      const plan = applyTechnicalReview(initial.plan, reviewResult);
      if (reviewResult.unresolved.length) throw new AiFailure(422, 'PRODUCT_STRUCTURE_UNRESOLVED', '结构复核仍有未解决的关键矛盾，已保留原结构中间结果，可重试复核。', reviewResult.unresolved);
      const design = designFromTechnicalPlan(plan);
      const source = { version: textSourceVersion(technicalPlanForWriting(plan)), rulesVersion: TEXT_RULES_VERSION, initialPlan: initial.plan, plan, review: reviewResult };
      signal.throwIfAborted();
      return remember(briefs, key, signProductArtifact('brief', { id: randomUUID(), reviewId: review.id, selection: review.selection, design,
        description: renderProductDescription(design), technicalSource: source, createdAt: now() }, config));
    });
  }
  function draftCheckpoint(brief: ProductBrief, checkpoint: unknown): TextDraft {
    if (!isTextDraft(checkpoint)) throw new AiFailure(400, 'PRODUCT_DRAFT_INVALID', '正文中间结果格式不正确。');
    verifyProductArtifact('text-draft', checkpoint, config);
    if (checkpoint.briefId !== brief.id || checkpoint.sourceVersion !== briefTextVersion(brief) || checkTextDocument(checkpoint.document, validationPlan(brief)).length) throw new AiFailure(409, 'PRODUCT_TEXT_STALE', '正文草稿依赖旧技术依据，不能作为当前结果复用。');
    return checkpoint;
  }
  async function draft(brief: ProductBrief, signal: AbortSignal, progress?: ProgressReporter): Promise<TextDraft> {
    const sourceVersion = briefTextVersion(brief), key = `${brief.signature}:${sourceVersion}`;
    if (drafts.has(key)) return drafts.get(key)!;
    return exclusive(`draft:${key}`, async () => {
      progress?.('生成权利要求、说明书和摘要', '仅使用冻结技术资料，分别组织结构说明与一次完整工作过程');
      const plan = validationPlan(brief);
      const doc = await productJson<TextDocument>(DRAFT, { patentType: brief.selection.patentType, plan: writingSource(brief) }, config, signal, fetcher,
        (v): v is TextDocument => !checkTextDocument(v, plan).length, progress, 11000, v => checkTextDocument(v, plan));
      signal.throwIfAborted();
      return remember(drafts, key, signProductArtifact('text-draft', { briefId: brief.id, sourceVersion, document: documentForWriting(doc), createdAt: now() }, config));
    });
  }
  async function materials(brief: ProductBrief, checkpoint: unknown, signal: AbortSignal, progress?: ProgressReporter, previous?: TextDocument) {
    const saved = checkpoint === undefined ? await draft(brief, signal, progress) : draftCheckpoint(brief, checkpoint);
    const plan = validationPlan(brief), original = documentForWriting(previous || saved.document);
    const priorErrors = checkTextDocument(original, plan);
    if (priorErrors.length) throw new AiFailure(400, 'PRODUCT_DRAFT_INVALID', '待复核正文与当前技术资料不一致。', priorErrors);
    const errors = (v: unknown) => { try { applyDocumentReview(original, v, plan); return []; } catch (e) { return failure(e); } };
    progress?.('复核并修正申请文本', '核对必要特征、从属引用、术语标号、自然句效果及操作重复');
    const review = await productJson<TextReview>(TEXT_REVIEW, { patentType: brief.selection.patentType, plan: writingSource(brief), document: original }, config, signal, fetcher,
      (v): v is TextReview => !errors(v).length, progress, 8000, errors);
    const document = applyDocumentReview(original, review, plan);
    const textRecord: TextRecord = { sourceVersion: saved.sourceVersion, draft: original, review, document, status: review.unresolved.length ? 'needs_review' : 'completed' };
    signal.throwIfAborted();
    return { ...documentContent(document), textRecord };
  }
  return { problems, structure, brief, draft, materials, validateDraft: draftCheckpoint, version: briefTextVersion };
}
