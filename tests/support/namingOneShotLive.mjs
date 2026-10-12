// 「一步定名」方案的真实评估脚本。付费调用，需显式开启：
//   RUN_NAMING_LIVE=1 node --experimental-strip-types --env-file-if-exists=.env.local tests/support/namingOneShotLive.mjs
// 或 npm run test:naming:live
//   可选：NAMING_LIVE_CASES=nonwoven,thermos 只跑指定案例；NAMING_LIVE_TIMEOUT_MS=300000 放宽总预算；
//         NAMING_LIVE_OUTPUT=artifacts/xxx 指定产物目录，默认按日期。
//
// 做什么：把新方案做成原型跑一遍，不改生产代码。
//   1. 用户定产品名 → 规则判断是否已是具体产品（材料、行业词、笼统词拦下，不调 AI）。
//   2. 一次 AI 调用出 5–8 个候选特点，每个带 label / detail / problem / question / improvementType。
//   3. 名字不再调 AI，用模板拼接后过现有 checkName 规则。
//   4. 换一批：带 previous 再调一次，看是否重复。
// 评什么：字段齐不齐、label 过不过结构词规则、problem 是不是空话、question 能不能看实物回答、
//   名字能不能拼出且落在 15–25 字、跨产品重复的 label（泛化信号）、每次调用耗时。
// 产物：artifacts/naming-oneshot-<日期>/report.md 与 report.json，原始模型输出一并保存供人工评价。
import fs from 'node:fs/promises';
import path from 'node:path';
import { readAiConfig } from '../../server/drawingAi.ts';
import { chatJson } from '../../server/patentStructureAi.ts';
import { AiFailure, aiProviders } from '../../server/aiSupport.ts';
import { checkName, checkProduct, countCharacters, isMaterialOrCategory, isStructuralFeature } from '../../src/features/utility/naming.ts';

if (process.env.RUN_NAMING_LIVE !== '1') throw new Error('Set RUN_NAMING_LIVE=1 explicitly to enable paid provider calls.');

const day = new Date().toISOString().slice(0, 10);
const root = path.resolve(process.env.NAMING_LIVE_OUTPUT || `artifacts/naming-oneshot-${day}`);
const workspace = process.cwd();
if (root !== workspace && !root.startsWith(workspace + path.sep)) throw new Error('Live test output must remain inside this workspace.');
await fs.mkdir(root, { recursive: true });

const config = readAiConfig(process.env);
// 评估时可临时放宽总预算（毫秒）。生产里取名预算固定 120 秒按三个模型均分，单次只有 36 秒。
if (Number(process.env.NAMING_LIVE_TIMEOUT_MS) > 0) config.timeoutMs = Number(process.env.NAMING_LIVE_TIMEOUT_MS);
const requests = [];
const fetcher = async (url, init) => {
  const payload = JSON.parse(init?.body || '{}');
  const entry = { model: payload.model, startedAt: new Date().toISOString() };
  requests.push(entry);
  const response = await fetch(url, init);
  entry.status = response.status;
  entry.completedAt = new Date().toISOString();
  return response;
};

// ---------- 原型提示词：一次出特点 ----------
const featurePrompt = `你是实用新型专利选题助手。输入是用户已确定的产品名 product，和可选的一句"哪里和别人不一样" hint。只依据这两项，提出 5 到 8 个候选结构特点，供用户核对后选用。
每个特点必须是该产品本体上、能画进黑白附图并标号的部件、形状或连接方式。不得是材料、工艺、尺寸参数、功能、效果、软件或宣传词。不得宣称用户实际具备该特点，这些只是待核对的假设。
hint 非空时，前 3 个特点必须围绕 hint 展开；hint 为空时给出该类产品常见且有实际技术效果的改进方向，彼此有实质差异，不要堆同类。不得重复 previous 中已有的 label。
每个特点输出五个字段：
label：进名字的名词短语，2 到 10 字，能直接嵌入"一种带{label}的{product}"，不以"的"结尾，不含标点。
detail：长什么样，看实物能对上，20 到 40 字，大白话。
problem：这样做是为了什么，10 到 30 字，说具体问题，不用"提高性能""更好"这类空话。
question：一个看实物就能回答是或否的核对问题，20 到 40 字，以"？"结尾，提到产品和特点。
improvementType：shape、structure 或 combined 之一。形状改进是外形或截面，构造改进是部件安排或连接，二者共同作用为 combined。
只返回纯 JSON：{"features":[{"label":"双层门板","detail":"门板分内外两层，中间留出空气层","problem":"减少热量从门板传导","question":"你的闸门门板是不是两层叠在一起、中间有空隙？","improvementType":"structure"}]}`;

