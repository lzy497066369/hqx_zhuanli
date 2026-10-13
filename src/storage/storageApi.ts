// Only same-origin HTTP reaches the browser; MySQL credentials stay on the server.
import { workspaceHeaders } from './workspaceContext';
let driver: 'mysql' | 'indexeddb' = 'mysql';
let configPromise: Promise<'mysql' | 'indexeddb'> | undefined;
let pending = 0;
let unsaved = false;
let lastError = '';
const writes = new Set<Promise<unknown>>();
export async function flushStorage(): Promise<void> {
  window.dispatchEvent(new Event('zhichuang:flush-drafts'));
  // Draft writers await the already-loaded storage config before joining writes.
  await Promise.resolve();
  while (writes.size) await Promise.all([...writes]);
  if (unsaved) throw new Error(lastError || '当前修改尚未保存，请先导出备份再切换工作空间。');
}

export function storageError() {
  return lastError || '浏览器存储不可用，本次修改仅在当前页面保留。';
}
export function storageFailure(error: unknown) {
  unsaved = true;
  lastError = error instanceof Error ? error.message : '保存失败。';
}
export async function storageRequest<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/storage/${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000),
      headers: { ...workspaceHeaders(), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  } catch { throw new Error('无法连接项目存储服务，数据尚未保存。'); }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error?.message || '项目存储服务不可用，数据尚未保存。');
  return result as T;
}
export function getStorageDriver(): Promise<'mysql' | 'indexeddb'> {
  configPromise ??= storageRequest<{ driver: 'mysql' | 'indexeddb' }>('config').then(result => {
    if (!['mysql', 'indexeddb'].includes(result.driver)) throw new Error('存储服务配置无效。');
    driver = result.driver;
    return driver;
  }).catch(error => { configPromise = undefined; throw error; });
  return configPromise;
}
export function queuedWriter() {
  let tail = Promise.resolve();
  let failed = false;
  return {
    reset() { failed = false; },
    run(task: () => Promise<void>): Promise<boolean> {
      pending++;
      const operation = tail.then(async () => {
        if (failed) return false;
        try { await task(); return true; }
        catch (error) { failed = true; storageFailure(error); return false; }
      }).finally(() => { pending--; });
      tail = operation.then(() => undefined);
      writes.add(operation);
      void operation.finally(() => { writes.delete(operation); });
      return operation;
    },
  };
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (pending || unsaved) { event.preventDefault(); event.returnValue = ''; }
});
