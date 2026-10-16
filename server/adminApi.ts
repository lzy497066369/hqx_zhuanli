import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RowDataPacket } from 'mysql2/promise';
import type { MysqlDatabase } from './mysql/database.ts';
import { hashPassword } from './passwords.ts';
import { ensurePersonalWorkspace } from './workspaces.ts';
import type { AiLog, AdminUser, AdminProject } from '../src/features/admin/types.ts';

class AdminFailure extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function send(res: ServerResponse, status: number, data: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); }
const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;
const date = (value: unknown) => value ? new Date(value as string).toISOString() : null;
const number = (value: unknown) => value === null || value === undefined ? null : Number(value);
function pagination(url: URL) {
  const page = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 25);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new AdminFailure(400, '分页参数无效。');
  return { page, pageSize, offset: (page - 1) * pageSize };
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AdminFailure(415, '请使用 JSON 提交。');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 8192) throw new AdminFailure(413, '提交内容过长。'); chunks.push(Buffer.from(chunk)); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (result && typeof result === 'object' && !Array.isArray(result)) return result; } catch { /* validation below */ }
  throw new AdminFailure(400, 'JSON 格式无效。');
}
function account(input: Record<string, unknown>, creating: boolean) {
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new AdminFailure(400, '账号需为 3–32 位字母、数字或下划线。');
  if (!displayName || displayName.length > 80) throw new AdminFailure(400, '昵称需为 1–80 个字符。');
  if (creating || input.password !== undefined && input.password !== '') {
    if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128 || !input.password.trim()) throw new AdminFailure(400, '密码需为 8–128 位。');
  }
  if (input.role !== undefined && !['user', 'admin'].includes(String(input.role))) throw new AdminFailure(400, '角色无效。');
  if (input.disabled !== undefined && typeof input.disabled !== 'boolean') throw new AdminFailure(400, '账号状态无效。');
  return { username, displayName, role: String(input.role || 'user'), password: typeof input.password === 'string' && input.password ? input.password : undefined };
}
function logRow(row: RowDataPacket): AiLog {
  return { id: row.id, requestId: row.request_id, userId: row.user_id, username: row.username || undefined, workspaceId: row.workspace_id, route: row.route, model: row.model, provider: row.provider,
    startedAt: date(row.started_at)!, finishedAt: date(row.finished_at), status: row.status, streaming: !!row.streaming, httpStatus: number(row.http_status), durationMs: number(row.duration_ms), firstTokenMs: number(row.first_token_ms),
    inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens), totalTokens: number(row.total_tokens), ...(row.details ? { details: json(row.details) } : {}) };
}
export async function writeAiLog(database: MysqlDatabase, log: AiLog) {
  await database.ready();
  await database.pool.execute(`INSERT INTO ai_request_logs (id,request_id,user_id,workspace_id,route,model,provider,started_at,finished_at,status,streaming,http_status,duration_ms,first_token_ms,input_tokens,output_tokens,total_tokens,details)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE finished_at=VALUES(finished_at),status=VALUES(status),http_status=VALUES(http_status),duration_ms=VALUES(duration_ms),first_token_ms=VALUES(first_token_ms),input_tokens=VALUES(input_tokens),output_tokens=VALUES(output_tokens),total_tokens=VALUES(total_tokens),details=VALUES(details)`,
  [log.id, log.requestId, log.userId, log.workspaceId, log.route.slice(0,255), log.model.slice(0,255), log.provider.slice(0,512), new Date(log.startedAt), log.finishedAt ? new Date(log.finishedAt) : null, log.status, log.streaming, log.httpStatus, log.durationMs, log.firstTokenMs, log.inputTokens, log.outputTokens, log.totalTokens, JSON.stringify(log.details)]);
}
function userRow(row: RowDataPacket): AdminUser { return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, disabledAt: date(row.disabled_at), createdAt: date(row.created_at)!, lastLoginAt: date(row.last_login_at), workspaceCount: Number(row.workspace_count || 0), projectCount: Number(row.project_count || 0) }; }
function projectRow(row: RowDataPacket): AdminProject { return { id: row.id, name: row.name, category: row.category, status: row.status, owner: row.owner, workspaceId: row.workspace_id, workspaceName: row.workspace_name, userId: row.user_id, username: row.username, updatedAt: date(row.updated_at)!, ...(row.data ? { data: json(row.data) } : {}) }; }

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, database: MysqlDatabase, actor: { id: string; role: string }) {
  try {
    if (actor.role !== 'admin') throw new AdminFailure(403, '仅管理员可以访问。');
    await database.ready();
    const url = new URL(req.url || '/', 'http://localhost'), path = url.pathname.slice('/api/admin'.length);
    const query = url.searchParams, { page, pageSize, offset } = pagination(url);
    if (req.method === 'GET' && (path === '/ai-requests' || /^\/ai-requests\/[^/]+$/.test(path))) {
      if (path !== '/ai-requests') {
        const [rows] = await database.pool.execute<RowDataPacket[]>('SELECT l.*,u.username FROM ai_request_logs l LEFT JOIN users u ON u.id=l.user_id WHERE l.id=?', [path.split('/')[2]]);
        if (!rows.length) throw new AdminFailure(404, '请求记录不存在。');
        send(res, 200, logRow(rows[0])); return;
      }
      const conditions: string[] = [], values: (string | boolean | Date | null)[] = [];
      for (const [key, column] of [['userId','l.user_id'],['model','l.model'],['requestId','l.request_id']] as const) if (query.get(key)) { conditions.push(`${column}=?`); values.push(query.get(key)); }
      if (query.get('status')) { if (!['running','success','failed','cancelled'].includes(query.get('status')!)) throw new AdminFailure(400, '结果筛选无效。'); conditions.push('l.status=?'); values.push(query.get('status')); }
      if (query.has('streaming') && query.get('streaming') !== '') { if (!['true','false'].includes(query.get('streaming')!)) throw new AdminFailure(400, '调用方式无效。'); conditions.push('l.streaming=?'); values.push(query.get('streaming') === 'true'); }
      for (const [key, operator] of [['from','>='],['to','<=']] as const) if (query.get(key)) { const value = new Date(query.get(key)!); if (!Number.isFinite(value.getTime())) throw new AdminFailure(400, '时间范围无效。'); conditions.push(`l.started_at ${operator} ?`); values.push(value); }
      if (query.get('q')) { conditions.push('(u.username LIKE ? OR l.model LIKE ? OR l.route LIKE ? OR l.request_id LIKE ?)'); values.push(...Array(4).fill(`%${query.get('q')!.slice(0,200)}%`)); }
      const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
      const join = ' FROM ai_request_logs l LEFT JOIN users u ON u.id=l.user_id';
      const [stats] = await database.pool.execute<RowDataPacket[]>(`SELECT COUNT(*) total,COALESCE(SUM(l.status='success'),0) success,COALESCE(SUM(l.status IN ('failed','cancelled')),0) failed,COALESCE(SUM(l.status='running'),0) running,SUM(l.total_tokens) tokens,COALESCE(SUM(l.total_tokens IS NULL),0) unreported${join}${where}`, values);
      const [rows] = await database.pool.execute<RowDataPacket[]>(`SELECT l.id,l.request_id,l.user_id,u.username,l.workspace_id,l.route,l.model,l.provider,l.started_at,l.finished_at,l.status,l.streaming,l.http_status,l.duration_ms,l.first_token_ms,l.input_tokens,l.output_tokens,l.total_tokens${join}${where} ORDER BY l.started_at DESC,l.id DESC LIMIT ${pageSize} OFFSET ${offset}`, values);
      send(res, 200, { items: rows.map(logRow), page, pageSize, total: Number(stats[0].total), summary: { success: Number(stats[0].success), failed: Number(stats[0].failed), running: Number(stats[0].running), tokens: number(stats[0].tokens), unreported: Number(stats[0].unreported) } }); return;
    }
    if (path === '/users' && req.method === 'GET') {
      const where = query.get('q') ? ' WHERE (u.username LIKE ? OR u.display_name LIKE ?)' : '', values = where ? Array(2).fill(`%${query.get('q')!.slice(0,200)}%`) : [];
      const [count] = await database.pool.execute<RowDataPacket[]>(`SELECT COUNT(*) total FROM users u${where}`, values);
      const [rows] = await database.pool.execute<RowDataPacket[]>(`SELECT u.id,u.username,u.display_name,u.role,u.disabled_at,u.created_at,u.last_login_at,(SELECT COUNT(*) FROM workspaces w WHERE w.owner_user_id=u.id) workspace_count,(SELECT COUNT(*) FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE w.owner_user_id=u.id) project_count FROM users u${where} ORDER BY u.created_at DESC,u.id DESC LIMIT ${pageSize} OFFSET ${offset}`, values);
      send(res, 200, { items: rows.map(userRow), total: Number(count[0].total), page, pageSize }); return;
    }
    if (path === '/users' && req.method === 'POST') {
      const input = await body(req), data = account(input, true), id = randomUUID(), hash = await hashPassword(data.password!);
      if (data.username === 'admin') throw new AdminFailure(409, 'admin 为默认管理员保留账号。');
      await database.transaction(async connection => { await connection.execute('INSERT INTO users (id,username,display_name,password_hash,role,disabled_at) VALUES (?,?,?,?,?,?)', [id,data.username,data.displayName,hash,data.role,input.disabled ? new Date() : null]); await ensurePersonalWorkspace(connection, id); });
      send(res, 201, { id }); return;
    }
    if (/^\/users\/[^/]+$/.test(path) && ['PATCH','DELETE'].includes(req.method || '')) {
      const id = path.split('/')[2], input = await body(req);
      const data = req.method === 'PATCH' ? account(input, false) : undefined;
      const hash = data?.password ? await hashPassword(data.password) : undefined;
      await database.transaction(async connection => {
        const [rows] = await connection.execute<RowDataPacket[]>('SELECT id,username,role FROM users WHERE id=? FOR UPDATE', [id]);
        if (!rows.length) throw new AdminFailure(404, '用户不存在。');
        const current = rows[0];
        if (req.method === 'DELETE') {
          if (id === actor.id || current.username === 'admin') throw new AdminFailure(400, '不能删除当前账号或默认管理员。');
          if (input.confirmUsername !== current.username) throw new AdminFailure(400, '请输入账号确认删除。');
          await connection.execute('DELETE FROM users WHERE id=?', [id]); return;
        }
        if ((id === actor.id || current.username === 'admin') && (input.disabled === true || data!.role !== 'admin')) throw new AdminFailure(400, '不能禁用当前账号或取消默认管理员权限。');
        if (current.username === 'admin' && data!.username !== 'admin' || current.username !== 'admin' && data!.username === 'admin') throw new AdminFailure(400, '默认管理员账号名为 admin，不可修改或占用。');
        await connection.execute(`UPDATE users SET username=?,display_name=?,role=?,disabled_at=${input.disabled === undefined ? 'disabled_at' : input.disabled ? 'UTC_TIMESTAMP(3)' : 'NULL'}${hash ? ',password_hash=?' : ''} WHERE id=?`, [data!.username,data!.displayName,data!.role,...(hash ? [hash] : []),id]);
        // Password, identity and permission changes invalidate every old session.
        await connection.execute('DELETE FROM user_sessions WHERE user_id=?', [id]);
      });
      send(res, 200, { success: true }); return;
    }
    if (path === '/projects' && req.method === 'GET') {
      const conditions: string[] = [], values: (string | null)[] = [];
      if (query.get('userId')) { conditions.push('w.owner_user_id=?'); values.push(query.get('userId')); }
      if (query.get('q')) { conditions.push('(p.name LIKE ? OR u.username LIKE ? OR w.name LIKE ?)'); values.push(...Array(3).fill(`%${query.get('q')!.slice(0,200)}%`)); }
      const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', join = ' FROM projects p JOIN workspaces w ON w.id=p.workspace_id LEFT JOIN users u ON u.id=w.owner_user_id';
      const [count] = await database.pool.execute<RowDataPacket[]>(`SELECT COUNT(*) total${join}${where}`, values);
      const [rows] = await database.pool.execute<RowDataPacket[]>(`SELECT p.id,p.name,p.category,p.status,p.owner,p.workspace_id,p.updated_at,w.name workspace_name,w.owner_user_id user_id,u.username${join}${where} ORDER BY p.updated_at DESC,p.id DESC LIMIT ${pageSize} OFFSET ${offset}`, values);
      send(res, 200, { items: rows.map(projectRow), total: Number(count[0].total), page, pageSize }); return;
    }
    if (path === '/project' && req.method === 'GET') {
      const [rows] = await database.pool.execute<RowDataPacket[]>('SELECT p.*,w.name workspace_name,w.owner_user_id user_id,u.username FROM projects p JOIN workspaces w ON w.id=p.workspace_id LEFT JOIN users u ON u.id=w.owner_user_id WHERE p.workspace_id=? AND p.id=?', [query.get('workspaceId') || '', query.get('id') || '']);
      if (!rows.length) throw new AdminFailure(404, '项目不存在。'); send(res, 200, projectRow(rows[0])); return;
    }
    if (path === '/workspaces' && req.method === 'GET') {
      const [rows] = await database.pool.execute<RowDataPacket[]>('SELECT w.id,w.name,w.description,w.owner_user_id userId,w.created_at createdAt,(SELECT COUNT(*) FROM projects p WHERE p.workspace_id=w.id) projectCount FROM workspaces w WHERE w.owner_user_id=? ORDER BY w.created_at DESC', [query.get('userId') || '']);
      send(res, 200, { items: rows }); return;
    }
    throw new AdminFailure(404, '管理接口不存在或请求方法不支持。');
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof AdminFailure) send(res, error.status, { error: { code: 'ADMIN_ERROR', message: error.message } });
    else if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') send(res, 409, { error: { code: 'USERNAME_EXISTS', message: '账号已存在。' } });
    else { console.error('Admin API failed', error instanceof Error ? error.name : 'unknown'); send(res, 503, { error: { code: 'ADMIN_UNAVAILABLE', message: '管理服务暂时不可用，请重试。' } }); }
  }
}
