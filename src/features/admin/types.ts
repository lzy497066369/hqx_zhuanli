export type AiLog = {
  id: string; requestId: string; userId: string | null; username?: string; workspaceId: string | null;
  route: string; model: string; provider: string; startedAt: string; finishedAt: string | null;
  status: 'running' | 'success' | 'failed' | 'cancelled'; streaming: boolean; httpStatus: number | null;
  durationMs: number | null; firstTokenMs: number | null; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  details?: Record<string, unknown>;
};
export type AdminUser = { id: string; username: string; displayName: string; role: string; disabledAt: string | null; createdAt: string; lastLoginAt: string | null; workspaceCount: number; projectCount: number };
export type AdminProject = { id: string; name: string; category: string; status: string; owner: string; workspaceId: string; workspaceName: string; userId: string; username: string; updatedAt: string; data?: Record<string, unknown> };
export type PageResult<T> = { items: T[]; total: number; page: number; pageSize: number; summary?: { success: number; failed: number; running: number; tokens: number | null; unreported: number } };
