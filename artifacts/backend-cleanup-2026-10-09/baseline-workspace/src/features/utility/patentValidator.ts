import type { PatentGenerationContext } from './claimPlan';
import type { FinalPatentDocument } from './finalDocumentSanitizer';
import type { ContentDesign } from './contentDrawing';
import type { PatentClaimReference } from './patentConsistency';
import { claimComponentIds, validatePatentConsistency } from './patentConsistency';
import { validateEvidenceReferences } from './patentEvidence';
import { buildReasoningPackage } from './patentReasoning';
import { getModelVersion } from './patentStructure';

export type ValidationIssue = {
  code: string;
  severity: 'error' | 'warning';
  field: string;
  message: string;
  evidenceRefs?: string[];
};
export type ValidationReport = {
  version: 1;
  modelVersion: string;
  issues: ValidationIssue[];
  readyForExport: boolean;
};

const normalize = (text: string) => text.normalize('NFKC').replace(/\s/gu, '');
const normalizeEffect = (text: string) => normalize(text)
  .replace(/^(?:本实用新型|本发明)?(?:能够|可以|可|从而|进而|因此|以便|达到|实现)+/u, '')
  .replace(/^(?:降低|减小|减轻)/u, '减少')
  .replace(/^(?:提升|增强)/u, '提高')
  .replace(/(?:的)?程度$/u, '');
