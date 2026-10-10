import { expect, test } from '@playwright/test';
import { generateNamingNames, generateNamingOptions } from '../server/namingAi';
import { aiProviders, markProviderSucceeded } from '../server/aiSupport';
import { emptyProfile } from '../src/features/utility/naming';

const config = { baseUrl: 'https://provider.example/v1', apiKey: 'server-secret', model: 'gpt-6-astra', fallbackModel: 'gpt-6-sol', secondFallbackModel: 'gpt-5.6-sol' };
// provider 冷却表是进程级共享状态：前一个用例的失败会把 provider 打进 5 分钟冷却，
// 使后续用例跳过它，产生「单独跑通过、整套跑失败」的假失败。每个用例前清除。
test.beforeEach(() => { for (const provider of aiProviders(config)) markProviderSucceeded(provider); });
const options = { options: ['H型钢梁', '槽钢柱', '角钢横梁', '钢梁固定件', '钢结构防护罩'].map(product => ({ product, features: ['H型截面', '螺栓连接板'] })) };
const names = { names: ['一种带螺栓连接板的H型钢梁', '一种带H型截面的H型钢梁', '一种H型截面与螺栓连接板组合的H型钢梁'] };
const envelope = (value: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });

test('集成：名称生成使用主模型，五个保护客体及三个名称受规则约束', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    calls.push(request.model);
    expect(String(init?.body)).not.toContain(config.apiKey);
    return envelope(calls.length === 1 ? options : names);
  };
  const offered = await generateNamingOptions({ company: '钢材公司', business: '钢材' }, config, new AbortController().signal, fetcher);
  expect(offered.options).toHaveLength(5);
  const named = await generateNamingNames({ profile: { ...emptyProfile, company: '钢材公司', business: '钢材', product: 'H型钢梁', features: 'H型截面、螺栓连接板' }, previous: [] }, config, new AbortController().signal, fetcher);
  expect(named.candidates).toHaveLength(3);
  expect(calls).toEqual(['gpt-6-astra', 'gpt-6-astra']);
});

