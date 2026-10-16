import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { normalizeTokenUsage } from '../src/features/product/tokenUsage.ts';
import type { TokenUsage } from '../src/features/product/tokenUsage.ts';

const usageContext = new AsyncLocalStorage<(usage: TokenUsage) => void>();

/** Each HTTP request owns its collector, including parallel image calls. */
export function withTokenUsage<T>(report: (usage: TokenUsage) => void, operation: () => Promise<T>): Promise<T> {
  return usageContext.run(report, operation);
}

export function createUsageRecorder(model: string): (usage: unknown) => void {
  const report = usageContext.getStore();
  let recorded = false;
  return usage => {
    if (!report || recorded) return;
    recorded = true;
    report({ id: randomUUID(), model, ...normalizeTokenUsage(usage) });
  };
}
