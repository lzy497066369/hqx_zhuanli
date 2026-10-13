import type { Project } from '../data.ts';
import { sanitizeProjects } from '../data.ts';
import type { NamingRecord } from '../features/utility/naming.ts';
import { isNamingRecord } from '../features/utility/naming.ts';
import * as browser from './browserProjectStorage.ts';
import { getStorageDriver, queuedWriter, storageRequest } from './storageApi.ts';
import { namingFingerprint } from '../features/product/productWorkflow.ts';
import { currentWorkspaceId } from './workspaceContext';

function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

function restoreFingerprint(project: Project): Project {
  const workflow = project.productWorkflow;
  if (!workflow) return project;
  const current = namingFingerprint(project);
  try {
    // MySQL JSON reorders keys. Preserve the workflow only when its original
    // source and current source are semantically identical, including array order.
    if (canonical(JSON.parse(workflow.sourceFingerprint)) === canonical(JSON.parse(current))) {
      return { ...project, productWorkflow: { ...workflow, sourceFingerprint: current } };
    }
  } catch { /* Invalid or stale source markers keep their existing workflow gate. */ }
  return project;
}

type ProjectSnapshot = { projects: Project[]; revision: number; initialized: boolean };
let projectsRevision: number | undefined;
let savedProjects = '';
const projectWrites = queuedWriter();

export async function loadProjectsAsync(): Promise<Project[]> {
  if (await getStorageDriver() === 'indexeddb') return browser.loadProjectsAsync();
  let snapshot = await storageRequest<ProjectSnapshot>('projects');
  if (!snapshot.initialized) {
    const legacy = currentWorkspaceId() ? [] : await browser.loadProjectsAsync();
    try { await storageRequest('projects', 'PUT', { projects: legacy, revision: snapshot.revision }); }
    catch (error) {
      const current = await storageRequest<ProjectSnapshot>('projects');
      if (!current.initialized) throw error;
    }
    snapshot = await storageRequest<ProjectSnapshot>('projects');
  }
  projectsRevision = snapshot.revision;
  projectWrites.reset();
  const result = sanitizeProjects(snapshot.projects).map(restoreFingerprint);
  savedProjects = JSON.stringify(result);
  return result;
}

export async function saveProjectsAsync(projects: Project[]): Promise<boolean> {
  if (await getStorageDriver() === 'indexeddb') return browser.saveProjectsAsync(projects);
  const serialized = JSON.stringify(projects);
  return projectWrites.run(async () => {
    if (projectsRevision === undefined) throw new Error('项目尚未加载，无法保存。');
    if (serialized === savedProjects) return;
    const result = await storageRequest<{ revision: number }>('projects', 'PUT', { projects: JSON.parse(serialized), revision: projectsRevision });
    projectsRevision = result.revision;
    savedProjects = serialized;
  });
}

type DraftState = { revision: number; writer: ReturnType<typeof queuedWriter> };
const drafts = new Map<string, DraftState>();
const keyOf = (projectId?: string) => projectId || 'new';
export async function loadNamingDraftAsync(projectId?: string, project?: Project): Promise<NamingRecord> {
  if (await getStorageDriver() === 'indexeddb') return browser.loadNamingDraftAsync(projectId, project);
  const key = keyOf(projectId);
  let result = await storageRequest<{ draft: NamingRecord | null; revision: number }>(`naming-drafts/${key}`);
  if (!result.draft) {
    const fallback = result.revision === 0 && !currentWorkspaceId()
      ? await browser.loadBrowserNamingDraft(projectId, project)
      : browser.projectNamingDraft(project);
    try { await storageRequest(`naming-drafts/${key}`, 'PUT', { draft: fallback, revision: result.revision }); }
    catch (error) {
      const current = await storageRequest<{ draft: NamingRecord | null; revision: number }>(`naming-drafts/${key}`);
      if (!current.draft) throw error;
    }
    result = await storageRequest(`naming-drafts/${key}`);
  }
  if (!isNamingRecord(result.draft)) throw new Error('服务端命名草稿格式无效，未覆盖原始数据。');
  drafts.set(key, { revision: result.revision, writer: queuedWriter() });
  return result.draft;
}

export async function saveNamingDraft(projectId: string | undefined, draft: NamingRecord): Promise<boolean> {
  if (await getStorageDriver() === 'indexeddb') return browser.saveNamingDraft(projectId, draft);
  const key = keyOf(projectId);
  const state = drafts.get(key);
  if (!state) return false;
  const snapshot = JSON.parse(JSON.stringify(draft));
  return state.writer.run(async () => {
    const result = await storageRequest<{ revision: number }>(`naming-drafts/${key}`, 'PUT', { draft: snapshot, revision: state.revision });
    state.revision = result.revision;
  });
}

export async function deleteNamingDraft(projectId?: string): Promise<void> {
  if (await getStorageDriver() === 'indexeddb') return browser.deleteNamingDraft(projectId);
  const key = keyOf(projectId);
  const state = drafts.get(key);
  if (!state) return;
  await state.writer.run(async () => {
    const result = await storageRequest<{ revision: number }>(`naming-drafts/${key}`, 'DELETE', { revision: state.revision });
    state.revision = result.revision;
  });
}
