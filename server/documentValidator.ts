/**
 * 最终验证器：对改写后的文档进行最终质量检查
 *
 * 验证项：
 * 1. 一致性检查（使用现有的patentConsistency）
 * 2. 完整性检查（必要字段是否存在）
 * 3. 格式规范性检查
 * 4. 质量评分
 */

import type { PolishedDocument, ValidatedDocument, ReviewIssue } from './documentGenerationV2.ts';
import type { PatentGenerationContext } from '../src/features/utility/claimPlan.ts';
import type { PatentStructureModel } from '../src/features/utility/patentStructure.ts';
import type { AiConfig } from './aiSupport.ts';
import { validatePatentConsistency } from '../src/features/utility/patentConsistency.ts';
import { validateClaimDependencies } from '../src/features/utility/claimDependencies.ts';
import { documentForValidation } from './documentGenerationV2.ts';
import { validatePatentDocument } from '../src/features/utility/patentValidator.ts';
import { validateEvidenceReferences } from '../src/features/utility/patentEvidence.ts';
import { getModelVersion, getReferenceNo } from '../src/features/utility/patentStructure.ts';

// ============================================================================
// 主验证流程
// ============================================================================

export async function validateFinalDocument(
  polished: PolishedDocument,
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal
): Promise<ValidatedDocument> {
  void config;
  void signal;
  const { model } = context;
  const issues: ReviewIssue[] = [];

  // 1. 完整性检查
  issues.push(...checkCompleteness(polished, context));

  // 2. 生成上下文硬校验：文档只能来自当前版本的已确认事实和权利要求规划。
  issues.push(...checkGenerationContext(context));

  // 3. 改写结果必须保持 ClaimPlan 的闭集映射。
  issues.push(...checkClaimPlanMapping(polished, context));

  // 4. 格式规范性检查
  issues.push(...checkFormatCompliance(polished, model));

  // 5. 权利要求依赖关系检查
  const claimErrors = validateClaimDependencies(polished.claims);
  issues.push(...claimErrors.map(error => ({
    id: `claim-dep-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    severity: 'error' as const,
    category: 'legal' as const,
    field: 'claims',
    message: error,
    autoFixable: false,
  })));

  // 6. 使用现有的一致性验证
  const consistencyIssues = validatePatentConsistency({
    model,
    claimReferences: polished.claimReferences,
    claimsText: polished.claims.join('\n'),
    text: [
      polished.abstract,
      polished.technicalField,
      polished.background,
      polished.content,
      polished.drawings,
      polished.embodiment,
    ].join('\n'),
    figureComponentIds: model.figureSpecs.map(fig => fig.componentIds),
    documentSourceModelVersion: getModelVersion(model),
  });

  issues.push(...consistencyIssues.map(issue => ({
    id: `consistency-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    severity: issue.severity,
    category: 'consistency' as const,
    field: 'document',
    message: issue.message,
    autoFixable: false,
  })));

  const factReport = validatePatentDocument({ context, document: documentForValidation(polished, context),
    claimReferences: polished.claimReferences, sourceModelVersion: getModelVersion(model) });
  issues.push(...factReport.issues.map((item, index) => ({
    id: `fact-${item.code}-${index}`, severity: item.severity, category: 'consistency' as const,
    field: item.field, message: item.message, autoFixable: false,
  })));

  // 7. 计算质量分数
  const qualityScore = calculateQualityScore(polished, issues);

  // 8. 判断是否可以导出。任何硬校验错误都必须阻断导出。
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const readyForExport = errorCount === 0;

  return {
    version: 2,
    stage: 'validated',
    validatedAt: new Date().toISOString(),
    document: polished,
    validationIssues: issues,
    readyForExport,
    qualityScore,
  };
}

// ============================================================================
// 完整性检查
// ============================================================================

function checkCompleteness(polished: PolishedDocument, context: PatentGenerationContext): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  // 检查必要字段
  const requiredFields: Array<[keyof PolishedDocument, string]> = [
    ['abstract', '摘要'],
    ['claims', '权利要求书'],
    ['technicalField', '技术领域'],
    ['background', '背景技术'],
    ['content', '实用新型内容'],
    ['drawings', '附图说明'],
    ['embodiment', '具体实施方式'],
  ];

  for (const [field, label] of requiredFields) {
    const value = polished[field];
    if (!value) {
      issues.push({
        id: `completeness-${field}-${Date.now()}`,
        severity: 'error',
        category: 'logic',
        field: field as string,
        message: `${label}为空`,
        autoFixable: false,
      });
    } else if (typeof value === 'string' && value.trim().length < 10) {
      issues.push({
        id: `completeness-${field}-short-${Date.now()}`,
        severity: 'error',
        category: 'logic',
        field: field as string,
        message: `${label}内容过短`,
        autoFixable: false,
      });
    } else if (Array.isArray(value) && value.length === 0) {
      issues.push({
        id: `completeness-${field}-empty-${Date.now()}`,
        severity: 'error',
        category: 'logic',
        field: field as string,
        message: `${label}为空数组`,
        autoFixable: false,
      });
    }
  }

  const plannedClaimCount = context.claimPlan.claims.length;
  if (polished.claims.length !== plannedClaimCount) {
    issues.push({
      id: `completeness-claims-count-${Date.now()}`,
      severity: 'error',
      category: 'legal',
      field: 'claims',
      message: `权利要求数量必须与规划一致（规划${plannedClaimCount}条，实际${polished.claims.length}条）`,
      autoFixable: false,
    });
  }

  return issues;
}

