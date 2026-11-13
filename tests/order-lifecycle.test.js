import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

test('反审核订单的删除与编辑重新生效', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jxc-orders-test-'));
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
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const result = response.status === 204 ? null : await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `Server did not start: ${output}`);
    await request('/api/register', 'POST', { username: 'testuser', password: 'Test1234' }, 201);
    const init = await request('/api/init');
    const product = await request('/api/products', 'POST', { name: '测试商品', sku: 'TEST', unit: '个', category_id: init.categories[0].id, stock: 10, cost: 2, price: 5 }, 201);
    const supplier = await request('/api/suppliers', 'POST', { name: '测试供应商' }, 201);
    const customer = await request('/api/customers', 'POST', { name: '测试客户' }, 201);
    const body = (type, quantity, paidAmount = 0) => ({
      type, date: '2026-01-02', partyId: type === 'purchase' ? supplier.id : customer.id,
      note: '', items: [{ productId: product.id, quantity, unitPrice: 5 }],
      paidAmount, paymentMethod: paidAmount ? '现金' : '',
    });
    const stock = async () => (await request('/api/init')).products.find((item) => item.id === product.id).stock;
    const order = async (id) => (await request('/api/orders')).find((item) => item.id === id);

    const saleDraft = await request('/api/orders', 'POST', body('sale', 2, 5), 201);
    assert.equal(saleDraft.audited, false);
    assert.equal(saleDraft.reversed, false);
    assert.equal(await stock(), 10);
    await request(`/api/orders/${saleDraft.id}`, 'DELETE');
    assert.equal(await order(saleDraft.id), undefined);
    assert.equal(await stock(), 10);
    assert.equal((await request('/api/init')).customers[0].outstanding, 0);
    await request(`/api/orders/${saleDraft.id}`, 'DELETE', undefined, 404);

    const purchaseDraft = await request('/api/orders', 'POST', body('purchase', 2, 5), 201);
    await request(`/api/orders/${purchaseDraft.id}`, 'DELETE');
    assert.equal(await order(purchaseDraft.id), undefined);
    assert.equal(await stock(), 10);
    assert.equal((await request('/api/init')).suppliers[0].outstanding, 0);
    await request(`/api/orders/${purchaseDraft.id}`, 'DELETE', undefined, 404);

    const draft = await request('/api/orders', 'POST', body('purchase', 2), 201);
    await request(`/api/orders/${draft.id}`, 'PUT', body('purchase', 3));
    assert.equal((await order(draft.id)).audited, false);
    assert.equal(await stock(), 10);
    await request(`/api/orders/${draft.id}/audit`, 'POST');
    assert.equal(await stock(), 13);
    await request(`/api/orders/${draft.id}`, 'DELETE', undefined, 409);
    await request(`/api/orders/${draft.id}/reverse`, 'POST');
    assert.equal(await stock(), 10);
    assert.equal((await order(draft.id)).reversed, true);
    await request(`/api/orders/${draft.id}`, 'DELETE');
    assert.equal(await order(draft.id), undefined);
    assert.equal(await stock(), 10);

    const purchase = await request('/api/orders', 'POST', body('purchase', 2, 5), 201);
    await request(`/api/orders/${purchase.id}/audit`, 'POST');
    await request(`/api/orders/${purchase.id}/reverse`, 'POST');
    assert.equal((await order(purchase.id)).payment_method, '现金');
    const updatedPurchase = await request(`/api/orders/${purchase.id}`, 'PUT', body('purchase', 4, 5));
    assert.equal(updatedPurchase.audited, true);
    assert.equal(updatedPurchase.reversed, false);
    assert.equal(updatedPurchase.paid, 5);
    assert.equal(await stock(), 14);
    await request(`/api/orders/${purchase.id}`, 'DELETE', undefined, 409);

    const sale = await request('/api/orders', 'POST', body('sale', 3, 5), 201);
    await request(`/api/orders/${sale.id}/audit`, 'POST');
    assert.equal(await stock(), 11);
    await request(`/api/orders/${sale.id}`, 'DELETE', undefined, 409);
    assert.equal(await stock(), 11);
    assert.equal((await order(sale.id)).audited, true);
    await request(`/api/orders/${sale.id}/reverse`, 'POST');
    assert.equal(await stock(), 14);
    await request(`/api/orders/${sale.id}`, 'PUT', body('sale', 15, 5), 409);
    assert.equal(await stock(), 14);
    assert.equal((await order(sale.id)).items[0].quantity, 3);
    assert.equal((await order(sale.id)).reversed, true);
    const updatedSale = await request(`/api/orders/${sale.id}`, 'PUT', body('sale', 4, 5));
    assert.equal(updatedSale.audited, true);
    assert.equal(updatedSale.paid, 5);
    assert.equal(await stock(), 10);
    await request(`/api/orders/${sale.id}/reverse`, 'POST');
    await request(`/api/orders/${sale.id}`, 'DELETE');
    assert.equal(await stock(), 14);

    const first = await request('/api/orders', 'POST', body('purchase', 1), 201);
    await request(`/api/orders/${first.id}/audit`, 'POST');
    const second = await request('/api/orders', 'POST', body('purchase', 1), 201);
    await request(`/api/orders/${first.id}/reverse`, 'POST');
    await request(`/api/orders/${first.id}`, 'DELETE');
    const third = await request('/api/orders', 'POST', body('purchase', 1), 201);
    assert.notEqual(third.number, second.number);

    const emptyProduct = await request('/api/products', 'POST', { name: '缺货商品', sku: 'EMPTY', unit: '个', category_id: init.categories[0].id, stock: 0, cost: 2, price: 5 }, 201);
    const suspended = {
      kind: 'order', type: 'sale', partyId: String(customer.id), orderDate: '2026-01-02',
      paidAmount: '0', paymentMethod: '', paymentVoucher: '', voucherName: '', removeVoucher: false,
      note: '待补货', lines: [{ productId: emptyProduct.id, quantity: 2, unitPrice: 5 }],
    };
    const savedDraft = await request('/api/suspended-orders', 'POST', suspended, 201);
    assert.equal((await request('/api/suspended-orders'))[0].note, '待补货');
    const backup = await request('/api/backup');
    assert.equal(backup.data.suspended_orders.length, 1);
    await request('/api/logout', 'POST', undefined, 204);
    await request('/api/register', 'POST', { username: 'otheruser', password: 'Test1234' }, 201);
    assert.deepEqual(await request('/api/suspended-orders'), []);
    await request('/api/login', 'POST', { username: 'testuser', password: 'Test1234' });
    assert.equal((await request('/api/suspended-orders'))[0].suspendedId, savedDraft.suspendedId);

    const replenishment = { ...body('purchase', 3), items: [{ productId: emptyProduct.id, quantity: 3, unitPrice: 2 }] };
    const purchaseForDraft = await request('/api/orders', 'POST', replenishment, 201);
    assert.equal((await request('/api/init')).products.find((item) => item.id === emptyProduct.id).stock, 0);
    await request(`/api/orders/${purchaseForDraft.id}/audit`, 'POST');
    assert.equal((await request('/api/init')).products.find((item) => item.id === emptyProduct.id).stock, 3);

    const updatedDraft = await request('/api/suspended-orders', 'POST', { ...savedDraft, note: '已补货' });
    await request('/api/suspended-orders', 'POST', { ...savedDraft, note: '过期修改' }, 409);
    await request(`/api/suspended-orders/${savedDraft.suspendedId}`, 'DELETE', { version: savedDraft.suspendedVersion }, 409);
    const saleForDraft = { ...body('sale', 2), items: [{ productId: emptyProduct.id, quantity: 2, unitPrice: 5 }], suspendedId: updatedDraft.suspendedId, suspendedVersion: updatedDraft.suspendedVersion };
    await request('/api/orders', 'POST', { ...saleForDraft, partyId: 0 }, 400);
    assert.equal((await request('/api/suspended-orders')).length, 1);
    const resumedSale = await request('/api/orders', 'POST', saleForDraft, 201);
    await request('/api/orders', 'POST', saleForDraft, 409);
    assert.deepEqual(await request('/api/suspended-orders'), []);
    await request(`/api/orders/${resumedSale.id}/audit`, 'POST');
    assert.equal((await request('/api/init')).products.find((item) => item.id === emptyProduct.id).stock, 1);

    await request('/api/restore', 'POST', backup);
    assert.equal((await request('/api/suspended-orders'))[0].note, '待补货');
    delete backup.data.suspended_orders;
    await request('/api/restore', 'POST', backup);
    assert.deepEqual(await request('/api/suspended-orders'), []);
  } finally {
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
