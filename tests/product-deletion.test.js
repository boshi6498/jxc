import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import Database from 'better-sqlite3';

test('删除订单后可删除商品并保留库存流水和备份', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jxc-product-delete-'));
  const legacy = new Database(path.join(directory, 'jxc.sqlite'));
  legacy.pragma('foreign_keys = OFF');
  legacy.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, specification TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL, category_id INTEGER, cost_cents INTEGER NOT NULL, price_cents INTEGER NOT NULL, stock REAL NOT NULL, threshold REAL NOT NULL, stock_alert_enabled INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id), order_id INTEGER REFERENCES orders(id), kind TEXT NOT NULL, quantity_delta REAL NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO products (sku, name, unit, cost_cents, price_cents, stock, threshold) VALUES ('OLD', '旧商品', '件', 100, 200, 10, 0);
    INSERT INTO stock_movements (product_id, kind, quantity_delta, note) VALUES (1, 'purchase', 3, '历史流水');
  `);
  legacy.close();
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), APP_SECRET: 'test-secret-that-is-at-least-32-characters', APP_PASSWORD: '', SUPER_ADMIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (data) => { output += data; });
  server.stderr.on('data', (data) => { output += data; });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function request(url, method = 'GET', body, expected = 200) {
    const response = await fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = response.status === 204 ? null : await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `Server did not start: ${output}`);
    await request('/api/register', 'POST', { username: 'testuser', password: 'Test1234' }, 201);
    assert.equal((await request('/api/stock/movements'))[0].product_name, '旧商品');
    const legacyBackup = await request('/api/backup');
    for (const movement of legacyBackup.data.stock_movements) {
      delete movement.product_name;
      delete movement.product_unit;
    }
    await request('/api/restore', 'POST', legacyBackup);
    assert.equal((await request('/api/stock/movements'))[0].unit, '件');
    const init = await request('/api/init');
    const supplier = await request('/api/suppliers', 'POST', { name: '供应商' }, 201);
    const body = { type: 'purchase', date: '2026-01-02', partyId: supplier.id, items: [{ productId: 1, quantity: 2, unitPrice: 1 }] };
    const order = await request('/api/orders', 'POST', body, 201);
    assert.match((await request('/api/products/1', 'DELETE', undefined, 409)).error, /业务记录/);
    await request(`/api/orders/${order.id}/audit`, 'POST');
    await request(`/api/orders/${order.id}/reverse`, 'POST');
    await request(`/api/orders/${order.id}`, 'DELETE');
    await request('/api/products/1', 'DELETE', undefined, 204);
    await request('/api/products/1', 'DELETE', undefined, 404);
    const movements = await request('/api/stock/movements');
    assert.equal(movements.length, 3);
    for (const movement of movements) {
      assert.equal(movement.product_id, null);
      assert.equal(movement.product_name, '旧商品');
      assert.equal(movement.unit, '件');
    }
    const backup = await request('/api/backup');
    await request('/api/restore', 'POST', backup);
    assert.deepEqual(await request('/api/stock/movements'), movements);
    const replacement = await request('/api/products', 'POST', { sku: 'OLD', name: '新商品', unit: '件', category_id: init.categories[0].id, stock: 10, cost: 1, price: 2 }, 201);
    const nextOrder = await request('/api/orders', 'POST', { ...body, items: [{ productId: replacement.id, quantity: 2, unitPrice: 1 }] }, 201);
    assert.notEqual(nextOrder.number, order.number);
    await request(`/api/orders/${nextOrder.id}`, 'DELETE');
    await request('/api/stocktakes', 'POST', { date: '2026-01-02', categoryId: init.categories[0].id, items: [{ productId: replacement.id, counted: 10 }] }, 201);
    assert.match((await request(`/api/products/${replacement.id}`, 'DELETE', undefined, 409)).error, /业务记录/);
  } finally {
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
