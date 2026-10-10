import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer, loadEnv } from 'vite';
import { createStrictTransport } from './strictE2eTransport.mjs';
import { createStrictLogObservers, startIsolatedServer } from './strictE2eDiagnostics.mjs';

const artifacts = resolve(process.env.PHASE10_ARTIFACT_DIR || '');
if (!process.env.PHASE10_ARTIFACT_DIR || artifacts === process.cwd() || artifacts.startsWith(`${process.cwd()}/`)) throw new Error('EXTERNAL_ARTIFACT_DIR_REQUIRED');
if (!['real', 'strict-local', 'local'].includes(process.env.PHASE10_MODE || 'local')) throw new Error('INVALID_PHASE10_MODE');
const live = process.env.PHASE10_MODE === 'real';
const strict = live || process.env.PHASE10_MODE === 'strict-local';
const env = live ? { ...loadEnv('development', process.cwd(), 'AI_'), ...process.env } : {};
const record = entry => appendFileSync(join(artifacts, 'transport.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
mkdirSync(artifacts, { recursive: true });
// Explicit empty values override .env.local without editing it.
for (const key of ['AI_FALLBACK_MODEL', 'AI_FALLBACK_BASE_URL', 'AI_FALLBACK_API_KEY',
  'AI_SECOND_FALLBACK_MODEL', 'AI_SECOND_FALLBACK_BASE_URL', 'AI_SECOND_FALLBACK_API_KEY']) process.env[key] = '';
for (const key of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_RESEARCH_MODEL', 'AI_RESEARCH_PROTOCOL']) process.env[key] = env[key] || '';
process.env.AI_EXECUTION_POLICY = strict ? 'strict-e2e' : '';
process.env.HOME = join(artifacts, 'home');
mkdirSync(process.env.HOME, { recursive: true });
let transport;
if (live) {
  if (!env.AI_API_KEY || !env.AI_MODEL || !env.AI_BASE_URL || env.AI_RESEARCH_PROTOCOL !== 'anthropic') throw new Error('NATIVE_RESEARCH_CONFIGURATION_REQUIRED');
  transport = createStrictTransport({ baseUrl: env.AI_BASE_URL, model: env.AI_MODEL,
    researchModel: env.AI_RESEARCH_MODEL || env.AI_MODEL, fetcher: globalThis.fetch, record });
  globalThis.fetch = transport.fetch;
  Object.assign(console, createStrictLogObservers(transport, record));
} else {
  globalThis.fetch = async () => { throw new Error('LOCAL_TEST_OUTBOUND_FORBIDDEN'); };
}
const server = await startIsolatedServer(createServer, { configLoader: 'runner', cacheDir: join(artifacts, 'vite-cache'),
  logLevel: 'silent', server: { host: '127.0.0.1', port: Number(process.env.PHASE10_PORT || 5198), strictPort: true } }, transport, record);
const stop = async () => {
  transport?.halt('TEST_ABORT');
  if (transport) record({ type: 'totals', ...transport.state });
  await server.close();
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
