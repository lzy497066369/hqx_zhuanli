import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));

export function loadConfig() {
  let env = {};
  // App-local files take precedence. Never copy credentials into app source or responses.
  for (const directory of [dirname(ROOT), ROOT]) {
    for (const name of ['.env', '.env.local']) {
      const path = join(directory, name);
      if (existsSync(path)) env = { ...env, ...parseEnv(readFileSync(path, 'utf8')) };
    }
  }
  env = { ...env, ...process.env };
  const providers = ['', 'FALLBACK_', 'SECOND_FALLBACK_'].map(prefix => ({
    baseUrl: (env[`AI_${prefix}BASE_URL`] || env.AI_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: env[`AI_${prefix}API_KEY`] || env.AI_API_KEY || '',
    model: env[`AI_${prefix}MODEL`] || '',
  })).filter((p, i, all) => p.apiKey && p.model && p.baseUrl &&
    all.findIndex(v => v.model === p.model && v.baseUrl === p.baseUrl) === i);
  for (const p of providers) {
    const url = new URL(p.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('AI_BASE_URL 必须为不含账号、密码或查询参数的 HTTPS 接口地址。');
    }
  }
  const port = Number(env.PATENT_TEXT_PORT || env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口配置无效。');
  return { providers, port, timeoutMs: 420_000 };
}
