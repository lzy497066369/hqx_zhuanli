import { expect, test } from '@playwright/test';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { confirmStructureEvidence } from '../src/features/utility/patentEvidence';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning';
import { sampleDraft } from './fixtures/structureFlow';

test('推理链只把有证据且参与连接的创新结构纳入机制', () => {
  const result = compileStructureDraft(sampleDraft('一种防护装置'));
  if (!result.success) throw new Error(result.errors.join('；'));
  const { model, evidence } = confirmStructureEvidence(result.model, { productName: modelTitle(result.model), introduction: '', usageScene: '', existingStructure: '', existingFunctions: '' });
  const reasoning = buildReasoningPackage(model, evidence);
  expect(reasoning.modelVersion).toBe(model.modelVersion);
  expect(reasoning.problemCauseStatus).toBe('INFERRED');
  expect(reasoning.chains.every(chain => chain.problemCauseStatus === 'INFERRED')).toBe(true);
  expect(reasoning.chains.every(chain => chain.evidenceRefs.length > 0)).toBe(true);
  expect(reasoning.chains.filter(chain => chain.status === 'SUPPORTED').every(chain => chain.relationRefs.length > 0)).toBe(true);
  expect(buildReasoningPackage(model).technicalEffects).toEqual([]);
  const orphan = { ...model, connections: model.connections.filter(link => ![link.from, link.to].includes(model.components.find(part => part.kind === 'innovation')!.id)) };
  expect(buildReasoningPackage(orphan).chains.some(chain => chain.status === 'ORPHAN_FEATURE')).toBe(true);
});

function modelTitle(model: { productTitle: string }) { return model.productTitle; }
