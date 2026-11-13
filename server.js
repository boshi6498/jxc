import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const databasePath = path.join(dataDirectory, 'jxc.sqlite');
const port = Number(process.env.PORT || 3001);
const appPassword = process.env.APP_PASSWORD;
const appSecret = process.env.APP_SECRET;
const cookieName = 'jxc_session';
const sessionDuration = 12 * 60 * 60 * 1000;
if (!appSecret || appSecret.length < 32) throw new Error('APP_SECRET must contain at least 32 characters.');
fs.mkdirSync(dataDirectory, { recursive: true });

const schema = `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, specification TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL, category_id INTEGER REFERENCES categories(id), cost_cents INTEGER NOT NULL DEFAULT 0, price_cents INTEGER NOT NULL DEFAULT 0, stock REAL NOT NULL DEFAULT 0, threshold REAL NOT NULL DEFAULT 0, stock_alert_enabled INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, type TEXT NOT NULL CHECK(type IN ('purchase','sale')), date TEXT NOT NULL, party_id INTEGER, party_name TEXT NOT NULL, total_cents INTEGER NOT NULL, paid_cents INTEGER NOT NULL DEFAULT 0, planned_paid_cents INTEGER NOT NULL DEFAULT 0, payment_method TEXT NOT NULL DEFAULT '', audited INTEGER NOT NULL DEFAULT 0, reversed INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS customer_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, date TEXT NOT NULL, total_cents INTEGER NOT NULL, payment_method TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS customer_receipt_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER NOT NULL REFERENCES customer_receipts(id) ON DELETE CASCADE, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), UNIQUE(receipt_id, order_id));
  CREATE TABLE IF NOT EXISTS customer_receipt_vouchers (receipt_id INTEGER PRIMARY KEY REFERENCES customer_receipts(id) ON DELETE CASCADE, mime_type TEXT NOT NULL, data_base64 TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS supplier_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, date TEXT NOT NULL, total_cents INTEGER NOT NULL, payment_method TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS supplier_payment_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id INTEGER NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), UNIQUE(payment_id, order_id));
  CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id), product_name TEXT NOT NULL, specification TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity > 0), unit_price_cents INTEGER NOT NULL, subtotal_cents INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS order_vouchers (order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE, mime_type TEXT NOT NULL, data_base64 TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS suspended_orders (id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id), order_id INTEGER REFERENCES orders(id), kind TEXT NOT NULL, quantity_delta REAL NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS stocktakes (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, date TEXT NOT NULL, category_id INTEGER REFERENCES categories(id), note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS stocktake_items (id INTEGER PRIMARY KEY AUTOINCREMENT, stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id), product_name TEXT NOT NULL, expected REAL NOT NULL, counted REAL NOT NULL, difference REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS orders_type_date_idx ON orders(type, date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements(product_id, id DESC);
`;
const initialSettings = {
  systemName: '商户进销存',
  purchaseTemplate: '采购入库单',
  salesTemplate: '销售出库单',
};
const defaultUnits= ['个', '件', '箱', '袋', '瓶', '盒', '千克', '克', '升', '米'];
function initializeUserDatabase(connection) {
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.exec(schema);
  const orderColumns = new Set(connection.prepare('PRAGMA table_info(orders)').all().map((column) => column.name));
  if (!orderColumns.has('paid_cents')) {
    connection.exec('ALTER TABLE orders ADD COLUMN paid_cents INTEGER NOT NULL DEFAULT 0');
    connection.exec('UPDATE orders SET paid_cents = total_cents');
  }
  if (!orderColumns.has('payment_method')) {
    connection.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''");
    connection.exec("UPDATE orders SET payment_method = '历史单据（按已结清处理）'");
  }
  if (!orderColumns.has('planned_paid_cents')) connection.exec('ALTER TABLE orders ADD COLUMN planned_paid_cents INTEGER NOT NULL DEFAULT 0');
  if (!orderColumns.has('audited')) {
    connection.exec('ALTER TABLE orders ADD COLUMN audited INTEGER NOT NULL DEFAULT 1');
    connection.exec('UPDATE orders SET planned_paid_cents = paid_cents');
  }
  if (!orderColumns.has('reversed')) {
    connection.exec('ALTER TABLE orders ADD COLUMN reversed INTEGER NOT NULL DEFAULT 0');
    connection.exec(`UPDATE orders SET reversed = 1
      WHERE audited = 0 AND EXISTS (
        SELECT 1 FROM stock_movements
        WHERE stock_movements.note = orders.number || ' 已反审核'
      )`);
  }
  const productColumns = new Set(connection.prepare('PRAGMA table_info(products)').all().map((column) => column.name));
  if (!productColumns.has('stock_alert_enabled')) {
    connection.exec('ALTER TABLE products ADD COLUMN stock_alert_enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!productColumns.has('category_id')) {
    connection.exec('ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories(id)');
  }
  const stocktakeColumns = new Set(connection.prepare('PRAGMA table_info(stocktakes)').all().map((column) => column.name));
  if (!stocktakeColumns.has('category_id')) {
    connection.exec('ALTER TABLE stocktakes ADD COLUMN category_id INTEGER REFERENCES categories(id)');
  }
  const uncategorized = connection.prepare("INSERT OR IGNORE INTO categories (name) VALUES ('未分类')");
  uncategorized.run();
  connection.prepare('UPDATE products SET category_id = ? WHERE category_id IS NULL')
    .run(connection.prepare("SELECT id FROM categories WHERE name = '未分类'").get().id);
  const insertSetting = connection.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(initialSettings)) insertSetting.run(key, value);
  const insertUnit = connection.prepare('INSERT OR IGNORE INTO units (name) VALUES (?)');
  for (const name of defaultUnits) insertUnit.run(name);
}

