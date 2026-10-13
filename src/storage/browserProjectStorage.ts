// Async project + naming-draft persistence backed by IndexedDB.
// First launch imports the legacy localStorage snapshot once; localStorage is
// kept afterwards only as a disaster-recovery backup and is never written again.
// Every function degrades to the legacy synchronous reader when IndexedDB is
// unavailable (private mode, quota, old browsers) instead of throwing.
import { emptyProfile, isNamingRecord, utilityDraftKey } from "../features/utility/naming.ts";
import type { NamingRecord } from "../features/utility/naming.ts";
import { loadProjects, sanitizeProjects } from "../data.ts";
import type { Project } from "../data.ts";
import { idbDel, idbGet, idbSet, isIdbAvailable } from "./idb.ts";

const PROJECTS_KEY = "projects";
const MIGRATED_KEY = "meta:migrated-v1";
const draftKey = (projectId?: string) => `naming-draft:${projectId || "new"}`;

export async function loadProjectsAsync(): Promise<Project[]> {
  const legacy = loadProjects();
  if (!isIdbAvailable()) return legacy;
  try {
    if (!(await idbGet(MIGRATED_KEY))) {
      await idbSet(PROJECTS_KEY, legacy);
      await idbSet(MIGRATED_KEY, new Date().toISOString());
      return legacy;
    }
    const stored = await idbGet(PROJECTS_KEY);
    // A missing value with the migration flag set means a broken store;
    // prefer the untouched localStorage backup over demo data.
    return stored === undefined ? legacy : sanitizeProjects(stored);
  } catch {
    return legacy;
  }
}

export async function saveProjectsAsync(projects: Project[]): Promise<boolean> {
  if (!isIdbAvailable()) return false;
  try {
    await idbSet(PROJECTS_KEY, projects);
    return true;
  } catch {
    return false;
  }
}

function legacyDraft(projectId: string | undefined, project?: Project): NamingRecord {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(utilityDraftKey(projectId)) || "null");
    if (isNamingRecord(value)) return value;
  } catch {
    /* Fall back to saved project when storage is corrupt. */
  }
  return projectNamingDraft(project);
}

export function projectNamingDraft(project?: Project): NamingRecord {
  if (project?.naming && isNamingRecord(project.naming)) return project.naming;
  if (project)
    return {
      version: 1,
      profile: { ...emptyProfile, company: project.owner },
      candidates: [],
      selectedName: project.name,
      confirmed: false,
    };
  return {
    version: 1,
    profile: { ...emptyProfile },
    candidates: [],
    selectedName: "",
    confirmed: false,
  };
}

export async function loadNamingDraftAsync(
  projectId: string | undefined,
  project?: Project,
): Promise<NamingRecord> {
  const fallback = legacyDraft(projectId, project);
  if (!isIdbAvailable()) return fallback;
  try {
    const stored = await idbGet(draftKey(projectId));
    if (isNamingRecord(stored)) return stored;
    // Lazy migration: import the legacy draft once, then drop the old key.
    await idbSet(draftKey(projectId), fallback);
    try {
      localStorage.removeItem(utilityDraftKey(projectId));
    } catch {
      /* The form reports storage errors. */
    }
    return fallback;
  } catch {
    return fallback;
  }
}

// Read-only migration source: preserve browser backups after migration to MySQL.
export async function loadBrowserNamingDraft(projectId?: string, project?: Project): Promise<NamingRecord> {
  if (isIdbAvailable()) {
    try {
      const stored = await idbGet(draftKey(projectId));
      if (isNamingRecord(stored)) return stored;
    } catch { /* Keep legacy backup. */ }
  }
  return legacyDraft(projectId, project);
}

export async function saveNamingDraft(
  projectId: string | undefined,
  draft: NamingRecord,
): Promise<boolean> {
  if (!isIdbAvailable()) return false;
  try {
    await idbSet(draftKey(projectId), draft);
    return true;
  } catch {
    return false;
  }
}

export function deleteNamingDraft(projectId?: string): Promise<void> {
  if (!isIdbAvailable()) return Promise.resolve();
  return idbDel(draftKey(projectId)).catch(() => undefined);
}
