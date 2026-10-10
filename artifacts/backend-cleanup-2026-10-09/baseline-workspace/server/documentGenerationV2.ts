/** Evidence-grounded draft followed by deterministic validation. */

import type { PatentGenerationContext } from '../src/features/utility/claimPlan.ts';
import type { AiConfig } from './aiSupport.ts';
import { reviewDraft } from './documentReviewer.ts';
import { fixIssues } from './documentFixer.ts';
import type { FinalPatentDocument } from '../src/features/utility/finalDocumentSanitizer.ts';
import { polishDocument } from './documentPolisher.ts';
import { generationSnapshot, generationDocumentSnapshot, type GenerationProof } from '../src/features/utility/patentPackage.ts';

// ============================================================================
// 类型定义
// ============================================================================

/** 文档草稿（允许有瑕疵） */
export type DocumentDraft = {
  version: 2;
  stage: 'draft';
  generatedAt: string;

  abstract: string;
  claims: DraftClaim[];
  technicalField: string;
  background: string;
  content: ContentSection;
  drawings: string;
  embodiment: string;

  /** AI生成时的元信息 */
  metadata: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    elapsedMs: number;
  };
};

export type DraftClaim = {
  claimNo: number;
  parentClaimNo?: number;
  text: string;
  componentIds: string[];
  connectionIds: string[];
  motionIds?: string[];
};

export type ContentSection = {
  problemStatement: string;
  technicalSolution: string;
  innovationPoints: string[];
  benefits: string;
};

/** 审核问题 */
export type ReviewIssue = {
  id: string;
  severity: 'error' | 'warning' | 'suggestion';
  category: 'logic' | 'consistency' | 'clarity' | 'redundancy' | 'legal';
  field: string;
  message: string;
  suggestion?: string;
  autoFixable: boolean;
};

/** 审核报告 */
export type ReviewReport = {
  version: 2;
  stage: 'reviewed';
  reviewedAt: string;

  issues: ReviewIssue[];
  overallScore: number; // 0-100
  readabilityScore: number;
  consistencyScore: number;
  innovationScore: number;

  metadata: {
    model: string;
    elapsedMs: number;
  };
};

/** 修复后的文档 */
export type FixedDocument = {
  version: 2;
  stage: 'fixed';
  fixedAt: string;

  draft: DocumentDraft;
  fixedIssues: ReviewIssue[];
  remainingIssues: ReviewIssue[];

  metadata: {
    model: string;
    elapsedMs: number;
  };
};

/** 改写后的文档 */
export type PolishedDocument = {
  version: 2;
  stage: 'polished';
  polishedAt: string;

  abstract: string;
  claims: string[];
  technicalField: string;
  background: string;
  content: string;
  drawings: string;
  embodiment: string;

  claimReferences: Array<{
    claimNo: number;
    parentClaimNo?: number;
    componentIds: string[];
    connectionIds: string[];
    motionIds?: string[];
  }>;

  improvements: {
    field: string;
    before: string;
    after: string;
    reason: string;
  }[];

  metadata: {
    model: string;
    elapsedMs: number;
  };
};

/** 最终验证结果 */
export type ValidatedDocument = {
  version: 2;
  stage: 'validated';
  validatedAt: string;

  document: PolishedDocument;
  validationIssues: ReviewIssue[];

  readyForExport: boolean;
  qualityScore: number;
  generationProof?: GenerationProof;
};

// ============================================================================
// 主流程
// ============================================================================

export type GenerationProgress = {
  stage: 'draft' | 'review' | 'fix' | 'polish' | 'validate' | 'complete';
  progress: number; // 0-100
  message: string;
};

export type GenerationOptions = {
  onProgress?: (progress: GenerationProgress) => void;
  enableAutoFix?: boolean;
  maxRetries?: number;
  qualityThreshold?: number; // 最低质量分数，默认75
};

/**
 * 生成专利文档（完整流程）
 */
