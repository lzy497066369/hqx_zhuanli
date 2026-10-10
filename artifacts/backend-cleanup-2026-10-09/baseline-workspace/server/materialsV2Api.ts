/**
 * 专利文档生成V2 API接口
 *
 * 提供HTTP接口供前端调用新的多阶段生成流程
 */

import { getModelVersion, isPatentStructureModel } from '../src/features/utility/patentStructure.ts';
import { isEvidencePackage, validateEvidenceReferences } from '../src/features/utility/patentEvidence.ts';
import { generateClaimPlan, type PatentGenerationContext } from '../src/features/utility/claimPlan.ts';
import type { ReasoningPackage } from '../src/features/utility/patentReasoning.ts';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning.ts';
import type { AiConfig } from './aiSupport.ts';
import { generatePatentDocument, type GenerationOptions, type ValidatedDocument } from './documentGenerationV2.ts';
import { generateValidationReport } from './documentValidator.ts';
import type { UtilityMaterials } from '../src/data.ts';
import { sanitizeFinalPatentDocument } from '../src/features/utility/finalDocumentSanitizer.ts';
import { validatePatentDocument } from '../src/features/utility/patentValidator.ts';
import { assertGenerationProof } from '../src/features/utility/patentPackage.ts';

export const MATERIALS_V2_PATH = '/api/utility/materials-v2';
export const MATERIALS_V2_STATUS_PATH = '/api/utility/materials-v2/status';

type JsonResponse = {
  status(code: number): JsonResponse;
  json(value: unknown): void;
};

type JsonRequest = {
  body: unknown;
  params: Record<string, string | undefined>;
};

type ExpressLike = {
  post(path: string, handler: (req: JsonRequest, res: JsonResponse) => void | Promise<void>): void;
  get(path: string, handler: (req: JsonRequest, res: JsonResponse) => void | Promise<void>): void;
  delete(path: string, handler: (req: JsonRequest, res: JsonResponse) => void | Promise<void>): void;
};

