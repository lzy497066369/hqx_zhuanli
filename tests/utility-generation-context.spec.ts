import { expect, test } from '@playwright/test';
import type { PolishedDocument, DocumentDraft } from '../server/documentGenerationV2';
import { polishDocument } from '../server/documentPolisher';
import { validateFinalDocument } from '../server/documentValidator';
import { confirmStructureEvidence } from '../src/features/utility/patentEvidence';
import { createPatentGenerationContext, type PatentGenerationContext } from '../src/features/utility/claimPlan';
import { buildReasoningPackage } from '../src/features/utility/patentReasoning';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { sampleDraft } from './fixtures/structureFlow';
import { generatePatentDocument } from '../server/documentGenerationV2';
import { materialsForContext } from './fixtures/materialsV2';
import { convertV2ToV1Materials } from '../server/materialsV2Api';
import { freezePatentPackage } from '../src/features/utility/patentPackage';
import { CONTENT_MODEL_REVISION } from '../src/features/utility/contentDrawing';
import { getModelVersion, modelToComponents } from '../src/features/utility/patentStructure';
import type { Project, UtilityDrawing } from '../src/data';

type PipelineCase = 'pass' | 'fix' | 'unfixable' | 'second-review' | 'polish-number' | 'validator';

async function runPipeline(mode: PipelineCase) {
  const context = contextFixture();
  const materials = materialsForContext(context);
  const content = { problemStatement: '技术问题：便于维护。', technicalSolution: materials.content,
    innovationPoints: ['快拆罩通过支架连接。'], benefits: '快拆罩用于防护。' };
  const claims = context.claimPlan.claims.map((claim, index) => ({ ...claim,
    text: materials.claims.split('\n')[index].replace(/^\d+\.\s*/u, '') }));
  const values = {
    abstract: materials.abstract.replace('本实用新型公开', '公开') + '壳体与支架固定连接，支架与快拆罩连接，快拆罩用于防护，壳体用于承载，支架用于连接。',
    claims, technicalField: materials.technicalField,
    background: '现有技术中，防护装置的结构配置需要结合具体使用场景核对，装配关系与维护操作有关。',
    content, drawings: materials.drawings + '\n附图标记：1、壳体；2、支架；3、快拆罩。',
    embodiment: '如图1至图3所示，' + materials.embodiment.repeat(3),
  };
  if (mode === 'validator') values.background += '温度为999℃。';
  const calls: string[] = [];
  let clarityCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const prompt = body.messages[0].content as string;
    const input = JSON.parse(body.messages[1].content);
    let value: unknown;
    if (prompt.includes('审核助手')) {
      calls.push('review');
      const clarity = prompt.includes('清晰度');
      if (clarity) clarityCalls++;
      const issue = clarity && ((['fix', 'unfixable'].includes(mode) && clarityCalls === 1) ||
        (mode === 'second-review' && clarityCalls === 2));
      value = { issues: issue ? [{ severity: 'error', category: 'clarity', field: 'technicalField',
        message: '技术领域表达需要修正', autoFixable: mode === 'fix' }] : [] };
    } else if (prompt.includes('文档修复助手')) {
      calls.push(`fix:${input.field}`);
      expect(input.context).toEqual(context);
      expect(input.field).toBe('technicalField');
      value = { fixed: input.original.replace('涉及', '涉及的是') };
    } else if (prompt.includes('改写专家')) {
      calls.push('polish');
      if (input.grounding) {
        expect(input.grounding.evidence.every((item: { evidenceScope?: string }) => item.evidenceScope === 'USER_PROVIDED')).toBe(true);
        expect(input.grounding.reasoning.chains[0].id).toBe(context.reasoning.chains[0].id);
        expect(input.grounding.reasoning.effects).toEqual(context.reasoning.effects);
      }
      let polished = input.draft;
      if (prompt.includes('技术内容')) polished = [polished.problemStatement, polished.technicalSolution,
        ...polished.innovationPoints, polished.benefits].join('\n');
      if (mode === 'polish-number' && prompt.includes('摘要')) polished += '温度为999℃。';
      value = { polished, changes: '' };
    } else {
      calls.push('draft');
      const fields = [['摘要', 'abstract'], ['权利要求', 'claims'], ['技术领域', 'technicalField'],
        ['背景技术', 'background'], ['技术内容', 'content'], ['附图说明', 'drawings'], ['具体实施方式', 'embodiment']] as const;
      const field = fields.find(([label]) => prompt.startsWith(`你是专利${label}撰写助手`))?.[1];
      if (!field) throw new Error(`Unexpected prompt: ${prompt.slice(0, 50)}`);
      value = field === 'content' ? values.content : { [field]: values[field] };
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await generatePatentDocument(context, config, new AbortController().signal);
    return { result, calls, context };
  } finally { globalThis.fetch = originalFetch; }
}

