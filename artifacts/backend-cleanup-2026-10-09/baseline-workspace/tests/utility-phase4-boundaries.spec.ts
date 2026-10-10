import { expect, test } from '@playwright/test';
import { generateBackgroundDraft, generateClaimsDraft, generateContentDraft, generateEmbodimentDraft } from '../server/draftGenerators';
import { assertTechnicalFingerprintUnchanged, type DocumentDraft, type PolishedDocument } from '../server/documentGenerationV2';
import { createPatentGenerationContext } from '../src/features/utility/claimPlan';
import { buildResearchEvidence, confirmStructureEvidence, isEvidencePackage, validateEvidenceReferences } from '../src/features/utility/patentEvidence';
import { extractResearchFacts, type PatentResearch } from '../src/features/utility/patentResearch';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { sampleDraft } from './fixtures/structureFlow';

function fixture() {
  const result = compileStructureDraft(sampleDraft('一种防护装置', '可调夹持组件'));
  if (!result.success) throw new Error(result.errors.join('；'));
  const source = { publication: 'CN123456789A', title: '测试检索资料', url: 'https://patents.google.com/patent/CN123456789A/en', evidence: 'opened' as const };
  const research: PatentResearch = { query: '防护装置', queries: ['防护装置'], summary: '带引用摘要，并非原文。',
    sources: [source], facts: extractResearchFacts([{ source, citedText: '检索归纳中提及壳体与支架固定连接。' }]), searchedAt: '2026-10-07T00:00:00Z' };
  const confirmed = confirmStructureEvidence(result.model, { productName: result.model.productTitle, introduction: '', usageScene: '', existingStructure: '', existingFunctions: '' }, research);
  return { ...confirmed, originalModel: result.model, research };
}

test('SUPPORTED 必须逐项具有来源标识、引用位置、原文、事实和匹配范围', () => {
  const { evidence } = fixture();
  const item = { ...evidence.items[0], sourceType: 'PRODUCT_DOCUMENT' as const, status: 'SUPPORTED' as const,
    sourceId: 'doc-1', sourceReference: '用户上传资料第1页', originalText: evidence.items[0].fact, evidenceScope: 'DOCUMENT_EXCERPT' as const };
  const pkg = { ...evidence, items: [item], research: undefined, priorArtRelations: [] };
  expect(isEvidencePackage(pkg)).toBe(true);
  for (const field of ['sourceId', 'sourceReference', 'originalText', 'fact', 'evidenceScope']) {
    const changed: Record<string, unknown> = { ...item }; delete changed[field];
    expect(isEvidencePackage({ ...pkg, items: [changed] }), field).toBe(false);
  }
  for (const evidenceScope of ['PATENT_CLAIMS', 'PATENT_ABSTRACT', 'SEARCH_SNIPPET', 'CITED_ASSISTANT_SUMMARY', 'INFERRED']) {
    expect(isEvidencePackage({ ...pkg, items: [{ ...item, evidenceScope }] }), evidenceScope).toBe(false);
  }
  expect(isEvidencePackage({ ...pkg, items: [{ ...item, originalText: '与事实无关的文字' }] })).toBe(false);
});

test('摘要不得升级专利原文：改标签或 SUPPORTED 均失败', () => {
  const { research } = fixture();
  const pkg = buildResearchEvidence(research);
  expect(pkg.items[0].status).toBe('INFERRED');
  expect(pkg.items[0].evidenceScope).toBe('CITED_ASSISTANT_SUMMARY');
  for (const scope of ['PATENT_CLAIMS', 'PATENT_DESCRIPTION', 'PATENT_ABSTRACT', 'PATENT_ORIGINAL_TEXT']) {
    expect(isEvidencePackage({ ...pkg, items: [{ ...pkg.items[0], evidenceScope: scope, status: 'SUPPORTED' }] })).toBe(false);
  }
  expect(isEvidencePackage({ ...pkg, items: [{ ...pkg.items[0], status: 'SUPPORTED' }] })).toBe(false);
});

test('独立对照关系有来源但不能成为结构依据，未知差异不认定缺失', () => {
  const { model, originalModel, evidence } = fixture();
  const stripRefs = <T extends { evidenceRefs?: string[] }>(items: T[]) => items.map(({ evidenceRefs: _refs, ...rest }) => rest);
  for (const field of ['components', 'connections', 'motions'] as const) expect(stripRefs(model[field])).toEqual(stripRefs(originalModel[field]));
  const relations = evidence.priorArtRelations!;
  expect(relations.length).toBeGreaterThan(0);
  expect(relations.every(relation => relation.status === 'INFERRED' && relation.relationType === 'ADDRESSES_PROBLEM')).toBe(true);
  const priorArt = evidence.items.find(item => item.sourceType === 'PATENT')!;
  expect(priorArt.relatedComponentIds).toEqual([]);
  expect(model.components.every(part => !part.evidenceRefs?.includes(priorArt.id))).toBe(true);
  expect(validateEvidenceReferences(model, evidence)).toEqual([]);
  const forged = structuredClone(evidence);
  forged.priorArtRelations![0].structureComponentIds = ['C99'];
  expect(validateEvidenceReferences(model, forged)).toContain('现有技术对照关系与证据/确认结构不一致');
  expect(() => buildReasoningPackage(model, forged)).toThrow('证据关联无效');
});