const accountsDb = new Database(path.join(dataDirectory, 'accounts.sqlite'));
accountsDb.pragma('journal_mode = WAL');
accountsDb.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  database_file TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const databaseContext = new AsyncLocalStorage();
const userDatabases = new Map();
const defaultDatabase = new Database(databasePath);
initializeUserDatabase(defaultDatabase);
const db = new Proxy({}, {
  get(_target, property) {
    const connection = databaseContext.getStore()?.database || defaultDatabase;
    const value = connection[property];
    return typeof value === 'function' ? value.bind(connection) : value;
  },
});
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function setSessionCookie(res, userId) {
  const token = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + sessionDuration })).toString('base64url');
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${cookieName}=${token}.${sessionSignature(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDuration / 1000}${secure}`);
}
if (appPassword && accountsDb.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0) {
  const { salt, hash } = hashPassword(appPassword);
  accountsDb.prepare('INSERT INTO users (username,salt,password_hash,database_file) VALUES (?,?,?,?)')
    .run('admin', salt, hash, path.basename(databasePath));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const integerId = (value) => /^\d+$/.test(String(value)) && Number(value) > 0 ? Number(value) : null;
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function sessionSignature(token) { return crypto.createHmac('sha256', appSecret).update(token).digest('base64url'); }
function sessionUser(req) {
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  if (!cookie) return null;
  const [token, providedSignature] = cookie.slice(cookieName.length + 1).split('.');
  if (!token || !providedSignature) return null;
  const expected = Buffer.from(sessionSignature(token));
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
  try {
    const session = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (!Number.isInteger(session.uid) || session.exp <= Date.now()) return null;
    return accountsDb.prepare('SELECT id, username, database_file FROM users WHERE id = ?').get(session.uid) || null;
  } catch { return null; }
}
function userDatabase(user) {
  if (!userDatabases.has(user.id)) {
    const connection = new Database(path.join(dataDirectory, user.database_file));
    initializeUserDatabase(connection);
    userDatabases.set(user.id, connection);
  }
  return userDatabases.get(user.id);
}
function requireSession(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: '登录已失效，请重新登录' });
  req.user = user;
  return databaseContext.run({ database: userDatabase(user) }, next);
}
const cents = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= 999999999 ? Math.round(amount * 100) : null;
};
const quantity = (value, allowZero = false) => {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount <= 999999999 && (allowZero ? amount >= 0 : amount > 0) ? amount : null;
};
const asMoney = (value) => value / 100;
const serializeProduct = (row) => ({ ...row, stock_alert_enabled: row.stock_alert_enabled !== 0, cost: asMoney(row.cost_cents), price: asMoney(row.price_cents), cost_cents: undefined, price_cents: undefined });
const serializeOrder = (row) => ({ ...row, audited: row.audited !== 0, reversed: row.reversed !== 0, total: asMoney(row.total_cents), paid: asMoney(row.paid_cents), planned_paid: asMoney(row.planned_paid_cents ?? row.paid_cents), outstanding: asMoney(row.total_cents - row.paid_cents), total_cents: undefined, paid_cents: undefined, planned_paid_cents: undefined });
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}
function nextNumber(prefix, date, table) {
  let count = db.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE date = ?').get(date).count + 1;
  const exists = db.prepare('SELECT 1 FROM ' + table + ' WHERE number = ?');
  const movementExists = table === 'orders' ? db.prepare("SELECT 1 FROM stock_movements WHERE note = ? OR note LIKE ? || ' %' LIMIT 1") : null;
  let number = `${prefix}-${date.replaceAll('-', '')}-${String(count).padStart(4, '0')}`;
  while (exists.get(number) || movementExists?.get(number, number)) {
    count += 1;
    number = `${prefix}-${date.replaceAll('-', '')}-${String(count).padStart(4, '0')}`;
  }
  return number;
}
function sendError(res, message, status = 400) { return res.status(status).json({ error: message }); }
function parsePaymentVoucher(value) {
  const match = typeof value === 'string' && /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return { error: '付款凭证只支持 JPG、PNG 或 WebP 图片' };
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 5 * 1024 * 1024) return { error: '付款凭证图片不能超过 5 MB' };
  const validSignature = match[1] === 'image/png'
    ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === 'image/jpeg'
      ? data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9
      : data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  return validSignature ? { mimeType: match[1], dataBase64: match[2] } : { error: '付款凭证图片格式无效' };
}
function saveOrderVoucher(orderId, voucher) {
  if (voucher === null) {
    db.prepare('DELETE FROM order_vouchers WHERE order_id = ?').run(orderId);
  } else if (voucher) {
    db.prepare('INSERT INTO order_vouchers (order_id,mime_type,data_base64) VALUES (?,?,?) ON CONFLICT(order_id) DO UPDATE SET mime_type=excluded.mime_type, data_base64=excluded.data_base64')
      .run(orderId, voucher.mimeType, voucher.dataBase64);
  }
}
function entityRoutes(name, requiredField) {
  const table = name;
  app.get(`/api/${name}`, (_req, res) => res.json(db.prepare(`SELECT * FROM ${table} ORDER BY name COLLATE NOCASE, id`).all()));
  app.post(`/api/${name}/import`, (req, res) => {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > 10000) return sendError(res, '导入资料须包含 1 至 10000 条记录');
    let rowNumber = 0;
    try {
      db.transaction(() => {
        for (const row of rows) {
          rowNumber += 1;
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('资料格式无效');
          const limits = name === 'products'
            ? { sku: 50, name: 120, specification: 120, unit: 30, category: 80, note: 500 }
            : { name: 120, contact: 80, phone: 60, email: 120, address: 300, note: 500 };
          for (const [key, limit] of Object.entries(limits)) {
            if (typeof row[key] !== 'string' || row[key].trim().length > limit) throw new Error(`字段 ${key} 无效或超过 ${limit} 个字符`);
          }
          let values;
          if (name === 'products') {
            const sku = text(row.sku, 50);
            const categoryName = text(row.category, 80);
            const unit = text(row.unit, 30);
            if (!sku || !categoryName || !unit) throw new Error('商品编码、分类和单位不能为空');
            if (!['启用', '关闭'].includes(row.stock_alert_enabled)) throw new Error('库存预警须填写“启用”或“关闭”');
            for (const key of ['cost', 'price', 'stock', 'threshold']) {
              if (typeof row[key] !== 'string' || !row[key].trim() || !/^\d+(?:\.\d+)?$/.test(row[key].trim())) throw new Error('价格和库存须填写有效数字');
            }
            db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(categoryName);
            db.prepare('INSERT OR IGNORE INTO units (name) VALUES (?)').run(unit);
            const category = db.prepare('SELECT id FROM categories WHERE name = ?').get(categoryName);
            values = productValues({ ...row, sku, unit, category_id: category.id, stock_alert_enabled: row.stock_alert_enabled === '启用' });
          } else {
            values = contactValues(row, requiredField);
          }
          if (!values) throw new Error(name === 'products' ? '商品名称、单位、价格或库存无效' : '名称不能为空');
          const columns = Object.keys(values);
          db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values));
        }
      })();
      return res.status(201).json({ imported: rows.length });
    } catch (error) {
      const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? '商品编码已存在' : error.message;
      return sendError(res, `第 ${rowNumber} 条记录导入失败：${message}；本次未导入任何资料`);
    }
  });
  app.post(`/api/${name}`, (req, res) => {
    const body = req.body || {};
    const values = name === 'products' ? productValues(body) : contactValues(body, requiredField);
    if (!values) return sendError(res, name === 'products' ? '请填写商品名称、单位及有效价格' : '请填写必填名称');
    try {
      const columns = Object.keys(values);
      const result = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values));
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(result.lastInsertRowid);
      return res.status(201).json(name === 'products' ? serializeProduct(row) : row);
    } catch (error) { return sendError(res, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? '商品编码已存在' : error.message); }
  });
  app.put(`/api/${name}/:id`, (req, res) => {
    const id = integerId(req.params.id);
    if (!id) return sendError(res, '记录编号无效');
    const body = { ...(req.body || {}) };
    if (name === 'products' && body.stock_alert_enabled === undefined) {
      body.stock_alert_enabled = db.prepare('SELECT stock_alert_enabled FROM products WHERE id = ?').get(id)?.stock_alert_enabled ?? 1;
    }
    const values = name === 'products' ? productValues(body) : contactValues(body, requiredField);
    if (!values) return sendError(res, name === 'products' ? '请填写商品名称、单位及有效价格' : '请填写必填名称');
    try {
      const columns = Object.keys(values);
      const result = db.prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(',')} WHERE id = ?`).run(...Object.values(values), id);
      if (!result.changes) return sendError(res, '记录不存在', 404);
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      return res.json(name === 'products' ? serializeProduct(row) : row);
    } catch (error) { return sendError(res, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? '商品编码已存在' : error.message); }
  });
  app.delete(`/api/${name}/:id`, (req, res) => {
    const id = integerId(req.params.id);
    if (!id) return sendError(res, '记录编号无效');
    if (name === 'products') {
      const referenced = db.prepare('SELECT 1 FROM order_items WHERE product_id = ? UNION SELECT 1 FROM stocktake_items WHERE product_id = ? LIMIT 1').get(id, id);
      if (referenced) return sendError(res, '该商品已有业务记录，不能删除；可将库存调整为 0', 409);
    }
    if (name === 'customers' && db.prepare('SELECT 1 FROM customer_receipts WHERE customer_id = ? LIMIT 1').get(id)) return sendError(res, '该客户已有收款记录，不能删除', 409);
    if (name === 'suppliers' && db.prepare('SELECT 1 FROM supplier_payments WHERE supplier_id = ? LIMIT 1').get(id)) return sendError(res, '该供应商已有付款记录，不能删除', 409);
    const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return result.changes ? res.status(204).end() : sendError(res, '记录不存在', 404);
  });
}
function contactValues(body, requiredField) {
  const name = text(body[requiredField], 120);
  if (!name) return null;
  return { name, contact: text(body.contact, 80), phone: text(body.phone, 60), email: text(body.email, 120), address: text(body.address, 300), note: text(body.note, 500) };
}
function productValues(body) {
  const name = text(body.name, 120);
  const unit = text(body.unit, 30);
  const cost = cents(body.cost ?? 0);
  const price = cents(body.price ?? 0);
  const stock = quantity(body.stock ?? 0, true);
  const threshold = quantity(body.threshold ?? 0, true);
  const categoryId = integerId(body.category_id);
  const category = categoryId && db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  const stockAlertEnabled = body.stock_alert_enabled === undefined || body.stock_alert_enabled === true || body.stock_alert_enabled === 1
    ? 1
    : body.stock_alert_enabled === false || body.stock_alert_enabled === 0 ? 0 : null;
  if (!name || !unit || !category || cost === null || price === null || stock === null || threshold === null || stockAlertEnabled === null) return null;
  return { sku: text(body.sku, 50) || `SP-${Date.now().toString().slice(-8)}`, name, specification: text(body.specification, 120), unit, category_id: category.id, cost_cents: cost, price_cents: price, stock, threshold, stock_alert_enabled: stockAlertEnabled, note: text(body.note, 500) };
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/auth', (req, res) => {
  const user = sessionUser(req);
  return res.json({ authenticated: Boolean(user), username: user?.username || '' });
});
app.post('/api/register', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) return sendError(res, '账号名须为 3-32 位字母、数字、下划线或连字符');
  if (typeof password !== 'string' || password.length < 8 || password.length > 64 || !/[A-Za-z]/.test(password) || !/\d/.test(password) || !/^[A-Za-z\d]+$/.test(password)) {
    return sendError(res, '密码须为 8-64 位，且同时包含字母和数字');
  }
  try {
    const { salt, hash } = hashPassword(password);
    const createUser = accountsDb.transaction(() => {
      const firstAccount = accountsDb.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0;
      const databaseFile = firstAccount ? path.basename(databasePath) : `account-${accountsDb.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM users').get().id}.sqlite`;
      const result = accountsDb.prepare('INSERT INTO users (username,salt,password_hash,database_file) VALUES (?,?,?,?)')
        .run(username, salt, hash, databaseFile);
      return accountsDb.prepare('SELECT id, username, database_file FROM users WHERE id = ?').get(result.lastInsertRowid);
    });
    const user = createUser();
    try { userDatabase(user); }
    catch (error) {
      accountsDb.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      throw error;
    }
    setSessionCookie(res, user.id);
    return res.status(201).json({ authenticated: true, username: user.username });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, '该账号名已被注册', 409);
    console.error(error);
    return sendError(res, '注册失败，请稍后重试', 500);
  }
});
app.post('/api/login', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = req.body?.password;
  const user = accountsDb.prepare('SELECT id, username, salt, password_hash, database_file FROM users WHERE username = ?').get(username);
  if (!user || typeof password !== 'string' || Buffer.byteLength(password) > 1024) return sendError(res, '账号或密码不正确', 401);
  const provided = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const expected = Buffer.from(user.password_hash, 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return sendError(res, '账号或密码不正确', 401);
  setSessionCookie(res, user.id);
  return res.json({ authenticated: true, username: user.username });
});
app.post('/api/logout', (_req, res) => {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  return res.status(204).end();
});
app.use('/api', requireSession);
app.get('/api/init', (_req, res) => {
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value]));
  const products = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all().map(serializeProduct);
  const totals = db.prepare(`SELECT type, COUNT(*) AS count, COALESCE(SUM(total_cents),0) AS total FROM orders WHERE audited = 1 GROUP BY type`).all();
  const orders = db.prepare('SELECT * FROM orders ORDER BY date DESC, id DESC LIMIT 8').all().map(serializeOrder);
  const suppliers = db.prepare("SELECT suppliers.*, COALESCE(SUM(CASE WHEN orders.total_cents > orders.paid_cents THEN orders.total_cents - orders.paid_cents ELSE 0 END), 0) AS outstanding_cents FROM suppliers LEFT JOIN orders ON orders.party_id = suppliers.id AND orders.type = 'purchase' AND orders.audited = 1 GROUP BY suppliers.id ORDER BY suppliers.name COLLATE NOCASE").all().map((row) => ({ ...row, outstanding: asMoney(row.outstanding_cents), outstanding_cents: undefined }));
  const customers = db.prepare("SELECT customers.*, COALESCE(SUM(CASE WHEN orders.total_cents > orders.paid_cents THEN orders.total_cents - orders.paid_cents ELSE 0 END), 0) AS outstanding_cents FROM customers LEFT JOIN orders ON orders.party_id = customers.id AND orders.type = 'sale' AND orders.audited = 1 GROUP BY customers.id ORDER BY customers.name COLLATE NOCASE").all().map((row) => ({ ...row, outstanding: asMoney(row.outstanding_cents), outstanding_cents: undefined }));
  const categories = db.prepare('SELECT * FROM categories ORDER BY name COLLATE NOCASE, id').all();
  return res.json({ settings, products, categories, units: db.prepare('SELECT * FROM units ORDER BY name').all(), suppliers, customers, orders, totals });
});
app.get('/api/categories', (_req, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY name COLLATE NOCASE, id').all()));
app.post('/api/categories', (req, res) => {
  const name = text(req.body?.name, 80);
  if (!name) return sendError(res, '请输入有效的分类名称');
  try {
    const result = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    return res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid));
  } catch (error) {
    return sendError(res, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? '该分类名称已存在' : error.message, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400);
  }
});
app.put('/api/categories/:id', (req, res) => {
  const id = integerId(req.params.id);
  if (!id) return sendError(res, '分类编号无效');
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!category) return sendError(res, '分类不存在', 404);
  if (category.name === '未分类') return sendError(res, '默认分类不能修改');
  const name = text(req.body?.name, 80);
  if (!name) return sendError(res, '请输入有效的分类名称');
  try {
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
    return res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, '该分类名称已存在', 409);
    throw error;
  }
});
app.delete('/api/categories/:id', (req, res) => {
  const id = integerId(req.params.id);
  if (!id) return sendError(res, '分类编号无效');
  const category = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
  if (!category) return sendError(res, '分类不存在', 404);
  if (category.name === '未分类') return sendError(res, '默认分类不能删除', 409);
  if (db.prepare('SELECT 1 FROM products WHERE category_id = ? LIMIT 1').get(id)) return sendError(res, '该分类下仍有商品，不能删除', 409);
  if (db.prepare('SELECT 1 FROM stocktakes WHERE category_id = ? LIMIT 1').get(id)) return sendError(res, '该分类已有盘点记录，不能删除', 409);
  const result = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  if (!result.changes) return sendError(res, '分类不存在', 404);
  return res.json({ deleted: true });
});
app.get('/api/settings', (_req, res) => res.json(Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value]))));
app.put('/api/settings', (req, res) => {
  const allowed = ['systemName', 'purchaseTemplate', 'salesTemplate'];
  const update = db.transaction(() => {
    for (const key of allowed) if (typeof req.body?.[key] === 'string') db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, text(req.body[key], 100));
  });
  update();
  return res.json(Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value])));
});

