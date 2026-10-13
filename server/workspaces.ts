import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RowDataPacket, PoolConnection } from 'mysql2/promise';
import type { MysqlDatabase } from './mysql/database.ts';

export class WorkspaceFailure extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export async function ensurePersonalWorkspace(connection: PoolConnection, userId: string) {
  await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT id FROM workspaces WHERE owner_user_id = ? LIMIT 1', [userId]);
  if (!rows.length) await connection.execute('INSERT INTO workspaces (id,owner_user_id,name,description,projects_initialized) VALUES (?,?,?,?,TRUE)', [randomUUID(), userId, '我的工作空间', '']);
}
function fields(input: Record<string, unknown>) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!name || name.length > 80 || (input.description !== undefined && typeof input.description !== 'string') || description.length > 500) throw new WorkspaceFailure(400, 'INVALID_WORKSPACE', '空间名称需为 1–80 个字符，简介最多 500 个字符。');
  return { name, description };
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export async function handleWorkspaces(req: IncomingMessage, res: ServerResponse, database: MysqlDatabase, userId: string, readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>) {
  const path = (req.url || '').split('?')[0];
  if (path === '/api/workspaces') {
    if (req.method === 'GET') {
      const workspaces = await database.transaction(async connection => {
        await ensurePersonalWorkspace(connection, userId);
        const [rows] = await connection.execute<RowDataPacket[]>('SELECT id,name,description,created_at AS createdAt,updated_at AS updatedAt FROM workspaces WHERE owner_user_id = ? ORDER BY created_at,id', [userId]);
        return rows;
      });
      send(res, 200, { workspaces }); return;
    }
    if (req.method === 'POST') {
      const { name, description } = fields(await readBody(req));
      const workspace = { id: randomUUID(), name, description };
      await database.transaction(async connection => {
        await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
        const [rows] = await connection.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM workspaces WHERE owner_user_id = ?', [userId]);
        if (rows[0].count >= 100) throw new WorkspaceFailure(400, 'WORKSPACE_LIMIT', '最多创建 100 个工作空间。');
        await connection.execute('INSERT INTO workspaces (id,owner_user_id,name,description,projects_initialized) VALUES (?,?,?,?,TRUE)', [workspace.id,userId,name,description]);
      });
      send(res, 201, { workspace }); return;
    }
    throw new WorkspaceFailure(405, 'METHOD_NOT_ALLOWED', '请求方法不支持。');
  }
  const workspaceId = path.slice('/api/workspaces/'.length);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId)) throw new WorkspaceFailure(404, 'WORKSPACE_NOT_FOUND', '工作空间不存在或无权访问。');
  if (req.method !== 'PATCH' && req.method !== 'DELETE') throw new WorkspaceFailure(405, 'METHOD_NOT_ALLOWED', '请求方法不支持。');
  const input = await readBody(req);
  const result = await database.transaction(async connection => {
    // Always lock owner before workspace, including deletion and default creation.
    await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT id,name,description FROM workspaces WHERE id = ? AND owner_user_id = ? FOR UPDATE', [workspaceId,userId]);
    if (!rows.length) throw new WorkspaceFailure(404, 'WORKSPACE_NOT_FOUND', '工作空间不存在或无权访问。');
    if (req.method === 'DELETE') {
      if (input.confirmName !== rows[0].name) throw new WorkspaceFailure(400, 'CONFIRM_NAME_REQUIRED', '请输入完整的工作空间名称确认删除。');
      await connection.execute('DELETE FROM workspaces WHERE id = ? AND owner_user_id = ?', [workspaceId,userId]);
      // Keep an empty personal space if the final one is deleted.
      await ensurePersonalWorkspace(connection, userId);
      return { success: true };
    }
    const { name, description } = fields(input);
    await connection.execute('UPDATE workspaces SET name = ?,description = ? WHERE id = ? AND owner_user_id = ?', [name,description,workspaceId,userId]);
    return { workspace: { id: workspaceId, name, description } };
  });
  send(res, 200, result);
}
