import { expect, test } from '@playwright/test';
import { handleMaterialsV2Request } from '../server/materialsV2Api';
import { confirmStructureEvidence } from '../src/features/utility/patentEvidence';
import { createPatentGenerationContext } from '../src/features/utility/claimPlan';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { sampleDraft } from './fixtures/structureFlow';
import { GenerationQueue } from '../server/generationQueue';

const config = { baseUrl: 'https://provider.example/v1', apiKey: 'test-key', model: 'test-model' };

function contextFixture() {
  const compiled = compileStructureDraft(sampleDraft('一种防护装置'));
  if (!compiled.success) throw new Error(compiled.errors.join('；'));
  const confirmed = confirmStructureEvidence(compiled.model, {
    productName: compiled.model.productTitle,
    introduction: '',
    usageScene: '',
    existingStructure: '',
    existingFunctions: '',
  });
  return createPatentGenerationContext(
    confirmed.model,
    confirmed.evidence,
    buildReasoningPackage(confirmed.model, confirmed.evidence),
  );
}

async function post(body: unknown) {
  return handleMaterialsV2Request('/api/utility/materials-v2', 'POST', body, config);
}

test('V2 API：拒绝裸结构模型，不自动补造生成上下文', async () => {
  const context = contextFixture();
  expect(context.reasoning.motionRefs).toEqual(expect.any(Array));
  const response = await post({ model: context.model });
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ error: 'INVALID_INPUT' });
  expect(response.body.message).toContain('完整生成上下文');
});

test('V2 API：拒绝证据、推理和权利要求规划的版本错配', async () => {
  const context = contextFixture();
  const response = await post({ patentType: 'utility', context: { ...context, reasoning: { ...context.reasoning, modelVersion: 'stale-model' } } });
  expect(response.status).toBe(400);
  expect(response.body.message).toContain('结构版本不一致');
});

test('V2 API：拒绝未解决的冲突证据', async () => {
  const context = contextFixture();
  const evidence = { ...context.evidence, items: context.evidence.items.map((item, index) => index === 0 ? { ...item, status: 'CONFLICT' as const } : item) };
  const response = await post({ patentType: 'utility', context: { ...context, evidence } });
  expect(response.status).toBe(400);
  expect(response.body.message).toContain('事实冲突');
});

test('V2 API：拒绝无效的双向证据引用', async () => {
  const context = contextFixture();
  const model = { ...context.model, components: context.model.components.map((component, index) => index === 0 ? { ...component, evidenceRefs: ['EVID-999'] } : component) };
  const response = await post({ patentType: 'utility', context: { ...context, model } });
  expect(response.status).toBe(400);
  expect(response.body.message).toContain('证据关联无效');
});

test('V2 后台任务：返回 taskId 后仍排队，占用名额直到后台任务结束', async () => {
  const queue = new GenerationQueue();
  const tokens = await Promise.all(Array.from({ length: 10 }, () => queue.begin('owner', new AbortController().signal)));
  let fail!: () => void;
  const background = new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('测试后台任务终止')); });
  let started = false;
  const response = await handleMaterialsV2Request('/api/utility/materials-v2', 'POST', { patentType: 'utility', context: contextFixture() }, config, undefined, undefined,
    async (_operation, onQueued) => {
      const release = await queue.acquire(new AbortController().signal, onQueued);
      started = true;
      try { await background; } finally { release(); }
    });
  expect(response.status).toBe(200);
  const foreignStatus = await handleMaterialsV2Request(`/api/utility/materials-v2/status/${response.body.taskId}`, 'GET', undefined, config, undefined, undefined, undefined, 'other-user:other-workspace');
  expect(foreignStatus.status).toBe(404);
  expect(foreignStatus.body).toMatchObject({ error: 'TASK_NOT_FOUND' });
  const status = () => handleMaterialsV2Request(`/api/utility/materials-v2/status/${response.body.taskId}`, 'GET', undefined, config);
  expect((await status()).body.message).toContain('排队等待');
  expect(started).toBe(false);
  queue.end(tokens[0], 'owner');
  await expect.poll(() => started).toBe(true);
  let nextStarted = false;
  const next = queue.begin('owner', new AbortController().signal).then(token => { nextStarted = true; return token; });
  await Promise.resolve();
  expect(nextStarted).toBe(false);
  fail();
  queue.end(await next, 'owner');
  await expect.poll(async () => (await status()).body.status).toBe('failed');
  tokens.slice(1).forEach(token => queue.end(token, 'owner'));
});