app.get('/api/customers/:id/receivables', (req, res) => {
  const customerId = integerId(req.params.id);
  const customer = customerId && db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId);
  if (!customer) return sendError(res, '客户不存在', 404);
  const orders = db.prepare(`SELECT id, number, date, total_cents, paid_cents
    FROM orders WHERE type = 'sale' AND audited = 1 AND party_id = ? AND total_cents > paid_cents
    ORDER BY date, id`).all(customerId).map((order) => ({
    id: order.id, number: order.number, date: order.date,
    total: asMoney(order.total_cents), paid: asMoney(order.paid_cents),
    outstanding: asMoney(order.total_cents - order.paid_cents),
  }));
  const receipts = db.prepare(`SELECT customer_receipts.*,
      EXISTS(SELECT 1 FROM customer_receipt_vouchers WHERE receipt_id = customer_receipts.id) AS has_voucher,
      customer_receipt_allocations.order_id, customer_receipt_allocations.amount_cents,
      orders.number AS order_number
    FROM customer_receipts
    LEFT JOIN customer_receipt_allocations ON customer_receipt_allocations.receipt_id = customer_receipts.id
    LEFT JOIN orders ON orders.id = customer_receipt_allocations.order_id
    WHERE customer_receipts.customer_id = ?
    ORDER BY customer_receipts.date DESC, customer_receipts.id DESC`).all(customerId);
  const receiptRows = [];
  for (const row of receipts) {
    let receipt = receiptRows[receiptRows.length - 1];
    if (!receipt || receipt.id !== row.id) {
      receipt = { id: row.id, date: row.date, total: asMoney(row.total_cents), payment_method: row.payment_method, note: row.note, has_voucher: Boolean(row.has_voucher), allocations: [] };
      receiptRows.push(receipt);
    }
    if (row.order_id !== null) receipt.allocations.push({ order_number: row.order_number, amount: asMoney(row.amount_cents) });
  }
  return res.json({ customer, orders, receipts: receiptRows });
});
app.get('/api/customer-receipts/:id/voucher', (req, res) => {
  const receiptId = integerId(req.params.id);
  if (!receiptId) return sendError(res, '收款记录编号无效');
  const voucher = db.prepare('SELECT mime_type, data_base64 FROM customer_receipt_vouchers WHERE receipt_id = ?').get(receiptId);
  if (!voucher) return sendError(res, '该收款记录没有凭证', 404);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.type(voucher.mime_type).send(Buffer.from(voucher.data_base64, 'base64'));
});
app.post('/api/customers/:id/receivables', (req, res) => {
  const customerId = integerId(req.params.id);
  const customer = customerId && db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
  if (!customer) return sendError(res, '客户不存在', 404);
  const date = dateValue(req.body?.date);
  if (!date) return sendError(res, '请选择有效收款日期');
  const paymentMethod = text(req.body?.paymentMethod, 30);
  if (!['现金', '微信', '支付宝', '银行转账', '其他'].includes(paymentMethod)) return sendError(res, '请选择有效收款方式');
  const voucher = req.body?.paymentVoucher === undefined || req.body.paymentVoucher === null ? null : parsePaymentVoucher(req.body.paymentVoucher);
  if (voucher?.error) return sendError(res, voucher.error);
  if (paymentMethod === '现金' && voucher) return sendError(res, '现金收款不需要上传凭证');
  if (typeof req.body?.note !== 'string' || req.body.note.length > 500) return sendError(res, '备注不能超过 500 字');
  if (!Array.isArray(req.body?.allocations) || req.body.allocations.length < 1 || req.body.allocations.length > 200) return sendError(res, '请选择需要收款的销售单');
  const allocations = [];
  const seenOrders = new Set();
  for (const allocation of req.body.allocations) {
    const orderId = integerId(allocation?.orderId);
    const amount = cents(allocation?.amount);
    if (!orderId || amount === null || amount <= 0 || seenOrders.has(orderId)) return sendError(res, '收款单据或金额无效');
    seenOrders.add(orderId);
    allocations.push({ orderId, amount });
  }
  const total = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  try {
    const saveReceipt = db.transaction(() => {
      const getOrder = db.prepare("SELECT id, total_cents, paid_cents FROM orders WHERE id = ? AND type = 'sale' AND audited = 1 AND party_id = ?");
      for (const allocation of allocations) {
        const order = getOrder.get(allocation.orderId, customerId);
        if (!order) throw new Error('收款单据不属于该客户或已不存在，请刷新后重试');
        if (allocation.amount > order.total_cents - order.paid_cents) throw new Error('收款金额超过单据未收金额，请刷新后重试');
      }
      const receipt = db.prepare('INSERT INTO customer_receipts (customer_id,date,total_cents,payment_method,note) VALUES (?,?,?,?,?)')
        .run(customerId, date, total, paymentMethod, text(req.body.note, 500));
      if (voucher) {
        db.prepare('INSERT INTO customer_receipt_vouchers (receipt_id,mime_type,data_base64) VALUES (?,?,?)')
          .run(receipt.lastInsertRowid, voucher.mimeType, voucher.dataBase64);
      }
      const insertAllocation = db.prepare('INSERT INTO customer_receipt_allocations (receipt_id,order_id,amount_cents) VALUES (?,?,?)');
      const updateOrder = db.prepare("UPDATE orders SET paid_cents = paid_cents + ?, payment_method = ? WHERE id = ? AND type = 'sale' AND audited = 1 AND party_id = ?");
      for (const allocation of allocations) {
        insertAllocation.run(receipt.lastInsertRowid, allocation.orderId, allocation.amount);
        const updated = updateOrder.run(allocation.amount, paymentMethod, allocation.orderId, customerId);
        if (!updated.changes) throw new Error('收款单据已变更，请刷新后重试');
      }
      return Number(receipt.lastInsertRowid);
    });
    const receiptId = saveReceipt();
    return res.status(201).json({ id: receiptId, date, total: asMoney(total), payment_method: paymentMethod, has_voucher: Boolean(voucher) });
  } catch (error) { return sendError(res, error.message, 409); }
});

