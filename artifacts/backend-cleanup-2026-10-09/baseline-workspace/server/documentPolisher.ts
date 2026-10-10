/**
 * 文档改写器：将草稿改写为专业的、流畅的专利文档
 *
 * 改写目标：
 * 1. 提升专业性和可读性
 * 2. 消除冗余和歧义
 * 3. 优化逻辑结构
 * 4. 保持技术内容的准确性
 */

import type { DocumentDraft, PolishedDocument, GenerationProgress } from './documentGenerationV2.ts';
import type { PatentGenerationContext } from '../src/features/utility/claimPlan.ts';
import type { AiConfig } from './aiSupport.ts';
import { getReferenceNo } from '../src/features/utility/patentStructure.ts';
import { chatJson } from './patentStructureAi.ts';

// ============================================================================
// 主改写流程
// ============================================================================

export async function polishDocument(
  draft: DocumentDraft,
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal,
  onProgress: (progress: GenerationProgress) => void
): Promise<PolishedDocument> {
  const startTime = Date.now();
  const improvements: PolishedDocument['improvements'] = [];

  // 改写各部分
  onProgress({ stage: 'polish', progress: 71, message: '改写摘要...' });
  const { text: abstract, improvement: abstractImprovement } = await polishAbstract(
    draft.abstract,
    context,
    config,
    signal
  );
  if (abstractImprovement) improvements.push(abstractImprovement);

  onProgress({ stage: 'polish', progress: 73, message: '改写权利要求...' });
  const { claims, claimReferences, improvement: claimsImprovement } = await polishClaims(
    draft.claims,
    context,
    config,
    signal
  );
  if (claimsImprovement) improvements.push(claimsImprovement);

  onProgress({ stage: 'polish', progress: 76, message: '改写技术领域...' });
  const { text: technicalField, improvement: fieldImprovement } = await polishTechnicalField(
    draft.technicalField,
    config,
    signal
  );
  if (fieldImprovement) improvements.push(fieldImprovement);

  onProgress({ stage: 'polish', progress: 78, message: '改写背景技术...' });
  const { text: background, improvement: backgroundImprovement } = await polishBackground(
    draft.background,
    context,
    config,
    signal
  );
  if (backgroundImprovement) improvements.push(backgroundImprovement);

  onProgress({ stage: 'polish', progress: 81, message: '改写技术内容...' });
  const { text: content, improvement: contentImprovement } = await polishContent(
    draft.content,
    context,
    config,
    signal
  );
  if (contentImprovement) improvements.push(contentImprovement);

  onProgress({ stage: 'polish', progress: 84, message: '改写附图说明...' });
  const { text: drawings, improvement: drawingsImprovement } = await polishDrawings(
    draft.drawings,
    config,
    signal
  );
  if (drawingsImprovement) improvements.push(drawingsImprovement);

  onProgress({ stage: 'polish', progress: 87, message: '改写具体实施方式...' });
  const { text: embodiment, improvement: embodimentImprovement } = await polishEmbodiment(
    draft.embodiment,
    context,
    config,
    signal
  );
  if (embodimentImprovement) improvements.push(embodimentImprovement);

  return {
    version: 2,
    stage: 'polished',
    polishedAt: new Date().toISOString(),
    abstract,
    claims,
    technicalField,
    background,
    content,
    drawings,
    embodiment,
    claimReferences,
    improvements,
    metadata: {
      model: config.model,
      elapsedMs: Date.now() - startTime,
    },
  };
}

function groundedModelFacts(context: PatentGenerationContext) {
  const { model, reasoning, claimPlan } = context;
  return {
    title: model.productTitle,
    components: model.components.map((component, index) => ({
      id: component.id,
      name: component.name,
      referenceNo: getReferenceNo(component, index),
    })),
    connections: model.connections.map(connection => ({
      id: connection.id,
      from: connection.from,
      to: connection.to,
      relation: connection.relation,
    })),
    motions: model.motions.map(motion => ({
      id: motion.id,
      componentId: motion.componentId,
      type: motion.type,
      path: motion.path,
    })),
    reasoning: {
      technicalProblem: reasoning.technicalProblem,
      problemCauseStatus: reasoning.problemCauseStatus,
      priorArtRelations: reasoning.priorArtRelations,
      chains: reasoning.chains.map(chain => ({ id: chain.id, solutionFeatureIds: chain.solutionFeatureIds,
        causeEvidenceRefs: chain.causeEvidenceRefs, priorArtRelationIds: chain.priorArtRelationIds, effectIds: chain.effectIds })),
      effects: reasoning.effects,
      structuralMechanism: reasoning.structuralMechanism,
      workingSteps: reasoning.workingSteps,
      technicalEffects: reasoning.technicalEffects,
      evidenceRefs: reasoning.evidenceRefs,
    },
    evidence: context.evidence.items.map(item => ({ id: item.id, sourceId: item.sourceId, sourceUrl: item.sourceUrl,
      sourceReference: item.sourceReference, evidenceScope: item.evidenceScope, status: item.status })),
    claimPlan: claimPlan.claims,
  };
}

