import type { DrawingPlanInput } from '../../src/features/utility/aiDrawing';
import type { PatentResearch } from '../../src/features/utility/patentResearch';
import { bracketStructure } from './drawing';
export const concept = {
  technicalField: '光伏组件机械安装结构', structure: bracketStructure,
  workingPrinciple: '底板承载左右支撑，左右支撑共同承托安装板，安装板承接光伏组件。',
  improvements: ['拟议采用分体支撑连接承载板；差异和连接强度尚需工程验证，不宣称新颖性。'],
};
export function researchFixture(input: DrawingPlanInput): PatentResearch {
  return {
    query: `${input.title}\n${input.technicalField}`.trim(), queries: ['site:patents.google.com 光伏组件 安装支架'],
    summary: '测试检索摘要：相关支架采用檩条与固定支架配合。此处为自动化测试数据，不是真实检索结论。',
    sources: [{ publication: 'CN217307583U', title: '光伏组件的安装支架（测试来源）', url: 'https://patents.google.com/patent/CN217307583U/en', evidence: 'opened' }],
    searchedAt: '2026-09-22T09:00:00.000Z',
  };
}
export function providerResearchFixture() {
  const url = 'https://patents.google.com/patent/CN217307583U/zh';
  return { status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['光伏组件 支架'], sources: [{ type: 'url', url }] } },
    { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '测试检索归纳：檩条与固定支架配合。', annotations: [{ type: 'url_citation', title: '光伏组件的安装支架', url: url + '?utm_source=test' }] }] },
  ] };
}
