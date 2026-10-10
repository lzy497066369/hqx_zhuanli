import type { ProductBrief, StructurePlanInput } from '../src/features/utility/patentStructure.ts';
import { isProductBrief, isInnovationNameCandidate, patentStructureSource } from '../src/features/utility/patentStructure.ts';
import { chatJson, researchInput, researchSummary, structureDiagnostic } from './patentStructureAi.ts';
import { researchPatents } from './patentResearch.ts';
import { buildResearchEvidence } from '../src/features/utility/patentEvidence.ts';
import type { AiConfig } from './aiSupport.ts';
import { AiFailure, aiProviders } from './aiSupport.ts';
import { isStructureSkeleton, sanitizeStructureSkeletonEnvelope, skeletonStructuralErrors, skeletonValidationErrors, subjectMatchesProduct } from '../src/features/utility/structureSkeleton.ts';
import type { StructureSkeleton, StructureSkeletonResponse } from '../src/features/utility/structureSkeleton.ts';
import { isGeometryRevision, isStructureEvidenceSelection, missingStructureEvidenceCategories, selectedStructureEvidence } from '../src/features/utility/structureEvidence.ts';
import { normalizeStructureFacts } from '../src/features/utility/patentStructure.ts';
import type { ProgressReporter } from './patentStructureAi.ts';
import { geometryProtocolPrompt } from '../src/features/utility/geometrySpec.ts';

export const STRUCTURE_SKELETON_PATH = '/api/utility/structure-skeleton';
export const STRUCTURE_SKELETON_TOTAL_TIMEOUT_MS = 240000;
export const STRUCTURE_SKELETON_ATTEMPT_TIMEOUT_MS = 85000;

export function structureSkeletonAttemptTimeoutMs(config: AiConfig) {
  const totalTimeoutMs = config.timeoutMs ?? STRUCTURE_SKELETON_TOTAL_TIMEOUT_MS;
  const providerCount = Math.max(1, aiProviders(config).length);
  return Math.min(STRUCTURE_SKELETON_ATTEMPT_TIMEOUT_MS, Math.max(5000, Math.floor(totalTimeoutMs / providerCount)));
}