const str = value => typeof value === 'string' ? value.trim() : '';
const isEnvelope = value => {
  const features = value?.features;
  return Array.isArray(features) && features.length >= 4 && features.length <= 10 &&
    features.every(f => f && ['label', 'detail', 'problem', 'question', 'improvementType'].every(key => str(f[key])));
};

async function proposeFeatures(product, hint, previous, onProgress) {
  const timeoutMs = config.timeoutMs ?? 120000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const attemptTimeoutMs = Math.max(1, Math.floor(timeoutMs * 0.9 / aiProviders(config).length));
  const started = Date.now();
  try {
    const result = await chatJson(featurePrompt, { product, hint, previous }, config, timeout, fetcher, 2000, undefined, isEnvelope, { attemptTimeoutMs, onProgress });
    return { features: result.value.features, model: result.model, elapsedMs: Date.now() - started, raw: result.value };
  } catch (error) {
    const code = error instanceof AiFailure ? error.code : error?.name || 'ERROR';
    return { features: [], model: null, elapsedMs: Date.now() - started, error: { code, message: error?.message || String(error) } };
  }
}

// ---------- 规则层：产品门禁、特点打分、模板拼名 ----------
function productGate(product) {
  const profile = { company: '评估用企业', business: product, product, features: '', excludedTerms: '' };
  const errors = [...new Set([...checkProduct(product), ...checkName(`一种${product}`, profile).errors])];
  return { concrete: !errors.length, material: isMaterialOrCategory(product), errors };
}

const emptyTalk = /提高性能|更好|更优|高效|节能|先进|美观|提升品质|优化$/u;
function scoreFeature(feature, product) {
  const issues = [];
  const label = str(feature.label), detail = str(feature.detail), problem = str(feature.problem), question = str(feature.question);
  if (!label) issues.push('label 为空');
  else {
    const n = countCharacters(label);
    if (n < 2 || n > 10) issues.push(`label ${n} 字，不在 2–10`);
    if (/[，。、；：！？,.;:!?]/u.test(label)) issues.push('label 含标点');
    if (label.endsWith('的')) issues.push('label 以"的"结尾');
    if (!isStructuralFeature(label)) issues.push('label 未过结构词规则');
  }
  if (!detail) issues.push('detail 为空');
  else if (countCharacters(detail) > 60) issues.push('detail 超 60 字');
  if (!problem) issues.push('problem 为空');
  else {
    if (countCharacters(problem) > 40) issues.push('problem 超 40 字');
    if (emptyTalk.test(problem)) issues.push('problem 是空话');
  }
  if (!question) issues.push('question 为空');
  else {
    if (!/[？?]$/u.test(question)) issues.push('question 不以问号结尾');
    if (!question.includes(product)) issues.push('question 未提到产品');
    if (countCharacters(question) > 60) issues.push('question 超 60 字');
  }
  if (!['shape', 'structure', 'combined'].includes(feature.improvementType)) issues.push('improvementType 非法');
  return issues;
}

const templates = product => [
  label => `一种带${label}的${product}`,
  label => `一种设有${label}的${product}`,
  label => `一种具有${label}的${product}`,
  label => `一种由${label}构成的${product}`,
  label => `一种${label}${product}`,
];
function buildName(product, label) {
  const profile = { company: '评估用企业', business: product, product, features: label, excludedTerms: '' };
  const tried = templates(product).map(make => { const name = make(label); return { name, check: checkName(name, profile) }; });
  const ok = tried.filter(item => !item.check.errors.length);
  const ideal = ok.find(item => item.check.length >= 15 && item.check.length <= 25) || ok[0];
  return {
    chosen: ideal ? { name: ideal.name, length: ideal.check.length, ideal: ideal.check.length >= 15 && ideal.check.length <= 25, warnings: ideal.check.warnings } : null,
    rejected: tried.filter(item => item.check.errors.length).map(item => ({ name: item.name, errors: item.check.errors })),
  };
}

