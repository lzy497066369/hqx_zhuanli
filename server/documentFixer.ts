/**
 * 文档修复器：自动修复可修复的问题
 *
 * 策略：
 * 1. 只修复标记为autoFixable的问题
 * 2. 按字段分批修复，避免修复冲突
 * 3. 修复后保留原始草稿，便于对比
 */

import type { DocumentDraft, ReviewReport, ReviewIssue, FixedDocument } from './documentGenerationV2.ts';
import type { PatentGenerationContext } from '../src/features/utility/claimPlan.ts';
import { documentForValidation } from './documentGenerationV2.ts';
import { validatePatentDocument } from '../src/features/utility/patentValidator.ts';
import type { AiConfig } from './aiSupport.ts';
import { chatJson } from './patentStructureAi.ts';
import { getAutoFixableIssues, groupIssuesByField } from './documentReviewer.ts';

// ============================================================================
// 主修复流程
// ============================================================================

export async function fixIssues(
  draft: DocumentDraft,
  review: ReviewReport,
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal
): Promise<FixedDocument> {
  const startTime = Date.now();
  const fixableIssues = getAutoFixableIssues(review.issues);

  if (fixableIssues.length === 0) {
    return {
      version: 2,
      stage: 'fixed',
      fixedAt: new Date().toISOString(),
      draft,
      fixedIssues: [],
      remainingIssues: review.issues,
      metadata: {
        model: config.model,
        elapsedMs: 0,
      },
    };
  }

  // 按字段分组修复
  const issuesByField = groupIssuesByField(fixableIssues);
  let fixedDraft = { ...draft };
  const actuallyFixed: ReviewIssue[] = [];

  const validateFacts = (value: DocumentDraft) => validatePatentDocument({ context, document: documentForValidation(value, context),
    claimReferences: value.claims, sourceModelVersion: context.model.modelVersion }).issues.filter(issue => issue.severity === 'error');
  const previousErrors = new Set(validateFacts(draft).map(issue => JSON.stringify(issue)));
  // Only the fields requested by Review are writable; any new fact violation
  // or provider failure stops the whole generation, rather than being hidden.
  for (const [field, issues] of Object.entries(issuesByField)) {
    const result = await fixField(fixedDraft, field, issues, context, config, signal);
    if (!result) throw new Error(`Fix 失败：${field} 返回格式或 ClaimPlan 映射无效`);
    const addedErrors = validateFacts(result).filter(issue => !previousErrors.has(JSON.stringify(issue)));
    if (addedErrors.length) throw new Error(`Fix 超出事实边界：${addedErrors.map(issue => issue.message).join('；')}`);
    fixedDraft = result;
    actuallyFixed.push(...issues);
  }

  const remainingIssues = review.issues.filter(
    issue => !actuallyFixed.some(fixed => fixed.id === issue.id)
  );

  return {
    version: 2,
    stage: 'fixed',
    fixedAt: new Date().toISOString(),
    draft: fixedDraft,
    fixedIssues: actuallyFixed,
    remainingIssues,
    metadata: {
      model: config.model,
      elapsedMs: Date.now() - startTime,
    },
  };
}

// ============================================================================
// 字段级修复
// ============================================================================

const fixPrompt = `你是专利文档修复助手。根据审核问题修复指定字段的内容。

修复原则：
1. 只修复列出的具体问题，不要改变其他正常内容
2. 保持原有的技术内容和逻辑
3. 修复后的内容应该更清晰、准确
4. 保持专利文档的专业性和规范性
5. 只能使用提供的 PatentGenerationContext 已有事实修复指定问题，禁止创造新的部件、连接、运动、数值、效果或证据；不得修改事实层
6. claims中除text外的字段必须与原稿完全一致；独立项没有parentClaimNo时必须省略该字段，不得填null

输出格式：纯JSON
对于简单字段（abstract, technicalField, background, drawings, embodiment）：
{
  "fixed": "修复后的完整内容"
}

对于复杂字段（claims）：
{
  "fixed": [
    { "claimNo": 1, "text": "...", "componentIds": [...], "connectionIds": [...], "motionIds": [...] }
  ]
}

对于content字段：
{
  "fixed": {
    "problemStatement": "...",
    "technicalSolution": "...",
    "innovationPoints": [...],
    "benefits": "..."
  }
}`;