const skeletonPrompt = `你是实用新型专利结构骨架助手。只根据用户确认的产品资料生成可供人类审核的轻量结构骨架，不生成完整草案。
检索资料中的 priorArtFacts 来自 EvidencePackage，其中 INFERRED 是未取得原文的 AI 检索归纳，不能写成已核实事实；仅用于理解现有技术问题、识别差异和辅助推理；不得复制、推断或新增用户产品的部件、连接、运动、尺寸或几何。用户确认资料才是结构事实来源。
只输出纯JSON：{"status":"ready","skeleton":{"version":1,"title":"已确认名称","visualSubject":"专利对象从外部最显眼的主体是什么，一句话","subjectComponent":"主体部件的name，必须排components第一位","summary":"不超过300字的结构概述","components":[{"name":"部件名","kind":"base或innovation","purpose":"作用","position":"相对其他部件的具体装配位置，示意待实物核对","visualFeature":"外观轮廓特征，不用颜色替代几何","geometryShape":"box等参数化形状","geometry":{"shape":"与geometryShape一致","position":[0,0,0],"size":[100,80,4],"rotation":[0,0,0]}}],"relationships":[{"from":"部件名","to":"部件名","relation":"connected_to/fixed_to/slidably_connected/rotatably_connected/driven_by/supported_by/limited_by之一，逐字输出，禁止自创其他值","description":"实际连接方式"}],"motions":[{"component":"运动部件名","type":"rotary或linear","drivenBy":"不同的驱动部件名","path":"运动轨迹","purpose":"运动作用"}],"problemSolved":"解决的问题","innovationPoints":["创新结构点"]}}。
也可以返回 {"status":"needs_information","summary":"缺失说明","questions":["需要用户核对的具体问题"]} 或 {"status":"unsupported","summary":"限制说明","questions":["需要改用CAD或确认的具体问题"],"unsupportedReason":"无法用参数化骨架表达的关键形状","geometryRevision":{"component":"已有部件名","shape":"支持的形状","change":"对原结构的最小具体修改","preservedInnovation":"修改后仍保留的具体创新结构","condition":"用户需要确认可修改设计且不影响关键功能的条件"}}。
unsupported 时先依据 confirmedEvidence、verifiedFacts 和 adoptedProposals 中已有的点与结构信息判断，能否仅修改一个已有部件的形状或局部结构使骨架可表达且保留原创新点；可行时给出一项最小 geometryRevision 供用户决定，不得声称已经修改或核验。若关键创新本身就是无法表达的曲面/轮廓，或无法确认修改后仍保留创新点，则不输出 geometryRevision，只说明 CAD 路径。已采纳的拟议修改不可反复原样建议；可行时尝试 ready，否则指出新的阻碍。
部件数2至30，名称唯一，至少一个innovation；受保护客体始终是用户资料里填写的产品本身，主体识别必须落在该产品上：先用一句话回答“这个产品从外面看，最主要、最显眼的是什么？”，并将该产品对应的部件放在components第一项。subjectComponent必须指向components第一项。钢材等原材料已被细化为具体产品（如H型钢梁），第一项就是该细化后的产品本体（如H型钢梁/带夹持板的H型钢梁），用户选择的结构特征体现在该产品本体上，而不是另起一个“连接组件/夹具/加工设备”作为首位主体。安装支架、连接件、紧固件、夹具等只是该产品上的配件或零件，绝不能取代产品本身成为首位主体或整体图主体；整体图要能看出用户所选结构就长在这个产品上。若申请对象是完整光伏板，主体是板体而不是支架；若申请对象确实是光伏板边框连接件，主体才是连接件。安装支架、角部连接件、紧固件通常是配件，整体图中不得大于、遮住或替代真正主体；主体附图中配件不画或只画轮廓，创新配件须保留在整体装配中并在局部图突出，不能凭空删掉。C01、C02等仅是系统内部结构关联ID，不是正式附图标号；不要生成、猜测或决定最终referenceNo。正式附图标号由用户在结构确认页填写，用户未填写时由离线编译器按部件顺序自动生成，可能是1、201、206、301等。第一项主体通常会被系统编译为内部C01，但正式文案只能使用referenceNo。若申请对象是完整光伏板，主体是板体而不是支架；若申请对象确实是光伏板边框连接件，主体才是连接件。安装支架、角部连接件、紧固件通常是配件，整体图中不得大于、遮住或替代真正主体；主体附图中配件不画或只画轮廓，创新配件须保留在整体装配中并在局部图突出，不能凭空删掉。每个component的visualFeature描述可见轮廓，而非只写颜色；geometry数值为同一坐标系下合理的相对比例、实际装配位置和朝向，供人工核对的示意值，绝非实测值。长方形板体用薄box，边框沿板体边缘，紧固件只在资料支持时加入。不要凭名称推断未经确认的网格、材料或额外部件。${geometryProtocolPrompt}
【附图表达优先】components 是用来生成专利附图的，应优先选择产品从外面看得见、能构成清晰机械装配轮廓的部件。只有产品资料支持时，才选用底座、薄板、折板、支架、杆件、托盘、靠板、外壳或连接件；参考图仅提供黑白轴测线稿、可见轮廓、标注方式的风格，不提供可复制的产品结构。读者应只看外轮廓就能认出本产品的装配关系。不要把产品拆成大量内部看不见的层次，也不要把普通板件、支架或外壳错误表达成同轴圆柱、圆管或透明叠层；只有真实产品确实是圆管、轴、环、齿轮等旋转件时才使用相应圆形几何。对于已确认的板件/杆件/支架，可使用比例合理的 box 或 prism，通过位置、尺寸和旋转体现装配姿态；用较少但有意义的部件表达主体轮廓，避免无必要的内部线条和重叠。内部零件只有在从外面可见、或对理解发明必不可少时才列入。每个部件的 geometryShape 和 position 要让人一眼能认出这是什么产品。连接端点必须引用部件且不能自连接，全部部件必须连通；运动件必须明确不同于自身的驱动部件：每条运动的drivenBy必须填写真实驱动它的另一个已定义部件名，绝不能与component相同；动力源部件（如电机/马达）填写驱动它的上游部件（如开关、电源输入件或上一级传动件），人力等外部驱动则填写人力直接作用的部件（如手柄、旋钮）。根据产品资料判断哪些部件实际发生运动；实际运动的部件必须在motions中给出完整记录（type、drivenBy、path、purpose）；确实静止的部件不要放入motions，服务端会确定性补齐static。
每个部件必须带有geometryShape、visualFeature、geometry且不得省略。visualFeature应直接写“长方形薄板，表面有深色电池片网格”“银色铝框”“L形连接件本体”等可见形状特征；不要只写“用于支撑”或只写颜色。已确认的长方形板面存在网格线时，可在该部件 geometry 中额外给出 surfaceGrid:[列数,行数]（每项1至20）；未确认网格则不得添加。若无法确认真实形状，不要用box掩盖，返回unsupported。不要输出referenceNo、D/C/R/M/F编号、Patent Structure Model、附图、长篇技术文案或检索全文。不要把候选名称当作已确认事实，拟议结构必须在summary或innovationPoints中标注待实物核对。`;

