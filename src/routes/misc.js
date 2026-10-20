'use strict';
// 工具箱（参数化只读 SQL）、意见箱、系统导航、业务手册、数据查看（本地运营表浏览）
const fs = require('node:fs');
const path = require('node:path');
const { readXlsx, parseCsv } = require('../core/xlsx');
const { tables: OPS } = require('../db/schema');
const { hasPerm } = require('../core/perms');

// 数据查看可浏览的运营表（不含账号/日志类敏感表）
const VIEWABLE = ['customers', 'key_persons', 'visit_plans', 'meetings', 'tasks', 'events', 'warnings', 'warning_rules', 'stage_summary', 'warranty_settings', 'documents', 'oem_mapping', 'demands', 'demand_pool', 'contracts'];

function register(r, { repo, analytics, config, HttpError }) {
  // ---------- 工具箱 ----------
  // sql_template 中 {{逻辑表名}} 替换为分析库实际表名，:参数 替换为绑定参数（防注入）
  const render = (tpl, params) => {
    const values = [];
    const sql = String(tpl).replace(/\{\{(\w+)\}\}/g, (_, t) => analytics.T(t)).replace(/:([A-Za-z_]\w*)/g, (_, k) => { values.push(params[k] == null ? '' : String(params[k])); return '?'; });
    return { sql, values };
  };
  r.get('/api/tools', async (req, res, x) => {
    const all = await repo.find('tools', {}, { order: 'id' });
    return { success: true, items: hasPerm(x.user, 'tool.manage') ? all : all.filter((t) => t.enabled) };
  });
  r.post('/api/tools/:id/run', async (req, res, x) => {
    const t = await repo.get('tools', x.params.id);
    if (!t || !t.enabled) throw new HttpError(404, '工具不存在或已停用');
    const { sql, values } = render(t.sql_template, x.body.params || {});
    try { return { success: true, ...(await analytics.readonlyQuery(sql, values, 1000)) }; } catch (e) { return { success: false, error: e.message }; }
  });
  r.post('/api/tools/manage', async (req, res, x) => {
    if (!x.body.name || !x.body.sql_template) throw new HttpError(400, '名称和 SQL 模板必填');
    return { success: true, id: await repo.insert('tools', { enabled: true, ...x.body }) };
  }, { perm: 'tool.manage' });
  r.put('/api/tools/manage/:id', async (req, res, x) => { await repo.update('tools', x.params.id, x.body); return { success: true }; }, { perm: 'tool.manage' });
  r.delete('/api/tools/manage/:id', async (req, res, x) => { await repo.remove('tools', x.params.id); return { success: true }; }, { perm: 'tool.manage' });

  // ---------- 系统导航（ADG） ----------
  r.get('/api/adg/systems', async () => repo.find('adg_systems', {}, { order: 'sort_order, id' }));
  r.post('/api/adg/systems', async (req, res, x) => {
    if (!x.body.name) throw new HttpError(400, '系统名称必填');
    return { success: true, id: await repo.insert('adg_systems', x.body) };
  }, { perm: 'adg.edit' });
  r.put('/api/adg/systems/:id', async (req, res, x) => { await repo.update('adg_systems', x.params.id, x.body); return { success: true }; }, { perm: 'adg.edit' });
  r.delete('/api/adg/systems/:id', async (req, res, x) => { await repo.remove('adg_systems', x.params.id); return { success: true }; }, { perm: 'adg.edit' });

  // ---------- 业务手册：data/handbooks 下的 xlsx / csv，每个 sheet 可检索 ----------
  const HB = path.join(config.DATA_DIR, 'handbooks');
  const loadBook = (file) => {
    const abs = path.join(HB, path.basename(file));
    if (!fs.existsSync(abs)) throw new HttpError(404, '手册不存在');
    return /\.csv$/i.test(abs) ? [{ name: 'Sheet1', rows: parseCsv(fs.readFileSync(abs, 'utf8')) }] : readXlsx(fs.readFileSync(abs));
  };
  r.get('/api/handbook/list', async () => {
    if (!fs.existsSync(HB)) return { success: true, handbooks: [], dir: HB };
    const handbooks = fs.readdirSync(HB).filter((f) => /\.(xlsx|csv)$/i.test(f)).map((file) => {
      try { return { file, name: file.replace(/\.(xlsx|csv)$/i, ''), sheets: loadBook(file).map((s) => s.name) }; } catch (e) { return { file, name: file, sheets: [], error: e.message }; }
    });
    return { success: true, handbooks, dir: HB };
  });
  r.get('/api/handbook/view', async (req, res, x) => {
    const sheets = loadBook(x.query.file || '');
    const s = sheets.find((z) => z.name === x.query.sheet) || sheets[0] || { rows: [] };
    const [headers = [], ...rows] = s.rows;
    const kw = String(x.query.q || '').trim();
    const hit = kw ? rows.filter((rw) => rw.some((v) => String(v).includes(kw))) : rows;
    return { success: true, sheet: s.name, headers: headers.map(String), rows: hit.slice(0, Number(x.query.limit || 300)).map((rw) => rw.map((v) => (v == null ? '' : String(v)))), total: hit.length };
  });

  // ---------- 数据查看：浏览本地运营表 ----------
  r.get('/api/dataview', async () => ({ items: VIEWABLE.map((k) => ({ key: k, title: OPS[k].comment, source: 'local' })) }));
  r.get('/api/dataview/:key', async (req, res, x) => {
    const key = x.params.key;
    if (!VIEWABLE.includes(key)) return { error: '不支持的表' };
    const rows = await repo.find(key, {}, { order: 'id DESC', limit: Math.min(Number(x.query.limit || 200), 2000) });
    const columns = Object.keys(OPS[key].cols).filter((c) => c !== 'stored_path');
    return { source: 'local', title: OPS[key].comment, columns, row_count: await repo.count(key), rows: rows.map((rw) => columns.map((c) => (rw[c] != null && typeof rw[c] === 'object' ? JSON.stringify(rw[c]) : rw[c]))) };
  });
}

module.exports = { register };
