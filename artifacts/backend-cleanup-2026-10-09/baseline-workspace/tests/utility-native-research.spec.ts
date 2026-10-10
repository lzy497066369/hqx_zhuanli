import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { researchPatents } from '../server/patentResearch';
import { parseAnthropicResearch, summarizeAnthropicToolResult } from '../server/researchProvider';
import type { NativeResearchDiagnostics } from '../server/researchProvider';
import { structureDiagnostic } from '../server/patentStructureAi';
import { flushStructureLog, structureLogPath } from '../server/structureLog';
import { generateDrawingPlan, readAiConfig } from '../server/drawingAi';
import { buildResearchEvidence, isEvidencePackage } from '../src/features/utility/patentEvidence';
import { extractResearchFacts, isPatentResearch } from '../src/features/utility/patentResearch';

const url = 'https://patents.google.com/patent/CN123456789U/zh';
const url2 = 'https://patents.google.com/patent/CN987654321U/zh';
const canonicalUrl = 'https://patents.google.com/patent/CN123456789U/en';
const canonicalUrl2 = 'https://patents.google.com/patent/CN987654321U/en';
const legacyUrl = 'https://www.google.com/patents/CN123456789U?oq=CN123456789U';
const legacyHttpUrl = 'http://www.google.com/patents/CN123456789U?cl=zh';
const input = { title: '机械防护罩', technicalField: '机械防护', structure: '', workingPrinciple: '', mode: 'concept' as const };
const config = { baseUrl: 'https://test.invalid/v1', apiKey: 'test-only', model: 'generation-model', researchModel: 'claude-opus-5-5', researchProtocol: 'anthropic' as const };
// Unit fixtures only. Never used by live tests or production.
const summary = '测试归纳：罩体连接在支架上；这里只讨论检索专利，不是用户结构。';
const citedText = 'SEARCH SNIPPET ONLY - not patent original';
const citedText2 = 'SECOND SEARCH SNIPPET ONLY - not patent original';
function native(options: { second?: boolean; citations?: Array<{ url: string; title: string; citedText?: string }>; summaryText?: string } = {}) {
  const citations = options.citations || [{ url, title: '测试防护罩', citedText }];
  const results = [...new Map(citations.map(item => [item.url, item])).values()];
  return { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [
    { type: 'server_tool_use', id: 'tool-1', name: 'web_search', input: { query: '防护罩 专利' } },
    { type: 'web_search_tool_result', tool_use_id: 'tool-1', content: results.map(item => ({ type: 'web_search_result', title: item.title, url: item.url })) },
    { type: 'text', text: options.summaryText || summary, citations: citations.map(item => ({ type: 'web_search_result_location', title: item.title, url: item.url, ...(item.citedText === undefined ? {} : { cited_text: item.citedText }) })) },
  ] };
}
const html = `<html><head><meta name="DC.title" content="测试防护罩"></head><body>
<dd itemprop="publicationNumber">CN123456789U</dd>
<section itemprop="abstract"><h2>Abstract</h2><div>测试原文：罩体与支架相连。</div></section>
<section itemprop="claims"><h2>Claims</h2><div>测试权利要求1。</div></section>
<section itemprop="description"><h2>Description</h2><div>测试说明书。</div></section></body></html>`;
const html2 = html.replaceAll('测试防护罩', '第二测试专利').replaceAll('CN123456789U', 'CN987654321U');
const pageResponse = (target = canonicalUrl) => new Response(target === canonicalUrl2 ? html2 : html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const diagnostics = (): NativeResearchDiagnostics => ({ searchActionCount: 0, searchResultCount: 0, qualifiedPatentResultCount: 0,
  queryCount: 0, coveredQueryCount: 0, citationCount: 0, originalPageCount: 0, verifiedSourceCount: 0, factCount: 0 });

test('生产 Research 解析失败阶段经诊断回调写入安全日志', async () => {
  const requestId = randomUUID();
  await expect(researchPatents(input, config, new AbortController().signal,
    async () => Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '无搜索结果' }] }),
    result => structureDiagnostic('research', result, requestId)))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  await flushStructureLog();
  const entries = readFileSync(structureLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.requestId === requestId);
  expect(entries).toEqual([expect.objectContaining({ stage: 'research', outcome: 'RESEARCH_UNVERIFIED', httpStatus: 200, failureStage: 'search-results' })]);
  expect(JSON.stringify(entries)).not.toContain('无搜索结果');
});