const skeletonLengthRetryPrompt = `${skeletonPrompt}\n上一轮输出因长度限制被截断。只输出完整纯 JSON：精简每项文字（purpose、position、visualFeature、description、path、problemSolved 及 innovationPoints 每项不超过 60 字，summary 不超过 150 字），不得省略主体、部件几何、连接或运动。`;

type Envelope = { status?: unknown; skeleton?: unknown; summary?: unknown; questions?: unknown; unsupportedReason?: unknown; geometryRevision?: unknown };

function isAssistance(value: unknown): value is Extract<StructureSkeletonResponse, { status: 'needs_information' | 'unsupported' }> {
  const item = value as Envelope | null;
  return !!item && (item.status === 'needs_information' || item.status === 'unsupported') && typeof item.summary === 'string' && item.summary.trim().length > 0 &&
    Array.isArray(item.questions) && item.questions.length >= 1 && item.questions.length <= 8 && item.questions.every(question => typeof question === 'string' && question.trim().length > 0) &&
    (item.status !== 'unsupported' || (typeof item.unsupportedReason === 'string' && item.unsupportedReason.trim().length > 0)) &&
    (item.geometryRevision === undefined || (item.status === 'unsupported' && isGeometryRevision(item.geometryRevision))) && !('skeleton' in item);
}

function isSkeletonEnvelope(value: unknown, brief: ProductBrief): value is { status: 'ready'; skeleton: StructureSkeleton } {
  const item = value as Envelope | null;
  return !!item && item.status === 'ready' && isStructureSkeleton(item.skeleton) && skeletonValidationErrors(item.skeleton).length === 0 && subjectErrors(item.skeleton, brief).length === 0 && !('draft' in item) && !('model' in item);
}

function compactBrief(brief: ProductBrief) {
  const { imageData: _imageData, structureEvidence, confirmedFacts, ...rest } = brief;
  return { ...rest, confirmedEvidence: selectedStructureEvidence(structureEvidence), verifiedFacts: normalizeStructureFacts(confirmedFacts).filter(fact => !fact.origin), adoptedProposals: normalizeStructureFacts(confirmedFacts).filter(fact => fact.origin === 'model_proposal') };
}

/**
 * 首位部件必须是用户所填产品本身。骨架的 title 是名称，产品名另从 brief 取，
 * 因此主体校验不能只依赖骨架自身，必须显式比对 brief.productName。
 */
function subjectErrors(skeleton: StructureSkeleton, brief: ProductBrief): string[] {
  const main = skeleton.components[0];
  if (!main) return ['结构骨架缺少首位主体部件。'];
  if (subjectMatchesProduct(main.name, brief.productName)) return [];
  return [`首位部件“${main.name}”不是所填产品“${brief.productName}”本身；整体图主体必须是该产品，可带形状、结构或连接限定，不能换成它的配件或加工设备。`];
}

