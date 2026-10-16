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
  cadCheckpointDir?: string | false;
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

/** Bound waiting independently of a transport's own abort implementation. */
export function awaitWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(value => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
    if (signal.aborted) onAbort();
  });
}

function bodyReader(response: Response, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!response.body) throw new AiFailure(502, 'AI_EMPTY', 'AI 服务返回空内容，请稍后重试。');
  const reader = response.body.getReader();
  // Some gateways/tee streams never acknowledge cancellation. Request it, but
  // never await that acknowledgement on the generation/fallback critical path.
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  return {
    read: () => { signal?.throwIfAborted(); return awaitWithSignal(reader.read(), signal); },
    close: () => { signal?.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch { /* A cancelled read may still be settling. */ } },
  };
}

export async function responseText(response: Response, limit = 256 * 1024, signal?: AbortSignal) {
  if (!response.body) throw new AiFailure(502, 'AI_EMPTY', 'AI 服务返回空内容，请稍后重试。');
  const reader = bodyReader(response, signal);
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
  } finally { reader.close(); }
  return Buffer.concat(chunks).toString('utf8');
}

export type ChatChoice = { finish_reason?: string; message?: { content?: unknown; refusal?: unknown } };
const CHAT_CONTENT_LIMIT = 256 * 1024;
const CHAT_STREAM_RAW_LIMIT = 16 * 1024 * 1024;

/**
 * 读取 chat/completions 响应，统一成非流式的 choice 形状。
 * 为什么要流式：实测中转站对"长时间没有任何响应字节"的连接约 125 秒就主动关闭（other side closed），
 * 而非流式请求在模型生成完之前上游一个字节都不发，长文必死；流式下 2 秒就有响应头、生成期间持续有数据，
 * 同一请求 156 秒完整返回。SSE 里把 delta.content / delta.refusal 拼回去，finish_reason 取最后一个非空值。
 * 上游若忽略 stream 直接回 JSON，也按原来的方式解析。
 */
export async function readChatChoice(response: Response, onUsage?: (usage: unknown) => void, signal?: AbortSignal): Promise<ChatChoice | undefined> {
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('text/event-stream')) {
    const envelope = JSON.parse(await responseText(response, CHAT_CONTENT_LIMIT, signal)) as { choices?: ChatChoice[]; usage?: unknown } | null;
    if (envelope?.usage) onUsage?.(envelope.usage);
    return envelope?.choices?.[0];
  }
  if (!response.body) throw new AiFailure(502, 'AI_EMPTY', 'AI 服务返回空内容，请稍后重试。');
  const reader = bodyReader(response, signal);
  const decoder = new TextDecoder();
  let buffer = '', content = '', refusal = '', rawSize = 0, sawChoice = false, complete = false;
  let finishReason: string | undefined;
  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { complete = true; return; }
    if (!data) return;
    let chunk: { error?: unknown; usage?: unknown; choices?: { delta?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }[] } | null;
    try { chunk = JSON.parse(data); } catch { throw new AiFailure(502, 'AI_INVALID_JSON', 'AI 流式返回格式不正确，未采用该结果；请稍后重试。'); }
    if (chunk?.error) throw new AiFailure(502, 'AI_UPSTREAM', 'AI 服务调用失败，请检查服务状态、模型配置或稍后重试。');
    if (chunk?.usage) onUsage?.(chunk.usage);
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    sawChoice = true;
    if (typeof choice.delta?.content === 'string') content += choice.delta.content;
    if (typeof choice.delta?.refusal === 'string') refusal += choice.delta.refusal;
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
    if (content.length > CHAT_CONTENT_LIMIT) throw new AiFailure(502, 'AI_TOO_LARGE', 'AI 返回内容过长，请缩小技术方案范围后重试。');
  };
  try {
    while (!complete) {
      const { value, done } = await reader.read();
      if (done) break;
      rawSize += value.length;
      if (rawSize > CHAT_STREAM_RAW_LIMIT) throw new AiFailure(502, 'AI_TOO_LARGE', 'AI 返回内容过长，请缩小技术方案范围后重试。');
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) { handleLine(line); if (complete) break; }
    }
    buffer += decoder.decode();
    if (!complete && buffer.trim()) handleLine(buffer);
  } finally { reader.close(); }
  if (!sawChoice) throw new AiFailure(502, 'AI_EMPTY', 'AI 服务返回空内容，请稍后重试。');
  return { finish_reason: finishReason, message: { content, ...(refusal ? { refusal } : {}) } };
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
