export async function adminRequest<T>(path: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal: signal || AbortSignal.timeout(20000), headers: data === undefined ? undefined : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `请求失败（${response.status}）`);
  return result as T;
}