function issue(id: string, field: string, message: string, category: ReviewIssue['category'] = 'consistency'): ReviewIssue {
  return { id, severity: 'error', category, field, message, autoFixable: false };
}

function checkGenerationContext(context: PatentGenerationContext): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const modelVersion = getModelVersion(context.model);

  if (context.evidence.modelVersion !== modelVersion) {
    issues.push(issue('context-evidence-version', 'evidence', '证据包与结构模型版本不一致'));
  }
  if (context.reasoning.modelVersion !== modelVersion) {
    issues.push(issue('context-reasoning-version', 'reasoning', '推理包与结构模型版本不一致'));
  }
  if (context.claimPlan.modelVersion !== modelVersion) {
    issues.push(issue('context-claim-plan-version', 'claimPlan', '权利要求规划与结构模型版本不一致', 'legal'));
  }

  for (const message of validateEvidenceReferences(context.model, context.evidence)) {
    issues.push(issue(`context-evidence-${issues.length}`, 'evidence', message));
  }
  for (const item of context.evidence.items) {
    if (item.status === 'CONFLICT') {
      issues.push(issue(`context-conflict-${item.id}`, 'evidence', `${item.id} 存在未解决的事实冲突`));
    }
  }

  const reliable = new Set(context.evidence.items
    .filter(item => item.status === 'SUPPORTED' || item.status === 'USER_CONFIRMED')
    .map(item => item.id));
  for (const value of [...context.model.components, ...context.model.connections, ...context.model.motions]) {
    if (!value.evidenceRefs?.some(ref => reliable.has(ref))) {
      issues.push(issue(`context-unsupported-${value.id}`, 'model', `${value.id} 缺少可追溯的可靠结构依据`));
    }
  }

  return issues;
}

function sameIds(actual: string[] | undefined, expected: string[]): boolean {
  return JSON.stringify(actual || []) === JSON.stringify(expected);
}

function checkClaimPlanMapping(polished: PolishedDocument, context: PatentGenerationContext): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const planned = context.claimPlan.claims;
  if (polished.claimReferences.length !== planned.length) {
    issues.push(issue('claim-plan-reference-count', 'claims', '权利要求引用记录数量与规划不一致', 'legal'));
    return issues;
  }

  for (const plan of planned) {
    const reference = polished.claimReferences.find(value => value.claimNo === plan.claimNo);
    if (!reference) {
      issues.push(issue(`claim-plan-missing-${plan.claimNo}`, 'claims', `缺少权利要求${plan.claimNo}的结构映射`, 'legal'));
      continue;
    }
    if (reference.parentClaimNo !== plan.parentClaimNo ||
        !sameIds(reference.componentIds, plan.componentIds) ||
        !sameIds(reference.connectionIds, plan.connectionIds) ||
        !sameIds(reference.motionIds, plan.motionIds)) {
      issues.push(issue(`claim-plan-mismatch-${plan.claimNo}`, `claims.${plan.claimNo}`, `权利要求${plan.claimNo}超出或偏离既定权利要求规划`, 'legal'));
    }
  }

  return issues;
}

// ============================================================================
// 格式规范性检查
// ============================================================================