test('生产 Research 门禁日志保留精确原因和计数且不泄露响应正文', async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await expect(researchPatents(input, config, new AbortController().signal,
      async () => Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [
        { type: 'server_tool_use', id: 'tool-1', name: 'web_search', input: { query: 'PRIVATE_QUERY' } },
        { type: 'web_search_tool_result', tool_use_id: 'tool-1', content: [{ type: 'web_search_result', title: 'PRIVATE_TITLE', url: 'https://example.com/other' }] },
        { type: 'text', text: 'PRIVATE_RESPONSE' },
      ] }), result => structureDiagnostic('research', result)))
      .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  } finally {
    console.warn = originalWarn;
  }
  const gate = warnings.find(args => args[0] === 'research gate');
  expect(gate?.[1]).toEqual({
    failureStage: 'search-results', failureReason: 'PATENT_RESULTS_MISSING',
    searchActionCount: 1, searchResultCount: 1, qualifiedPatentResultCount: 0,
    queryCount: 1, coveredQueryCount: 0, citationCount: 0,
    originalPageCount: 0, verifiedSourceCount: 0, factCount: 0,
    toolResultDiagnostics: [expect.objectContaining({
      blockType: 'web_search_tool_result', toolUseIdPresent: true, toolUseIdLength: 6, toolUseIdMatched: true,
      contentType: 'array', contentIsArray: true, contentItemCount: 1,
      contentItemTypes: ['web_search_result'], toolResultErrorCodes: [], searchResultCount: 1,
      searchResultTypes: ['web_search_result'], searchResultHostnames: ['example.com'], searchResultPathnames: ['/other'],
    })],
  });
  expect(JSON.stringify(warnings)).not.toMatch(/PRIVATE_QUERY|PRIVATE_TITLE|PRIVATE_RESPONSE|test-only/);
});

test('原生工具结果诊断记录三条搜索结果及安全 URL 结构', () => {
  const observed = summarizeAnthropicToolResult({
    type: 'web_search_tool_result', tool_use_id: 'tool-123',
    content: [
      { type: 'web_search_result', title: '一', url: url },
      { type: 'web_search_result', title: '二', url: url2 },
      { type: 'web_search_result', title: '三', url: url },
    ],
  }, new Set(['tool-123']));
  expect(observed).toMatchObject({
    blockType: 'web_search_tool_result', toolUseIdPresent: true, toolUseIdLength: 8, toolUseIdMatched: true,
    contentType: 'array', contentIsArray: true, contentItemCount: 3, contentItemTypes: ['web_search_result', 'web_search_result', 'web_search_result'],
    toolResultErrorCodes: [], searchResultCount: 3, searchResultTypes: ['web_search_result', 'web_search_result', 'web_search_result'],
    searchResultHostnames: ['patents.google.com'], searchResultPathnames: ['/patent/CN123456789U/zh', '/patent/CN987654321U/zh'],
  });
  expect(observed.toolResultFailureReason).toBeUndefined();
});

test('content 为字符串时只增加 CONTENT_NOT_ARRAY 诊断，仍拒绝 TOOL_RESULT_INVALID', async () => {
  const payload = native();
  payload.content[1].content = 'PRIVATE_TOOL_RESULT';
  const observed = diagnostics();
  await expect(parseAnthropicResearch(payload, input, async () => { throw new Error('unexpected fetch'); }, new AbortController().signal, observed))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(observed).toMatchObject({ failureStage: 'tool-result', failureReason: 'TOOL_RESULT_INVALID', toolResultFailureReason: 'CONTENT_NOT_ARRAY' });
  expect(observed.toolResultDiagnostics).toEqual([expect.objectContaining({ contentType: 'string', contentIsArray: false, contentItemCount: 0, toolResultFailureReason: 'CONTENT_NOT_ARRAY' })]);
});

