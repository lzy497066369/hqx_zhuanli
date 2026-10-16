// Retry each failed batch job at most once, keeping the first-attempt record intact.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, ROOT } from '../config.mjs';

if (!process.argv[2]) throw new Error('Provide the batch evaluation directory.');
const directory = resolve(process.argv[2]);
const manifestPath = join(directory, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!manifest.finishedAt) throw new Error('The initial batch is still running.');
if (manifest.retries?.length) throw new Error('This batch already has a retry pass.');
const { runPipeline, checkDocument, checkPlan, formatDocument } = await import(pathToFileURL(join(directory, 'snapshot', 'pipeline.mjs')));
const config = loadConfig();
const failed = manifest.runs.filter(r => r.status === 'failed');
manifest.retries = [];
const persist = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
let next = 0;
const results = await Promise.allSettled(Array.from({ length: 2 }, async () => {
  while (next < failed.length) {
    const original = failed[next++];
    const job = JSON.parse(readFileSync(join(directory, `${original.product}-${original.repetition}.json`), 'utf8'));
    const started = Date.now(), startedAt = new Date().toISOString();
    const record = { id: job.id, product: original.product, repetition: original.repetition, startedAt, status: 'running', firstFailure: original.error };
    manifest.retries.push(record); persist();
    job.status = 'running'; job.error = '';
    let lastStage, lastModel;
    const save = message => {
      job.updatedAt = new Date().toISOString();
      if (message) {
        job.events.push({ time: job.updatedAt, message });
        console.log(JSON.stringify({ product: original.product, repetition: original.repetition, stage: job.stage, message }));
      }
      if (job.model && (lastStage !== job.stage || lastModel !== job.model)) {
        job.stageModels.push({ time: job.updatedAt, stage: job.stage, model: job.model, retry: true });
        lastStage = job.stage; lastModel = job.model;
      }
      const path = join(ROOT, 'data', `${job.id}.json`);
      writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
    };
    save('保留初次失败记录，使用相同快照进行一次断点重试。');
    try { await runPipeline(config, job, AbortSignal.timeout(18 * 60_000), save); }
    catch (error) { job.status = 'failed'; job.error = error.message; save(job.error); }
    const text = job.document ? formatDocument(job.document) : '';
    Object.assign(record, {
      status: job.status, error: job.error || '', finishedAt: new Date().toISOString(), elapsedSeconds: Math.round((Date.now() - started) / 1000),
      title: job.document?.title || job.plan?.title || '', parts: job.plan?.parts.length,
      physicalParts: job.plan?.parts.filter(p => ['part', 'assembly'].includes(p.kind)).length,
      claims: job.document?.claims.length, claim1Chars: job.document?.claims[0]?.text.length,
      totalChars: text.length, operationChars: job.document?.operation.length, abstractChars: job.document?.abstract.length,
      uncertainPhrases: [...new Set(text.match(/初拟|暂定|拟采用|待验证|待确认|尚需确定|根据需要确定|需按[^。\n]{0,30}核定/g) || [])],
      planErrors: job.plan ? checkPlan(job.plan) : null, documentErrors: job.document ? checkDocument(job.document, job.plan) : null,
      dependencies: job.document?.claims.map(c => [c.number, c.dependsOn]),
      unresolved: [...(job.structureReview?.unresolved || []), ...(job.textReview?.unresolved || [])],
      structureFindings: job.structureReview?.findings, textFindings: job.textReview?.findings,
      automaticRepairs: job.events.filter(e => e.time >= startedAt && e.message.startsWith('自动修正')),
      transportWarnings: job.events.filter(e => e.time >= startedAt && /可用模型|超时|连接.*服务|授权|额度/.test(e.message)),
    });
    writeFileSync(join(directory, `${original.product}-${original.repetition}-retry.json`), JSON.stringify(job, null, 2));
    if (text) writeFileSync(join(directory, `${original.product}-${original.repetition}-retry.txt`), text, 'utf8');
    persist();
    console.log(JSON.stringify({ event: 'retry_finished', product: original.product, repetition: original.repetition, status: job.status, seconds: record.elapsedSeconds, error: record.error }));
  }
}));
for (const result of results) if (result.status === 'rejected') throw result.reason;
manifest.retryFinishedAt = new Date().toISOString(); persist();
console.log(JSON.stringify({ event: 'retry_pass_finished', recovered: manifest.retries.filter(r => r.status === 'completed').length, total: manifest.retries.length }));
