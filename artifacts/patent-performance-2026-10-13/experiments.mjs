import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { readAiConfig } from '../../server/drawingAi.ts';
import { chatJson } from '../../server/patentStructureAi.ts';
import { generateNamingOptions, generateNamingNames } from '../../server/namingAi.ts';
import { generateStructureEvidenceOptions } from '../../server/structureEvidenceAi.ts';
import { PRODUCT_BRIEF_PROMPT } from '../../server/productWorkflowAi.ts';
import { isProductDesign } from '../../src/features/product/productWorkflow.ts';

const root = 'artifacts/patent-performance-2026-10-13';
const mode = process.env.PERFORMANCE_EXPERIMENT_MODE || 'all';
const reportPath = `${root}/${mode === 'naming-fixed' ? 'naming-fixed' : 'experiments'}.json`;
const state = JSON.parse(await fs.readFile(`${root}/state.json`, 'utf8'));
const config = readAiConfig(process.env);
const report = { startedAt: new Date().toISOString(), model: config.model, stages: [], requests: [] };
let name;
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const elapsed = started => Math.round(performance.now() - started);
const fetcher = async (url, init) => {
  const started = performance.now(); const payload = JSON.parse(init.body);
  const record = { stage: name, model: payload.model, endpoint: new URL(url).pathname, requestBytes: Buffer.byteLength(init.body), promptChars: payload.messages?.[0]?.content?.length, outputChars: 0, maxGapMs: 0, startedAt: new Date().toISOString() };
  report.requests.push(record);
  let buffer = '', content = '', last, raw = '';
  const decoder = new TextDecoder();
  const parse = line => {
    if (!line.startsWith('data:')) return; const data = line.slice(5).trim(); if (!data || data === '[DONE]') return;
    try { const event = JSON.parse(data); const choice = event.choices?.[0];
      if (event.usage) record.usage = event.usage;
      if (choice?.finish_reason) record.finishReason = choice.finish_reason;
      if (choice?.delta?.content) { const now = elapsed(started); record.firstContentMs ??= now; if (last !== undefined) record.maxGapMs = Math.max(record.maxGapMs, now - last); last = now; content += choice.delta.content; }
    } catch {}
  };
  try {
    const response = await fetch(url, init); record.status = response.status; record.headersMs = elapsed(started);
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    return new Response(response.body?.pipeThrough(new TransformStream({
      transform(chunk, controller) { record.firstByteMs ??= elapsed(started); if (sse) { buffer += decoder.decode(chunk, { stream: true }); const lines = buffer.split(/\r?\n/); buffer = lines.pop(); lines.forEach(parse); } else raw += decoder.decode(chunk, { stream: true }); controller.enqueue(chunk); },
      async flush() { if (sse && buffer.trim()) parse(buffer); if (!sse) { try { const event = JSON.parse(raw); content = event.choices?.[0]?.message?.content || ''; record.usage = event.usage; } catch {} } record.totalMs = elapsed(started); record.outputChars = content.length; await fs.writeFile(`${root}/experiment-output-${report.requests.indexOf(record) + 1}.txt`, content); await save(); console.log('REQUEST', JSON.stringify(record)); }
    })), { status: response.status, headers: response.headers });
  } catch (error) { record.totalMs = elapsed(started); record.error = { name: error.name, code: error.cause?.code }; await save(); throw error; }
};
async function stage(label, fn) {
  name = label; const started = performance.now(); const record = { name: label, outcome: 'running' }; report.stages.push(record); await save(); console.log('START', name);
  try { const value = await fn(); record.outcome = 'completed'; await fs.writeFile(`${root}/${mode}-${label}.json`, JSON.stringify(value, null, 2)); return value; }
  catch (error) { record.outcome = 'failed'; record.error = { code: error.code || error.name, message: error.message, details: error.details }; console.error('FAILED', JSON.stringify(record.error)); }
  finally { record.elapsedMs = elapsed(started); await save(); console.log('END', label, record.elapsedMs); }
}
const signal = AbortSignal.timeout(1800000);
const progress = (label, detail) => console.log('PROGRESS', name, label, detail);
const concise = `${PRODUCT_BRIEF_PROMPT}\n在完整保留所选事实、核心部件、连接关系、运动状态、逐项覆盖和待核实事项的前提下，控制重复：overview 300至380字；appearance 100至160字；workingPrinciple 150至220字；technicalField一句话；useCase一句话；innovation 80至120字。components 每项 structure 40至70字、connection 40至70字、purpose 15至30字。assumptions 合并相同待核实事项，最多5条、每条30至50字；choiceCoverage 每项30至60字。不要为了压缩而删去必要机构，也不要将普通连接螺栓等常规细节拆成额外创新部件。若关键结构需要更多文字，以事实完整为先。`;
if (mode !== 'naming-fixed') await stage('brief-concise-prompt', () => chatJson(concise, { selection: state.review.selection, logicalAssumptions: state.review.assumptions }, { ...config, fallbackModel: '', secondFallbackModel: '' }, signal, fetcher, 14000, undefined, value => isProductDesign(value, state.review.selection), { onProgress: progress }));

const profile = { company: state.selection.company, business: '光伏组件安装支架', product: '光伏组件安装支架', features: 'T形滑槽、锁紧螺栓、防脱挡边', improvementType: 'structure', excludedTerms: '' };
await stage('naming-product-options', () => generateNamingOptions({ company: profile.company, business: profile.business, excludedTerms: '', previous: [] }, config, signal, fetcher, progress));
const evidence = await stage('naming-structure-evidence', () => generateStructureEvidenceOptions({ profile }, config, signal, fetcher, progress));
const selectedIds = evidence ? ['component', 'relationship', 'motion', 'geometry', 'problem'].map(category => evidence.options.find(option => option.category === category).id) : [];
await stage('naming-names', () => generateNamingNames({ profile, previous: [], ...(evidence ? { structureEvidence: { version: 1, options: evidence.options, selectedIds, confirmed: true } } : {}) }, config, signal, fetcher, progress));
report.completedAt = new Date().toISOString(); await save();
