import { createHmac, timingSafeEqual } from 'node:crypto';
import { AiFailure } from './aiSupport.ts';
import type { AiConfig } from './aiSupport.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function signature(kind: string, value: unknown, config: AiConfig): string {
  if (!config.apiKey) throw new AiFailure(503, 'AI_NOT_CONFIGURED', '请先配置服务端文本模型。');
  return createHmac('sha256', config.workflowSigningKey || config.apiKey).update(`product-workflow-v2:${kind}:${canonical(value)}`).digest('hex');
}
export function signProductArtifact<T extends object>(kind: string, value: T, config: AiConfig): T & { signature: string } {
  return { ...value, signature: signature(kind, value, config) };
}
export function verifyProductArtifact(kind: string, value: { signature: string }, config: AiConfig): void {
  const { signature: received, ...payload } = value;
  const expected = signature(kind, payload, config);
  if (!/^[a-f0-9]{64}$/.test(received) || !timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new AiFailure(409, 'PRODUCT_PROOF_INVALID', '当前结果已被修改或服务密钥已更换，请重新校验产品后生成，不能沿用过期的确认结果。');
  }
}
