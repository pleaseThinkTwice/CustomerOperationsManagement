'use strict';
// 合同台账（主合同/补充协议树）、统计、附件、Excel 导入导出
const files = require('../core/files');
const { readTable, rowsToObjects, writeXlsx } = require('../core/xlsx');
const { sendFile } = require('../http/router');

const COLS = [
  ['contract_no', '合同编号'], ['title', '合同名称'], ['oem', '客户'], ['contract_type', '合同类型'], ['status', '状态'],
  ['sign_date', '签订日期'], ['start_date', '开始日期'], ['end_date', '结束日期'], ['amount', '金额'], ['currency', '币种'],
  ['their_company', '对方公司'], ['their_signer', '对方签署人'], ['payment_terms', '付款条件'], ['important_notes', '重要条款'], ['remark', '备注'],
  ['parent_no', '主合同编号'],
];
const INLINE = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.txt'];

function register(r, { repo, HttpError }) {
  const list = async (q = {}) => {
    let rows = await repo.find('contracts', {}, { order: 'sign_date DESC, id DESC' });
    const subCount = new Map();
    for (const c of rows) if (c.parent_id) subCount.set(c.parent_id, (subCount.get(c.parent_id) || 0) + 1);
    if (q.oem) rows = rows.filter((c) => c.oem === q.oem);
    if (q.status) rows = rows.filter((c) => c.status === q.status);
    if (q.kw) rows = rows.filter((c) => [c.contract_no, c.title, c.their_company, c.remark].some((v) => String(v || '').includes(q.kw)));
    return rows.map(({ stored_path, ...c }) => ({ ...c, sub_count: subCount.get(c.id) || 0, has_file: !!stored_path }));
  };
  r.get('/api/contracts', async (req, res, x) => list(x.query));
  r.get('/api/contracts/stats', async () => {
    const rows = await repo.find('contracts', {});
    const sum = (key) => {
      const m = new Map();
      for (const c of rows) m.set(c[key] || '未填', (m.get(c[key] || '未填') || 0) + Number(c.amount || 0));
      return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    };
    const cnt = new Map();
    for (const c of rows) cnt.set(c.status || '未填', (cnt.get(c.status || '未填') || 0) + 1);
    return {
      total: rows.length, total_amount: rows.reduce((s, c) => s + Number(c.amount || 0), 0),
      by_status: [...cnt].map(([label, value]) => ({ label, value })), by_type: sum('contract_type'), by_oem: sum('oem').slice(0, 10),
    };
  });
  r.post('/api/contracts', async (req, res, x) => {
    if (!x.body.title) throw new HttpError(400, '合同名称不能为空');
    return { success: true, id: await repo.insert('contracts', { currency: 'CNY', ...x.body, parent_id: x.body.parent_id || null }) };
  }, { perm: 'contract.edit' });
  r.put('/api/contracts/:id', async (req, res, x) => {
    const patch = { ...x.body, parent_id: x.body.parent_id || null };
    if (String(patch.parent_id) === String(x.params.id)) throw new HttpError(400, '不能把自己设为主合同');
    if (!(await repo.update('contracts', x.params.id, patch))) throw new HttpError(404, '合同不存在');
    return { success: true };
  }, { perm: 'contract.edit' });
  r.delete('/api/contracts/:id', async (req, res, x) => {
    const c = await repo.get('contracts', x.params.id);
    if (!c) return { success: true };
    if (await repo.count('contracts', { parent_id: c.id })) return { success: false, error: '请先删除其下的补充协议' };
    files.remove(c.stored_path);
    await repo.remove('contracts', c.id);
    return { success: true };
  }, { perm: 'contract.edit' });

  r.post('/api/contracts/:id/file', async (req, res, x) => {
    const c = await repo.get('contracts', x.params.id);
    if (!c) throw new HttpError(404, '合同不存在');
    const f = (x.files || [])[0];
    if (!f) throw new HttpError(400, '请选择文件');
    files.remove(c.stored_path);
    const s = files.save('contracts', f);
    await repo.update('contracts', c.id, { file_name: f.filename, stored_path: s.stored_path, file_size: s.file_size });
    return { success: true };
  }, { perm: 'contract.edit' });
  r.get('/api/contracts/:id/file-info', async (req, res, x) => {
    const c = await repo.get('contracts', x.params.id);
    if (!c || !c.stored_path) return { has_file: false, message: '该合同无附件' };
    const ext = (c.file_name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    return { has_file: true, file_name: c.file_name, ext, size: c.file_size, can_inline: INLINE.includes(ext), view_url: `/api/contracts/${c.id}/file`, unc_link: '', unc_only: false, file_path: '' };
  });
  r.get('/api/contracts/:id/file', async (req, res, x) => {
    const c = await repo.get('contracts', x.params.id);
    const buf = c && files.read(c.stored_path);
    if (!buf) throw new HttpError(404, '附件不存在');
    sendFile(res, buf, { filename: c.file_name, mime: files.mimeOf(c.file_name), inline: x.query.download !== '1' });
  });

  r.get('/api/contracts/export', async (req, res) => {
    const rows = await list();
    const byId = new Map(rows.map((c) => [c.id, c]));
    const sheet = [COLS.map((c) => c[1]), ...rows.map((c) => COLS.map(([k]) => (k === 'parent_no' ? ((byId.get(c.parent_id) || {}).contract_no || '') : (c[k] == null ? '' : c[k]))))];
    sendFile(res, writeXlsx([{ name: '合同台账', rows: sheet }]), { filename: `合同台账_${repo.today()}.xlsx`, mime: files.mimeOf('.xlsx') });
  });
  // 导入：按合同编号新增或更新；“主合同编号”列用来挂补充协议
  r.post('/api/contracts/import', async (req, res, x) => {
    const f = (x.files || [])[0];
    if (!f) throw new HttpError(400, '请选择 Excel/CSV 文件');
    const map = Object.fromEntries(COLS.map(([k, v]) => [v, k]));
    const rows = rowsToObjects(readTable(f.buffer, f.filename), map);
    let added = 0; let updated = 0; const pending = [];
    for (const rw of rows) {
      if (!rw.title && !rw.contract_no) continue;
      const { parent_no: parentNo, ...data } = rw;
      const exist = rw.contract_no ? await repo.findOne('contracts', { contract_no: String(rw.contract_no) }) : null;
      const id = exist ? (await repo.update('contracts', exist.id, data), exist.id) : await repo.insert('contracts', { currency: 'CNY', ...data });
      if (exist) updated++; else added++;
      if (parentNo) pending.push([id, String(parentNo)]);
    }
    for (const [id, no] of pending) { const p = await repo.findOne('contracts', { contract_no: no }); if (p) await repo.update('contracts', id, { parent_id: p.id }); }
    return { success: true, added, updated, message: `新增 ${added} 条，更新 ${updated} 条` };
  }, { perm: 'contract.edit' });
}

module.exports = { register };