test('系统：不合格模型输出不可采用，备用结果也要校验', async () => {
  const fetcher: typeof fetch = async () => envelope({ options: [{ product: '钢材', features: [] }] });
  await expect(generateNamingOptions({ company: '钢材公司', business: '钢材' }, config, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: 'AI_INVALID_OPTIONS' });
  const badNames: typeof fetch = async () => envelope({ names: ['一种高效H型钢梁', '一种数据处理方法', '一种钢结构'] });
  const recovered = await generateNamingNames({ profile: { ...emptyProfile, company: '钢材公司', business: '钢材', product: 'H型钢梁', features: 'H型截面' }, previous: [] }, config, new AbortController().signal, badNames);
  expect(recovered.candidates.length).toBeGreaterThanOrEqual(3);
  expect(recovered.candidates.every(candidate => candidate.name.includes('H型钢梁') && candidate.name.includes('H型截面'))).toBe(true);
  const unrelated: typeof fetch = async () => envelope({ names: ['一种带滑轨的H型钢梁', '一种带螺杆的H型钢梁', '一种带转轴的H型钢梁'] });
  const recoveredUnrelated = await generateNamingNames({ profile: { ...emptyProfile, company: '钢材公司', business: '钢材', product: 'H型钢梁', features: 'H型截面' }, previous: [] }, config, new AbortController().signal, unrelated);
  expect(recoveredUnrelated.candidates.length).toBeGreaterThanOrEqual(3);
  await expect(generateNamingNames({ profile: { ...emptyProfile, company: '钢材公司', business: '钢材', product: '钢结构', features: 'H型截面' }, previous: [] }, config, new AbortController().signal, async () => envelope(names))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('名称首轮不足三项时自动修复，并保持已选客体、特征和历史名称不变', async () => {
  const previous = ['一种带定位孔的H型钢梁'];
  const first = { names: ['一种带螺栓连接板的H型钢梁'] };
  const repaired = { names: [
    '一种带H型截面的H型钢梁',
    '一种带螺栓连接板的H型钢梁',
    '一种H型截面与螺栓连接板组合的H型钢梁',
  ] };
  const requests: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    const input = JSON.parse(request.messages[1].content);
    expect(input.product).toBe('H型钢梁');
    expect(input.features).toEqual(['H型截面', '螺栓连接板']);
    expect(input.previous).toEqual(previous);
    return envelope(requests.length === 1 ? first : repaired);
  };
  const result = await generateNamingNames({ profile: { ...emptyProfile, company: '钢材公司', business: '钢材', product: 'H型钢梁', features: 'H型截面、螺栓连接板' }, previous }, config, new AbortController().signal, fetcher);
  expect(result.candidates.map(candidate => candidate.name)).toEqual(repaired.names);
  expect(requests).toHaveLength(2);
  expect((JSON.parse((requests[1] as { messages: { content: string }[] }).messages[1].content)).previousDraft).toEqual(first.names);
});

test('名称自动修复仍不足三项时用已选特征本地补全，且超长资料提前提示不可满足', async () => {
  let calls = 0;
  const invalid: typeof fetch = async () => { calls += 1; return envelope({ names: ['一种带螺栓连接板的H型钢梁'] }); };
  const repairedLocally = await generateNamingNames({ profile: { ...emptyProfile, company: '钢材公司', business: '钢材', product: 'H型钢梁', features: 'H型截面' }, previous: [] }, config, new AbortController().signal, invalid);
  expect(repairedLocally.candidates.length).toBeGreaterThanOrEqual(3);
  expect(repairedLocally.candidates.every(candidate => candidate.name.includes('H型钢梁') && candidate.name.includes('H型截面'))).toBe(true);
  expect(calls).toBe(4);

  let called = false;
  const long: typeof fetch = async () => { called = true; return envelope(names); };
  await expect(generateNamingNames({ profile: { ...emptyProfile, company: '钢材公司', business: '钢材', product: '超长超复杂多层组合式钢梁连接定位安装组件', features: '具有多级导向限位和可调式螺栓连接板结构' }, previous: [] }, config, new AbortController().signal, long)).rejects.toMatchObject({ code: 'AI_NAME_LENGTH', message: /40字内/ });
  expect(called).toBe(false);
});

test('名称候选逐条筛选：不合格、重复和上批名称不导致整批被弃', async () => {
  const previous = ['一种带H型截面的H型钢梁'];
  const offered = { names: [
    '一种H型截面H型钢梁', '一种带螺栓连接板的H型钢梁', '一种H型截面与螺栓连接板组合的H型钢梁',
    '一种高效H型截面H型钢梁', '一种带H型截面的钢梁', '一种带H型截面的H型钢梁', '一种H型截面H型钢梁',
  ] };
  const profile = { ...emptyProfile, company: '钢材公司', business: '钢材', product: 'H型钢梁', features: 'H型截面、螺栓连接板' };
  const result = await generateNamingNames({ profile, previous }, config, new AbortController().signal, async () => envelope(offered));
  expect(result.providerModel).toBe(config.model);
  expect(result.candidates.map(candidate => candidate.name)).toEqual(offered.names.slice(0, 3));
});

test('产品选项逐项筛选，不把无效客体或特征交给名称页', async () => {
  const offered = { options: [
    { product: '数据处理方法', features: ['螺栓连接板', '定位孔'] },
    { product: '未识别到明确的产品客体', features: ['螺栓连接板', '定位孔'] },
    { product: '未识别到明确的产品客体连接组件', features: ['螺栓连接板', '定位孔'] },
    { product: '钢结构', features: ['H型截面', '螺栓连接板'] },
    { product: 'H型钢梁', features: ['定位孔', '高效节能', '待确认的连接板', '螺栓连接板', '定位孔'] },
    { product: '钢梁固定件', features: ['定位孔', '螺栓连接板'] },
    { product: '钢结构防护罩', features: ['定位孔', '螺栓连接板'] },
  ] };
  const result = await generateNamingOptions({ company: '钢材公司', business: '钢材' }, config, new AbortController().signal, async () => envelope(offered));
  expect(result.options.map(option => option.product)).toEqual(['H型钢梁', '钢梁固定件', '钢结构防护罩']);
  expect(result.options[0].features).toEqual(['定位孔', '螺栓连接板']);
});

test('同名客体的无效建议不阻挡后续有效特征', async () => {
  const offered = { options: [
    { product: 'H型钢梁', features: ['高效节能', '耐腐蚀'] },
    { product: 'H型钢梁', features: ['定位孔', '螺栓连接板'] },
    ...options.options.slice(1, 3),
  ] };
  const result = await generateNamingOptions({ company: '钢材公司', business: '钢材' }, config, new AbortController().signal, async () => envelope(offered));
  expect(result.options[0]).toEqual(offered.options[1]);
  expect(result.options).toHaveLength(3);
});
test('合格客体不足三组时使用备用模型，排除词在前后步骤一致', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    calls.push(request.model);
    expect(JSON.parse(request.messages[1].content).excludedTerms).toBe('钢梁固定件');
    return envelope(calls.length === 1 ? { options: [
      { product: '钢结构', features: ['定位孔', '螺栓连接板'] },
      { product: '钢梁固定件', features: ['定位孔', '螺栓连接板'] },
      { product: 'H型钢梁', features: ['定位孔', '螺栓连接板'] },
      { product: '钢结构防护罩', features: ['定位孔', '螺栓连接板'] },
    ] } : { options: [
      { product: 'H型钢梁', features: ['定位孔', '螺栓连接板'] },
      { product: '钢梁固定件', features: ['定位孔', '螺栓连接板'] },
      { product: '钢结构防护罩', features: ['定位孔', '螺栓连接板'] },
      { product: '钢材固定座', features: ['定位孔', '螺栓连接板'] },
    ] });
  };
  const result = await generateNamingOptions({ company: '钢材公司', business: '钢材', excludedTerms: '钢梁固定件' }, config, new AbortController().signal, fetcher);
  expect(result.options.map(option => option.product)).toEqual(['H型钢梁', '钢结构防护罩', '钢材固定座']);
  expect(result.providerModel).toBe(config.fallbackModel);
  expect(calls).toEqual([config.model, config.fallbackModel]);
});

