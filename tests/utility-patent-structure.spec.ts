import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { structureLogPath } from '../server/structureLog';
import type { AddressInfo } from 'node:net';
import { createAiMiddleware } from '../server/drawingAi';
import { aiProviders, markProviderSucceeded } from '../server/aiSupport';
import { generateStructureDraft, handlePatentStructureRequest, INNOVATION_CANDIDATES_PATH, STRUCTURE_DRAFT_PATH } from '../server/patentStructureAi';
import { expandStructureProposal, proposalValidationErrors } from '../server/structureProposal';
import { STRUCTURE_EVIDENCE_PATH } from '../server/structureEvidenceAi';
import { STRUCTURE_ANSWERS_PATH } from '../server/structureAnswersAi';
import { generateStructureAnswers } from '../server/structureAnswersAi';
import { generateStructureSkeleton, STRUCTURE_SKELETON_PATH, structureSkeletonAttemptTimeoutMs } from '../server/structureSkeletonAi';
import { isStructureEvidenceSelection } from '../src/features/utility/structureEvidence';
import { isPatentStructureModel, patentStructureSource, buildPatentStructureModel, modelToComponents, getModelVersion } from '../src/features/utility/patentStructure';
import { CONTENT_MODEL_REVISION } from '../src/features/utility/contentDrawing';
import { actualFigureMarkers } from '../src/features/utility/figureConsistency';
import { compileStructureDraft } from '../src/features/utility/structureCompiler';
import { buildStructureDraftFromSkeleton, isEditableStructureSkeleton, skeletonValidationErrors } from '../src/features/utility/structureSkeleton';
import type { StructureDraft } from '../src/features/utility/structureDraft';
import { validatePatentConsistency } from '../src/features/utility/patentConsistency';
import type { InnovationNameCandidate, PatentStructureModel, ProductBrief } from '../src/features/utility/patentStructure';
import { providerResearchFixture } from './fixtures/research';
import { offlinePatentFetch } from './fixtures/verifiedPatentPage';
import { sampleSkeleton } from './fixtures/structureFlow';

const evidenceOptions = [
  { id: 'E01', category: 'component', label: '风筒与电机', detail: '风筒内安装电机', technicalMeaning: '确认部件' },
  { id: 'E02', category: 'relationship', label: '电机由风筒支承', detail: '电机连接风筒', technicalMeaning: '确认连接' },
  { id: 'E03', category: 'motion', label: '电机驱动叶轮', detail: '叶轮绕轴旋转', technicalMeaning: '确认驱动' },
  { id: 'E04', category: 'geometry', label: '圆管风筒', detail: '风筒可用圆管示意', technicalMeaning: '确认形状' },
  { id: 'E05', category: 'problem', label: '减少噪声', detail: '隔音散热待验证', technicalMeaning: '确认问题' },
] as const;
const confirmedEvidence = { version: 1 as const, options: [...evidenceOptions], selectedIds: evidenceOptions.slice(0, 4).map(option => option.id), confirmed: true };
const geometryAlternative = { id: 'G01', component: '支架', shape: 'box', description: '支架主体为平直长方体，连接位置仍可示意。', condition: '支架主体实际为平直矩形，创新点在连接而非曲面。' };
const geometryRevision = { component: '支架', shape: 'box', change: '将非关键曲面支架改为平直矩形支架，连接位置不变。', preservedInnovation: '快拆连接仍通过支架固定。', condition: '确认允许修改支架外形且快拆连接功能不受影响。' };

const brief: ProductBrief = { productName: '低噪轴流风机', introduction: '用于通风换气。', usageScene: '厂房和设备间。', existingStructure: '包括风筒、电机、叶轮和防护网。', existingFunctions: '电机带动叶轮旋转。' };
const candidate: InnovationNameCandidate = { id: 'N01', name: '一种具有电机隔音散热结构的轴流风机', innovationDirection: '隔音与散热协同结构', solvedProblem: '降低噪声并避免热量积聚。', coreInnovationStructure: '隔音罩、散热通道和连接支架组合。', mainComponents: ['风筒', '电机', '隔音罩', '散热通道'], implementation: '隔音罩固定在电机外侧，散热通道与风筒连通。' };
const model: PatentStructureModel = {
  version: 1, productTitle: candidate.name, technicalField: '风机结构技术领域', baseStructure: '风筒内安装电机和叶轮，外侧设置隔音散热机构。',
  components: [
    { id: 'C01', name: '风筒', kind: 'base', purpose: '形成气流通道。', position: '中心位置。', whyNeeded: '承载内部部件并引导气流。', geometry: { shape: 'tube', position: [0, 0, 0], size: [100, 300, 80], rotation: [0, 0, 0] } },
    { id: 'C02', name: '电机', kind: 'base', purpose: '驱动叶轮。', position: '风筒中部。', whyNeeded: '提供旋转动力。', geometry: { shape: 'cylinder', position: [0, 0, 100], size: [30, 80, 0], rotation: [0, 0, 0] } },
    { id: 'C03', name: '隔音罩', kind: 'innovation', purpose: '降低电机噪声。', position: '电机外侧。', whyNeeded: '围合电机并保留散热间隙。', geometry: { shape: 'box', position: [-45, -45, 60], size: [90, 90, 100], rotation: [0, 0, 0] } },
  ],
  connections: [
    { id: 'R01', from: 'C02', to: 'C01', relation: 'supported_by', description: '电机由风筒支承。' },
    { id: 'R02', from: 'C02', to: 'C03', relation: 'fixed_to', description: '隔音罩固定在电机外侧。' },
  ], motions: [{ id: 'M01', componentId: 'C02', drivenBy: 'C02', type: 'rotary', path: '绕轴线旋转。', purpose: '带动叶轮工作。' }],
  functions: ['通风换气。'], innovationPoints: ['隔音罩与散热间隙协同。'], problemSolved: '降低噪声并避免热量积聚。', workingPrinciple: '电机驱动叶轮旋转，气流经过风筒，隔音罩降低声能并通过间隙散热。',
  figureSpecs: [
    { id: 'F01', title: '整体结构示意图', kind: 'overall', componentIds: ['C01', 'C02', 'C03'], connectionIds: ['R01', 'R02'] },
    { id: 'F02', title: '侧向正投影', kind: 'side', componentIds: ['C01', 'C02', 'C03'], connectionIds: ['R01', 'R02'] },
    { id: 'F03', title: '隔音罩局部放大图', kind: 'detail', componentIds: ['C02', 'C03'], connectionIds: ['R02'] },
  ],
};
const draft: StructureDraft = {
  version: 1, title: candidate.name, technicalField: model.technicalField, baseStructure: model.baseStructure,
  components: model.components.map(c => ({ id: `D${c.id.slice(1)}`, name: c.name, kind: c.kind, purpose: c.purpose, position: c.position, whyNeeded: c.whyNeeded, geometry: c.geometry })),
  relationships: model.connections.map(r => ({ ...r, from: `D${r.from.slice(1)}`, to: `D${r.to.slice(1)}` })),
  motions: [
    { id: 'M01', componentId: 'D01', type: 'static', path: '固定于安装位置', purpose: '支撑结构' },
    { id: 'M02', componentId: 'D02', type: 'static', path: '固定于风筒', purpose: '驱动叶轮' },
    { id: 'M03', componentId: 'D03', type: 'static', path: '固定于电机外侧', purpose: '隔音' },
  ], innovationPoints: model.innovationPoints, problemSolved: model.problemSolved, workingPrinciple: model.workingPrinciple,
  nextDraftNumber: 4, nextModelNumber: 1,
};
const config = { baseUrl: 'https://provider.example/v1', apiKey: 'private-test-key', model: 'gpt-6', researchModel: 'gpt-6', fallbackModel: 'gpt-6-sol' };

