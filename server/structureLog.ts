import { mkdirSync } from 'node:fs';
import { appendFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = join(homedir(), '.local', 'state', 'zhichuang-workshop');
export const structureLogPath = join(LOG_DIR, 'patent-structure.jsonl');
// 单个日志文件上限 5MB，超限后轮转为 .1，避免无限增长。
const MAX_LOG_BYTES = 5 * 1024 * 1024;
try { mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 }); } catch { /* 诊断日志不可用不影响主流程 */ }

async function rotateLogIfNeeded(): Promise<void> {
  try {
    const info = await stat(structureLogPath);
    if (info.size < MAX_LOG_BYTES) return;
    await rename(structureLogPath, `${structureLogPath}.1`);
  } catch { /* 缺文件或轮转失败都不影响主流程 */ }
}
const stages = new Set(['request', 'research', 'skeleton', 'draft', 'repair']);
const outcomes = new Set(['started', 'completed', 'aborted', 'network_error', 'AI_AUTH', 'AI_RATE_LIMIT', 'AI_UPSTREAM', 'AI_INCOMPLETE', 'AI_INVALID_JSON', 'AI_INVALID_OUTPUT', 'AI_ATTEMPT_TIMEOUT', 'AI_MODEL_TIMEOUT', 'AI_TOTAL_TIMEOUT', 'RESEARCH_UNAVAILABLE', 'RESEARCH_UNVERIFIED', 'failed']);

const validationCategories = new Set(['schema', 'geometry', 'relationship', 'motion', 'source_mismatch', 'other']);
export type StructureLogEntry = { requestId: string; stage: string; model?: string; httpStatus?: number | null; elapsedMs: number; outcome: string; finishReason?: string; failureKind?: string; failureStage?: string; validation?: Record<string, number> };

// 写入串行化：并发 appendFile 的完成顺序无保证，会让同一次请求的记录在文件里错序，
// 诊断时难以按时间线阅读。用一条 Promise 链把写入排队，保持调用顺序。
let writeQueue: Promise<void> = Promise.resolve();

export function recordStructureLog(entry: StructureLogEntry) {
  const record = {
    timestamp: new Date().toISOString(),
    requestId: /^[0-9a-f-]{36}$/u.test(entry.requestId) ? entry.requestId : '[redacted]',
    stage: stages.has(entry.stage) ? entry.stage : 'request',
    model: entry.model && /^(?:claude|gpt|gemini|qwen|deepseek|glm|doubao|kimi)[a-z0-9._/-]{0,90}$/u.test(entry.model) ? entry.model : '[redacted]',
    httpStatus: typeof entry.httpStatus === 'number' && entry.httpStatus >= 100 && entry.httpStatus <= 599 ? entry.httpStatus : null,
    elapsedMs: Math.max(0, Math.floor(entry.elapsedMs)),
    outcome: outcomes.has(entry.outcome) ? entry.outcome : 'failed',
    finishReason: entry.finishReason && ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(entry.finishReason) ? entry.finishReason : 'unknown',
    failureKind: entry.failureKind && ['unsupported_endpoint', 'unsupported_tool', 'unsupported_model', 'rate_limit', 'invalid_request', 'unknown'].includes(entry.failureKind) ? entry.failureKind : 'unknown',
    ...(entry.failureStage && ['message-shape', 'duplicate-tool-use', 'tool-result', 'search-results', 'citation-shape', 'patent-citation-url', 'citation-source-missing', 'citation-text-missing', 'no-cited-summary', 'no-attributable-citation', 'research-validation'].includes(entry.failureStage) ? { failureStage: entry.failureStage } : {}),
    validation: Object.fromEntries(Object.entries(entry.validation || {}).filter(([key, count]) => validationCategories.has(key) && Number.isInteger(count) && count > 0 && count <= 100)),
  };
  const line = `${JSON.stringify(record)}\n`;
  // 异步追加不阻塞事件循环；失败仅告警，不影响主流程。排队保证顺序。
  writeQueue = writeQueue
    .then(() => rotateLogIfNeeded())
    .then(() => appendFile(structureLogPath, line, { encoding: 'utf8', mode: 0o600 }))
    .catch(() => { console.warn('patent-structure diagnostic log unavailable', { requestId: record.requestId }); });
}

// 请求终态必须可等待：诊断日志的用途是按 requestId 回溯一次请求的完整时间线，
// 若终态记录还在写入队列里就返回响应，调用方立刻按 requestId 读文件会读不到它。
export async function flushStructureLog(): Promise<void> {
  await writeQueue;
}