async function fixField(
  draft: DocumentDraft,
  field: string,
  issues: ReviewIssue[],
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal
): Promise<DocumentDraft | null> {
  const issueDescriptions = issues.map(issue =>
    `- ${issue.message}${issue.suggestion ? `\n  建议：${issue.suggestion}` : ''}`
  ).join('\n');

  const input = {
    field,
    issues: issueDescriptions,
    original: getFieldValue(draft, field),
    context,
  };

  const result = await chatJson(
      `${fixPrompt}\n\n需要修复的字段：${field}\n问题列表：\n${issueDescriptions}`,
      input,
      config,
      signal,
      fetch,
      3000,
      undefined,
      (value) => {
        const data = value as { fixed?: unknown };
        if (!data.fixed) {
          return ['缺少fixed字段'];
        }
        return true;
      }
    );

  const fixed = (result.value as { fixed: unknown }).fixed;
  return setFieldValue(draft, field, fixed);
}

function getFieldValue(draft: DocumentDraft, field: string): unknown {
  switch (field) {
    case 'abstract': return draft.abstract;
    case 'claims': return draft.claims;
    case 'technicalField': return draft.technicalField;
    case 'background': return draft.background;
    case 'content': return draft.content;
    case 'drawings': return draft.drawings;
    case 'embodiment': return draft.embodiment;
    default: return null;
  }
}

function setFieldValue(draft: DocumentDraft, field: string, value: unknown): DocumentDraft | null {
  switch (field) {
    case 'abstract':
      return typeof value === 'string' ? { ...draft, abstract: value } : null;
    case 'claims':
      return isValidClaims(value, draft.claims) ? { ...draft, claims: value } : null;
    case 'technicalField':
      return typeof value === 'string' ? { ...draft, technicalField: value } : null;
    case 'background':
      return typeof value === 'string' ? { ...draft, background: value } : null;
    case 'content':
      return isValidContent(value) ? { ...draft, content: value } : null;
    case 'drawings':
      return typeof value === 'string' ? { ...draft, drawings: value } : null;
    case 'embodiment':
      return typeof value === 'string' ? { ...draft, embodiment: value } : null;
    default:
      return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isValidClaims(value: unknown, original: DocumentDraft['claims']): value is DocumentDraft['claims'] {
  if (!Array.isArray(value) || value.length !== original.length) return false;
  return value.every((claim, index) => {
    if (!claim || typeof claim !== 'object') return false;
    const candidate = claim as Partial<DocumentDraft['claims'][number]>;
    const source = original[index];
    return typeof candidate.claimNo === 'number' &&
      candidate.claimNo === source.claimNo &&
      candidate.parentClaimNo === source.parentClaimNo &&
      typeof candidate.text === 'string' &&
      isStringArray(candidate.componentIds) &&
      JSON.stringify(candidate.componentIds) === JSON.stringify(source.componentIds) &&
      isStringArray(candidate.connectionIds) &&
      JSON.stringify(candidate.connectionIds) === JSON.stringify(source.connectionIds) &&
      isStringArray(candidate.motionIds || []) &&
      JSON.stringify(candidate.motionIds || []) === JSON.stringify(source.motionIds || []);
  });
}

function isValidContent(value: unknown): value is DocumentDraft['content'] {
  if (!value || typeof value !== 'object') return false;
  const content = value as Partial<DocumentDraft['content']>;
  return typeof content.problemStatement === 'string' &&
    typeof content.technicalSolution === 'string' &&
    isStringArray(content.innovationPoints) &&
    typeof content.benefits === 'string';
}
