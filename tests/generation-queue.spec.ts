import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GenerationQueue } from '../server/generationQueue';
import { createAiMiddleware } from '../server/drawingAi';
import { PRODUCT_PATHS } from '../server/productWorkflowAi';
import { logicalResult, jsonEnvelope, productConfig, productSelection } from './fixtures/productWorkflow';

const signal = () => new AbortController().signal;

test('10 个完整生成占满后，第 11/12 个 FIFO 排队；已有事务跨步骤保留名额', async () => {
  const queue = new GenerationQueue();
  const tokens = await Promise.all(Array.from({ length: 10 }, () => queue.begin('owner', signal())));
  const order: number[] = [];
  const eleventh = queue.begin('owner', signal()).then(token => { order.push(11); return token; });
  const twelfth = queue.begin('owner', signal()).then(token => { order.push(12); return token; });
  for (let step = 0; step < 3; step++) queue.enter(tokens[0], 'owner', new AbortController())();
  await Promise.resolve();
  expect(order).toEqual([]);
  queue.end(tokens[0], 'owner');
  const next = await eleventh;
  expect(order).toEqual([11]);
  queue.enter(next, 'owner', new AbortController())();
  expect(order).toEqual([11]);
  queue.end(next, 'owner');
  queue.end(await twelfth, 'owner');
  expect(order).toEqual([11, 12]);
  tokens.slice(1).forEach(token => queue.end(token, 'owner'));
});

test('取消等待者后不阻塞后续任务，取消执行者须等当前步骤真正退出才释放', async () => {
  const queue = new GenerationQueue();
  const tokens = await Promise.all(Array.from({ length: 10 }, () => queue.begin('owner', signal())));
  const cancelled = new AbortController();
  const waiting = queue.begin('owner', cancelled.signal).catch(error => error.name);
  let started = false;
  const next = queue.begin('owner', signal()).then(token => { started = true; return token; });
  cancelled.abort();
  expect(await waiting).toBe('AbortError');
  const controller = new AbortController();
  const leave = queue.enter(tokens[0], 'owner', controller);
  queue.end(tokens[0], 'owner');
  expect(controller.signal.aborted).toBe(true);
  await Promise.resolve();
  expect(started).toBe(false);
  leave(); leave();
  queue.end(await next, 'owner');
  tokens.slice(1).forEach(token => queue.end(token, 'owner'));
});

test('事务归属、单步骤互斥与崩溃页面的空闲名额回收', async () => {
  const queue = new GenerationQueue();
  const token = await queue.begin('owner', signal());
  expect(() => queue.enter(token, 'other', new AbortController())).toThrow('名额已释放');
  const leave = queue.enter(token, 'owner', new AbortController());
  expect(() => queue.enter(token, 'owner', new AbortController())).toThrow('前一步尚未结束');
  queue.expire(Date.now() + 100000);
  queue.heartbeat(token, 'owner');
  leave();
  queue.expire(Date.now() + 100000);
  expect(() => queue.heartbeat(token, 'owner')).toThrow('名额已释放');
});

test('HTTP：第 11 人收到排队进度，前 10 人后续步骤优先继续，结束后自动轮到第 11 人', async () => {
  const middleware = createAiMiddleware(productConfig, async () => jsonEnvelope(logicalResult()));
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown = {}, token?: string, cookie = 'session=owner') => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(token ? { 'X-Generation-Token': token } : {}) }, body: JSON.stringify(body),
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const tokens: string[] = [];
    for (let i = 0; i < 10; i++) tokens.push((await (await post('/api/generation/begin')).json()).token);
    const waiting = await fetch(base + '/api/generation/begin', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', Cookie: 'session=eleventh' }, body: '{}' });
    reader = waiting.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('当前排队第 1 位');
    for (let step = 0; step < 2; step++) {
      expect((await post(PRODUCT_PATHS.review, { selection: productSelection }, tokens[0])).status).toBe(200);
    }
    expect((await post(PRODUCT_PATHS.review, { selection: productSelection }, tokens[0], 'session=other')).status).toBe(409);
    await post('/api/generation/end', {}, tokens[0]);
    let output = '';
    while (true) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
    expect(output).toContain('"type":"result"');
    const result = output.trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'result');
    await post('/api/generation/end', {}, result.data.token, 'session=eleventh');
    for (const token of tokens.slice(1)) await post('/api/generation/end', {}, token);
  } finally {
    await reader?.cancel().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