test('工具错误只记录 error_code，不改变 TOOL_RESULT_INVALID 拒绝', async () => {
  const payload = native();
  payload.content[1].content = [{ type: 'web_search_tool_result_error', error_code: 'unavailable', message: 'PRIVATE_ERROR_MESSAGE' }];
  const observed = diagnostics();
  await expect(parseAnthropicResearch(payload, input, async () => { throw new Error('unexpected fetch'); }, new AbortController().signal, observed))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(observed).toMatchObject({ failureStage: 'tool-result', failureReason: 'TOOL_RESULT_INVALID', toolResultFailureReason: 'TOOL_RESULT_ERROR' });
  expect(observed.toolResultDiagnostics?.[0]).toMatchObject({ toolResultErrorCodes: ['unavailable'], searchResultCount: 0, toolResultFailureReason: 'TOOL_RESULT_ERROR' });
  expect(JSON.stringify(observed)).not.toContain('PRIVATE_ERROR_MESSAGE');
});

test('工具 ID 不匹配只记录未匹配状态，保留现有 PATENT_RESULTS_MISSING 语义', async () => {
  const payload = native();
  payload.content[1].tool_use_id = 'unrelated';
  const observed = diagnostics();
  await expect(parseAnthropicResearch(payload, input, async () => { throw new Error('unexpected fetch'); }, new AbortController().signal, observed))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(observed).toMatchObject({ failureStage: 'search-results', failureReason: 'PATENT_RESULTS_MISSING', toolResultFailureReason: 'TOOL_USE_ID_MISMATCH' });
  expect(observed.toolResultDiagnostics?.[0]).toMatchObject({ toolUseIdPresent: true, toolUseIdLength: 9, toolUseIdMatched: false, searchResultCount: 1 });
  expect(observed.searchResultCount).toBe(0);
});

test('有效结果与工具错误混合时记录两类结构但仍拒绝', async () => {
  const payload = native();
  payload.content[1].content.push({ type: 'web_search_tool_result_error', error_code: 'unavailable', message: 'PRIVATE_ERROR_MESSAGE' });
  const observed = diagnostics();
  await expect(parseAnthropicResearch(payload, input, async () => { throw new Error('unexpected fetch'); }, new AbortController().signal, observed))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(observed).toMatchObject({ failureStage: 'tool-result', failureReason: 'TOOL_RESULT_INVALID', toolResultFailureReason: 'TOOL_RESULT_ERROR' });
  expect(observed.toolResultDiagnostics?.[0]).toMatchObject({ contentItemCount: 2, searchResultCount: 1, toolResultErrorCodes: ['unavailable'] });
});

test('空工具结果数组保持数组诊断且不会自动通过', async () => {
  const payload = native();
  payload.content[1].content = [];
  const observed = diagnostics();
  await expect(parseAnthropicResearch(payload, input, async () => { throw new Error('unexpected fetch'); }, new AbortController().signal, observed))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(observed).toMatchObject({ failureStage: 'search-results', failureReason: 'PATENT_RESULTS_MISSING' });
  expect(observed.toolResultDiagnostics?.[0]).toMatchObject({ contentType: 'array', contentIsArray: true, contentItemCount: 0, searchResultCount: 0 });
});

test('未知工具结果 item 只记录类型，不把它解释为搜索结果', () => {
  const observed = summarizeAnthropicToolResult({
    type: 'web_search_tool_result', tool_use_id: 'tool-1',
    content: [{ type: 'web_search_result', url }, { type: 'provider_internal_item', secret: 'PRIVATE_ITEM' }],
  }, new Set(['tool-1']));
  expect(observed).toMatchObject({ contentItemTypes: ['web_search_result', 'provider_internal_item'], searchResultCount: 1, toolResultFailureReason: 'UNKNOWN_CONTENT_ITEM' });
  expect(JSON.stringify(observed)).not.toContain('PRIVATE_ITEM');
});

