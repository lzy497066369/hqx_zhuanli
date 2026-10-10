/**
 * AI审核器：对草稿进行多维度质量评估
 *
 * 审核维度：
 * 1. 逻辑一致性（部件、连接、编号）
 * 2. 文本清晰度（是否有歧义、冗余）
 * 3. 法律合规性（权利要求格式、技术特征完整性）
 * 4. 创新性表达（是否突出创新点）
 */

import type { DocumentDraft, ReviewReport, ReviewIssue } from './documentGenerationV2.ts';
import type { PatentStructureModel } from '../src/features/utility/patentStructure.ts';
import type { AiConfig } from './aiSupport.ts';
import { getReferenceNo } from '../src/features/utility/patentStructure.ts';
import { chatJson } from './patentStructureAi.ts';

function reviewFailureIssue(dimension: string, error: unknown): ReviewIssue[] {
  console.error(`${dimension} review failed:`, error);
  return [{
    id: `review-failure-${dimension.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    severity: 'error',
    category: 'logic',
    field: 'review',
    message: `${dimension}审核执行失败，无法确认文档质量`,
    autoFixable: false,
  }];
}

function validReviewIssues(value: unknown): true | string[] {
  const data = value as { issues?: unknown[] } | null;
  if (!Array.isArray(data?.issues) || data.issues.length > 100) return ['issues字段必须是有效数组'];
  return data.issues.every(item => {
    if (!item || typeof item !== 'object') return false;
    const issue = item as Partial<ReviewIssue>;
    return ['error', 'warning', 'suggestion'].includes(issue.severity || '') &&
      ['logic', 'consistency', 'clarity', 'redundancy', 'legal'].includes(issue.category || '') &&
      typeof issue.field === 'string' && !!issue.field.trim() &&
      typeof issue.message === 'string' && !!issue.message.trim() &&
      typeof issue.autoFixable === 'boolean' &&
      (issue.suggestion === undefined || typeof issue.suggestion === 'string');
  }) ? true : ['ReviewIssue 的 severity、category、field、message 或 autoFixable 无效'];
}

// ============================================================================
// 主审核流程
// ============================================================================

export async function reviewDraft(
  draft: DocumentDraft,
  model: PatentStructureModel,
  config: AiConfig,
  signal: AbortSignal
): Promise<ReviewReport> {
  const startTime = Date.now();

  // Strict E2E runs dimensions sequentially so failure stops future supplier calls.
  const checks = [
    () => reviewConsistency(draft, model, config, signal),
    () => reviewClarity(draft, config, signal),
    () => reviewLegalCompliance(draft, model, config, signal),
    () => reviewInnovation(draft, model, config, signal),
  ];
  const results: ReviewIssue[][] = [];
  if (config.executionPolicy) {
    for (const check of checks) results.push(await check());
  } else {
    results.push(...await Promise.all(checks.map(check => check())));
  }
  const [consistencyIssues, clarityIssues, legalIssues, innovationIssues] = results;


  // 合并所有问题
  const allIssues = [
    ...consistencyIssues,
    ...clarityIssues,
    ...legalIssues,
    ...innovationIssues,
  ];

  // 计算各维度分数
  const consistencyScore = calculateScore(consistencyIssues);
  const clarityScore = calculateScore(clarityIssues);
  const legalScore = calculateScore(legalIssues);
  const innovationScore = calculateScore(innovationIssues);

  // 计算总分（加权平均）
  const overallScore = Math.round(
    consistencyScore * 0.3 +
    clarityScore * 0.2 +
    legalScore * 0.35 +
    innovationScore * 0.15
  );

  return {
    version: 2,
    stage: 'reviewed',
    reviewedAt: new Date().toISOString(),
    issues: allIssues,
    overallScore,
    readabilityScore: clarityScore,
    consistencyScore,
    innovationScore,
    metadata: {
      model: config.model,
      elapsedMs: Date.now() - startTime,
    },
  };
}

// ============================================================================
// 一致性审核
// ============================================================================

const consistencyPrompt = `你是专利文档一致性审核助手。检查文档各部分之间的一致性。

检查项：
1. 部件编号一致性：
   - 同一部件在不同部分的编号是否一致
   - 编号是否有遗漏或重复

2. 部件名称一致性：
   - 同一部件的名称是否前后一致（不能一会儿叫"支撑板"一会儿叫"底板"）

3. 连接关系一致性：
   - 权利要求、技术内容、具体实施方式中描述的连接关系是否一致
   - 是否有矛盾的描述（如A与B固定连接，又说A与B可滑动）

4. 创新点一致性：
   - 权利要求中的特征是否体现了技术内容中的创新点
   - 有益效果的描述是否与创新点对应

输出格式：纯JSON
{
  "issues": [
    {
      "severity": "error" | "warning" | "suggestion",
      "category": "consistency",
      "field": "claims",
      "message": "具体问题描述",
      "suggestion": "修改建议（可选）",
      "autoFixable": true | false
    }
  ]
}

注意：
- severity="error"：必须修复的严重问题
- severity="warning"：建议修复的问题
- severity="suggestion"：可以改进的地方
- autoFixable=true：可以通过AI自动修复`;

async function reviewConsistency(
  draft: DocumentDraft,
  model: PatentStructureModel,
  config: AiConfig,
  signal: AbortSignal
): Promise<ReviewIssue[]> {
  const componentRefs = model.components.map((c, i) => ({
    id: c.id,
    name: c.name,
    referenceNo: getReferenceNo(c, i),
  }));

  const input = {
    componentRefs,
    abstract: draft.abstract,
    claims: draft.claims.map(c => c.text),
    content: draft.content,
    embodiment: draft.embodiment,
    connections: model.connections.map(conn => {
      const from = model.components.find(c => c.id === conn.from);
      const to = model.components.find(c => c.id === conn.to);
      return {
        from: from?.name,
        to: to?.name,
        relation: conn.relation,
      };
    }),
  };

  try {
    const result = await chatJson(
      consistencyPrompt,
      input,
      config,
      signal,
      fetch,
      2000,
      undefined,
      validReviewIssues
    );

    const issues = (result.value as { issues: ReviewIssue[] }).issues;
    return issues.map(issue => ({
      ...issue,
      id: `consistency-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    }));
  } catch (error) {
    if (config.executionPolicy) throw error;
    return reviewFailureIssue('一致性', error);
  }
}