test('集成：新实体名称和可核对的结构特征可直接进入选项', async () => {
  const concrete = { options: ['H型钢梁', '槽钢柱', '角钢横梁', '钢梁导轨', '钢构件防护罩']
    .map(product => ({ product, features: ['螺栓连接板', '定位孔'] })) };
  const result = await generateNamingOptions({ company: '钢材公司', business: '钢材' }, config, new AbortController().signal, async () => envelope(concrete));
  expect(result.options).toEqual(concrete.options);
});

test('成品选题保留产品本身，过滤光伏板配件及无纺布生产设备', async () => {
  const photovoltaic = { options: [
    { product: '光伏板边框连接件', features: ['边框角部卡槽', '紧固螺栓孔'] },
    ...['带安装边框的光伏板', '带背面支撑梁的光伏板', '带边缘定位槽的光伏板'].map(product => ({ product, features: ['边框定位槽', '背面支撑梁'] })),
  ] };
  const fetcher: typeof fetch = async () => envelope(photovoltaic);
  const result = await generateNamingOptions({ company: '光伏企业', business: '光伏板' }, config, new AbortController().signal, fetcher);
  expect(result.options).toHaveLength(3);
  expect(result.options.every(option => option.product.endsWith('光伏板'))).toBe(true);

  const fabric = { options: [
    { product: '无纺布生产设备', features: ['定位槽', '支撑板'] },
    ...['带网格压纹的无纺布', '双层复合无纺布', '带边缘折边的无纺布'].map(product => ({ product, features: ['网格压纹', '双层叠置'] })),
  ] };
  const fabrics = await generateNamingOptions({ company: '织物企业', business: '无纺布' }, config, new AbortController().signal, async () => envelope(fabric));
  expect(fabrics.options.map(option => option.product)).toEqual(fabric.options.slice(1).map(option => option.product));
});

test('光伏板名称拒绝序号、描述分句和转成连接件的标题', async () => {
  const profile = { ...emptyProfile, company: '光伏企业', business: '光伏板', product: '带安装边框的光伏板', features: '边框定位槽、背面支撑梁' };
  const offered = { names: [
    '1 一种带边框定位槽的带安装边框的光伏板',
    '一种带边框定位槽的带安装边框的光伏板，其边框设有紧固螺栓孔',
    '一种带边框定位槽的光伏板边框连接件',
    '一种带边框定位槽的带安装边框的光伏板',
    '一种设有背面支撑梁的带安装边框的光伏板',
    '一种边框定位槽与背面支撑梁组合的带安装边框的光伏板',
  ] };
  const result = await generateNamingNames({ profile, previous: [] }, config, new AbortController().signal, async () => envelope(offered));
  expect(result.candidates.map(candidate => candidate.name)).toEqual(offered.names.slice(3));
});

