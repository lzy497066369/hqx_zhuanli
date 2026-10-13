import { writeFile } from 'node:fs/promises';
import { generateStructureEvidenceOptions } from '../../server/structureEvidenceAi.ts';
import { readAiConfig } from '../../server/drawingAi.ts';

const config = { ...readAiConfig(process.env), fallbackModel: '', secondFallbackModel: '' };
const attempts = [];
const fetcher = async (url, init) => {
  const request = JSON.parse(init.body);
  const started = Date.now();
  const response = await fetch(url, init);
  const record = { model: request.model, maxCompletionTokens: request.max_completion_tokens, status: response.status, contentType: response.headers.get('content-type'), contentChars: 0, reasoningChars: 0, finishReasons: [], done: false };
  attempts.push(record);
  console.log('response', JSON.stringify(record));
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  let pending = '';
  const consume = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { record.done = true; return; }
    if (!data) return;
    let event;
    try { event = JSON.parse(data); } catch { record.invalidEvents = (record.invalidEvents || 0) + 1; return; }
    const choice = event?.choices?.[0];
    if (choice?.finish_reason) record.finishReasons.push(choice.finish_reason);
    if (typeof choice?.delta?.content === 'string') record.contentChars += choice.delta.content.length;
    if (typeof choice?.delta?.reasoning_content === 'string') record.reasoningChars += choice.delta.reasoning_content.length;
    if (event?.usage) record.usage = event.usage;
  };
  return new Response(response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) consume(line);
      controller.enqueue(chunk);
    },
    flush() {
      pending += decoder.decode();
      if (pending.trim()) consume(pending);
      record.elapsedMs = Date.now() - started;
      console.log('completion', JSON.stringify(record));
    },
  })), { status: response.status, headers: response.headers });
};
const report = { timestamp: new Date().toISOString(), profile: 'generic test fixture; not user data', attempts };
try {
  const result = await generateStructureEvidenceOptions({ profile: { company: '测试设备有限公司', business: '轴流风机', product: '轴流风机防护罩', features: '螺栓连接板', excludedTerms: '', improvementType: 'structure' } }, config, new AbortController().signal, fetcher);
  report.result = { status: 'completed', optionCount: result.options.length, providerModel: result.providerModel };
} catch (error) {
  report.result = { status: 'failed', code: error.code, name: error.name };
}
await writeFile(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
