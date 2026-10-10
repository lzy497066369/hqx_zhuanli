import { expect, test } from '@playwright/test';
import { createPatentGenerationContext } from '../src/features/utility/claimPlan';
import { confirmStructureEvidence } from '../src/features/utility/patentEvidence';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning';
import { validatePatentDocument } from '../src/features/utility/patentValidator';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { PATENT_FIGURES } from '../src/features/utility/drawingModel';
import { sampleDraft } from './fixtures/structureFlow';

test('效果同义改写只在 effectId、外部原文及结构关系均可追溯时放行', () => {
  const draft = sampleDraft('一种防护装置', '过滤组件');
  draft.components[2].whyNeeded = '减少过滤组件表面的杂质积聚';
  const compiled = compileStructureDraft(draft);
  if (!compiled.success) throw new Error(compiled.errors.join('；'));
  const confirmed = confirmStructureEvidence(compiled.model, {
    productName: compiled.model.productTitle, introduction: '', usageScene: '', existingStructure: '', existingFunctions: '',
  });
  const componentId = confirmed.model.components[2].id;
  const connectionId = confirmed.model.connections.find(link => link.from === componentId || link.to === componentId)!.id;
  const id = `EVID-${String(confirmed.evidence.items.length + 1).padStart(3, '0')}`;
  const statement = '减少过滤组件表面的杂质积聚';
  const model = {
    ...confirmed.model,
    components: confirmed.model.components.map(part => part.id === componentId ? { ...part, evidenceRefs: [...part.evidenceRefs!, id] } : part),
    connections: confirmed.model.connections.map(link => link.id === connectionId ? { ...link, evidenceRefs: [...link.evidenceRefs!, id] } : link),
  };
  const evidence = { ...confirmed.evidence, items: [...confirmed.evidence.items, {
    id, sourceType: 'PRODUCT_DOCUMENT' as const, sourceTitle: '用户提供的产品效果资料', sourceUrl: 'https://example.com/product-document',
    sourceId: 'product-document-001', evidenceScope: 'DOCUMENT_EXCERPT' as const, factType: 'EFFECT' as const,
    originalText: `${model.connections.find(link => link.id === connectionId)!.description}；${model.motions.find(motion => motion.componentId === componentId)!.path}；${statement}。`, fact: statement, extractedFact: statement,
    relatedComponentIds: [componentId], relatedConnectionIds: [connectionId], relatedMotionIds: [],
    confidence: 0.8, status: 'SUPPORTED' as const,
  }] };
  const reasoning = buildReasoningPackage(model, evidence);
  expect(reasoning.effects).toContainEqual(expect.objectContaining({ effectId: `EFFECT-${id}`, statement }));
  expect(reasoning.effects[0].reasoningChainIds).toEqual([`CHAIN-${componentId}`]);
  const withoutMechanism = { ...evidence, items: evidence.items.map(item => item.id === id ? { ...item, originalText: statement } : item) };
  expect(buildReasoningPackage(model, withoutMechanism).effects).toEqual([]);
  const context = createPatentGenerationContext(model, evidence, reasoning);
  const document = { title: model.productTitle, abstract: '从而降低过滤组件表面的杂质积聚程度。', claims: [], sections: [], figures: PATENT_FIGURES };
  const report = validatePatentDocument({ context, document, sourceModelVersion: model.modelVersion });
  expect(report.issues.filter(issue => issue.code === 'EFFECT_REASONING_MISSING')).toEqual([]);

  const unsupported = validatePatentDocument({ context: { ...context, reasoning: { ...reasoning, effects: [] } },
    document, sourceModelVersion: model.modelVersion });
  expect(unsupported.issues.some(issue => issue.code === 'EFFECT_REASONING_MISSING')).toBe(true);
});
