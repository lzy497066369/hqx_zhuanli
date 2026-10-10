import { expect, test } from '@playwright/test';
import { generateClaimsDraft } from '../server/draftGenerators';
import { createPatentGenerationContext } from '../src/features/utility/claimPlan';
import { claimComponentIds, validatePatentConsistency } from '../src/features/utility/patentConsistency';
import { confirmStructureEvidence } from '../src/features/utility/patentEvidence';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { sampleDraft } from './fixtures/structureFlow';

function fixture() {
  const compiled = compileStructureDraft(sampleDraft('一种防护装置'));
  if (!compiled.success) throw new Error(compiled.errors.join('；'));
  const confirmed = confirmStructureEvidence(compiled.model, {
    productName: compiled.model.productTitle, introduction: '', usageScene: '', existingStructure: '', existingFunctions: '',
  });
  return createPatentGenerationContext(confirmed.model, confirmed.evidence,
    buildReasoningPackage(confirmed.model, confirmed.evidence));
}

test('纯名称也能证明核心创新部件出现在权利要求正文', () => {
  const context = fixture();
  const claim = context.claimPlan.claims[0];
  const text = '1. 一种防护装置，包括壳体、支架和快拆罩，其特征在于：壳体与支架固定连接，支架与快拆罩连接。';
  const issues = validatePatentConsistency({
    model: context.model,
    claimsText: text,
    claimReferences: [{ claimNo: 1, componentIds: claim.componentIds, connectionIds: claim.connectionIds }],
    documentSourceModelVersion: context.model.modelVersion,
  });
  expect(issues.some(issue => issue.code === 'INNOVATION_NOT_IN_CLAIM_TEXT')).toBe(false);
  expect(claimComponentIds('1. 一种快拆罩，其特征在于：壳体与支架连接。', context.model)).not.toContain('C03');
  expect(claimComponentIds('2. 根据权利要求1所述的快拆罩，其特征在于：壳体与支架连接。', context.model)).not.toContain('C03');
});

test('映射正确但正文遗漏部件时，权利要求生成请求修正', async () => {
  const context = fixture();
  const planned = context.claimPlan.claims.map(plan => ({
    ...plan,
    text: plan.claimNo === 1
      ? '一种防护装置，包括壳体和支架，其特征在于：壳体与支架连接。'
      : `根据权利要求${plan.parentClaimNo}所述的防护装置，其特征在于：快拆罩与支架连接。`,
  }));
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    prompts.push(body.messages[0].content);
    const claims = prompts.length === 1 ? planned : planned.map((claim, index) => index === 0 ? {
      ...claim, text: '一种防护装置，包括壳体、支架和快拆罩，其特征在于：壳体与支架固定连接，支架与快拆罩连接。',
    } : claim);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ claims }) } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const claims = await generateClaimsDraft(context,
      { baseUrl: 'https://provider.example/v1', apiKey: 'test-key', model: 'test-model' }, new AbortController().signal);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('正文与ClaimPlan部件不一致');
    expect(claims[0].text).toContain('快拆罩');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