test('历史形状的 11 条搜索结果记录数量且无工具错误', () => {
  const observed = summarizeAnthropicToolResult({
    type: 'web_search_tool_result', tool_use_id: 'historical-tool',
    content: Array.from({ length: 11 }, (_, index) => ({ type: 'web_search_result', url: `https://patents.google.com/patent/US${1000000 + index}A1/en` })),
  }, new Set(['historical-tool']));
  expect(observed.searchResultCount).toBe(11);
  expect(observed.toolResultErrorCodes).toEqual([]);
  expect(observed.searchResultHostnames).toEqual(['patents.google.com']);
});

test('历史形状的 unavailable 结果只被分类为工具错误，不推断其对应真实失败响应', () => {
  const observed = summarizeAnthropicToolResult({
    type: 'web_search_tool_result', tool_use_id: 'historical-tool',
    content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
  }, new Set(['historical-tool']));
  expect(observed).toMatchObject({ toolResultErrorCodes: ['unavailable'], searchResultCount: 0, toolResultFailureReason: 'TOOL_RESULT_ERROR' });
});

test('工具结果 URL 仅保留 hostname/pathname，不泄露凭据、查询、fragment 或完整 URL', () => {
  const sensitiveUrl = 'https://patents.google.com/patent/CN123456789U/en?api_key=SECRET_API_KEY&Authorization=Bearer_SECRET&Cookie=SECRET_COOKIE&token=SECRET_TOKEN#fragment';
  const observed = summarizeAnthropicToolResult({
    type: 'web_search_tool_result', tool_use_id: 'tool-sensitive',
    content: [{ type: 'web_search_result', url: sensitiveUrl }],
  }, new Set(['tool-sensitive']));
  const serialized = JSON.stringify(observed);
  expect(observed).toMatchObject({ searchResultHostnames: ['patents.google.com'], searchResultPathnames: ['/patent/CN123456789U/en'] });
  expect(serialized).not.toContain('SECRET_API_KEY');
  expect(serialized).not.toContain('Bearer_SECRET');
  expect(serialized).not.toContain('SECRET_COOKIE');
  expect(serialized).not.toContain('SECRET_TOKEN');
  expect(serialized).not.toContain('?api_key=');
  expect(serialized).not.toContain('#fragment');
  expect(serialized).not.toContain(sensitiveUrl);
});

test('未知 error_code 只记录脱敏占位符，不泄露供应商字段内容', () => {
  const observed = summarizeAnthropicToolResult({
    type: 'web_search_tool_result', tool_use_id: 'tool-sensitive-error',
    content: [{ type: 'web_search_tool_result_error', error_code: 'PRIVATE_PROVIDER_ERROR_TOKEN' }],
  }, new Set(['tool-sensitive-error']));
  expect(observed.toolResultErrorCodes).toEqual(['[unknown]']);
  expect(JSON.stringify(observed)).not.toContain('PRIVATE_PROVIDER_ERROR_TOKEN');
});

test('显式原生协议进入真实 Research caller，Search→页面→Fact→Evidence 不升级范围', async () => {
  const calls: string[] = [];
  const attempts: unknown[] = [];
  const research = await researchPatents(input, config, new AbortController().signal, async (target, init) => {
    calls.push(String(target));
    if (calls.length === 1) {
      expect(String(target)).toBe(config.baseUrl + '/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body.model).toBe(config.researchModel);
      expect(body.tools[0]).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 2, allowed_domains: ['patents.google.com'] });
      expect(body.response_format).toBeUndefined();
      expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
      return Response.json(native());
    }
    expect(String(target)).toBe(canonicalUrl);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(new Headers(init?.headers).has('x-api-key')).toBe(false);
    return pageResponse();
  }, attempt => attempts.push(attempt));
  expect(calls).toHaveLength(2);
  expect(attempts).toEqual([expect.objectContaining({ protocol: 'anthropic', searchActionCount: 1, originalPageCount: 1, outcome: 'completed' })]);
  const evidence = buildResearchEvidence(research);
  expect(isEvidencePackage(evidence)).toBe(true);
  expect(evidence.items).toHaveLength(1);
  expect(evidence.items[0]).toMatchObject({ evidenceScope: 'SEARCH_SNIPPET', status: 'INFERRED', originalText: citedText, citationId: expect.stringMatching(/^ANTHROPIC-CN123456789U-/), relatedComponentIds: [], relatedConnectionIds: [], relatedMotionIds: [] });
  expect(evidence.items[0].originalText).not.toContain(summary);
  expect(evidence.items[0].originalText).not.toContain('测试原文');
  // Existing validator still rejects all arbitrary original-text/SUPPORTED upgrades.
  for (const scope of ['PATENT_ABSTRACT', 'PATENT_CLAIMS', 'PATENT_ORIGINAL_TEXT']) {
    const forged = structuredClone(evidence);
    forged.items[0].evidenceScope = scope as typeof forged.items[0]['evidenceScope'];
    expect(isEvidencePackage(forged)).toBe(false);
  }
  const withoutCitationId = structuredClone(evidence);
  delete withoutCitationId.items[0].citationId;
  expect(isEvidencePackage(withoutCitationId)).toBe(false);
});

