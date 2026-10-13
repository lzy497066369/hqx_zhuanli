import { idbGet, idbSet } from './idb.ts';
import { getStorageDriver, queuedWriter, storageRequest } from './storageApi.ts';

export type Material = { id: string; name: string; size: number; mimeType?: string; lastModified?: number };
let revision: number | undefined;
let saved = '';
const writes = queuedWriter();

export async function loadMaterialsAsync(): Promise<Material[]> {
  if (await getStorageDriver() === 'indexeddb') {
    try { const value = await idbGet('materials'); return Array.isArray(value) ? value as Material[] : []; }
    catch { return []; }
  }
  const result = await storageRequest<{ materials: Material[]; revision: number }>('materials');
  revision = result.revision;
  saved = JSON.stringify(result.materials);
  writes.reset();
  return result.materials;
}
export async function saveMaterialsAsync(materials: Material[]): Promise<boolean> {
  if (await getStorageDriver() === 'indexeddb') {
    try { await idbSet('materials', materials); return true; } catch { return false; }
  }
  const snapshot = JSON.stringify(materials);
  return writes.run(async () => {
    if (revision === undefined) throw new Error('资料库尚未加载，无法保存。');
    if (snapshot === saved) return;
    const result = await storageRequest<{ revision: number }>('materials', 'PUT', { materials: JSON.parse(snapshot), revision });
    revision = result.revision;
    saved = snapshot;
  });
}
