export type TokenUsage = {
  id: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== 'object') return false;
  const item = value as TokenUsage;
  return typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id) &&
    typeof item.model === 'string' && item.model.length > 0 && item.model.length <= 200 &&
    [item.inputTokens, item.outputTokens, item.totalTokens].every(value => value === null || count(value));
}

/** Provider totals already include cached/reasoning tokens; do not add those details again. */
export function normalizeTokenUsage(value: unknown): Omit<TokenUsage, 'id' | 'model'> {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const inputTokens = count(input) ? input : null;
  const outputTokens = count(output) ? output : null;
  const sum = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  return { inputTokens, outputTokens, totalTokens: count(usage.total_tokens) ? usage.total_tokens : count(sum) ? sum : null };
}

export function summarizeTokenUsage(records: TokenUsage[]) {
  const unique = [...new Map(records.map(record => [record.id, record])).values()];
  const reported = unique.filter(record => record.totalTokens !== null);
  return {
    totalTokens: reported.length ? reported.reduce((sum, record) => sum + record.totalTokens!, 0) : null,
    inputTokens: unique.length && unique.every(record => record.inputTokens !== null) ? unique.reduce((sum, record) => sum + record.inputTokens!, 0) : null,
    outputTokens: unique.length && unique.every(record => record.outputTokens !== null) ? unique.reduce((sum, record) => sum + record.outputTokens!, 0) : null,
    missingCalls: unique.length - reported.length,
  };
}