test('Anthropic 多来源 citation 分别验证页面并保留各自 snippet', async () => {
  const calls: string[] = [];
  const research = await parseAnthropicResearch(native({ citations: [
    { url, title: '测试防护罩', citedText },
    { url: url2, title: '第二测试专利', citedText: citedText2 },
  ] }), input, async target => {
    calls.push(String(target));
    return pageResponse(String(target));
  }, new AbortController().signal, diagnostics());
  expect(calls).toEqual([canonicalUrl, canonicalUrl2]);
  expect(research.sources.map(source => source.publication)).toEqual(['CN123456789U', 'CN987654321U']);
  expect(research.facts).toHaveLength(2);
  expect(research.facts).toEqual(expect.arrayContaining([
    expect.objectContaining({ publication: 'CN123456789U', sourceId: 'CN123456789U', originalText: citedText, evidenceScope: 'SEARCH_SNIPPET', citationId: expect.any(String) }),
    expect.objectContaining({ publication: 'CN987654321U', sourceId: 'CN987654321U', originalText: citedText2, evidenceScope: 'SEARCH_SNIPPET', citationId: expect.any(String) }),
  ]));
  const evidence = buildResearchEvidence(research);
  expect(isEvidencePackage(evidence)).toBe(true);
  expect(evidence.items).toHaveLength(2);
  expect(evidence.items.every(item => item.evidenceScope === 'SEARCH_SNIPPET' && item.status === 'INFERRED')).toBe(true);
});

test('有搜索动作但无合格专利结果时精确阻断，不访问页面', async () => {
  const payload = native();
  payload.content[1].content = [{ type: 'web_search_result', title: '其他来源', url: 'https://example.com/other' }];
  const observed = diagnostics();
  await expect(parseAnthropicResearch(payload, input, async () => { throw new Error('unexpected fetch'); }, new AbortController().signal, observed))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(observed).toMatchObject({ failureReason: 'PATENT_RESULTS_MISSING', searchActionCount: 1, searchResultCount: 1,
    qualifiedPatentResultCount: 0, queryCount: 1, coveredQueryCount: 0 });
});

test('有专利搜索结果但无匹配搜索动作时阻断，不访问页面', async () => {
  const payload = native();
  payload.content.shift();
  const observed = diagnostics();
  await expect(parseAnthropicResearch(payload, input, async () => { throw new Error('unexpected fetch'); }, new AbortController().signal, observed))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(observed).toMatchObject({ failureReason: 'SEARCH_ACTION_MISSING', searchActionCount: 0, qualifiedPatentResultCount: 0 });
});

test('多 query 中仅一条有合格专利结果时覆盖不足', async () => {
  const payload = native();
  payload.content.splice(2, 0, { type: 'server_tool_use', id: 'tool-2', name: 'web_search', input: { query: '另一个检索词' } },
    { type: 'web_search_tool_result', tool_use_id: 'tool-2', content: [{ type: 'web_search_result', title: '其他来源', url: 'https://example.com/other' }] });
  const observed = diagnostics();
  await expect(parseAnthropicResearch(payload, input, async () => { throw new Error('unexpected fetch'); }, new AbortController().signal, observed))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(observed).toMatchObject({ failureReason: 'QUERY_COVERAGE_INSUFFICIENT', searchActionCount: 2,
    searchResultCount: 2, qualifiedPatentResultCount: 1, queryCount: 2, coveredQueryCount: 1 });
});