test('Reasoning 使用对应关系和实际证据文本；无相关术语不强行映射', () => {
  const { model, evidence } = fixture();
  const reasoning = buildReasoningPackage(model, evidence);
  for (const chain of reasoning.chains) {
    expect(chain.id).toBe(`CHAIN-${chain.featureId}`);
    expect(chain.causeEvidenceRefs.length).toBeGreaterThan(0);
    expect(chain.problemCauseStatus).toBe('INFERRED');
    expect(chain.solutionFeatureIds).toContain(chain.featureId);
    expect(chain.structuralMechanism).toBeTruthy();
    expect(chain.workingSteps.length).toBeGreaterThan(0);
    expect(chain.problemCause).not.toContain('配置或协同不足');
  }
  const matching = reasoning.chains.find(chain => chain.priorArtRelationIds.length)!;
  expect(matching.problemCause).toContain('检索归纳中提及壳体与支架固定连接');
  const unrelated = reasoning.chains.find(chain => model.components.find(part => part.id === chain.featureId)?.name === '可调夹持组件')!;
  expect(unrelated.priorArtEvidenceRefs).toEqual([]);
  expect(reasoning.technicalEffects).toEqual([]);
  expect(buildReasoningPackage(model).chains.every(chain => chain.causeEvidenceRefs.length === 0 && chain.technicalEffects.length === 0)).toBe(true);
});

test('正向固定关系与已确认滑动结构形成可追溯差异和条件性原因，否定句不触发', () => {
  const { originalModel, research } = fixture();
  const input = { ...originalModel, problemSolved: '调节部件间距', connections: originalModel.connections.map((link, index) => index ? link : { ...link, relation: 'slidably_connected' as const }) };
  const brief = { productName: input.productTitle, introduction: '', usageScene: '', existingStructure: '', existingFunctions: '' };
  const { model, evidence } = confirmStructureEvidence(input, brief, research);
  const reasoning = buildReasoningPackage(model, evidence);
  expect(reasoning.priorArtRelations.some(relation => relation.relationType === 'DISTINGUISHED_FROM')).toBe(true);
  expect(reasoning.chains.some(chain => chain.problemCause.includes('固定约束可能限制该调节'))).toBe(true);
  expect(reasoning.effects).toEqual([]);
  const negative = { ...research, facts: extractResearchFacts([{ source: research.sources[0], citedText: '壳体与支架不是固定连接。' }]) };
  expect(confirmStructureEvidence(input, brief, negative).evidence.priorArtRelations!.every(relation => relation.relationType !== 'DISTINGUISHED_FROM')).toBe(true);
});

test('真实 Draft caller 的模型请求保留 Research 范围、定位与独立推理关系', async () => {
  const { model, evidence } = fixture();
  const context = createPatentGenerationContext(model, evidence, buildReasoningPackage(model, evidence));
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (_url, init) => {
    called = true;
    const request = JSON.parse(String(init?.body));
    const input = JSON.parse(request.messages[1].content);
    const fact = input.grounding.evidence.find((item: { sourceType: string }) => item.sourceType === 'PATENT');
    expect(fact).toMatchObject({ sourceId: 'CN123456789A', sourceUrl: 'https://patents.google.com/patent/CN123456789A/en',
      status: 'INFERRED', evidenceScope: 'CITED_ASSISTANT_SUMMARY', factType: 'PRIOR_ART_FEATURE' });
    expect(input.grounding.reasoning.priorArtRelations).toEqual(context.reasoning.priorArtRelations);
    expect(input.grounding.claimPlan).toEqual(context.claimPlan);
    expect(request.messages[0].content).toContain('不是专利原文');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ background: '防护装置涉及机械装配技术领域，其结构设计需要结合产品需求核对各部件的配置及相互连接关系。' }) } }] });
  };
  try {
    await generateBackgroundDraft(context, { baseUrl: 'https://phase4-test.invalid/v1', apiKey: 'mock-only', model: 'mock' }, new AbortController().signal);
    expect(called).toBe(true);
  } finally { globalThis.fetch = originalFetch; }
});