// ---------- 案例 ----------
const cases = [
  { id: 'gate-no-hint', product: '闸门', hint: '', refresh: true },
  { id: 'gate-with-hint', product: '闸门', hint: '门板是两层的，中间留空，为了隔热' },
  { id: 'pv-panel', product: '光伏板', hint: '' },
  { id: 'nonwoven', product: '无纺布', hint: '' },
  { id: 'thermos', product: '保温杯', hint: '' },
  { id: 'steel-raw', product: '钢材', hint: '', expectGate: true },
  { id: 'generic-system', product: '智能控制系统', hint: '', expectGate: true },
];

const log = (label, detail) => console.log(`  ${label}: ${detail}`);
const only = (process.env.NAMING_LIVE_CASES || '').split(',').map(id => id.trim()).filter(Boolean);
const selected = only.length ? cases.filter(item => only.includes(item.id)) : cases;
const results = [];
for (const item of selected) {
  console.log(`\n== ${item.id} · ${item.product}${item.hint ? ` · 提示「${item.hint}」` : ''}`);
  const gate = productGate(item.product);
  const record = { ...item, gate, features: [], refresh: undefined };
  if (!gate.concrete) {
    console.log(`  规则拦下，未调用 AI：${gate.errors.join(' ')}`);
    results.push(record);
    continue;
  }
  const first = await proposeFeatures(item.product, item.hint, [], log);
  record.model = first.model; record.elapsedMs = first.elapsedMs; record.error = first.error; record.raw = first.raw;
  if (first.error) console.log(`  失败：${first.error.code} ${first.error.message}`);
  record.features = first.features.map(feature => {
    const issues = scoreFeature(feature, item.product);
    const naming = buildName(item.product, str(feature.label));
    return { ...feature, issues, naming };
  });
  for (const feature of record.features) {
    const flag = feature.issues.length ? `✗ ${feature.issues.join('；')}` : '✓';
    console.log(`  - ${feature.label} | ${feature.problem} | ${feature.naming.chosen?.name || '拼不出名字'} ${flag}`);
  }
  if (item.refresh && first.features.length) {
    const previous = first.features.map(feature => str(feature.label));
    console.log('  换一批（带 previous）…');
    const second = await proposeFeatures(item.product, item.hint, previous, log);
    const labels = second.features.map(feature => str(feature.label));
    const overlap = labels.filter(label => previous.includes(label));
    record.refresh = { model: second.model, elapsedMs: second.elapsedMs, error: second.error, labels, overlap, raw: second.raw };
    console.log(`  换一批得到 ${labels.length} 个，与首轮重复 ${overlap.length} 个${overlap.length ? `：${overlap.join('、')}` : ''}`);
  }
  results.push(record);
}

// ---------- 汇总 ----------
const ran = results.filter(record => record.gate.concrete);
const gated = results.filter(record => !record.gate.concrete);
const allFeatures = ran.flatMap(record => record.features.map(feature => ({ ...feature, product: record.product, caseId: record.id })));
const clean = allFeatures.filter(feature => !feature.issues.length);
const named = allFeatures.filter(feature => feature.naming.chosen);
const idealNamed = named.filter(feature => feature.naming.chosen.ideal);
const byLabel = new Map();
for (const feature of allFeatures) {
  const key = str(feature.label);
  if (!byLabel.has(key)) byLabel.set(key, new Set());
  byLabel.get(key).add(feature.product);
}
const generic = [...byLabel.entries()].filter(([, products]) => products.size >= 2).map(([label, products]) => ({ label, products: [...products] }));
const issueCounts = {};
for (const feature of allFeatures) for (const issue of feature.issues) issueCounts[issue.replace(/\d+ 字/u, 'N 字')] = (issueCounts[issue.replace(/\d+ 字/u, 'N 字')] || 0) + 1;
const gateExpectation = results.filter(record => record.expectGate).map(record => ({ id: record.id, product: record.product, gatedAsExpected: !record.gate.concrete }));
const totalElapsed = ran.reduce((sum, record) => sum + (record.elapsedMs || 0) + (record.refresh?.elapsedMs || 0), 0);
const summary = {
  day, model: config.model, cases: results.length, ran: ran.length, gated: gated.length, gateExpectation,
  requests: requests.length, totalElapsedMs: totalElapsed,
  features: allFeatures.length, featuresClean: clean.length, featureCleanRate: allFeatures.length ? +(clean.length / allFeatures.length).toFixed(2) : 0,
  named: named.length, namedIdealLength: idealNamed.length,
  genericLabels: generic, issueCounts,
  refresh: results.filter(record => record.refresh).map(record => ({ id: record.id, got: record.refresh.labels.length, overlap: record.refresh.overlap.length })),
  failures: ran.filter(record => record.error).map(record => ({ id: record.id, ...record.error })),
};

