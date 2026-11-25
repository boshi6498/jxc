import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

test('账号管理、一次性恢复码及会话失效', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jxc-accounts-test-'));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const env = { ...process.env, DATA_DIR: directory, PORT: String(port), APP_SECRET: 'test-secret-that-is-at-least-32-characters', APP_PASSWORD: '', SUPER_ADMIN: '' };
  const base = `http://127.0.0.1:${port}`;
  let server;
  let output = '';
  async function start() {
    server = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (data) => { output += data; });
    server.stderr.on('data', (data) => { output += data; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Server did not start: ${output}`);
  }
  async function stop() {
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
  function client() {
    let cookie = '';
    return async (url, method = 'GET', body, expected = 200) => {
      const response = await fetch(`${base}${url}`, {
        method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const result = response.status === 204 ? null : await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    };
  }
  try {
    env.SUPER_ADMIN = 'whh';
    await start();
    await client()('/api/register', 'POST', { username: 'whh', password: 'Admin123' }, 409);
    await stop();
    env.SUPER_ADMIN = '';
    await start();
    const admin = client();
    const member = client();
    const adminRegistration = await admin('/api/register', 'POST', { username: 'whh', password: 'Admin123' }, 201);
    assert.match(adminRegistration.recoveryCode, /^[a-f0-9]{48}$/);
    const registration = await member('/api/register', 'POST', { username: 'member', password: 'Member123' }, 201);
    assert.match(registration.recoveryCode, /^[a-f0-9]{48}$/);
    await stop();
    env.SUPER_ADMIN = 'whh';
    await start();
    assert.equal((await admin('/api/auth')).isSuperAdmin, true);
    await member('/api/admin/users', 'GET', undefined, 403);
    const users = await admin('/api/admin/users');
    assert.equal(users.total, 2);
    assert.equal(users.enabled, 2);
    const memberId = users.users.find((user) => user.username === 'member').id;
    const adminId = users.users.find((user) => user.username === 'whh').id;
    assert.equal(users.users.find((user) => user.id === adminId).isSuperAdmin, true);
    await admin(`/api/admin/users/${adminId}/enabled`, 'PUT', { enabled: false }, 409);

    const anonymous = client();
    await anonymous('/api/recover-password', 'POST', { username: 'member', recoveryCode: 'wrong', password: 'Changed123' }, 401);
    const recovered = await anonymous('/api/recover-password', 'POST', { username: 'member', recoveryCode: registration.recoveryCode, password: 'Changed123' });
    assert.notEqual(recovered.recoveryCode, registration.recoveryCode);
    await member('/api/init', 'GET', undefined, 401);
    await anonymous('/api/recover-password', 'POST', { username: 'member', recoveryCode: registration.recoveryCode, password: 'Changed456' }, 401);
    await member('/api/login', 'POST', { username: 'member', password: 'Changed123' });
    await member('/api/account/recovery-code', 'POST', { password: 'wrong' }, 401);
    const replacement = await member('/api/account/recovery-code', 'POST', { password: 'Changed123' });
    await anonymous('/api/recover-password', 'POST', { username: 'member', recoveryCode: recovered.recoveryCode, password: 'Changed456' }, 401);
    assert.notEqual(replacement.recoveryCode, recovered.recoveryCode);

    await admin(`/api/admin/users/${memberId}/enabled`, 'PUT', { enabled: false });
    await member('/api/init', 'GET', undefined, 401);
    await anonymous('/api/login', 'POST', { username: 'member', password: 'Changed123' }, 401);
    await anonymous('/api/recover-password', 'POST', { username: 'member', recoveryCode: replacement.recoveryCode, password: 'Changed456' }, 401);
    assert.equal((await admin('/api/admin/users')).enabled, 1);
    await admin(`/api/admin/users/${memberId}/enabled`, 'PUT', { enabled: true });
    const reset = await admin(`/api/admin/users/${memberId}/reset-password`, 'POST');
    const login = await member('/api/login', 'POST', { username: 'member', password: reset.temporaryPassword });
    assert.equal(login.mustChangePassword, true);
    await member('/api/init', 'GET', undefined, 403);
    const changed = await member('/api/account/change-password', 'POST', { currentPassword: reset.temporaryPassword, password: 'Newpass123' });
    assert.match(changed.recoveryCode, /^[a-f0-9]{48}$/);
    await member('/api/init');
    await anonymous('/api/recover-password', 'POST', { username: 'member', recoveryCode: replacement.recoveryCode, password: 'Changed456' }, 401);

    const cli = spawnSync(process.execPath, ['server.js', '--reset-super-admin'], { env, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const temporaryPassword = cli.stdout.match(/A1[a-f0-9]{24}/)?.[0];
    assert.ok(temporaryPassword);
    await admin('/api/admin/users', 'GET', undefined, 401);
    assert.equal((await admin('/api/login', 'POST', { username: 'whh', password: temporaryPassword })).mustChangePassword, true);
    await admin('/api/account/change-password', 'POST', { currentPassword: temporaryPassword, password: 'Admin456' });
    assert.equal((await admin('/api/admin/users')).total, 2);

    for (let i = 0; i < 10; i += 1) await anonymous('/api/recover-password', 'POST', { username: 'missing', recoveryCode: 'wrong', password: 'Changed456' }, 401);
    await anonymous('/api/recover-password', 'POST', { username: 'missing', recoveryCode: 'wrong', password: 'Changed456' }, 429);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
