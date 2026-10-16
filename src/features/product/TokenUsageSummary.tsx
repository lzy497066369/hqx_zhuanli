import { summarizeTokenUsage } from './tokenUsage';
import type { TokenUsage } from './tokenUsage';

export function TokenUsageSummary({ records, incomplete = false }: { records?: TokenUsage[]; incomplete?: boolean }) {
  const usage = summarizeTokenUsage(records || []);
  const partial = incomplete || usage.missingCalls > 0;
  const format = (value: number) => value.toLocaleString('zh-CN');
  return <section className="pw-token-usage" aria-label="专利生成 Token 用量" data-testid="token-usage">
    <div><strong>{partial ? '已统计 Token' : '累计 Token 用量'}</strong><span className="pw-token-total">{usage.totalTokens === null ? records?.length ? '未提供' : '未记录' : format(usage.totalTokens)}</span>
      {usage.inputTokens !== null && <span>输入 {format(usage.inputTokens)}</span>}
      {usage.outputTokens !== null && <span>输出 {format(usage.outputTokens)}</span>}</div>
    {usage.missingCalls > 0 && <p>有 {usage.missingCalls} 次调用未返回 Token 用量，合计仅包含已返回的数据。</p>}
  </section>;
}