for (const stage of ['claims', 'content', 'embodiment'] as const) {
  test(`Draft ${stage} 校验重试不能丢失证据范围和事实边界`, async () => {
    const { model, evidence } = fixture();
    const context = createPatentGenerationContext(model, evidence, buildReasoningPackage(model, evidence));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body));
      const input = JSON.parse(request.messages[1].content);
      expect(request.messages[0].content).toContain('不是专利原文');
      expect(request.messages[0].content).toContain('不得改写或新增任何事实层字段');
      expect(input.grounding.evidence.find((item: { sourceType: string }) => item.sourceType === 'PATENT'))
        .toMatchObject({ sourceId: 'CN123456789A', evidenceScope: 'CITED_ASSISTANT_SUMMARY', status: 'INFERRED' });
      if (calls === 2) expect(request.messages[0].content).toContain('上一次生成');
      const valid = stage === 'claims'
        ? { claims: context.claimPlan.claims.map(claim => ({ ...claim, text: `${claim.claimNo}：${claim.componentIds.map(id => model.components.find(part => part.id === id)!.name).join('、')}` })) }
        : stage === 'content'
          ? { problemStatement: model.problemSolved, technicalSolution: model.baseStructure, innovationPoints: ['已确认的可调夹持组件'], benefits: '结构目的，不宣称性能改善。' }
          : { embodiment: '如图1至图3所示，' + '壳体与支架固定连接，罩体连接在支架上。'.repeat(8) };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls === 1 ? {} : valid) } }] });
    };
    try {
      const config = { baseUrl: 'https://phase4-test.invalid/v1', apiKey: 'mock-only', model: 'mock' };
      const generate = stage === 'claims' ? generateClaimsDraft : stage === 'content' ? generateContentDraft : generateEmbodimentDraft;
      await generate(context, config, new AbortController().signal);
      expect(calls).toBe(2);
    } finally { globalThis.fetch = originalFetch; }
  });
}

function documents() {
  const { model, evidence } = fixture();
  const context = createPatentGenerationContext(model, evidence, buildReasoningPackage(model, evidence));
  const metadata = { model: 'test-only', elapsedMs: 1, promptTokens: 0, completionTokens: 0 };
  const before: DocumentDraft = { version: 2, stage: 'draft', generatedAt: '2026-10-07',
    abstract: '壳体 C01 与支架 C02 固定连接 R01。可调夹持组件 C03 保持静止 M03。',
    technicalField: '涉及防护技术领域。', background: '技术问题：便于维护。',
    content: { problemStatement: '技术问题：便于维护。', technicalSolution: '可调夹持组件 C03 连接支架 C02。', innovationPoints: [], benefits: '不宣称已经提高可靠性。' },
    drawings: '图1示意壳体和支架。', embodiment: '参考 EVID-001 和 CHAIN-C01。尺寸20mm。',
    claims: [{ claimNo: 1, text: '壳体 C01 与支架 C02 固定连接。', componentIds: ['C01', 'C02'], connectionIds: ['R01'], motionIds: [] },
      { claimNo: 2, parentClaimNo: 1, text: '根据权利要求1，可调夹持组件 C03 连接支架 C02。', componentIds: ['C03', 'C02'], connectionIds: ['R02'], motionIds: ['M03'] }], metadata };
  const after: PolishedDocument = { ...before, stage: 'polished', polishedAt: '2026-10-07',
    content: [before.content.problemStatement, before.content.technicalSolution, before.content.benefits].join('\n'),
    claims: before.claims.map(claim => `${claim.claimNo}. ${claim.text}`), claimReferences: before.claims.map(({ text: _text, ...refs }) => refs), improvements: [] };
  return { before, after, context };
}

test('Polish 接受受控术语、纯语法变化和段落重排', () => {
  const { before, after, context } = documents();
  after.abstract = after.abstract.replace('可调夹持组件', '可调式夹持组件').split('。').filter(Boolean).reverse().join('。') + '。';
  after.technicalField = after.technicalField.replace('涉及', '涉及的是');
  expect(() => assertTechnicalFingerprintUnchanged(before, after, context)).not.toThrow();
});

for (const kind of ['component', 'connection', 'motion', 'numeric', 'dependency', 'problem', 'solution', 'effect', 'evidence', 'chain', 'negation'] as const) {
  test(`Polish 拒绝 ${kind} 事实改变，即使元数据未变`, () => {
    const { before, after, context } = documents();
    if (kind === 'component') after.abstract = after.abstract.replace('C01', 'C02');
    if (kind === 'connection') after.abstract = after.abstract.replace('R01', 'R02');
    if (kind === 'motion') after.abstract = after.abstract.replace('M03', 'M02');
    if (kind === 'numeric') after.embodiment = after.embodiment.replace('20mm', '25mm');
    if (kind === 'dependency') after.claimReferences[1].parentClaimNo = 3;
    if (kind === 'problem') after.background = '技术问题：提高夹持精度。';
    if (kind === 'solution') after.content = after.content.replace('连接', '焊接');
    if (kind === 'effect') after.content = after.content.replace('不宣称已经提高可靠性', '提高可靠性');
    if (kind === 'evidence') after.embodiment = after.embodiment.replace('EVID-001', 'EVID-002');
    if (kind === 'chain') after.embodiment = after.embodiment.replace('CHAIN-C01', 'CHAIN-C02');
    if (kind === 'negation') after.abstract = after.abstract.replace('固定连接', '不固定连接');
    expect(() => assertTechnicalFingerprintUnchanged(before, after, context)).toThrow('Polish = FAILED');
  });
}