test('citation 无法绑定真实搜索来源时明确标记映射失败', async () => {
  const payload = native();
  payload.content[2].citations![0].url = url2;
  const observed = diagnostics();
  await expect(parseAnthropicResearch(payload, input, async () => { throw new Error('unexpected fetch'); }, new AbortController().signal, observed))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(observed).toMatchObject({ failureStage: 'citation-mapping', failureReason: 'CITATION_MAPPING_FAILED',
    qualifiedPatentResultCount: 1, citationCount: 0, verifiedSourceCount: 0 });
});

test('未引用的助手正文不进入 Research 摘要或 Evidence', async () => {
  const unsafe = '未经引用的 CN987654321U 具有虚构连接。';
  const research = await parseAnthropicResearch(native({ summaryText: `${summary}\n${unsafe}`, citations: [{ url, title: '测试防护罩', citedText }] }), input,
    async target => pageResponse(String(target)), new AbortController().signal, diagnostics());
  expect(research.summary).toContain(citedText);
  expect(research.summary).not.toContain(unsafe);
  expect(research.summary).not.toContain(summary);
  expect(research.sources).toHaveLength(1);
  expect(buildResearchEvidence(research).items.map(item => item.originalText)).toEqual([citedText]);
});

test('超过五个引用时只保留前五个可归因来源及其事实', async () => {
  const citations = Array.from({ length: 7 }, (_, index) => ({
    url: `https://patents.google.com/patent/CN${100000000 + index}U/zh`,
    title: `测试专利 ${index}`,
    citedText: `来源 ${index} 的检索摘录`,
  }));
  const calls: string[] = [];
  const research = await parseAnthropicResearch(native({ citations }), input, async target => {
    calls.push(String(target));
    const publication = /\/patent\/(CN\d+U)\/en/.exec(String(target))?.[1];
    return new Response(html.replaceAll('CN123456789U', publication || ''), { headers: { 'content-type': 'text/html' } });
  }, new AbortController().signal, diagnostics());
  expect(calls).toHaveLength(5);
  expect(research.sources.map(source => source.publication)).toEqual(citations.slice(0, 5).map(item => /CN\d+U/.exec(item.url)![0]));
  expect(research.facts).toHaveLength(5);
  expect(isPatentResearch(research)).toBe(true);
  expect(isEvidencePackage(buildResearchEvidence(research))).toBe(true);
  expect(research.summary).not.toContain('来源 5');
});

test('引用摘录夹带另一公开号时不能归到当前来源', async () => {
  let calls = 0;
  await expect(parseAnthropicResearch(native({ citations: [{ url, title: '测试防护罩', citedText: `还包含 CN987654321U ${citedText}` }] }), input,
    async () => { calls++; return pageResponse(); }, new AbortController().signal, diagnostics()))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(calls).toBe(0);
});

test('独立相同摘录不合并来源；显式同一事实才传递全部来源和引用到 Evidence', () => {
  const first = { publication: 'CN123456789U', title: '测试防护罩', url: canonicalUrl, evidence: 'opened' as const };
  const second = { publication: 'CN987654321U', title: '第二测试专利', url: canonicalUrl2, evidence: 'opened' as const };
  const entries = [
    { source: first, citationId: 'CIT-A', citedText },
    { source: second, citationId: 'CIT-B', citedText },
  ];
  const independent = extractResearchFacts(entries);
  expect(independent).toHaveLength(2);
  expect(independent.map(fact => fact.sourceRefs)).toEqual([['CN123456789U'], ['CN987654321U']]);
  const grouped = extractResearchFacts(entries.map(entry => ({ ...entry, groupKey: 'explicit-shared-fact' })));
  expect(grouped).toHaveLength(1);
  expect(grouped[0]).toMatchObject({ sourceRefs: ['CN123456789U', 'CN987654321U'], citationRefs: ['CIT-A', 'CIT-B'], status: 'INFERRED' });
  const research = { query: '测试', queries: ['测试'], summary: '带引用的摘要', sources: [first, second], facts: grouped, searchedAt: '2026-10-07T00:00:00Z' };
  expect(isPatentResearch(research)).toBe(true);
  const evidence = buildResearchEvidence(research);
  expect(isEvidencePackage(evidence)).toBe(true);
  expect(evidence.items[0]).toMatchObject({ sourceRefs: ['CN123456789U', 'CN987654321U'], citationRefs: ['CIT-A', 'CIT-B'], evidenceScope: 'CITED_ASSISTANT_SUMMARY', status: 'INFERRED' });
  expect(isPatentResearch({ ...research, sources: [first] })).toBe(false);
  const forged = structuredClone(evidence);
  forged.items[0].sourceRefs = ['CN123456789U'];
  expect(isEvidencePackage(forged)).toBe(false);
});