export async function generateStructureSkeleton(input: StructurePlanInput, config: AiConfig, signal: AbortSignal, fetcher: typeof fetch = fetch, requestIdOrProgress?: string | ProgressReporter, progressReporter?: ProgressReporter): Promise<StructureSkeletonResponse> {
  const requestId = typeof requestIdOrProgress === 'string' ? requestIdOrProgress : undefined;
  const onProgress = typeof requestIdOrProgress === 'function' ? requestIdOrProgress : progressReporter;
  const totalTimeout = AbortSignal.timeout(config.timeoutMs ?? STRUCTURE_SKELETON_TOTAL_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, totalTimeout]);
  try {
    if (!input || !isProductBrief(input.brief) || !isInnovationNameCandidate(input.candidate)) throw new AiFailure(400, 'INVALID_INPUT', '请提供有效的产品资料和名称候选。');
    if (input.requireEvidence) {
      const evidence = input.brief.structureEvidence;
      if (!isStructureEvidenceSelection(evidence) || !evidence.confirmed || missingStructureEvidenceCategories(evidence).length) {
        return { status: 'needs_information', summary: '产品结构、连接、运动或几何资料尚未确认。', questions: ['请先确认产品实际具备的部件、连接关系、运动方式和可表达的几何形状。'], options: [], candidate: input.candidate };
      }
    }
    onProgress?.('检索相关资料', '正在检索公开专利；检索失败将停止本次结构生成');
    const research = await researchPatents(
      researchInput(input.brief, input.candidate),
      config,
      requestSignal,
      fetcher,
      result => structureDiagnostic('research', result, requestId),
      false,
    );
    const priorArtEvidence = buildResearchEvidence(research);
    onProgress?.('生成结构骨架', '模型只整理部件、连接、运动和几何类别');
    const result = await chatJson(skeletonPrompt, {
      title: input.candidate.name,
      brief: compactBrief(input.brief),
      candidate: { name: input.candidate.name, innovationDirection: input.candidate.innovationDirection, coreInnovationStructure: input.candidate.coreInnovationStructure, mainComponents: input.candidate.mainComponents, implementation: input.candidate.implementation },
      research: {
        summary: researchSummary(research),
        sources: priorArtEvidence.research!.sources,
        priorArtFacts: priorArtEvidence.items.map(fact => ({
          id: fact.id,
          sourceId: fact.sourceId,
          sourceTitle: fact.sourceTitle,
          sourceUrl: fact.sourceUrl,
          status: fact.status,
          factType: fact.factType,
          extractedFact: fact.extractedFact,
          evidenceScope: fact.evidenceScope,
        })),
      },
    }, config, requestSignal, fetcher, 4000, undefined, value => {
      const cleaned = sanitizeStructureSkeletonEnvelope(value);
      if (isAssistance(cleaned)) return true;
      if (isSkeletonEnvelope(cleaned, input.brief)) return true;
      // 结构性违规逐项透出（部件数量/重名/未知引用/非法枚举等）；结构成立时再报告内容性问题（连通性/形状/运动）。
      const skeleton = (cleaned as { skeleton?: unknown } | null)?.skeleton;
      const structural = skeletonStructuralErrors(skeleton);
      const subjectIssues = isStructureSkeleton(skeleton) ? subjectErrors(skeleton, input.brief) : [];
      const issues = structural.length ? structural : subjectIssues.length ? subjectIssues : skeletonValidationErrors(skeleton);
      return ['结构骨架返回格式无效，必须只包含轻量部件、连接、运动和几何类别。', ...issues.slice(0, 4)];
    }, {
      attemptTimeoutMs: structureSkeletonAttemptTimeoutMs(config),
      lengthRetry: { prompt: skeletonLengthRetryPrompt, maxTokens: 4000 },
      validationRetry: {
        maxTokens: 4000,
        prompt: (details) => {
          const header = '结构骨架返回格式无效，必须只包含轻量部件、连接、运动和几何类别。';
          const issues = details.filter(detail => detail !== header);
          return `${skeletonPrompt}\n上一轮输出未通过确定性校验，只输出修正后的完整纯 JSON。逐项修复以下问题，保持文字简洁，保留主体、每个部件的形状和几何、连接及运动：\n- ${issues.length ? issues.join('\n- ') : '输出必须是通过校验的完整骨架 JSON。'}`;
        },
      },
      diagnostic: result => structureDiagnostic('skeleton', result, requestId),
    });
    if (isAssistance(result.value)) return { ...result.value, options: [], candidate: input.candidate };
    if (!isSkeletonEnvelope(result.value, input.brief)) throw new AiFailure(502, 'AI_INVALID_OUTPUT', 'AI 返回的结构骨架协议错误，未采用该结果；请重试。');
    if (result.value.skeleton.title !== input.candidate.name) throw new AiFailure(502, 'AI_INVALID_STRUCTURE', '结构骨架名称与已确认名称不一致，未采用该结果。');
    return { status: 'ready', skeleton: result.value.skeleton, candidate: input.candidate, source: patentStructureSource(input.brief, input.candidate), research, providerModel: result.model, generatedAt: new Date().toISOString() };
  } catch (error) {
    if (signal.aborted) throw new AiFailure(499, 'AI_CANCELLED', '已取消本次生成。');
    if (totalTimeout.aborted) throw new AiFailure(504, 'AI_TOTAL_TIMEOUT', '结构生成超过请求总时限，未修改原方案；请稍后重试。');
    if (error instanceof AiFailure && error.code === 'AI_ATTEMPT_TIMEOUT') throw new AiFailure(504, 'AI_MODEL_TIMEOUT', '结构骨架模型单次调用超时，未修改原方案；请稍后重试。');
    throw error;
  }
}