export async function generatePatentDocument(
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal,
  options: GenerationOptions = {}
): Promise<ValidatedDocument> {
  const { onProgress = () => {} } = options;
  const enableAutoFix = options.enableAutoFix ?? true;
  const retryLimit = config.executionPolicy ? 1 : 2;
  const maxRetries = Number.isFinite(options.maxRetries) ? Math.min(retryLimit, Math.max(0, Math.floor(options.maxRetries!))) : retryLimit;

  // 第1步：生成草稿
  onProgress({ stage: 'draft', progress: 10, message: '正在生成文档草稿...' });
  const draft = await generateDraft(context, config, signal, onProgress);

  // Review is deliberately run twice: the second pass is the gate after any
  // requested fix, even when the first pass found no fixable issue.
  onProgress({ stage: 'review', progress: 32, message: '正在审核文档草稿...' });
  let reviewedDraft = draft;
  let review = await reviewDraft(reviewedDraft, context.model, config, signal);
  let reviewPass = 1;
  let fixAttempts = 0;
  const reviews: GenerationProof['reviews'] = [];

  while (true) {
    const errors = review.issues.filter(issue => issue.severity === 'error');
    if (errors.length === 0) {
      reviews.push({ issues: review.issues, fixedIssueIds: [] });
      if (reviewPass === 1) {
        onProgress({ stage: 'review', progress: 58, message: '正在进行第二次审核...' });
        review = await reviewDraft(reviewedDraft, context.model, config, signal);
        reviewPass = 2;
        continue;
      }
      break;
    }

    const canFix = enableAutoFix && fixAttempts < maxRetries && errors.every(issue => issue.autoFixable);
    if (!canFix) {
      throw new Error(`文档审核未通过：${errors.map(issue => issue.message).join('；')}`);
    }

    fixAttempts += 1;
    onProgress({ stage: 'fix', progress: 42 + Math.min(12, fixAttempts * 4), message: `正在修复审核问题（第${fixAttempts}轮）...` });
    const fixed = await fixIssues(reviewedDraft, review, context, config, signal);
    reviews.push({ issues: review.issues, fixedIssueIds: fixed.fixedIssues.map(issue => issue.id) });
    reviewedDraft = fixed.draft;

    onProgress({ stage: 'review', progress: 56, message: '正在验证修复结果...' });
    review = await reviewDraft(reviewedDraft, context.model, config, signal);
    reviewPass += 1;
  }

  onProgress({ stage: 'polish', progress: 68, message: '正在优化文档表达...' });
  const polished = await polishDocument(reviewedDraft, context, config, signal, onProgress);

  assertTechnicalFingerprintUnchanged(reviewedDraft, polished, context);

  onProgress({ stage: 'validate', progress: 90, message: '正在进行最终验证...' });
  const validated = await validateFinalDocument(polished, context, config, signal);
  if (!validated.readyForExport || validated.validationIssues.some(issue => issue.severity === 'error')) {
    throw new Error(`最终验证未通过：${validated.validationIssues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('；') || '存在未解决的验证问题'}`);
  }
  const qualityThreshold = Math.max(75, options.qualityThreshold ?? 75);
  if (validated.qualityScore < qualityThreshold) {
    throw new Error(`最终验证质量分数 ${validated.qualityScore} 低于门槛 ${qualityThreshold}`);
  }

  onProgress({ stage: 'complete', progress: 100, message: '文档生成完成' });

  return { ...validated, generationProof: {
    version: 1, contextSnapshot: generationSnapshot(context), documentSnapshot: generationDocumentSnapshot(polished), reviews,
    polish: { before: generationSnapshot(technicalFingerprint(reviewedDraft, context)), after: generationSnapshot(technicalFingerprint(polished, context)) },
    validation: { readyForExport: validated.readyForExport, issues: validated.validationIssues, qualityScore: validated.qualityScore, qualityThreshold },
  } };
}

// ============================================================================
// 导入实际实现
// ============================================================================

import {
  generateAbstractDraft,
  generateClaimsDraft,
  generateTechnicalFieldDraft,
  generateBackgroundDraft,
  generateContentDraft,
  generateDrawingsDraft,
  generateEmbodimentDraft,
} from './draftGenerators.ts';

import { validateFinalDocument as validateFinalDocumentImpl } from './documentValidator.ts';

// ============================================================================
// 阶段1：草稿生成
// ============================================================================

async function generateDraft(
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal,
  onProgress: (progress: GenerationProgress) => void
): Promise<DocumentDraft> {
  const startTime = Date.now();

  onProgress({ stage: 'draft', progress: 12, message: '生成技术领域...' });
  const technicalField = await generateTechnicalFieldDraft(context, config, signal);

  onProgress({ stage: 'draft', progress: 14, message: '生成背景技术...' });
  const background = await generateBackgroundDraft(context, config, signal);

  onProgress({ stage: 'draft', progress: 17, message: '生成技术内容...' });
  const content = await generateContentDraft(context, config, signal, { technicalField, background });

  onProgress({ stage: 'draft', progress: 20, message: '生成权利要求...' });
  const claims = await generateClaimsDraft(context, config, signal, content);

  onProgress({ stage: 'draft', progress: 22, message: '生成附图说明...' });
  const drawings = await generateDrawingsDraft(context, config, signal);

  onProgress({ stage: 'draft', progress: 24, message: '生成具体实施方式...' });
  const embodiment = await generateEmbodimentDraft(context, config, signal, { content, claims, drawings });

  onProgress({ stage: 'draft', progress: 26, message: '根据完整草稿生成摘要...' });
  const abstract = await generateAbstractDraft(context, config, signal, { content, claims, embodiment });

  return {
    version: 2,
    stage: 'draft',
    generatedAt: new Date().toISOString(),
    abstract,
    claims,
    technicalField,
    background,
    content,
    drawings,
    embodiment,
    metadata: {
      model: config.model,
      promptTokens: 0, // TODO: 实际统计
      completionTokens: 0,
      elapsedMs: Date.now() - startTime,
    },
  };
}

