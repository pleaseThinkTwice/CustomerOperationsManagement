'use strict';
// 文档管理（客户规格书/测试报告/协议）：上传、筛选、下载
const files = require('../core/files');
const { sendFile } = require('../http/router');

function register(r, { repo, analytics, HttpError }) {
  r.get('/api/documents', async (req, res, x) => {
    const where = {};
    if (x.query.oem) where.oem = x.query.oem;
    if (x.query.capacity_ah) where.capacity_ah = analytics.capKey(x.query.capacity_ah);
    if (x.query.doc_type) where.doc_type = x.query.doc_type;
    const cs = new Map((await repo.find('customers', {})).map((c) => [c.oem, c.name_cn || c.oem_ch]));
    return (await repo.find('documents', where, { order: 'upload_date DESC, id DESC' })).map(({ stored_path, ...d }) => ({ ...d, name_cn: cs.get(d.oem) || d.oem, has_file: !!stored_path }));
  });
  r.post('/api/documents/upload', async (req, res, x) => {
    const f = (x.files || [])[0];
    if (!f) throw new HttpError(400, '请选择文件');
    const b = x.fields;
    const dup = await repo.findOne('documents', { oem: b.oem || '', file_name: f.filename });
    if (dup && b.overwrite !== '1') throw new HttpError(409, `已存在同名文件「${f.filename}」`, { code: 'file_exists' });
    const s = files.save('documents', f);
    const data = { oem: b.oem || '', capacity_ah: analytics.capKey(b.capacity_ah), doc_type: b.doc_type || '其他', title: b.title || f.filename, file_name: f.filename, stored_path: s.stored_path, file_size: s.file_size, uploader: b.uploader || x.user.name, upload_date: repo.today() };
    if (dup) { files.remove(dup.stored_path); await repo.update('documents', dup.id, data); return { success: true, id: dup.id, overwritten: true }; }
    return { success: true, id: await repo.insert('documents', data) };
  });
  r.get('/api/documents/:id/download', async (req, res, x) => {
    const d = await repo.get('documents', x.params.id);
    if (!d) throw new HttpError(404, '文档不存在');
    const buf = files.read(d.stored_path) || Buffer.from(`《${d.title}》为演示占位文档，尚未上传原文件。\n`, 'utf8');
    sendFile(res, buf, { filename: d.stored_path ? d.file_name : `${d.title}.txt`, mime: d.stored_path ? files.mimeOf(d.file_name) : 'text/plain; charset=utf-8', inline: true });
  });
  r.delete('/api/documents/:id', async (req, res, x) => {
    const d = await repo.get('documents', x.params.id);
    if (d) { files.remove(d.stored_path); await repo.remove('documents', d.id); }
    return { success: true };
  });
}

module.exports = { register };