const sentences = (text: string) => text.split(/[。；;\n]/u).map(normalize).filter(Boolean);
// Part/figure/claim numbering is deliberately not a measurement. Include Chinese
// quantities and ranges so changing digit notation cannot bypass this check.
const number = /(?:\d+(?:\.\d+)?|[零一二三四五六七八九十百千万两]+)(?:\s*[-~～至到]\s*(?:\d+(?:\.\d+)?|[零一二三四五六七八九十百千万两]+))?\s*(?:%|％|℃|°|mm\b|cm\b|m\b|kg\b|g\b|N\b|MPa\b|Pa\b|Hz\b|W\b|V\b|rpm\b|毫米|厘米|微米|千米|千克|公斤|克|米|牛顿|兆帕|摄氏度|度|倍|小时|分钟|秒|个|件|组)/giu;
// “有益效果为” is the standard conclusion prefix, not a technical effect.
// Keep the actual effect terms gated by the reasoning package below.
const effect = /(?:提高|提升|降低|减少|增强|改善|避免|防止|保证|确保|节省|节约|优于|有效地|显著|大幅)/u;
const structuralNoun = /(?:设有|增设|安装有|装有|还包括|还包含|设置|通过(?!设置))\s*(?:所述)?([\p{Script=Han}A-Za-z]{2,18}?(?:槽|孔|杆|板|盖|罩|轴|环|套|座|弹簧|连接器|显示屏|传感器|电机|控制器|模块|单元))(?=[，。；、（(与及和的\s]|$)/gu;

/** Deterministic hard gate over the exact, already sanitized export text. */
export function validatePatentDocument(input: {
  context: PatentGenerationContext;
  document: FinalPatentDocument;
  claimReferences?: PatentClaimReference[];
  design?: ContentDesign;
  sourceModelVersion?: string;
}): ValidationReport {
  const { context, document, design } = input;
  const { model, evidence, reasoning, claimPlan } = context;
  const issues: ValidationIssue[] = [];
  const error = (code: string, field: string, message: string) => issues.push({ code, field, message, severity: 'error' });
  for (const message of validateEvidenceReferences(model, evidence)) error('EVIDENCE_REFERENCE_INVALID', 'evidence', message);
  // Rebuild the actual trace, so forged or stale chain metadata cannot authorize an effect.
  try {
    if (JSON.stringify(reasoning) !== JSON.stringify(buildReasoningPackage(model, evidence))) {
      error('REASONING_TRACE_INVALID', 'reasoning', '推理链与来源、结构机制不一致');
    }
  } catch {
    error('REASONING_TRACE_INVALID', 'reasoning', '无法从证据与结构重建推理链');
  }
  const version = getModelVersion(model);
  if (reasoning.modelVersion !== version || claimPlan.modelVersion !== version) error('CONTEXT_VERSION_MISMATCH', 'context', '推理、权利要求规划与结构模型版本不一致');
  for (const item of evidence.items) if (item.status === 'CONFLICT') error('EVIDENCE_CONFLICT', 'evidence', `${item.id} 存在未解决的事实冲突`);
  const reliable = evidence.items.filter(item => item.status === 'SUPPORTED' || item.status === 'USER_CONFIRMED');
  const supportedEffect = (sentence: string) => reasoning.effects?.some(value => {
    if (value.status !== 'SUPPORTED' || !value.reasoningChainIds?.length ||
        !value.reasoningChainIds.every(id => reasoning.chains.some(chain => chain.id === id && chain.effectIds.includes(value.effectId) &&
          chain.structuralMechanism && chain.workingSteps.length > 0 && chain.causeEvidenceRefs.length > 0)) || normalizeEffect(value.statement) !== normalizeEffect(sentence) ||
        !value.componentIds.length || !(value.relationIds.length || value.motionIds.length)) return false;
    return value.evidenceRefs.some(id => {
      const item = evidence.items.find(candidate => candidate.id === id);
      return item?.status === 'SUPPORTED' && !!item.originalText && item.fact === value.statement &&
        value.componentIds.every(ref => item.relatedComponentIds.includes(ref) && model.components.some(part => part.id === ref)) &&
        value.relationIds.every(ref => item.relatedConnectionIds.includes(ref) && model.connections.some(link => link.id === ref)) &&
        value.motionIds.every(ref => item.relatedMotionIds.includes(ref) && model.motions.some(motion => motion.id === ref));
    });
  });
  for (const value of [...model.components, ...model.connections, ...model.motions]) {
    if (!value.evidenceRefs?.some(id => reliable.some(item => item.id === id))) error('STRUCTURE_UNSUPPORTED', 'model', `${value.id} 缺少可追溯的结构依据，请重新确认结构`);
  }
  for (const chain of reasoning.chains) if (chain.status !== 'SUPPORTED') error(chain.status, 'reasoning', `${chain.featureId} 未形成有依据的结构机制`);
  const fields = [
    ['title', document.title], ['abstract', document.abstract],
    ...document.claims.map((text, index) => [`claims.${index + 1}`, text]),
    ...document.sections.map(section => [section.title, section.paragraphs.join('\n')]),
  ];
  for (const [field, text] of fields) {
    for (const sentence of sentences(text)) {
      // Evidence must support this assertion, not merely contain the same digit
      // in an unrelated sentence or describe a schematic geometry coordinate.
      if (Array.from(sentence.matchAll(number)).length && !reliable.some(item =>
        sentences(item.originalText || item.fact).includes(sentence) || normalize(item.extractedFact) === sentence)) {
        error('NUMERIC_EVIDENCE_MISSING', field, `数值陈述缺少原文依据：${sentence}`);
      }
      if (effect.test(sentence) && !/^(?:技术问题：|.*旨在|.*目的在于)/u.test(sentence) &&
          !supportedEffect(sentence)) {
        error('EFFECT_REASONING_MISSING', field, `技术效果缺少对应机制与来源：${sentence}`);
      }
    }
    for (const match of text.matchAll(structuralNoun)) {
      if (!model.components.some(part => part.name === match[1])) error('UNMODELED_FEATURE', field, `新增结构“${match[1]}”不在结构模型中`);
    }
  }
  const refs = input.claimReferences || [];
  if (refs.length !== document.claims.length || new Set(refs.map(ref => ref.claimNo)).size !== refs.length) error('CLAIM_MAPPING_INVALID', 'claims', '权利要求正文与引用记录不是一一对应');
  document.claims.forEach((text, index) => {
    const ref = refs.find(value => value.claimNo === index + 1);
    if (!ref) return;
    const mentioned = claimComponentIds(text, model);
    if (mentioned.some(id => !ref.componentIds.includes(id)) || ref.componentIds.some(id => !mentioned.includes(id))) {
      error('CLAIM_SUPPORT_MISSING', `claims.${index + 1}`, '权利要求中的部件与该条结构映射不一致');
    }
  });
  const text = fields.map(([, text]) => text).join('\n');
  issues.push(...validatePatentConsistency({
    model, claimReferences: refs, claimsText: document.claims.join('\n'), text,
    figureComponentIds: model.figureSpecs.map(figure => figure.componentIds), design,
    documentSourceModelVersion: input.sourceModelVersion,
    drawingSourceModelVersion: design?.sourceModelVersion,
  }).map(issue => ({ ...issue, field: 'consistency' })));
  return { version: 1, modelVersion: version, issues, readyForExport: !issues.some(issue => issue.severity === 'error') };
}