async function validateFinalDocument(
  polished: PolishedDocument,
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal
): Promise<ValidatedDocument> {
  return validateFinalDocumentImpl(polished, context, config, signal);
}

export type TechnicalFingerprint = {
  observedIds: string[];
  problemStatements: string[];
  solutionFeatures: string[];
  reasoningChainIds: string[];
  technicalPropositions: string[];
  componentIds: string[];
  componentNames: string[];
  connectionIds: string[];
  motionIds: string[];
  claimNumbers: number[];
  claimDependencies: Array<{ claimNo: number; parentClaimNo?: number }>;
  numericFacts: string[];
  technicalEffects: string[];
  evidenceRefs: string[];
  connectionFacts: string[];
  motionFacts: string[];
};

function documentTexts(document: DocumentDraft | PolishedDocument): string[] {
  if ('stage' in document && document.stage === 'draft') {
    return [
      document.abstract,
      document.technicalField,
      document.background,
      document.content.problemStatement,
      document.content.technicalSolution,
      ...document.content.innovationPoints,
      document.content.benefits,
      document.drawings,
      document.embodiment,
      ...document.claims.map(claim => claim.text),
    ];
  }
  return [
    document.abstract,
    document.technicalField,
    document.background,
    document.content,
    document.drawings,
    document.embodiment,
    ...document.claims.map(claim => claim.replace(/^\d+\.\s*/u, '')),
  ];
}

function numericFacts(document: DocumentDraft | PolishedDocument): string[] {
  // Preserve measurements (including Chinese notation), and unlabelled digits;
  // claim prefixes are already removed by documentTexts. Order is linguistic.
  return documentTexts(document).flatMap(text =>
    text.match(/(?:\d+(?:\.\d+)?|[零一二三四五六七八九十百千万两]+)\s*(?:%|％|℃|°|mm\b|cm\b|m\b|kg\b|g\b|N\b|MPa\b|Pa\b|Hz\b|W\b|V\b|rpm\b|毫米|厘米|千克|公斤|克|米|牛顿|兆帕|度|倍|小时|分钟|秒|个|件|组)|\d+(?:\.\d+)?/giu) || []
  ).map(value => value.replace(/\s/gu, '')).sort();
}

/** Only explicitly controlled terminology variants are equivalent; unknown paraphrases fail closed. */
function canonicalTechnicalText(text: string, context: PatentGenerationContext): string {
  let result = text.normalize('NFKC');
  for (const component of [...context.model.components].sort((a, b) => b.name.length - a.name.length)) {
    const canonical = component.name.normalize('NFKC');
    const variants = new Set([canonical, canonical.replace(/可调式/gu, '可调'), canonical.replace(/可调(?!式)/gu, '可调式')]);
    for (const variant of [...variants].sort((a, b) => b.length - a.length)) result = result.split(variant).join(canonical);
  }
  return result.replace(/所述/gu, '').replace(/涉及的是/gu, '涉及').replace(/\s/gu, '');
}

function observedPropositions(document: DocumentDraft | PolishedDocument, context: PatentGenerationContext): string[] {
  // Preserve section and claim attribution, but allow paragraph/sentence reordering and duplicate removal.
  const content = document.stage === 'draft'
    ? [document.content.problemStatement, document.content.technicalSolution, ...document.content.innovationPoints, document.content.benefits].join('\n')
    : document.content;
  const sections = [document.abstract, document.technicalField, document.background, content, document.drawings, document.embodiment,
    ...document.claims.map(claim => typeof claim === 'string' ? claim.replace(/^\d+\.\s*/u, '') : claim.text)];
  return [...new Set(sections.flatMap((text, index) => text.split(/[。；;\n]/u)
    .map(sentence => canonicalTechnicalText(sentence, context)).filter(Boolean).map(sentence => `${index}:${sentence}`)))].sort();
}

