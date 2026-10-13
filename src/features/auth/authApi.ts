export type AuthUser = { id: string; username: string; displayName: string; role: string };
export async function authRequest<T>(path: string, value?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/auth/${path}`, { method: value === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: value === undefined ? undefined : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(15000) });
  } catch { throw new Error('无法连接账号服务，请检查网络后重试。'); }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error?.message || '账号服务暂时不可用，请稍后重试。');
  return result as T;
}
