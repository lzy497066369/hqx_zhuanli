let workspaceId: string | undefined;
export function selectStorageWorkspace(id?: string) { workspaceId = id; }
export function currentWorkspaceId() { return workspaceId; }
export function workspaceHeaders(): Record<string, string> { return workspaceId ? { 'X-Workspace-Id': workspaceId } : {}; }
