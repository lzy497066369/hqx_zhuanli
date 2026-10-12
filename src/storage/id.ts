// 浏览器只在「安全上下文」（https 或 localhost）里提供 crypto.randomUUID。
// 局域网 http://192.168.x.x 访问时它是 undefined，直接调用会抛 TypeError，
// 保存动作悄悄失败、按钮看起来"点不动"。这里退回到 getRandomValues 拼出同样形状的 UUID v4。
export function newId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (webCrypto && typeof webCrypto.getRandomValues === "function") webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
