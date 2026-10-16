import type { Project } from '../data';
import { companiesFromProjects, isCompanies } from '../features/projects/company';
import type { Company } from '../features/projects/company';
import { idbGet, idbSet, isIdbAvailable } from './idb';
import { getStorageDriver, queuedWriter, storageRequest } from './storageApi';
import { currentWorkspaceId } from './workspaceContext';

type Snapshot = { companies: Company[]; revision: number; initialized: boolean };
let companiesRevision: number | undefined;
let savedCompanies = '';
const writes = queuedWriter();
const browserKey = () => `companies:${currentWorkspaceId() || 'local'}`;

export async function loadCompaniesAsync(projects: Project[]): Promise<Company[]> {
  const fallback = companiesFromProjects(projects);
  if (await getStorageDriver() === 'indexeddb') {
    writes.reset();
    if (!isIdbAvailable()) return fallback;
    const stored = await idbGet(browserKey()).catch(() => undefined);
    if (stored !== undefined) {
      if (!isCompanies(stored)) throw new Error('企业资料格式无效，未覆盖原始数据。');
      return stored;
    }
    await idbSet(browserKey(), fallback).catch(() => undefined);
    return fallback;
  }
  let snapshot = await storageRequest<Snapshot>('companies');
  if (!snapshot.initialized) {
    try { await storageRequest('companies', 'PUT', { companies: fallback, revision: snapshot.revision }); }
    catch (error) {
      const current = await storageRequest<Snapshot>('companies');
      if (!current.initialized) throw error;
    }
    snapshot = await storageRequest<Snapshot>('companies');
  }
  if (!isCompanies(snapshot.companies)) throw new Error('企业资料格式无效，未覆盖原始数据。');
  companiesRevision = snapshot.revision; savedCompanies = JSON.stringify(snapshot.companies); writes.reset();
  return snapshot.companies;
}

export async function saveCompaniesAsync(companies: Company[]): Promise<boolean> {
  const serialized = JSON.stringify(companies);
  const key = browserKey();
  const driver = await getStorageDriver();
  return writes.run(async () => {
    if (driver === 'indexeddb') {
      try { await idbSet(key, companies); }
      catch { throw new Error('浏览器存储不可用，企业资料仅在当前页面保留。'); }
      return;
    }
    if (companiesRevision === undefined) throw new Error('企业资料尚未加载，无法保存。');
    if (serialized === savedCompanies) return;
    const result = await storageRequest<{ revision: number }>('companies', 'PUT', { companies: JSON.parse(serialized), revision: companiesRevision });
    companiesRevision = result.revision; savedCompanies = serialized;
  });
}