function readAiConfig(env: Record<string, string | undefined>): AiConfig {
  return {
    baseUrl: (env.AI_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: env.AI_API_KEY || '',
    model: env.AI_MODEL || '',
    researchModel: env.AI_RESEARCH_MODEL || env.AI_MODEL || '',
    fallbackModel: env.AI_FALLBACK_MODEL || '',
    fallbackBaseUrl: (env.AI_FALLBACK_BASE_URL || '').replace(/\/+$/, ''),
    fallbackApiKey: env.AI_FALLBACK_API_KEY || '',
    secondFallbackModel: env.AI_SECOND_FALLBACK_MODEL || '',
    secondFallbackBaseUrl: (env.AI_SECOND_FALLBACK_BASE_URL || '').replace(/\/+$/, ''),
    secondFallbackApiKey: env.AI_SECOND_FALLBACK_API_KEY || '',
  };
}

// 存储生成任务的状态
const generationTasks = new Map<string, {
  status: 'running' | 'completed' | 'failed';
  progress: number;
  message: string;
  result?: ValidatedDocument;
  materials?: UtilityMaterials;
  error?: string;
  startedAt: string;
}>();

const isNonEmptyString = (value: unknown, maxLength: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

const isStringArray = (value: unknown, maxItems: number, maxLength: number) =>
  Array.isArray(value) && value.length <= maxItems && value.every(item => isNonEmptyString(item, maxLength));

function isReasoningPackage(value: unknown): value is ReasoningPackage {
  if (!value || typeof value !== 'object') return false;
  const reasoning = value as ReasoningPackage;
  if (reasoning.version !== 1 || !isNonEmptyString(reasoning.modelVersion, 120) ||
      !isNonEmptyString(reasoning.technicalProblem, 3000) ||
      !isNonEmptyString(reasoning.problemCause, 3000) ||
      reasoning.problemCauseStatus !== 'INFERRED' ||
      !isStringArray(reasoning.priorArtEvidenceRefs, 20, 20) ||
      !isStringArray(reasoning.solutionFeatures, 30, 1000) ||
      !isStringArray(reasoning.structuralMechanism, 30, 1500) ||
      !isStringArray(reasoning.workingSteps, 50, 1500) ||
      !isStringArray(reasoning.technicalEffects, 50, 1500) ||
      !Array.isArray(reasoning.priorArtRelations) || reasoning.priorArtRelations.length > 1500 ||
      !Array.isArray(reasoning.effects) || reasoning.effects.length > 50 ||
      !reasoning.effects.every(effect => !!effect && typeof effect === 'object' &&
        effect.status === 'SUPPORTED' && isStringArray(effect.reasoningChainIds, 80, 20) && effect.reasoningChainIds.length > 0 &&
        isNonEmptyString(effect.effectId, 80) && isNonEmptyString(effect.statement, 1500) &&
        isStringArray(effect.componentIds, 80, 20) && isStringArray(effect.relationIds, 120, 20) &&
        isStringArray(effect.motionIds, 80, 20) && isStringArray(effect.evidenceRefs, 150, 20)) ||
      !isStringArray(reasoning.evidenceRefs, 150, 20) ||
      !isStringArray(reasoning.componentRefs, 80, 20) ||
      !isStringArray(reasoning.relationRefs, 120, 20) ||
      !isStringArray(reasoning.motionRefs, 80, 20) ||
      typeof reasoning.confidence !== 'number' || reasoning.confidence < 0 || reasoning.confidence > 1 ||
      !Array.isArray(reasoning.chains) || reasoning.chains.length > 80) return false;

  return reasoning.chains.every(chain => !!chain && typeof chain === 'object' &&
    isNonEmptyString(chain.id, 20) && /^CHAIN-C\d{2,3}$/u.test(chain.id) &&
    isStringArray(chain.causeEvidenceRefs, 150, 20) && isStringArray(chain.solutionFeatureIds, 240, 20) &&
    isStringArray(chain.priorArtRelationIds, 20, 20) &&
    isNonEmptyString(chain.featureId, 20) &&
    ['SUPPORTED', 'ORPHAN_FEATURE', 'UNSUPPORTED'].includes(chain.status) &&
    isNonEmptyString(chain.technicalProblem, 3000) &&
    isNonEmptyString(chain.problemCause, 3000) &&
    chain.problemCauseStatus === 'INFERRED' &&
    isStringArray(chain.priorArtEvidenceRefs, 20, 20) &&
    isStringArray(chain.solutionFeatures, 30, 1000) &&
    typeof chain.structuralMechanism === 'string' && chain.structuralMechanism.length <= 2000 &&
    isStringArray(chain.workingSteps, 50, 1500) &&
    isStringArray(chain.technicalEffects, 50, 1500) &&
    isStringArray(chain.effectIds, 50, 80) &&
    isStringArray(chain.evidenceRefs, 40, 20) &&
    isStringArray(chain.componentRefs, 40, 20) &&
    isStringArray(chain.relationRefs, 40, 20) &&
    isStringArray(chain.motionRefs, 40, 20) &&
    typeof chain.confidence === 'number' && chain.confidence >= 0 && chain.confidence <= 1);
}

function isClaimPlan(value: unknown): value is PatentGenerationContext['claimPlan'] {
  if (!value || typeof value !== 'object') return false;
  const plan = value as PatentGenerationContext['claimPlan'];
  if (plan.version !== 1 || !isNonEmptyString(plan.modelVersion, 120) ||
      !Array.isArray(plan.claims) || plan.claims.length === 0 || plan.claims.length > 30) return false;
  const claimNumbers = new Set<number>();
  return plan.claims.every(claim => {
    if (!claim || typeof claim !== 'object' || !Number.isInteger(claim.claimNo) || claim.claimNo < 1 ||
        claimNumbers.has(claim.claimNo) ||
        (claim.parentClaimNo !== undefined && (!Number.isInteger(claim.parentClaimNo) || claim.parentClaimNo < 1 || claim.parentClaimNo >= claim.claimNo)) ||
        !isNonEmptyString(claim.purpose, 3000) || !isStringArray(claim.componentIds, 80, 20) || !isStringArray(claim.connectionIds, 120, 20) ||
        !isStringArray(claim.motionIds, 80, 20) || !isStringArray(claim.evidenceRefs, 80, 20)) return false;
    claimNumbers.add(claim.claimNo);
    return true;
  });
}

function validateGenerationContext(value: unknown): { context?: PatentGenerationContext; message?: string } {
  if (!value || typeof value !== 'object') return { message: '缺少生成上下文' };
  const context = value as Partial<PatentGenerationContext>;
  if (!isPatentStructureModel(context.model)) return { message: '结构模型格式无效' };
  if (!isEvidencePackage(context.evidence)) return { message: '证据包格式无效' };
  if (!isReasoningPackage(context.reasoning)) return { message: '推理包格式无效' };
  if (!isClaimPlan(context.claimPlan)) return { message: '权利要求规划格式无效' };
  const modelVersion = getModelVersion(context.model);
  if (context.evidence.modelVersion !== modelVersion ||
      context.reasoning.modelVersion !== modelVersion ||
      context.claimPlan.modelVersion !== modelVersion) {
    return { message: '生成上下文的结构版本不一致' };
  }
  const evidenceErrors = validateEvidenceReferences(context.model, context.evidence);
  if (evidenceErrors.length > 0) return { message: `证据关联无效：${evidenceErrors.join('；')}` };
  if (context.evidence.items.some(item => item.status === 'CONFLICT')) {
    return { message: '证据包包含未解决的事实冲突' };
  }
  try {
    if (JSON.stringify(context.reasoning) !== JSON.stringify(buildReasoningPackage(context.model, context.evidence)) ||
        JSON.stringify(context.claimPlan) !== JSON.stringify(generateClaimPlan(context.model, context.evidence, context.reasoning))) {
      return { message: '推理或权利要求规划与当前证据和结构不一致' };
    }
  } catch (error) {
    return { message: error instanceof Error ? error.message : '生成上下文校验失败' };
  }

  return { context: context as PatentGenerationContext };
}

function parseGenerationRequest(body: unknown): { context?: PatentGenerationContext; patentType?: 'utility' | 'invention'; options?: GenerationOptions; message?: string } {
  if (!body || typeof body !== 'object') return { message: '请求体格式无效' };
  const payload = body as { context?: unknown; model?: unknown; patentType?: unknown; options?: unknown };
  if (payload.model !== undefined) return { message: '不再接受裸结构模型，请提交完整生成上下文' };
  if (payload.patentType !== 'utility' && payload.patentType !== 'invention') return { message: '请明确指定有效的专利类型' };
  const validated = validateGenerationContext(payload.context);
  if (!validated.context) return { message: validated.message };
  return { context: validated.context, patentType: payload.patentType, options: payload.options as GenerationOptions | undefined };
}

/**
 * 注册API路由
 */
export function registerMaterialsV2Api(app: ExpressLike) {
  // 启动生成任务
  app.post(MATERIALS_V2_PATH, async (req, res) => {
    try {
      const parsed = parseGenerationRequest(req.body);
      if (!parsed.context) {
        res.status(400).json({ error: 'INVALID_INPUT', message: parsed.message || '生成上下文无效' });
        return;
      }

      // 生成任务ID
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // 初始化任务状态
      generationTasks.set(taskId, {
        status: 'running',
        progress: 0,
        message: '开始生成文档...',
        startedAt: new Date().toISOString(),
      });

      // 异步执行生成任务
      const config = readAiConfig(process.env);
      const controller = new AbortController();

      generatePatentDocument(
        parsed.context,
        config,
        controller.signal,
        {
          ...parsed.options,
          onProgress: (progress) => {
            const task = generationTasks.get(taskId);
            if (task) {
              task.progress = progress.progress;
              task.message = progress.message;
            }
          },
        }
      )
        .then((result) => {
          const task = generationTasks.get(taskId);
          if (task) {
            finishTask(task, result, parsed.context!, parsed.patentType!);
          }
        })
        .catch((error) => {
          const task = generationTasks.get(taskId);
          if (task) {
            task.status = 'failed';
            task.error = error instanceof Error ? error.message : String(error);
            task.message = '文档生成失败';
          }
        });

      // 返回任务ID
      res.json({ taskId });
    } catch (error) {
      console.error('Failed to start document generation:', error);
      res.status(500).json({
        error: 'GENERATION_FAILED',
        message: error instanceof Error ? error.message : '生成任务启动失败',
      });
    }
  });

  // 查询生成任务状态
  app.get(`${MATERIALS_V2_STATUS_PATH}/:taskId`, (req, res) => {
    const { taskId } = req.params;
    if (!taskId) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: '缺少任务ID' });
      return;
    }
    const task = generationTasks.get(taskId);

    if (!task) {
      res.status(404).json({ error: 'TASK_NOT_FOUND', message: '任务不存在' });
      return;
    }

    if (task.status === 'completed' && task.result) {
      // 返回完整结果
      res.json({
        status: 'completed',
        progress: 100,
        message: task.message,
        result: task.result,
        materials: task.materials,
        report: generateValidationReport(task.result),
      });
    } else if (task.status === 'failed') {
      res.json({
        status: 'failed',
        progress: task.progress,
        message: task.message,
        error: task.error,
      });
    } else {
      // 返回进度
      res.json({
        status: 'running',
        progress: task.progress,
        message: task.message,
      });
    }
  });

  // 取消生成任务（预留接口）
  app.delete(`${MATERIALS_V2_STATUS_PATH}/:taskId`, (req, res) => {
    const { taskId } = req.params;
    if (!taskId) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: '缺少任务ID' });
      return;
    }
    const task = generationTasks.get(taskId);

    if (!task) {
      res.status(404).json({ error: 'TASK_NOT_FOUND', message: '任务不存在' });
      return;
    }

    if (task.status === 'running') {
      // TODO: 实现取消逻辑（需要保存AbortController）
      res.json({ message: '取消功能待实现' });
    } else {
      res.json({ message: '任务已结束，无需取消' });
    }
  });

  // 清理过期任务（每小时清理一次）
  setInterval(() => {
    const now = Date.now();
    for (const [taskId, task] of generationTasks.entries()) {
      const age = now - new Date(task.startedAt).getTime();
      // 清理1小时前的任务
      if (age > 3600000) {
        generationTasks.delete(taskId);
      }
    }
  }, 3600000);
}

