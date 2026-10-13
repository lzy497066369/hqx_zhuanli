import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiMiddleware, readAiConfig } from './drawingAi.ts';
import { createStorageMiddleware } from './storageApi.ts';
import { readStorageConfig } from './mysql/database.ts';
import { createAuthMiddleware } from './auth.ts';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const middleware = createAiMiddleware(readAiConfig(process.env));
const storage = createStorageMiddleware(readStorageConfig(process.env));
const auth = createAuthMiddleware(readStorageConfig(process.env));
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  void auth.middleware(req, res, () => { void storage.middleware(req, res, () => { void middleware(req, res, () => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); }
      catch { res.writeHead(400); res.end(); return; }
      if (pathname.startsWith('/api/') || process.env.SERVE_FRONTEND === 'false') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '接口不存在。' } })); return; }
      let path = resolve(root, `.${pathname}`);
      if ((path !== root && !path.startsWith(root + sep)) || pathname.split('/').some(p => p.startsWith('.'))) { res.writeHead(404); res.end(); return; }
      try { if (!(await stat(path)).isFile()) path = resolve(root, 'index.html'); }
      catch { if (extname(pathname)) { res.writeHead(404); res.end(); return; } path = resolve(root, 'index.html'); }
      const bytes = await readFile(path);
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    })().catch(() => { if (!res.headersSent) res.writeHead(503); res.end('Please build the frontend before starting the server.'); });
  }); }); });
});
server.requestTimeout = 270000;
server.headersTimeout = 15000;
const port = Number(process.env.PORT || 4173);
// 容器内需要监听 0.0.0.0；本机运行保持只监听回环地址。
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`知创工坊（本机 AI 服务） http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { server.close(() => { void Promise.all([storage.close(), auth.close()]).finally(() => process.exit()); }); });
}
