import { expect, test } from '@playwright/test';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { confirmStructureEvidence, isEvidencePackage, validateEvidenceReferences } from '../src/features/utility/patentEvidence';
import type { ProductBrief } from '../src/features/utility/patentStructure';
import { sampleDraft } from './fixtures/structureFlow';

const brief: ProductBrief = {
  productName: '一种防护装置', introduction: '', usageScene: '', existingStructure: '', existingFunctions: '',
  confirmedFacts: [{ question: '是否有盖体', answer: '包含盖体' }, { question: '可否弹性连接', answer: '建议弹性连接', origin: 'model_proposal' }],
};

test('模型确认只证明结构选择；仅检索来源不会冒充为已支持的先行技术事实', () => {
  const result = compileStructureDraft(sampleDraft(brief.productName));
  if (!result.success) throw new Error(result.errors.join('；'));
  const { model, evidence } = confirmStructureEvidence(result.model, brief, {
    query: '防护装置', queries: ['防护装置'], summary: '检索摘要', searchedAt: new Date().toISOString(),
    sources: [{ publication: 'CN123456789A', title: '检索命中', url: 'https://patents.google.com/patent/CN123456789A/en', evidence: 'search_result' }],
  });
  expect(isEvidencePackage(evidence)).toBe(true);
  expect(validateEvidenceReferences(model, evidence)).toEqual([]);
  expect(evidence.items.find(item => item.fact.includes('弹性连接'))).toMatchObject({ sourceType: 'AI_INFERENCE', status: 'INFERRED' });
  expect(evidence.items.some(item => item.sourceType === 'PATENT' && item.status === 'SUPPORTED')).toBe(false);
  expect(evidence.research?.sources).toHaveLength(1);
  expect(evidence.research?.evidence).toEqual([]);
  expect(model.components.every(component => component.evidenceRefs?.length === 1)).toBe(true);
});

test('带已验证引用的 AI 检索归纳仅作为 INFERRED 保存，但不能成为用户结构的证据', () => {
  const result = compileStructureDraft(sampleDraft(brief.productName));
  if (!result.success) throw new Error(result.errors.join('；'));
  const research = {
    query: '防护装置', queries: ['防护装置'], summary: '检索摘要', searchedAt: new Date().toISOString(),
    sources: [{ publication: 'CN123456789A', title: '检索命中', url: 'https://patents.google.com/patent/CN123456789A/en', evidence: 'opened' as const }],
    facts: [{
      id: 'RSF-001', sourceId: 'CN123456789A', sourceType: 'PATENT' as const, publication: 'CN123456789A',
      sourceUrl: 'https://patents.google.com/patent/CN123456789A/en', sourceTitle: '检索命中',
      originalText: '带引用的检索摘要：现有技术公开了防护装置。', extractedFact: '带引用的检索摘要：现有技术公开了防护装置。',
      factType: 'PRIOR_ART_FEATURE' as const, confidence: 0.7, status: 'INFERRED' as const,
      evidenceScope: 'CITED_ASSISTANT_SUMMARY' as const,
      relatedComponentIds: [], relatedConnectionIds: [], relatedMotionIds: [], relatedFigureIds: [],
    }],
  };
  const { model, evidence } = confirmStructureEvidence(result.model, brief, research);
  const priorArt = evidence.items.find(item => item.sourceType === 'PATENT' && item.status === 'INFERRED');
  expect(isEvidencePackage(evidence)).toBe(true);
  expect(priorArt).toMatchObject({
    sourceId: 'CN123456789A', factType: 'PRIOR_ART_FEATURE', evidenceScope: 'CITED_ASSISTANT_SUMMARY',
    relatedComponentIds: [], relatedConnectionIds: [], relatedMotionIds: [], relatedFigureIds: [],
  });
  expect(model.components.some(component => component.evidenceRefs?.includes(priorArt?.id || ''))).toBe(false);
  expect(model.connections.some(connection => connection.evidenceRefs?.includes(priorArt?.id || ''))).toBe(false);
  expect(model.motions.some(motion => motion.evidenceRefs?.includes(priorArt?.id || ''))).toBe(false);
  expect(validateEvidenceReferences(model, evidence)).toEqual([]);
});

test('证据包拒绝伪造已核实来源、坏链接和跨版本引用', () => {
  const result = compileStructureDraft(sampleDraft(brief.productName));
  if (!result.success) throw new Error(result.errors.join('；'));
  const { model, evidence } = confirmStructureEvidence(result.model, brief);
  expect(isEvidencePackage({ ...evidence, items: [{ ...evidence.items[0], status: 'SUPPORTED' }] })).toBe(false);
  expect(isEvidencePackage({ ...evidence, items: [{ ...evidence.items[0], sourceType: 'AI_INFERENCE' }] })).toBe(false);
  expect(isEvidencePackage({ ...evidence, items: [{
    ...evidence.items[0], sourceType: 'PATENT', status: 'SUPPORTED', sourceTitle: '检索命中',
    sourceUrl: 'https://patents.google.com/patent/CN123456789A/zh', originalText: '带引用的检索摘要',
    sourceId: 'CN123456789A', relatedComponentIds: [], relatedConnectionIds: [], relatedMotionIds: [],
  }] })).toBe(false);
  expect(isEvidencePackage({ ...evidence, research: { query: 'q', researchSummary: 's', retrievedAt: new Date().toISOString(), sources: [{ publication: 'CN123456789A', title: 't', url: 'https://example.org', evidence: 'opened' }], evidence: [], priorArtFeatures: [], technicalTerms: [] } })).toBe(false);
  expect(validateEvidenceReferences(model, { ...evidence, modelVersion: 'other' })).toContain('证据包与结构模型版本不一致');
  const stale = { ...model, components: model.components.map((part, index) => index ? part : { ...part, evidenceRefs: ['EVID-999'] }) };
  expect(validateEvidenceReferences(stale, evidence).some(error => error.includes('EVID-999'))).toBe(true);
});