test('生产生成函数：两轮审核后润色、最终验证并生成凭据', async () => {
  const { result, calls } = await runPipeline('pass');
  expect(result.readyForExport).toBe(true);
  expect(result.generationProof?.reviews).toHaveLength(2);
  expect(calls).toEqual([...Array(7).fill('draft'), ...Array(8).fill('review'), ...Array(7).fill('polish')]);
});

test('生产生成函数：仅修审核指定字段，重新审核后才能润色', async () => {
  const { result, calls } = await runPipeline('fix');
  expect(result.readyForExport).toBe(true);
  expect(result.generationProof?.reviews[0].fixedIssueIds).toHaveLength(1);
  expect(calls).toEqual([...Array(7).fill('draft'), ...Array(4).fill('review'), 'fix:technicalField',
    ...Array(4).fill('review'), ...Array(7).fill('polish')]);
});

test('冻结入口：生产结果深冻结，缺失凭据或事实/正文变化均阻断', async () => {
  const { result, context } = await runPipeline('pass');
  const materials = convertV2ToV1Materials(result, context);
  const model = context.model;
  const components = modelToComponents(model);
  const detail = components.find(part => part.componentId === model.components.find(part => part.kind === 'innovation')?.id)!;
  const drawing: UtilityDrawing = {
    version: 1, technicalField: model.technicalField, structure: model.baseStructure,
    workingPrinciple: model.workingPrinciple, parts: components, updatedAt: materials.generatedAt,
    patentStructureModel: model, evidencePackage: context.evidence,
    design: { revision: CONTENT_MODEL_REVISION, title: model.productTitle, source: 'test', generatedAt: materials.generatedAt,
      components, detailPartId: detail.id, detailComponentId: detail.componentId,
      sourceModelVersion: getModelVersion(model), structureModel: model },
  };
  const project: Project = { id: 'freeze-test', name: model.productTitle, category: 'utility',
    description: '', owner: '', status: 'draft', updatedAt: materials.generatedAt };
  const original = JSON.stringify({ project, drawing, materials });
  const frozen = freezePatentPackage(project, drawing, materials);
  expect(Object.isFrozen(frozen)).toBe(true);
  expect(Object.isFrozen(frozen.context.model.components[0])).toBe(true);
  expect(Object.isFrozen(frozen.document.claims)).toBe(true);
  expect(Object.isFrozen(model)).toBe(false);
  expect(JSON.stringify({ project, drawing, materials })).toBe(original);

  expect(() => freezePatentPackage(project, drawing, { ...materials, generationProof: undefined })).toThrow('缺少有效的 V2');
  expect(() => freezePatentPackage(project, drawing, { ...materials, abstract: materials.abstract + '温度为999℃。' })).toThrow('正文已变化');
  const changed = structuredClone(drawing);
  changed.evidencePackage!.items[0].notes = '来源已经更新';
  expect(() => freezePatentPackage(project, changed, materials)).toThrow('生成事实/正文已变化');
  const failedReview = structuredClone(materials);
  failedReview.generationProof!.reviews[1].issues.push({ id: 'remaining-error', severity: 'error' });
  expect(() => freezePatentPackage(project, drawing, failedReview)).toThrow('缺少有效的 V2');
  const changedPolish = structuredClone(materials);
  changedPolish.generationProof!.polish.after = 'changed';
  expect(() => freezePatentPackage(project, drawing, changedPolish)).toThrow('缺少有效的 V2');
});

for (const mode of ['unfixable', 'second-review', 'polish-number', 'validator'] as const) {
  test(`生产生成函数阻断：${mode}`, async () => {
    await expect(runPipeline(mode)).rejects.toThrow(mode === 'polish-number' ? 'Polish = FAILED' :
      mode === 'validator' ? '最终验证未通过' : '文档审核未通过');
  });
}

const config = { baseUrl: 'https://provider.example/v1', apiKey: 'test-key', model: 'test-model' };

