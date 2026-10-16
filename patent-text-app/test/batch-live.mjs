// Explicit opt-in: calls the configured real model. Not included in npm test.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig, ROOT } from '../config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = join(ROOT, 'data', 'evaluations', stamp);
const snapshot = join(directory, 'snapshot');
mkdirSync(snapshot, { recursive: true });
const files = ['prompts.mjs', 'pipeline.mjs', 'structure.mjs', 'ai.mjs'];
const hashes = {};
for (const file of files) {
  copyFileSync(join(ROOT, file), join(snapshot, file));
  hashes[file] = hash(readFileSync(join(snapshot, file)));
}
const { generateProblems, runPipeline, checkPlan, checkDocument, formatDocument } = await import(pathToFileURL(join(snapshot, 'pipeline.mjs')));
const config = loadConfig();
const manifest = {
  startedAt: new Date().toISOString(), directory, hashes,
  protocol: '三个产品，各生成一组候选问题，固定选择第一项；每个相同输入独立生成两次。最多两个并发任务，保留失败及模型切换。',
  products: ['纸箱', '夹具', '闸门'], repetitions: 2, concurrency: 2,
  providers: config.providers.map(p => ({ model: p.model })),
  proposals: [], runs: [],
};
const persistManifest = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
persistManifest();
console.log(JSON.stringify({ event: 'batch_started', directory, hash: hashes['prompts.mjs'], products: manifest.products }));

async function workers(items, callback) {
  let index = 0;
  const results = await Promise.allSettled(Array.from({ length: 2 }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await callback(item);
    }
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

await workers(manifest.products, async product => {
  const startedAt = new Date().toISOString();
  try {
    const proposal = await generateProblems(config, product, AbortSignal.timeout(8 * 60_000));
    manifest.proposals.push({ product, startedAt, finishedAt: new Date().toISOString(), ...proposal });
    console.log(JSON.stringify({ event: 'problem_selected', product, title: proposal.problems[0].title }));
  } catch (error) {
    manifest.proposals.push({ product, startedAt, error: error.message });
    console.log(JSON.stringify({ event: 'problem_failed', product, error: error.message }));
  }
  persistManifest();
});

const queue = [];
for (let repetition = 1; repetition <= manifest.repetitions; repetition++) {
  for (const product of manifest.products) {
    const proposal = manifest.proposals.find(p => p.product === product);
    if (!proposal || proposal.error) continue;
    queue.push({ product, repetition, proposal });
  }
}

await workers(queue, async ({ product, repetition, proposal }) => {
  const job = {
    id: randomUUID(), product, scenario: proposal.scenario, problem: structuredClone(proposal.problems[0]),
    createdAt: new Date().toISOString(), status: 'running', stage: 'structure', events: [],
    notes: ['本任务为批量实测样稿。', '未生成附图，未执行现有技术检索或工程验证。'],
    evaluation: { batch: stamp, repetition, promptHash: hashes['prompts.mjs'] },
  };
  const record = { product, repetition, id: job.id, startedAt: job.createdAt, status: 'running' };
  manifest.runs.push(record); persistManifest();
  let lastStage, lastModel;
  job.stageModels = [];
  const save = message => {
    job.updatedAt = new Date().toISOString();
    if (message) {
      job.events.push({ time: job.updatedAt, message });
      console.log(JSON.stringify({ event: 'progress', product, repetition, stage: job.stage, message }));
    }
    if (job.model && (job.stage !== lastStage || job.model !== lastModel)) {
      job.stageModels.push({ time: job.updatedAt, stage: job.stage, model: job.model });
      lastStage = job.stage; lastModel = job.model;
    }
    const path = join(ROOT, 'data', `${job.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  save('开始独立生成，使用固定版本提示词和本组相同问题。');
  try {
    await runPipeline(config, job, AbortSignal.timeout(18 * 60_000), save);
  } catch (error) {
    job.status = 'failed'; job.error = error.message; save(job.error);
  }
  const text = job.document ? formatDocument(job.document) : '';
  const warnings = text.match(/初拟|暂定|拟采用|待验证|待确认|尚需确定|根据需要确定|需按[^。\n]{0,30}核定/g) || [];
  // This reports exact reuse for manual review; it is not a product quality gate.
  const normalize = value => (value || '').replace(/（\d+）/g, '').replace(/[\s，。；：、（）“”‘’]/g, '');
  const operation = normalize(job.document?.operation), embodiment = normalize(job.document?.embodiment);
  let matchingWindows = 0;
  const windows = Math.max(0, operation.length - 19);
  for (let i = 0; i < windows; i++) if (embodiment.includes(operation.slice(i, i + 20))) matchingWindows++;
  Object.assign(record, {
    status: job.status, error: job.error || '', finishedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - Date.parse(job.createdAt)) / 1000),
    title: job.document?.title || job.plan?.title || job.initialPlan?.title || '',
    stageModels: job.stageModels, transportWarnings: job.events.filter(e => /可用模型|超时|连接.*服务|授权|额度/.test(e.message)),
    automaticRepairs: job.events.filter(e => e.message.startsWith('自动修正')),
    parts: job.plan?.parts.length, physicalParts: job.plan?.parts.filter(p => ['part', 'assembly'].includes(p.kind)).length,
    claims: job.document?.claims.length, claim1Chars: job.document?.claims[0]?.text.length,
    abstractChars: job.document?.abstract.length, totalChars: text.length, operationChars: job.document?.operation.length,
    dependencies: job.document?.claims.map(c => [c.number, c.dependsOn]),
    uncertainPhrases: [...new Set(warnings)],
    operationExactReuseRatio: windows ? Math.round(matchingWindows / windows * 100) / 100 : 0,
    planErrors: job.plan ? checkPlan(job.plan) : null,
    documentErrors: job.document ? checkDocument(job.document, job.plan) : null,
    unresolved: [...(job.structureReview?.unresolved || []), ...(job.textReview?.unresolved || [])],
    structureFindings: job.structureReview?.findings, textFindings: job.textReview?.findings,
  });
  writeFileSync(join(directory, `${product}-${repetition}.json`), JSON.stringify(job, null, 2));
  if (text) writeFileSync(join(directory, `${product}-${repetition}.txt`), text, 'utf8');
  persistManifest();
  console.log(JSON.stringify({ event: 'run_finished', product, repetition, status: job.status, id: job.id, seconds: record.elapsedSeconds, claims: record.claims, uncertainPhrases: record.uncertainPhrases, error: record.error }));
});
manifest.finishedAt = new Date().toISOString();
manifest.sourceUnchanged = Object.fromEntries(files.map(file => [file, hash(readFileSync(join(ROOT, file))) === hashes[file]]));
persistManifest();
console.log(JSON.stringify({ event: 'batch_finished', directory, completed: manifest.runs.filter(r => r.status === 'completed').length, total: manifest.runs.length, proposalFailures: manifest.proposals.filter(p => p.error).length, sourceUnchanged: manifest.sourceUnchanged }));