function technicalFingerprint(document: DocumentDraft | PolishedDocument, context: PatentGenerationContext): TechnicalFingerprint {
  const texts = documentTexts(document).map(text => canonicalTechnicalText(text, context));
  const fullText = texts.join('\n');
  const claims = document.stage === 'draft' ? document.claims : document.claimReferences;
  const unique = (values: string[]) => [...new Set(values)].sort();
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const names = context.model.components.map(part => escape(part.name)).sort((a, b) => b.length - a.length).join('|');
  const connections = new RegExp(`(?:${names})[（(]?(?:C?\\d+)?[）)]?\\s*(?:与|由|和|通过)\\s*(?:所述)?(?:${names})[（(]?(?:C?\\d+)?[）)]?\\s*(?:固定连接|滑动连接|转动连接|连接|驱动|支撑|限位)`, 'gu');
  const motions = new RegExp(`(?:${names})[^。；\\n]{0,20}?(?:旋转|转动|滑动|移动|往复|rotary|linear|static)`, 'gu');
  const propositions = observedPropositions(document, context);
  return {
    // Text observations are separate from metadata; unchanged claim references cannot mask C01 → C02.
    observedIds: unique(fullText.match(/\b(?:C\d{2,3}|R\d{2,3}|M\d{2,3}|EVID-\d{3}|RSF-\d{3}|CHAIN-C\d{2,3}|PAR-\d{3,4})\b/gu) || []),
    problemStatements: propositions.filter(value => /问题|不足|缺少|无法|难以|需求/u.test(value)),
    solutionFeatures: propositions.filter(value => context.model.components.some(part => value.includes(part.name) || value.includes(part.id))),
    reasoningChainIds: unique(fullText.match(/\bCHAIN-C\d{2,3}\b/gu) || []),
    technicalPropositions: propositions,
    componentIds: unique([...(fullText.match(/\bC\d{2,3}\b/gu) || []), ...claims.flatMap(claim => claim.componentIds)]),
    componentNames: unique(context.model.components.filter(part => fullText.includes(part.name)).map(part => part.name)),
    connectionIds: unique([...(fullText.match(/\bR\d{2,3}\b/gu) || []), ...claims.flatMap(claim => claim.connectionIds)]),
    motionIds: unique([...(fullText.match(/\bM\d{2,3}\b/gu) || []), ...claims.flatMap(claim => claim.motionIds || [])]),
    claimNumbers: claims.map(claim => claim.claimNo),
    claimDependencies: claims.map(claim => ({ claimNo: claim.claimNo, parentClaimNo: claim.parentClaimNo })),
    numericFacts: numericFacts(document),
    technicalEffects: unique(texts.flatMap(text => text.split(/[。；;\n]/u)).filter(sentence => /提高|提升|降低|减少|增强|改善|避免|防止|保证|确保|节省|节约/u.test(sentence)).map(sentence => sentence.replace(/\s/gu, ''))),
    evidenceRefs: unique(fullText.match(/\b(?:EVID|RSF)-\d{3}\b/gu) || []),
    connectionFacts: unique(fullText.match(connections) || []),
    motionFacts: unique(fullText.match(motions) || []),
  };
}

/** Compare observed document facts, not the unchanged context object. */
export function assertTechnicalFingerprintUnchanged(before: DocumentDraft, after: PolishedDocument, context: PatentGenerationContext): void {
  const expected = technicalFingerprint(before, context);
  const actual = technicalFingerprint(after, context);
  const changed = (Object.keys(expected) as Array<keyof TechnicalFingerprint>)
    .filter(key => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]));
  if (changed.length) throw new Error(`Polish = FAILED：润色前后技术指纹发生变化（${changed.join('、')}），未采用润色结果。`);
}

/** A view for existing validators, never a mutation of the generation facts. */
export function documentForValidation(document: DocumentDraft | PolishedDocument, context: PatentGenerationContext): FinalPatentDocument {
  const draft = document.stage === 'draft';
  const content = draft ? [document.content.problemStatement, document.content.technicalSolution, ...document.content.innovationPoints, document.content.benefits].join('\n') : document.content;
  return {
    title: context.model.productTitle,
    abstract: document.abstract,
    claims: draft ? document.claims.map(claim => claim.text) : document.claims,
    sections: [
      { title: '技术领域', paragraphs: [document.technicalField] },
      { title: '背景技术', paragraphs: [document.background] },
      { title: '实用新型内容', paragraphs: [content] },
      { title: '附图说明', paragraphs: [document.drawings] },
      { title: '具体实施方式', paragraphs: [document.embodiment] },
    ],
    figures: context.model.figureSpecs.map((figure, index) => ({
      kind: figure.kind, figureIndex: index + 1, figureLabel: `图${index + 1}`,
      id: figure.id, sourceId: figure.id, name: figure.title,
    })),
  };
}
