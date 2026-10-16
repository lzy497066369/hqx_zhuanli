import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createAuthMiddleware } from '../server/auth.ts';
import { createAiMiddleware, readAiConfig } from '../server/drawingAi.ts';
import { readStorageConfig } from '../server/mysql/database.ts';

test('MySQL 鉴权：50 位用户同时提交全部获准，第 51/52 人排队后依次递补', { timeout: 30000 }, async () => {
  const config = { ...readStorageConfig(process.env), workspace: `queue-test-${randomUUID()}` };
  const auth = createAuthMiddleware(config, { AUTH_REQUIRED: 'true' });
  // This test exercises real HTTP, sessions and MySQL without calling any model.
  const ai = createAiMiddleware(readAiConfig({}));
  const server = createServer((req, res) => void auth.middleware(req, res, () => void ai(req, res, () => { res.writeHead(404); res.end(); })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = process.env.GENERATION_QUEUE_TEST_URL || `http://127.0.0.1:${server.address().port}`;
  const users = [];
  const readers = [];
  const request = (user, path, token, streaming = false) => fetch(base + path, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', Cookie: user.cookie, 'X-Workspace-Id': user.workspace,
      ...(token ? { 'X-Generation-Token': token } : {}),
      ...(streaming ? { Accept: 'application/x-ndjson' } : {}),
    }, body: '{}', signal: AbortSignal.timeout(20000),
  });
  const readResult = async reader => {
    let output = '';
    while (true) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
    const result = output.trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'result');
    assert.equal(typeof result?.data.token, 'string');
    return result.data.token;
  };
  try {
    await auth.database.ready();
    for (let index = 0; index < 52; index++) {
      const id = randomUUID(), workspace = `queue-user-${id}`, session = randomBytes(32).toString('hex');
      await auth.database.pool.execute('INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)',
        [id, `queue_${id.replaceAll('-', '').slice(0, 24)}`, '并发测试临时账号', 'test-only-no-password']);
      users.push({ id, workspace, cookie: `zhichuang_session=${session}` });
      await auth.database.pool.execute('INSERT INTO workspaces (id, owner_user_id, name) VALUES (?, ?, ?)', [workspace, id, '并发测试临时空间']);
      await auth.database.pool.execute('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))',
        [createHash('sha256').update(session).digest('hex'), id]);
    }
    const responses = await Promise.all(users.slice(0, 50).map(async user => {
      const response = await request(user, '/api/generation/begin');
      user.token = (await response.json()).token;
      return response;
    }));
    const statuses = responses.map(response => response.status);
    assert.deepEqual(statuses, Array(50).fill(200), '50 个同时到达的已登录请求必须全部取得生成名额');
    const tokens = users.slice(0, 50).map(user => user.token);
    assert.equal(new Set(tokens).size, 50);
    for (let index = 50; index < 52; index++) {
      const response = await request(users[index], '/api/generation/begin', undefined, true);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      readers.push(reader);
      const progress = new TextDecoder().decode((await reader.read()).value);
      assert.ok(progress.includes(`当前排队第 ${index - 49} 位`));
      assert.ok(progress.includes('最多同时生成 50 份专利'));
      assert.ok(!progress.includes('"type":"result"'));
    }
    assert.equal((await request(users[0], '/api/generation/end', tokens[0])).status, 200);
    const firstToken = await readResult(readers[0]);
    users[50].token = firstToken;
    const progress = new TextDecoder().decode((await readers[1].read()).value);
    assert.ok(progress.includes('当前排队第 1 位'));
    assert.ok(!progress.includes('"type":"result"'));
    assert.equal((await request(users[50], '/api/generation/end', firstToken)).status, 200);
    const secondToken = await readResult(readers[1]);
    users[51].token = secondToken;
    assert.equal((await request(users[51], '/api/generation/end', secondToken)).status, 200);
    const ended = await Promise.all(tokens.slice(1).map((token, index) => request(users[index + 1], '/api/generation/end', token)));
    assert.ok(ended.every(response => response.status === 200));
  } finally {
    await Promise.allSettled(readers.map(reader => reader.cancel()));
    await Promise.allSettled(users.filter(user => user.token).map(user => request(user, '/api/generation/end', user.token)));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const user of users) await auth.database.pool.execute('DELETE FROM users WHERE id = ?', [user.id]);
    await auth.database.pool.execute('DELETE FROM workspaces WHERE id = ?', [config.workspace]);
    await auth.close();
  }
});
