import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { entityColumns, entityExportValues, parseEntityCsv } from '../src/entity-csv.js';

test('CSV 支持引号、逗号、换行并拒绝错误表头和格式', () => {
  const headers = entityColumns.customers.map(([, label]) => label).join(',');
  const rows = parseEntityCsv(`\ufeff${headers}\r\n"客户,一","张""三",0123,,"地址\n第二行","备注"\r\n`, 'customers');
  assert.deepEqual(rows[0], { name: '客户,一', contact: '张"三', phone: '0123', email: '', address: '地址\n第二行', note: '备注' });
  assert.throws(() => parseEntityCsv('名称\n客户', 'customers'), /表头/);
  assert.throws(() => parseEntityCsv(`${headers}\n"未闭合`, 'customers'), /引号/);
  assert.throws(() => parseEntityCsv(`${headers}\n客户,联系人`, 'customers'), /列数/);
});

test('资料导入回滚及分类重命名保留关联', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jxc-import-test-'));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), APP_SECRET: 'test-secret-that-is-at-least-32-characters', APP_PASSWORD: '' },
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
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const result = await response.json();
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
    assert.ok(ready, output);
    await request('/api/register', 'POST', { username: 'testuser', password: 'Test1234' }, 201);
    const contact = { name: '测试', contact: '张三', phone: '0123', email: '', address: '地址', note: '' };
    for (const entity of ['suppliers', 'customers']) {
      assert.equal((await request(`/api/${entity}/import`, 'POST', { rows: [contact] }, 201)).imported, 1);
      const error = await request(`/api/${entity}/import`, 'POST', { rows: [contact, { ...contact, name: '' }] }, 400);
      assert.match(error.error, /第 2 条/);
    }
    const product = { sku: 'SKU-1', name: '商品', specification: '规格', unit: '托', category: '新分类', cost: '1.25', price: '2', stock: '5', threshold: '3', stock_alert_enabled: '关闭', note: '备注' };
    await request('/api/products/import', 'POST', { rows: [product] }, 201);
    const failure = await request('/api/products/import', 'POST', { rows: [{ ...product, sku: 'SKU-2', category: '回滚分类', unit: '回滚单位' }, product] }, 400);
    assert.match(failure.error, /第 2 条.*商品编码已存在/);
    await request('/api/products/import', 'POST', { rows: [{ ...product, sku: 'SKU-3', stock: '1.5' }] }, 400);
    const init = await request('/api/init');
    assert.equal(init.suppliers.length, 1);
    assert.equal(init.customers.length, 1);
    assert.equal(init.products.length, 1);
    assert.equal(init.products[0].stock, 5);
    assert.equal(init.products[0].cost, 1.25);
    assert.equal(init.products[0].stock_alert_enabled, false);
    assert.ok(init.categories.some((item) => item.name === '新分类'));
    assert.ok(init.units.some((item) => item.name === '托'));
    assert.ok(!init.categories.some((item) => item.name === '回滚分类'));
    assert.ok(!init.units.some((item) => item.name === '回滚单位'));
    for (const entity of ['products', 'suppliers', 'customers']) {
      const csv = [entityColumns[entity].map(([, label]) => label), entityExportValues(entity, init[entity][0], init.categories)]
        .map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const imported = parseEntityCsv(csv, entity)[0];
      assert.equal(imported.name, init[entity][0].name);
      if (entity === 'products') {
        assert.equal(imported.category, '新分类');
        assert.equal(imported.stock_alert_enabled, '关闭');
        assert.equal(imported.stock, '5');
      } else assert.equal(imported.phone, '0123');
    }
    const category = init.categories.find((item) => item.name === '新分类');
    const defaultCategory = init.categories.find((item) => item.name === '未分类');
    const stocktake = await request('/api/stocktakes', 'POST', { date: '2026-01-02', categoryId: category.id, items: [{ productId: init.products[0].id, counted: 5 }] }, 201);
    await request('/api/categories', 'POST', { name: 'Other' }, 201);
    await request(`/api/categories/${category.id}`, 'PUT', { name: 'other' }, 409);
    await request(`/api/categories/${category.id}`, 'PUT', { name: '  ' }, 400);
    await request(`/api/categories/${defaultCategory.id}`, 'PUT', { name: '默认' }, 400);
    await request('/api/categories/999999', 'PUT', { name: '不存在' }, 404);
    const renamed = await request(`/api/categories/${category.id}`, 'PUT', { name: '已更名' });
    assert.equal(renamed.id, category.id);
    assert.equal(renamed.name, '已更名');
    const afterRename = await request('/api/init');
    assert.equal(afterRename.products[0].category_id, category.id);
    assert.equal((await request(`/api/stocktakes/${stocktake.id}`)).category_name, '已更名');
    await request(`/api/categories/${category.id}`, 'DELETE', undefined, 409);
  } finally {
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
