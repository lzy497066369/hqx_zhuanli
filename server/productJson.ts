import { AiFailure, attemptTimeoutMs, generationProviders } from './aiSupport.ts';
import type { AiConfig } from './aiSupport.ts';
import { chatJson } from './patentStructureAi.ts';
import type { ProgressReporter } from './patentStructureAi.ts';

export async function productJson<T>(prompt: string, input: unknown, config: AiConfig, signal: AbortSignal, fetcher: typeof fetch, accept: (value: unknown) => value is T, progress?: ProgressReporter, maxTokens = 9000, explain?: (value: unknown) => string[]): Promise<T> {
  // 文本生成总预算 600 秒。单次尝试上限按模型数均分（3 个模型时每个 190 秒）；
  // 之前的 210 秒均分后每个模型只有 66.5 秒，简介和申请文案这类长输出经常在此超时。
  // 前端 ProductWorkflowWorkspace.tsx 的等待时间（660 秒）必须长于这里。
  const timeoutMs = config.timeoutMs ?? 600000;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    // Text requests alone use a modest reasoning budget; image and CAD requests
    // still use their existing caller and options without this wrapper.
    const textFetcher: typeof fetch = (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (!config.executionPolicy && /^(?:gpt-[56](?:[.-]|$)|o[134](?:[-.]|$))/i.test(request.model)) request.reasoning_effort = 'low';
      return fetcher(url, { ...init, body: JSON.stringify(request) });
    };
    const combined = AbortSignal.any([signal, timeout]);
    let correction: { errors: string[]; previousOutput: unknown } | undefined;
    for (let round = 0; round < 2; round++) {
      if (correction) progress?.('修正校验问题', '保留上一轮结果，仅修正程序指出的格式或一致性问题');
      const system = correction ? `${prompt}\n本轮为程序发起的校验修正。correction.previousOutput为上轮结果，correction.errors为需修正项；保留正确内容，返回本阶段要求的完整JSON结果。复核阶段仍返回修改列表，不返回整篇或整套方案。` : prompt;
      const result = await chatJson(system, correction ? { ...(input as object), correction } : input, config, combined, textFetcher, maxTokens, undefined,
        value => accept(value) ? true : (explain?.(value) ?? ['返回的 JSON 不符合要求的结构。']),
        { attemptTimeoutMs: attemptTimeoutMs(timeoutMs, .95, generationProviders(config).length), onProgress: progress, stopOnInvalid: true });
      if (!result.invalid) return result.value as T;
      correction = { errors: result.invalid, previousOutput: result.value };
    }
    throw new AiFailure(502, 'AI_INVALID_OUTPUT', '模型两次返回的内容都没有通过格式校验，未采用该结果；请重试。', correction?.errors);
  } catch (error) {
    if (signal.aborted) throw new AiFailure(499, 'AI_CANCELLED', '已取消本次生成，已有成果仍保留。');
    if (timeout.aborted || (error instanceof AiFailure && error.code === 'AI_ATTEMPT_TIMEOUT')) throw new AiFailure(504, 'AI_TIMEOUT', '产品文本生成超时，请稍后重试。');
    if (error instanceof AiFailure && error.code === 'AI_INVALID_OUTPUT') throw new AiFailure(502, 'AI_INVALID_OUTPUT', '模型两次返回的内容都没有通过格式校验，未采用该结果；请重试。', error.details);
    if (error instanceof AiFailure) throw error;
    throw new AiFailure(502, 'AI_NETWORK', '文本模型连接失败，请稍后重试。');
  }
}