app.get('/api/suppliers/:id/payables', (req, res) => {
  const supplierId = integerId(req.params.id);
  const supplier = supplierId && db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(supplierId);
  if (!supplier) return sendError(res, '供应商不存在', 404);
  const orders = db.prepare(`SELECT id, number, date, total_cents, paid_cents
    FROM orders WHERE type = 'purchase' AND audited = 1 AND party_id = ? AND total_cents > paid_cents
    ORDER BY date, id`).all(supplierId).map((order) => ({
    id: order.id, number: order.number, date: order.date,
    total: asMoney(order.total_cents), paid: asMoney(order.paid_cents),
    outstanding: asMoney(order.total_cents - order.paid_cents),
  }));
  const payments = db.prepare(`SELECT supplier_payments.*,
      supplier_payment_allocations.order_id, supplier_payment_allocations.amount_cents,
      orders.number AS order_number
    FROM supplier_payments
    LEFT JOIN supplier_payment_allocations ON supplier_payment_allocations.payment_id = supplier_payments.id
    LEFT JOIN orders ON orders.id = supplier_payment_allocations.order_id
    WHERE supplier_payments.supplier_id = ?
    ORDER BY supplier_payments.date DESC, supplier_payments.id DESC`).all(supplierId);
  const paymentRows = [];
  for (const row of payments) {
    let payment = paymentRows[paymentRows.length - 1];
    if (!payment || payment.id !== row.id) {
      payment = { id: row.id, date: row.date, total: asMoney(row.total_cents), payment_method: row.payment_method, note: row.note, allocations: [] };
      paymentRows.push(payment);
    }
    if (row.order_id !== null) payment.allocations.push({ order_number: row.order_number, amount: asMoney(row.amount_cents) });
  }
  return res.json({ supplier, orders, payments: paymentRows });
});
app.post('/api/suppliers/:id/payables', (req, res) => {
  const supplierId = integerId(req.params.id);
  const supplier = supplierId && db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
  if (!supplier) return sendError(res, '供应商不存在', 404);
  const date = dateValue(req.body?.date);
  if (!date) return sendError(res, '请选择有效付款日期');
  const paymentMethod = text(req.body?.paymentMethod, 30);
  if (!['现金', '微信', '支付宝', '银行转账', '其他'].includes(paymentMethod)) return sendError(res, '请选择有效付款方式');
  if (typeof req.body?.note !== 'string' || req.body.note.length > 500) return sendError(res, '备注不能超过 500 字');
  if (!Array.isArray(req.body?.allocations) || req.body.allocations.length < 1 || req.body.allocations.length > 200) return sendError(res, '请选择需要付款的采购单');
  const allocations = [];
  const seenOrders = new Set();
  for (const allocation of req.body.allocations) {
    const orderId = integerId(allocation?.orderId);
    const amount = cents(allocation?.amount);
    if (!orderId || amount === null || amount <= 0 || seenOrders.has(orderId)) return sendError(res, '付款单据或金额无效');
    seenOrders.add(orderId);
    allocations.push({ orderId, amount });
  }
  const total = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  try {
    const savePayment = db.transaction(() => {
      const getOrder = db.prepare("SELECT id, total_cents, paid_cents FROM orders WHERE id = ? AND type = 'purchase' AND audited = 1 AND party_id = ?");
      for (const allocation of allocations) {
        const order = getOrder.get(allocation.orderId, supplierId);
        if (!order) throw new Error('付款单据不属于该供应商或已不存在，请刷新后重试');
        if (allocation.amount > order.total_cents - order.paid_cents) throw new Error('付款金额超过单据待付金额，请刷新后重试');
      }
      const payment = db.prepare('INSERT INTO supplier_payments (supplier_id,date,total_cents,payment_method,note) VALUES (?,?,?,?,?)')
        .run(supplierId, date, total, paymentMethod, text(req.body.note, 500));
      const insertAllocation = db.prepare('INSERT INTO supplier_payment_allocations (payment_id,order_id,amount_cents) VALUES (?,?,?)');
      const updateOrder = db.prepare("UPDATE orders SET paid_cents = paid_cents + ?, payment_method = ? WHERE id = ? AND type = 'purchase' AND audited = 1 AND party_id = ?");
      for (const allocation of allocations) {
        insertAllocation.run(payment.lastInsertRowid, allocation.orderId, allocation.amount);
        const updated = updateOrder.run(allocation.amount, paymentMethod, allocation.orderId, supplierId);
        if (!updated.changes) throw new Error('付款单据已变更，请刷新后重试');
      }
      return Number(payment.lastInsertRowid);
    });
    const paymentId = savePayment();
    return res.status(201).json({ id: paymentId, date, total: asMoney(total), payment_method: paymentMethod });
  } catch (error) { return sendError(res, error.message, 409); }
});

