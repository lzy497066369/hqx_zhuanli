import { expect, test } from '@playwright/test';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { confirmStructureEvidence } from '../src/features/utility/patentEvidence';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning';
import { generateClaimPlan } from '../src/features/utility/claimPlan';
import { sampleDraft } from './fixtures/structureFlow';

test('权利要求规划过滤孤立特征并拒绝跨版本数据', () => {
  const result = compileStructureDraft(sampleDraft('一种防护装置'));
  if (!result.success) throw new Error(result.errors.join('；'));
  const { model, evidence } = confirmStructureEvidence(result.model, { productName: result.model.productTitle, introduction: '', usageScene: '', existingStructure: '', existingFunctions: '' });
  const plan = generateClaimPlan(model, evidence, buildReasoningPackage(model, evidence));
  expect(plan.claims[0].componentIds.every(id => model.components.some(part => part.id === id))).toBe(true);
  expect(plan.claims[0].purpose).toBeTruthy();
  expect(plan.claims[0].connectionIds.every(id => model.connections.some(link => link.id === id))).toBe(true);
  expect(() => generateClaimPlan(model, { ...evidence, modelVersion: 'stale' }, buildReasoningPackage(model))).toThrow(/版本/);
  const isolated = { ...model, components: [...model.components, { ...model.components[0], id: 'C99', name: '孤立部件', evidenceRefs: [] }] };
  const confirmedIsolated = confirmStructureEvidence(isolated, { productName: isolated.productTitle, introduction: '', usageScene: '', existingStructure: '', existingFunctions: '' });
  const isolatedPlan = generateClaimPlan(confirmedIsolated.model, confirmedIsolated.evidence, buildReasoningPackage(confirmedIsolated.model, confirmedIsolated.evidence));
  expect(isolatedPlan.claims[0].componentIds).not.toContain('C99');
});
