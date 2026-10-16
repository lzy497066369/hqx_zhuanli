import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatChoice } from '../server/aiSupport.ts';
import { chatJson } from '../server/patentStructureAi.ts';
import { buildProductCad } from '../server/productCad.ts';
import { createServer } from 'node:http';

const encoder = new TextEncoder();
const config = { baseUrl: 'https://lifecycle-test.invalid/v1', apiKey: 'test-only', model: 'primary', fallbackModel: 'fallback' };
const completion = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });

for (const scenario of [
  { name: 'default', maxRetries: undefined, successAt: 3, calls: 2, succeeds: false },
  { name: 'two repairs succeed', maxRetries: 2, successAt: 3, calls: 3, succeeds: true },
  { name: 'two repairs exhausted', maxRetries: 2, successAt: Infinity, calls: 3, succeeds: false },
]) {
  test(`Validation corrections remain bounded: ${scenario.name}`, async () => {
    let calls = 0;
    const prompts = [], feedback = [];
    const work = chatJson('initial', {}, { ...config, model: `validation-${scenario.name}`, fallbackModel: '' }, new AbortController().signal, async (_url, init) => {
      prompts.push(JSON.parse(init.body).messages[0].content);
      calls++;
      return completion({ valid: calls === scenario.successAt, attempt: calls });
    }, 100, undefined, value => value.valid || [`repair attempt ${value.attempt}`], {
      validationRetry: { maxTokens: 100, maxRetries: scenario.maxRetries, prompt: details => { feedback.push(details); return details.join('\n'); } },
    });
    if (scenario.succeeds) assert.equal((await work).value.valid, true);
    else await assert.rejects(work, { code: 'AI_INVALID_OUTPUT' });
    assert.equal(calls, scenario.calls);
    assert.deepEqual(feedback, Array.from({ length: calls - 1 }, (_, i) => [`repair attempt ${i + 1}`]));
    assert.deepEqual(prompts, ['initial', ...feedback.map(details => details.join('\n'))]);
  });
}

function openStream(text = '', contentType = 'text/event-stream') {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { if (text) controller.enqueue(encoder.encode(text)); },
    // An upstream cancellation acknowledgement must not hold up the result.
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { 'Content-Type': contentType } });
  return { response, cancelled: () => cancelled };
}
async function bounded(work, ms = 800) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Response lifecycle remained pending')), ms); })]); }
  finally { clearTimeout(timer); }
}

test('SSE DONE completes without waiting for the transport to close and preserves trailing usage', async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  const stream = openStream('data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":null}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    + `data: ${JSON.stringify({ choices: [], usage })}\n\n` + 'data: [DONE]\n\n');
  const records = [];
  const choice = await bounded(readChatChoice(stream.response, value => records.push(value)));
  assert.deepEqual(choice, { finish_reason: 'stop', message: { content: '{"ok":true}' } });
  assert.deepEqual(records, [usage]);
  assert.equal(stream.cancelled(), true);
});

for (const type of ['text/event-stream', 'application/json']) {
  test(`Attempt timeout releases a stalled ${type} body before using fallback`, async () => {
    const stream = openStream('', type), calls = [];
    const primary = `${type}-primary`, fallback = `${type}-fallback`;
    const result = await bounded(chatJson('test', {}, { ...config, model: primary, fallbackModel: fallback }, new AbortController().signal, async (_url, init) => {
      const model = JSON.parse(init.body).model; calls.push(model);
      return model === primary ? stream.response : completion({ ok: true });
    }, 100, undefined, value => value.ok === true, { attemptTimeoutMs: 40 }));
    assert.deepEqual(result.value, { ok: true });
    assert.deepEqual(calls, [primary, fallback]);
    assert.equal(stream.cancelled(), true);
  });
}

test('Attempt timeout also bounds a fetcher that fails to settle on abort', async () => {
  const calls = [];
  const result = await bounded(chatJson('test', {}, { ...config, model: 'fetch-primary', fallbackModel: 'fetch-fallback' }, new AbortController().signal, async (_url, init) => {
    const model = JSON.parse(init.body).model; calls.push(model);
    return model === 'fetch-primary' ? new Promise(() => {}) : completion({ ok: true });
  }, 100, undefined, value => value.ok === true, { attemptTimeoutMs: 40 }));
  assert.equal(result.model, 'fetch-fallback');
  assert.deepEqual(calls, ['fetch-primary', 'fetch-fallback']);
});

