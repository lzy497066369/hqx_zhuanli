import { createHash, randomUUID } from 'node:crypto';
import { createUsageRecorder } from './aiUsage.ts';
import { markAiResponseFailure } from './aiAudit.ts';
import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { AiFailure, AI_USER_AGENT, responseText } from './aiSupport.ts';
import type { AiConfig } from './aiSupport.ts';
import { GenerationQueue } from './generationQueue.ts';
import { signProductArtifact } from './productProof.ts';
import type { ProductBrief, ProductImage, ProductImageRef } from '../src/features/product/productWorkflow.ts';
import { buildPatentFigurePrompt, buildPreviewPrompt } from '../src/features/product/productPrompts.ts';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
// All billable image requests share one process-wide upstream slot. This also
// covers different projects and image stages running in the same backend.
const imageRequestQueue = new GenerationQueue(1);
export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a > 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b)) &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0);
}
export function validateImageUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AiFailure(502, 'IMAGE_URL_INVALID', '生图服务返回了无效图片地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
    url.hostname === 'localhost' || url.hostname.endsWith('.local') || (isIP(url.hostname) && !isPublicImageAddress(url.hostname)) || url.hostname.startsWith('[')) {
    throw new AiFailure(502, 'IMAGE_URL_UNSAFE', '生图服务返回的图片地址不安全，未下载该图片。');
  }
  return url;
}
async function downloadImage(value: string, signal: AbortSignal, redirects = 0): Promise<Buffer> {
  const url = validateImageUrl(value);
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(item => !isPublicImageAddress(item.address))) throw new AiFailure(502, 'IMAGE_URL_UNSAFE', '图片地址解析到非公开网络，已拒绝下载。');
  signal.throwIfAborted();
  // Pin the validated IP for the TLS connection; do not re-resolve it (DNS rebinding).
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = get(url, { signal, family: 4, headers: { Accept: 'image/png,image/jpeg,image/webp', 'User-Agent': AI_USER_AGENT },
      lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, 4) }, resolve);
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
    response.resume();
    if (redirects >= 3 || !response.headers.location) throw new AiFailure(502, 'IMAGE_DOWNLOAD_FAILED', '图片地址跳转过多，请重试。');
    return downloadImage(new URL(response.headers.location, url).href, signal, redirects + 1);
  }
  if (response.statusCode !== 200) { response.destroy(); throw new AiFailure(502, 'IMAGE_DOWNLOAD_FAILED', '图片下载失败，请重试。'); }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw new AiFailure(502, 'IMAGE_TOO_LARGE', '生成图片超过大小限制，请降低生图尺寸后重试。');
      chunks.push(Buffer.from(chunk));
    }
  } finally { response.destroy(); }
  return Buffer.concat(chunks);
}
export function imageMime(bytes: Buffer): ProductImageRef['mimeType'] {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 24 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 24 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new AiFailure(502, 'IMAGE_INVALID', '生图服务未返回可识别的 PNG、JPEG 或 WebP 图片，未采用该结果。');
}
export function checkImageConfig(config: AiConfig): void {
  const image = config.image;
  let url: URL | undefined;
  try { url = new URL(image?.baseUrl || ''); } catch { /* Reject below without exposing provider details. */ }
  if (!image?.apiKey || !image.model || image.model.length > 100 || !url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AiFailure(503, 'IMAGE_NOT_CONFIGURED', '生图服务未配置，请设置服务端 AI_IMAGE_BASE_URL、AI_IMAGE_MODEL 和 AI_IMAGE_API_KEY。');
  }
}
/** Exactly one billable generation call. A user-visible retry is required after an ambiguous failure. */
export async function generateProductImage(brief: ProductBrief, kind: 'preview' | 'patent', templateId: string, config: AiConfig, signal: AbortSignal, fetcher: typeof fetch = fetch, reference?: ProductImage): Promise<ProductImage> {
  checkImageConfig(config);
  const needsReference = kind === 'preview' && templateId !== 'color-hero';
  if (needsReference && (!reference || reference.briefId !== brief.id || reference.kind !== 'preview' || reference.templateId !== 'color-hero')) {
    throw new AiFailure(400, 'PREVIEW_REFERENCE_REQUIRED', '请先生成同一版本的主体图，再以主体图为参考生成其他视角。');
  }
  const settings = config.image!;
  const prompt = kind === 'preview' ? buildPreviewPrompt(brief, templateId) : buildPatentFigurePrompt(brief, templateId);
  let body: string | FormData;
  if (needsReference) {
    const bytes = Buffer.from(reference!.dataUrl.split(',')[1] || '', 'base64');
    if (bytes.length > MAX_IMAGE_BYTES || imageMime(bytes) !== reference!.mimeType || createHash('sha256').update(bytes).digest('hex') !== reference!.digest) {
      throw new AiFailure(400, 'PREVIEW_REFERENCE_INVALID', '主体参考图内容无效，未提交其他视角的生图请求。');
    }
    const extension = reference!.mimeType === 'image/png' ? 'png' : reference!.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    const form = new FormData();
    form.set('model', settings.model);
    form.set('prompt', prompt);
    form.set('n', '1');
    if (settings.size) form.set('size', settings.size);
    form.set('image', new Blob([new Uint8Array(bytes)], { type: reference!.mimeType }), `product-hero.${extension}`);
    body = form;
  } else {
    body = JSON.stringify({ model: settings.model, prompt, n: 1, ...(settings.size ? { size: settings.size } : {}) });
  }
  let usage: unknown;
  const recordUsage = createUsageRecorder(settings.model);
  let auditResponse: Response | undefined;
  let timeout: AbortSignal | undefined;
  let releaseImageSlot: (() => void) | undefined;
  try {
    releaseImageSlot = await imageRequestQueue.acquire(signal);
    timeout = AbortSignal.timeout(settings.timeoutMs ?? 210000);
    const combined = AbortSignal.any([signal, timeout]);
    const response = await fetcher(`${settings.baseUrl}/images/${needsReference ? 'edits' : 'generations'}`, { method: 'POST', redirect: 'error', signal: combined,
      headers: { Authorization: `Bearer ${settings.apiKey}`, ...(!needsReference ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': AI_USER_AGENT },
      body,
    });
    auditResponse = response;
    if (!response.ok) {
      // Inspect only bounded diagnostics for known capability errors; never return raw provider text.
      let diagnostic = '';
      try {
        const error = JSON.parse(await responseText(response, 16 * 1024));
        diagnostic = typeof error?.error?.message === 'string' ? error.error.message : '';
      } catch { /* Treat malformed error bodies as a generic provider failure. */ }
      if (response.status === 403 && /image generation is not enabled for this group/i.test(diagnostic)) throw new AiFailure(503, 'IMAGE_GROUP_DISABLED', '这把生图 API key 所属分组尚未开启生图。请在服务商后台开启生图权限，并确认可用的图片模型名后重试；当前产品简介已保留。');
      if (response.status === 400 && /requires an image model/i.test(diagnostic)) throw new AiFailure(503, 'IMAGE_MODEL_UNSUPPORTED', '当前 AI_IMAGE_MODEL 不是图片接口支持的生图模型，请改为该分组已授权的图片模型。');
      if ([401, 403].includes(response.status)) throw new AiFailure(502, 'IMAGE_AUTH', '生图服务授权失败，请检查服务端生图密钥及模型权限。');
      if (response.status === 429) throw new AiFailure(429, 'IMAGE_RATE_LIMIT', '生图服务限流或额度不足，请检查额度后重试。');
      if (needsReference) throw new AiFailure(502, 'IMAGE_REFERENCE_UPSTREAM', '主体图已保留，但参考图生图失败。请核对图片模型与服务商是否支持 images/edits 上传参考图片；未改用独立文字生图，也未自动重复提交。');
      throw new AiFailure(502, 'IMAGE_UPSTREAM', '生图调用失败，请核对模型是否支持 images/generations 接口。未自动重复扣费请求。');
    }
    let payload: { data?: { b64_json?: unknown; url?: unknown }[]; usage?: unknown };
    try { payload = JSON.parse(await responseText(response, MAX_IMAGE_BYTES * 1.5)); }
    catch (error) { if (error instanceof AiFailure) throw error; throw new AiFailure(502, 'IMAGE_INVALID_RESPONSE', '生图服务未返回有效 JSON。'); }
    usage = payload?.usage;
    const image = payload?.data?.[0];
    let bytes: Buffer;
    if (typeof image?.b64_json === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json)) bytes = Buffer.from(image.b64_json, 'base64');
    else if (typeof image?.url === 'string') bytes = await downloadImage(image.url, combined);
    else throw new AiFailure(502, 'IMAGE_EMPTY', '生图服务未返回图片，未使用占位图替代。');
    if (bytes.length > MAX_IMAGE_BYTES) throw new AiFailure(502, 'IMAGE_TOO_LARGE', '生成图片超过大小限制，请降低生图尺寸后重试。');
    const mimeType = imageMime(bytes);
    const reference = signProductArtifact('image', { id: randomUUID(), briefId: brief.id, kind, templateId, mimeType,
      digest: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() }, config);
    return { ...reference, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, prompt, model: settings.model };
  } catch (error) {
    await markAiResponseFailure(auditResponse, error);
    if (signal.aborted) throw new AiFailure(499, 'AI_CANCELLED', '已取消生图请求；已有成果仍保留。');
    if (timeout?.aborted) throw new AiFailure(504, 'IMAGE_TIMEOUT', '生图超时；上游可能仍在处理，未自动重复提交。请稍后手动重试。');
    if (error instanceof AiFailure) throw error;
    throw new AiFailure(502, 'IMAGE_NETWORK', '生图网络连接失败，未自动重复提交；请稍后重试。');
  } finally {
    releaseImageSlot?.();
    recordUsage(usage);
  }
}
