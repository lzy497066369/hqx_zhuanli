import { makeVerifiedCad } from './fixtures/productWorkflow';
import { test, expect } from '@playwright/test';
import { createProductWorkflowService, PRODUCT_PATHS } from '../server/productWorkflowAi';
import { createProductTextService } from '../server/productTextAi';
import { signProductArtifact } from '../server/productProof';
import { checkTechnicalPlan, frozenSourceVersion, isFrozenTechnicalSource, technicalPlanForWriting, textSourceVersion } from '../src/features/product/productText';
import { createProductWorkflow, isProductSelection, namingFingerprint } from '../src/features/product/productWorkflow';
import { isNamingRecord, emptyProfile } from '../src/features/utility/naming';
import type { NamingRecord } from '../src/features/utility/naming';
import { isProblemProposal } from '../src/features/product/productProblems';
import { makeReview, makeWorkflow, productProject, productSelection, productConfig, jsonEnvelope } from './fixtures/productWorkflow';
import { emptyTextReview, makeTechnicalPlan, makeTextDocument, makeTextBrief, makeTextDraft } from './fixtures/productText';

const base = makeTechnicalPlan();
const proposal = { product: productSelection.product, context: '', scenario: base.scenario,
  problems: [1, 2, 3].map(i => ({ id: `p${i}`, title: `位置调节问题${i}`, problem: i === 1 ? base.problem : `场景${i}下定位不便`,
    goal: base.goal, approach: '通过滑动导向及可解除的锁紧连接调节位置', suggestedName: productSelection.proposedName })) };
const selection = { ...productSelection, company: '', choices: [{ id: 'selected-problem', category: '技术问题', text: base.problem }],
  selectedProblem: { product: proposal.product, context: '', scenario: proposal.scenario, problem: proposal.problems[0] } };
const signal = () => new AbortController().signal;

test('产品名称直接生成问题，后端不转发密钥等额外字段，所选问题保持到结构阶段', async () => {
  const calls: any[] = [];
  const service = createProductWorkflowService(productConfig, async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(JSON.parse(request.messages[1].content));
    return jsonEnvelope(calls.length === 1 ? { scenario: proposal.scenario, problems: proposal.problems } : makeTechnicalPlan(selection));
  });
  const result = await service(PRODUCT_PATHS.problems, { product: proposal.product, context: '', apiKey: 'DO_NOT_FORWARD', baseUrl: 'DO_NOT_FORWARD' }, signal());
  expect(isProblemProposal(result)).toBe(true); expect(JSON.stringify(calls)).not.toContain('DO_NOT_FORWARD');
  expect(isProductSelection(selection)).toBe(true);
  await service(PRODUCT_PATHS.structure, { review: makeReview(selection) }, signal());
  expect(calls[1].selection.selectedProblem).toEqual(selection.selectedProblem);
  const changed = makeTechnicalPlan(selection); changed.problem = '换成另一个问题';
  expect(checkTechnicalPlan(changed, selection).join()).toContain('不能改题');
});

test('新选题保存和重载不需要伪造结构资料，问题变化会使工作区版本失效', () => {
  const naming: NamingRecord = { version: 1, profile: { ...emptyProfile, product: proposal.product, business: proposal.product, improvementType: 'structure' },
    candidates: [], selectedName: proposal.problems[0].suggestedName, confirmed: true, problemProposal: proposal, problemSelection: selection.selectedProblem };
  expect(isNamingRecord(JSON.parse(JSON.stringify(naming)))).toBe(true);
  const project = { ...productProject, naming, owner: '' };
  const workflow = createProductWorkflow(project);
  expect(isProductSelection(workflow.selection)).toBe(true); expect(workflow.selection.selectedProblem).toEqual(selection.selectedProblem);
  expect(workflow.selection.choices).toHaveLength(1); expect(naming.structureSelection).toBeUndefined();
  const next = structuredClone(project); next.naming.problemSelection!.problem = proposal.problems[1];
  expect(namingFingerprint(next)).not.toBe(workflow.sourceFingerprint);
});