test('User cancellation interrupts a stalled body without requesting fallback', async () => {
  const controller = new AbortController(), stream = openStream(), calls = [];
  const timer = setTimeout(() => controller.abort(new DOMException('用户取消', 'AbortError')), 30);
  try {
    await assert.rejects(bounded(chatJson('test', {}, { ...config, model: 'cancel-primary' }, controller.signal, async (_url, init) => {
      calls.push(JSON.parse(init.body).model); return stream.response;
    }, 100)), { name: 'AbortError' });
    assert.deepEqual(calls, ['cancel-primary']);
    assert.equal(stream.cancelled(), true);
  } finally { clearTimeout(timer); }
});

test('An incomplete DONE stream remains invalid and is never accepted as a finished result', async () => {
  const stream = openStream('data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":null}]}\n\ndata: [DONE]\n\n');
  await assert.rejects(bounded(chatJson('test', {}, { ...config, model: 'incomplete-only', fallbackModel: '' }, new AbortController().signal, async () => stream.response, 100)), { code: 'AI_INCOMPLETE' });
});

test('An upstream SSE error does not stall cleanup before fallback', async () => {
  const stream = openStream('data: {"error":{"message":"upstream unavailable"}}\n\n');
  const calls = [];
  const result = await bounded(chatJson('test', {}, { ...config, model: 'error-primary', fallbackModel: 'error-fallback' }, new AbortController().signal, async (_url, init) => {
    const model = JSON.parse(init.body).model; calls.push(model);
    return model === 'error-primary' ? stream.response : completion({ ok: true });
  }, 100));
  assert.equal(result.model, 'error-fallback');
  assert.deepEqual(calls, ['error-primary', 'error-fallback']);
  assert.equal(stream.cancelled(), true);
});

test('Native HTTP fetch returns a finished SSE result while the gateway leaves its connection open', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const localConfig = { ...config, baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'native-http', fallbackModel: '' };
    const result = await bounded(chatJson('test', {}, localConfig, new AbortController().signal, fetch, 100));
    assert.deepEqual(result.value, { ok: true });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('The real CAD entry point reports a CAD timeout and preserves prior text/preview', async () => {
  const brief = { signature: 'test-brief', description: '测试底座', design: { title: '测试', components: [{ number: '1', name: '底座', structure: '矩形底座', connection: '固定' }] } };
  const image = { templateId: 'color-hero', dataUrl: 'data:image/png;base64,dGVzdA==' };
  const snapshot = JSON.stringify(brief);
  await assert.rejects(bounded(buildProductCad(brief, [image], { ...config, model: 'cad-timeout', fallbackModel: '', timeoutMs: 60, cadCheckpointDir: false },
    new AbortController().signal, async () => new Promise(() => {})), 3000), error => {
    assert.equal(error.code, 'CAD_AI_TIMEOUT');
    assert.match(error.message, /附图建模.*已有正文与预览保留/);
    assert.doesNotMatch(error.message, /单次结构生成/);
    return true;
  });
  assert.equal(JSON.stringify(brief), snapshot);
});

test('A native network failure activates the frozen-structure alternative without changing the technical input', async () => {
  const brief = { signature: 'test-frozen-brief', description: '测试底座', design: { title: '测试', components: [{ number: '1', name: '底座', structure: '矩形底座', connection: '固定' }] },
    technicalSource: { plan: { parts: [{ id: '1', name: '底座', kind: 'part', parentId: null }] } } };
  const snapshot = JSON.stringify(brief), calls = [];
  await assert.rejects(bounded(buildProductCad(brief, [{ templateId: 'color-hero', dataUrl: 'data:image/png;base64,dGVzdA==' }],
    { ...config, model: 'frozen-network', fallbackModel: '', timeoutMs: 1000, cadCheckpointDir: false }, new AbortController().signal, async (_url, init) => {
      const payload = JSON.parse(init.body), input = payload.messages[1].content;
      calls.push({ images: Array.isArray(input) ? input.filter(c => c.type === 'image_url').length : 0,
        input: JSON.parse(Array.isArray(input) ? input[0].text : input) });
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }) });
    }), 3000), { code: 'AI_NETWORK' });
  assert.deepEqual(calls.map(c => c.images), [1, 0]);
  for (const call of calls) assert.deepEqual(call.input.technicalPlan, brief.technicalSource.plan);
  assert.equal(JSON.stringify(brief), snapshot);
});
