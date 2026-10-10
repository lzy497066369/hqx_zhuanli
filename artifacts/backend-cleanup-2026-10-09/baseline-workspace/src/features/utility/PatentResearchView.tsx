import type { PatentResearch } from './patentResearch';

export function PatentResearchView({ research }: { research: PatentResearch }) {
  return <section className="uw-research" aria-label="公开专利检索参考">
    <h4>公开专利检索参考 · {research.sources.length} 篇</h4>
    <p className="uw-hint">有限范围网页检索，不是全部专利遍历或新颖性结论。下列摘要由 AI 归纳；打开操作记录不保证页面读取成功，更不代表完整审阅权利要求或核实法律状态。</p>
    <ul>{research.sources.map(source => <li key={source.publication}>
      <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
      <span>{source.publication} · {source.evidence === 'opened' ? '工具记录了打开操作' : '仅检索结果，未记录打开操作'}</span>
    </li>)}</ul>
    <details><summary>查看检索词与已有技术归纳</summary>
      <p>检索时间：{new Date(research.searchedAt).toLocaleString()}</p>
      <ul>{research.queries.map((query, i) => <li key={i}>{query}</li>)}</ul>
      <pre>{research.summary}</pre>
    </details>
  </section>;
}
