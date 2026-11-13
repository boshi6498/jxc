import React, { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle, ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine,
  Boxes, Building2, CalendarDays, Check, ChevronDown, ChevronRight,
  CircleHelp, ClipboardCheck, CreditCard, Download, FileText, LayoutDashboard,
  LogOut, Menu, Package, Pencil, Plus, Printer, RotateCcw, Save, Search, Tags,
  PauseCircle, Settings, ShieldCheck, ShoppingBag, Trash2, Truck, Upload, Users, X,
} from 'lucide-react';
import './styles.css';
import './auth.css';
import './finance.css';
import './print.css';
import { entityColumns, entityExportValues, parseEntityCsv } from './entity-csv.js';

const nav = [
  { title: '总览', items: [['dashboard', '经营总览', LayoutDashboard]] },
  { title: '基础资料', items: [['products', '商品管理', Package], ['categories', '商品分类', Tags], ['suppliers', '供应商管理', Truck], ['customers', '客户管理', Users], ['units', '商品单位', Boxes]] },
  { title: '业务单据', items: [['purchase', '采购订单', ArrowDownToLine], ['sales', '销售订单', ArrowUpFromLine]] },
  { title: '库存', items: [['stock', '库存管理', ArrowLeftRight], ['stocktakes', '库存盘点', ClipboardCheck]] },
  { title: '系统', items: [['settings', '系统设置', Settings]] },
];
const money = (value) => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const firstOfMonth = () => `${today().slice(0, 7)}-01`;
const isStockAlertEnabled = (value) => ![false, 0, 'false', '0'].includes(value);
const labels = { dashboard: '经营总览', receivables: '应收账款客户明细', stockAlerts: '库存告警明细', products: '商品管理', categories: '商品分类', suppliers: '供应商管理', customers: '客户管理', units: '商品单位', purchase: '采购订单', sales: '销售订单', stock: '库存管理', stocktakes: '库存盘点', settings: '系统设置' };
const descriptions = { receivables: '查看客户未收款明细，并按销售单登记收款。', stockAlerts: '查看低于安全库存的商品，并可直接解除库存告警。', products: '管理商品档案、销售价格与安全库存。', categories: '管理商品分类，点击分类名称查看该分类下的商品。', suppliers: '维护供应商联系方式和往来资料，点击名称查看全部采购订单。', customers: '维护客户资料，点击名称查看全部销售订单，或进入应收账款处理。', units: '管理商品档案可使用的计量单位。', purchase: '登记采购到货，生成采购流水并同步入库。', sales: '选择商品开单，系统校验库存并自动出库。', stock: '查看实时库存、调整销售价格和导出库存数据。', stocktakes: '录入实盘数量，保存后自动校准系统库存。', settings: '自定义系统名称、单据模板，并备份或恢复业务数据。' };
const field = (name, label, type = 'text', options = {}) => ({ name, label, type, ...options });

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function App() {
  const [active, setActive] = useState('dashboard');
  const [data, setData] = useState({ settings: {}, products: [], categories: [], units: [], suppliers: [], customers: [], orders: [], totals: [] });
  const [stocktakes, setStocktakes] = useState([]);
  const [modal, setModal] = useState(null);
  const [suspendedOrders, setSuspendedOrders] = useState([]);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [focusedParty, setFocusedParty] = useState(null);
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [toast, setToast] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authLoading, setAuthLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [authUser, setAuthUser] = useState('');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [previewOrder, setPreviewOrder] = useState(null);
  const currentTitle = data.settings.systemName || '商户进销存';

  async function refresh() {
    const [init, orders, stocktakeRows, drafts] = await Promise.all([api('/api/init'), api('/api/orders'), api('/api/stocktakes'), api('/api/suspended-orders')]);
    setData({ ...init, orders });
    setStocktakes(stocktakeRows);
    setSuspendedOrders(drafts);
    return { ...init, suspendedOrders: drafts };
  }
  useEffect(() => {
    let active = true;
    api('/api/auth').then((auth) => {
      if (!active || !auth.authenticated) return;
      setAuthenticated(true);
      setAuthUser(auth.username);
      return refresh();
    }).catch((cause) => { if (active) setError({ page: 'dashboard', message: cause.message }); }).finally(() => {
      if (active) { setAuthLoading(false); setLoading(false); }
    });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (!toast) return undefined; const timer = window.setTimeout(() => setToast(''), 2800); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => { document.title = currentTitle; }, [currentTitle]);

  const lowStock = data.products.filter((item) => isStockAlertEnabled(item.stock_alert_enabled) && Number(item.stock) <= Number(item.threshold));
  const stockValue = data.products.reduce((sum, item) => sum + Number(item.stock) * Number(item.cost), 0);
  const visibleOrders = data.orders.filter((order) => (!['purchase', 'sales'].includes(active) || order.type === (active === 'purchase' ? 'purchase' : 'sale')) && (!from || order.date >= from) && (!to || order.date <= to) && `${order.number} ${order.party_name} ${order.items?.map((item) => item.product_name).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const notify = (message) => { setToast(message); setError(null); };
  const reportError = (cause) => { setError({ page: active, message: cause.message }); setToast(''); };
  async function signIn(mode, username, password) {
    setLoginError('');
    try {
      const auth = await api(`/api/${mode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify({ username, password }) });
      await refresh();
      setAuthUser(auth.username);
      setAuthenticated(true);
    }
    catch (cause) { setLoginError(cause.message); }
  }
  async function signOut() {
    try { await api('/api/logout', { method: 'POST' }); } finally { setAuthenticated(false); setAuthUser(''); setSuspendedOrders([]); setCategoryFilter(''); setData({ settings: {}, products: [], categories: [], units: [], suppliers: [], customers: [], orders: [], totals: [] }); }
  }

  async function saveEntity(entity, form) {
    const body = Object.fromEntries(new FormData(form).entries());
    if (entity === 'products') {
      for (const key of ['cost', 'price', 'stock', 'threshold', 'category_id']) body[key] = Number(body[key] || 0);
    }
    const url = modal.record ? `/api/${entity}/${modal.record.id}` : `/api/${entity}`;
    const saved = await api(url, { method: modal.record ? 'PUT' : 'POST', body: JSON.stringify(body) });
    const returnTo = modal.returnTo
      ? entity === 'products'
        ? {
          ...modal.returnTo,
          lines: modal.returnTo.lines.map((line, index) => index === modal.returnTo.productLineIndex
            ? { ...line, productId: saved.id, unitPrice: modal.returnTo.type === 'purchase' ? saved.cost : saved.price }
            : line),
        }
        : { ...modal.returnTo, partyId: String(saved.id) }
      : null;
    if (!modal.record && focusedParty?.entity === entity) setFocusedParty(null);
    setModal(returnTo); await refresh(); notify(modal.record ? '信息已更新' : '信息已保存');
  }
  async function saveCategory(name) {
    try {
      const category = await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
      setData((current) => ({ ...current, categories: [...current.categories, category].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) }));
      notify(`分类“${category.name}”已添加`);
      return category;
    } catch (cause) {
      reportError(cause);
      return null;
    }
  }
  async function renameCategory(category, name) {
    try {
      const updated = await api(`/api/categories/${category.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
      setData((current) => ({ ...current, categories: current.categories.map((item) => item.id === updated.id ? updated : item).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) }));
      notify('分类名称已更新');
      return true;
    } catch (cause) { reportError(cause); return false; }
  }
  async function deleteCategory(category) {
    if (!window.confirm(`删除分类“${category.name}”？`)) return;
    try {
      await api(`/api/categories/${category.id}`, { method: 'DELETE' });
      if (categoryFilter === String(category.id)) setCategoryFilter('');
      await refresh();
      notify('分类已删除');
    } catch (cause) { reportError(cause); }
  }
  async function removeEntity(entity, row) {
    if (!window.confirm(`确定删除“${row.name}”吗？`)) return;
    try { await api(`/api/${entity}/${row.id}`, { method: 'DELETE' }); if (focusedParty?.entity === entity && focusedParty.id === row.id) setFocusedParty(null); await refresh(); notify('已删除'); }
    catch (cause) { reportError(cause); }
  }
  async function saveUnit(event) {
    event.preventDefault();
    try { await api('/api/units', { method: 'POST', body: JSON.stringify({ name: new FormData(event.currentTarget).get('name') }) }); await refresh(); notify('计量单位已添加'); }
    catch (cause) { reportError(cause); }
  }
  async function saveOrder(event, lines, paymentVoucher, removeVoucher) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const body = { type: modal.type, partyId: Number(values.get('partyId')), date: values.get('date'), note: values.get('note'), paymentMethod: values.get('paymentMethod'), paidAmount: Number(values.get('paidAmount') || 0), items: lines.map((line) => ({ productId: Number(line.productId), quantity: Number(line.quantity), unitPrice: Number(line.unitPrice) })) };
    if (modal.suspendedId) { body.suspendedId = modal.suspendedId; body.suspendedVersion = modal.suspendedVersion; }
    if (paymentVoucher) body.paymentVoucher = paymentVoucher;
    else if (removeVoucher) body.paymentVoucher = null;
    const order = await api(modal.order ? `/api/orders/${modal.order.id}` : '/api/orders', { method: modal.order ? 'PUT' : 'POST', body: JSON.stringify(body) });
    setModal(null);
    if (modal.suspendedId) setSuspendedOrders((current) => current.filter((draft) => draft.suspendedId !== modal.suspendedId));
    try { await refresh(); notify(`单据 ${order.number} ${modal.order?.reversed ? '已更新并重新生效' : modal.order ? '已更新' : '已保存，待审核生效'}`); }
    catch (cause) { reportError(cause); }
  }
  async function auditOrder(order) {
    try { const result = await api(`/api/orders/${order.id}/audit`, { method: 'POST' }); await refresh(); notify(`单据 ${result.number} 已审核，库存及收付款已生效`); }
    catch (cause) { reportError(cause); }
  }
  async function suspendOrder(draft) {
    const saved = await api('/api/suspended-orders', { method: 'POST', body: JSON.stringify(draft) });
    setSuspendedOrders((current) => [saved, ...current.filter((item) => item.suspendedId !== saved.suspendedId)]);
    setModal(null);
    notify('订单已挂起，可稍后取单继续操作');
  }
  async function cancelSuspendedOrder(suspendedId) {
    const draft = modal?.suspendedId === suspendedId ? modal : suspendedOrders.find((item) => item.suspendedId === suspendedId);
    const activeDraft = modal?.kind === 'order' && modal.suspendedId === suspendedId;
    if (!draft || !window.confirm(`确定${activeDraft ? '取消已取出的' : '取消这张'}${draft.type === 'purchase' ? '采购' : '销售'}挂单吗？`)) return;
    await api(`/api/suspended-orders/${encodeURIComponent(suspendedId)}`, { method: 'DELETE', body: JSON.stringify({ version: draft.suspendedVersion }) });
    setSuspendedOrders((current) => current.filter((item) => item.suspendedId !== suspendedId));
    if (modal?.kind === 'order' && modal.suspendedId === suspendedId) setModal(null);
    notify('挂单已取消');
  }
  async function openSuspendedOrders() {
    try { await refresh(); setModal({ kind: 'suspendedOrders' }); }
    catch (cause) { reportError(cause); }
  }
  async function resumeOrder(draft) {
    const refreshed = await refresh();
    const latest = refreshed.suspendedOrders.find((item) => item.suspendedId === draft.suspendedId);
    if (!latest) throw new Error('挂单已被其他设备保存或取消，请刷新挂单列表');
    setModal(latest);
  }
  async function saveReceipt(customer, body) {
    const receipt = await api(`/api/customers/${customer.id}/receivables`, { method: 'POST', body: JSON.stringify(body) });
    setModal(null);
    try { await refresh(); notify(`收款 ${money(receipt.total)} 已登记`); }
    catch (cause) { reportError(cause); }
  }
  async function saveSupplierPayment(supplier, body) {
    const payment = await api(`/api/suppliers/${supplier.id}/payables`, { method: 'POST', body: JSON.stringify(body) });
    setModal(null);
    try { await refresh(); notify(`付款 ${money(payment.total)} 已登记`); }
    catch (cause) { reportError(cause); }
  }
  async function reverseOrder(order) {
    const typeLabel = order.type === 'purchase' ? '采购' : '销售';
    if (!window.confirm(`确定反审核${typeLabel}订单 ${order.number}？订单将恢复为可编辑的未审核状态，并撤销库存及订单内收付款。`)) return;
    try {
      const result = await api(`/api/orders/${order.id}/reverse`, { method: 'POST' });
      await refresh();
      notify(`${result.number} 已反审核，订单已恢复为可编辑状态`);
    } catch (cause) { reportError(cause); }
  }
  async function deleteOrder(order) {
    if (!window.confirm(`确定删除${order.reversed ? '已反审核' : '未审核'}的订单 ${order.number}？删除后无法恢复。`)) return;
    try {
      const result = await api(`/api/orders/${order.id}`, { method: 'DELETE' });
      await refresh();
      notify(`${result.number} 已删除`);
    } catch (cause) { reportError(cause); }
  }
  async function saveStocktake(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const categoryId = Number(form.get('categoryId'));
    const categoryProducts = data.products.filter((product) => product.category_id === categoryId);
    if (!data.categories.some((category) => category.id === categoryId) || !categoryProducts.length) {
      reportError(new Error('请选择包含商品的分类再进行盘点'));
      return;
    }
    const items = categoryProducts.map((product) => ({ productId: product.id, counted: Number(form.get(`count-${product.id}`)) }));
    try {
      const result = await api('/api/stocktakes', { method: 'POST', body: JSON.stringify({ date: form.get('date'), categoryId, note: form.get('note'), items }) });
      const refreshed = await refresh();
      const mismatchedProduct = items.find((item) => Number(refreshed.products.find((product) => product.id === item.productId)?.stock) !== item.counted);
      setModal(null);
      if (mismatchedProduct) throw new Error('盘点单已保存，但库存数量未能同步，请刷新页面并检查库存');
      notify(`盘点单 ${result.number} 已保存，库存已更新`);
    }
    catch (cause) { reportError(cause); }
  }
  async function saveSettings(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try { const settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) }); setData((current) => ({ ...current, settings })); notify('系统设置已保存'); }
    catch (cause) { reportError(cause); }
  }
  async function updateProduct(product, patch) {
    const alertStateChange = typeof patch.stock_alert_enabled === 'boolean';
    if (alertStateChange) {
      setData((current) => ({
        ...current,
        products: current.products.map((item) => String(item.id) === String(product.id) ? { ...item, ...patch } : item),
      }));
    }
    try {
      const updatedProduct = await api(`/api/products/${product.id}`, { method: 'PUT', body: JSON.stringify({ ...product, ...patch }) });
      if (patch.stock_alert_enabled !== undefined && !Object.hasOwn(updatedProduct, 'stock_alert_enabled')) {
        throw new Error('当前运行的服务端未返回库存预警状态，请重启服务端后再试。');
      }
      if (patch.stock_alert_enabled !== undefined && isStockAlertEnabled(updatedProduct.stock_alert_enabled) !== patch.stock_alert_enabled) {
        throw new Error(`服务器保存库存预警状态失败（返回：${String(updatedProduct.stock_alert_enabled)}），请重启服务端后再试。`);
      }
      setData((current) => ({
        ...current,
        products: current.products.map((item) => String(item.id) === String(updatedProduct.id) ? updatedProduct : item),
      }));
      notify(patch.stock_alert_enabled === false ? '库存预警已解除' : patch.stock_alert_enabled === true ? '库存预警已恢复' : '商品信息已更新');
    }
    catch (cause) {
      if (alertStateChange) {
        try { await refresh(); }
        catch (refreshError) { reportError(new Error(`${cause.message}；刷新数据失败：${refreshError.message}`)); return; }
      }
      reportError(cause);
    }
  }
  async function restoreBackup(file) {
    if (!file) return;
    if (!window.confirm('恢复备份会覆盖当前全部业务数据，确认继续吗？')) return;
    try { const backup = JSON.parse(await file.text()); await api('/api/restore', { method: 'POST', body: JSON.stringify(backup) }); await refresh(); notify('备份恢复完成'); }
    catch (cause) { reportError(cause); }
  }
  function openOrder(type) {
    const product = data.products[0];
    setModal({ kind: 'order', type, lines: [{ productId: product?.id ?? '', quantity: 1, unitPrice: product ? (type === 'purchase' ? product.cost : product.price) : 0 }] });
  }
  function openStocktakeDetail(stocktake) {
    setModal({ kind: 'stocktakeDetailLoading', stocktake });
    api(`/api/stocktakes/${stocktake.id}`).then((detail) => {
      setModal({ kind: 'stocktakeDetail', stocktake: detail });
    }).catch((cause) => {
      setModal(null);
      reportError(cause);
    });
  }
  function exportRows(rows, filename, headers, values) {
    const csv = [headers, ...rows.map(values)].map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
  }
  function exportOrders() { exportRows(visibleOrders, `${active === 'purchase' ? '采购' : '销售'}订单-${from}-${to}.csv`, ['单据编号','日期','往来单位','商品','数量','单位','单价','金额','已收/已付','未结账','收/付款方式','备注'], (order) => order.items.flatMap((line) => [order.number, order.date, order.party_name, line.product_name, line.quantity, line.unit, line.unit_price, line.subtotal, order.paid, order.outstanding, order.payment_method, order.note])); }
  function exportEntities(entity) {
    const columns = entityColumns[entity];
    exportRows(data[entity], `${labels[entity]}-${today()}.csv`, columns.map(([, label]) => label), (row) => entityExportValues(entity, row, data.categories));
  }
  async function importEntities(entity, file) {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('CSV 文件不能超过 10 MB');
      const rows = parseEntityCsv(await file.text(), entity);
      if (!window.confirm(`将新增 ${rows.length} 条${labels[entity]}资料，不会覆盖现有记录。确定导入吗？`)) return;
      const result = await api(`/api/${entity}/import`, { method: 'POST', body: JSON.stringify({ rows }) });
      if (focusedParty?.entity === entity) setFocusedParty(null);
      try { await refresh(); notify(`成功导入 ${result.imported} 条资料`); }
      catch (cause) { throw new Error(`资料已导入，但刷新失败：${cause.message}`); }
    } catch (cause) { reportError(cause); }
  }
  function printCurrentOrder(order) { setPreviewOrder(order); }
  async function openOrderParty(order) {
    const entity = order.type === 'purchase' ? 'suppliers' : 'customers';
    try {
      const current = await refresh();
      if (!current[entity].some((party) => party.id === order.party_id)) throw new Error(`该订单对应的${entity === 'suppliers' ? '供应商' : '客户'}已不存在`);
      setFocusedParty({ entity, id: order.party_id });
      setQuery('');
      setActive(entity);
    } catch (cause) { reportError(cause); }
  }

  if (authLoading) return <div className="auth-loading"><span className="loader" />正在验证本地账套…</div>;
  if (!authenticated) return <LoginPage onLogin={signIn} error={loginError} systemName={currentTitle} />;

  return <div className={`app-shell ${previewOrder ? 'print-order-mode' : ''}`}>
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><span>J</span><i /></div><div className="brand-name"><b>{currentTitle}</b><small>JXC · BUSINESS SYSTEM</small></div><button className="icon-button mobile-close" aria-label="关闭菜单" onClick={() => setMobileMenu(false)}><X size={18} /></button></div>
      <div className="company-chip"><div className="company-mark"><Building2 size={16} /></div><div><b>{authUser} 的独立账套</b><span>仅此账号可访问</span></div><ChevronDown size={14} /></div>
      <nav className="side-nav" aria-label="主导航">{nav.map((group) => <div className="nav-group" key={group.title}><span className="nav-label">{group.title}</span>{group.items.map(([id, label, Icon]) => <button key={id} className={`nav-link ${active === id ? 'active' : ''}`} onClick={() => { setActive(id); setQuery(''); if (id === 'products') setCategoryFilter(''); setFocusedParty(null); setMobileMenu(false); }}><Icon size={16} strokeWidth={1.8} /><span>{label}</span>{id === 'stock' && <em>{lowStock.length}</em>}</button>)}</div>)}</nav>
      <div className="sidebar-bottom"><div className="local-card"><ShieldCheck size={17} /><span><b>账号独立数据</b><small>SQLite · 自动保存</small></span></div><button className="profile" onClick={signOut} title="退出登录"><div className="profile-avatar">{authUser.slice(0, 1).toUpperCase()}</div><span><b>{authUser}</b><small>退出登录</small></span><CircleHelp size={16} /></button></div>
    </aside>
    {mobileMenu && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setMobileMenu(false)} />}
    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="打开菜单" onClick={() => setMobileMenu(true)}><Menu size={19} /></button><span>{currentTitle}</span><b>/</b><strong>{labels[active]}</strong></div><div className="top-right"><div className="date-chip"><CalendarDays size={14} />{new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}</div><button type="button" className="button-secondary suspended-orders-button" onClick={openSuspendedOrders}><PauseCircle size={14} />挂单{ suspendedOrders.length > 0 ? ` (${suspendedOrders.length})` : ''}</button><button type="button" className="button-secondary top-logout" onClick={signOut}><LogOut size={14} />退出登录</button><span className="online-dot" title="服务运行中" /></div></header>
      <div className="page-content">
        <section className="page-heading"><div><div className="eyebrow"><span className="live-dot" />进销存管理 · 实时数据</div><h1>{active === 'dashboard' ? '经营总览' : labels[active]}</h1><p>{active === 'dashboard' ? '采购、销售与库存，尽在掌握。' : descriptions[active]}</p></div><div className="heading-actions">{active === 'purchase' && <button className="button-primary" onClick={() => openOrder('purchase')}><Plus size={16} />新建采购单</button>}{active === 'sales' && <button className="button-primary" onClick={() => openOrder('sale')}><Plus size={16} />新建销售单</button>}{active === 'stocktakes' && <button className="button-primary" onClick={() => setModal({ kind: 'stocktake' })} disabled={!data.products.length}><Plus size={16} />开始盘点</button>}</div></section>
        {error?.page === active && <div className="notice-error"><AlertTriangle size={16} />{error.message}<button onClick={() => setError(null)} aria-label="关闭提示"><X size={15} /></button></div>}
        {loading ? <div className="loading-state"><span className="loader" />正在读取本地账套…</div> : <>
          {active === 'dashboard' && <Dashboard data={data} lowStock={lowStock} stockValue={stockValue} setActive={setActive} openOrder={openOrder} onPrintOrder={printCurrentOrder} onViewReceivables={() => setActive('receivables')} onViewStockAlerts={() => setActive('stockAlerts')} />}
          {active === 'receivables' && <ReceivableCustomers rows={data.customers.filter((customer) => Number(customer.outstanding) > 0)} onBack={() => setActive('dashboard')} onSettle={(customer) => setModal({ kind: 'receivable', customer })} />}
          {active === 'stockAlerts' && <StockAlerts products={lowStock} onEdit={(product, patch) => updateProduct(product, patch)} />}
          {active === 'products' && <EntityTable entity="products" rows={data.products} query={query} setQuery={setQuery} categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter} onExport={() => exportEntities('products')} onImport={(file) => importEntities('products', file)} onAdd={(categoryId) => setModal({ kind: 'entity', entity: 'products', categoryId })} onEdit={(row) => setModal({ kind: 'entity', entity: 'products', record: row })} onDelete={(row) => removeEntity('products', row)} onChangeCategory={(row, patch) => updateProduct(row, patch)} units={data.units} categories={data.categories} />}
          {active === 'categories' && <Categories categories={data.categories} products={data.products} onAdd={saveCategory} onRename={renameCategory} onDelete={deleteCategory} onViewProducts={(category) => { setCategoryFilter(String(category.id)); setQuery(''); setActive('products'); }} />}
          {active === 'suppliers' && <EntityTable entity="suppliers" rows={focusedParty?.entity === 'suppliers' ? data.suppliers.filter((party) => party.id === focusedParty.id) : data.suppliers} query={query} setQuery={(value) => { setFocusedParty(null); setQuery(value); }} focused={focusedParty?.entity === 'suppliers'} onShowAll={() => setFocusedParty(null)} onExport={() => exportEntities('suppliers')} onImport={(file) => importEntities('suppliers', file)} onAdd={() => setModal({ kind: 'entity', entity: 'suppliers' })} onEdit={(row) => setModal({ kind: 'entity', entity: 'suppliers', record: row })} onDelete={(row) => removeEntity('suppliers', row)} onSettle={(supplier) => setModal({ kind: 'payable', supplier })} onViewOrders={(supplier) => setModal({ kind: 'partyOrders', party: supplier, orderType: 'purchase' })} />}
          {active === 'customers' && <EntityTable entity="customers" rows={focusedParty?.entity === 'customers' ? data.customers.filter((party) => party.id === focusedParty.id) : data.customers} query={query} setQuery={(value) => { setFocusedParty(null); setQuery(value); }} focused={focusedParty?.entity === 'customers'} onShowAll={() => setFocusedParty(null)} onExport={() => exportEntities('customers')} onImport={(file) => importEntities('customers', file)} onAdd={() => setModal({ kind: 'entity', entity: 'customers' })} onEdit={(row) => setModal({ kind: 'entity', entity: 'customers', record: row })} onDelete={(row) => removeEntity('customers', row)} onSettle={(customer) => setModal({ kind: 'receivable', customer })} onViewOrders={(customer) => setModal({ kind: 'partyOrders', party: customer, orderType: 'sale' })} />}
          {active === 'units' && <Units rows={data.units} onAdd={saveUnit} onDelete={async (row) => { if (window.confirm(`删除单位“${row.name}”？`)) { try { await api(`/api/units/${row.id}`, { method: 'DELETE' }); await refresh(); notify('单位已删除'); } catch (cause) { reportError(cause); } } }} />}
          {(active === 'purchase' || active === 'sales') && <OrderList type={active} rows={visibleOrders} parties={active === 'purchase' ? data.suppliers : data.customers} onViewParty={openOrderParty} from={from} to={to} setFrom={setFrom} setTo={setTo} query={query} setQuery={setQuery} onExport={exportOrders} onPrint={() => window.print()} onPrintOrder={printCurrentOrder} onEditOrder={(order) => setModal({ kind: 'order', type: order.type, order, lines: order.items.map((item) => ({ productId: item.product_id, quantity: item.quantity, unitPrice: item.unit_price })) })} onAudit={auditOrder} onReverseOrder={reverseOrder} onDeleteOrder={deleteOrder} onSettle={(order) => {
            const customer = data.customers.find((item) => item.id === order.party_id);
            const supplier = data.suppliers.find((item) => item.id === order.party_id);
            if (active === 'purchase' && supplier) setModal({ kind: 'payable', supplier });
            else if (active === 'sales' && customer) setModal({ kind: 'receivable', customer });
            else reportError(new Error(`未找到该${active === 'purchase' ? '采购单对应的供应商' : '销售单对应的客户'}`));
          }} />}
          {active === 'stock' && <StockTable products={searched(data.products, query)} query={query} setQuery={setQuery} lowStock={lowStock} onEdit={(product, patch) => updateProduct(product, patch)} onExport={() => exportRows(data.products, `库存清单-${today()}.csv`, ['商品编码','商品名称','规格','单位','库存数量','采购价','销售价','库存金额'], (p) => [p.sku,p.name,p.specification,p.unit,p.stock,p.cost,p.price,Number(p.stock)*Number(p.cost)])} onPrint={() => window.print()} onStocktake={() => setModal({ kind: 'stocktake' })} />}
          {active === 'stocktakes' && <StocktakeList rows={stocktakes} onPrint={() => window.print()} onView={openStocktakeDetail} />}
          {active === 'settings' && <SettingsPage settings={data.settings} onSave={saveSettings} onRestore={restoreBackup} />}
        </>}
      </div>
      <footer className="app-footer"><span>{currentTitle} <i>·</i> 让每一笔进出都有数</span><span>数据保存在本机 <i className="sync-dot">●</i></span></footer>
    </main>
    {modal && <Modal modal={modal} data={data} suspendedOrders={suspendedOrders} onClose={(returnTo) => setModal(returnTo || null)} onSaveEntity={saveEntity} onSaveOrder={saveOrder} onSaveStocktake={saveStocktake} onSaveReceipt={saveReceipt} onSaveSupplierPayment={saveSupplierPayment} onSuspendOrder={suspendOrder} onResumeOrder={resumeOrder} onCancelSuspendedOrder={cancelSuspendedOrder} onAddParty={(entity, returnTo) => setModal({ kind: 'entity', entity, returnTo })} onPrintOrder={printCurrentOrder} onError={reportError} />}
    {previewOrder && <PrintableOrder order={previewOrder} title={data.settings[previewOrder.type === 'purchase' ? 'purchaseTemplate' : 'salesTemplate']} systemName={currentTitle} onClose={() => setPreviewOrder(null)} />}
    {toast && <div className="toast"><span><Check size={14} /></span>{toast}</div>}
  </div>;
}

function searched(rows, query) { return rows.filter((row) => Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(query.toLowerCase()))); }

function LoginPage({ onLogin, error, systemName }) {
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('login');
  const [formError, setFormError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setFormError('');
    const form = event.currentTarget;
    const values = new FormData(form);
    const username = values.get('username');
    const password = values.get('password');
    if (mode === 'register' && password !== values.get('confirmPassword')) {
      setFormError('两次输入的密码不一致');
      setBusy(false);
      return;
    }
    try { await onLogin(mode, username, password); }
    finally { setBusy(false); }
  }
  const registering = mode === 'register';
  return <main className="auth-screen"><section className="auth-story"><div className="auth-brand"><span className="auth-mark">J</span><span>{systemName}</span></div><div className="auth-message"><span className="section-kicker">INVENTORY · PURCHASE · SALES</span><h1>把每一次<br />进出，都记清。</h1><p>商品、往来单位、库存与单据，<br />在一个本地账套里有序流转。</p></div><div className="auth-foot"><ShieldCheck size={14} />每个账号拥有独立业务数据</div><div className="auth-lines"><i /><i /><i /><i /></div></section><section className="auth-form-side"><form className="auth-form" onSubmit={submit}><div className="auth-form-icon"><Boxes size={20} /></div><span className="section-kicker">{registering ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</span><h2>{registering ? '注册新账号' : '登录管理账套'}</h2><p>{registering ? '注册后将创建仅你可访问的独立账套' : '使用账号名和密码登录你的业务账套'}</p><label>账号名<input autoFocus type="text" name="username" placeholder="3-32 位字母、数字、下划线或连字符" autoComplete="username" minLength="3" maxLength="32" pattern="[A-Za-z0-9_-]{3,32}" required /></label><label>密码<input type="password" name="password" placeholder={registering ? '至少 8 位，且包含字母和数字' : '输入密码'} autoComplete={registering ? 'new-password' : 'current-password'} minLength={registering ? 8 : undefined} maxLength="64" pattern={registering ? '(?=.*[A-Za-z])(?=.*\\d)[A-Za-z\\d]{8,64}' : undefined} required /></label>{!registering && <button className="auth-mode-toggle" type="button" onClick={() => { setMode('register'); setFormError(''); }}>还没有注册？自主注册</button>}{registering && <label>确认密码<input type="password" name="confirmPassword" placeholder="再次输入密码" autoComplete="new-password" minLength="8" maxLength="64" required /></label>}{registering && <small className="auth-hint">密码需为 8-64 位英文字母与数字组合</small>}{(formError || error) && <div className="auth-error"><AlertTriangle size={14} />{formError || error}</div>}{registering && <button className="button-primary" disabled={busy}>{busy ? '正在创建…' : '注册并创建账套'}<ChevronRight size={15} /></button>}{!registering && <button className="button-primary" disabled={busy}>{busy ? '正在登录…' : '安全登录'}<ChevronRight size={15} /></button>}{registering && <button className="auth-mode-toggle" type="button" onClick={() => { setMode('login'); setFormError(''); }}>已有账号？返回登录</button>}<small className="auth-security"><ShieldCheck size={13} />HttpOnly 会话 · 每个账号数据相互隔离</small></form></section></main>;
}

function Dashboard({ data, lowStock, stockValue, setActive, openOrder, onPrintOrder, onViewReceivables, onViewStockAlerts }) {
  const month = today().slice(0, 7);
  const monthOrders = data.orders.filter((order) => order.date.startsWith(month));
  const sales = monthOrders.filter((order) => order.type === 'sale').reduce((sum, order) => sum + order.total, 0);
  const purchases = monthOrders.filter((order) => order.type === 'purchase').reduce((sum, order) => sum + order.total, 0);
  const receivables = data.customers.reduce((sum, customer) => sum + Number(customer.outstanding || 0), 0);
  const metrics = [['本月销售额', money(sales), ArrowUpFromLine, 'green'], ['本月采购额', money(purchases), ArrowDownToLine, 'orange'], ['应收账款', money(receivables), Users, 'purple', onViewReceivables], ['当前库存成本', money(stockValue), Boxes, 'blue'], ['库存预警', `${lowStock.length} 项`, AlertTriangle, 'red', onViewStockAlerts]];
  return <>
    <section className="metric-grid">{metrics.map(([label, value, Icon, color, onClick]) => {
      const content = <><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={16} /></span></div><b className="metric-value">{value}</b><div className="metric-foot">{onClick ? (label === '应收账款' ? '点击查看未收款客户' : '点击查看告警商品并处理') : label === '当前库存成本' ? `${data.products.length} 个商品` : `本月 ${monthOrders.filter((order) => order.type === (label === '本月销售额' ? 'sale' : 'purchase')).length} 笔单据`}</div></>;
      return onClick
        ? <button type="button" className={`metric-card metric-card-link ${color}`} key={label} onClick={onClick}>{content}</button>
        : <article className={`metric-card ${color}`} key={label}>{content}</article>;
    })}</section>
    <section className="overview-grid"><article className="panel overview-panel"><div className="panel-heading"><div><span className="section-kicker">BUSINESS SNAPSHOT</span><h2>业务概况</h2></div><span className="period-label">{month}</span></div><div className="overview-numbers"><div><span>商品档案</span><b>{data.products.length}<small> 项</small></b></div><div><span>供应商</span><b>{data.suppliers.length}<small> 家</small></b></div><div><span>常用客户</span><b>{data.customers.length}<small> 位</small></b></div><div><span>业务单据</span><b>{monthOrders.length}<small> 张</small></b></div></div><div className="overview-bottom"><div className="overview-decoration"><div className="deco-ring ring-one" /><div className="deco-ring ring-two" /><div className="deco-core"><Boxes size={25} /></div></div><div className="overview-caption"><span>库存周转的每一步</span><b>都有迹可循</b><small>采购入库 · 销售出库 · 盘点调整</small></div></div></article>
      <article className="panel quick-panel"><div className="panel-heading"><div><span className="section-kicker">QUICK ACTIONS</span><h2>快捷操作</h2></div></div><div className="quick-actions"><button onClick={() => openOrder('purchase')}><span className="quick-icon purchase-icon"><ArrowDownToLine size={17} /></span><span><b>采购入库</b><small>登记供应商到货</small></span><ChevronRight size={15} /></button><button onClick={() => openOrder('sale')}><span className="quick-icon sales-icon"><ArrowUpFromLine size={17} /></span><span><b>销售出库</b><small>创建客户销售单</small></span><ChevronRight size={15} /></button><button onClick={() => setActive('stocktakes')}><span className="quick-icon stock-icon"><ClipboardCheck size={17} /></span><span><b>库存盘点</b><small>按实盘数量校准</small></span><ChevronRight size={15} /></button></div><div className="quick-foot"><ShieldCheck size={14} />每笔业务自动记录库存变化</div></article></section>
    <section className="lower-grid"><article className="panel recent-panel"><div className="panel-heading"><div><span className="section-kicker">LATEST ORDERS</span><h2>最近单据</h2></div><button className="text-link" onClick={() => setActive('purchase')}>全部单据 <ChevronRight size={13} /></button></div><OrderRows rows={data.orders.slice(0, 5)} compact onOpenOrder={onPrintOrder} /></article><article className="panel alert-panel"><div className="panel-heading"><div><span className="section-kicker">INVENTORY ALERT</span><h2>库存预警 <em className="count-badge">{lowStock.length}</em></h2></div><button className="text-link" onClick={() => setActive('stock')}>查看库存 <ChevronRight size={13} /></button></div>{lowStock.length ? lowStock.slice(0, 4).map((product) => <div className="alert-row" key={product.id}><span className="product-avatar">{product.name.slice(0, 1)}</span><span className="alert-copy"><b>{product.name}</b><small>{product.sku} · 安全库存 {product.threshold}</small></span><strong>{product.stock}<small> {product.unit}</small></strong></div>) : <div className="all-clear"><Check size={18} />所有商品库存充足</div>}</article></section>
  </>;
}

function ReceivableCustomers({ rows, onBack, onSettle }) {
  const total = rows.reduce((sum, customer) => sum + Number(customer.outstanding), 0);
  return <section className="receivables-page">
    <div className="receivables-toolbar"><div className="inline-note"><Users size={15} />共 {rows.length} 位客户有未收款项</div><button className="button-secondary" onClick={onBack}><ChevronRight size={14} className="back-chevron" />返回经营总览</button></div>
    <div className="order-summary receivable-summary"><div><span>应收账款合计</span><b>{money(total)}</b></div><div><span>未收款客户</span><b>{rows.length}<small> 位</small></b></div></div>
    <div className="panel table-panel"><div className="table-scroll"><table className="data-table wide-table"><thead><tr><th>客户名称</th><th>联系人</th><th>联系电话</th><th>邮箱</th><th>地址</th><th>未收款金额</th><th>操作</th></tr></thead><tbody>{rows.map((customer) => <tr key={customer.id}><td><button type="button" className="order-number-link" onClick={() => onSettle(customer)}>{customer.name}</button></td><td>{customer.contact || '—'}</td><td>{customer.phone || '—'}</td><td>{customer.email || '—'}</td><td className="address-cell">{customer.address || '—'}</td><td><b className="balance-due">{money(customer.outstanding)}</b></td><td><button type="button" className="button-secondary" onClick={() => onSettle(customer)}><CreditCard size={14} />处理收款</button></td></tr>)}</tbody></table>{rows.length === 0 && <EmptyState text="当前没有未收款客户" />}</div><div className="table-meta">仅显示应收账款大于零的客户，点击客户名称可处理收款</div></div>
  </section>;
}

function StockAlerts({ products, onEdit }) {
  return <section className="panel table-panel stock-alerts-panel">
    <div className="table-scroll"><table className="data-table wide-table"><thead><tr><th>商品信息</th><th>编码</th><th>规格</th><th>当前库存</th><th>安全库存</th><th>告警状态</th><th>操作</th></tr></thead><tbody>{products.map((product) => <tr key={product.id}><td><b className="main-cell">{product.name}</b></td><td className="mono">{product.sku}</td><td>{product.specification || '—'}</td><td><b className="qty-low">{product.stock}</b> {product.unit}</td><td>{product.threshold} {product.unit}</td><td><span className="stock-badge is-low"><i />库存偏低</span></td><td><button type="button" className="stock-alert-toggle" onClick={() => onEdit(product, { stock_alert_enabled: false })}>解除预警</button></td></tr>)}</tbody></table>{products.length === 0 && <EmptyState text="当前没有库存告警商品" />}</div><div className="table-meta">共 {products.length} 个库存告警商品<span>解除后该商品将不再触发库存告警</span></div>
  </section>;
}

function OrderRows({ rows, compact = false, onOpenOrder }) {
  if (!rows.length) return <EmptyState text="暂无订单数据" />;
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>流水号</th><th>日期</th><th>往来单位</th><th>业务类型</th><th className="right">金额</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td className="mono">{row.number}</td><td>{row.date}</td><td>{row.party_name}</td><td>{onOpenOrder ? <button type="button" className={`type-tag order-type-link ${row.type}`} onClick={() => onOpenOrder(row)}>{row.type === 'purchase' ? '采购入库' : '销售出库'}</button> : <span className={`type-tag ${row.type}`}>{row.type === 'purchase' ? '采购入库' : '销售出库'}</span>}</td><td className="right amount">{money(row.total)}</td></tr>)}</tbody></table></div>;
}

function EntityTable({ entity, rows, query, setQuery, categoryFilter = '', setCategoryFilter, focused, onShowAll, onAdd, onEdit, onDelete, onSettle, onViewOrders, onImport, onExport, units = [], categories = [], onChangeCategory }) {
  const product = entity === 'products';
  const contactLabel = entity === 'suppliers' ? '供应商' : '客户';
  const balanceLabel = entity === 'suppliers' ? '待付款金额' : '待收款金额';
  const searchRows = searched(rows, query);
  const visibleRows = product && categoryFilter ? searchRows.filter((row) => String(row.category_id) === categoryFilter) : searchRows;
  const productActions = <><select aria-label="商品分类筛选" className="category-filter" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">全部分类</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button className="button-primary" onClick={() => onAdd(categoryFilter ? Number(categoryFilter) : undefined)}><Plus size={15} />新增商品</button></>;
  return <>
    <Toolbar query={query} setQuery={setQuery} placeholder={`搜索${product ? '商品名称、编码或规格' : `${contactLabel}名称、电话`}`} action={<>{focused && <button type="button" className="button-secondary" onClick={onShowAll}>查看全部{contactLabel}</button>}<label className="button-secondary"><Upload size={14} />导入<input type="file" accept=".csv,text/csv" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; onImport(file); }} /></label><button type="button" className="button-secondary" onClick={onExport}><Download size={14} />导出</button>{product ? productActions : <button className="button-primary" onClick={onAdd}><Plus size={15} />新增{contactLabel}</button>}</>} />
    <div className="panel table-panel"><div className="table-scroll"><table className="data-table wide-table"><thead><tr>{product ? <><th>商品名称</th><th className="product-category-column">商品分类</th><th>商品编码</th><th>规格</th><th>单位</th><th>采购价</th><th>销售价</th><th>库存</th><th>操作</th></> : <><th>{contactLabel}名称</th><th>联系人</th><th>联系电话</th><th>邮箱</th><th>地址</th><th>备注</th><th>{balanceLabel}</th><th>操作</th></>}</tr></thead><tbody>{visibleRows.map((row) => <tr key={row.id}>{product ? <><td><b className="main-cell">{row.name}</b></td><td className="product-category-column"><select className="product-category-select" aria-label={`${row.name}商品分类`} value={row.category_id} onChange={(event) => onChangeCategory(row, { category_id: Number(event.target.value) })}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></td><td className="mono">{row.sku}</td><td>{row.specification || '—'}</td><td>{row.unit}</td><td>{money(row.cost)}</td><td>{money(row.price)}</td><td><b className={Number(row.stock) <= Number(row.threshold) ? 'qty-low' : ''}>{row.stock}</b> {row.unit}</td></> : <><td><button type="button" className="order-number-link" title={`查看${contactLabel}订单`} onClick={() => onViewOrders(row)}>{row.name}</button></td><td>{row.contact || '—'}</td><td>{row.phone || '—'}</td><td>{row.email || '—'}</td><td className="address-cell">{row.address || '—'}</td><td>{row.note || '—'}</td><td>{entity === 'suppliers' && Number(row.outstanding) > 0 ? <button type="button" className="settlement-amount" onClick={() => onSettle(row)}>{money(row.outstanding)}</button> : <b className={Number(row.outstanding) > 0 ? 'balance-due' : 'balance-clear'}>{money(row.outstanding)}</b>}</td></>}<td><div className="row-actions">{entity === 'customers' && Number(row.outstanding) > 0 && <button type="button" className="button-secondary settle-action" onClick={() => onSettle(row)}><CreditCard size={13} />处理收款</button>}{entity === 'suppliers' && Number(row.outstanding) > 0 && <button type="button" className="button-secondary settle-action" onClick={() => onSettle(row)}><CreditCard size={13} />处理付款</button>}<button className="icon-button" title="编辑" aria-label="编辑" onClick={() => onEdit(row)}><Pencil size={14} /></button><button className="icon-button danger-hover" title="删除" aria-label="删除" onClick={() => onDelete(row)}><Trash2 size={14} /></button></div></td></tr>)}</tbody></table>{visibleRows.length === 0 && <EmptyState text={`还没有${product ? '商品档案' : `${contactLabel}资料`}`} />}</div><div className="table-meta">共 {visibleRows.length} 条记录{product && <span>商品单位 {units.length} 种 · 分类 {categories.length} 个</span>}{entity === 'suppliers' && <span>点击待付款金额可处理付款</span>}</div></div>
  </>;
}

function Categories({ categories, products, onAdd, onRename, onDelete, onViewProducts }) {
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  async function add(event) {
    event.preventDefault();
    if (await onAdd(name)) setName('');
  }
  async function rename(event, category) {
    event.preventDefault();
    if (await onRename(category, editingName)) setEditingId(null);
  }
  return <section className="unit-layout">
    <div className="panel unit-panel">
      <div className="panel-heading"><div><span className="section-kicker">CATEGORY MANAGEMENT</span><h2>商品分类</h2></div><span className="unit-total">{categories.length} 个</span></div>
      <form className="unit-add" onSubmit={add}><input aria-label="新分类名称" value={name} onChange={(event) => setName(event.target.value)} maxLength="80" placeholder="输入分类名称" required /><button className="button-primary"><Plus size={15} />新增分类</button></form>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>分类名称</th><th>商品数量</th><th>操作</th></tr></thead><tbody>
        {categories.map((category) => <tr key={category.id}>
          <td>{editingId === category.id ? <form className="category-edit-form" onSubmit={(event) => rename(event, category)}><input aria-label="分类名称" value={editingName} onChange={(event) => setEditingName(event.target.value)} maxLength="80" required autoFocus /><button className="button-secondary" type="submit">保存</button><button className="button-secondary" type="button" onClick={() => setEditingId(null)}>取消</button></form> : <button type="button" className="order-number-link" onClick={() => onViewProducts(category)}>{category.name}</button>}</td>
          <td>{products.filter((product) => product.category_id === category.id).length}</td>
          <td><div className="row-actions">{category.name !== '未分类' && editingId !== category.id && <><button type="button" className="icon-button" aria-label={`修改分类 ${category.name}`} title="修改分类" onClick={() => { setEditingId(category.id); setEditingName(category.name); }}><Pencil size={14} /></button><button type="button" className="icon-button danger-hover" aria-label={`删除分类 ${category.name}`} title="删除分类" onClick={() => onDelete(category)}><Trash2 size={14} /></button></>}</div></td>
        </tr>)}
      </tbody></table></div>
    </div>
    <aside className="unit-tip"><div className="tip-icon"><Tags size={19} /></div><b>商品分类小贴士</b><p>点击分类名称可查看对应商品。修改分类名称不会改变商品和盘点记录的关联；默认分类“未分类”不能修改或删除。</p></aside>
  </section>;
}

function Units({ rows, onAdd, onDelete }) {
  return <section className="unit-layout"><div className="panel unit-panel"><div className="panel-heading"><div><span className="section-kicker">UNIT MANAGEMENT</span><h2>计量单位</h2></div><span className="unit-total">{rows.length} 种</span></div><form className="unit-add" onSubmit={onAdd}><input name="name" placeholder="输入新单位，如：托" maxLength="30" required /><button className="button-primary"><Plus size={15} />添加单位</button></form><div className="unit-list">{rows.map((unit) => <div className="unit-item" key={unit.id}><span className="unit-symbol">{unit.name.slice(0, 1)}</span><b>{unit.name}</b><button className="icon-button danger-hover" onClick={() => onDelete(unit)} aria-label={`删除单位 ${unit.name}`} title="删除"><Trash2 size={14} /></button></div>)}</div></div><aside className="unit-tip"><div className="tip-icon"><Boxes size={19} /></div><b>单位管理小贴士</b><p>商品档案和订单会使用这里维护的单位。已被商品使用的单位不能删除，避免历史记录的计量信息丢失。</p></aside></section>;
}

function OrderList({ type, rows, parties, onViewParty, from, to, setFrom, setTo, query, setQuery, onExport, onPrint, onPrintOrder, onEditOrder, onAudit, onReverseOrder, onDeleteOrder, onSettle }) {
  const purchase = type === 'purchase';
  const quantityTotal = rows.reduce((sum, order) => sum + order.items.reduce((lineSum, item) => lineSum + Number(item.quantity), 0), 0);
  const amountTotal = rows.reduce((sum, order) => sum + order.total, 0);
  return <><section className="order-summary"><div><span>时间段单据</span><b>{rows.length}<small> 张</small></b></div><div><span>{purchase ? '采购数量合计' : '销售数量合计'}</span><b>{quantityTotal}<small> 件</small></b></div><div><span>{purchase ? '采购金额合计' : '销售金额合计'}</span><b>{money(amountTotal)}</b></div></section><div className="toolbar-row"><label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索流水号、往来单位或商品" /></label><div className="toolbar-actions"><label className="date-range"><span>从</span><input aria-label="开始日期" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /><span>至</span><input aria-label="结束日期" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><button className="button-secondary" onClick={onExport}><Download size={14} />导出</button><button className="button-secondary print-action" onClick={onPrint}><Printer size={14} />打印</button></div></div><div className="panel table-panel"><div className="table-scroll"><table className="data-table wide-table"><thead><tr><th>单据流水号</th><th>日期</th><th>{purchase ? '供应商' : '客户'}</th><th>商品明细</th><th>数量</th><th>单据金额</th><th>收/付款情况</th><th>操作</th></tr></thead><tbody>  {rows.map((order) => { const settled = order.audited && order.total > 0 && order.outstanding <= 0; return <tr key={order.id}><td className="mono"><button type="button" className="order-number-link" onClick={() => onPrintOrder(order)}>{order.number}</button></td><td>{order.date}</td><td>{parties.some((party) => party.id === order.party_id) ? <button type="button" className="order-number-link" title={`查看${purchase ? '供应商' : '客户'}资料`} onClick={() => onViewParty(order)}>{order.party_name}</button> : order.party_name}</td><td className="order-products">{order.items.map((item) => <span key={item.id}>{item.product_name} <small>×{item.quantity}{item.unit}</small></span>)}</td><td>{order.items.reduce((sum, item) => sum + Number(item.quantity), 0)}</td><td><b>{money(order.total)}</b></td><td className="settlement-cell">{!order.audited ? <><b className="audit-pending">{order.reversed ? '已反审核' : '未审核'}</b><small>{order.reversed ? '可删除或编辑后重新生效' : '审核后生效'}</small></> : <><b className={settled ? 'balance-clear' : 'balance-due'}>{settled ? '已结清' : order.paid > 0 ? '部分结账' : '未结账'}</b><small>{purchase ? '已付款' : '已收款'} {money(order.paid)}</small>{order.outstanding > 0 ? <button type="button" className="settlement-amount" onClick={() => onSettle(order)}>处理{purchase ? '付款' : '收款'} {money(order.outstanding)}</button> : <small>已结清</small>}<small>{order.payment_method}</small></>}</td><td><div className="row-actions">{!order.audited && <button className="button-secondary audit-button" title="审核订单" onClick={() => onAudit(order)}><Check size={13} />审核</button>}{order.audited && <button className="icon-button danger-hover" title="反审核订单" aria-label="反审核订单" onClick={() => onReverseOrder(order)}><RotateCcw size={14} /></button>}{!order.audited && <button type="button" className="button-secondary danger-hover" title="删除订单" onClick={() => onDeleteOrder(order)}><Trash2 size={14} />删除订单</button>}<button className="icon-button" title="编辑订单" aria-label="编辑订单" onClick={() => onEditOrder(order)}><Pencil size={14} /></button></div></td></tr>; })}</tbody></table>{rows.length === 0 && <EmptyState text="当前时间段内没有单据" />}</div><div className="table-meta">显示 {rows.length} 张单据<span>未审核订单可编辑，审核后才会生效库存与收付款</span></div></div></>;
}

function Toolbar({ query, setQuery, placeholder, action }) {
  return <div className="toolbar-row"><label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} /><kbd>⌘ K</kbd></label><div className="toolbar-actions">{action}</div></div>;
}

function StockTable({ products, query, setQuery, lowStock, onEdit, onExport, onPrint, onStocktake }) {
  const [prices, setPrices] = useState({});
  const [costs, setCosts] = useState({});
  const [thresholds, setThresholds] = useState({});
  return <><div className="stock-callout"><div className="callout-mark"><AlertTriangle size={17} /></div><div><b>{lowStock.length ? `${lowStock.length} 个商品低于安全库存` : '库存状态正常'}</b><span>{lowStock.length ? lowStock.map((item) => item.name).join('、') : '当前启用预警的商品均达到安全库存标准。'}</span></div><button className="button-secondary" onClick={onStocktake}><ClipboardCheck size={14} />库存盘点</button></div><div className="toolbar-row"><label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品名称或编码" /></label><div className="toolbar-actions"><button className="button-secondary" onClick={onExport}><Download size={14} />导出库存</button><button className="button-secondary print-action" onClick={onPrint}><Printer size={14} />打印</button></div></div><div className="panel table-panel"><div className="table-scroll"><table className="data-table wide-table"><thead><tr><th>商品信息</th><th>编码</th><th>规格</th><th>当前库存</th><th>安全库存</th><th>采购价</th><th>销售价格</th><th>库存状态</th></tr></thead><tbody>{products.map((item) => { const alertEnabled = isStockAlertEnabled(item.stock_alert_enabled); const isLow = alertEnabled && Number(item.stock) <= Number(item.threshold); return <tr key={item.id}><td><b className="main-cell">{item.name}</b></td><td className="mono">{item.sku}</td><td>{item.specification || '—'}</td><td><b className={isLow ? 'qty-low' : ''}>{item.stock}</b> {item.unit}</td><td><form className="threshold-editor" onSubmit={(event) => { event.preventDefault(); onEdit(item, { threshold: Number(thresholds[item.id] ?? item.threshold) }); }}><input type="number" min="0" step="1" aria-label={`${item.name}安全库存`} value={thresholds[item.id] ?? item.threshold} onChange={(event) => setThresholds((current) => ({ ...current, [item.id]: event.target.value }))} /><span>{item.unit}</span><button className="icon-button" title="保存安全库存" aria-label={`保存${item.name}安全库存`}><Save size={13} /></button></form></td><td><form className="price-editor" onSubmit={(event) => { event.preventDefault(); onEdit(item, { cost: Number(costs[item.id] ?? item.cost) }); }}><span>¥</span><input type="number" min="0" step="0.01" aria-label={`${item.name}采购价`} value={costs[item.id] ?? item.cost} onChange={(event) => setCosts((current) => ({ ...current, [item.id]: event.target.value }))} /><button className="icon-button" title="保存采购价" aria-label={`保存${item.name}采购价`}><Save size={13} /></button></form></td><td><form className="price-editor" onSubmit={(event) => { event.preventDefault(); onEdit(item, { price: Number(prices[item.id] ?? item.price) }); }}><span>¥</span><input type="number" min="0" step="0.01" aria-label={`${item.name}销售价格`} value={prices[item.id] ?? item.price} onChange={(event) => setPrices((current) => ({ ...current, [item.id]: event.target.value }))} /><button className="icon-button" title="保存销售价格" aria-label={`保存${item.name}销售价格`}><Save size={13} /></button></form></td><td><div className="stock-status-actions"><span className={`stock-badge ${isLow ? 'is-low' : ''}`}><i />{!alertEnabled ? '预警已解除' : isLow ? '库存偏低' : '库存充足'}</span>{(isLow || !alertEnabled) && <button type="button" className="stock-alert-toggle" onClick={() => onEdit(item, { stock_alert_enabled: !alertEnabled })}>{alertEnabled ? '解除预警' : '恢复预警'}</button>}</div></td></tr>; })}</tbody></table>{products.length === 0 && <EmptyState text="还没有商品库存" />}</div><div className="table-meta">共 {products.length} 个商品<span>可调整安全库存、采购价和销售价；无需备货的商品可解除预警</span></div></div></>;
}

function StocktakeList({ rows, onPrint, onView }) {
  return <><div className="toolbar-row"><div className="inline-note"><ClipboardCheck size={15} />选择商品分类进行盘点，未选分类的商品不会参与</div><div className="toolbar-actions"><button className="button-secondary" onClick={onPrint}><Printer size={14} />打印</button></div></div><div className="panel table-panel"><div className="table-scroll"><table className="data-table wide-table"><thead><tr><th>盘点流水号</th><th>盘点日期</th><th>商品分类</th><th>商品数量</th><th>备注</th><th>创建时间</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td className="mono"><button type="button" className="order-number-link" onClick={() => onView(row)}>{row.number}</button></td><td>{row.date}</td><td>{row.category_name || '历史盘点'}</td><td>{row.item_count}</td><td>{row.note || '—'}</td><td>{row.created_at}</td></tr>)}</tbody></table>{rows.length === 0 && <EmptyState text="尚无盘点记录，开始一次库存盘点" />}</div><div className="table-meta">点击盘点流水号可查看商品实盘记录</div></div></>;
}

function SettingsPage({ settings, onSave, onRestore }) {
  return <div className="settings-layout"><section className="panel settings-panel"><div className="settings-section"><div className="settings-icon"><Settings size={17} /></div><div className="settings-heading"><b>系统与单据</b><span>设置系统显示名称及打印单据抬头</span></div></div><form onSubmit={onSave} className="settings-form"><label>系统名称<input name="systemName" defaultValue={settings.systemName || ''} maxLength="60" required /><small>显示在侧边栏、页面标题和打印单据上</small></label><div className="settings-divider" /><label>采购单据模板名称<input name="purchaseTemplate" defaultValue={settings.purchaseTemplate || '采购入库单'} maxLength="60" required /><small>打印采购单时显示的单据标题</small></label><label>销售单据模板名称<input name="salesTemplate" defaultValue={settings.salesTemplate || '销售出库单'} maxLength="60" required /><small>打印销售单时显示的单据标题</small></label><div className="settings-submit"><button className="button-primary"><Save size={15} />保存设置</button></div></form></section><section className="panel settings-panel backup-panel"><div className="settings-section"><div className="settings-icon backup"><ShieldCheck size={17} /></div><div className="settings-heading"><b>数据备份与恢复</b><span>下载完整业务数据，或从备份文件还原</span></div></div><div className="backup-content"><div className="backup-info"><b>JSON 数据备份</b><p>包含商品、供应商、客户、单据、收款记录、库存记录和系统设置。建议定期下载并妥善保管。</p><a className="button-secondary download-link" href="/api/backup"><Download size={15} />下载完整备份</a></div><div className="backup-restore"><b>从备份恢复</b><p>恢复操作会覆盖当前数据，请先下载一份当前备份。</p><label className="button-secondary upload-button"><Upload size={15} />选择备份文件<input type="file" accept="application/json,.json" onChange={(event) => { onRestore(event.target.files?.[0]); event.target.value = ''; }} /></label></div></div><div className="backup-warning"><AlertTriangle size={15} />恢复会替换当前所有商品和业务数据，且无法撤销。</div></section></div>;
}

function Modal({ modal, data, suspendedOrders, onClose, onSaveEntity, onSaveOrder, onSaveStocktake, onSaveReceipt, onSaveSupplierPayment, onSuspendOrder, onResumeOrder, onCancelSuspendedOrder, onAddParty, onPrintOrder, onError }) {
  function openOrder(orderId) {
    const order = data.orders.find((item) => item.id === orderId);
    if (!order) {
      onError(new Error('未找到对应订单，请刷新后重试'));
      return;
    }
    onPrintOrder(order);
  }
  if (modal.kind === 'entity') return <EntityModal modal={modal} data={data} onClose={() => onClose(modal.returnTo)} onSave={onSaveEntity} onError={onError} />;
  if (modal.kind === 'order') return <OrderModal modal={modal} data={data} onClose={onClose} onSave={onSaveOrder} onSuspend={onSuspendOrder} onCancelSuspended={onCancelSuspendedOrder} onAddParty={onAddParty} />;
  if (modal.kind === 'suspendedOrders') return <SuspendedOrdersModal orders={suspendedOrders} data={data} onClose={onClose} onResume={onResumeOrder} onCancel={onCancelSuspendedOrder} />;
  if (modal.kind === 'stocktake') return <StocktakeModal data={data} onClose={onClose} onSave={onSaveStocktake} />;
  if (modal.kind === 'stocktakeDetailLoading') return <ModalFrame title={`${modal.stocktake.number} · 盘点单`} kicker="STOCKTAKE DETAIL" onClose={onClose}><div className="loading-state"><span className="loader" />正在读取盘点明细…</div></ModalFrame>;
  if (modal.kind === 'stocktakeDetail') return <StocktakeDetailModal stocktake={modal.stocktake} onClose={onClose} />;
  if (modal.kind === 'partyOrders') return <PartyOrdersModal party={modal.party} type={modal.orderType} orders={data.orders.filter((order) => order.type === modal.orderType && order.party_id === modal.party.id)} onClose={onClose} onPrintOrder={onPrintOrder} />;
  if (modal.kind === 'receivable') return <ReceivableModal key={modal.customer.id} customer={modal.customer} onClose={onClose} onSave={onSaveReceipt} onOpenOrder={openOrder} />;
  if (modal.kind === 'payable') return <SupplierPayablesModal key={modal.supplier.id} supplier={modal.supplier} onClose={onClose} onSave={onSaveSupplierPayment} onOpenOrder={openOrder} />;
  return null;
}

function PartyOrdersModal({ party, type, orders, onClose, onPrintOrder }) {
  const purchase = type === 'purchase';
  return <ModalFrame title={`${party.name} · 全部${purchase ? '采购' : '销售'}订单`} kicker={purchase ? 'SUPPLIER ORDER HISTORY' : 'CUSTOMER ORDER HISTORY'} onClose={onClose} wide>
    {orders.length ? <div className="panel table-panel"><div className="table-scroll"><table className="data-table wide-table"><thead><tr><th>订单编号</th><th>日期</th><th>商品明细</th><th>数量</th><th>订单金额</th><th>{purchase ? '已付款' : '已收款'}</th><th>未结金额</th><th>状态</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}>
      <td className="mono"><button type="button" className="order-number-link" onClick={() => onPrintOrder(order)}>{order.number}</button></td>
      <td>{order.date}</td>
      <td className="order-products">{order.items.map((item) => <span key={item.id}>{item.product_name} <small>×{item.quantity}{item.unit}</small></span>)}</td>
      <td>{order.items.reduce((sum, item) => sum + Number(item.quantity), 0)}</td>
      <td><b>{money(order.total)}</b></td>
      <td>{order.audited ? money(order.paid) : '—'}</td>
      <td>{order.audited ? money(order.outstanding) : '—'}</td>
      <td><b className={!order.audited ? 'audit-pending' : 'balance-clear'}>{order.audited ? '已审核' : order.reversed ? '已反审核' : '未审核'}</b></td>
    </tr>)}</tbody></table></div><div className="table-meta">共 {orders.length} 张{purchase ? '采购' : '销售'}订单，按日期倒序排列</div></div> : <EmptyState text={`该${purchase ? '供应商' : '客户'}还没有${purchase ? '采购' : '销售'}订单，包含未审核订单`} />}
    <div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>关闭</button></div>
  </ModalFrame>;
}

function ReceivableModal({ customer, onClose, onSave, onOpenOrder }) {
  const [details, setDetails] = useState(null);
  const [allocations, setAllocations] = useState({});
  const [paymentMethod, setPaymentMethod] = useState('现金');
  const [paymentVoucher, setPaymentVoucher] = useState('');
  const [voucherName, setVoucherName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  useEffect(() => {
    let active = true;
    api(`/api/customers/${customer.id}/receivables`).then((result) => {
      if (active) setDetails(result);
    }).catch((cause) => {
      if (active) setFormError(cause.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [customer.id]);
  const totalDue = details?.orders.reduce((sum, order) => sum + Math.round(order.outstanding * 100), 0) || 0;
  const totalReceived = Object.values(allocations).reduce((sum, value) => sum + Math.round(Number(value || 0) * 100), 0);
  const fillAll = () => setAllocations(Object.fromEntries((details?.orders || []).map((order) => [order.id, order.outstanding.toFixed(2)])));
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const receiptAllocations = Object.entries(allocations)
      .map(([orderId, amount]) => ({ orderId: Number(orderId), amount: Number(amount) }))
      .filter((allocation) => Number.isFinite(allocation.amount) && allocation.amount > 0);
    if (!receiptAllocations.length) {
      setFormError('请填写本次收款金额');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await onSave(customer, {
        date: form.get('date'),
        paymentMethod,
        note: form.get('note'),
        allocations: receiptAllocations,
        ...(paymentMethod !== '现金' && paymentVoucher ? { paymentVoucher } : {}),
      });
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setSaving(false);
    }
  }
  return <ModalFrame title={`${customer.name} · 应收账款处理`} kicker="RECEIVABLE COLLECTION" onClose={onClose} wide>
    {loading ? <div className="loading-state"><span className="loader" />正在读取客户应收明细…</div> : !details ? <>
      <p className="order-form-error" role="alert"><AlertTriangle size={14} />{formError || '读取客户应收明细失败'}</p>
      <div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>关闭</button></div>
    </> : <>
      {formError && <p className="order-form-error" role="alert"><AlertTriangle size={14} />{formError}</p>}
      <div className="order-summary receivable-summary"><div><span>当前未收金额</span><b className={totalDue ? 'balance-due' : 'balance-clear'}>{money(totalDue / 100)}</b></div><div><span>本次收款金额</span><b>{money(totalReceived / 100)}</b></div></div>
      {details?.orders.length ? <form onSubmit={submit} className="receipt-form">
        <div className="order-form-meta">
          <label>收款日期<input type="date" name="date" defaultValue={today()} required /></label>
          <label>收款方式<select name="paymentMethod" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} required>{['现金', '微信', '支付宝', '银行转账', '其他'].map((method) => <option key={method} value={method}>{method}</option>)}</select></label>
        </div>
        {paymentMethod !== '现金' && <div className="voucher-upload">
          <span>收款凭证 <small>非现金收款可上传，JPG、PNG 或 WebP，最大 5 MB</small></span>
          <div className="voucher-actions">
            <label className="button-secondary upload-button"><Upload size={14} />{voucherName || '上传收款凭证'}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
                setFormError('请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片');
                return;
              }
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result !== 'string') { setFormError('读取收款凭证失败'); return; }
                setPaymentVoucher(reader.result);
                setVoucherName(file.name);
                setFormError('');
              };
              reader.onerror = () => setFormError('读取收款凭证失败');
              reader.readAsDataURL(file);
            }} /></label>
            {voucherName && <button type="button" className="text-link voucher-remove" onClick={() => { setPaymentVoucher(''); setVoucherName(''); }}>移除凭证</button>}
          </div>
        </div>}
        <div className="settlement-batch-actions"><button type="button" className="button-secondary" onClick={fillAll}>合并结清全部未收款</button><span>勾选明细后将合并登记为一笔收款</span></div><div className="panel receipt-orders"><div className="receipt-row receipt-head"><span>销售单号 / 日期</span><span>单据金额</span><span>已收金额</span><span>尚欠金额</span><span>本次收款</span></div>
          {details.orders.map((order) => <div className="receipt-row" key={order.id}>
            <span><div className="settlement-select"><input type="checkbox" aria-label={`选择订单 ${order.number} 用于收款`} checked={allocations[order.id] !== undefined} onChange={(event) => setAllocations((current) => ({ ...current, [order.id]: event.target.checked ? order.outstanding.toFixed(2) : undefined }))} /><span><button type="button" className="order-number-link" onClick={() => onOpenOrder(order.id)}>{order.number}</button><small>{order.date}</small></span></div></span><span>{money(order.total)}</span><span>{money(order.paid)}</span><b className="balance-due">{money(order.outstanding)}</b>
            <input aria-label={`${order.number}本次收款金额`} type="number" min="0" max={order.outstanding.toFixed(2)} step="0.01" value={allocations[order.id] ?? ''} onChange={(event) => setAllocations((current) => ({ ...current, [order.id]: event.target.value }))} placeholder="0.00" />
          </div>)}
        </div>
        <label className="note-field">收款备注<input name="note" placeholder="选填" maxLength="500" /></label>
        <div className="payment-summary"><span>收款后未收余额</span><b className={totalDue > totalReceived ? 'balance-due' : 'balance-clear'}>{money(Math.max(0, totalDue - totalReceived) / 100)}</b></div>
        <div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>取消</button><button type="submit" className="button-primary" disabled={saving || totalReceived <= 0 || totalReceived > totalDue}><Check size={15} />{saving ? '正在保存…' : '确认收款'}</button></div>
      </form> : <EmptyState text="该客户当前没有未收款销售单" />}
      <section className="receipt-history"><div className="panel-heading"><div><span className="section-kicker">COLLECTION HISTORY</span><h2>收款记录</h2></div></div>
        {details?.receipts.length ? <div className="receipt-history-list">{details.receipts.map((receipt) => <article className="receipt-history-item" key={receipt.id}><div><b>{receipt.date} · {receipt.payment_method}</b><strong>{money(receipt.total)}</strong></div><small>{receipt.allocations.map((item) => `${item.order_number || '已删除单据'} ${money(item.amount)}`).join('、') || '无关联销售单'}{receipt.note ? ` · ${receipt.note}` : ''}{receipt.has_voucher && <> · <a href={`/api/customer-receipts/${receipt.id}/voucher`} target="_blank" rel="noreferrer">查看凭证</a></>}</small></article>)}</div> : <p className="receipt-history-empty">暂无收款记录</p>}
      </section>
    </>}
  </ModalFrame>;
}

function SupplierPayablesModal({ supplier, onClose, onSave, onOpenOrder }) {
  const [details, setDetails] = useState(null);
  const [allocations, setAllocations] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  useEffect(() => {
    let active = true;
    api(`/api/suppliers/${supplier.id}/payables`).then((result) => {
      if (active) setDetails(result);
    }).catch((cause) => {
      if (active) setFormError(cause.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [supplier.id]);
  const totalDue = details?.orders.reduce((sum, order) => sum + Math.round(order.outstanding * 100), 0) || 0;
  const totalPayment = Object.values(allocations).reduce((sum, value) => sum + Math.round(Number(value || 0) * 100), 0);
  const fillAll = () => setAllocations(Object.fromEntries((details?.orders || []).map((order) => [order.id, order.outstanding.toFixed(2)])));
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const paymentAllocations = Object.entries(allocations)
      .map(([orderId, amount]) => ({ orderId: Number(orderId), amount: Number(amount) }))
      .filter((allocation) => Number.isFinite(allocation.amount) && allocation.amount > 0);
    if (!paymentAllocations.length) {
      setFormError('请填写本次付款金额');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await onSave(supplier, {
        date: form.get('date'),
        paymentMethod: form.get('paymentMethod'),
        note: form.get('note'),
        allocations: paymentAllocations,
      });
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setSaving(false);
    }
  }
  return <ModalFrame title={`${supplier.name} · 应付账款处理`} kicker="SUPPLIER PAYMENT" onClose={onClose} wide>
    {loading ? <div className="loading-state"><span className="loader" />正在读取供应商应付明细…</div> : !details ? <>
      <p className="order-form-error" role="alert"><AlertTriangle size={14} />{formError || '读取供应商应付明细失败'}</p>
      <div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>关闭</button></div>
    </> : <>
      {formError && <p className="order-form-error" role="alert"><AlertTriangle size={14} />{formError}</p>}
      <div className="order-summary receivable-summary"><div><span>当前待付金额</span><b className={totalDue ? 'balance-due' : 'balance-clear'}>{money(totalDue / 100)}</b></div><div><span>本次付款金额</span><b>{money(totalPayment / 100)}</b></div></div>
      {details.orders.length ? <form onSubmit={submit} className="receipt-form">
        <div className="order-form-meta">
          <label>付款日期<input type="date" name="date" defaultValue={today()} required /></label>
          <label>付款方式<select name="paymentMethod" defaultValue="现金" required>{['现金', '微信', '支付宝', '银行转账', '其他'].map((method) => <option key={method} value={method}>{method}</option>)}</select></label>
        </div>
        <div className="settlement-batch-actions"><button type="button" className="button-secondary" onClick={fillAll}>合并结清全部待付</button><span>勾选明细后将合并登记为一笔付款</span></div><div className="panel receipt-orders"><div className="receipt-row receipt-head"><span>采购单号 / 日期</span><span>单据金额</span><span>已付金额</span><span>尚欠金额</span><span>本次付款</span></div>
          {details.orders.map((order) => <div className="receipt-row" key={order.id}>
            <span><div className="settlement-select"><input type="checkbox" aria-label={`选择订单 ${order.number} 用于付款`} checked={allocations[order.id] !== undefined} onChange={(event) => setAllocations((current) => ({ ...current, [order.id]: event.target.checked ? order.outstanding.toFixed(2) : undefined }))} /><span><button type="button" className="order-number-link" onClick={() => onOpenOrder(order.id)}>{order.number}</button><small>{order.date}</small></span></div></span><span>{money(order.total)}</span><span>{money(order.paid)}</span><b className="balance-due">{money(order.outstanding)}</b>
            <input aria-label={`${order.number}本次付款金额`} type="number" min="0" max={order.outstanding.toFixed(2)} step="0.01" value={allocations[order.id] ?? ''} onChange={(event) => setAllocations((current) => ({ ...current, [order.id]: event.target.value }))} placeholder="0.00" />
          </div>)}
        </div>
        <label className="note-field">付款备注<input name="note" placeholder="选填" maxLength="500" /></label>
        <div className="payment-summary"><span>付款后待付余额</span><b className={totalDue > totalPayment ? 'balance-due' : 'balance-clear'}>{money(Math.max(0, totalDue - totalPayment) / 100)}</b></div>
        <div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>取消</button><button type="submit" className="button-primary" disabled={saving || totalPayment <= 0 || totalPayment > totalDue}><Check size={15} />{saving ? '正在保存…' : '确认付款'}</button></div>
      </form> : <EmptyState text="该供应商当前没有待付款采购单" />}
      <section className="receipt-history"><div className="panel-heading"><div><span className="section-kicker">PAYMENT HISTORY</span><h2>付款记录</h2></div></div>
        {details.payments.length ? <div className="receipt-history-list">{details.payments.map((payment) => <article className="receipt-history-item" key={payment.id}><div><b>{payment.date} · {payment.payment_method}</b><strong>{money(payment.total)}</strong></div><small>{payment.allocations.map((item) => `${item.order_number || '已删除单据'} ${money(item.amount)}`).join('、') || '无关联采购单'}{payment.note ? ` · ${payment.note}` : ''}</small></article>)}</div> : <p className="receipt-history-empty">暂无付款记录</p>}
      </section>
    </>}
  </ModalFrame>;
}

function EntityModal({ modal, data, onClose, onSave, onError }) {
  const isProduct = modal.entity === 'products';
  const title = isProduct ? '商品' : modal.entity === 'suppliers' ? '供应商' : '客户';
  const row = modal.record || {};
  const fields = isProduct ? [field('sku','商品编码', 'text', { placeholder: '留空自动生成' }), field('name','商品名称','text',{ required:true }), field('category_id','商品分类','select',{ required:true }), field('specification','规格型号','text',{ placeholder:'例如：500ml / S码' }), field('unit','计量单位','select',{ required:true }), field('cost','采购单价','number',{ min:'0',step:'0.01',required:true }), field('price','销售单价','number',{ min:'0',step:'0.01',required:true }), field('stock','初始库存','number',{ min:'0',step:'1',required:true }), field('threshold','安全库存','number',{ min:'0',step:'1',required:true }), field('note','备注','text') ] : [field('name',`${title}名称`,'text',{required:true}),field('contact','联系人'),field('phone','联系电话','tel'),field('email','电子邮箱','email'),field('address','地址','text',{wide:true}),field('note','备注','text',{wide:true})];
  return <ModalFrame title={`${modal.record ? '编辑' : '新增'}${title}`} kicker={`${title.toUpperCase()} PROFILE`} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSave(modal.entity, event.currentTarget).catch(onError); }} className="entity-form"><div className="modal-grid">{fields.map((item) => <label className={item.wide ? 'wide-field' : ''} key={item.name}>{item.label}{item.type === 'select' ? <select name={item.name} defaultValue={item.name === 'unit' ? row.unit || data.units[0]?.name || '' : row.category_id ?? modal.categoryId ?? data.categories.find((category) => category.name === '未分类')?.id ?? data.categories[0]?.id ?? ''} required={item.required}>{(item.name === 'unit' ? data.units : data.categories).map((option) => <option key={option.id} value={item.name === 'unit' ? option.name : option.id}>{option.name}</option>)}</select> : <input name={item.name} type={item.type} defaultValue={row[item.name] ?? (item.name === 'stock' || item.name === 'threshold' ? 0 : item.name === 'cost' || item.name === 'price' ? 0 : '')} placeholder={item.placeholder} required={item.required} min={item.min} step={item.step} maxLength={item.name === 'note' ? 500 : undefined} />}</label>)}</div><ModalActions onClose={onClose} label={modal.record ? '保存修改' : `创建${title}`} /></form></ModalFrame>;
}

function OrderProductSelect({ products, product, value, allowAdd, onChange }) {
  const listId = useId();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const label = (item) => item ? `${item.name}${item.specification ? ` · ${item.specification}` : ''} · ${item.sku}` : '';
  const [query, setQuery] = useState(() => label(product));
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const keyword = dirty ? query.trim().toLowerCase() : '';
  const matches = keyword
    ? products.filter((item) => [item.name, item.sku, item.specification].some((part) => String(part ?? '').toLowerCase().includes(keyword)))
    : products;
  const options = allowAdd ? [...matches, null] : matches;
  useEffect(() => {
    if (!dirty) setQuery(label(product));
  }, [product, dirty]);
  useEffect(() => {
    if (inputRef.current) inputRef.current.setCustomValidity(dirty || !product ? '请从下拉列表选择商品' : '');
  }, [dirty, product]);
  useEffect(() => {
    const list = listRef.current;
    const option = list?.children[activeIndex + (matches.length ? 0 : 1)];
    if (!list || !option || activeIndex < 0) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [activeIndex, open, matches.length]);
  function choose(item) {
    if (!item) {
      onChange('__add_product__', inputRef.current.form);
      return;
    }
    setQuery(label(item));
    setDirty(false);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current.setCustomValidity('');
    if (String(item.id) !== String(value)) onChange(String(item.id), inputRef.current.form);
  }
  return <div className="order-product-select">
    <input ref={inputRef} role="combobox" aria-label="商品名称" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined} data-product-search-pending={dirty} value={query} placeholder="选择或搜索商品" required
      onFocus={(event) => { setOpen(true); setActiveIndex(-1); event.currentTarget.select(); }}
      onClick={() => setOpen(true)}
      onBlur={() => { setOpen(false); setActiveIndex(-1); }}
      onInvalid={() => setOpen(true)}
      onChange={(event) => { setQuery(event.target.value); setDirty(true); setOpen(true); setActiveIndex(-1); event.currentTarget.setCustomValidity('请从下拉列表选择商品'); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true);
          setActiveIndex((index) => options.length ? (event.key === 'ArrowDown' ? Math.min(index + 1, options.length - 1) : index <= 0 ? options.length - 1 : index - 1) : -1);
        } else if (event.key === 'Enter' && open) {
          event.preventDefault();
          if (activeIndex >= 0) choose(options[activeIndex]);
        } else if (event.key === 'Escape') {
          event.preventDefault(); setQuery(label(product)); setDirty(false); setOpen(false); setActiveIndex(-1);
          event.currentTarget.setCustomValidity(product ? '' : '请从下拉列表选择商品');
        }
      }} />
    <ChevronDown className="order-product-chevron" size={14} aria-hidden="true" />
    {open && <div ref={listRef} className="order-product-options" id={listId} role="listbox" aria-label="商品列表">
      {!matches.length && <div className="order-product-empty">没有匹配的商品</div>}
      {options.map((item, index) => <div key={item?.id ?? 'add'} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}>{item ? label(item) : '＋ 新增商品'}</div>)}
    </div>}
  </div>;
}

function OrderModal({ modal, data, onClose, onSave, onSuspend, onCancelSuspended, onAddParty }) {
  const purchase = modal.type === 'purchase';
  const partyRows = purchase ? data.suppliers : data.customers;
  const [lines, setLines] = useState(modal.lines);
  const [orderDate, setOrderDate] = useState(modal.orderDate || modal.order?.date || today());
  const [paidAmount, setPaidAmount] = useState(modal.paidAmount ?? String(modal.order ? (modal.order.audited ? modal.order.paid : modal.order.planned_paid) : 0));
  const [partyId, setPartyId] = useState(String(modal.partyId ?? modal.order?.party_id ?? partyRows[0]?.id ?? ''));
  const [paymentMethod, setPaymentMethod] = useState(modal.paymentMethod ?? ((modal.order?.audited ? modal.order?.paid : modal.order?.planned_paid) > 0 && ['现金', '微信', '支付宝', '银行转账', '其他'].includes(modal.order.payment_method) ? modal.order.payment_method : ''));
  const [paymentVoucher, setPaymentVoucher] = useState(modal.paymentVoucher || '');
  const [voucherName, setVoucherName] = useState(modal.voucherName || '');
  const [removeVoucher, setRemoveVoucher] = useState(modal.removeVoucher || false);
  const [formError, setFormError] = useState('');
  const orderLinesRef = useRef(null);
  const previousLineCount = useRef(lines.length);
  const dateOrders = data.orders.filter((order) => order.date === orderDate);
  const orderNumber = modal.order?.number || `${purchase ? 'CG' : 'XS'}-${orderDate.replaceAll('-', '')}-${String(dateOrders.length + 1).padStart(4, '0')}`;
  const total = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
  const outstanding = Math.max(0, total - Number(paidAmount || 0));
  useEffect(() => {
    if (lines.length > previousLineCount.current) {
      const animationFrame = window.requestAnimationFrame(() => {
        orderLinesRef.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      previousLineCount.current = lines.length;
      return () => window.cancelAnimationFrame(animationFrame);
    }
    previousLineCount.current = lines.length;
    return undefined;
  }, [lines.length]);
  function getReturnTo(productLineIndex, form) {
    const note = form ? new FormData(form).get('note') : modal.note;
    return {
      ...modal,
      lines,
      orderDate,
      paidAmount,
      partyId,
      paymentMethod,
      paymentVoucher,
      voucherName,
      removeVoucher,
      note,
      ...(productLineIndex === undefined ? {} : { productLineIndex }),
    };
  }
  function addParty(form) {
    onAddParty(purchase ? 'suppliers' : 'customers', getReturnTo(undefined, form));
  }
  function addProduct(lineIndex, form) {
    onAddParty('products', getReturnTo(lineIndex, form));
  }
  async function suspendOrder(form) {
    const pendingProduct = form.querySelector('[data-product-search-pending="true"]');
    if (pendingProduct) { pendingProduct.reportValidity(); return; }
    try { await onSuspend(getReturnTo(undefined, form)); }
    catch (cause) { setFormError(cause.message); }
  }
  async function submitOrder(event) {
    event.preventDefault();
    if (!partyId) {
      setFormError(purchase ? '请选择有效供应商' : '请选择有效客户');
      event.currentTarget.querySelector('[name="partyId"]').focus();
      return;
    }
    setFormError('');
    try { await onSave(event, lines, paymentVoucher, removeVoucher); }
    catch (cause) { setFormError(cause.message); }
  }
  return <ModalFrame title={`${modal.order ? '编辑' : '新建'}${purchase ? '采购订单' : '销售订单'}`} kicker={purchase ? 'PURCHASE ORDER' : 'SALES ORDER'} onClose={onClose} wide>
    <form onSubmit={submitOrder} className="order-form">
      <div className="order-number-preview"><span>单据流水号{modal.order ? '' : '（预计）'}</span><b>{orderNumber}</b></div>
      <div className="order-form-meta">
        <label>{purchase ? '供应商' : '客户'}
          <select name="partyId" aria-required="true" aria-invalid={formError === (purchase ? '请选择有效供应商' : '请选择有效客户')} value={partyId} onChange={(event) => {
            if (event.target.value === '__add_party__') { addParty(event.currentTarget.form); return; }
            setPartyId(event.target.value); setFormError('');
          }}>
            {partyRows.map((party) => <option key={party.id} value={party.id}>{party.name}{party.phone ? ` · ${party.phone}` : ''}</option>)}
            {!modal.order && <option value="__add_party__">＋ 增加{purchase ? '供应商' : '客户'}</option>}
          </select>
        </label>
        <label>单据日期<input type="date" name="date" value={orderDate} onChange={(event) => setOrderDate(event.target.value)} required /></label>
      </div>
      {formError && <p className="order-form-error" role="alert"><AlertTriangle size={14} />{formError}</p>}
      <div className="line-title"><b>商品明细</b></div>
      <div className="line-head"><span>商品名称 / 规格</span><span>当前库存</span><span>数量</span><span>单价</span><span>小计</span><i /></div>
      <div className="order-lines" ref={orderLinesRef}>{lines.map((line, index) => {
        const product = data.products.find((item) => item.id === Number(line.productId));
        return <div className="order-line" key={`${index}-${line.productId}`}>
        <OrderProductSelect products={data.products} product={product} value={line.productId} allowAdd={!modal.order} onChange={(value, form) => {
          if (value === '__add_product__') { addProduct(index, form); return; }
          const selected = data.products.find((item) => item.id === Number(value));
          if (!selected) return;
          const next = [...lines];
          next[index] = { ...next[index], productId: selected.id, unitPrice: purchase ? selected.cost : selected.price };
          setLines(next);
        }} />
          <span className={`line-stock ${!purchase && Number(product?.stock) <= 0 ? 'qty-low' : ''}`}>{product?.stock ?? 0} {product?.unit}</span>
          <input aria-label="商品数量" type="number" min="1" step="1" value={line.quantity} onChange={(event) => {
            const next = [...lines];
            next[index] = { ...next[index], quantity: event.target.value };
            setLines(next);
          }} required />
          <input aria-label="商品单价" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => {
            const next = [...lines];
            next[index] = { ...next[index], unitPrice: event.target.value };
            setLines(next);
          }} required />
          <b className="line-subtotal">{money(Number(line.quantity || 0) * Number(line.unitPrice || 0))}</b>
          <button type="button" className="icon-button danger-hover" aria-label="移除商品" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, lineIndex) => lineIndex !== index))}><X size={14} /></button>
        </div>;
      })}</div>
      <button type="button" className="text-link add-order-line" onClick={() => setLines([...lines, { productId: data.products[0]?.id ?? '', quantity: 1, unitPrice: (purchase ? data.products[0]?.cost : data.products[0]?.price) ?? 0 }])}><Plus size={14} />添加商品</button>
      <p className="stock-note"><Boxes size={14} />{modal.order?.reversed ? '反审核订单保存后将重新生效，库存及收付款会同步更新。' : '未审核订单不影响库存，审核后才正式入库或出库。'}</p>
      <div className="order-form-meta payment-fields">
        <label>{purchase ? '付款方式' : '收款方式'}
          <select name="paymentMethod" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} required={Number(paidAmount) > 0}>
            <option value="">{purchase ? '未付款' : '未收款'}</option>
            {['现金', '微信', '支付宝', '银行转账', '其他'].map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
        </label>
        <label>{purchase ? '付款金额' : '收款金额'}
          <input name="paidAmount" type="number" min="0" max={total.toFixed(2)} step="0.01" value={paidAmount} onChange={(event) => setPaidAmount(event.target.value)} required />
        </label>
      </div>
      <div className="payment-summary"><span>{outstanding > 0 ? '未结账金额' : '结账状态'}</span><b className={total > 0 && outstanding <= 0 ? 'balance-clear' : 'balance-due'}>{total > 0 && outstanding <= 0 ? '已结清' : outstanding > 0 ? money(outstanding) : '未结账'}</b></div>
      <div className="voucher-upload">
        <span>{purchase ? '付款凭证' : '收款凭证'} <small>选填，JPG、PNG 或 WebP，最大 5 MB</small></span>
        <div className="voucher-actions">
          <label className="button-secondary upload-button"><Upload size={14} />{voucherName || '上传凭证图片'}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
              setFormError('请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片');
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result !== 'string') { setFormError('读取付款凭证失败'); return; }
              setPaymentVoucher(reader.result);
              setVoucherName(file.name);
              setRemoveVoucher(false);
              setFormError('');
            };
            reader.onerror = () => setFormError('读取付款凭证失败');
            reader.readAsDataURL(file);
          }} /></label>
          {modal.order?.has_voucher && !removeVoucher && <><a className="button-secondary" href={`/api/orders/${modal.order.id}/voucher`} target="_blank" rel="noreferrer">查看已上传凭证</a><button type="button" className="text-link voucher-remove" onClick={() => { setRemoveVoucher(true); setPaymentVoucher(''); setVoucherName(''); }}>移除凭证</button></>}
          {removeVoucher && <span className="voucher-pending-remove">保存后移除凭证</span>}
        </div>
      </div>
      <label className="note-field">备注<input name="note" defaultValue={modal.note ?? modal.order?.note ?? ''} placeholder="选填" maxLength="500" /></label>
      <div className="order-total"><span>单据合计</span><b>{money(total)}</b></div>
      <div className="modal-actions order-modal-actions">
        <div className="order-secondary-actions">
          <button type="button" className="button-secondary" onClick={onClose}>关闭</button>
          {modal.suspendedId && <button type="button" className="button-secondary cancel-suspended-button" onClick={() => onCancelSuspended(modal.suspendedId).catch((cause) => setFormError(cause.message))}>取消订单</button>}
        </div>
        <div className="order-primary-actions">
          {!modal.order && <button type="button" className="button-secondary" onClick={(event) => suspendOrder(event.currentTarget.form)}>挂单</button>}
          <button type="submit" className="button-primary"><Check size={15} />{modal.order ? '保存修改' : '保存未审核订单'}</button>
        </div>
      </div>
    </form>
  </ModalFrame>;
}

function SuspendedOrdersModal({ orders, data, onClose, onResume, onCancel }) {
  const [formError, setFormError] = useState('');
  return <ModalFrame title="挂单列表" kicker="SUSPENDED ORDERS" onClose={onClose} wide>
    {formError && <p className="order-form-error" role="alert"><AlertTriangle size={14} />{formError}</p>}
    {orders.length ? <div className="suspended-order-list">{orders.map((order) => {
      const purchase = order.type === 'purchase';
      const party = (purchase ? data.suppliers : data.customers).find((item) => item.id === Number(order.partyId));
      const total = order.lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
      return <article className="suspended-order-item" key={order.suspendedId}>
        <div className="suspended-order-info">
          <b>{purchase ? '采购订单' : '销售订单'} · {party?.name || '未选择往来单位'}</b>
          <span>{order.orderDate} · {order.lines.length} 项商品 · {money(total)}</span>
        </div>
        <div className="suspended-order-actions">
          <button type="button" className="button-primary" onClick={() => onResume(order).catch((cause) => setFormError(cause.message))}>取单继续</button>
          <button type="button" className="button-secondary cancel-suspended-button" onClick={() => onCancel(order.suspendedId).catch((cause) => setFormError(cause.message))}>取消挂单</button>
        </div>
      </article>;
    })}</div> : <EmptyState text="暂无挂单，可在新建销售单或采购单时挂起订单" />}
    <div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>关闭</button></div>
  </ModalFrame>;
}

function StocktakeModal({ data, onClose, onSave }) {
  const [categoryId, setCategoryId] = useState('');
  const products = data.products.filter((product) => String(product.category_id) === categoryId);
  return <ModalFrame title="库存盘点" kicker="STOCKTAKE" onClose={onClose} wide><form onSubmit={onSave}><div className="order-form-meta"><label>盘点日期<input type="date" name="date" defaultValue={today()} required /></label><label>商品分类<select name="categoryId" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required><option value="">请选择要盘点的分类</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label className="wide-field">盘点备注<input name="note" placeholder="选填" maxLength="500" /></label></div>{categoryId ? products.length ? <div className="panel stocktake-grid"><div className="line-head"><span>商品名称 / 规格</span><span>系统库存</span><span>实盘数量</span><span>差异</span></div>{products.map((product) => <StocktakeLine key={product.id} product={product} />)}</div> : <EmptyState text="该分类下暂无商品，未分类商品及其他分类不会参与此次盘点" /> : <EmptyState text="请选择商品分类；未选中的分类不会参与盘点" />}<p className="stock-note"><ClipboardCheck size={14} />只盘点所选分类内的商品，其他分类和未分类商品不会改变库存。</p><div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>取消</button><button type="submit" className="button-primary" disabled={!categoryId || products.length === 0}><Check size={15} />保存盘点</button></div></form></ModalFrame>;
}
function StocktakeLine({ product }) {
  const [count, setCount] = useState(Number.isInteger(Number(product.stock)) ? String(product.stock) : '');
  const difference = count === '' ? null : Number(count) - Number(product.stock);
  return <div className="stocktake-line"><span><b>{product.name}</b><small>{product.specification || product.sku}</small></span><span>{product.stock} {product.unit}</span><input name={`count-${product.id}`} type="number" min="0" max="999999999" step="1" value={count} onChange={(event) => setCount(event.target.value)} required /><b className={difference === null ? 'diff-zero' : difference ? (difference > 0 ? 'diff-plus' : 'qty-low') : 'diff-zero'}>{difference === null ? '—' : `${difference > 0 ? '+' : ''}${difference} ${product.unit}`}</b></div>;
}
function StocktakeDetailModal({ stocktake, onClose }) {
  return <ModalFrame title={`${stocktake.number} · 盘点单`} kicker="STOCKTAKE DETAIL" onClose={onClose} wide>
    <div className="order-form-meta stocktake-detail-meta"><label>盘点日期<input value={stocktake.date} readOnly /></label><label>商品分类<input value={stocktake.category_name || '历史盘点'} readOnly /></label><label className="wide-field">盘点备注<input value={stocktake.note || '—'} readOnly /></label></div>
    <div className="panel table-panel stocktake-detail-table"><div className="table-scroll"><table className="data-table wide-table"><thead><tr><th>商品名称</th><th>盘点前库存</th><th>实盘数量</th><th>库存调整</th></tr></thead><tbody>{stocktake.items.map((item) => <tr key={item.id}><td><b className="main-cell">{item.product_name}</b></td><td>{item.expected} {item.unit}</td><td><b>{item.counted} {item.unit}</b></td><td className={Number(item.difference) > 0 ? 'diff-plus' : Number(item.difference) < 0 ? 'qty-low' : 'diff-zero'}>{Number(item.difference) > 0 ? '+' : ''}{item.difference} {item.unit}</td></tr>)}</tbody></table>{stocktake.items.length === 0 && <EmptyState text="该盘点单没有商品明细" />}</div></div>
    <div className="modal-actions"><button type="button" className="button-primary" onClick={onClose}>关闭</button></div>
  </ModalFrame>;
}
function ModalFrame({ title, kicker, onClose, children, wide = false }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`form-modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true"><header><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>{children}</section></div>;
}
function ModalActions({ onClose, label }) { return <div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>取消</button><button type="submit" className="button-primary"><Check size={15} />{label}</button></div>; }
function EmptyState({ text }) { return <div className="empty-state"><Package size={21} /><span>{text}</span></div>; }
function PrintableOrder({ order, title, systemName, onClose }) {
  return <div className="print-overlay"><div className="print-controls"><button className="button-secondary" onClick={() => window.print()}><Printer size={14} />打印</button><button className="button-secondary" onClick={onClose}><X size={14} />关闭预览</button></div><article className="print-sheet"><div className="print-brand">{systemName}</div><h1>{title || (order.type === 'purchase' ? '采购入库单' : '销售出库单')}</h1><div className="print-meta"><span>单据编号：{order.number}</span><span>单据日期：{order.date}</span><span>{order.type === 'purchase' ? '供应商' : '客户'}：{order.party_name}</span></div><table><thead><tr><th>商品名称</th><th>规格</th><th>单位</th><th>数量</th><th>单价</th><th>小计</th></tr></thead><tbody>{order.items.map((item) => <tr key={item.id || item.product_name}><td>{item.product_name}</td><td>{item.specification || '—'}</td><td>{item.unit}</td><td>{item.quantity}</td><td>{money(item.unit_price)}</td><td>{money(item.subtotal)}</td></tr>)}</tbody></table><div className="print-total">合计金额：<b>{money(order.total)}</b></div><div className="print-note">备注：{order.note || '—'}</div><div className="print-payment"><span>{order.type === 'purchase' ? '付款方式' : '收款方式'}：{order.payment_method}</span><span>{order.type === 'purchase' ? '已付款' : '已收款'}：{money(order.paid)}</span><span>未结金额：{money(order.outstanding)}</span></div>{order.has_voucher && <div className="print-voucher"><h2>付款/收款凭证</h2><a href={`/api/orders/${order.id}/voucher`} target="_blank" rel="noreferrer"><img src={`/api/orders/${order.id}/voucher`} alt={`${order.number}付款凭证`} /></a></div>}<div className="signature-row"><span>经办人：____________</span><span>签收人：____________</span><span>日期：____________</span></div></article></div>;
}

createRoot(document.getElementById('root')).render(<App />);