test('同一来源相同 citation 去重，不同 cited_text 保留为独立 fact', async () => {
  const research = await parseAnthropicResearch(native({ citations: [
    { url, title: '测试防护罩', citedText },
    { url, title: '测试防护罩', citedText },
    { url, title: '测试防护罩', citedText: '同一来源的第二段摘要' },
  ] }), input, async target => pageResponse(String(target)), new AbortController().signal, diagnostics());
  expect(research.facts).toHaveLength(2);
  expect(research.facts?.map(fact => fact.originalText)).toEqual([citedText, '同一来源的第二段摘要']);
  expect(new Set(research.facts?.map(fact => fact.citationId)).size).toBe(2);
});

test('混合非专利 citation 被忽略，不会错误归因到专利', async () => {
  const payload = native({ citations: [{ url, title: '测试防护罩', citedText }] });
  payload.content[2].citations.push({ type: 'web_search_result_location', title: '普通网页', url: 'https://example.com/article' });
  const research = await parseAnthropicResearch(payload, input, async target => pageResponse(String(target)), new AbortController().signal, diagnostics());
  expect(research.facts).toHaveLength(1);
  expect(research.facts?.[0].publication).toBe('CN123456789U');
});

test('专利根域 citation 被忽略，合法专利 citation 仍完成页面核验', async () => {
  const payload = native({ citations: [{ url, title: '测试防护罩', citedText }] });
  payload.content[2].citations.push({ type: 'web_search_result_location', title: 'Google Patents', url: 'https://patents.google.com/' });
  const calls: string[] = [];
  const research = await parseAnthropicResearch(payload, input, async target => {
    calls.push(String(target));
    return pageResponse(String(target));
  }, new AbortController().signal, diagnostics());
  expect(calls).toEqual([canonicalUrl]);
  expect(research.facts).toHaveLength(1);
  expect(research.facts?.[0].publication).toBe('CN123456789U');
});

test('旧式 Google Patents citation 规范化后仍核验固定专利页面', async () => {
  const calls: string[] = [];
  const research = await parseAnthropicResearch(native({ citations: [{ url: legacyUrl, title: '测试防护罩', citedText }] }), input,
    async target => { calls.push(String(target)); return pageResponse(String(target)); }, new AbortController().signal, diagnostics());
  expect(calls).toEqual(['https://patents.google.com/patent/CN123456789U/en']);
  expect(research.sources).toEqual([expect.objectContaining({ publication: 'CN123456789U', url: canonicalUrl })]);
  expect(research.facts?.[0]).toMatchObject({ publication: 'CN123456789U', sourceUrl: canonicalUrl, evidenceScope: 'SEARCH_SNIPPET', status: 'INFERRED' });
});

test('供应商返回 HTTP 旧式 Google Patents citation 时仍只访问固定 HTTPS 专利页面', async () => {
  const calls: string[] = [];
  const research = await parseAnthropicResearch(native({ citations: [{ url: legacyHttpUrl, title: '测试防护罩', citedText }] }), input,
    async target => { calls.push(String(target)); return pageResponse(String(target)); }, new AbortController().signal, diagnostics());
  expect(calls).toEqual(['https://patents.google.com/patent/CN123456789U/en']);
  expect(research.sources[0]).toEqual(expect.objectContaining({ publication: 'CN123456789U', url: 'https://patents.google.com/patent/CN123456789U/en' }));
});