test('已细化的无纺布产品可以用简洁产品名称，仍需确认结构特征', async () => {
  const profile = { ...emptyProfile, company: '织物企业', business: '无纺布', product: '水刺无纺布', features: '网格压纹、双层叠置' };
  const offered = { names: ['一种水刺无纺布', '一种带网格压纹的水刺无纺布', '一种带双层叠置的水刺无纺布'] };
  const result = await generateNamingNames({ profile, previous: [] }, config, new AbortController().signal, async () => envelope(offered));
  expect(result.candidates.map(candidate => candidate.name)).toEqual(offered.names);
  expect(result.candidates[0].feature).toBe(profile.features);
});

test('集成：三类改进均传入名称生成，非法类型被拒绝', async () => {
  for (const [type, label] of [['shape', '形状改进'], ['structure', '构造改进'], ['combined', '形状与构造结合']] as const) {
    const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const input = JSON.parse(request.messages[1].content);
      expect(input.improvementType).toBe(label);
      return envelope(names);
    };
    const profile = { ...emptyProfile, company: '钢材公司', business: '钢材', product: 'H型钢梁', features: 'H型截面、螺栓连接板', improvementType: type };
    expect((await generateNamingNames({ profile, previous: [] }, config, new AbortController().signal, fetcher)).candidates).toHaveLength(3);
  }
  await expect(generateNamingNames({ profile: { ...emptyProfile, company: '钢材公司', business: '钢材', product: '钢结构', features: 'H型截面', improvementType: 'other' }, previous: [] }, config, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('系统：上游非 JSON 内容会尝试备用模型，并返回可恢复错误', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)).model);
    return calls.length === 1 ? Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] }) : envelope(options);
  };
  const result = await generateNamingOptions({ company: '钢材公司', business: '钢材' }, config, new AbortController().signal, fetcher);
  expect(result.providerModel).toBe('gpt-6-sol');
  expect(calls).toEqual(['gpt-6-astra', 'gpt-6-sol']);
  const invalid: typeof fetch = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] });
  await expect(generateNamingOptions({ company: '钢材公司', business: '钢材' }, config, new AbortController().signal, invalid)).rejects.toMatchObject({ code: 'AI_INVALID_JSON', status: 502 });
});

test('系统：前两级失败时使用第二备用模型并返回真实模型名', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model;
    calls.push(model);
    return model === 'gpt-5.6-sol' ? envelope(options) : new Response('unavailable', { status: 503 });
  };
  const result = await generateNamingOptions({ company: '钢材公司', business: '钢材' }, config, new AbortController().signal, fetcher);
  expect(calls).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol']);
  expect(result.providerModel).toBe('gpt-5.6-sol');
});

test('系统：主模型卡住时取消该尝试并给备用模型留出时间', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model;
    calls.push(model);
    if (model === config.model) return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return envelope(names);
  };
  const profile = { ...emptyProfile, company: '钢材公司', business: '钢材', product: 'H型钢梁', features: 'H型截面、螺栓连接板' };
  const result = await generateNamingNames({ profile, previous: [] }, { ...config, secondFallbackModel: '', timeoutMs: 100 }, new AbortController().signal, fetcher);
  expect(calls).toEqual([config.model, config.fallbackModel]);
  expect(result.providerModel).toBe(config.fallbackModel);
  expect(result.candidates).toHaveLength(3);
});

test('系统：两模型均卡住时返回明确的超时状态', async () => {
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const profile = { ...emptyProfile, company: '钢材公司', business: '钢材', product: 'H型钢梁', features: 'H型截面、螺栓连接板' };
  await expect(generateNamingNames({ profile, previous: [] }, { ...config, secondFallbackModel: '', timeoutMs: 100 }, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: 'AI_TIMEOUT', status: 504 });
});