function checkFormatCompliance(
  polished: PolishedDocument,
  model: PatentStructureModel
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  // 检查摘要
  if (polished.abstract.length < 50 || polished.abstract.length > 400) {
    issues.push({
      id: `format-abstract-length-${Date.now()}`,
      severity: 'warning',
      category: 'clarity',
      field: 'abstract',
      message: `摘要长度为${polished.abstract.length}字，建议在50-400字之间`,
      autoFixable: false,
    });
  }

  if (/本实用新型|本发明/.test(polished.abstract)) {
    issues.push({
      id: `format-abstract-subject-${Date.now()}`,
      severity: 'warning',
      category: 'clarity',
      field: 'abstract',
      message: '摘要中不应使用"本实用新型"或"本发明"',
      autoFixable: true,
    });
  }

  // 检查权利要求格式
  for (let i = 0; i < polished.claims.length; i++) {
    const claim = polished.claims[i];
    const expectedPrefix = `${i + 1}. `;

    if (!claim.startsWith(expectedPrefix)) {
      issues.push({
        id: `format-claim-number-${i}-${Date.now()}`,
        severity: 'error',
        category: 'legal',
        field: 'claims',
        message: `权利要求${i + 1}的编号格式不正确`,
        autoFixable: false,
      });
    }

    if (i === 0) {
      // 独立权利要求检查
      if (!claim.includes('其特征在于')) {
        issues.push({
          id: `format-claim-1-feature-${Date.now()}`,
          severity: 'error',
          category: 'legal',
          field: 'claims',
          message: '独立权利要求应包含"其特征在于"',
          autoFixable: false,
        });
      }
    } else {
      // 从属权利要求检查
      if (!claim.includes('根据权利要求')) {
        issues.push({
          id: `format-claim-${i + 1}-reference-${Date.now()}`,
          severity: 'error',
          category: 'legal',
          field: 'claims',
          message: `权利要求${i + 1}应引用上位权利要求`,
          autoFixable: false,
        });
      }
    }
  }

  // 检查技术领域格式
  if (!polished.technicalField.startsWith('本实用新型涉及') &&
      !polished.technicalField.startsWith('本发明涉及')) {
    issues.push({
      id: `format-field-prefix-${Date.now()}`,
      severity: 'warning',
      category: 'clarity',
      field: 'technicalField',
      message: '技术领域应以"本实用新型涉及"开头',
      autoFixable: true,
    });
  }

  // 检查具体实施方式格式
  if (!polished.embodiment.includes('如图') && !polished.embodiment.includes('如附图')) {
    issues.push({
      id: `format-embodiment-figures-${Date.now()}`,
      severity: 'warning',
      category: 'clarity',
      field: 'embodiment',
      message: '具体实施方式应引用附图',
      autoFixable: true,
    });
  }

  // 检查部件编号是否正确使用
  const componentRefs = model.components.map((c, i) => getReferenceNo(c, i));
  const allText = [
    polished.abstract,
    ...polished.claims,
    polished.content,
    polished.embodiment,
  ].join(' ');

  for (const ref of componentRefs) {
    // 检查是否使用了括号标注
    const pattern = new RegExp(`\\(${ref}\\)|（${ref}）`, 'g');
    if (!pattern.test(allText)) {
      issues.push({
        id: `format-ref-${ref}-missing-${Date.now()}`,
        severity: 'suggestion',
        category: 'clarity',
        field: 'document',
        message: `部件编号${ref}未在文档中使用括号标注`,
        autoFixable: false,
      });
    }
  }

  return issues;
}

// ============================================================================
// 质量评分
// ============================================================================

function calculateQualityScore(
  polished: PolishedDocument,
  issues: ReviewIssue[]
): number {
  let score = 100;

  // 扣分项
  for (const issue of issues) {
    if (issue.severity === 'error') {
      score -= 25;
    } else if (issue.severity === 'warning') {
      score -= 10;
    } else if (issue.severity === 'suggestion') {
      score -= 3;
    }
  }

  // 加分项：改进数量
  const improvementBonus = Math.min(polished.improvements.length * 2, 10);
  score += improvementBonus;

  // 加分项：权利要求数量合理
  if (polished.claims.length >= 3 && polished.claims.length <= 10) {
    score += 5;
  }

  // 加分项：摘要长度适中
  if (polished.abstract.length >= 100 && polished.abstract.length <= 200) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

// ============================================================================
// 验证报告生成
// ============================================================================

export function generateValidationReport(validated: ValidatedDocument): string {
  const { qualityScore, validationIssues, readyForExport } = validated;

  let report = '# 文档质量验证报告\n\n';
  report += `**质量评分：** ${qualityScore}/100\n`;
  report += `**是否可导出：** ${readyForExport ? '✅ 是' : '❌ 否'}\n`;
  report += `**验证时间：** ${new Date(validated.validatedAt).toLocaleString('zh-CN')}\n\n`;

  if (validationIssues.length === 0) {
    report += '## ✨ 没有发现问题\n\n文档质量良好，可以导出Word。\n';
    return report;
  }

  // 按严重程度分组
  const errors = validationIssues.filter(i => i.severity === 'error');
  const warnings = validationIssues.filter(i => i.severity === 'warning');
  const suggestions = validationIssues.filter(i => i.severity === 'suggestion');

  if (errors.length > 0) {
    report += `## ❌ 严重问题（${errors.length}个）\n\n`;
    for (const error of errors) {
      report += `- **${error.field}：** ${error.message}\n`;
      if (error.suggestion) {
        report += `  💡 建议：${error.suggestion}\n`;
      }
    }
    report += '\n';
  }

  if (warnings.length > 0) {
    report += `## ⚠️ 警告（${warnings.length}个）\n\n`;
    for (const warning of warnings) {
      report += `- **${warning.field}：** ${warning.message}\n`;
      if (warning.suggestion) {
        report += `  💡 建议：${warning.suggestion}\n`;
      }
    }
    report += '\n';
  }

  if (suggestions.length > 0) {
    report += `## 💡 改进建议（${suggestions.length}个）\n\n`;
    for (const suggestion of suggestions) {
      report += `- **${suggestion.field}：** ${suggestion.message}\n`;
    }
    report += '\n';
  }

  // 改进总结
  if (validated.document.improvements.length > 0) {
    report += `## ✅ 已完成的改进（${validated.document.improvements.length}个）\n\n`;
    for (const improvement of validated.document.improvements) {
      report += `- **${improvement.field}：** ${improvement.reason}\n`;
    }
  }

  return report;
}