test('供应商返回本地化或高级检索 citation 时仍只访问固定 HTTPS 专利页面', async () => {
  for (const page of ['fi', 'ja', 'tr', 'adv_search.asp']) {
    const citationUrl = `https://patents.google.com/patent/CN123456789U/${page}`;
    const calls: string[] = [];
    const research = await parseAnthropicResearch(native({ citations: [{ url: citationUrl, title: '测试防护罩', citedText }] }), input,
      async target => { calls.push(String(target)); return pageResponse(String(target)); }, new AbortController().signal, diagnostics());
    expect(calls).toEqual(['https://patents.google.com/patent/CN123456789U/en']);
    expect(research.sources[0]).toEqual(expect.objectContaining({ publication: 'CN123456789U', url: 'https://patents.google.com/patent/CN123456789U/en' }));
  }
});

test('Research 协议只改变检索配置，不修改生成模型；错误协议失败关闭', () => {
  const value = readAiConfig({ AI_MODEL: 'generation', AI_RESEARCH_MODEL: 'research', AI_RESEARCH_PROTOCOL: 'anthropic' });
  expect(value.model).toBe('generation'); expect(value.researchModel).toBe('research'); expect(value.researchProtocol).toBe('anthropic');
  expect(readAiConfig({}).researchProtocol).toBe('responses');
  expect(() => readAiConfig({ AI_RESEARCH_PROTOCOL: 'guess' })).toThrow();
});

for (const mutation of ['missing-use', 'wrong-id', 'no-citation', 'unavailable', 'truncated', 'foreign-url', 'missing-cited-text', 'unsearched-patent', 'snippet-only'] as const) {
  test(`原生协议拒绝 ${mutation}，不抓取页面`, async () => {
    const payload = native();
    if (mutation === 'missing-use') payload.content.shift();
    if (mutation === 'wrong-id') payload.content[1].tool_use_id = 'unrelated';
    if (mutation === 'no-citation') payload.content[2].citations = [];
    if (mutation === 'unavailable') Object.assign(payload.content[1], { content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } });
    if (mutation === 'truncated') payload.stop_reason = 'max_tokens';
    if (mutation === 'foreign-url') payload.content[2].citations![0].url = 'https://attacker.invalid/patent/CN123456789U/zh';
    if (mutation === 'missing-cited-text') delete payload.content[2].citations![0].cited_text;
    if (mutation === 'unsearched-patent') payload.content[2].citations!.push({ ...payload.content[2].citations![0], url: url2 });
    if (mutation === 'snippet-only') payload.content[2].text = '';
    let calls = 0;
    await expect(parseAnthropicResearch(payload, input, async () => { calls++; return pageResponse(); }, new AbortController().signal, diagnostics()))
      .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
    expect(calls).toBe(0);
  });
}

for (const failure of ['403', 'network', 'redirect', 'wrong-publication', 'captcha', 'json', 'oversize', 'missing-claims'] as const) {
  test(`原文抓取失败 ${failure} → EVIDENCE_FETCH_FAILED，无设计调用/无 Word`, async () => {
    const calls: string[] = [];
    await expect(generateDrawingPlan(input, config, new AbortController().signal, async (target) => {
      calls.push(String(target));
      if (String(target) === config.baseUrl + '/messages') return Response.json(native());
      expect(String(target)).toBe(canonicalUrl);
      if (failure === 'network' || failure === 'redirect') throw new TypeError('network/redirect');
      if (failure === '403') return new Response('blocked', { status: 403 });
      if (failure === 'json') return Response.json({ text: html });
      return new Response(failure === 'captcha' ? '<html>verify identity</html>' : failure === 'wrong-publication' ? html.replace('CN123456789U', 'CN987654321U') : failure === 'oversize' ? 'x'.repeat(2 * 1024 * 1024 + 1) : html.replace('itemprop="claims"', 'itemprop="other"'), { headers: { 'content-type': 'text/html' } });
    })).rejects.toMatchObject({ code: 'EVIDENCE_FETCH_FAILED' });
    expect(calls).toEqual([config.baseUrl + '/messages', canonicalUrl]);
  });
}
