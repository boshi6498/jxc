import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function start(directory) {
  const port = await availablePort();
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), APP_SECRET: '', APP_PASSWORD: '', SUPER_ADMIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (data) => { output += data; });
  server.stderr.on('data', (data) => { output += data; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return server;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  await once(server, 'exit');
  throw new Error(`Server did not start: ${output}`);
}

test('未配置 APP_SECRET 时生成并复用持久化密钥', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jxc-secret-'));
  let server;
  try {
    server = await start(directory);
    const first = await readFile(path.join(directory, '.app-secret'), 'utf8');
    assert.ok(first.trim().length >= 32);
    server.kill();
    await once(server, 'exit');
    server = await start(directory);
    assert.equal(await readFile(path.join(directory, '.app-secret'), 'utf8'), first);
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  }
});
