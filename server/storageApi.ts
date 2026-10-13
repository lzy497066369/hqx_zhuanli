import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RowDataPacket, PoolConnection } from 'mysql2/promise';
import { MysqlDatabase } from './mysql/database.ts';
import type { StorageConfig } from './mysql/database.ts';
import { requestContext } from './requestContext.ts';

const ROOT = '/api/storage';
const MAX_BODY = 96 * 1024 * 1024;
class StorageFailure extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
function invalid(): never { throw new StorageFailure(400, 'INVALID_INPUT', '存储数据格式不正确。'); }
function conflict(): never { throw new StorageFailure(409, 'STORAGE_CONFLICT', '其他页面已修改数据，本次修改未保存。请保留当前内容，再刷新后重试。'); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function string(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max; }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < 4294967295; }
function json(value: unknown): unknown { return typeof value === 'string' ? JSON.parse(value) : value; }

type ProjectInput = { id: string; name: string; category: string; owner: string; description: string; status: string; demo?: boolean };
type MaterialInput = { id: string; name: string; size: number; mimeType?: string; lastModified?: number };
function projects(value: unknown): ProjectInput[] {
  if (!Array.isArray(value) || value.length > 5000) invalid();
  const seen = new Set();
  for (const p of value) {
    if (!record(p) || !id(p.id) || seen.has(p.id) || !string(p.name, 500) || !p.name.trim() || !string(p.owner, 500) ||
      !string(p.description, 200000) || !['invention','utility','design','software'].includes(String(p.category)) ||
      !['draft','ready'].includes(String(p.status)) || !string(p.updatedAt, 64) || Number.isNaN(Date.parse(p.updatedAt)) ||
      (p.demo !== undefined && typeof p.demo !== 'boolean')) invalid();
    seen.add(p.id);
  }
  return value;
}
function materials(value: unknown): MaterialInput[] {
  if (!Array.isArray(value) || value.length > 5000) invalid();
  const seen = new Set();
  for (const m of value) {
    if (!record(m) || !id(m.id) || seen.has(m.id) || !string(m.name, 1024) || !m.name ||
      !Number.isSafeInteger(m.size) || Number(m.size) < 0 || !string(m.mimeType ?? '', 255) ||
      !Number.isSafeInteger(m.lastModified ?? 0) || Number(m.lastModified ?? 0) < 0) invalid();
    seen.add(m.id);
  }
  return value;
}
function draft(value: unknown): Record<string, unknown> {
  if (!record(value) || value.version !== 1 || !record(value.profile) ||
    !['company','business','product','features','excludedTerms'].every(key => string((value.profile as Record<string, unknown>)[key], 200000)) ||
    !Array.isArray(value.candidates) || !string(value.selectedName, 500) || typeof value.confirmed !== 'boolean') invalid();
  return value;
}
function allowed(req: IncomingMessage, origins: Set<string>): boolean {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
    const url = new URL(`${proto}://${req.headers.host}`);
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return false;
    if (req.headers.origin && new URL(req.headers.origin).origin !== url.origin) return false;
    if (origins.has(url.origin)) return true;
    return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  } catch { return false; }
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new StorageFailure(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new StorageFailure(413, 'BODY_TOO_LARGE', '项目数据超过 96 MB，请拆分项目或压缩图片。');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new StorageFailure(413, 'BODY_TOO_LARGE', '项目数据超过 96 MB，请拆分项目或压缩图片。');
    chunks.push(Buffer.from(chunk));
  }
  let result: unknown;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid(); }
  if (!record(result)) invalid();
  return result;
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export function createStorageMiddleware(config: StorageConfig, allowedOrigins = process.env.ALLOWED_ORIGINS || '') {
  const database = config.driver === 'mysql' ? new MysqlDatabase(config) : undefined;
  const origins = new Set(allowedOrigins.split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean));
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url || '').split('?')[0];
    if (path !== ROOT && !path.startsWith(`${ROOT}/`)) { next(); return; }
    try {
      if (!allowed(req, origins)) throw new StorageFailure(403, 'ORIGIN_NOT_ALLOWED', '只允许同源访问存储接口。');
      if (path === `${ROOT}/config` && req.method === 'GET') { send(res, 200, { driver: config.driver }); return; }
      if (!database) throw new StorageFailure(503, 'MYSQL_DISABLED', '当前未启用 MySQL 存储。');
      if (path === `${ROOT}/health` && req.method === 'GET') { await database.ready(); await database.pool.query('SELECT 1'); send(res, 200, { status: 'ok', driver: 'mysql' }); return; }
      const context = requestContext(req);
      const workspaceId = context?.workspaceId || config.workspace;
      const assertWorkspace = async (connection: PoolConnection) => {
        if (!context) return;
        const [rows] = await connection.execute<RowDataPacket[]>('SELECT id FROM workspaces WHERE id = ? AND owner_user_id = ? FOR UPDATE', [workspaceId,context.userId]);
        if (!rows.length) throw new StorageFailure(404, 'WORKSPACE_NOT_FOUND', '工作空间不存在或无权访问。');
      };
      const resource = path === `${ROOT}/projects` ? 'projects' : path === `${ROOT}/materials` ? 'materials' : undefined;
      if (resource) {
        if (req.method === 'GET') {
          const result = await database.transaction(async connection => {
            await assertWorkspace(connection);
            // Lock the revision and rows together so a reader never gets a mixed snapshot.
            const [meta] = await connection.execute<RowDataPacket[]>('SELECT projects_revision, materials_revision, projects_initialized FROM workspaces WHERE id = ? FOR UPDATE', [workspaceId]);
            if (resource === 'projects') {
              // Sort positions in Node: MySQL filesort copies large JSON image payloads
              // into its sort buffer and can fail even for a single 5 MB project.
              const [rows] = await connection.execute<RowDataPacket[]>('SELECT position, data FROM projects WHERE workspace_id = ?', [workspaceId]);
              return { revision: meta[0].projects_revision, initialized: !!meta[0].projects_initialized, projects: rows.sort((a, b) => a.position - b.position).map(row => json(row.data)) };
            }
            const [rows] = await connection.execute<RowDataPacket[]>('SELECT id, name, size, mime_type AS mimeType, last_modified AS lastModified FROM materials WHERE workspace_id = ? ORDER BY position', [workspaceId]);
            return { revision: meta[0].materials_revision, materials: rows };
          });
          send(res, 200, result); return;
        }
        if (req.method !== 'PUT') throw new StorageFailure(405, 'METHOD_NOT_ALLOWED', '接口不支持此请求方法。');
        const input = await body(req);
        if (!revision(input.revision)) invalid();
        const values = resource === 'projects' ? projects(input.projects) : materials(input.materials);
        const result = await database.transaction(async connection => {
            await assertWorkspace(connection);
          const column = resource === 'projects' ? 'projects_revision' : 'materials_revision';
          const [meta] = await connection.execute<RowDataPacket[]>(`SELECT ${column} AS revision FROM workspaces WHERE id = ? FOR UPDATE`, [workspaceId]);
          if (meta[0].revision !== input.revision) conflict();
          // Delete only rows absent in the submitted snapshot. Stable rows retain created_at.
          const [current] = await connection.execute<RowDataPacket[]>(`SELECT id FROM ${resource} WHERE workspace_id = ?`, [workspaceId]);
          const ids = new Set(values.map(value => value.id));
          for (const row of current) {
            if (ids.has(row.id)) continue;
            await connection.execute(`DELETE FROM ${resource} WHERE workspace_id = ? AND id = ?`, [workspaceId, row.id]);
            if (resource === 'projects') await connection.execute('DELETE FROM naming_drafts WHERE workspace_id = ? AND draft_key = ?', [workspaceId, row.id]);
          }
          for (const [position, value] of values.entries()) {
            if (resource === 'projects') {
              const project = value as ProjectInput;
              await connection.execute(
              'INSERT INTO projects (workspace_id,id,name,category,owner,description,status,is_demo,position,data) VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),owner=VALUES(owner),description=VALUES(description),status=VALUES(status),is_demo=VALUES(is_demo),position=VALUES(position),data=VALUES(data)',
              [workspaceId,project.id,project.name,project.category,project.owner,project.description,project.status,!!project.demo,position,JSON.stringify(project)]);
            } else {
              const material = value as MaterialInput;
              await connection.execute(
              'INSERT INTO materials (workspace_id,id,name,size,mime_type,last_modified,position) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),size=VALUES(size),mime_type=VALUES(mime_type),last_modified=VALUES(last_modified),position=VALUES(position)',
              [workspaceId,material.id,material.name,material.size,material.mimeType || '',material.lastModified || 0,position]);
            }
          }
          await connection.execute(`UPDATE workspaces SET ${column} = ${column} + 1${resource === 'projects' ? ', projects_initialized = TRUE' : ''} WHERE id = ?`, [workspaceId]);
          return { revision: Number(input.revision) + 1 };
        });
        send(res, 200, result); return;
      }
      const prefix = `${ROOT}/naming-drafts/`;
      if (path.startsWith(prefix)) {
        const key = path.slice(prefix.length);
        if (!id(key)) invalid();
        if (req.method === 'GET') {
          const result = await database.transaction(async connection => {
            await assertWorkspace(connection);
            const [rows] = await connection.execute<RowDataPacket[]>('SELECT data, revision FROM naming_drafts WHERE workspace_id = ? AND draft_key = ?', [workspaceId, key]);
            return rows.length ? { draft: json(rows[0].data), revision: rows[0].revision } : { draft: null, revision: 0 };
          });
          send(res, 200, result); return;
        }
        if (req.method !== 'PUT' && req.method !== 'DELETE') throw new StorageFailure(405, 'METHOD_NOT_ALLOWED', '接口不支持此请求方法。');
        const input = await body(req);
        if (!revision(input.revision)) invalid();
        const value = req.method === 'PUT' ? draft(input.draft) : undefined;
        const result = await database.transaction(async connection => {
            await assertWorkspace(connection);
          // Serialize missing-row inserts and project deletion with workspace operations.
          await connection.execute('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [workspaceId]);
          const [rows] = await connection.execute<RowDataPacket[]>('SELECT revision FROM naming_drafts WHERE workspace_id = ? AND draft_key = ? FOR UPDATE', [workspaceId, key]);
          if ((rows[0]?.revision || 0) !== input.revision) conflict();
          if (req.method === 'DELETE') {
            // Tombstones stop stale tabs and browser backups from recreating cleared drafts.
            await connection.execute('INSERT INTO naming_drafts (workspace_id,draft_key,data,revision) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data), revision=VALUES(revision)', [workspaceId,key,'null',Number(input.revision) + 1]);
            return { revision: Number(input.revision) + 1 };
          }
          await connection.execute('INSERT INTO naming_drafts (workspace_id,draft_key,data,revision) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data), revision=VALUES(revision)', [workspaceId,key,JSON.stringify(value),Number(input.revision) + 1]);
          return { revision: Number(input.revision) + 1 };
        });
        send(res, 200, result); return;
      }
      throw new StorageFailure(404, 'NOT_FOUND', '存储接口不存在。');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof StorageFailure) send(res, error.status, { error: { code: error.code, message: error.message } });
      else send(res, 503, { error: { code: 'MYSQL_UNAVAILABLE', message: 'MySQL 连接或保存失败，数据尚未保存。请检查数据库服务与配置后重试。' } });
    }
  };
  return { middleware, close: () => database?.close() ?? Promise.resolve(), database };
}
