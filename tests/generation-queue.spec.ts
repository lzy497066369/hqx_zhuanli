import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GenerationQueue } from '../server/generationQueue';
import { createAiMiddleware } from '../server/drawingAi';
import { PRODUCT_PATHS } from '../server/productWorkflowAi';
import { logicalResult, jsonEnvelope, productConfig, productSelection } from './fixtures/productWorkflow';

const signal = () => new AbortController().signal;

test('50 个完整生成占满后，第 51/52 个 FIFO 排队；已有事务跨步骤保留名额', async () => {
  const queue = new GenerationQueue();
  const tokens = await Promise.all(Array.from({ length: 50 }, () => queue.begin('owner', signal())));
  expect(new Set(tokens).size).toBe(50);
  const order: number[] = [];
  const positions: number[] = [];
  const fiftyFirst = queue.begin('owner', signal()).then(token => { order.push(51); return token; });
  const fiftySecond = queue.begin('owner', signal(), position => positions.push(position)).then(token => { order.push(52); return token; });
  expect(positions.at(-1)).toBe(2);
  for (let step = 0; step < 3; step++) queue.enter(tokens[0], 'owner', new AbortController())();
  await Promise.resolve();
  expect(order).toEqual([]);
  queue.end(tokens[0], 'owner');
  const next = await fiftyFirst;
  expect(order).toEqual([51]);
  expect(positions.at(-1)).toBe(1);
  queue.enter(next, 'owner', new AbortController())();
  expect(order).toEqual([51]);
  queue.end(next, 'owner');
  queue.end(await fiftySecond, 'owner');
  expect(order).toEqual([51, 52]);
  tokens.slice(1).forEach(token => queue.end(token, 'owner'));
});

test('取消等待者后不阻塞后续任务，取消执行者须等当前步骤真正退出才释放', async () => {
  const queue = new GenerationQueue();
  const tokens = await Promise.all(Array.from({ length: 50 }, () => queue.begin('owner', signal())));
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

test('200 个并发请求按 FIFO 执行，运行峰值为 50，全部完成后名额可复用', async () => {
  const queue = new GenerationQueue();
  const order: number[] = [];
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 200 }, async (_, index) => {
    const release = await queue.acquire(signal());
    active++;
    peak = Math.max(peak, active);
    order.push(index);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    release();
    release();
  }));
  expect(peak).toBe(50);
  expect(active).toBe(0);
  expect(order).toEqual(Array.from({ length: 200 }, (_, index) => index));
  const tokens = await Promise.all(Array.from({ length: 50 }, () => queue.begin('owner', signal())));
  tokens.forEach(token => queue.end(token, 'owner'));
});