function contextFixture(): PatentGenerationContext {
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

function polishedFixture(context: PatentGenerationContext): PolishedDocument {
  const claims = context.claimPlan.claims.map(claim =>
    `${claim.claimNo}. ${claim.claimNo === 1 ? '一种防护装置，其特征在于：壳体与支架连接。' : `根据权利要求${claim.parentClaimNo}所述的防护装置，其特征在于：快拆罩沿支架移动。`}`,
  );
  return {
    version: 2,
    stage: 'polished',
    polishedAt: new Date().toISOString(),
    abstract: '一种防护装置，包括壳体、支架及快拆罩，用于对目标结构提供可拆卸防护。',
    claims,
    technicalField: '本实用新型涉及机械装配技术领域。',
    background: '现有防护装置在装配和维护过程中需要反复拆装，结构配合不够便利。',
    content: '通过壳体、支架和快拆罩的结构配合，形成可拆卸的防护方案，并改善装配操作。',
    drawings: '图1至图6分别示出防护装置的整体结构、局部结构及装配关系。',
    embodiment: '如图1所示，壳体与支架连接，快拆罩沿支架移动后完成安装。',
    claimReferences: context.claimPlan.claims.map(claim => ({
      claimNo: claim.claimNo,
      parentClaimNo: claim.parentClaimNo,
      componentIds: [...claim.componentIds],
      connectionIds: [...claim.connectionIds],
      motionIds: [...claim.motionIds],
    })),
    improvements: [],
    metadata: { model: config.model, elapsedMs: 1 },
  };
}

test('最终验证：权利要求数量不等于 ClaimPlan 时不得导出', async () => {
  const context = contextFixture();
  const polished = polishedFixture(context);
  polished.claims = polished.claims.slice(0, -1);
  const result = await validateFinalDocument(polished, context, config, new AbortController().signal);
  expect(result.readyForExport).toBe(false);
  expect(result.validationIssues.some(issue => issue.id.startsWith('completeness-claims-count-'))).toBe(true);
});

test('最终验证：权利要求包含规划外部件时不得导出', async () => {
  const context = contextFixture();
  const polished = polishedFixture(context);
  polished.claimReferences[0].componentIds.push('C999');
  const result = await validateFinalDocument(polished, context, config, new AbortController().signal);
  expect(result.readyForExport).toBe(false);
  expect(result.validationIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'claim-plan-mismatch-1' }),
  ]));
});

test('最终验证：权利要求包含规划外连接或运动时不得导出', async () => {
  const context = contextFixture();
  const connectionCase = polishedFixture(context);
  connectionCase.claimReferences[0].connectionIds.push('R999');
  const connectionResult = await validateFinalDocument(connectionCase, context, config, new AbortController().signal);
  expect(connectionResult.readyForExport).toBe(false);
  expect(connectionResult.validationIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'claim-plan-mismatch-1' }),
  ]));

  const motionCase = polishedFixture(context);
  motionCase.claimReferences[0].motionIds = ['M999'];
  const motionResult = await validateFinalDocument(motionCase, context, config, new AbortController().signal);
  expect(motionResult.readyForExport).toBe(false);
  expect(motionResult.validationIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'claim-plan-mismatch-1' }),
  ]));
});

test('润色器：模型返回未建模结构时立即失败', async () => {
  const context = contextFixture();
  const plannedClaims = context.claimPlan.claims.map(claim => ({
    claimNo: claim.claimNo,
    parentClaimNo: claim.parentClaimNo,
    text: claim.claimNo === 1 ? '一种防护装置，其特征在于：壳体与支架连接。' : '根据权利要求1所述的防护装置，其特征在于：快拆罩沿支架移动。',
    componentIds: [...claim.componentIds],
    connectionIds: [...claim.connectionIds],
    motionIds: [...claim.motionIds],
  }));
  const draft: DocumentDraft = {
    version: 2,
    stage: 'draft',
    generatedAt: new Date().toISOString(),
    abstract: '一种防护装置。',
    claims: plannedClaims,
    technicalField: '机械装配技术领域。',
    background: '现有防护装置存在装配不便的问题。',
    content: { problemStatement: '装配不便。', technicalSolution: '壳体与支架连接。', innovationPoints: ['快拆罩'], benefits: '便于维护。' },
    drawings: '图1为整体结构示意图。',
    embodiment: '如图1所示，壳体与支架连接。',
    metadata: { model: config.model, promptTokens: 0, completionTokens: 0, elapsedMs: 0 },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as { messages?: Array<{ content?: string }> };
    const prompt = body.messages?.[0]?.content || '';
    let value: unknown;
    if (prompt.includes('权利要求改写专家')) value = { polished: plannedClaims, changes: '' };
    else if (prompt.includes('技术内容改写专家')) value = { polished: '技术方案中设有神秘槽，神秘槽用于排水。', changes: '' };
    else if (prompt.includes('摘要改写专家')) value = { polished: '一种防护装置，包括壳体、支架及快拆罩。', changes: '' };
    else if (prompt.includes('技术领域改写专家')) value = { polished: '本实用新型涉及机械装配技术领域。', changes: '' };
    else if (prompt.includes('背景技术改写专家')) value = { polished: '现有防护装置存在装配不便的问题。', changes: '' };
    else if (prompt.includes('附图说明改写专家')) value = { polished: '图1为整体结构示意图。', changes: '' };
    else if (prompt.includes('具体实施方式改写专家')) value = { polished: '如图1所示，壳体与支架连接。', changes: '' };
    else throw new Error(`未识别的润色提示：${prompt.slice(0, 30)}`);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await expect(polishDocument(draft, context, config, new AbortController().signal, () => {})).rejects.toThrow('未建模结构');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
