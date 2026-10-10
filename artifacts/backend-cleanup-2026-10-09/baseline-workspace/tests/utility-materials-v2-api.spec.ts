import { expect, test } from '@playwright/test';
import { handleMaterialsV2Request } from '../server/materialsV2Api';
import { confirmStructureEvidence } from '../src/features/utility/patentEvidence';
import { createPatentGenerationContext } from '../src/features/utility/claimPlan';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { sampleDraft } from './fixtures/structureFlow';

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