/**
 * 转换V2文档为V1格式（兼容现有Word导出）
 */
export function convertV2ToV1Materials(validated: ValidatedDocument, context: PatentGenerationContext): UtilityMaterials {
  if (!validated.readyForExport || validated.validationIssues.some(issue => issue.severity === 'error')) {
    throw new Error('最终校验未通过，禁止生成正式材料');
  }
  const doc = validated.document;

  const materials: UtilityMaterials = {
    version: 1,
    sourceModelVersion: getModelVersion(context.model),
    generationSource: 'materials-v2',
    generationProof: validated.generationProof,
    generatedAt: doc.polishedAt,
    abstract: doc.abstract,
    claims: doc.claims.join('\n'),
    technicalField: doc.technicalField,
    background: doc.background,
    content: doc.content,
    drawings: doc.drawings,
    embodiment: doc.embodiment,
    claimReferences: doc.claimReferences,
  };
  assertGenerationProof(materials, context);
  return materials;
}

function finishTask(task: (typeof generationTasks extends Map<string, infer T> ? T : never), result: ValidatedDocument, context: PatentGenerationContext, patentType: 'utility' | 'invention') {
  if (!result.readyForExport || result.validationIssues.some(issue => issue.severity === 'error')) {
    task.status = 'failed';
    task.message = '最终校验未通过';
    task.error = result.validationIssues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('；') || '最终校验未通过';
    return;
  }
  const materials = convertV2ToV1Materials(result, context);
  const document = sanitizeFinalPatentDocument(context.model.productTitle, context.model, materials, patentType, true);
  const report = validatePatentDocument({ context, document, claimReferences: materials.claimReferences,
    sourceModelVersion: materials.sourceModelVersion });
  if (!report.readyForExport) {
    task.status = 'failed';
    task.message = '最终导出文本校验未通过';
    task.error = report.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('；');
    return;
  }
  task.materials = materials;
  task.result = result;
  task.status = 'completed';
  task.progress = 100;
  task.message = '文档生成完成';
}

