import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withAiAudit, auditedFetch } from '../server/aiAudit.ts';
import { readChatChoice } from '../server/aiSupport.ts';
import { chatJson } from '../server/patentStructureAi.ts';

function scope(records, userId = 'audit-user') {
  return { requestId: randomUUID(), userId, username: userId, workspaceId: `${userId}-space`, route: '/api/product/test', clientIp: '127.0.0.1', userAgent: 'test', clientStreaming: true, write: async log => { records.push(structuredClone(log)); } };
}
const request = { method: 'POST', body: JSON.stringify({ model: 'audit-model', stream: true, messages: [{ role: 'user', content: 'hello' }] }) };
const jsonResponse = (value = { ok: true }, usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage }), { headers: { 'Content-Type': 'application/json' } });

test('audit observes streaming first content, usage and DONE without waiting for upstream close', async () => {
  const records = [], encoder = new TextEncoder(); let cancel = false, step = 0;
  const response = new Response(new ReadableStream({
    async pull(controller) {
      step++;
      if (step === 1) controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
      if (step === 2) { await new Promise(resolve => setTimeout(resolve,25)); controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')); }
      if (step === 3) { await new Promise(resolve => setTimeout(resolve,25)); controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\ndata: [DONE]\n\n')); }
    }, cancel() { cancel = true; return new Promise(() => {}); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  await withAiAudit(scope(records), async () => {
    const result = await readChatChoice(await auditedFetch(async () => response)('https://provider.test/v1/chat/completions', request));
    assert.equal(result.message.content, 'hello world');
  });
  const last = records.at(-1);
  assert.equal(last.status, 'success'); assert.ok(last.firstTokenMs >= 10); assert.ok(last.details.outputMs >= 5);
  assert.equal(last.totalTokens, 7); assert.equal(last.details.output, 'hello world'); assert.ok(last.details.response.includes('[DONE]')); assert.equal(cancel, true);
  assert.equal(records[0].status, 'running'); assert.equal(new Set(records.map(item => item.id)).size, 1);
});

test('JSON and multipart logs redact credentials and binary data, keep token details and distinguish actual protocol', async () => {
  const records = [];
  await withAiAudit(scope(records), async () => {
    const form = new FormData(); form.set('model','image-model'); form.set('prompt','完整入参'); form.set('api_key','private-value'); form.set('image',new Blob(['image'], { type:'image/png' }),'example.png');
    const response = await auditedFetch(async () => new Response(JSON.stringify({ data:[{b64_json:'secret-image-bytes'}], usage:{input_tokens:10,output_tokens:4,total_tokens:14,input_tokens_details:{cached_tokens:3}}, api_key:'response-secret' }), { headers:{'Content-Type':'application/json','Set-Cookie':'secret-cookie','X-Request-Id':'provider-id'} }))('https://user:password@provider.test/images/edits?api_key=private', {method:'POST',body:form,headers:{Authorization:'Bearer secret'}});
    await response.json();
  });
  const log = records.at(-1), serialized = JSON.stringify(log);
  for (const secret of ['private-value','secret-image-bytes','response-secret','secret-cookie','Bearer secret','user:password','api_key=private']) assert.ok(!serialized.includes(secret), secret);
  assert.equal(log.firstTokenMs,null); assert.equal(log.details.outputMs,null); assert.equal(log.totalTokens,14); assert.equal(log.details.usage.input_tokens_details.cached_tokens,3);
  assert.equal(log.details.request.image.bytes,5); assert.equal(log.details.responseHeaders['x-request-id'],'provider-id'); assert.equal(log.details.responseStreaming,false);
});

test('validation repair attempts are independent records, rejected model output is marked failed', async () => {
  const records = []; let calls = 0;
  await withAiAudit(scope(records), async () => {
    const result = await chatJson('test', {}, { baseUrl:'https://audit.test/v1',apiKey:'test',model:'validation-audit' }, new AbortController().signal,
      async () => jsonResponse({ valid:++calls === 2 }),100,undefined,value => value.valid || ['not valid'], { validationRetry:{maxTokens:100,prompt:()=>'repair'} });
    assert.equal(result.value.valid,true);
  });
  const final = [...new Map(records.map(item => [item.id,item])).values()];
  assert.equal(final.length,2); assert.deepEqual(final.map(item => item.status),['failed','success']); assert.equal(new Set(final.map(item => item.requestId)).size,1);
  assert.equal(final[0].details.validationError.code,'AI_INVALID_OUTPUT');
});

test('network errors, HTTP failures, invalid JSON and incomplete SSE are recorded as failures', async () => {
  for (const mode of ['network','http','json','sse']) {
    const records = [];
    await withAiAudit(scope(records), async () => {
      const fetcher = auditedFetch(async () => {
        if (mode === 'network') throw new TypeError('fetch failed');
        if (mode === 'http') return new Response('rate limited',{status:429});
        if (mode === 'json') return new Response('bad json');
        return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
      });
      try { const response = await fetcher('https://audit.test/v1/chat/completions',request); if (mode === 'http') await response.body.cancel(); else if (mode === 'sse') await readChatChoice(response); else await response.text(); } catch { /* Expected network failure. */ }
    });
    assert.equal(records.at(-1).status,'failed',mode);
  }
});

test('an abort records a fetcher that never settles; parallel user contexts never cross', async () => {
  const records = [], controller = new AbortController();
  withAiAudit(scope(records), () => { void auditedFetch(async () => new Promise(() => {}))('https://audit.test/chat/completions',{...request,signal:controller.signal}); });
  await new Promise(resolve => setTimeout(resolve,10)); controller.abort(); await new Promise(resolve => setTimeout(resolve,10));
  assert.equal(records.at(-1).status,'cancelled');
  const parallel = [];
  const fetcher = auditedFetch(async () => jsonResponse());
  await Promise.all(['alice','bob'].map(user => withAiAudit(scope(parallel,user),async () => { await (await fetcher('https://audit.test/chat/completions',request)).json(); })));
  const final = [...new Map(parallel.map(item => [item.id,item])).values()];
  assert.equal(final.length,2); for (const log of final) assert.equal(log.workspaceId,`${log.userId}-space`);
});

test('wrappers do not duplicate logs or record patent page GET requests', async () => {
  const records = [], fetcher = auditedFetch(async () => jsonResponse());
  await withAiAudit(scope(records),async () => { await (await auditedFetch(fetcher)('https://audit.test/chat/completions',request)).json(); await (await fetcher('https://patents.google.com/patent/test')).text(); });
  assert.equal(new Set(records.map(item => item.id)).size,1);
});

test('HTTP failure diagnostics are captured before chat fallback succeeds',async()=>{
  const records=[];
  await withAiAudit(scope(records),async()=>{
    let calls=0;
    const result=await chatJson('test',{}, {baseUrl:'https://audit.test/v1',apiKey:'test',model:'http-failure-audit',fallbackModel:'http-fallback-audit'},new AbortController().signal,
      async()=>++calls===1?new Response(JSON.stringify({error:{message:'rate limited'}}),{status:429,headers:{'Content-Type':'application/json'}}):jsonResponse(),100);
    assert.equal(result.model,'http-fallback-audit');
  });
  const final=[...new Map(records.map(item=>[item.id,item])).values()];
  assert.equal(final.length,2);assert.equal(final[0].status,'failed');assert.equal(final[0].httpStatus,429);assert.equal(final[0].details.response.error.message,'rate limited');assert.equal(final[1].status,'success');
});