entityRoutes('suppliers', 'name');
entityRoutes('customers', 'name');
entityRoutes('products', 'name');
app.get('/api/units', (_req, res) => res.json(db.prepare('SELECT * FROM units ORDER BY name').all()));
app.post('/api/units', (req, res) => {
  const name = text(req.body?.name, 30);
  if (!name) return sendError(res, '单位名称不能为空');
  try { const result = db.prepare('INSERT INTO units (name) VALUES (?)').run(name); return res.status(201).json(db.prepare('SELECT * FROM units WHERE id = ?').get(result.lastInsertRowid)); }
  catch { return sendError(res, '该单位已存在'); }
});
app.delete('/api/units/:id', (req, res) => {
  const id = integerId(req.params.id);
  const unit = id && db.prepare('SELECT name FROM units WHERE id = ?').get(id);
  if (!unit) return sendError(res, '单位不存在', 404);
  if (db.prepare('SELECT 1 FROM products WHERE unit = ? LIMIT 1').get(unit.name)) return sendError(res, '仍有商品使用该单位，不能删除', 409);
  db.prepare('DELETE FROM units WHERE id = ?').run(id);
  return res.status(204).end();
});

function serializeSuspendedOrder(row) {
  return { ...JSON.parse(row.data), suspendedId: row.id, suspendedVersion: row.version };
}
app.get('/api/suspended-orders', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json(db.prepare('SELECT * FROM suspended_orders ORDER BY rowid DESC').all().map(serializeSuspendedOrder));
});
app.post('/api/suspended-orders', (req, res) => {
  const draft = req.body;
  const validString = (value, limit) => typeof value === 'string' && value.length <= limit;
  const validInput = (value) => (typeof value === 'string' && value.length <= 30) || (typeof value === 'number' && Number.isFinite(value));
  if (!draft || !['purchase', 'sale'].includes(draft.type) || !Array.isArray(draft.lines) || draft.lines.length < 1 || draft.lines.length > 200 ||
      draft.lines.some((line) => !line || !validInput(line.productId ?? '') || !validInput(line.quantity) || !validInput(line.unitPrice)) ||
      !validInput(draft.partyId) || !validString(draft.orderDate, 10) || !validInput(draft.paidAmount) ||
      !validString(draft.paymentMethod, 30) || !validString(draft.note, 500) || !validString(draft.voucherName, 255) ||
      typeof draft.removeVoucher !== 'boolean') return sendError(res, '挂单数据无效');
  if (draft.paymentVoucher && parsePaymentVoucher(draft.paymentVoucher).error) return sendError(res, '付款凭证无效');
  if (draft.paymentVoucher !== '' && typeof draft.paymentVoucher !== 'string') return sendError(res, '付款凭证无效');
  const data = JSON.stringify({
    kind: 'order', type: draft.type, lines: draft.lines.map(({ productId, quantity: count, unitPrice }) => ({ productId, quantity: count, unitPrice })),
    partyId: draft.partyId, orderDate: draft.orderDate, paidAmount: draft.paidAmount, paymentMethod: draft.paymentMethod,
    paymentVoucher: draft.paymentVoucher, voucherName: draft.voucherName, removeVoucher: draft.removeVoucher, note: draft.note,
  });
  if (draft.suspendedId) {
    if (typeof draft.suspendedId !== 'string' || !Number.isSafeInteger(draft.suspendedVersion)) return sendError(res, '挂单标识无效');
    const updated = db.prepare('UPDATE suspended_orders SET data = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(data, draft.suspendedId, draft.suspendedVersion);
    if (!updated.changes) return sendError(res, '挂单已被其他设备修改或取消，请重新取单', 409);
    return res.json(serializeSuspendedOrder(db.prepare('SELECT * FROM suspended_orders WHERE id = ?').get(draft.suspendedId)));
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO suspended_orders (id, data) VALUES (?, ?)').run(id, data);
  return res.status(201).json(serializeSuspendedOrder(db.prepare('SELECT * FROM suspended_orders WHERE id = ?').get(id)));
});
app.delete('/api/suspended-orders/:id', (req, res) => {
  if (!Number.isSafeInteger(req.body?.version)) return sendError(res, '挂单版本无效');
  const result = db.prepare('DELETE FROM suspended_orders WHERE id = ? AND version = ?').run(req.params.id, req.body.version);
  if (!result.changes) return sendError(res, '挂单已被其他设备修改或取消，请刷新挂单列表', 409);
  return res.status(204).end();
});
app.get('/api/orders', (req, res) => {
  const conditions = [];
  const values = [];
  if (['purchase', 'sale'].includes(req.query.type)) { conditions.push('type = ?'); values.push(req.query.type); }
  const from = dateValue(req.query.from);
  const to = dateValue(req.query.to);
  if (req.query.from && !from || req.query.to && !to) return sendError(res, '日期格式无效');
  if (from) { conditions.push('date >= ?'); values.push(from); }
  if (to) { conditions.push('date <= ?'); values.push(to); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orders = db.prepare(`SELECT orders.*, EXISTS(SELECT 1 FROM order_vouchers WHERE order_id = orders.id) AS has_voucher FROM orders ${where} ORDER BY date DESC, id DESC`).all(...values).map(serializeOrder);
  const items = db.prepare(`SELECT order_items.* FROM order_items JOIN orders ON orders.id = order_items.order_id ${where}`).all(...values);
  const byOrder = new Map();
  for (const item of items) { if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []); byOrder.get(item.order_id).push({ ...item, unit_price: asMoney(item.unit_price_cents), subtotal: asMoney(item.subtotal_cents) }); }
  return res.json(orders.map((order) => ({ ...order, items: byOrder.get(order.id) || [] })));
});
app.post('/api/orders', (req, res) => {
  const { type, partyId: rawPartyId, date: rawDate, note = '', items: rawItems, paidAmount: rawPaidAmount = 0, paymentMethod: rawPaymentMethod = '' } = req.body || {};
  const { suspendedId, suspendedVersion } = req.body || {};
  if (suspendedId !== undefined && (typeof suspendedId !== 'string' || !Number.isSafeInteger(suspendedVersion))) return sendError(res, '挂单标识无效');
  const voucher = req.body?.paymentVoucher === undefined || req.body.paymentVoucher === null ? null : parsePaymentVoucher(req.body.paymentVoucher);
  if (voucher?.error) return sendError(res, voucher.error);
  const date = dateValue(rawDate);
  if (!['purchase', 'sale'].includes(type)) return sendError(res, '单据类型无效');
  if (!date) return sendError(res, '请选择有效单据日期');
  if (typeof note !== 'string' || note.length > 500) return sendError(res, '备注不能超过 500 字');
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 200) return sendError(res, '单据至少需要一个商品');
  const partyId = integerId(rawPartyId);
  const partyTable = type === 'purchase' ? 'suppliers' : 'customers';
  const party = partyId && db.prepare(`SELECT id, name FROM ${partyTable} WHERE id = ?`).get(partyId);
  if (!party) return sendError(res, type === 'purchase' ? '请选择有效供应商' : '请选择有效客户');
  const lines = [];
  for (const item of rawItems) {
    const productId = integerId(item.productId);
    const product = productId && db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    const count = quantity(item.quantity);
    const unitPrice = cents(item.unitPrice);
    if (!product || count === null || unitPrice === null) return sendError(res, '商品、数量或单价无效');
    lines.push({ product, quantity: count, unitPrice, subtotal: Math.round(count * unitPrice) });
  }
  const total = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const paid = cents(rawPaidAmount);
  if (paid === null || paid > total) return sendError(res, `${type === 'sale' ? '收款' : '付款'}金额不能小于零或超过单据金额`);
  const paymentMethods = ['现金', '微信', '支付宝', '银行转账', '其他'];
  const paymentMethod = paid === 0 ? (type === 'sale' ? '未收款' : '未付款') : text(rawPaymentMethod, 30);
  if (paid > 0 && !paymentMethods.includes(paymentMethod)) return sendError(res, `请选择有效的${type === 'sale' ? '收款' : '付款'}方式`);
  try {
    const create = db.transaction(() => {
      if (suspendedId !== undefined) {
        const deleted = db.prepare('DELETE FROM suspended_orders WHERE id = ? AND version = ?').run(suspendedId, suspendedVersion);
        if (!deleted.changes) throw new Error('挂单已被其他设备修改或取消，请重新取单');
      }
      const number = nextNumber(type === 'purchase' ? 'CG' : 'XS', date, 'orders');
      const result = db.prepare('INSERT INTO orders (number,type,date,party_id,party_name,total_cents,paid_cents,planned_paid_cents,payment_method,audited,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(number, type, date, party.id, party.name, total, 0, paid, paymentMethod, 0, text(note, 500));
      const orderId = Number(result.lastInsertRowid);
      saveOrderVoucher(orderId, voucher);
      const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,product_name,specification,unit,quantity,unit_price_cents,subtotal_cents) VALUES (?,?,?,?,?,?,?,?)');
      for (const line of lines) {
        insertItem.run(orderId, line.product.id, line.product.name, line.product.specification, line.product.unit, line.quantity, line.unitPrice, line.subtotal);
      }
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    });
    return res.status(201).json({ ...serializeOrder(create()), items: lines.map((line) => ({ product_name: line.product.name, specification: line.product.specification, unit: line.product.unit, quantity: line.quantity, unit_price: asMoney(line.unitPrice), subtotal: asMoney(line.subtotal) })) });
  } catch (error) { return sendError(res, error.message, 409); }
});
function applyOrderAudit(order) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const direction = order.type === 'purchase' ? 1 : -1;
  for (const item of items) {
    const product = db.prepare('SELECT name, stock FROM products WHERE id = ?').get(item.product_id);
    if (!product || order.type === 'sale' && product.stock < item.quantity) {
      throw new Error(`${product?.name || '商品'} 库存不足，无法审核订单`);
    }
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(direction * item.quantity, item.product_id);
    db.prepare('INSERT INTO stock_movements (product_id,order_id,kind,quantity_delta,note) VALUES (?,?,?,?,?)')
      .run(item.product_id, order.id, order.type, direction * item.quantity, order.number);
  }
  db.prepare('UPDATE orders SET audited = 1, reversed = 0, paid_cents = planned_paid_cents WHERE id = ?').run(order.id);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
}
app.post('/api/orders/:id/audit', (req, res) => {
  const id = integerId(req.params.id);
  if (!id) return sendError(res, '单据编号无效');
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!existing) return sendError(res, '单据不存在', 404);
  if (existing.audited) return sendError(res, '该订单已经审核', 409);
  try {
    const audit = db.transaction(() => applyOrderAudit(existing));
    return res.json(serializeOrder(audit()));
  } catch (error) { return sendError(res, error.message, 409); }
});
app.put('/api/orders/:id', (req, res) => {
  const id = integerId(req.params.id);
  if (!id) return sendError(res, '单据编号无效');
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!existing) return sendError(res, '单据不存在', 404);
  const { type, partyId: rawPartyId, date: rawDate, note = '', items: rawItems, paidAmount: rawPaidAmount = 0, paymentMethod: rawPaymentMethod = '' } = req.body || {};
  const hasVoucherChange = Object.hasOwn(req.body || {}, 'paymentVoucher');
  const voucher = !hasVoucherChange || req.body.paymentVoucher === null ? null : parsePaymentVoucher(req.body.paymentVoucher);
  if (voucher?.error) return sendError(res, voucher.error);
  const date = dateValue(rawDate);
  if (type !== existing.type) return sendError(res, '单据类型无效');
  if (!date) return sendError(res, '请选择有效单据日期');
  if (typeof note !== 'string' || note.length > 500) return sendError(res, '备注不能超过 500 字');
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 200) return sendError(res, '单据至少需要一个商品');
  const partyId = integerId(rawPartyId);
  const partyTable = type === 'purchase' ? 'suppliers' : 'customers';
  const party = partyId && db.prepare(`SELECT id, name FROM ${partyTable} WHERE id = ?`).get(partyId);
  if (!party) return sendError(res, type === 'purchase' ? '请选择有效供应商' : '请选择有效客户');
  const lines = [];
  for (const item of rawItems) {
    const productId = integerId(item.productId);
    const product = productId && db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    const count = quantity(item.quantity);
    const unitPrice = cents(item.unitPrice);
    if (!product || count === null || unitPrice === null) return sendError(res, '商品、数量或单价无效');
    lines.push({ product, quantity: count, unitPrice, subtotal: Math.round(count * unitPrice) });
  }
  const total = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const paid = cents(rawPaidAmount);
  if (paid === null || paid > total) return sendError(res, `${type === 'sale' ? '收款' : '付款'}金额不能小于零或超过单据金额`);
  const recordedReceipts = type === 'sale' ? db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM customer_receipt_allocations WHERE order_id = ?').get(id).total : 0;
  const recordedPayments = type === 'purchase' ? db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM supplier_payment_allocations WHERE order_id = ?').get(id).total : 0;
  if (recordedReceipts > 0 && partyId !== existing.party_id) return sendError(res, '已有收款记录的销售单不能更换客户');
  if (recordedPayments > 0 && partyId !== existing.party_id) return sendError(res, '已有付款记录的采购单不能更换供应商');
  if (paid < recordedReceipts) return sendError(res, '已登记的收款记录不能通过编辑单据撤销');
  if (paid < recordedPayments) return sendError(res, '已登记的付款记录不能通过编辑单据撤销');
  const paymentMethods = ['现金', '微信', '支付宝', '银行转账', '其他'];
  const paymentMethod = paid === 0 ? (type === 'sale' ? '未收款' : '未付款') : text(rawPaymentMethod, 30);
  if (paid > 0 && !paymentMethods.includes(paymentMethod)) return sendError(res, `请选择有效的${type === 'sale' ? '收款' : '付款'}方式`);
  try {
    const update = db.transaction(() => {
      const previousItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
      if (!existing.audited) {
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
        const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,product_name,specification,unit,quantity,unit_price_cents,subtotal_cents) VALUES (?,?,?,?,?,?,?,?)');
        for (const line of lines) insertItem.run(id, line.product.id, line.product.name, line.product.specification, line.product.unit, line.quantity, line.unitPrice, line.subtotal);
        db.prepare('UPDATE orders SET date = ?, party_id = ?, party_name = ?, total_cents = ?, planned_paid_cents = ?, payment_method = ?, note = ? WHERE id = ?')
          .run(date, party.id, party.name, total, paid, paymentMethod, text(note, 500), id);
        if (hasVoucherChange) saveOrderVoucher(id, voucher);
        if (existing.reversed) return applyOrderAudit(existing);
        return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      }
      const stockDeltas = new Map();
      const direction = type === 'purchase' ? 1 : -1;
      for (const item of previousItems) {
        stockDeltas.set(item.product_id, (stockDeltas.get(item.product_id) || 0) - direction * item.quantity);
      }
      for (const line of lines) {
        stockDeltas.set(line.product.id, (stockDeltas.get(line.product.id) || 0) + direction * line.quantity);
      }
      for (const [productId, delta] of stockDeltas) {
        if (delta === 0) continue;
        const product = db.prepare('SELECT name, stock FROM products WHERE id = ?').get(productId);
        if (!product || product.stock + delta < 0) {
          throw new Error(type === 'sale'
            ? `${product?.name || '商品'} 库存不足，无法保存修改`
            : `${product?.name || '商品'} 库存不足，无法减少采购数量`);
        }
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(delta, productId);
      }
      const movement = db.prepare('INSERT INTO stock_movements (product_id,order_id,kind,quantity_delta,note) VALUES (?,?,?,?,?)');
      for (const item of previousItems) {
        movement.run(item.product_id, id, type, -direction * item.quantity, `${existing.number} 编辑冲销`);
      }
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,product_name,specification,unit,quantity,unit_price_cents,subtotal_cents) VALUES (?,?,?,?,?,?,?,?)');
      for (const line of lines) {
        insertItem.run(id, line.product.id, line.product.name, line.product.specification, line.product.unit, line.quantity, line.unitPrice, line.subtotal);
        movement.run(line.product.id, id, type, direction * line.quantity, existing.number);
      }
      db.prepare('UPDATE orders SET date = ?, party_id = ?, party_name = ?, total_cents = ?, paid_cents = ?, planned_paid_cents = ?, payment_method = ?, note = ? WHERE id = ?')
        .run(date, party.id, party.name, total, paid, paid, paymentMethod, text(note, 500), id);
      if (hasVoucherChange) saveOrderVoucher(id, voucher);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    });
    const order = update();
    return res.json({ ...serializeOrder(order), items: lines.map((line) => ({ product_name: line.product.name, specification: line.product.specification, unit: line.product.unit, quantity: line.quantity, unit_price: asMoney(line.unitPrice), subtotal: asMoney(line.subtotal) })) });
  } catch (error) { return sendError(res, error.message, 409); }
});
app.post('/api/orders/:id/reverse', (req, res) => {
  const id = integerId(req.params.id);
  if (!id) return sendError(res, '单据编号无效');
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!existing) return sendError(res, '单据不存在', 404);
  if (!existing.audited) return sendError(res, '该订单已经是未审核状态', 409);
  if (existing.type === 'sale' && db.prepare('SELECT 1 FROM customer_receipt_allocations WHERE order_id = ? LIMIT 1').get(id)) return sendError(res, '该销售单已有收款记录，不能反审核', 409);
  if (existing.type === 'purchase' && db.prepare('SELECT 1 FROM supplier_payment_allocations WHERE order_id = ? LIMIT 1').get(id)) return sendError(res, '该采购单已有付款记录，不能反审核', 409);
  try {
    const reverse = db.transaction(() => {
      const items = db.prepare('SELECT product_id, product_name, quantity FROM order_items WHERE order_id = ?').all(id);
      const laterOrder = db.prepare(`SELECT later.number FROM orders AS later
        JOIN order_items AS later_item ON later_item.order_id = later.id
        WHERE later.audited = 1
          AND (later.date > ? OR (later.date = ? AND later.id > ?))
          AND EXISTS (
            SELECT 1 FROM order_items AS current_item
            WHERE current_item.order_id = ? AND current_item.product_id = later_item.product_id
          )
        LIMIT 1`).get(existing.date, existing.date, id, id);
      if (laterOrder) {
        throw new Error(`商品已有后续已审核订单 ${laterOrder.number}，不能反审核该订单`);
      }
      const direction = existing.type === 'purchase' ? -1 : 1;
      const stockDeltas = new Map();
      for (const item of items) {
        stockDeltas.set(item.product_id, (stockDeltas.get(item.product_id) || 0) + direction * item.quantity);
      }
      for (const [productId, delta] of stockDeltas) {
        const product = db.prepare('SELECT stock, name FROM products WHERE id = ?').get(productId);
        if (!product || product.stock + delta < 0) {
          throw new Error(`${product?.name || '商品'} 当前库存不足，无法反审核该采购订单`);
        }
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(delta, productId);
      }
      db.prepare('UPDATE stock_movements SET order_id = NULL, note = ? WHERE order_id = ?')
        .run(`${existing.number} 已反审核`, id);
      const insertMovement = db.prepare('INSERT INTO stock_movements (product_id,kind,quantity_delta,note) VALUES (?,?,?,?)');
      for (const [productId, delta] of stockDeltas) {
        insertMovement.run(productId, existing.type, delta, `${existing.number} 反审核冲销`);
      }
      db.prepare('UPDATE orders SET audited = 0, reversed = 1, planned_paid_cents = paid_cents, paid_cents = 0 WHERE id = ?').run(id);
    });
    reverse();
    return res.json({ reversed: true, number: existing.number });
  } catch (error) { return sendError(res, error.message, 409); }
});
app.delete('/api/orders/:id', (req, res) => {
  const id = integerId(req.params.id);
  if (!id) return sendError(res, '单据编号无效');
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!existing) return sendError(res, '单据不存在', 404);
  if (existing.audited) return sendError(res, '只有未审核的订单才能删除', 409);
  if (existing.type === 'sale' && db.prepare('SELECT 1 FROM customer_receipt_allocations WHERE order_id = ? LIMIT 1').get(id)) return sendError(res, '该销售单已有收款记录，不能删除', 409);
  if (existing.type === 'purchase' && db.prepare('SELECT 1 FROM supplier_payment_allocations WHERE order_id = ? LIMIT 1').get(id)) return sendError(res, '该采购单已有付款记录，不能删除', 409);
  const result = db.prepare('DELETE FROM orders WHERE id = ? AND audited = 0').run(id);
  if (!result.changes) return sendError(res, '只有未审核的订单才能删除', 409);
  return res.json({ deleted: true, number: existing.number });
});
app.get('/api/orders/:id/voucher', (req, res) => {
  const id = integerId(req.params.id);
  if (!id) return sendError(res, '单据编号无效');
  const voucher = db.prepare('SELECT mime_type, data_base64 FROM order_vouchers WHERE order_id = ?').get(id);
  if (!voucher) return sendError(res, '该单据没有付款凭证', 404);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.type(voucher.mime_type).send(Buffer.from(voucher.data_base64, 'base64'));
});
app.get('/api/stock', (_req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all().map(serializeProduct)));
app.get('/api/stock/movements', (req, res) => {
  const from = dateValue(req.query.from); const to = dateValue(req.query.to);
  if (req.query.from && !from || req.query.to && !to) return sendError(res, '日期格式无效');
  const clauses = []; const values = [];
  if (from) { clauses.push("date(stock_movements.created_at) >= ?"); values.push(from); }
  if (to) { clauses.push("date(stock_movements.created_at) <= ?"); values.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return res.json(db.prepare(`SELECT stock_movements.*, products.name AS product_name, products.unit FROM stock_movements JOIN products ON products.id = stock_movements.product_id ${where} ORDER BY stock_movements.id DESC LIMIT 500`).all(...values));
});
app.post('/api/stocktakes', (req, res) => {
  const date = dateValue(req.body?.date);
  const counts = req.body?.items;
  const categoryId = integerId(req.body?.categoryId);
  const category = categoryId && db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!date || !category || !Array.isArray(counts) || counts.length < 1) return sendError(res, '请选择盘点日期、商品分类并填写盘点商品');
  const categoryProducts = db.prepare('SELECT * FROM products WHERE category_id = ? ORDER BY name COLLATE NOCASE').all(categoryId);
  if (categoryProducts.length !== counts.length) return sendError(res, '盘点商品与所选分类不匹配，请刷新后重试');
  const productsById = new Map(categoryProducts.map((product) => [product.id, product]));
  const rows = [];
  const seenProducts = new Set();
  for (const line of counts) {
    if (!line || typeof line !== 'object') return sendError(res, '盘点商品或实盘数量无效');
    const id = integerId(line.productId);
    const rawCount = line.counted;
    const counted = typeof rawCount === 'number' || typeof rawCount === 'string' && rawCount.trim() ? Number(rawCount) : NaN;
    const product = id && productsById.get(id);
    if (!product || seenProducts.has(id) || !Number.isSafeInteger(counted) || counted < 0 || counted > 999999999) return sendError(res, '实盘商品必须全部属于所选分类，且数量须为 0 至 999999999 的整数');
    seenProducts.add(id);
    rows.push({ product, counted, difference: Math.round((counted - product.stock) * 10000) / 10000 });
  }
  if (seenProducts.size !== categoryProducts.length) return sendError(res, '所选分类中的商品必须全部参与盘点');
  const save = db.transaction(() => {
    const number = nextNumber('PD', date, 'stocktakes');
    const result = db.prepare('INSERT INTO stocktakes (number,date,category_id,note) VALUES (?,?,?,?)').run(number, date, categoryId, text(req.body.note, 500));
    const id = Number(result.lastInsertRowid);
    const insert = db.prepare('INSERT INTO stocktake_items (stocktake_id,product_id,product_name,expected,counted,difference) VALUES (?,?,?,?,?,?)');
    for (const row of rows) {
      insert.run(id, row.product.id, row.product.name, row.product.stock, row.counted, row.difference);
      if (row.difference !== 0) {
        db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(row.counted, row.product.id);
        db.prepare("INSERT INTO stock_movements (product_id,kind,quantity_delta,note) VALUES (?,'stocktake',?,?)").run(row.product.id, row.difference, number);
      }
    }
    return { id, number, date, items: rows.map((row) => ({ product_name: row.product.name, expected: row.product.stock, counted: row.counted, difference: row.difference })) };
  });
  return res.status(201).json(save());
});
app.get('/api/stocktakes', (_req, res) => res.json(db.prepare('SELECT stocktakes.*, categories.name AS category_name, COUNT(stocktake_items.id) AS item_count FROM stocktakes LEFT JOIN categories ON categories.id = stocktakes.category_id LEFT JOIN stocktake_items ON stocktake_items.stocktake_id=stocktakes.id GROUP BY stocktakes.id ORDER BY stocktakes.date DESC, stocktakes.id DESC').all()));
app.get('/api/stocktakes/:id', (req, res) => {
  const id = integerId(req.params.id);
  if (!id) return sendError(res, '盘点单编号无效');
  const stocktake = db.prepare('SELECT stocktakes.*, categories.name AS category_name FROM stocktakes LEFT JOIN categories ON categories.id = stocktakes.category_id WHERE stocktakes.id = ?').get(id);
  if (!stocktake) return sendError(res, '盘点单不存在', 404);
  const items = db.prepare(`SELECT stocktake_items.*, COALESCE(products.unit, '') AS unit
    FROM stocktake_items LEFT JOIN products ON products.id = stocktake_items.product_id
    WHERE stocktake_items.stocktake_id = ? ORDER BY stocktake_items.id`).all(id);
  return res.json({ ...stocktake, items });
});

