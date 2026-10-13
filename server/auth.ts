import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RowDataPacket, PoolConnection } from 'mysql2/promise';
import { MysqlDatabase } from './mysql/database.ts';
import type { StorageConfig } from './mysql/database.ts';
import { setRequestContext } from './requestContext.ts';
import { ensurePersonalWorkspace, handleWorkspaces, WorkspaceFailure } from './workspaces.ts';

const deriveKey = promisify(scrypt);
const COOKIE = 'zhichuang_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const DUMMY_HASH = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
export type AuthUser = { id: string; username: string; displayName: string; role: string };

class AuthFailure extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function sameOrigin(req: IncomingMessage, allowedOrigins: Set<string>): boolean {
  try {
    const protocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
    const host = new URL(`${protocol}://${req.headers.host}`);
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return false;
    if (req.headers.origin && new URL(req.headers.origin).origin !== host.origin) return false;
    if (allowedOrigins.has(host.origin)) return true;
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') && ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname);
  } catch { return false; }
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AuthFailure(415, 'JSON_REQUIRED', '请求必须使用 JSON。');
  if (Number(req.headers['content-length']) > 8192) throw new AuthFailure(413, 'BODY_TOO_LARGE', '提交内容过长。');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new AuthFailure(413, 'BODY_TOO_LARGE', '提交内容过长。');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Return the same validation error. */ }
  throw new AuthFailure(400, 'INVALID_JSON', '提交内容格式不正确。');
}
function credentials(input: Record<string, unknown>) {
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  const password = input.password;
  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new AuthFailure(400, 'INVALID_USERNAME', '账号需为 3–32 位字母、数字或下划线。');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || !password.trim()) throw new AuthFailure(400, 'INVALID_PASSWORD', '密码需为 8–128 位，不能只包含空格。');
  return { username, password };
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [, salt, digest] = hash.split(':');
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)) return false;
  const key = await deriveKey(password, salt, 64) as Buffer;
  return timingSafeEqual(key, Buffer.from(digest, 'hex'));
}
function publicUser(row: RowDataPacket): AuthUser {
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}
function cookieToken(req: IncomingMessage): string | undefined {
  const token = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
function setCookie(req: IncomingMessage, res: ServerResponse, token: string, logout = false) {
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!('encrypted' in req.socket && req.socket.encrypted);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${logout ? 0 : SESSION_SECONDS}${secure ? '; Secure' : ''}`);
}
async function createSession(connection: PoolConnection, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await connection.execute('DELETE FROM user_sessions WHERE user_id = ? AND expires_at <= UTC_TIMESTAMP(3)', [userId]);
  const [sessions] = await connection.execute<RowDataPacket[]>('SELECT token_hash FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  for (const session of sessions.slice(9)) await connection.execute('DELETE FROM user_sessions WHERE token_hash = ?', [session.token_hash]);
  await connection.execute('INSERT INTO user_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)', [tokenHash(token), userId, new Date(Date.now() + SESSION_SECONDS * 1000)]);
  await connection.execute('UPDATE users SET last_login_at = UTC_TIMESTAMP(3) WHERE id = ?', [userId]);
  return token;
}

export function createAuthMiddleware(config: StorageConfig, env: NodeJS.ProcessEnv = process.env) {
  // Explicitly disable only for isolated legacy tests; production defaults to authentication.
  const enabled = env.AUTH_REQUIRED !== 'false';
  const database = enabled ? new MysqlDatabase(config) : undefined;
  const origins = new Set((env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean));
  const attempts = new Map<string, { count: number; until: number }>();
  let active = 0;
  function throttle(req: IncomingMessage, username: string) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const keys = [`ip:${req.socket.remoteAddress}`, `username:${username}`];
    for (const key of keys) {
      const value = attempts.get(key) || { count: 0, until: now + 15 * 60000 };
      if (value.count >= (key.startsWith('ip:') ? 60 : 15) || attempts.size > 10000 || active >= 4) throw new AuthFailure(429, 'AUTH_RATE_LIMIT', '尝试次数过多，请稍后再试。');
      value.count++;
      attempts.set(key, value);
    }
  }
  async function currentUser(req: IncomingMessage): Promise<AuthUser | null> {
    const token = cookieToken(req);
    if (!database || !token) return null;
    await database.ready();
    const [rows] = await database.pool.execute<RowDataPacket[]>('SELECT u.id,u.username,u.display_name,u.role FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3)', [tokenHash(token)]);
    return rows[0] ? publicUser(rows[0]) : null;
  }
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url || '').split('?')[0];
    if (!path.startsWith('/api/')) { next(); return; }
    if (path === '/api/storage/health') { next(); return; }
    try {
      if (!sameOrigin(req, origins)) throw new AuthFailure(403, 'ORIGIN_NOT_ALLOWED', '只允许同源访问。');
      if (path === '/api/auth/me' && req.method === 'GET') { send(res, 200, { enabled, user: await currentUser(req) }); return; }
      if (!enabled) { next(); return; }
      if (path === '/api/auth/register' || path === '/api/auth/login') {
        if (req.method !== 'POST') throw new AuthFailure(405, 'METHOD_NOT_ALLOWED', '请使用 POST 提交。');
        const input = await readBody(req);
        const { username, password } = credentials(input);
        throttle(req, username);
        active++;
        try {
          await database!.ready();
          if (path.endsWith('/register')) {
            const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : username;
            if (!displayName || displayName.length > 80) throw new AuthFailure(400, 'INVALID_DISPLAY_NAME', '昵称需为 1–80 个字符。');
            const hash = await hashPassword(password);
            const user: AuthUser = { id: randomUUID(), username, displayName, role: 'user' };
            const token = await database!.transaction(async connection => {
              // Never accept a role from the registration request.
              await connection.execute('INSERT INTO users (id,username,display_name,password_hash,role) VALUES (?,?,?,?,?)', [user.id,username,displayName,hash,'user']);
              await ensurePersonalWorkspace(connection, user.id);
              return createSession(connection, user.id);
            });
            setCookie(req, res, token); send(res, 201, { user }); return;
          }
          const [rows] = await database!.pool.execute<RowDataPacket[]>('SELECT id,username,display_name,password_hash,role FROM users WHERE username = ?', [username]);
          const valid = await verifyPassword(password, rows[0]?.password_hash || DUMMY_HASH);
          if (!rows[0] || !valid) throw new AuthFailure(401, 'INVALID_CREDENTIALS', '账号或密码错误。');
          const user = publicUser(rows[0]);
          const token = await database!.transaction(async connection => {
            await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [user.id]);
            return createSession(connection, user.id);
          });
          setCookie(req, res, token); send(res, 200, { user }); return;
        } finally { active--; }
      }
      if (path === '/api/auth/logout') {
        if (req.method !== 'POST') throw new AuthFailure(405, 'METHOD_NOT_ALLOWED', '请使用 POST 退出。');
        await readBody(req);
        const token = cookieToken(req);
        if (token) { await database!.ready(); await database!.pool.execute('DELETE FROM user_sessions WHERE token_hash = ?', [tokenHash(token)]); }
        setCookie(req, res, '', true); send(res, 200, { success: true }); return;
      }
      if (path.startsWith('/api/auth/')) throw new AuthFailure(404, 'NOT_FOUND', '账号接口不存在。');
      const user = await currentUser(req);
      if (!user) throw new AuthFailure(401, 'AUTH_REQUIRED', '请先登录；登录已过期时请先备份未保存内容，再刷新登录。');
      setRequestContext(req, { userId: user.id });
      if (path === '/api/workspaces' || path.startsWith('/api/workspaces/')) {
        await handleWorkspaces(req, res, database!, user.id, readBody); return;
      }
      if (path !== '/api/storage/config') {
        const workspaceId = req.headers['x-workspace-id'];
        if (typeof workspaceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId)) throw new AuthFailure(400, 'WORKSPACE_REQUIRED', '请先选择你的工作空间。');
        const [rows] = await database!.pool.execute<RowDataPacket[]>('SELECT id FROM workspaces WHERE id = ? AND owner_user_id = ?', [workspaceId,user.id]);
        if (!rows.length) throw new AuthFailure(404, 'WORKSPACE_NOT_FOUND', '工作空间不存在或无权访问。');
        setRequestContext(req, { userId: user.id, workspaceId });
      }
      next();
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof AuthFailure || error instanceof WorkspaceFailure) send(res, error.status, { error: { code: error.code, message: error.message } });
      else if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') send(res, 409, { error: { code: 'USERNAME_EXISTS', message: '这个账号已经注册，请换一个账号或直接登录。' } });
      else send(res, 503, { error: { code: 'AUTH_UNAVAILABLE', message: '账号服务暂时不可用，请稍后重试。' } });
    }
  };
  return { middleware, database, close: () => database?.close() ?? Promise.resolve() };
}
