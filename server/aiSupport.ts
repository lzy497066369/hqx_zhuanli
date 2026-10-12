import type { AIExecutionPolicy } from '../src/features/utility/aiExecutionPolicy.ts';
export { STRICT_E2E_POLICY } from '../src/features/utility/aiExecutionPolicy.ts';

export const AI_USER_AGENT = 'zhichuang-workshop/1.0';
export type AiConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  researchModel?: string;
  researchProtocol?: 'responses' | 'anthropic';
  fallbackModel?: string;
  fallbackBaseUrl?: string;
  fallbackApiKey?: string;
  secondFallbackModel?: string;
  secondFallbackBaseUrl?: string;
  secondFallbackApiKey?: string;
  timeoutMs?: number;
  workflowSigningKey?: string;
  image?: { baseUrl: string; apiKey: string; model: string; size?: string; timeoutMs?: number };
  /** 视觉理解模型：看四张彩色预览图编写 FreeCAD 脚本。缺省复用文本模型配置。 */
  vision?: { baseUrl: string; apiKey: string; model: string };
  /** FreeCAD 命令行程序路径与单次建模超时；缺省自动探测常见安装位置。 */
  freecad?: { command?: string; timeoutMs?: number };
  /** Only explicitly enabled E2E executions opt into this policy. Research ignores it. */
  executionPolicy?: AIExecutionPolicy;
};
export type AiProvider = { baseUrl: string; apiKey: string; model: string };

export function aiProviders(config: AiConfig, primaryModel = config.model): AiProvider[] {
  const providers = [
    { baseUrl: config.baseUrl, apiKey: config.apiKey, model: primaryModel },
    { baseUrl: config.fallbackBaseUrl || config.baseUrl, apiKey: config.fallbackApiKey || config.apiKey, model: config.fallbackModel || '' },
    { baseUrl: config.secondFallbackBaseUrl || config.baseUrl, apiKey: config.secondFallbackApiKey || config.apiKey, model: config.secondFallbackModel || '' },
  ];
  return providers.filter((provider, index, all) => provider.baseUrl && provider.apiKey && provider.model && all.findIndex(item => item.baseUrl === provider.baseUrl && item.apiKey === provider.apiKey && item.model === provider.model) === index);
}
/** Strict generation pins the configured primary, even when it is cooling down. */
export function generationProviders(config: AiConfig): AiProvider[] {
  if (config.executionPolicy) return [{ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model }];
  return availableProviders(aiProviders(config));
}
export class AiFailure extends Error {
  status: number;
  code: string;
  details: string[];
  constructor(status: number, code: string, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = [...new Set(details.filter(detail => typeof detail === 'string' && detail.trim()).map(detail => detail.trim().split('').map(character => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    }).join('').slice(0, 320)))].slice(0, 12);
  }
}

export async function responseText(response: Response, limit = 256 * 1024) {
  if (!response.body) throw new AiFailure(502, 'AI_EMPTY', 'AI 服务返回空内容，请稍后重试。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new AiFailure(502, 'AI_TOO_LARGE', 'AI 返回内容过长，请缩小技术方案范围后重试。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

// 失败 provider 熔断：短时间内失败过的 provider 进入冷却，后续请求直接跳过，
// 避免每个请求都先等故障 provider 超时一遍再切换。冷却只影响 provider 选择
// 顺序，不影响单次请求内的故障转移；全部冷却中时不跳过任何一个。
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
const providerCooldownUntil = new Map<string, number>();

function providerKey(provider: AiProvider): string {
  return `${provider.baseUrl}::${provider.model}`;
}

const COOLDOWN_CODES = new Set(['AI_AUTH', 'AI_RATE_LIMIT', 'AI_UPSTREAM', 'AI_NETWORK', 'AI_ATTEMPT_TIMEOUT']);

/**
 * 连接层故障：DNS、连接被重置、TLS、以及 Node 自带 undici 在 300 秒收不到响应头时抛的
 * `TypeError: fetch failed`（cause 为 UND_ERR_HEADERS_TIMEOUT）。它们都是普通 Error 而不是 AiFailure，
 * 属于可用性问题，应当切换备用 provider 并熔断，而不是整单失败。
 * SyntaxError 来自上游坏内容，AbortError 来自我们自己的取消或超时信号，都不算连接层故障。
 */
export function isTransientNetworkError(error: unknown): boolean {
  return error instanceof Error && !(error instanceof AiFailure) && !(error instanceof SyntaxError) && error.name !== 'AbortError';
}

export function shouldCoolDownProvider(error: unknown): boolean {
  if (error instanceof AiFailure) return COOLDOWN_CODES.has(error.code);
  return isTransientNetworkError(error);
}

/**
 * 单次 provider 尝试的超时上限。Node 22 自带 undici 对「无响应头」默认 300 秒就直接抛错，
 * 而我们的请求是 stream:false，模型生成完之前上游不会回任何响应头。
 * 如果单次尝试超时比 300 秒还长，先触发的是 undici，错误既不是 AI_ATTEMPT_TIMEOUT 也不会切换模型。
 * 所以均分后的超时必须封顶在 300 秒之前，留 30 秒余量。
 */
export const ATTEMPT_TIMEOUT_CAP_MS = 270_000;

export function attemptTimeoutMs(budgetMs: number, share: number, providerCount: number): number {
  return Math.min(ATTEMPT_TIMEOUT_CAP_MS, Math.max(1, Math.floor(budgetMs * share / Math.max(1, providerCount))));
}

export function availableProviders(providers: AiProvider[]): AiProvider[] {
  const now = Date.now();
  const fresh = providers.filter(provider => (providerCooldownUntil.get(providerKey(provider)) ?? 0) <= now);
  return fresh.length ? fresh : providers;
}

export function markProviderFailed(provider: AiProvider): void {
  providerCooldownUntil.set(providerKey(provider), Date.now() + PROVIDER_COOLDOWN_MS);
}

export function markProviderSucceeded(provider: AiProvider): void {
  providerCooldownUntil.delete(providerKey(provider));
}