// ============================================================================
// 清晰度审核
// ============================================================================

const clarityPrompt = `你是专利文档清晰度审核助手。检查文档的可读性和表达清晰度。

检查项：
1. 冗余表达：
   - 是否有重复的句子或段落
   - 是否有不必要的赘述

2. 歧义表达：
   - 代词指代是否明确（"其"、"该"、"所述"指代谁）
   - 技术术语使用是否准确

3. 句式问题：
   - 句子是否过长（超过100字）
   - 是否有语病或不通顺的地方

4. 专业性：
   - 是否使用了口语化表达
   - 是否有错别字或标点错误

输出格式：纯JSON
{
  "issues": [
    {
      "severity": "warning" | "suggestion",
      "category": "clarity",
      "field": "embodiment",
      "message": "句子过长，建议拆分",
      "suggestion": "将XX部分拆分为两句",
      "autoFixable": true
    }
  ]
}`;

async function reviewClarity(
  draft: DocumentDraft,
  config: AiConfig,
  signal: AbortSignal
): Promise<ReviewIssue[]> {
  const input = {
    abstract: draft.abstract,
    claims: draft.claims.map(c => c.text),
    technicalField: draft.technicalField,
    background: draft.background,
    content: `${draft.content.problemStatement}\n${draft.content.technicalSolution}\n${draft.content.benefits}`,
    embodiment: draft.embodiment,
  };

  try {
    const result = await chatJson(
      clarityPrompt,
      input,
      config,
      signal,
      fetch,
      2000,
      undefined,
      validReviewIssues
    );

    const issues = (result.value as { issues: ReviewIssue[] }).issues;
    return issues.map(issue => ({
      ...issue,
      id: `clarity-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    }));
  } catch (error) {
    if (config.executionPolicy) throw error;
    return reviewFailureIssue('清晰度', error);
  }
}

// ============================================================================
// 法律合规性审核
// ============================================================================

const legalPrompt = `你是专利法律合规性审核助手。检查文档是否符合专利法规定。

检查项：
1. 权利要求格式：
   - 独立权利要求是否包含前序部分、特征部分
   - 从属权利要求的引用是否正确
   - 是否有权利要求过于宽泛或过于狭窄

2. 技术特征完整性：
   - 权利要求是否包含了必要技术特征
   - 是否有功能性限定而缺少结构限定

3. 说明书支持：
   - 权利要求的特征在说明书中是否有对应描述
   - 附图标记是否正确

4. 禁止事项：
   - 是否包含科学理论、智力活动规则
   - 是否有绝对化表述（"最好"、"完美"）
   - 是否有商业宣传内容

输出格式：纯JSON
{
  "issues": [
    {
      "severity": "error" | "warning",
      "category": "legal",
      "field": "claims",
      "message": "权利要求1缺少必要技术特征",
      "suggestion": "应补充XX特征",
      "autoFixable": false
    }
  ]
}`;

async function reviewLegalCompliance(
  draft: DocumentDraft,
  model: PatentStructureModel,
  config: AiConfig,
  signal: AbortSignal
): Promise<ReviewIssue[]> {
  const input = {
    title: model.productTitle,
    claims: draft.claims,
    abstract: draft.abstract,
    content: draft.content,
    embodiment: draft.embodiment,
    components: model.components.map((c, i) => ({
      name: c.name,
      referenceNo: getReferenceNo(c, i),
      kind: c.kind,
    })),
  };

  try {
    const result = await chatJson(
      legalPrompt,
      input,
      config,
      signal,
      fetch,
      2500,
      undefined,
      validReviewIssues
    );

    const issues = (result.value as { issues: ReviewIssue[] }).issues;
    return issues.map(issue => ({
      ...issue,
      id: `legal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    }));
  } catch (error) {
    if (config.executionPolicy) throw error;
    return reviewFailureIssue('法律合规性', error);
  }
}