// provider 冷却表是进程级共享状态：前一个用例的 429/401 会把主模型打进 5 分钟冷却，
// 使后续用例跳过主模型，产生「单独跑通过、整套跑失败」的假失败。每个用例前清除。
test.beforeEach(() => { for (const provider of aiProviders(config)) markProviderSucceeded(provider); });
const candidateEnvelope = { candidates: [candidate, { ...candidate, id: 'N02', name: '一种具有防护网清洁结构的轴流风机' }, { ...candidate, id: 'N03', name: '一种具有快速拆装风筒结构的轴流风机' }] };
const responseEnvelope = (value: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
const incompleteEnvelope = (reason: string, content = '{"options":[') => Response.json({ choices: [{ finish_reason: reason, message: { content } }] });
const stub = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch => async (url, init) => {
  // Research now verifies the original page with a separate, credential-free GET.
  // Model handlers still receive only model requests, preserving call assertions.
  if (init?.method === 'GET' && new URL(String(url)).origin === 'https://patents.google.com') return offlinePatentFetch(url, init);
  return handler(String(url), init);
};
const waitForAbort = (signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

async function runApi(fetcher: typeof fetch, path: string, body: unknown, settings = config) {
  const middleware = createAiMiddleware(settings, fetcher);
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
  try { return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}

test('集成：进度流报告重试与校验，失败返回错误事件；JSON 接口保持兼容', async () => {
  const middleware = createAiMiddleware(config, stub((_url, init) => {
    const { model } = JSON.parse(String(init?.body));
    return model === config.model ? incompleteEnvelope('length') : responseEnvelope({ options: evidenceOptions });
  }));
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${STRUCTURE_EVIDENCE_PATH}`;
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ profile: evidenceProfile }) });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.type === 'progress').map(event => event.step.label)).toEqual(expect.arrayContaining(['核对结构输入', '调用主模型', '重新请求完整输出', '切换备用模型', '核对结构资料']));
    expect(events.at(-1).type).toBe('result');
    expect(events.at(-1).data.options).toHaveLength(5);
    const failure = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({}) });
    const failureEvents = (await failure.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(failureEvents.at(-1)).toMatchObject({ type: 'error', error: { code: 'INVALID_INPUT' } });
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test('集成：模型尚未返回时客户端已收到真实进度事件', async () => {
  let release!: () => void;
  const blocked = new Promise<Response>(resolve => { release = () => resolve(responseEnvelope({ options: evidenceOptions })); });
  const middleware = createAiMiddleware(config, stub(() => blocked));
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${STRUCTURE_EVIDENCE_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ profile: evidenceProfile }),
    });
    reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('核对结构输入');
    release();
    let rest = '';
    while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    expect(rest).toContain('"type":"result"');
  } finally {
    release?.();
    await reader?.cancel().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test('结构流程：先检索再生成候选，服务端固定研究和设计模型', async () => {
  const calls: { path: string; model: string }[] = [];
  const response = await runApi(stub((url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ path: url.endsWith('/responses') ? 'responses' : 'chat', model: body.model });
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    return responseEnvelope(candidateEnvelope);
  }), INNOVATION_CANDIDATES_PATH, { ...brief, model: 'evil-model' });
  expect(response.status).toBe(200);
  expect(calls).toEqual([{ path: 'responses', model: 'gpt-6' }, { path: 'chat', model: 'gpt-6' }]);
  expect((await response.json()).candidates).toHaveLength(3);
});

test('结构资料选项接口：五类齐全、严格拒绝重复编号和链接，不转发伪造模型', async () => {
  const profile = { company: '明远设备有限公司', business: '低噪轴流风机', product: '轴流风机防护罩', features: '螺栓连接板', excludedTerms: '', improvementType: 'structure' };
  let calls = 0;
  const fetcher = stub((_url, init) => {
    calls++;
    expect(JSON.parse(String(init?.body)).model).toBe(config.model);
    return responseEnvelope({ options: evidenceOptions });
  });
  const response = await runApi(fetcher, STRUCTURE_EVIDENCE_PATH, { profile, model: 'evil-model', apiKey: 'evil-key' });
  expect(response.status).toBe(200);
  expect((await response.json()).options).toHaveLength(5);
  expect(calls).toBe(1);
  for (const options of [[...evidenceOptions, { ...evidenceOptions[0] }], evidenceOptions.map((option, index) => index === 0 ? { ...option, detail: 'https://invalid.example' } : option)]) {
    const invalid = await runApi(stub(() => responseEnvelope({ options })), STRUCTURE_EVIDENCE_PATH, { profile });
    expect(invalid.status).toBe(502);
  }
});

const evidenceProfile = { company: '明远设备有限公司', business: '低噪轴流风机', product: '轴流风机防护罩', features: '螺栓连接板', excludedTerms: '', improvementType: 'structure' };

test('集成：结构资料 length 截断后在同一模型缩短输出重试一次', async () => {
  const requests: { model: string; max_completion_tokens: number; messages: { content: string }[] }[] = [];
  const response = await runApi(stub((_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1 ? incompleteEnvelope('length') : responseEnvelope({ options: evidenceOptions });
  }), STRUCTURE_EVIDENCE_PATH, { profile: evidenceProfile });
  expect(response.status).toBe(200);
  expect((await response.json()).options).toHaveLength(5);
  expect(requests.map(request => [request.model, request.max_completion_tokens])).toEqual([['gpt-6', 4000], ['gpt-6', 4500]]);
  expect(requests[1].messages[0].content).toContain('五类共5项');
});

test('集成：截断重试仍失败时切换备用模型，不采用部分 JSON', async () => {
  const calls: string[] = [];
  const response = await runApi(stub((_url, init) => {
    const request = JSON.parse(String(init?.body));
    calls.push(request.model);
    return incompleteEnvelope('length');
  }), STRUCTURE_EVIDENCE_PATH, { profile: evidenceProfile });
  // 截断重试资格按 provider 独立：主备各自被请求两次，均因截断失败。
  expect(calls).toEqual(['gpt-6', 'gpt-6', 'gpt-6-sol', 'gpt-6-sol']);
  expect(response.status).toBe(502);
  expect((await response.json()).error.code).toBe('AI_INCOMPLETE');
});

test('集成：拒答、限流及无效 JSON 不触发截断重试', async () => {
  const cases = [
    Response.json({ choices: [{ finish_reason: 'content_filter', message: { refusal: 'private prompt', content: '{' } }] }),
    new Response('private response', { status: 429 }),
    incompleteEnvelope('stop'),
  ];
  for (const first of cases) {
    const calls: string[] = [];
    // 上一轮用例的 429 会把主 provider 打进 5 分钟冷却（进程级共享状态），
    // 使本轮跳过主模型。先清除冷却，保证每个用例都从主模型开始。
    markProviderSucceeded({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
    const response = await runApi(stub((_url, init) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request.model);
      return calls.length === 1 ? first : responseEnvelope({ options: evidenceOptions });
    }), STRUCTURE_EVIDENCE_PATH, { profile: evidenceProfile });
    expect(calls).toEqual(['gpt-6', 'gpt-6-sol']);
    expect(response.status).toBe(200);
    expect((await response.json()).providerModel).toBe('gpt-6-sol');
  }
});

test('集成：结构资料诊断仅记录脱敏模型、HTTP 状态和结束原因', async () => {
  const original = console.warn;
  const records: unknown[][] = [];
  console.warn = (...args: unknown[]) => { records.push(args); };
  try {
    const response = await runApi(stub(() => incompleteEnvelope('private finish reason', 'private prompt')), STRUCTURE_EVIDENCE_PATH, { profile: evidenceProfile });
    expect(response.status).toBe(502);
    expect(records).toEqual([
      ['structure-evidence completion', { model: 'gpt-6', httpStatus: 200, finishReason: 'unknown' }],
      ['structure-evidence completion', { model: 'gpt-6-sol', httpStatus: 200, finishReason: 'unknown' }],
      // 接口失败统一落一行：只有路径、状态码、错误码、耗时，不含请求内容。
      ['api failure', { path: STRUCTURE_EVIDENCE_PATH, status: 502, code: 'AI_INCOMPLETE', elapsedMs: expect.any(Number), aborted: false }],
    ]);
    expect(JSON.stringify(records)).not.toContain('private');
    expect(JSON.stringify(records)).not.toContain(config.apiKey);
  } finally { console.warn = original; }
});

test('结构草案：未确认资料不调用 AI；补全后传入原文并仅检索一次', async () => {
  expect(isStructureEvidenceSelection(confirmedEvidence)).toBe(true);
  let calls = 0;
  const fetcher = stub((url, init) => {
    calls++;
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    const content = JSON.parse(String(init?.body)).messages[1].content;
    expect(content).toContain('电机驱动叶轮');
    expect(JSON.parse(content).brief.structureEvidence).toBeUndefined();
    return responseEnvelope({ draft });
  });
  const missing = await generateStructureDraft({ brief, candidate, requireEvidence: true }, config, new AbortController().signal, fetcher);
  expect(missing.status).toBe('needs_information');
  expect(calls).toBe(0);
  const result = await generateStructureDraft({ brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, config, new AbortController().signal, fetcher);
  expect(result.draft?.title).toBe(candidate.name);
  expect(calls).toBe(2);
});

test('集成：已确认的定向事实传给模型并参与来源校验，非法事实拒绝请求', async () => {
  const confirmedBrief = { ...brief, structureEvidence: confirmedEvidence, confirmedFacts: [{ question: '支架如何固定？', answer: '通过螺栓固定。' }] };
  const seen: unknown[] = [];
  const fetcher = stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    const context = JSON.parse(String(init?.body)).messages[1].content;
    seen.push(JSON.parse(context).verifiedFacts);
    return responseEnvelope({ draft });
  });
  const result = await generateStructureDraft({ brief: confirmedBrief, candidate, requireEvidence: true }, config, new AbortController().signal, fetcher);
  expect(seen).toEqual([confirmedBrief.confirmedFacts]);
  expect('source' in result && result.source).toBe(patentStructureSource(confirmedBrief, candidate));
  expect(patentStructureSource({ ...confirmedBrief, confirmedFacts: [] }, candidate)).not.toBe(patentStructureSource(confirmedBrief, candidate));
  const invalid = await runApi(fetcher, STRUCTURE_DRAFT_PATH, { brief: { ...confirmedBrief, confirmedFacts: [{ question: '支架如何固定？', answer: 'a'.repeat(1001) }] }, candidate, requireEvidence: true });
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).error.code).toBe('INVALID_INPUT');
  expect(seen).toHaveLength(1);
});

test('集成：建议答案仅使用选定资料，模型拟议与核验事实分开传递', async () => {
  const proposed = { question: '支架如何固定？', answer: '拟用螺栓连接。', origin: 'model_proposal' as const };
  const verified = { question: '壳体形状？', answer: '实物为圆管。' };
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence, confirmedFacts: [proposed, verified] }, candidate, questions: ['叶片如何运动？'] };
  let calls = 0;
  const fetcher = stub((_url, init) => {
    calls++;
    const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(context.verifiedFacts).toEqual([verified]);
    expect(context.adoptedProposals).toEqual([proposed]);
    expect(context.confirmedEvidence).toHaveLength(4);
    expect(context.questions).toEqual(input.questions);
    expect(context.brief.imageData).toBeUndefined();
    return responseEnvelope({ suggestions: [{ question: input.questions[0], answer: '拟由电机驱动绕轴旋转。', basis: 'proposed', rationale: '尚无实物依据。' }] });
  });
  const result = await runApi(fetcher, STRUCTURE_ANSWERS_PATH, input);
  expect(result.status).toBe(200);
  expect((await result.json()).suggestions[0].basis).toBe('proposed');
  expect(calls).toBe(1);
  const invalid = await runApi(fetcher, STRUCTURE_ANSWERS_PATH, { ...input, questions: ['同一问题', '同一问题'] });
  expect(invalid.status).toBe(400);
  expect(calls).toBe(1);
});

test('集成：建议答案缺项或对不上原问题时不接受', async () => {
  const input = { brief, candidate, questions: ['太阳轮如何连接？'] };
  await expect(generateStructureAnswers(input, config, new AbortController().signal,
    stub(() => responseEnvelope({ suggestions: [{ question: '另一问题', answer: '固定连接', basis: 'supported', rationale: '无依据' }] })))).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
});

test('集成：几何备选仅接受受支持形状和受限字段', async () => {
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const valid = await generateStructureDraft(input, config, new AbortController().signal,
    stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ status: 'unsupported', summary: '待核对', questions: ['是否符合？'], unsupportedReason: '未知曲面', geometryAlternatives: [geometryAlternative] })));
  expect(valid.status).toBe('unsupported');
  expect('geometryAlternatives' in valid && valid.geometryAlternatives).toEqual([geometryAlternative]);
  for (const alternative of [{ ...geometryAlternative, shape: 'sphere' }, { ...geometryAlternative, condition: '' }]) {
    const invalid = await runApi(stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ status: 'unsupported', summary: '待核对', questions: ['是否符合？'], unsupportedReason: '未知曲面', geometryAlternatives: [alternative] })), STRUCTURE_DRAFT_PATH, input);
    expect(invalid.status).toBe(502);
    expect((await invalid.json()).error.code).toBe('AI_INVALID_STRUCTURE');
  }
});

test('集成：骨架最小修改方案受校验，采纳后与核验事实分开传给模型', async () => {
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const proposal = { status: 'unsupported', summary: '曲面不可表达', questions: ['允许修改支架吗？'], unsupportedReason: '曲面不属于协议', geometryRevision };
  const result = await generateStructureSkeleton(input, config, new AbortController().signal, stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(context.brief.confirmedEvidence).toHaveLength(4);
    return responseEnvelope(proposal);
  }));
  expect(result).toMatchObject({ status: 'unsupported', geometryRevision });
  for (const bad of [{ ...geometryRevision, shape: 'freeform' }, { ...geometryRevision, preservedInnovation: '' }]) {
    const response = await runApi(stub(url => url.endsWith('/responses')
      ? Response.json(providerResearchFixture())
      : responseEnvelope({ ...proposal, geometryRevision: bad })), STRUCTURE_SKELETON_PATH, input);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('AI_INVALID_OUTPUT');
  }
  const adopted = { question: '拟议几何修改：支架', answer: '拟修改支架为平直矩形，保留快拆连接。', origin: 'model_proposal' as const };
  const verified = { question: '支架连接方式', answer: '螺栓固定。' };
  await generateStructureSkeleton({ ...input, brief: { ...input.brief, confirmedFacts: [verified, adopted] } }, config, new AbortController().signal, stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(context.brief.verifiedFacts).toEqual([verified]);
    expect(context.brief.adoptedProposals).toEqual([adopted]);
    return responseEnvelope(proposal);
  }));
  const cadOnly = await generateStructureSkeleton(input, config, new AbortController().signal, stub(url => url.endsWith('/responses')
    ? Response.json(providerResearchFixture())
    : responseEnvelope({
    status: 'unsupported', summary: '叶片关键曲面不可表达', questions: ['是否提供 CAD 图纸？'], unsupportedReason: '曲面本身是创新点',
  })));
  expect(cadOnly.status).toBe('unsupported');
  expect('geometryRevision' in cadOnly).toBe(false);
});

test('集成：骨架单模型预算不会过早截断且总时限仍可终止请求', async () => {
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  expect(structureSkeletonAttemptTimeoutMs(config)).toBe(85000);
  expect(structureSkeletonAttemptTimeoutMs({ ...config, secondFallbackModel: 'gpt-6-luna' })).toBe(80000);
  const calls: string[] = [];
  const fetcher = stub(async (url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    calls.push(JSON.parse(String(init?.body)).model);
    await new Promise(resolve => setTimeout(resolve, 25));
    return responseEnvelope({ status: 'ready', skeleton: sampleSkeleton(candidate.name) });
  });
  const result = await runApi(fetcher, STRUCTURE_SKELETON_PATH, input, { ...config, timeoutMs: 60 });
  expect(result.status).toBe(200);
  expect((await result.json()).status).toBe('ready');
  expect(calls).toEqual(['gpt-6']);

  const timedOut = await runApi(fetcher, STRUCTURE_SKELETON_PATH, input, { ...config, timeoutMs: 6 });
  expect(timedOut.status).toBe(504);
  expect((await timedOut.json()).error.code).toBe('AI_TOTAL_TIMEOUT');
});

test('集成：主模型返回骨架协议错误后切换备用模型且不采用非法结果', async () => {
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const calls: string[] = [];
  const invalidSkeleton = { ...sampleSkeleton(candidate.name), relationships: [] };
  const response = await runApi(stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    const request = JSON.parse(String(init?.body));
    calls.push(request.model);
    return request.model === config.model
      ? responseEnvelope({ status: 'ready', skeleton: invalidSkeleton })
      : responseEnvelope({ status: 'ready', skeleton: sampleSkeleton(candidate.name) });
  }), STRUCTURE_SKELETON_PATH, input);
  expect(response.status).toBe(200);
  // 校验重试资格按 provider 独立：主模型先用掉自己的校验重试（仍返回非法骨架），
  // 之后才切换到备用模型并成功。
  expect(calls).toEqual([config.model, config.model, config.fallbackModel]);
  const result = await response.json();
  expect(result.status).toBe('ready');
  expect(result.providerModel).toBe(config.fallbackModel);
  expect(result.skeleton.relationships).toHaveLength(2);
  const requestId = response.headers.get('X-Structure-Request-Id');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
  const records = readFileSync(structureLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(record => record.requestId === requestId);
  expect(records.filter(record => record.stage === 'skeleton').map(record => [record.model, record.outcome])).toEqual([
    [config.model, 'AI_INVALID_OUTPUT'], [config.model, 'AI_INVALID_OUTPUT'], [config.fallbackModel, 'completed'],
  ]);
});

test('集成：未确认资料阻断；确认资料按 Research → Skeleton 顺序调用并可离线编译', async () => {
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const calls: Array<{ kind: 'research' | 'skeleton'; body: any }> = [];
  const fetcher = stub((url, init) => {
    const request = JSON.parse(String(init?.body));
    if (url.endsWith('/responses')) {
      calls.push({ kind: 'research', body: request });
      return Response.json(providerResearchFixture());
    }
    calls.push({ kind: 'skeleton', body: request });
    expect(request.max_completion_tokens).toBe(4000);
    const context = JSON.parse(request.messages[1].content);
    expect(context.brief.confirmedEvidence).toHaveLength(4);
    expect(context.brief.imageData).toBeUndefined();
    expect(context.research?.summary).toBeTruthy();
    expect(context.research?.sources).toEqual(expect.any(Array));
    return responseEnvelope({ status: 'ready', skeleton: sampleSkeleton(candidate.name) });
  });
  const missing = await generateStructureSkeleton({ brief, candidate, requireEvidence: true }, config, new AbortController().signal, fetcher);
  expect(missing.status).toBe('needs_information');
  expect(calls).toHaveLength(0);
  const result = await generateStructureSkeleton(input, config, new AbortController().signal, fetcher);
  expect(result.status).toBe('ready');
  expect(calls.map(call => call.kind)).toEqual(['research', 'skeleton']);
  expect(calls[0].body.input).toBeTruthy();
  if (result.status !== 'ready') throw new Error('expected ready');
  expect(result.research.summary).toBeTruthy();
  expect(result.research.sources.length).toBeGreaterThan(0);
  const assembled = buildStructureDraftFromSkeleton({ brief: input.brief, candidate, skeleton: result.skeleton });
  expect(assembled.success).toBe(true);
  if (assembled.success) {
    expect(compileStructureDraft(assembled.draft).success).toBe(true);
    expect(assembled.draft.components.map(component => component.geometry?.position)).toEqual([[0, 0, 0], [20, 0, 40], [15, -5, 100]]);
    expect(assembled.draft.components.map(component => component.position)).toEqual(['主体', '壳体上', '支架上']);
  }
  for (const invalid of [{ ...result.skeleton, relationships: [] }, { ...result.skeleton, subjectComponent: '不存在的主体' }, { ...result.skeleton, components: result.skeleton.components.map((part, i) => i === 0 ? { ...part, geometryShape: undefined, geometry: undefined } : part) }]) {
    expect(skeletonValidationErrors(invalid).length).toBeGreaterThan(0);
    const response = await runApi(stub(() => responseEnvelope({ status: 'ready', skeleton: invalid })), STRUCTURE_SKELETON_PATH, input);
    expect(response.status).toBe(502);
  }
  const editing = { ...result.skeleton, components: [...result.skeleton.components, { name: '', kind: 'base', purpose: '', position: '' }] };
  expect(isEditableStructureSkeleton(editing)).toBe(true);
  expect(skeletonValidationErrors(editing).length).toBeGreaterThan(0);
});

test('模型：光伏板以薄板为主体，配件不能替代主体', () => {
  const title = '一种带角部连接结构的光伏板';
  const skeleton = sampleSkeleton(title, '角部连接件');
  skeleton.visualSubject = '长方形薄板是整体可见主体';
  skeleton.subjectComponent = '光伏板体';
  skeleton.components[0] = { ...skeleton.components[0], name: '光伏板体', visualFeature: '长方形薄板，正面可见', geometry: { shape: 'box', position: [0, 0, 0], size: [120, 80, 4], rotation: [0, 0, 0] } };
  skeleton.components[1] = { ...skeleton.components[1], name: '边框', visualFeature: '沿板体边缘的细长框边', geometry: { shape: 'box', position: [0, 0, 4], size: [120, 3, 2], rotation: [0, 0, 0] } };
  // 角部连接件须落在边框上表面并与之接触，不能穿入边框内部，否则被 assemblyGeometryIssues
  // 判为穿插而拒绝编译。position 是旋转前的左下后角：边框 [0,0,4]+[120,3,2] 占 z 4→6，
  // 故连接件底面取 z=6（[0,0,6]+[9,8,3] 占 z 6→9），恰好贴合。
  skeleton.components[2] = { ...skeleton.components[2], visualFeature: '位于板角的小型连接件', geometry: { shape: 'box', position: [0, 0, 6], size: [9, 8, 3], rotation: [0, 0, 0] } };
  skeleton.relationships = [{ from: '光伏板体', to: '边框', relation: 'fixed_to', description: '边框固定在板体边缘' }, { from: '边框', to: '角部连接件', relation: 'fixed_to', description: '连接件安装在边框角部' }];
  expect(skeletonValidationErrors(skeleton)).toEqual([]);
  const assembled = buildStructureDraftFromSkeleton({ brief: { ...brief, productName: '光伏板' }, candidate: { ...candidate, name: title }, skeleton });
  expect(assembled.success).toBe(true);
  if (assembled.success) {
    const compiled = compileStructureDraft(assembled.draft);
    expect(compiled.success).toBe(true);
    if (compiled.success) {
      expect(compiled.model.components[0]).toMatchObject({ id: 'C01', name: '光伏板体', visualFeature: '长方形薄板，正面可见', geometry: { size: [120, 80, 4] } });
      expect(compiled.model.figureSpecs[0].componentIds).toContain('C01');
      expect(compiled.model.figureSpecs[2].componentIds).toContain('C03');
    }
  }
  expect(skeletonValidationErrors({ ...skeleton, subjectComponent: '边框', components: [skeleton.components[1], skeleton.components[0], skeleton.components[2]] })).not.toEqual([]);
  expect(skeletonValidationErrors({ ...skeleton, components: [{ ...skeleton.components[0], geometry: { ...skeleton.components[0].geometry!, size: [32, 24, 16] } }, ...skeleton.components.slice(1)] })).not.toEqual([]);
  expect(skeletonValidationErrors({ ...skeleton, components: [...skeleton.components.slice(0, 2), { ...skeleton.components[2], geometry: { ...skeleton.components[2].geometry!, size: [120, 70, 3] } }] })).toEqual(expect.arrayContaining([expect.stringContaining('投影过大')]));
  expect(skeletonValidationErrors({ ...skeleton, title: '一种带角部连接件的光伏板', components: [skeleton.components[2], skeleton.components[0], skeleton.components[1]], subjectComponent: '角部连接件' })).toEqual(expect.arrayContaining([expect.stringContaining('主体应为薄板板体')]));
  expect(skeletonValidationErrors({ ...skeleton, title: '一种光伏板边框连接件', subjectComponent: '角部连接件', components: [skeleton.components[2], skeleton.components[0], skeleton.components[1]] })).not.toEqual(expect.arrayContaining([expect.stringContaining('投影过大')]));
});

test('集成：检索 HTTP 400 记录固定分类并阻断结构草案生成', async () => {
  const original = console.warn;
  const records: unknown[][] = [];
  console.warn = (...args: unknown[]) => { records.push(args); };
  try {
    const fetcher = stub((url, init) => {
      if (url.endsWith('/responses')) {
        const model = JSON.parse(String(init?.body)).model;
        return model === config.model
          ? Response.json({ error: { type: 'invalid_request_error', message: `web_search tool unsupported: ${config.apiKey} ${candidate.name}` } }, { status: 400 })
          : Response.json({ error: { type: 'invalid_request_error', message: 'bad parameter' } }, { status: 400 });
      }
      return responseEnvelope({ draft });
    });
    const response = await runApi(fetcher, STRUCTURE_DRAFT_PATH, { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true });
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('RESEARCH_UNAVAILABLE');
    const requestId = response.headers.get('X-Structure-Request-Id');
    const entries = readFileSync(structureLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.requestId === requestId);
    expect(entries.filter(entry => entry.stage === 'research').map(entry => [entry.httpStatus, entry.failureKind])).toEqual([[400, 'unsupported_tool']]);
    expect(JSON.stringify(entries)).not.toContain(config.apiKey);
    expect(JSON.stringify(entries)).not.toContain(candidate.name);
    expect(JSON.stringify(records)).not.toContain(config.apiKey);
  } finally { console.warn = original; }
});

test('集成：简化结构草案由服务端生成编号和静止记录，仍经离线编译', async () => {
  const proposal = {
    version: 1, technicalField: draft.technicalField, baseStructure: draft.baseStructure,
    components: draft.components.map(({ name, kind, purpose, position, whyNeeded, geometry }) => ({ name, kind, purpose, position, whyNeeded, geometry })),
    relationships: draft.relationships.map(({ from, to, relation, description }) => ({ from: draft.components.find(component => component.id === from)!.name, to: draft.components.find(component => component.id === to)!.name, relation, description })),
    motions: [], innovationPoints: draft.innovationPoints, problemSolved: draft.problemSolved, workingPrinciple: draft.workingPrinciple,
  };
  const result = await generateStructureDraft({ brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, config, new AbortController().signal,
    stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ status: 'ready', proposal })));
  expect(result.draft.components.map(component => component.id)).toEqual(['D01', 'D02', 'D03']);
  expect(result.draft.motions.map(motion => motion.id)).toEqual(['M01', 'M02', 'M03']);
  expect(compileStructureDraft(result.draft).success).toBe(true);
});

test('集成：空创新点仅可由已确认候选中的同名结构补成拟议文字', async () => {
  const proposal = {
    version: 1, technicalField: draft.technicalField, baseStructure: draft.baseStructure,
    components: draft.components.map(({ name, kind, purpose, position, whyNeeded, geometry }) => ({ name, kind, purpose, position, whyNeeded, geometry })),
    relationships: draft.relationships.map(({ from, to, relation, description }) => ({ from: draft.components.find(component => component.id === from)!.name, to: draft.components.find(component => component.id === to)!.name, relation, description })),
    motions: [], innovationPoints: [], problemSolved: draft.problemSolved, workingPrinciple: draft.workingPrinciple,
  };
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const result = await generateStructureDraft(input, config, new AbortController().signal,
    stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ status: 'ready', proposal })));
  expect(result.draft.innovationPoints).toEqual([`拟议结构，待实物核对：${candidate.coreInnovationStructure}`]);
  expect(compileStructureDraft(result.draft).success).toBe(true);
  await expect(generateStructureDraft({ ...input, candidate: { ...candidate, coreInnovationStructure: '不关联现有部件的构造' } }, config, new AbortController().signal,
    stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ status: 'ready', proposal })))).rejects.toMatchObject({ code: 'AI_INVALID_STRUCTURE' });
});

test('集成：候选改进方向明确指向的既有部件可标记为创新结构', async () => {
  const proposal = {
    version: 1, technicalField: draft.technicalField, baseStructure: draft.baseStructure,
    components: draft.components.map(({ name, purpose, position, whyNeeded, geometry }) => ({ name, kind: 'base', purpose, position, whyNeeded, geometry })),
    relationships: draft.relationships.map(({ from, to, relation, description }) => ({ from: draft.components.find(component => component.id === from)!.name, to: draft.components.find(component => component.id === to)!.name, relation, description })),
    motions: [], innovationPoints: [], problemSolved: draft.problemSolved, workingPrinciple: draft.workingPrinciple,
  };
  const target = draft.components.find(component => component.kind === 'innovation')!.name;
  const chosen = { ...candidate, innovationDirection: `${target}连接结构`, coreInnovationStructure: `${target}的连接结构`, mainComponents: [target] };
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate: chosen, requireEvidence: true };
  const fetcher = stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ status: 'ready', proposal }));
  const result = await generateStructureDraft(input, config, new AbortController().signal, fetcher);
  expect(result.draft.components.filter(component => component.kind === 'innovation').map(component => component.name)).toEqual([target]);
  expect(result.draft.innovationPoints).toEqual([`拟议结构，待实物核对：${chosen.coreInnovationStructure}`]);
  expect(compileStructureDraft(result.draft).success).toBe(true);
  await expect(generateStructureDraft({ ...input, candidate: { ...chosen, innovationDirection: '未指明的改进方向' } }, config, new AbortController().signal, fetcher))
    .rejects.toMatchObject({ code: 'AI_INVALID_STRUCTURE' });
});

test('集成：简化草案缺失几何或驱动时不得编译', async () => {
  const base = {
    version: 1, technicalField: draft.technicalField, baseStructure: draft.baseStructure,
    components: draft.components.map(({ name, kind, purpose, position, whyNeeded, geometry }) => ({ name, kind, purpose, position, whyNeeded, geometry })),
    relationships: draft.relationships.map(({ from, to, relation, description }) => ({ from: draft.components.find(component => component.id === from)!.name, to: draft.components.find(component => component.id === to)!.name, relation, description })),
    motions: [], innovationPoints: draft.innovationPoints, problemSolved: draft.problemSolved, workingPrinciple: draft.workingPrinciple,
  };
  for (const proposal of [
    { ...base, components: base.components.map((component, index) => index === 0 ? { ...component, geometry: undefined } : component) },
    { ...base, motions: [{ component: '风筒', type: 'rotary', path: '转动', purpose: '通风' }] },
  ]) {
    let calls = 0;
    await expect(generateStructureDraft({ brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, config, new AbortController().signal,
      stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : (calls++, responseEnvelope({ status: 'ready', proposal }))))).rejects.toMatchObject({ code: 'AI_INVALID_STRUCTURE' });
    expect(calls).toBe(4);
  }
});

test('集成：简化草案缺少字段时返回具体路径并在原模型修复', async () => {
  const proposal = {
    version: 1, technicalField: draft.technicalField, baseStructure: draft.baseStructure,
    components: draft.components.map(({ name, kind, purpose, position, whyNeeded, geometry }) => ({ name, kind, purpose, position, whyNeeded, geometry })),
    relationships: draft.relationships.map(({ from, to, relation, description }) => ({ from: draft.components.find(component => component.id === from)!.name, to: draft.components.find(component => component.id === to)!.name, relation, description })),
    motions: [], innovationPoints: draft.innovationPoints, problemSolved: draft.problemSolved, workingPrinciple: draft.workingPrinciple,
  };
  let calls = 0;
  const result = await generateStructureDraft({ brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, config, new AbortController().signal, stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    calls++;
    if (calls === 2) expect(JSON.parse(String(init?.body)).messages[0].content).toContain('components[0].name');
    return responseEnvelope({ status: 'ready', proposal: calls === 1 ? { ...proposal, components: proposal.components.map((component, index) => index ? component : { ...component, name: '' }) } : proposal });
  }));
  expect(calls).toBe(2);
  expect(result.draft.components[0].name).toBe(proposal.components[0].name);
});

test('集成：已采纳问题重复出现时仅定向修复一次，不返回重复问题', async () => {
  const question = '支架如何固定？';
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence, confirmedFacts: [{ question, answer: '拟用螺栓固定。', origin: 'model_proposal' as const }] }, candidate, requireEvidence: true };
  let calls = 0;
  const response = await runApi(stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    calls++;
    if (calls === 2) expect(JSON.parse(String(init?.body)).messages[0].content).toContain('问题均已有采纳答案');
    return responseEnvelope({ status: 'needs_information', summary: '需核对连接', questions: [question] });
  }), STRUCTURE_DRAFT_PATH, input);
  expect(calls).toBe(4);
  expect(response.status).toBe(502);
  const body = await response.json();
  expect(body.error.code).toBe('AI_INVALID_STRUCTURE');
  expect(body.error.details).toContain('needs_information 中的问题均已有采纳答案；请依据 adoptedProposals 生成 ready 草案，或明确返回 unsupported；若仍缺事实，请提出不同的具体问题。');
});

test('集成：第三轮按驱动校验反馈修复后生成可编译模型', async () => {
  const proposal = {
    version: 1, technicalField: draft.technicalField, baseStructure: draft.baseStructure,
    components: draft.components.map(({ name, kind, purpose, position, whyNeeded, geometry }) => ({ name, kind, purpose, position, whyNeeded, geometry })),
    relationships: draft.relationships.map(({ from, to, relation, description }) => ({ from: draft.components.find(component => component.id === from)!.name, to: draft.components.find(component => component.id === to)!.name, relation, description })),
    motions: [], innovationPoints: draft.innovationPoints, problemSolved: draft.problemSolved, workingPrinciple: draft.workingPrinciple,
  };
  let calls = 0;
  const result = await generateStructureDraft({ brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, config, new AbortController().signal,
    stub((url, init) => {
      if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
      calls++;
      if (calls === 3) expect(JSON.parse(String(init?.body)).messages[0].content).toContain('非static运动的drivenBy');
      return responseEnvelope({ status: 'ready', proposal: calls < 3 ? { ...proposal, motions: [{ component: proposal.components[0].name, type: 'rotary', drivenBy: proposal.components[0].name, path: '自转', purpose: '传动' }] } : proposal });
    }));
  expect(calls).toBe(3);
  expect(compileStructureDraft(result.draft).success).toBe(true);
});

test('集成：固定壳体可作为转动连接端点，行星运动件仍须明确驱动', () => {
  const names = ['壳体', '驱动电机', '输入轴', '太阳轮', '行星轮', '行星架', '固定内齿圈', '输出轴'];
  const proposal = {
    version: 1, technicalField: '齿轮传动机构', baseStructure: '拟议的固定内齿圈行星传动机构，待实物核对。',
    components: names.map((name, index) => ({ name, kind: index === 5 ? 'innovation' : 'base', purpose: '拟议传动', position: '拟议安装位置，待核对', whyNeeded: '形成传动路径', geometry: {
      shape: index === 3 || index === 4 ? 'spur_gear' : index === 6 ? 'ring_gear' : 'cylinder', position: [0, 0, index], size: index === 6 ? [2, 60, 10] : index === 3 || index === 4 ? [2, 20, 10] : [5, 20, 0], rotation: [0, 0, 0],
    } })),
    relationships: [
      { from: '壳体', to: '输入轴', relation: 'rotatably_connected', description: '壳体支承输入轴' },
      { from: '壳体', to: '驱动电机', relation: 'fixed_to', description: '电机固定于壳体' },
      { from: '输入轴', to: '驱动电机', relation: 'driven_by', description: '电机驱动输入轴' },
      { from: '输入轴', to: '太阳轮', relation: 'fixed_to', description: '同速旋转' },
      { from: '太阳轮', to: '行星轮', relation: 'connected_to', description: '啮合' },
      { from: '行星轮', to: '行星架', relation: 'rotatably_connected', description: '行星轮可在行星架上自转' },
      { from: '固定内齿圈', to: '壳体', relation: 'fixed_to', description: '齿圈固定' },
      { from: '行星轮', to: '固定内齿圈', relation: 'connected_to', description: '内啮合' },
      { from: '行星架', to: '输出轴', relation: 'fixed_to', description: '同速输出' },
    ],
    motions: [
      { component: '输入轴', type: 'rotary', drivenBy: '驱动电机', path: '绕轴旋转', purpose: '传动' },
      { component: '太阳轮', type: 'rotary', drivenBy: '输入轴', path: '绕轴旋转', purpose: '传动' },
      { component: '行星轮', type: 'rotary', drivenBy: '太阳轮', path: '自转和公转', purpose: '传动' },
      { component: '行星架', type: 'rotary', drivenBy: '行星轮', path: '绕轴旋转', purpose: '输出' },
      { component: '输出轴', type: 'rotary', drivenBy: '行星架', path: '绕轴旋转', purpose: '输出' },
    ], innovationPoints: ['拟议行星架输出'], problemSolved: '拟议减速', workingPrinciple: '拟议传动路径，待实物核对。',
  };
  expect(expandStructureProposal(proposal, candidate.name)).toBeDefined();
  expect(compileStructureDraft(expandStructureProposal(proposal, candidate.name)).success).toBe(true);
  expect(expandStructureProposal({ ...proposal, relationships: [
    ...proposal.relationships, { from: '驱动电机', to: '输入轴', relation: 'driven_by', description: '电机提供输入驱动' },
  ] }, candidate.name)).toBeDefined();
  expect(expandStructureProposal({ ...proposal, motions: proposal.motions.filter(motion => motion.component !== '行星轮') }, candidate.name)).toBeUndefined();
  expect(proposalValidationErrors({ ...proposal, motions: proposal.motions.filter(motion => motion.component !== '行星轮') })).toContain('运动部件或带运动连接的部件缺少 motions 记录及驱动部件：行星轮。');
  expect(proposalValidationErrors({ ...proposal, relationships: [{ from: '太阳', to: '行星轮', relation: 'meshes_with', description: '啮合' }, ...proposal.relationships] })[0]).toContain('from="太阳"、relation="meshes_with"');
});

test('集成：固定导向套和阀盖不因相对运动连接被误判为运动件', () => {
  const proposal = {
    version: 1, technicalField: '阀门结构技术领域', baseStructure: '阀体内设置导向套和阀芯，端部设置阀盖。',
    components: ['阀体', '导向套', '阀盖', '阀芯', '操作杆'].map((name, index) => ({
      name, kind: name === '阀芯' ? 'innovation' : 'base', purpose: `${name}的结构作用`, position: '拟议安装位置，待核对', whyNeeded: `设置${name}以形成阀门结构`,
      geometry: { shape: 'cylinder', position: [0, 0, index], size: [10, 30, 0], rotation: [0, 0, 0] },
    })),
    relationships: [
      { from: '导向套', to: '阀体', relation: 'fixed_to', description: '导向套固定安装于阀体内' },
      { from: '阀盖', to: '阀体', relation: 'fixed_to', description: '阀盖固定连接于阀体端部' },
      { from: '阀芯', to: '导向套', relation: 'slidably_connected', description: '阀芯沿导向套轴向往复移动' },
      { from: '阀芯', to: '操作杆', relation: 'driven_by', description: '操作杆驱动阀芯往复移动' },
    ],
    motions: [{ component: '阀芯', type: 'linear', drivenBy: '操作杆', path: '沿阀体轴向往复移动', purpose: '控制阀口启闭' }],
    innovationPoints: ['导向套与阀芯的配合结构'], problemSolved: '提高阀芯运动稳定性', workingPrinciple: '操作杆驱动阀芯沿导向套往复移动。',
  };
  expect(proposalValidationErrors(proposal)).toEqual([]);
  expect(expandStructureProposal(proposal, '一种阀芯导向结构')).toBeDefined();
});

test('集成：运动字段校验返回具体驱动、字段和自驱错误', () => {
  const base = {
    version: 1, technicalField: '机械结构技术领域', baseStructure: '主体与运动件构成结构。',
    components: ['主体', '滑块', '推杆'].map((name, index) => ({
      name, kind: name === '滑块' ? 'innovation' : 'base', purpose: '结构作用', position: '安装位置，待核对', whyNeeded: '形成结构',
      geometry: { shape: 'box', position: [index * 20, 0, 0], size: [10, 10, 10], rotation: [0, 0, 0] },
    })),
    relationships: [{ from: '滑块', to: '主体', relation: 'slidably_connected', description: '滑块相对主体移动' }],
    innovationPoints: ['滑块导向结构'], problemSolved: '改善运动', workingPrinciple: '推杆驱动滑块移动。',
  };
  expect(proposalValidationErrors({ ...base, motions: [{ component: '滑块', type: 'linear', path: '直线移动', purpose: '调节位置' }] })).toContain('motions[0].drivenBy：非static运动的drivenBy必须逐字引用另一个已有部件。');
  expect(proposalValidationErrors({ ...base, motions: [{ component: '滑块', type: 'linear', drivenBy: '滑块', path: '直线移动', purpose: '调节位置' }] })).toContain('motions[0].drivenBy 不能指向自身，必须填写非自身驱动部件。');
  expect(proposalValidationErrors({ ...base, motions: [{ component: '滑块', type: 'linear', drivenBy: '推杆', purpose: '调节位置' }] })).toContain('motions[0].path 须填写运动轨迹或固定状态。');
});

test('集成：无效草案的修复轮超时后由备用模型接手确定性修复', async () => {
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const calls: string[] = [];
  const result = await handlePatentStructureRequest(STRUCTURE_DRAFT_PATH, input, { ...config, timeoutMs: 300 }, new AbortController().signal,
    stub((url, init) => {
      if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
      const request = JSON.parse(String(init?.body));
      calls.push(request.model);
      if (calls.length === 1) return responseEnvelope({ draft: { ...draft, relationships: [] } });
      if (calls.length === 2) return waitForAbort(init!.signal!);
      expect(request.messages[0].content).toContain('连接关系不足');
      expect(JSON.parse(request.messages[1].content).previousDraft.relationships).toEqual([]);
      return responseEnvelope({ draft });
    }));
  expect(calls).toEqual(['gpt-6', 'gpt-6', 'gpt-6-sol']);
  expect('providerModel' in result && result.providerModel).toBe('gpt-6-sol');
  expect('draft' in result && compileStructureDraft(result.draft).success).toBe(true);
});

test('集成：真实叶轮遗漏运动记录时不自动视作静止部件', async () => {
  const proposal = {
    version: 1, technicalField: draft.technicalField, baseStructure: draft.baseStructure,
    components: draft.components.slice(0, 2).map(({ name, kind, purpose, position, whyNeeded, geometry }, index) => ({ name: index ? '叶轮' : name, kind: index ? 'innovation' : kind, purpose, position, whyNeeded, geometry })),
    relationships: [{ from: draft.components[0].name, to: '叶轮', relation: 'connected_to', description: '连接' }],
    motions: [], innovationPoints: draft.innovationPoints, problemSolved: draft.problemSolved, workingPrinciple: draft.workingPrinciple,
  };
  await expect(generateStructureDraft({ brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, config, new AbortController().signal,
    stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ status: 'ready', proposal })))).rejects.toMatchObject({ code: 'AI_INVALID_STRUCTURE' });
});

test('集成：诊断分类只记录白名单计数，不记录原始校验错误', async () => {
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const response = await runApi(stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ draft: { ...draft, components: draft.components.map((component, index) => index === 0 ? { ...component, geometry: { shape: 'gear', position: [0, 0, 0], size: [1, 1, 1], rotation: [0, 0, 0] } } : component) } })), STRUCTURE_DRAFT_PATH, input);
  expect(response.status).toBe(502);
  const requestId = response.headers.get('X-Structure-Request-Id');
  const records = readFileSync(structureLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(record => record.requestId === requestId);
  expect(records.filter(record => record.stage === 'draft' || record.stage === 'repair').map(record => record.validation)).toEqual([{ geometry: 1 }, { geometry: 1 }, { geometry: 1 }, { geometry: 1 }]);
  expect(JSON.stringify(records)).not.toContain(candidate.name);
  expect(JSON.stringify(records)).not.toContain(config.apiKey);
});

test('结构草案：明确无法表达关键几何时返回不支持，不调用通用兜底', async () => {
  let chatCalls = 0;
  const result = await generateStructureDraft({ brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, config, new AbortController().signal,
    stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : (chatCalls++, responseEnvelope({ status: 'unsupported', summary: '关键螺旋叶片无法用基础几何表达', questions: ['是否使用 CAD？'], unsupportedReason: '复杂曲面' }))));
  expect(result.status).toBe('unsupported');
  expect(result.draft).toBeUndefined();
  expect(chatCalls).toBe(1);
});

test('结构草案：鉴权失败不重复设计请求且保留错误分类', async () => {
  let chats = 0;
  await expect(generateStructureDraft({ brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, config, new AbortController().signal,
    stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : (chats++, new Response('', { status: 401 }))))).rejects.toMatchObject({ code: 'AI_AUTH' });
  expect(chats).toBe(1);
});

test('集成：STEP 02 检索限时直接终止结构生成，候选名称仍强制检索', async () => {
  const calls: string[] = [];
  const fetcher = stub((url, init) => {
    calls.push(url.endsWith('/responses') ? 'research' : 'draft');
    if (url.endsWith('/responses')) return waitForAbort(init!.signal!);
    return responseEnvelope({ draft });
  });
  await expect(handlePatentStructureRequest(STRUCTURE_DRAFT_PATH, { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, { ...config, timeoutMs: 160 }, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: 'AI_NETWORK' });
  expect(calls).toEqual(['research']);
  const candidateCalls: string[] = [];
  await expect(handlePatentStructureRequest(INNOVATION_CANDIDATES_PATH, brief, { ...config, timeoutMs: 30 }, new AbortController().signal, stub((url, init) => {
    candidateCalls.push(url);
    return waitForAbort(init!.signal!);
  }))).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  expect(candidateCalls).toHaveLength(1);
});

test('集成：单次草案超时切备用模型，失败日志仅含脱敏元数据', async () => {
  const original = console.warn;
  const records: unknown[][] = [];
  console.warn = (...args: unknown[]) => { records.push(args); };
  try {
    const calls: string[] = [];
    const result = await handlePatentStructureRequest(STRUCTURE_DRAFT_PATH, { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true }, { ...config, timeoutMs: 250 }, new AbortController().signal, stub((url, init) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request.model);
      if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
      return request.model === config.model ? waitForAbort(init!.signal!) : responseEnvelope({ draft });
    }));
    expect('providerModel' in result && result.providerModel).toBe(config.fallbackModel);
    expect(calls).toEqual(['gpt-6', 'gpt-6', 'gpt-6-sol']);
    expect(records).toEqual([
      ['patent-structure stage', { stage: 'research', model: 'gpt-6', httpStatus: 200, elapsedMs: expect.any(Number), outcome: 'completed', finishReason: 'unknown', failureKind: 'unknown' }],
      ['patent-structure stage', { stage: 'draft', model: 'gpt-6', httpStatus: null, elapsedMs: expect.any(Number), outcome: 'AI_ATTEMPT_TIMEOUT', finishReason: 'unknown', failureKind: 'unknown' }],
      ['ai provider failure', { host: 'provider.example', model: config.model, httpStatus: null, elapsedMs: expect.any(Number), error: 'Error(AI_ATTEMPT_TIMEOUT): 单次结构生成调用超时。' }],
      ['patent-structure stage', { stage: 'draft', model: 'gpt-6-sol', httpStatus: 200, elapsedMs: expect.any(Number), outcome: 'completed', finishReason: 'stop', failureKind: 'unknown' }],
    ]);
    expect(JSON.stringify(records)).not.toContain(config.apiKey);
    expect(JSON.stringify(records)).not.toContain(candidate.name);
  } finally { console.warn = original; }
});

test('集成：修复轮超时不因更早的校验错误而被误报为资料无效', async () => {
  // 首次尝试返回缺连接的草案 → lastValidationErrors 被填充；修复轮超时。
  // 修复前这里会落到 AI_INVALID_STRUCTURE（“资料生不出结构”），掩盖真实原因是模型超时。
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const calls: string[] = [];
  await expect(handlePatentStructureRequest(STRUCTURE_DRAFT_PATH, input, { ...config, timeoutMs: 250 }, new AbortController().signal,
    stub((url, init) => {
      if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
      calls.push(JSON.parse(String(init?.body)).model);
      if (calls.length === 1) return responseEnvelope({ draft: { ...draft, relationships: [] } });
      return waitForAbort(init!.signal!);
    }))).rejects.toMatchObject({ code: 'AI_MODEL_TIMEOUT' });
});

test('集成：全部草案调用超时与用户取消不进入修复或兜底', async () => {
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const calls: string[] = [];
  const fetcher = stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    calls.push(JSON.parse(String(init?.body)).model);
    return waitForAbort(init!.signal!);
  });
  await expect(handlePatentStructureRequest(STRUCTURE_DRAFT_PATH, input, { ...config, timeoutMs: 250 }, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: 'AI_MODEL_TIMEOUT' });
  expect(calls).toEqual(['gpt-6', 'gpt-6-sol']);
  const controller = new AbortController();
  let draftStarted!: () => void;
  const started = new Promise<void>(resolve => { draftStarted = resolve; });
  const cancelled = handlePatentStructureRequest(STRUCTURE_DRAFT_PATH, input, config, controller.signal, stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    calls.push(JSON.parse(String(init?.body)).model);
    draftStarted();
    return waitForAbort(init!.signal!);
  }));
  await started;
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ code: 'AI_CANCELLED' });
  expect(calls).toEqual(['gpt-6', 'gpt-6-sol', 'gpt-6']);
});

test('集成：请求总时限与单次超时分离，日志可按编号追踪且不含资料', async () => {
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const fetcher = stub((url, init) => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : waitForAbort(init!.signal!));
  const response = await runApi(fetcher, STRUCTURE_DRAFT_PATH, input, { ...config, timeoutMs: 250 });
  expect(response.status).toBe(504);
  expect((await response.json()).error.code).toBe('AI_MODEL_TIMEOUT');
  const requestId = response.headers.get('X-Structure-Request-Id');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
  const lines = readFileSync(structureLogPath, 'utf8').trim().split('\n');
  const records = lines.map(line => JSON.parse(line)).filter(record => record.requestId === requestId);
  expect(records.map(record => [record.stage, record.outcome])).toEqual([
    ['request', 'started'], ['research', 'completed'], ['draft', 'AI_ATTEMPT_TIMEOUT'], ['draft', 'AI_ATTEMPT_TIMEOUT'], ['request', 'AI_MODEL_TIMEOUT'],
  ]);
  expect(JSON.stringify(records)).not.toContain(config.apiKey);
  expect(JSON.stringify(records)).not.toContain(candidate.name);
  expect(JSON.stringify(records)).not.toContain(brief.productName);
  await expect(handlePatentStructureRequest(STRUCTURE_DRAFT_PATH, input, { ...config, timeoutMs: 30 }, new AbortController().signal, stub(async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return Response.json(providerResearchFixture());
  }))).rejects.toMatchObject({ code: 'AI_TOTAL_TIMEOUT' });
});

test('结构流程：检索失败阻断，不静默调用设计模型', async () => {
  let calls = 0;
  const response = await runApi(stub(() => { calls++; return new Response('rate limited', { status: 429 }); }), INNOVATION_CANDIDATES_PATH, brief);
  expect(response.status).toBe(429);
  expect(calls).toBe(2); // research primary then configured fallback
  expect((await response.json()).error.message).toContain('不会静默跳过检索');
});

test('AI 只生成结构草案，最终模型由离线编译器生成', async () => {
  const result = await generateStructureDraft({ brief, candidate }, config, new AbortController().signal, stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ draft })));
  expect(result.draft.components[2].id).toBe('D03');
  expect(JSON.stringify(result)).not.toContain('"model":');
  expect(compileStructureDraft(result.draft).success).toBe(true);
  await expect(generateStructureDraft({ brief, candidate }, config, new AbortController().signal, stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ draft: { ...draft, title: '不匹配的名称' } })))).rejects.toMatchObject({ code: 'AI_INVALID_STRUCTURE' });
});

test('结构草案部件为空时自动重试，不要求用户手动补录', async () => {
  let chatCalls = 0;
  const emptyDraft = { ...draft, components: [], relationships: [], motions: [] };
  const result = await generateStructureDraft({ brief, candidate }, config, new AbortController().signal, stub(url => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    chatCalls++;
    return responseEnvelope({ draft: chatCalls === 1 ? emptyDraft : draft });
  }));

  expect(chatCalls).toBe(2);
  expect(result.draft.components).toHaveLength(3);
  expect(compileStructureDraft(result.draft).success).toBe(true);
});

test('结构草案重试时把确定性校验错误反馈给模型', async () => {
  const prompts: string[] = [];
  const contexts: unknown[] = [];
  let chatCalls = 0;
  const emptyDraft = { ...draft, components: [], relationships: [], motions: [] };
  const result = await generateStructureDraft({ brief, candidate }, config, new AbortController().signal, stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    const request = JSON.parse(String(init?.body));
    prompts.push(request.messages[0].content);
    contexts.push(JSON.parse(request.messages[1].content));
    chatCalls++;
    return responseEnvelope({ draft: chatCalls === 1 ? emptyDraft : draft });
  }));

  expect(result.draft.title).toBe(candidate.name);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('草案至少需要一个部件');
  expect(prompts[1]).toContain('只修复下列问题');
  expect(contexts[0]).not.toHaveProperty('previousDraft');
  expect(contexts[1]).toHaveProperty('previousDraft.components');
});

test('集成：慢主备模型消耗预算后不继续发起修复请求', async () => {
  const calls: string[] = [];
  const input = { brief: { ...brief, structureEvidence: confirmedEvidence }, candidate, requireEvidence: true };
  const result = handlePatentStructureRequest(STRUCTURE_DRAFT_PATH, input, { ...config, secondFallbackModel: 'gpt-6-luna', timeoutMs: 150 }, new AbortController().signal, stub(async (url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    const modelName = JSON.parse(String(init?.body)).model;
    calls.push(modelName);
    if (modelName !== 'gpt-6-luna') return waitForAbort(init!.signal!);
    await new Promise(resolve => setTimeout(resolve, 30));
    return responseEnvelope({ draft: { ...draft, title: '错误名称' } });
  }));
  // With a 150 ms wall-clock budget, Windows scheduling can time out the final
  // provider before its invalid response arrives. Both outcomes must stop here;
  // the exact three-call assertion below rules out a subsequent repair request.
  await expect(result).rejects.toMatchObject({ code: expect.stringMatching(/^(AI_INVALID_STRUCTURE|AI_MODEL_TIMEOUT)$/) });
  expect(calls).toEqual(['gpt-6', 'gpt-6-sol', 'gpt-6-luna']);
});

for (const [type, label] of [['shape', '形状改进'], ['structure', '构造改进'], ['combined', '形状与构造结合']] as const) {
  test(`集成：${label}从结构请求传递到统一模型与局部图`, async () => {
    const prompts: string[] = [];
    const result = await generateStructureDraft({ brief: { ...brief, improvementType: type }, candidate }, config, new AbortController().signal, stub((url, init) => {
      if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
      const request = JSON.parse(String(init?.body));
      prompts.push(request.messages[0].content);
      expect(JSON.parse(request.messages[1].content).brief.improvementType).toBe(type);
      return responseEnvelope({ draft });
    }));
    expect(prompts[0]).toContain(`已确认改进类型：${label}`);
    expect(prompts[0]).toContain('既有部件标记为 innovation');
    expect(result.draft.improvementType).toBe(type);
    const compiled = compileStructureDraft(result.draft);
    expect(compiled.success).toBe(true);
    if (compiled.success) {
      expect(compiled.model.improvementType).toBe(type);
      expect(compiled.model.figureSpecs[2].componentIds).toContain(compiled.mapping.D03);
      expect(compiled.model.figureSpecs[2].highlightComponentIds).toContain(compiled.mapping.D03);
    }
  });
}

test('系统：已确认改进类型的无效草案不得采用固定兜底', async () => {
  let chatCalls = 0;
  await expect(generateStructureDraft({ brief: { ...brief, improvementType: 'shape' }, candidate }, config, new AbortController().signal, stub(url => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    chatCalls++;
    return responseEnvelope({ draft: { ...draft, components: [], relationships: [], motions: [] } });
  }))).rejects.toMatchObject({ code: 'AI_INVALID_STRUCTURE' });
  expect(chatCalls).toBe(4);
});

test('系统：AI 明确返回冲突改进类型时重试且不覆盖已确认类型', async () => {
  let chatCalls = 0;
  await expect(generateStructureDraft({ brief: { ...brief, improvementType: 'shape' }, candidate }, config, new AbortController().signal, stub(url => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    chatCalls++;
    return responseEnvelope({ draft: { ...draft, improvementType: 'structure' } });
  }))).rejects.toMatchObject({ code: 'AI_INVALID_STRUCTURE' });
  expect(chatCalls).toBe(4);
});

test('结构草案连续无效时不采用通用备用结构', async () => {
  let chatCalls = 0;
  const emptyDraft = { ...draft, components: [], relationships: [], motions: [] };
  await expect(generateStructureDraft({ brief, candidate }, config, new AbortController().signal, stub(url => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    chatCalls++;
    return responseEnvelope({ draft: emptyDraft });
  }))).rejects.toMatchObject({ code: 'AI_INVALID_STRUCTURE' });
  expect(chatCalls).toBe(4);
});

test('结构结果不合格时在原模型修复，不发送原草案给独立备用服务', async () => {
  const calls: { url: string; model: string; authorization: string }[] = [];
  const backupConfig = { ...config, fallbackBaseUrl: 'https://api.tu-zi.com/v1', fallbackApiKey: 'backup-private-key', fallbackModel: 'claude-opus-5-5' };
  const result = await generateStructureDraft({ brief, candidate }, backupConfig, new AbortController().signal, stub((url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, model: body.model, authorization: new Headers(init?.headers).get('Authorization') || '' });
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    return responseEnvelope({ draft: calls.length === 2 ? { ...draft, title: '不匹配名称' } : draft });
  }));
  expect(result.providerModel).toBe('gpt-6');
  expect(calls.map(call => `${call.url}:${call.model}`)).toEqual([
    'https://provider.example/v1/responses:gpt-6',
    'https://provider.example/v1/chat/completions:gpt-6',
    'https://provider.example/v1/chat/completions:gpt-6',
  ]);
  expect(calls[2].authorization).toBe('Bearer private-test-key');
});

test('实际附图标号与模型一致；篡改局部图标号或几何会报具体错误', () => {
  const components = modelToComponents(model).map(part => ({ ...part, name: part.name.replace(/^\d+、/u, '') }));
  const design = { revision: CONTENT_MODEL_REVISION, title: model.productTitle, source: 'test', generatedAt: '2026-09-23T00:00:00.000Z', components, detailPartId: 3, structureModel: model, sourceModelVersion: getModelVersion(model) };
  expect(model.figureSpecs.map(figure => figure.kind)).toEqual(['overall', 'side', 'detail']);
  expect(model.figureSpecs[2].componentIds).toContain('C03');
  expect(actualFigureMarkers(design, model)[2]).toEqual(model.figureSpecs[2].componentIds);
  expect(validatePatentConsistency({ model, design }).filter(issue => issue.severity === 'error')).toEqual([]);
  const noMarker = { ...model, figureSpecs: model.figureSpecs.map((figure, index) => index === 2 ? { ...figure, componentIds: ['C01'] } : figure) };
  expect(validatePatentConsistency({ model: noMarker, design: { ...design, structureModel: model } }).map(issue => issue.code)).toContain('FIGURE_MARKERS_MISMATCH');
  const wrongGeometry = { ...design, components: components.map((part, index) => index === 0 ? { ...part, position: [100, 0, 0] } : part) };
  expect(validatePatentConsistency({ model, design: wrongGeometry }).map(issue => issue.code)).toContain('DRAWING_GEOMETRY_MISMATCH');
});

test('手动模型不推断部件连接，也不默认末尾部件为创新部件', () => {
  const result = buildPatentStructureModel({ title: model.productTitle, technicalField: model.technicalField,
    structure: model.baseStructure, workingPrinciple: model.workingPrinciple, problemSolved: model.problemSolved,
    innovationName: '电机', connections: [{ from: 'C02', to: 'C01', relation: 'supported_by', description: '电机由风筒支撑。' }, { from: 'C03', to: 'C02', relation: 'fixed_to', description: '罩固定在电机上。' }],
    components: model.components.map(part => ({ name: part.name, geometry: part.geometry, purpose: part.purpose, whyNeeded: part.whyNeeded })) });
  expect(result.components.find(part => part.kind === 'innovation')?.id).toBe('C02');
  expect(result.connections.map(connection => [connection.from, connection.to])).toEqual([['C02', 'C01'], ['C03', 'C02']]);
  expect(result.components[0].whyNeeded).toBe(model.components[0].whyNeeded);
});

test('产品图片随设计请求发送，不将图片写入文本或候选来源；名称不一致的结构被拒绝', async () => {
  const imageBrief = { ...brief, imageData: `data:image/png;base64,${Buffer.from('test-image').toString('base64')}` };
  let imageUrl = '';
  const fetcher = stub((url, init) => {
    if (url.endsWith('/responses')) return Response.json(providerResearchFixture());
    const body = JSON.parse(String(init?.body));
    imageUrl = body.messages[1].content[1].image_url.url;
    expect(body.messages[1].content[0].text).not.toContain(imageBrief.imageData);
    return responseEnvelope(candidateEnvelope);
  });
  const response = await runApi(fetcher, INNOVATION_CANDIDATES_PATH, imageBrief);
  expect(response.status).toBe(200);
  expect(imageUrl).toBe(imageBrief.imageData);
  expect(JSON.stringify(await response.json())).not.toContain(imageBrief.imageData);
  await expect(generateStructureDraft({ brief, candidate }, config, new AbortController().signal,
    stub(url => url.endsWith('/responses') ? Response.json(providerResearchFixture()) : responseEnvelope({ draft: { ...draft, title: '一种不匹配的名称' } }))
  )).rejects.toMatchObject({ code: 'AI_INVALID_STRUCTURE' });
});

test('断开的部件与未绘出的部件不允许进入统一结构模型', () => {
  const disconnected = { ...model, connections: [model.connections[0]] };
  const noInnovationFigure = { ...model, figureSpecs: model.figureSpecs.map(figure => ({ ...figure, componentIds: ['C01', 'C02'] })) };
  expect(isPatentStructureModel(disconnected)).toBe(false);
  expect(isPatentStructureModel(noInnovationFigure)).toBe(false);
});
