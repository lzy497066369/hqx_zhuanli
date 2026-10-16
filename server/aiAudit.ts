import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AiLog } from '../src/features/admin/types.ts';
import { normalizeTokenUsage } from '../src/features/product/tokenUsage.ts';

export type AuditContext = { requestId: string; userId: string; username: string; workspaceId?: string; route: string; clientIp: string; userAgent: string; clientStreaming: boolean; write: (log: AiLog) => Promise<void> };
const context = new AsyncLocalStorage<AuditContext>();
export function withAiAudit<T>(value: AuditContext, operation: () => T): T { return context.run(value, operation); }
const LIMIT = 16 * 1024 * 1024;
const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|.*api[-_]?key|password|.*secret|access_token|refresh_token)$/i;
export function redactAudit(value: unknown): unknown {
  if (typeof value === 'string' && /^data:[^;,]+;base64,/i.test(value)) return `[二进制数据，${value.length} 字符]`;
  if (Array.isArray(value)) return value.map(redactAudit);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[已隐藏]' : /^(b64_json|base64|image_base64)$/i.test(key) && typeof item === 'string' ? `[二进制数据，${item.length} 字符]` : redactAudit(item)]));
  return value;
}
function requestBody(body: RequestInit['body']): unknown {
  if (typeof body === 'string') { try { return redactAudit(JSON.parse(body)); } catch { return body; } }
  if (body instanceof FormData) return redactAudit(Object.fromEntries([...body.entries()].map(([key, item]) => [key, typeof item === 'string' ? item : { fileName: item.name, mimeType: item.type, bytes: item.size }])));
  return body ? '[二进制请求体]' : null;
}
function safeUrl(input: string): string { const url = new URL(input); url.username = ''; url.password = ''; url.search = ''; return url.toString(); }
const wrappers = new WeakMap<typeof fetch, typeof fetch>();
const outcomes = new WeakMap<Response, (error: unknown) => Promise<void>>();
export function markAiResponseFailure(response: Response | undefined, error: unknown) { return response ? outcomes.get(response)?.(error) : undefined; }
/** Observe the very same bytes the caller reads; never tee or drain a second stream. */
export function auditedFetch(fetcher: typeof fetch): typeof fetch {
  const cached = wrappers.get(fetcher); if (cached) return cached;
  const wrapped: typeof fetch = async (input, init) => {
    const scope = context.getStore();
    if (!scope) return fetcher(input, init);
    const started = performance.now(), startedAt = new Date().toISOString();
    const body = requestBody(init?.body), params = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    if (!params.model) return fetcher(input, init);
    const log: AiLog = { id: randomUUID(), requestId: scope.requestId, userId: scope.userId, workspaceId: scope.workspaceId || null,
      route: scope.route, model: String(params.model || ''), provider: safeUrl(String(input instanceof Request ? input.url : input)), startedAt, finishedAt: null,
      status: 'running', streaming: params.stream === true, httpStatus: null, durationMs: null, firstTokenMs: null, inputTokens: null, outputTokens: null, totalTokens: null,
      details: { request: body, username: scope.username, method: init?.method || 'GET', clientIp: scope.clientIp, userAgent: scope.userAgent, clientStreaming: scope.clientStreaming } };
    let chain = Promise.resolve();
    const save = () => { const snapshot = structuredClone(log); chain = chain.then(() => scope.write(snapshot)).catch(() => { console.error('AI audit persistence failed', log.id); }); return chain; };
    await save();
    let finished = false, raw = '', pending = '', output = '', bytes = 0, lastToken: number | null = null, sawTerminal = false, sawOutput = false, protocol = '', usage: Record<string, unknown> = {};
    const signal = init?.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const elapsed = () => Math.round(performance.now() - started);
    const observe = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const event = value as Record<string, any>;
      const envelope = event.response || event;
      if (envelope.usage) { usage = { ...usage, ...envelope.usage }; log.details!.usage = usage; Object.assign(log, normalizeTokenUsage(usage)); }
      if (event.message?.usage) { usage = { ...usage, ...event.message.usage }; log.details!.usage = usage; Object.assign(log, normalizeTokenUsage(usage)); }
      if (envelope.id) log.details!.providerRequestId = envelope.id;
      if (envelope.model) log.details!.responseModel = envelope.model;
      if (event.error || envelope.error || event.type === 'error' || ['failed', 'incomplete'].includes(envelope.status)) log.details!.error = redactAudit(event.error || envelope.error || event);
      for (const choice of event.choices || []) {
        if (choice.finish_reason) { sawTerminal = true; log.details!.finishReason = choice.finish_reason; if (!['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason)) log.details!.error = `finish_reason: ${choice.finish_reason}`; }
        const text = choice.delta?.content || choice.delta?.refusal || choice.delta?.reasoning_content;
        if (typeof text === 'string' && text) { sawOutput = true; log.firstTokenMs ??= elapsed(); lastToken = elapsed(); if (output.length < LIMIT) output += text; }
        if (choice.message?.refusal || choice.delta?.refusal) log.details!.error = choice.message?.refusal || choice.delta.refusal;
      }
      const delta = event.delta?.text || (typeof event.delta === 'string' && /\.delta$/.test(event.type || '') ? event.delta : '');
      if (delta) { sawOutput = true; log.firstTokenMs ??= elapsed(); lastToken = elapsed(); if (output.length < LIMIT) output += delta; }
      if (['response.completed', 'message_stop'].includes(event.type)) sawTerminal = true;
    };
    const line = (value: string) => {
      if (!value.startsWith('data:')) { if (raw.length < LIMIT) raw += `${value}\n`.slice(0,LIMIT-raw.length); return; }
      const data = value.slice(5).trim();
      if (!data || data === '[DONE]') { if (raw.length < LIMIT) raw += `${value}\n`.slice(0,LIMIT-raw.length); return; }
      try { const parsed = JSON.parse(data); observe(parsed); if (raw.length < LIMIT) raw += `data: ${JSON.stringify(redactAudit(parsed))}\n`.slice(0,LIMIT-raw.length); }
      catch { log.details!.error = '流式响应包含无效 JSON'; if (raw.length < LIMIT) raw += `${value}\n`.slice(0,LIMIT-raw.length); }
    };
    const finish = async (failure?: unknown, cancelled = false) => {
      if (finished) return; finished = true;
      signal?.removeEventListener('abort', abort);
      if (protocol === 'sse') { if (pending.trim()) line(pending); log.details!.output = output; log.details!.response = raw; if (!sawTerminal && !failure) failure = new Error('流式响应未完整结束'); }
      else if (raw) { try { const value = JSON.parse(raw); observe(value); log.details!.response = redactAudit(value); } catch { log.details!.response = raw; if (bytes <= LIMIT && !failure && log.httpStatus && log.httpStatus < 400) failure = new Error('AI 响应不是有效 JSON'); } }
      log.finishedAt = new Date().toISOString(); log.durationMs = elapsed();
      log.details!.outputMs = log.firstTokenMs !== null && lastToken !== null ? Math.max(0, lastToken - log.firstTokenMs) : null;
      log.details!.responseBytes = bytes; log.details!.responseTruncated = bytes > LIMIT;
      if (failure) log.details!.error = redactAudit(failure instanceof Error ? { name: failure.name, message: failure.message } : String(failure));
      log.status = log.httpStatus !== null && log.httpStatus >= 400 ? 'failed' : cancelled && !sawTerminal ? 'cancelled' : failure || log.details!.error || !log.httpStatus ? 'failed' : 'success';
      if (log.outputTokens !== null && log.details!.outputMs) log.details!.tokensPerSecond = Math.round(log.outputTokens * 100000 / Number(log.details!.outputMs)) / 100;
      await save();
    };
    const abort = () => { void finish(signal?.reason || new Error('请求已取消'), true); void reader?.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      const response = await fetcher(input, init);
      if (signal?.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
      log.httpStatus = response.status; log.details!.headersMs = elapsed();
      log.details!.responseHeaders = Object.fromEntries([...response.headers.entries()].filter(([key]) => /^(content-type|x-request-id|request-id|openai-processing-ms|retry-after|x-ratelimit-.*)$/i.test(key)));
      protocol = response.headers.get('content-type')?.includes('text/event-stream') ? 'sse' : 'json';
      log.details!.responseStreaming = protocol === 'sse';
      reader = response.body?.getReader();
      if (!reader) { await finish(new Error('AI 返回空响应')); return response; }
      const decoder = new TextDecoder();
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await reader!.read();
            if (done) { const tail = decoder.decode(); if (protocol === 'sse') pending += tail; else raw += tail; cleanup(); await finish(); controller.close(); return; }
            log.details!.firstByteMs ??= elapsed(); bytes += value.length;
            const text = decoder.decode(value, { stream: true });
            if (protocol === 'sse') { pending += text; const lines = pending.split(/\r?\n/); pending = lines.pop() || ''; for (const item of lines) line(item); if (pending.length > LIMIT) { pending = ''; log.details!.error = '流式事件过长'; } }
            if (protocol !== 'sse' && raw.length < LIMIT) raw += text.slice(0, LIMIT - raw.length);
            if (sawOutput) log.details!.lastOutputMs = lastToken;
            controller.enqueue(value);
          } catch (error) { cleanup(); await finish(error); controller.error(error); }
        },
        async cancel(reason) { cleanup(); const saved = finish(sawTerminal ? undefined : reason || new Error('响应读取提前结束'), signal?.aborted === true); void reader!.cancel(reason).catch(() => {}); await saved; },
      });
      if (signal?.aborted) abort();
      const observed = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      outcomes.set(observed, async error => {
        log.details!.validationError = redactAudit(error instanceof Error ? { name: error.name, message: error.message, ...('code' in error ? { code: error.code } : {}), ...('details' in error ? { details: error.details } : {}) } : error);
        if (!finished) await finish(error); else { if (log.status !== 'cancelled') log.status = 'failed'; await save(); }
      });
      return observed;
    } catch (error) { await finish(error, init?.signal?.aborted === true); throw error; }
  };
  wrappers.set(fetcher, wrapped); wrappers.set(wrapped, wrapped); return wrapped;
}
