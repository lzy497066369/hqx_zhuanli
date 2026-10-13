// Run after building zhichuang-frontend:latest. Uses isolated Docker resources.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { request } from 'node:http';

test('frontend Docker proxy preserves origin, large bodies, status and streamed progress', { timeout: 60000 }, async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const network = `zhichuang-proxy-test-${suffix}`;
  const backend = `${network}-api`;
  const frontend = `${network}-web`;
  const directory = await mkdtemp(join(tmpdir(), 'zhichuang-proxy-'));
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    await writeFile(join(directory, 'server.mjs'), `
      import { createServer } from 'node:http';
      createServer(async (req, res) => {
        if (req.url === '/api/stream') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ type: 'progress' }) + '\\n');
          setTimeout(() => res.end(JSON.stringify({ type: 'result' }) + '\\n'), 2000);
          return;
        }
        let bytes = 0;
        for await (const chunk of req) bytes += chunk.length;
        res.writeHead(req.url === '/api/conflict' ? 409 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: req.url, host: req.headers.host, protocol: req.headers['x-forwarded-proto'], origin: req.headers.origin, site: req.headers['sec-fetch-site'], bytes }));
      }).listen(4173, '0.0.0.0');
    `);
    docker('network', 'create', network);
    docker('run', '-d', '--name', backend, '--network', network, '--network-alias', 'backend',
      '--mount', `type=bind,source=${directory},target=/smoke,readonly`, 'node:22-bookworm', 'node', '/smoke/server.mjs');
    docker('run', '-d', '--name', frontend, '--network', network, '-p', '127.0.0.1::80', 'zhichuang-frontend:latest');
    const port = docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "80/tcp") 0).HostPort}}', frontend);
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* startup */ }
      await delay(200);
    }
    assert.match(await (await fetch(base)).text(), /知创工坊/);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
    const headers = { Host: 'patent.example.test', Origin: 'https://patent.example.test', 'X-Forwarded-Proto': 'https', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    const body = JSON.stringify({ image: 'x'.repeat(2 * 1024 * 1024) });
    const echo = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/echo?version=2`, { method: 'PUT', headers }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.deepEqual(echo, { url: '/api/echo?version=2', host: 'patent.example.test', protocol: 'https', origin: 'https://patent.example.test', site: 'same-origin', bytes: Buffer.byteLength(body) });
    assert.equal((await fetch(`${base}/api/conflict`)).status, 409);
    const stream = await fetch(`${base}/api/stream`);
    assert.match(stream.headers.get('content-type'), /application\/x-ndjson/);
    const reader = stream.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /progress/);
    assert.doesNotMatch(first, /result/, 'progress must arrive before the final response');
    let rest = '';
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    assert.match(rest, /result/);
  } finally {
    for (const name of [frontend, backend]) { try { docker('rm', '-f', name); } catch { /* absent */ } }
    try { docker('network', 'rm', network); } catch { /* absent */ }
    await rm(directory, { recursive: true, force: true });
  }
});