test('格式修正带上上一轮输出，保留已正确的技术内容，文本请求设置轻量推理', async () => {
  const plan = makeTechnicalPlan(selection), wrong = structuredClone(plan); wrong.parts[0].parentId = '99';
  const requests: any[] = [];
  const service = createProductTextService({ ...productConfig, model: 'gpt-6.1-sol' }, async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    return jsonEnvelope(requests.length === 1 ? wrong : plan);
  });
  await service.structure(makeReview(selection), signal());
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[1].messages[1].content).correction.previousOutput).toEqual(wrong);
  expect(requests.every(r => r.reasoning_effort === 'low')).toBe(true);
  expect(requests[0].max_completion_tokens).toBe(9000);
});

test('v1冻结结构继续可读，旧版本校验仍能发现技术字段被修改', () => {
  const source = makeTextBrief().technicalSource!;
  source.version = textSourceVersion(technicalPlanForWriting(source.plan), '2026-10-14-v1');
  delete source.rulesVersion;
  expect(isFrozenTechnicalSource(source)).toBe(true); expect(frozenSourceVersion(source)).toBe(source.version);
  source.plan.parts[0].position += '新位置'; expect(isFrozenTechnicalSource(source)).toBe(false);
});

test('继续复核使用上次已修正文稿并验证签名，不能退回原始草稿', async () => {
  const workflow = makeWorkflow(true), brief = makeTextBrief();
  const original = makeTextDocument(), revised = structuredClone(original); revised.background = '已经修正并保留的背景技术内容。';
  const previous = signProductArtifact('materials', { briefId: brief.id, title: brief.design.title, abstract: revised.abstract,
    claims: revised.claims.map(c => `${c.number}. ${c.text}`), technicalField: revised.technicalField, background: revised.background,
    content: [revised.technicalProblem, revised.solution, ...revised.benefits].join('\n\n'), embodiment: [revised.embodiment, revised.operation].join('\n\n'),
    drawings: '图1为本产品的立体图。', createdAt: new Date().toISOString(), textRecord: { sourceVersion: brief.technicalSource!.version,
      draft: original, review: { ...emptyTextReview(), patches: [{ op: 'replace', path: '/background', value: revised.background }], unresolved: ['继续检查支持'] }, document: revised, status: 'needs_review' } }, productConfig);
  const { signature: _oldSignature, ...confirmationData } = workflow.confirmation!;
  const confirmation = signProductArtifact('confirmation', { ...confirmationData, briefId: brief.id }, productConfig);
  const inputs: any[] = [];
  const service = createProductWorkflowService(productConfig, async (_url, init) => { const body = JSON.parse(String(init?.body));
    if (body.messages[0].content.includes('独立图文核对员')) return jsonEnvelope({ passed: true, summary: '模拟最终图文核对', findings: [] });
    inputs.push(JSON.parse(body.messages[1].content)); return jsonEnvelope(emptyTextReview()); });
  const body = { brief, confirmation, cad: makeVerifiedCad(brief), draft: makeTextDraft(brief), previousMaterials: previous };
  const result: any = await service(PRODUCT_PATHS.materials, body, signal());
  expect(inputs).toHaveLength(1); expect(inputs[0].document.background).toBe(revised.background);
  expect(result.background).toBe(revised.background); expect(result.textRecord.status).toBe('completed');
  const tampered = structuredClone(previous); tampered.background = '篡改';
  await expect(service(PRODUCT_PATHS.materials, { ...body, previousMaterials: tampered }, signal())).rejects.toMatchObject({ code: 'PRODUCT_DOCUMENT_INVALID' });
});

test('旧实用新型入口统一进入项目管理弹窗，取消后留在项目管理', async ({ page }) => {
  await page.goto('/#utility');
  await expect(page).toHaveURL(/#projects\/all$/);
  await expect(page.getByRole('dialog', { name: '新建项目' })).toBeVisible();
  await expect(page.getByLabel('知识产权类型', { exact: true })).toHaveValue('utility');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '全部专利', exact: true })).toBeVisible();
  await expect(page.getByTestId('product-problem-naming')).toHaveCount(0);
});
