'use strict';
// 客户档案、关键人、拜访计划、大事记、质保设置、OEM 映射，以及客户维度的数仓下拉
const fs = require('node:fs');
const path = require('node:path');
const { readTable, rowsToObjects, writeXlsx } = require('../core/xlsx');
const { sendFile } = require('../http/router');

const PERSON_HEADERS = { 类型: 'type', 姓名: 'name', 部门: 'department', 职位: 'position', 上级: 'superior', 沟通风格: 'style', 电话: 'phone', 邮箱: 'email' };

function register(r, { repo, analytics, config, HttpError }) {
  const allowed = (user) => (user.oem_perms && user.oem_perms.length && !user.perms.includes('*') ? user.oem_perms : null);
  const mustCustomer = async (oem) => {
    const c = await repo.findOne('customers', { oem });
    if (!c) throw new HttpError(404, `客户不存在：${oem}`);
    return c;
  };

  // ---------- 客户 ----------
  r.get('/api/customers/list', async (req, res, x) => {
    const lim = allowed(x.user);
    const rows = await repo.find('customers', lim ? { oem: lim } : {}, { order: 'oem' });
    return rows.map((c) => ({ oem: c.oem, oem_ch: c.oem_ch, name_cn: c.name_cn, level: c.level, relationship_status: c.relationship_status }));
  });
  r.get('/api/customers/cell_caps', async (req, res, x) => analytics.cellCaps(x.query.oem || ''));
  r.get('/api/customers/cell_products', async (req, res, x) => analytics.cellProducts(x.query.oem || ''));
  r.get('/api/customers/by_cap', async (req, res, x) => analytics.oemsByCap(x.query.cell_cap || ''));

  r.get('/api/customers', async (req, res, x) => {
    const lim = allowed(x.user);
    let rows = await repo.find('customers', lim ? { oem: lim } : {}, { order: 'oem' });
    if (x.query.name_cn) rows = rows.filter((c) => [c.name_cn, c.oem_ch, c.oem].some((v) => String(v || '').includes(x.query.name_cn)));
    if (x.query.level) rows = rows.filter((c) => c.level === x.query.level);
    const persons = await repo.find('key_persons', {}, { order: 'id' });
    return rows.map((c) => ({ ...c, key_persons: persons.filter((p) => p.oem === c.oem), visit_plans: [], agreements: [] }));
  });

  r.get('/api/customers/:oem', async (req, res, x) => {
    const c = await mustCustomer(x.params.oem);
    c.key_persons = await repo.find('key_persons', { oem: c.oem }, { order: 'id' });
    c.visit_plans = await repo.find('visit_plans', { oem: c.oem }, { order: 'visit_date DESC' });
    c.agreements = await repo.find('documents', { oem: c.oem }, { order: 'upload_date DESC' });
    return c;
  });
  r.post('/api/customers', async (req, res, x) => {
    const oem = String(x.body.oem || '').trim();
    if (!oem) throw new HttpError(400, 'OEM 不能为空');
    if (await repo.findOne('customers', { oem })) throw new HttpError(409, `客户 ${oem} 已存在`);
    await repo.insert('customers', { ...x.body, oem });
    return { success: true, oem };
  }, { perm: 'customer.edit' });
  r.put('/api/customers/:oem', async (req, res, x) => {
    const c = await mustCustomer(x.params.oem);
    const patch = { ...x.body }; delete patch.oem;
    await repo.update('customers', c.id, patch);
    return { success: true };
  }, { perm: 'customer.edit' });
  r.delete('/api/customers/:oem', async (req, res, x) => {
    const c = await mustCustomer(x.params.oem);
    for (const t of ['key_persons', 'visit_plans', 'events', 'oem_mapping']) await repo.removeWhere(t, { oem: c.oem });
    await repo.remove('customers', c.id);
    return { success: true };
  }, { perm: 'customer.edit' });

  // ---------- 关键人 ----------
  r.post('/api/key_persons', async (req, res, x) => {
    if (!x.body.oem || !x.body.name) throw new HttpError(400, '客户和姓名必填');
    const id = await repo.insert('key_persons', { type: 'external', ...x.body });
    return { success: true, id };
  }, { perm: 'customer.edit' });
  r.put('/api/key_persons/:id', async (req, res, x) => {
    const patch = { ...x.body }; delete patch.oem;
    if (!(await repo.update('key_persons', x.params.id, patch))) throw new HttpError(404, '关键人不存在');
    return { success: true };
  }, { perm: 'customer.edit' });
  r.delete('/api/key_persons/:id', async (req, res, x) => { await repo.remove('key_persons', x.params.id); return { success: true }; }, { perm: 'customer.edit' });

  r.get('/api/key_persons/template', async (req, res, x) => {
    const rows = [Object.keys(PERSON_HEADERS)];
    if (x.query.oem) for (const p of await repo.find('key_persons', { oem: x.query.oem }, { order: 'id' })) rows.push([p.type === 'internal' ? '内部' : '外部', p.name, p.department, p.position, p.superior, p.style, p.phone, p.email].map((v) => v || ''));
    else rows.push(['外部', '张三', '采购部', '采购总监', '', '务实', '138-0000-0000', 'zhangsan@example.com']);
    sendFile(res, writeXlsx([{ name: '关键人', rows }]), { filename: `关键人导入模板${x.query.oem ? '_' + x.query.oem : ''}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  });
  r.post('/api/key_persons/import', async (req, res, x) => {
    const oem = x.fields.oem || x.body.oem;
    const file = (x.files || [])[0];
    if (!oem || !file) throw new HttpError(400, '缺少客户或文件');
    await mustCustomer(oem);
    const list = rowsToObjects(readTable(file.buffer, file.filename), PERSON_HEADERS);
    let imported = 0; let updated = 0; let skipped = 0; const errors = []; const items = [];
    for (const [i, p] of list.entries()) {
      const name = String(p.name || '').trim();
      if (!name) { skipped++; errors.push(`第 ${i + 2} 行：姓名为空`); continue; }
      const type = /内/.test(String(p.type)) || p.type === 'internal' ? 'internal' : 'external';
      const data = { oem, type, name, department: p.department, position: p.position, superior: p.superior, style: p.style, phone: String(p.phone || ''), email: p.email };
      const exist = await repo.findOne('key_persons', { oem, type, name });
      if (exist) { await repo.update('key_persons', exist.id, data); updated++; items.push({ name, action: '更新' }); }
      else { await repo.insert('key_persons', data); imported++; items.push({ name, action: '新增' }); }
    }
    return { success: true, imported, updated, skipped, items, errors };
  }, { perm: 'customer.edit' });

  // ---------- 拜访计划 ----------
  r.get('/api/visit_plans', async (req, res, x) => repo.find('visit_plans', x.query.oem ? { oem: x.query.oem } : {}, { order: 'visit_date DESC' }));
  r.post('/api/visit_plans', async (req, res, x) => {
    if (!x.body.oem || !x.body.visit_date) throw new HttpError(400, '客户和拜访日期必填');
    const id = await repo.insert('visit_plans', { ...x.body, created_by: x.user.name });
    return { success: true, id };
  }, { perm: 'visit.edit' });
  r.put('/api/visit_plans/:id', async (req, res, x) => { await repo.update('visit_plans', x.params.id, x.body); return { success: true }; }, { perm: 'visit.edit' });
  r.delete('/api/visit_plans/:id', async (req, res, x) => { await repo.remove('visit_plans', x.params.id); return { success: true }; }, { perm: 'visit.edit' });

  // ---------- 大事记 ----------
  r.get('/api/events', async (req, res, x) => {
    const where = {};
    if (x.query.oem) where.oem = x.query.oem;
    let rows = await repo.find('events', where, { order: 'occur_at DESC, id DESC' });
    // scope=project 或带 cell_cap：只看该容量 + 客户级（cell_cap 为空）事件
    if (x.query.cell_cap) { const caps = String(x.query.cell_cap).split(','); rows = rows.filter((e) => !e.cell_cap || caps.includes(String(e.cell_cap))); }
    return rows;
  });
  r.post('/api/events', async (req, res, x) => {
    if (!x.body.title) throw new HttpError(400, '标题必填');
    const id = await repo.insert('events', { ...x.body, created_by: x.user.name });
    return { success: true, id };
  }, { perm: 'events.edit' });
  r.put('/api/events/:id', async (req, res, x) => { await repo.update('events', x.params.id, x.body); return { success: true }; }, { perm: 'events.edit' });
  r.delete('/api/events/:id', async (req, res, x) => { await repo.remove('events', x.params.id); return { success: true }; }, { perm: 'events.edit' });

  // ---------- 质保设置 ----------
  r.get('/api/warranty_settings', async (req, res, x) => {
    const where = {};
    if (x.query.oem) where.oem = x.query.oem;
    if (x.query.cell_cap) where.cell_cap = analytics.capKey(x.query.cell_cap);
    return repo.find('warranty_settings', where, { order: 'oem, cell_cap, vehicle_model' });
  });
  r.put('/api/warranty_settings/:id', async (req, res, x) => {
    if (!(await repo.update('warranty_settings', x.params.id, { ...x.body, source: 'manual' }))) throw new HttpError(404, '记录不存在');
    return { success: true };
  });
  // 从数仓质保政策初始化（已存在的 客户×容量×车型 不覆盖）
  r.post('/api/warranty_settings/init', async (req, res, x) => {
    const pols = await analytics.warrantyPolicies(x.query.oem || x.body.oem || '', x.query.cell_cap || x.body.cell_cap || '');
    let added = 0;
    for (const p of pols) {
      const key = { oem: p.oem, cell_cap: String(p.cell_cap), vehicle_model: p.vehicle_model };
      if (await repo.findOne('warranty_settings', key)) continue;
      await repo.insert('warranty_settings', { ...p, ...key, source: 'doris' }); added++;
    }
    return { success: true, added, total: pols.length };
  });
  // Excel 导入：读取 data/import/warranty.xlsx（列：客户/容量/车型/PN/乘用年限/乘用里程/乘用SOH/营运年限/营运里程/营运SOH），
  // 文件不存在时退化为从数仓全量初始化。force=1 覆盖已有记录。
  r.post('/api/warranty_settings/parse-excel', async (req, res, x) => {
    const file = path.join(config.DATA_DIR, 'import', 'warranty.xlsx');
    const force = x.query.force === '1';
    const policies = await analytics.warrantyPolicies('', '');
    const pnSet = new Set(policies.map((p) => p.pn));
    let rows = [];
    if (fs.existsSync(file)) {
      rows = rowsToObjects(readTable(fs.readFileSync(file), file), {
        客户: 'oem', 容量: 'cell_cap', 车型: 'vehicle_model', PN: 'pn', 乘用年限: 'passenger_years', 乘用里程: 'passenger_mileage', 乘用SOH: 'passenger_soh',
        营运年限: 'commercial_years', 营运里程: 'commercial_mileage', 营运SOH: 'commercial_soh',
      });
    } else rows = policies;
    let imported = 0; let matched = 0; let noMatch = 0;
    for (const p of rows) {
      const key = { oem: p.oem, cell_cap: analytics.capKey(p.cell_cap), vehicle_model: p.vehicle_model };
      if (pnSet.has(p.pn)) matched++; else noMatch++;
      const exist = await repo.findOne('warranty_settings', key);
      if (exist && !force) continue;
      if (exist) await repo.update('warranty_settings', exist.id, { ...p, ...key, source: 'excel' });
      else await repo.insert('warranty_settings', { ...p, ...key, source: 'excel' });
      imported++;
    }
    return { success: true, imported, pn_matched_doris: matched, pn_no_doris: noMatch, source: fs.existsSync(file) ? file : 'doris' };
  });

  // ---------- OEM 映射 ----------
  r.get('/api/oem_mapping', async (req, res, x) => repo.find('oem_mapping', x.query.oem ? { oem: x.query.oem } : {}, { order: 'oem' }));
  r.post('/api/oem_mapping', async (req, res, x) => {
    const { oem, oem_ch, cust_grp_name } = x.body;
    if (!oem || !cust_grp_name) throw new HttpError(400, 'oem 与客户组必填');
    const exist = await repo.findOne('oem_mapping', { oem, cust_grp_name });
    if (exist) return { success: true, id: exist.id };
    return { success: true, id: await repo.insert('oem_mapping', { oem, oem_ch, cust_grp_name }) };
  }, { perm: 'oem_mapping.edit' });
  r.delete('/api/oem_mapping/:id', async (req, res, x) => { await repo.remove('oem_mapping', x.params.id); return { success: true }; }, { perm: 'oem_mapping.edit' });
  r.get('/api/doris/oem_list', async () => analytics.oemList());
  r.get('/api/doris/cust_grp_list', async () => analytics.custGrpList());
}

module.exports = { register };
