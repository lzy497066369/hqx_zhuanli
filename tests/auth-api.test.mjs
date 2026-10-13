import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createAuthMiddleware } from '../server/auth.ts';
import { readStorageConfig } from '../server/mysql/database.ts';

test('MySQL auth: ordinary role, hashed passwords, sessions, protected APIs and logout', async () => {
  const config = { ...readStorageConfig(process.env), workspace: `auth-test-${randomUUID()}` };
  let auth = createAuthMiddleware(config, { AUTH_REQUIRED: 'true' }); let current = auth;
  const server = createServer((req, res) => { void current.middleware(req, res, () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ protected: true })); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const username = `test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, password = 'Test-Password-890!';
  const request = async (path, method = 'GET', data, cookie, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, cookie: response.headers.get('set-cookie'), data: await response.json() };
  };
  try {
    for (const path of ['/api/storage/projects', '/api/storage/materials', '/api/product/review', '/api/utility/naming-options']) assert.equal((await request(path)).status, 401);
    assert.deepEqual((await request('/api/auth/me')).data, { enabled: true, user: null });
    assert.equal((await request('/api/auth/register', 'POST', { username, password: 'short' })).status, 400);
    assert.equal((await request('/api/auth/register', 'POST', { username, password }, undefined, { Origin: 'https://attacker.test' })).status, 403);
    const registered = await request('/api/auth/register', 'POST', { username: username.toUpperCase(), password, displayName: '测试用户', role: 'admin' });
    assert.equal(registered.status, 201); assert.equal(registered.data.user.role, 'user'); assert.equal(registered.data.user.username, username);
    assert.ok(!JSON.stringify(registered.data).includes(password)); assert.match(registered.cookie, /HttpOnly/); assert.match(registered.cookie, /SameSite=Lax/);
    const cookie = registered.cookie.split(';')[0];
    const spaces = await request('/api/workspaces', 'GET', undefined, cookie);
    assert.equal(spaces.status, 200);
    const scope = { 'X-Workspace-Id': spaces.data.workspaces[0].id };
    const [rows] = await auth.database.pool.execute('SELECT password_hash,role FROM users WHERE username = ?', [username]);
    assert.equal(rows[0].role, 'user'); assert.match(rows[0].password_hash, /^scrypt:/); assert.ok(!rows[0].password_hash.includes(password));
    const [sessions] = await auth.database.pool.execute('SELECT token_hash FROM user_sessions WHERE user_id = ?', [registered.data.user.id]);
    assert.equal(sessions[0].token_hash, createHash('sha256').update(cookie.split('=')[1]).digest('hex'));
    assert.equal((await request('/api/storage/projects', 'GET', undefined, cookie, scope)).status, 200);
    assert.equal((await request('/api/auth/me', 'GET', undefined, cookie)).data.user.id, registered.data.user.id);
    assert.equal((await request('/api/auth/register', 'POST', { username, password })).status, 409);
    const bad = await request('/api/auth/login', 'POST', { username, password: 'incorrect-password' }); assert.equal(bad.status, 401); assert.equal(bad.cookie, null);
    const login = await request('/api/auth/login', 'POST', { username, password }); assert.equal(login.status, 200); assert.equal(login.data.user.role, 'user');
    const secondCookie = login.cookie.split(';')[0];
    await auth.close(); auth = createAuthMiddleware(config, { AUTH_REQUIRED: 'true' }); current = auth;
    assert.equal((await request('/api/auth/me', 'GET', undefined, secondCookie)).data.user.username, username);
    assert.equal((await request('/api/auth/logout', 'POST', {}, secondCookie, { Origin: 'https://attacker.test' })).status, 403);
    const logout = await request('/api/auth/logout', 'POST', {}, secondCookie); assert.equal(logout.status, 200); assert.match(logout.cookie, /Max-Age=0/);
    assert.equal((await request('/api/storage/projects', 'GET', undefined, secondCookie)).status, 401);
    await auth.database.pool.execute('UPDATE user_sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE user_id = ?', [registered.data.user.id]);
    assert.equal((await request('/api/storage/projects', 'GET', undefined, cookie)).status, 401);
    assert.equal((await request('/api/storage/projects', 'GET', undefined, 'zhichuang_session=' + '0'.repeat(64))).status, 401);
    for (let i = 0; i < 15; i++) await request('/api/auth/login', 'POST', { username: 'missing_test_user', password });
    assert.equal((await request('/api/auth/login', 'POST', { username: 'missing_test_user', password })).status, 429);
  } finally {
    await auth.database.ready(); await auth.database.pool.execute('DELETE FROM users WHERE username = ?', [username]);
    await auth.database.pool.execute('DELETE FROM workspaces WHERE id = ?', [config.workspace]);
    await auth.close(); await new Promise(resolve => server.close(resolve));
  }
});
