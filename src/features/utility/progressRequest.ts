import { STRICT_E2E_POLICY } from './aiExecutionPolicy';
import type { ProgressStep } from './generationProgress';
import { workspaceHeaders } from '../../storage/workspaceContext';
import { isTokenUsage } from '../product/tokenUsage';
import type { TokenUsage } from '../product/tokenUsage';

type StreamEvent = { type: 'progress'; step: ProgressStep } | { type: 'usage'; usage: unknown } | { type: 'result'; data: unknown } | { type: 'error'; error: { code?: string; message?: string; details?: string[] } };

export async function progressRequest<T>(path: string, body: unknown, onProgress: (step: ProgressStep) => void, signal?: AbortSignal, headers: Record<string, string> = {}, onUsage?: (usage: TokenUsage) => void): Promise<{ data: T; requestId?: string }> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...workspaceHeaders(), ...headers }, body: JSON.stringify(body), signal });
  const requestId = response.headers.get('X-Structure-Request-Id') || undefined;
  if (response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
    // 带 code 与 requestId 抛出：调用方据此渲染具体原因和诊断编号，而不是回退到泛化文案。
    if (!response.body) throw Object.assign(new Error('进度连接中断，请重试。'), { code: 'STREAM_INTERRUPTED', requestId });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let result: T | undefined;
    const consume = (line: string) => {
      if (!line) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        throw Object.assign(new Error('进度数据解析失败，未修改已有成果；请重试。'), { code: 'STREAM_PARSE_ERROR', requestId });
      }
      if (event.type === 'progress' && typeof event.step?.label === 'string' && typeof event.step?.detail === 'string') onProgress(event.step);
      if (event.type === 'usage' && isTokenUsage(event.usage)) onUsage?.(event.usage);
      if (event.type === 'error') throw Object.assign(new Error(event.error.message || '生成暂时不可用，请重试。'), { code: event.error.code, details: event.error.details, requestId });
      if (event.type === 'result') result = event.data as T;
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let end = pending.indexOf('\n');
        while (end !== -1) { consume(pending.slice(0, end)); pending = pending.slice(end + 1); end = pending.indexOf('\n'); }
        if (done) break;
      }
      consume(pending);
    } finally { reader.releaseLock(); }
    if (result === undefined) throw Object.assign(new Error('进度连接中断，未收到完整结果；请重试。'), { code: 'STREAM_INTERRUPTED', requestId });
    return { data: result, requestId };
  }
  const usageHeader = response.headers.get('X-AI-Token-Usage');
  if (usageHeader) {
    let records: unknown;
    try { records = JSON.parse(decodeURIComponent(usageHeader)); } catch { /* Missing usage must not block a usable result. */ }
    if (Array.isArray(records)) for (const record of records) if (isTokenUsage(record)) onUsage?.(record);
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error?.message || '生成暂时不可用，请重试。'), { code: value.error?.code, details: value.error?.details, requestId });
  return { data: value as T, requestId };
}

/**
 * 明确可恢复的 AI 错误码：限流、超时、网络抖动。鉴权失败、输入无效、
 * 内容校验问题不在此列，重试没有意义。
 */
const RETRYABLE_AI_ERROR_CODES = new Set([
  'LOCAL_RATE_LIMIT',
  'AI_RATE_LIMIT',
  'AI_TIMEOUT',
  'AI_ATTEMPT_TIMEOUT',
  'AI_MODEL_TIMEOUT',
  'AI_TOTAL_TIMEOUT',
  'AI_NETWORK',
  'AI_UPSTREAM',
]);

export function isRetryableAiError(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_AI_ERROR_CODES.has(code);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消本次请求', 'AbortError')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('已取消本次请求', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type AiRetryOptions = {
  maxAttempts?: 1 | 2;
  signal?: AbortSignal;
  /** 触发重试前等待的毫秒数，默认 5000。 */
  retryDelayMs?: number;
  /**
   * 每次尝试的独立超时（毫秒）。超时会被标记为 AI_ATTEMPT_TIMEOUT 并自动
   * 重试一次；用户主动取消（signal 中止）不会重试。
   */
  attemptTimeoutMs?: number;
  /** 即将自动重试时回调，用于提示用户。 */
  onRetry?: (code: string | undefined) => void;
};

/**
 * 对限流/超时类错误自动退避重试一次。signal 已中止或遇到不可重试
 * 的错误时直接抛出，不做重试。客户端超时用 attemptTimeoutMs 实现：
 * 每次尝试拥有独立计时器，不会因为一次超时耗尽整轮重试。
 */
export async function withAiRetry<T>(task: (signal?: AbortSignal) => Promise<T>, options: AiRetryOptions = {}): Promise<T> {
  const { signal, retryDelayMs = 5000, attemptTimeoutMs, onRetry } = options;
  const maxAttempts = import.meta.env?.STRICT_AI_E2E ? STRICT_E2E_POLICY.maxAttempts : options.maxAttempts ?? 2;
  const runAttempt = async (): Promise<T> => {
    if (!attemptTimeoutMs) return task(signal);
    if (signal?.aborted) throw new DOMException('已取消本次请求', 'AbortError');
    const attempt = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; attempt.abort(new DOMException('请求超时', 'TimeoutError')); }, attemptTimeoutMs);
    const onUserAbort = () => attempt.abort(signal!.reason);
    signal?.addEventListener('abort', onUserAbort, { once: true });
    try {
      return await task(signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal);
    } catch (cause) {
      // 客户端单次尝试超时：包装为可重试的 AI_ATTEMPT_TIMEOUT，让外层退避重试。
      // 不直接在 cause 上 Object.assign：DOMException 等对象的 code 可能是只读
      // 的，严格模式下直接赋值会抛 TypeError；新建普通 Error 也避免污染共享的错误对象。
      if (timedOut && !signal?.aborted) {
        throw Object.assign(
          new Error(cause instanceof Error ? cause.message : String(cause), { cause }),
          { code: 'AI_ATTEMPT_TIMEOUT' },
        );
      }
      throw cause;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onUserAbort);
    }
  };
  try {
    return await runAttempt();
  } catch (cause) {
    if (maxAttempts === 1 || signal?.aborted || !isRetryableAiError(cause)) throw cause;
    const code = (cause as { code?: unknown } | null)?.code;
    onRetry?.(typeof code === 'string' ? code : undefined);
    await abortableSleep(retryDelayMs, signal);
    return await runAttempt();
  }
}