// ---------- 报告 ----------
const esc = text => String(text ?? '').replace(/\|/gu, '｜').replace(/\n/gu, ' ');
const lines = [];
lines.push(`# 一步定名方案 真实评估 ${day}`, '', `主模型 ${config.model}；${requests.length} 次上游请求；AI 总耗时 ${(totalElapsed / 1000).toFixed(1)} 秒。`, '');
lines.push('## 汇总', '', '| 指标 | 值 |', '|---|---|');
lines.push(`| 案例 | ${results.length}，其中 ${ran.length} 个调用了 AI，${gated.length} 个被规则拦下 |`);
lines.push(`| 门禁符合预期 | ${gateExpectation.every(item => item.gatedAsExpected) ? '是' : '否'}（${gateExpectation.map(item => `${item.product}:${item.gatedAsExpected ? '拦下' : '放行'}`).join('，')}） |`);
lines.push(`| 特点总数 | ${allFeatures.length} |`);
lines.push(`| 全部规则通过的特点 | ${clean.length}（${Math.round(summary.featureCleanRate * 100)}%） |`);
lines.push(`| 能拼出合格名字 | ${named.length}，其中 15–25 字 ${idealNamed.length} |`);
lines.push(`| 跨产品重复的 label | ${generic.length ? generic.map(item => `${item.label}（${item.products.join('、')}）`).join('；') : '无'} |`);
lines.push(`| 换一批重复 | ${summary.refresh.map(item => `${item.id}: ${item.overlap}/${item.got}`).join('；') || '未测'} |`);
lines.push(`| 失败 | ${summary.failures.length ? summary.failures.map(item => `${item.id} ${item.code}`).join('；') : '无'} |`);
if (Object.keys(issueCounts).length) {
  lines.push('', '问题分布：', '');
  for (const [issue, count] of Object.entries(issueCounts).sort((a, b) => b[1] - a[1])) lines.push(`- ${issue}：${count}`);
}
lines.push('', '## 各案例', '');
for (const record of results) {
  lines.push(`### ${record.product}${record.hint ? `，提示「${record.hint}」` : ''}`, '');
  if (!record.gate.concrete) { lines.push(`规则拦下，未调用 AI：${record.gate.errors.join(' ')}`, ''); continue; }
  lines.push(`模型 ${record.model || '无'}，耗时 ${((record.elapsedMs || 0) / 1000).toFixed(1)} 秒${record.error ? `，失败 ${record.error.code}：${record.error.message}` : ''}`, '');
  if (record.features.length) {
    lines.push('| # | label | 为了什么 | 核对问题 | 拼出的名字 | 字数 | 规则问题 |', '|---|---|---|---|---|---|---|');
    record.features.forEach((feature, index) => {
      lines.push(`| ${index + 1} | ${esc(feature.label)} | ${esc(feature.problem)} | ${esc(feature.question)} | ${esc(feature.naming.chosen?.name || '拼不出')} | ${feature.naming.chosen?.length ?? ''} | ${esc(feature.issues.join('；') || '无')} |`);
    });
    lines.push('', '长什么样：', '');
    record.features.forEach((feature, index) => lines.push(`${index + 1}. ${esc(feature.detail)}`));
    lines.push('');
  }
  if (record.refresh) {
    lines.push(`换一批：得到 ${record.refresh.labels.length} 个，与首轮重复 ${record.refresh.overlap.length} 个。新 label：${record.refresh.labels.join('、') || '无'}`, '');
  }
}
await fs.writeFile(path.join(root, 'report.md'), lines.join('\n'));
await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ summary, results, requests }, null, 2));
console.log(`\n${JSON.stringify(summary)}`);
console.log(`报告：${path.join(root, 'report.md')}`);
if (summary.failures.length) process.exitCode = 1;
