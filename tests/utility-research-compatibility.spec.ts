import { expect, test } from '@playwright/test';
import { generateDrawingPlan } from '../server/drawingAi';
import { researchPatents } from '../server/patentResearch';
import { parseOfflineResearch as parseResearch, offlinePatentFetch } from './fixtures/verifiedPatentPage';
import { buildResearchEvidence } from '../src/features/utility/patentEvidence';
import { providerResearchFixture } from './fixtures/research';

const input = { title: '可调节夹持装置', technicalField: '机械夹持', structure: '', workingPrinciple: '', mode: 'concept' as const };
const config = { baseUrl: 'https://research-test.invalid/v1', apiKey: 'unit-test-only', model: 'design-model', researchModel: 'claude-opus-5-5' };

for (const model of ['claude-opus-5-5', 'configured-responses-model']) {
  test(`Research 请求兼容 ${model}，仍要求真实工具来源和引用`, async () => {
    const research = await researchPatents(input, { ...config, researchModel: model }, new AbortController().signal, async (url, init) => {
      if (init?.method === 'GET') return offlinePatentFetch(url, init);
      expect(String(url)).toBe(`${config.baseUrl}/responses`);
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      expect(body.tool_choice).toBe(model.startsWith('claude-') ? 'auto' : 'required');
      expect(body.tools).toEqual([{ type: 'web_search', filters: { allowed_domains: ['patents.google.com'] } }]);
      expect(body.include).toEqual(['web_search_call.action.sources']);
      expect(body.stream).toBe(false);
      expect(body.messages).toBeUndefined();
      expect(body.response_format).toBeUndefined();
      return Response.json(providerResearchFixture());
    });
    const evidence = buildResearchEvidence(research);
    expect(evidence.items.length).toBeGreaterThan(0);
    expect(evidence.items.every(item => item.status === 'INFERRED' && item.evidenceScope === 'PATENT_ORIGINAL_TEXT')).toBe(true);
  });
}

test('Claude auto 返回 HTTP 200 但工具不可用时停止，不调用设计模型', async () => {
  const calls: string[] = [];
  await expect(generateDrawingPlan(input, config, new AbortController().signal, async (url, init) => {
    calls.push(String(url));
    expect(JSON.parse(String(init?.body)).tool_choice).toBe('auto');
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Web search is currently unavailable.' }] }] });
  })).rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
  expect(calls).toEqual([`${config.baseUrl}/responses`]);
});

test('auto 不允许仅凭模型生成的 URL 或引用冒充检索', async () => {
  const payload = providerResearchFixture();
  payload.output = payload.output.filter(item => item.type !== 'web_search_call');
  await expect(researchPatents(input, config, new AbortController().signal, async () => Response.json(payload)))
    .rejects.toMatchObject({ code: 'RESEARCH_UNVERIFIED' });
});

test('有检索来源但引用位置没有事实文本时拒绝空 Evidence', async () => {
  const payload = providerResearchFixture();
  for (const item of payload.output) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) Object.assign(annotation, { start_index: 0, end_index: 0 });
    }
  }
  await expect(parseResearch(payload, input)).rejects.toThrow();
});
