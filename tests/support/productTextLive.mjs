// Opt-in: exercises the main application's four text stages, never drawing APIs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readAiConfig } from '../../server/drawingAi.ts';
import { createProductTextService } from '../../server/productTextAi.ts';
import { signProductArtifact } from '../../server/productProof.ts';
import { checkTechnicalPlan, checkTextDocument, documentContent } from '../../src/features/product/productText.ts';
if (process.env.RUN_PRODUCT_TEXT_LIVE !== '1') throw new Error('Set RUN_PRODUCT_TEXT_LIVE=1 to enable real model calls.');
const directory = path.resolve(process.env.PRODUCT_TEXT_LIVE_OUTPUT || `artifacts/product-text-refactor-live-${new Date().toISOString().replace(/[:.]/g, '-')}`);
if (!directory.startsWith(process.cwd() + path.sep)) throw new Error('Output must remain inside this workspace.');
fs.mkdirSync(directory, { recursive: true });
const config = readAiConfig(process.env);
if (!config.apiKey || !config.model) throw new Error('No model configuration.');
const oldDirectory = path.resolve('patent-text-app/data/evaluations/2026-10-13T08-58-50-310Z');
const baseline = JSON.parse(fs.readFileSync(path.join(oldDirectory, 'manifest.json'), 'utf8'));
const files = ['server/productTextAi.ts', 'server/productTextPrompts.ts', 'server/productJson.ts', 'src/features/product/productText.ts', 'server/productWorkflowAi.ts'];
const hashes = {};
for (const file of files) {
  const data = fs.readFileSync(file), target = path.join(directory, 'source', file);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
  hashes[file] = createHash('sha256').update(data).digest('hex');
}
const manifest = { startedAt: new Date().toISOString(), directory, baseline: oldDirectory, hashes,
  protocol: '主应用四个文本阶段；沿用历史同一场景、问题和方向，每类独立生成两次。前置选择为固定测试资料，不调用候选问题或既有跨特征逻辑审查，不调用附图接口。最多两个并发任务。', runs: [] };
const persist = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
persist(); console.log(JSON.stringify({ event: 'started', directory }));
const queue = ['纸箱', '夹具', '闸门'].flatMap(product => [1, 2].map(repetition => ({ product, repetition })));
let index = 0;
async function run({ product, repetition }) {
  const proposal = baseline.proposals.find(p => p.product === product), problem = proposal.problems[0];
  const selection = { company: '文本流程验证', business: product, product, proposedName: `一种${product}`, patentType: 'utility', improvementType: 'structure', visualPreferences: '',
    selectedProblem: { product, context: '', scenario: proposal.scenario, problem: { ...problem, suggestedName: `一种${product}` } },
    choices: [{ id: 'selected-problem', category: '技术问题', text: problem.problem }] };
  // Only the selected input is used by the four-stage service. This is explicitly
  // a test fixture, not a claim that the preliminary logic model was called.
  const reviewFixture = signProductArtifact('review', { id: randomUUID(), selection, verdict: 'feasible', summary: '固定选题测试输入', checks: [], conflicts: [], assumptions: [], createdAt: new Date().toISOString() }, config);
  const record = { product, repetition, startedAt: new Date().toISOString(), status: 'running', events: [], requests: [] };
  manifest.runs.push(record); persist();
  const state = { selection, problem, record };
  const save = () => { fs.writeFileSync(path.join(directory, `${product}-${repetition}.json`), JSON.stringify(state, null, 2)); persist(); };
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    const request = { stage: record.stage, model: body.model, startedAt: new Date().toISOString() };
    record.requests.push(request); save();
    try { const result = await fetch(url, init); request.httpStatus = result.status; return result; }
    catch (error) { request.failure = error.name; throw error; }
  };
  const service = createProductTextService(config, fetcher), signal = AbortSignal.timeout(25 * 60_000);
  const progress = (label, detail) => { record.events.push({ time: new Date().toISOString(), label, detail }); save(); console.log(JSON.stringify({ product, repetition, stage: record.stage, label })); };
  try {
    record.stage = 'structure'; state.structure = await service.structure(reviewFixture, signal, progress); save();
    record.stage = 'structureReview'; state.brief = await service.brief(reviewFixture, state.structure, signal, progress); save();
    record.stage = 'draft'; state.draft = await service.draft(state.brief, signal, progress); save();
    record.stage = 'textReview'; state.materials = await service.materials(state.brief, state.draft, signal, progress); save();
    record.status = state.materials.textRecord.status;
    const doc = state.materials.textRecord.document, text = documentContent(doc);
    record.planErrors = checkTechnicalPlan(state.brief.technicalSource.plan, selection);
    record.documentErrors = checkTextDocument(doc, state.brief.technicalSource.plan);
    record.unresolved = state.materials.textRecord.review.unresolved;
    record.partEdits = state.brief.technicalSource.review.partEdits;
    fs.writeFileSync(path.join(directory, `${product}-${repetition}.txt`), [doc.title, '说明书摘要', text.abstract, '权利要求书', ...text.claims, '说明书', text.technicalField, text.background, text.content, '具体实施方式', text.embodiment].join('\n\n'));
  } catch (error) { record.status = 'failed'; record.error = { code: error.code || error.name, message: error.message, details: error.details || [] }; }
  record.finishedAt = new Date().toISOString(); record.elapsedSeconds = Math.round((Date.now() - Date.parse(record.startedAt)) / 1000);
  record.validationRetries = record.events.filter(e => e.label === '修正校验问题').length;
  save(); console.log(JSON.stringify({ event: 'finished', product, repetition, status: record.status, seconds: record.elapsedSeconds, error: record.error }));
}
await Promise.allSettled([0, 1].map(async () => { while (index < queue.length) await run(queue[index++]); }));
manifest.finishedAt = new Date().toISOString(); persist();
console.log(JSON.stringify({ event: 'complete', directory, statuses: manifest.runs.map(r => `${r.product}-${r.repetition}:${r.status}`) }));