/**
 * Vite中间件处理函数
 */
export async function handleMaterialsV2Request(
  url: string,
  method: string,
  body: any,
  config: AiConfig,
  signal?: AbortSignal,
  progress?: (update: { progress: number; message: string }) => void
): Promise<{ status: number; body: any }> {
  // POST /api/utility/materials-v2 - 启动生成任务
  if (method === 'POST' && url === MATERIALS_V2_PATH) {
    try {
      const parsed = parseGenerationRequest(body);
      if (!parsed.context) return { status: 400, body: { error: 'INVALID_INPUT', message: parsed.message || '生成上下文无效' } };

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      generationTasks.set(taskId, {
        status: 'running',
        progress: 0,
        message: '开始生成文档...',
        startedAt: new Date().toISOString(),
      });

      const controller = new AbortController();
      if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

      generatePatentDocument(
        parsed.context,
        config,
        controller.signal,
        {
          ...parsed.options,
          onProgress: (update) => {
            const task = generationTasks.get(taskId);
            if (task) {
              task.progress = update.progress;
              task.message = update.message;
            }
            progress?.(update);
          },
        }
      )
        .then((result) => {
          const task = generationTasks.get(taskId);
          if (task) {
            finishTask(task, result, parsed.context!, parsed.patentType!);
          }
        })
        .catch((error) => {
          const task = generationTasks.get(taskId);
          if (task) {
            task.status = 'failed';
            task.error = error instanceof Error ? error.message : String(error);
            task.message = '文档生成失败';
          }
        });

      return { status: 200, body: { taskId } };
    } catch (error) {
      console.error('Failed to start document generation:', error);
      return {
        status: 500,
        body: {
          error: 'GENERATION_FAILED',
          message: error instanceof Error ? error.message : '生成任务启动失败',
        }
      };
    }
  }

  // GET /api/utility/materials-v2/status/:taskId - 查询任务状态
  if (method === 'GET' && url.startsWith(MATERIALS_V2_STATUS_PATH)) {
    const taskId = url.split('/').pop();
    if (!taskId) {
      return { status: 400, body: { error: 'INVALID_REQUEST', message: '缺少任务ID' } };
    }

    const task = generationTasks.get(taskId);
    if (!task) {
      return { status: 404, body: { error: 'TASK_NOT_FOUND', message: '任务不存在' } };
    }

    if (task.status === 'completed' && task.result) {
      return {
        status: 200,
        body: {
          status: 'completed',
          progress: 100,
          message: task.message,
          result: task.result,
          materials: task.materials,
          report: generateValidationReport(task.result),
        }
      };
    } else if (task.status === 'failed') {
      return {
        status: 200,
        body: {
          status: 'failed',
          progress: task.progress,
          message: task.message,
          error: task.error,
        }
      };
    } else {
      return {
        status: 200,
        body: {
          status: 'running',
          progress: task.progress,
          message: task.message,
        }
      };
    }
  }

  return { status: 404, body: { error: 'NOT_FOUND', message: '接口不存在' } };
}