test('HTTP：50 位用户取得名额，第 51/52 人收到队列位置并依次递补，已有任务跨步骤保留名额', async () => {
  const middleware = createAiMiddleware(productConfig, async () => jsonEnvelope(logicalResult()));
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown = {}, token?: string, cookie = 'session=owner') => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(token ? { 'X-Generation-Token': token } : {}) }, body: JSON.stringify(body),
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const queued = async (cookie: string) => {
    const response = await fetch(base + '/api/generation/begin', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', Cookie: cookie }, body: '{}' });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    readers.push(reader);
    return reader;
  };
  const readResult = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let output = '';
    while (true) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
    const result = output.trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'result');
    expect(result?.data.token).toEqual(expect.any(String));
    return result.data.token as string;
  };
  try {
    const tokens = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      const cookie = `session=user-${index}`;
      const response = await post('/api/generation/begin', {}, undefined, cookie);
      expect(response.status).toBe(200);
      const { token } = await response.json();
      expect(token).toEqual(expect.any(String));
      return { cookie, token };
    }));
    const first = await queued('session=fifty-first');
    const firstProgress = new TextDecoder().decode((await first.read()).value);
    expect(firstProgress).toContain('当前排队第 1 位');
    expect(firstProgress).toContain('最多同时生成 50 份专利');
    expect(firstProgress).not.toContain('"type":"result"');
    const second = await queued('session=fifty-second');
    const secondProgress = new TextDecoder().decode((await second.read()).value);
    expect(secondProgress).toContain('当前排队第 2 位');
    expect(secondProgress).not.toContain('"type":"result"');
    for (let step = 0; step < 2; step++) {
      expect((await post(PRODUCT_PATHS.review, { selection: productSelection }, tokens[0].token, tokens[0].cookie)).status).toBe(200);
    }
    expect((await post(PRODUCT_PATHS.review, { selection: productSelection }, tokens[0].token, 'session=other')).status).toBe(409);
    await post('/api/generation/end', {}, tokens[0].token, tokens[0].cookie);
    const firstToken = await readResult(first);
    const movedUp = new TextDecoder().decode((await second.read()).value);
    expect(movedUp).toContain('当前排队第 1 位');
    expect(movedUp).not.toContain('"type":"result"');
    await post('/api/generation/end', {}, firstToken, 'session=fifty-first');
    const secondToken = await readResult(second);
    await post('/api/generation/end', {}, secondToken, 'session=fifty-second');
    await Promise.all(tokens.slice(1).map(({ token, cookie }) => post('/api/generation/end', {}, token, cookie)));
  } finally {
    await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('HTTP：50 个请求同时执行模拟模型，第 51 个等待，取消排队者后第 52 个自动递补', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const gates: Array<() => void> = [];
  const middleware = createAiMiddleware(productConfig, async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    try {
      if (calls <= 50) await new Promise<void>(resolve => gates.push(resolve));
      return jsonEnvelope(logicalResult());
    } finally { active--; }
  });
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (cookie: string, accept = 'application/json', abortSignal?: AbortSignal) => fetch(base + PRODUCT_PATHS.review, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: accept, Cookie: cookie },
    body: JSON.stringify({ selection: productSelection }), signal: abortSignal,
  });
  const cancel = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const requests = Array.from({ length: 50 }, (_, index) => post(`session=user-${index}`));
  try {
    await expect.poll(() => calls).toBe(50);
    expect(active).toBe(50);
    const waiting = await post('session=fifty-first', 'application/x-ndjson', cancel.signal);
    const cancelledReader = waiting.body!.getReader();
    expect(new TextDecoder().decode((await cancelledReader.read()).value)).toContain('当前排队第 1 位');
    const next = await post('session=fifty-second', 'application/x-ndjson');
    reader = next.body!.getReader();
    const queued = new TextDecoder().decode((await reader.read()).value);
    expect(queued).toContain('当前排队第 2 位');
    expect(queued).toContain('最多同时生成 50 份专利');
    expect(calls).toBe(50);
    cancel.abort();
    const movedUp = new TextDecoder().decode((await reader.read()).value);
    expect(movedUp).toContain('当前排队第 1 位');
    expect(movedUp).not.toContain('"type":"result"');
    expect(calls).toBe(50);
    gates[0]();
    let output = '';
    while (true) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
    expect(output).toContain('"type":"result"');
    expect(calls).toBe(51);
    expect(peak).toBe(50);
    gates.forEach(release => release());
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(200);
      expect((await response.json()).verdict).toBe('feasible');
    }
    expect(active).toBe(0);
  } finally {
    cancel.abort();
    gates.forEach(release => release());
    await Promise.allSettled(requests);
    await reader?.cancel().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('HTTP：不可续修的步骤失败仍释放生成名额', async () => {
  const middleware = createAiMiddleware(productConfig, async () => jsonEnvelope(logicalResult()));
  const server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown = {}, token?: string) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'session=terminal-failure', ...(token ? { 'X-Generation-Token': token } : {}) }, body: JSON.stringify(body),
  });
  try {
    const { token } = await (await post('/api/generation/begin')).json();
    const failed = await post(PRODUCT_PATHS.review, {}, token);
    expect(failed.status).toBe(400);
    const heartbeat = await post('/api/generation/heartbeat', {}, token);
    expect(heartbeat.status).toBe(409);
    expect((await heartbeat.json()).error.code).toBe('GENERATION_EXPIRED');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