// ============================================================================
// 创新性审核
// ============================================================================

const innovationPrompt = `你是专利创新性审核助手。评估文档对创新点的表达是否充分。

检查项：
1. 创新点识别：
   - 是否明确指出了与现有技术的区别
   - 创新点是否清晰、具体

2. 创新点展现：
   - 权利要求是否充分保护了创新点
   - 说明书是否充分描述了创新点的技术效果

3. 技术效果说明：
   - 有益效果的描述是否具体、可验证
   - 是否说明了创新点如何解决技术问题

4. 改进建议：
   - 是否还有未被充分保护的技术特征
   - 权利要求布局是否合理

输出格式：纯JSON
{
  "issues": [
    {
      "severity": "suggestion",
      "category": "clarity",
      "field": "claims",
      "message": "建议增加关于XX特征的从属权利要求",
      "suggestion": "可以补充：根据权利要求X所述的...，其特征在于：XX的具体结构为...",
      "autoFixable": false
    }
  ]
}`;

async function reviewInnovation(
  draft: DocumentDraft,
  model: PatentStructureModel,
  config: AiConfig,
  signal: AbortSignal
): Promise<ReviewIssue[]> {
  const innovationComponents = model.components.filter(c => c.kind === 'innovation');

  const input = {
    title: model.productTitle,
    innovationPoints: model.innovationPoints,
    innovationComponents: innovationComponents.map(c => ({
      name: c.name,
      purpose: c.purpose,
      whyNeeded: c.whyNeeded,
    })),
    claims: draft.claims,
    content: draft.content,
    benefits: draft.content.benefits,
  };

  try {
    const result = await chatJson(
      innovationPrompt,
      input,
      config,
      signal,
      fetch,
      2000,
      undefined,
      validReviewIssues
    );

    const issues = (result.value as { issues: ReviewIssue[] }).issues;
    return issues.map(issue => ({
      ...issue,
      id: `innovation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    }));
  } catch (error) {
    if (config.executionPolicy) throw error;
    return reviewFailureIssue('创新性', error);
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 根据问题列表计算质量分数
 */
function calculateScore(issues: ReviewIssue[]): number {
  let score = 100;

  for (const issue of issues) {
    if (issue.severity === 'error') {
      score -= 20;
    } else if (issue.severity === 'warning') {
      score -= 10;
    } else if (issue.severity === 'suggestion') {
      score -= 3;
    }
  }

  return Math.max(0, score);
}

/**
 * 按严重程度对问题排序
 */
export function sortIssuesBySeverity(issues: ReviewIssue[]): ReviewIssue[] {
  const severityOrder = { error: 0, warning: 1, suggestion: 2 };
  return [...issues].sort((a, b) => {
    const orderDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (orderDiff !== 0) return orderDiff;
    return a.field.localeCompare(b.field);
  });
}

/**
 * 过滤出可自动修复的问题
 */
export function getAutoFixableIssues(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.filter(issue => issue.autoFixable);
}

/**
 * 按字段分组问题
 */
export function groupIssuesByField(issues: ReviewIssue[]): Record<string, ReviewIssue[]> {
  const groups: Record<string, ReviewIssue[]> = {};
  for (const issue of issues) {
    if (!groups[issue.field]) {
      groups[issue.field] = [];
    }
    groups[issue.field].push(issue);
  }
  return groups;
}
