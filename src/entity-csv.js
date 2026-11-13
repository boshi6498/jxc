export const entityColumns = {
  products: [
    ['sku', '商品编码'], ['name', '商品名称'], ['specification', '规格'], ['unit', '单位'],
    ['category', '商品分类'], ['cost', '采购价'], ['price', '销售价'], ['stock', '库存'],
    ['threshold', '安全库存'], ['stock_alert_enabled', '库存预警'], ['note', '备注'],
  ],
  suppliers: [['name', '供应商名称'], ['contact', '联系人'], ['phone', '联系电话'], ['email', '邮箱'], ['address', '地址'], ['note', '备注']],
  customers: [['name', '客户名称'], ['contact', '联系人'], ['phone', '联系电话'], ['email', '邮箱'], ['address', '地址'], ['note', '备注']],
};

export function entityExportValues(entity, row, categories) {
  return entityColumns[entity].map(([key]) => {
    if (key === 'category') return categories.find((category) => category.id === row.category_id)?.name || '未分类';
    if (key === 'stock_alert_enabled') return [false, 0, 'false', '0'].includes(row.stock_alert_enabled) ? '关闭' : '启用';
    return row[key];
  });
}

export function parseEntityCsv(content, entity) {
  const columns = entityColumns[entity];
  if (!columns) throw new Error('不支持的资料类型');
  const input = content.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === '"' && !value && !closed) {
      quoted = true;
    } else if (char === ',' || char === '\r' || char === '\n') {
      row.push(value); value = ''; closed = false;
      if (char !== ',') {
        rows.push(row); row = [];
        if (char === '\r' && input[i + 1] === '\n') i += 1;
      }
    } else if (char === '"' || closed) {
      throw new Error('CSV 格式错误：引号位置无效');
    } else value += char;
  }
  if (quoted) throw new Error('CSV 格式错误：引号未闭合');
  if (value || row.length || closed) { row.push(value); rows.push(row); }
  const headers = rows.shift()?.map((header) => header.trim());
  if (!headers || headers.length !== columns.length || columns.some(([, label]) => !headers.includes(label)) || new Set(headers).size !== headers.length) {
    throw new Error('CSV 表头不匹配，请先导出对应资料作为模板');
  }
  const records = rows.filter((values) => values.some((item) => item.trim())).map((values, index) => {
    if (values.length !== headers.length) throw new Error(`第 ${index + 2} 条记录的列数不正确`);
    return Object.fromEntries(columns.map(([key, label]) => [key, values[headers.indexOf(label)]]));
  });
  if (!records.length) throw new Error('CSV 中没有可导入的资料');
  return records;
}
