const providerCooldown = new Map();

export function parseJSON(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI 没有返回完整的 JSON 对象。');
  return JSON.parse(clean.slice(start, end + 1));
}

export async function readCompletion(response, onActivity = () => {}) {
  if (!response.body) throw new Error('AI 返回了空响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '', finish = '', bytes = 0, doneMarker = false;
  const streaming = (response.headers.get('content-type') || '').includes('text/event-stream');
  function line(value) {
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { doneMarker = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) {
      const failure = new Error('AI 服务在生成中返回错误。');
      failure.upstream = chunk.error;
      throw failure;
    }
    const choice = chunk.choices?.[0];
    if (choice?.delta?.refusal) throw new Error('AI 未能处理此请求。');
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    onActivity(content.length);
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 8 * 1024 * 1024) throw new Error('AI 响应超出大小限制。');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (streaming) {
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const value of lines) line(value);
      }
    }
    buffer += decoder.decode();
    if (streaming) {
      if (buffer.trim()) line(buffer);
      if (!finish && !doneMarker) throw new Error('AI 连接提前断开，未采用不完整结果。');
    } else {
      const envelope = JSON.parse(buffer);
      const choice = envelope.choices?.[0];
      if (choice?.message?.refusal || envelope.error) throw new Error('AI 未能处理此请求。');
      content = choice?.message?.content;
      finish = choice?.finish_reason;
    }
    if (finish && finish !== 'stop') throw new Error('AI 输出未正常结束，未采用截断的结果。');
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI 未返回正文。');
    return content;
  } finally { await reader.cancel().catch(() => {}); }
}

export async function callJSON(config, { system, input, signal, maxTokens = 8000, onActivity, onProvider, onWarning }) {
  if (!config.providers.length) throw new Error('未找到文本接口配置，请在 .env.local 设置 AI_BASE_URL、AI_API_KEY、AI_MODEL。');
  let failure = 'AI 服务暂时不可用。';
  const available = config.providers.filter(p => (providerCooldown.get(`${p.baseUrl}:${p.model}`) || 0) < Date.now());
  for (const provider of available.length ? available : config.providers) {
    signal?.throwIfAborted();
    onProvider?.(provider.model);
    const combined = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(signal ? [signal] : [])]);
    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'patent-text-app/1.0' },
        body: JSON.stringify({ model: provider.model, stream: true, max_completion_tokens: maxTokens,
          ...(/^gpt-[56]|^o[134]/i.test(provider.model) ? { reasoning_effort: 'low' } : {}),
          messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }] }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        failure = response.status === 401 || response.status === 403 ? '接口授权失败，请检查密钥及模型权限。'
          : response.status === 429 ? '接口额度不足或请求过于频繁。' : `AI 服务暂时不可用（HTTP ${response.status}）。`;
        providerCooldown.set(`${provider.baseUrl}:${provider.model}`, Date.now() + 300_000);
        onWarning?.(failure);
        continue;
      }
      const value = parseJSON(await readCompletion(response, onActivity));
      providerCooldown.delete(`${provider.baseUrl}:${provider.model}`);
      return { value, model: provider.model };
    } catch (error) {
      if (signal?.aborted) throw new Error('生成已取消。');
      providerCooldown.set(`${provider.baseUrl}:${provider.model}`, Date.now() + 300_000);
      failure = combined.aborted ? '本阶段生成超时，可重试继续。'
        : error instanceof SyntaxError ? 'AI 返回格式不正确，可重试继续。'
          : error.message?.startsWith('AI ') ? error.message : '无法连接 AI 服务，可重试继续。';
      onWarning?.(failure);
    }
  }
  throw new Error(failure);
}