const backupTables = ['settings','units','categories','suppliers','customers','products','orders','customer_receipts','customer_receipt_allocations','customer_receipt_vouchers','supplier_payments','supplier_payment_allocations','order_items','order_vouchers','stock_movements','stocktakes','stocktake_items','suspended_orders'];
app.get('/api/backup', (_req, res) => {
  const backup = { format: 'jxc-backup', version: 1, createdAt: new Date().toISOString(), data: Object.fromEntries(backupTables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])) };
  res.setHeader('Content-Disposition', `attachment; filename="jxc-backup-${new Date().toISOString().slice(0,10)}.json"`);
  return res.json(backup);
});
app.post('/api/restore', (req, res) => {
  const backup = req.body;
  const optionalTables = ['categories', 'order_vouchers', 'customer_receipts', 'customer_receipt_allocations', 'customer_receipt_vouchers', 'supplier_payments', 'supplier_payment_allocations', 'suspended_orders'];
  if (backup?.format !== 'jxc-backup' || backup.version !== 1 || !backup.data || backupTables.filter((table) => !optionalTables.includes(table)).some((table) => !Array.isArray(backup.data[table])) || optionalTables.some((table) => backup.data[table] !== undefined && !Array.isArray(backup.data[table]))) return sendError(res, '备份文件格式不受支持');
  try {
    const restore = db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      for (const table of [...backupTables].reverse()) db.prepare(`DELETE FROM ${table}`).run();
      const columns = { settings: ['key','value'], units: ['id','name'], categories: ['id','name','created_at'], suppliers: ['id','name','contact','phone','email','address','note','created_at'], customers: ['id','name','contact','phone','email','address','note','created_at'], products: ['id','sku','name','specification','unit','category_id','cost_cents','price_cents','stock','threshold','stock_alert_enabled','note','created_at'], orders: ['id','number','type','date','party_id','party_name','total_cents','paid_cents','planned_paid_cents','payment_method','audited','reversed','note','created_at'], customer_receipts: ['id','customer_id','date','total_cents','payment_method','note','created_at'], customer_receipt_allocations: ['id','receipt_id','order_id','amount_cents'], customer_receipt_vouchers: ['receipt_id','mime_type','data_base64'], supplier_payments: ['id','supplier_id','date','total_cents','payment_method','note','created_at'], supplier_payment_allocations: ['id','payment_id','order_id','amount_cents'], order_items: ['id','order_id','product_id','product_name','specification','unit','quantity','unit_price_cents','subtotal_cents'], order_vouchers: ['order_id','mime_type','data_base64'], stock_movements: ['id','product_id','order_id','kind','quantity_delta','note','created_at'], stocktakes: ['id','number','date','category_id','note','created_at'], stocktake_items: ['id','stocktake_id','product_id','product_name','expected','counted','difference'], suspended_orders: ['id','version','data'] };
      const categoryInsert = db.prepare('INSERT INTO categories (id,name,created_at) VALUES (?,?,?)');
      for (const row of backup.data.categories || []) categoryInsert.run(row.id, row.name, row.created_at || new Date().toISOString());
      db.prepare("INSERT OR IGNORE INTO categories (name) VALUES ('未分类')").run();
      const uncategorizedId = db.prepare("SELECT id FROM categories WHERE name = '未分类'").get().id;
      for (const table of backupTables) {
        if (table === 'categories') continue;
        const fields = columns[table]; const insert = db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
        for (const row of backup.data[table] || []) insert.run(...fields.map((field) => {
          if (table === 'orders' && field === 'paid_cents' && row[field] === undefined) return row.total_cents;
          if (table === 'orders' && field === 'planned_paid_cents' && row[field] === undefined) return row.paid_cents ?? row.total_cents;
          if (table === 'orders' && field === 'audited' && row[field] === undefined) return 1;
          if (table === 'orders' && field === 'reversed' && row[field] === undefined) return 0;
          if (table === 'orders' && field === 'payment_method' && row[field] === undefined) return '历史单据（按已结清处理）';
          if (table === 'products' && field === 'stock_alert_enabled' && row[field] === undefined) return 1;
          if (table === 'products' && field === 'category_id' && row[field] == null) return uncategorizedId;
          return row[field] ?? null;
        }));
      }
      db.prepare(`UPDATE orders SET reversed = 1
        WHERE audited = 0 AND EXISTS (
          SELECT 1 FROM stock_movements
          WHERE stock_movements.note = orders.number || ' 已反审核'
        )`).run();
    });
    restore();
    return res.json({ restored: true });
  } catch (error) { return sendError(res, `恢复失败，原数据未更改：${error.message}`); }
});

const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof SyntaxError && 'body' in error) return sendError(res, '请求数据格式无效');
  return res.status(500).json({ error: '服务器内部错误' });
});
app.listen(port, '0.0.0.0', () => console.log(`JXC listening on ${port}`));