function assertTextGrounded(text: string, context: PatentGenerationContext, field: string) {
  const model = context.model;
  const knownNames = new Set(model.components.map(component => component.name));
  const structuralNoun = /(?:设有|增设|安装有|装有|还包括|还包含|设置|通过(?!设置))\s*(?:所述)?([\p{Script=Han}A-Za-z]{2,18}?(?:槽|孔|杆|板|盖|罩|轴|环|套|座|弹簧|连接器|显示屏|传感器|电机|控制器|模块|单元))(?=[，。；、（(与及和的\s]|$)/gu;
  for (const match of text.matchAll(structuralNoun)) {
    if (!knownNames.has(match[1])) throw new Error(`${field}包含未建模结构“${match[1]}”`);
  }
}

function assertClaimPlanMapping(
  claims: Array<{ claimNo: number; parentClaimNo?: number; componentIds: string[]; connectionIds: string[]; motionIds?: string[] }>,
  context: PatentGenerationContext,
) {
  const expected = new Map(context.claimPlan.claims.map(claim => [claim.claimNo, claim]));
  if (claims.length !== expected.size || new Set(claims.map(claim => claim.claimNo)).size !== claims.length) {
    throw new Error('润色后的权利要求数量或编号偏离权利要求规划');
  }
  for (const claim of claims) {
    const planned = expected.get(claim.claimNo);
    if (!planned || claim.parentClaimNo !== planned.parentClaimNo ||
        JSON.stringify(claim.componentIds) !== JSON.stringify(planned.componentIds) ||
        JSON.stringify(claim.connectionIds) !== JSON.stringify(planned.connectionIds) ||
        JSON.stringify(claim.motionIds || []) !== JSON.stringify(planned.motionIds)) {
      throw new Error(`权利要求${claim.claimNo}的结构映射偏离权利要求规划`);
    }
  }
}

// ============================================================================
// 各部分改写
// ============================================================================

type PolishResult = {
  text: string;
  improvement?: {
    field: string;
    before: string;
    after: string;
    reason: string;
  };
};

const polishAbstractPrompt = `你是专利摘要改写专家。将草稿改写为专业、清晰的专利摘要。

仅优化草稿已有表达。不得增加或改变部件、连接、运动、数值、技术效果及证据引用；字数要求不能凌驾于事实边界之上。

改写要点：
1. 开门见山，直接说明产品构成
2. 简洁描述关键技术特征（不超过2个）
3. 概括技术效果
4. 控制在120-200字
5. 删除冗余、模糊的表述
6. 不使用"本实用新型"、"本发明"

输出格式：
{
  "polished": "改写后的摘要",
  "changes": "主要改动说明（如：删除了冗余描述；优化了句式结构）"
}`;

async function polishAbstract(
  draft: string,
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal
): Promise<PolishResult> {
  const input = {
    draft,
    grounding: groundedModelFacts(context),
  };

  const result = await chatJson(
    polishAbstractPrompt,
    input,
    config,
    signal,
    fetch,
    1500
  );

  const data = result.value as { polished: string; changes?: string };

  return {
    text: data.polished,
    improvement: data.changes ? {
      field: '摘要',
      before: draft.slice(0, 100) + '...',
      after: data.polished.slice(0, 100) + '...',
      reason: data.changes,
    } : undefined,
  };
}

const polishClaimsPrompt = `你是专利权利要求改写专家。将草稿改写为规范、专业的权利要求。

仅优化语言，不得增删技术限定、结构参数、位置关系、部件、连接、运动、数值、技术效果或证据引用。保持每条权利要求的编号、引用依赖和 ClaimPlan 结构映射完全不变。

改写要点：
1. 独立权利要求：
   - 确保包含所有必要技术特征
   - 使用规范的"包括...，其特征在于..."句式
   - 删除不必要的限定词

2. 从属权利要求：
   - 保留草稿已有的实质性技术特征，不补写新特征
   - 保持草稿和 ClaimPlan 中的引用关系
   - 只能改进已有结构参数、位置关系的表述，不能补充或改变事实

3. 语言优化：
   - 删除口语化表述
   - 统一技术术语
   - 优化句式，提高清晰度

输出格式：
{
  "polished": [
    {
      "claimNo": 1,
      "text": "一种XXX，包括...",
      "componentIds": ["C01", "C02"],
      "connectionIds": ["R01"]
    }
  ],
  "changes": "主要改动说明"
}`;

type PolishClaimsResult = {
  claims: string[];
  claimReferences: PolishedDocument['claimReferences'];
  improvement?: PolishedDocument['improvements'][0];
};

async function polishClaims(
  draftClaims: DocumentDraft['claims'],
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal
): Promise<PolishClaimsResult> {
  const input = {
    draft: draftClaims,
    grounding: groundedModelFacts(context),
  };

  const result = await chatJson(
    polishClaimsPrompt,
    input,
    config,
    signal,
    fetch,
    4000
  );

  const data = result.value as {
    polished: Array<{
      claimNo: number;
      parentClaimNo?: number;
      text: string;
      componentIds: string[];
      connectionIds: string[];
      motionIds?: string[];
    }>;
    changes?: string;
  };

  assertClaimPlanMapping(data.polished, context);

  const claims = data.polished.map(c => `${c.claimNo}. ${c.text}`);
  const claimReferences = data.polished.map(c => ({
    claimNo: c.claimNo,
    parentClaimNo: c.parentClaimNo,
    componentIds: c.componentIds,
    connectionIds: c.connectionIds,
    motionIds: c.motionIds || [],
  }));

  return {
    claims,
    claimReferences,
    improvement: data.changes ? {
      field: '权利要求书',
      before: draftClaims.slice(0, 2).map(c => c.text).join('；'),
      after: claims.slice(0, 2).join('；'),
      reason: data.changes,
    } : undefined,
  };
}

const polishTechnicalFieldPrompt = `你是专利技术领域改写专家。将草稿改写为规范的技术领域表述。

仅优化语言，不得扩大或缩小草稿所述的技术领域，不得增加技术事实。

改写要点：
1. 使用标准格式："本实用新型涉及XXX技术领域"
2. 领域描述准确、不过宽也不过窄
3. 简洁明了，1-2句话

输出格式：
{
  "polished": "本实用新型涉及...",
  "changes": "改动说明（可选）"
}`;

async function polishTechnicalField(
  draft: string,
  config: AiConfig,
  signal: AbortSignal
): Promise<PolishResult> {
  const result = await chatJson(
    polishTechnicalFieldPrompt,
    { draft },
    config,
    signal,
    fetch,
    500
  );

  const data = result.value as { polished: string; changes?: string };

  return {
    text: data.polished,
    improvement: data.changes ? {
      field: '技术领域',
      before: draft,
      after: data.polished,
      reason: data.changes,
    } : undefined,
  };
}

const polishBackgroundPrompt = `你是专利背景技术改写专家。将草稿改写为客观、专业的背景技术描述。

仅优化草稿语言。不得添加未经草稿和来源支持的现有技术事实、问题、数字或检索引用；不得把推断表述成已证实的事实。

改写要点：
1. 客观陈述现有技术现状
2. 具体说明存在的问题（可验证的具体问题，不是"效率低"这类空话）
3. 避免绝对化表述（不说"所有"、"都"）
4. 如果有检索引用，规范引用格式
5. 控制在100-300字

输出格式：
{
  "polished": "改写后的背景技术",
  "changes": "改动说明"
}`;

async function polishBackground(
  draft: string,
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal
): Promise<PolishResult> {
  const input = {
    draft,
    research: context.research,
    externalEvidence: context.evidence.items
      .filter(item => item.originalText)
      .map(item => ({ id: item.id, originalText: item.originalText, sourceTitle: item.sourceTitle })),
  };

  const result = await chatJson(
    polishBackgroundPrompt,
    input,
    config,
    signal,
    fetch,
    1500
  );

  const data = result.value as { polished: string; changes?: string };

  return {
    text: data.polished,
    improvement: data.changes ? {
      field: '背景技术',
      before: draft.slice(0, 100) + '...',
      after: data.polished.slice(0, 100) + '...',
      reason: data.changes,
    } : undefined,
  };
}

const polishContentPrompt = `你是专利技术内容改写专家。将草稿改写为结构清晰、逻辑严密的技术内容。

仅优化草稿已有事实的语言与顺序。不得新增或改变结构、连接、运动、数值、技术效果、证据引用或问题原因；不能把推断写成已证实事实。

改写要点：
1. 技术问题：明确、具体
2. 技术方案：清晰描述结构关系，使用规范的连接词
3. 创新点：突出与现有技术的区别
4. 有益效果：
   - 有逻辑递进（通过XX，能够YY；进而实现ZZ）
   - 不是简单罗列
   - 与技术问题对应

输出格式：
{
  "polished": "完整的技术内容段落（包含技术问题、技术方案、有益效果）",
  "changes": "改动说明"
}`;

async function polishContent(
  draft: DocumentDraft['content'],
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal
): Promise<PolishResult> {
  const input = {
    draft: {
      problemStatement: draft.problemStatement,
      technicalSolution: draft.technicalSolution,
      innovationPoints: draft.innovationPoints,
      benefits: draft.benefits,
    },
    grounding: groundedModelFacts(context),
  };

  const result = await chatJson(
    polishContentPrompt,
    input,
    config,
    signal,
    fetch,
    3000
  );

  const data = result.value as { polished: string; changes?: string };
  assertTextGrounded(data.polished, context, '实用新型内容');

  return {
    text: data.polished,
    improvement: data.changes ? {
      field: '实用新型内容',
      before: `${draft.problemStatement.slice(0, 50)}...`,
      after: data.polished.slice(0, 100) + '...',
      reason: data.changes,
    } : undefined,
  };
}

const polishDrawingsPrompt = `你是专利附图说明改写专家。将草稿改写为规范的附图说明。

仅优化表达。不得改变图号、附图标记、部件名称或图中的结构关系。

改写要点：
1. 每张图的说明格式统一："图X为XXX"
2. 附图标记格式规范："附图标记：1、部件A；2、部件B；..."
3. 简洁明了，不冗余

输出格式：
{
  "polished": "改写后的附图说明",
  "changes": "改动说明（可选）"
}`;

async function polishDrawings(
  draft: string,
  config: AiConfig,
  signal: AbortSignal
): Promise<PolishResult> {
  const result = await chatJson(
    polishDrawingsPrompt,
    { draft },
    config,
    signal,
    fetch,
    1000
  );

  const data = result.value as { polished: string; changes?: string };

  return {
    text: data.polished,
    improvement: data.changes ? {
      field: '附图说明',
      before: draft.slice(0, 100) + '...',
      after: data.polished.slice(0, 100) + '...',
      reason: data.changes,
    } : undefined,
  };
}

const polishEmbodimentPrompt = `你是专利具体实施方式改写专家。将草稿改写为详细、连贯的实施方式描述。

仅优化草稿已有内容的表达。不得补充或改变部件、位置、连接、运动、工作步骤、数值、技术效果及证据引用；没有来源的细节应保持缺省。

改写要点：
1. 首句标准格式："如图1至图3所示，一种XXX，包括..."
2. 逐个描述部件：
   - 说明位置、作用
   - 使用括号标注编号
   - 使用"所述"指代前文部件
3. 描述连接关系要清晰
4. 最后描述使用过程（"使用时，..."）
5. 语言流畅，逻辑连贯

输出格式：
{
  "polished": "改写后的具体实施方式",
  "changes": "改动说明"
}`;

async function polishEmbodiment(
  draft: string,
  context: PatentGenerationContext,
  config: AiConfig,
  signal: AbortSignal
): Promise<PolishResult> {
  const input = {
    draft,
    grounding: groundedModelFacts(context),
  };

  const result = await chatJson(
    polishEmbodimentPrompt,
    input,
    config,
    signal,
    fetch,
    3000
  );

  const data = result.value as { polished: string; changes?: string };
  assertTextGrounded(data.polished, context, '具体实施方式');

  return {
    text: data.polished,
    improvement: data.changes ? {
      field: '具体实施方式',
      before: draft.slice(0, 100) + '...',
      after: data.polished.slice(0, 100) + '...',
      reason: data.changes,
    } : undefined,
  };
}
