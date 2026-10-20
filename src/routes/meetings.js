'use strict';
// 会议纪要：会议 + 共识 + 待办任务 + 归档材料；AI 提取纪要（有大模型走大模型，否则按规则提取）
const files = require('../core/files');
const { writeXlsx, extractText } = require('../core/xlsx');
const { sendFile } = require('../http/router');
const notify = require('../core/notify');

const MEETING_PROMPT = `你是会议纪要整理助手。从用户给的会议记录原文中提取结构化信息，只输出 JSON：
{"title":"会议标题","meeting_date":"YYYY-MM-DD","purpose":"会议目的","participants_external":"客户方参会人，逗号分隔","participants_internal":"我方参会人，逗号分隔","consensus":["共识1"],"tasks":[{"task_description":"待办内容","owner":"责任人","planned_date":"YYYY-MM-DD"}]}`;

// 无大模型时的规则提取：首行作标题，识别日期、参会人、"共识/决议/结论"段、"负责/待办/行动"行
function ruleExtract(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const date = (String(text).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/) || []);
  const fmt = date.length ? `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}` : '';
  const pick = (re) => { const l = lines.find((s) => re.test(s)); return l ? l.replace(re, '').replace(/^[:：\s]+/, '') : ''; };
  const consensus = []; const tasks = []; let section = '';
  for (const l of lines.slice(1)) {
    if (/^(共识|决议|结论|会议结论)/.test(l)) { section = 'c'; const rest = l.replace(/^(共识|决议|结论|会议结论)[:：]?/, '').trim(); if (rest) consensus.push(rest); continue; }
    if (/^(待办|行动项|任务|跟进事项)/.test(l)) { section = 't'; continue; }
    const item = l.replace(/^[\d一二三四五六七八九十]+[.、)）]\s*|^[-*•]\s*/, '');
    const owner = (item.match(/(?:负责人|责任人|负责)[:：\s]*([一-龥A-Za-z]{2,8})/) || item.match(/[(（]([一-龥]{2,4})[)）]/) || [])[1] || '';
    const due = (item.match(/(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})/) || [])[1] || '';
    if (section === 't' || /负责|跟进|完成/.test(item)) tasks.push({ task_description: item, owner, planned_date: due.replace(/[/.]/g, '-') });
    else if (section === 'c') consensus.push(item);
  }
  return {
    title: (lines[0] || '会议纪要').replace(/^#+\s*/, '').slice(0, 60), meeting_date: fmt,
    purpose: pick(/^(会议目的|议题|主题)/), participants_external: pick(/^(客户方|外部参会|对方参会)/), participants_internal: pick(/^(我方|内部参会|参会人员)/),
    material_name: '', consensus, tasks,
  };
}

function register(r, { repo, ai, HttpError }) {
  async function full(m) {
    m.consensus = await repo.find('meeting_consensus', { meeting_id: m.id }, { order: 'sort_order, id' });
    m.tasks = await repo.find('tasks', { meeting_id: m.id }, { order: 'id' });
    const c = await repo.findOne('customers', { oem: m.oem });
    m.customer_name = c ? (c.oem_ch || c.name_cn) : m.oem;
    return m;
  }
  async function saveConsensus(id, list) {
    if (!Array.isArray(list)) return;
    await repo.removeWhere('meeting_consensus', { meeting_id: id });
    for (const [i, c] of list.entries()) {
      const content = typeof c === 'string' ? c : (c && c.content);
      if (content && String(content).trim()) await repo.insert('meeting_consensus', { meeting_id: id, content: String(content).trim(), sort_order: i });
    }
  }
  async function createMeeting(body, user) {
    const id = await repo.insert('meetings', { ...body, recorder: body.recorder || user.name, created_by: user.name });
    await saveConsensus(id, body.consensus || []);
    for (const t of body.tasks || []) if (t && t.task_description) await repo.insert('tasks', { meeting_id: id, status: '待处理', ...t });
    return id;
  }

  r.get('/api/meetings', async (req, res, x) => {
    const where = x.query.oem ? { oem: x.query.oem } : {};
    const all = await repo.find('meetings', where, { order: 'meeting_date DESC, id DESC' });
    const custs = new Map((await repo.find('customers', {})).map((c) => [c.oem, c.oem_ch || c.name_cn]));
    const matCount = new Map((await repo.query(null, 'SELECT meeting_id, COUNT(*) AS n FROM materials GROUP BY meeting_id')).map((m) => [m.meeting_id, Number(m.n)]));
    const taskStat = new Map((await repo.query(null, "SELECT meeting_id, COUNT(*) AS n, SUM(CASE WHEN status='已完成' THEN 1 ELSE 0 END) AS done FROM tasks GROUP BY meeting_id")).map((t) => [t.meeting_id, t]));
    const rows = all.map((m) => ({ ...m, customer_name: custs.get(m.oem) || m.oem, materials_count: matCount.get(m.id) || 0,
      task_total: Number((taskStat.get(m.id) || {}).n || 0), task_done: Number((taskStat.get(m.id) || {}).done || 0) }));
    const pageSize = Number(x.query.page_size || 0);
    if (!pageSize) return rows;
    const page = Math.max(1, Number(x.query.page || 1));
    const items = rows.slice((page - 1) * pageSize, page * pageSize);
    for (const m of items) { m.consensus = await repo.find('meeting_consensus', { meeting_id: m.id }, { order: 'sort_order, id' }); m.tasks = await repo.find('tasks', { meeting_id: m.id }, { order: 'id' }); }
    return { items, page, total: rows.length, pages: Math.ceil(rows.length / pageSize) || 1 };
  });
  r.get('/api/meetings/:id', async (req, res, x) => {
    const m = await repo.get('meetings', x.params.id);
    if (!m) throw new HttpError(404, '会议不存在');
    return full(m);
  });
  r.post('/api/meetings', async (req, res, x) => {
    if (!x.body.title) throw new HttpError(400, '会议标题必填');
    return { success: true, id: await createMeeting(x.body, x.user) };
  }, { perm: 'meeting.edit' });
  r.put('/api/meetings/:id', async (req, res, x) => {
    const m = await repo.get('meetings', x.params.id);
    if (!m) throw new HttpError(404, '会议不存在');
    const { consensus, tasks, ...rest } = x.body; void tasks;
    await repo.update('meetings', m.id, rest);
    await saveConsensus(m.id, consensus);
    return { success: true, id: m.id };
  }, { perm: 'meeting.edit' });
  r.delete('/api/meetings/:id', async (req, res, x) => {
    const id = Number(x.params.id);
    for (const mat of await repo.find('materials', { meeting_id: id })) files.remove(mat.stored_path);
    for (const t of ['materials', 'tasks', 'meeting_consensus']) await repo.removeWhere(t, { meeting_id: id });
    await repo.remove('meetings', id);
    return { success: true };
  }, { perm: 'meeting.edit' });
  r.post('/api/meetings/batch-create', async (req, res, x) => {
    let created = 0; let failed = 0; const ids = [];
    for (const m of x.body.meetings || []) {
      try { if (!m.title) throw new Error('缺标题'); ids.push(await createMeeting(m, x.user)); created++; } catch (e) { failed++; }
    }
    return { success: true, created_count: created, failed_count: failed, ids };
  }, { perm: 'meeting.edit' });

  r.get('/api/meetings/:id/export/xlsx', async (req, res, x) => {
    const m = await repo.get('meetings', x.params.id);
    if (!m) throw new HttpError(404, '会议不存在');
    await full(m);
    const sheets = [
      { name: '会议信息', rows: [['字段', '内容'], ['客户', m.customer_name], ['标题', m.title], ['日期', m.meeting_date], ['目的', m.purpose], ['客户方参会', m.participants_external], ['我方参会', m.participants_internal], ['记录人', m.recorder]] },
      { name: '共识', rows: [['序号', '共识'], ...m.consensus.map((c, i) => [i + 1, c.content])] },
      { name: '待办', rows: [['序号', '事项', '责任人', '计划日期', '状态', '实际完成'], ...m.tasks.map((t, i) => [i + 1, t.task_description, t.owner, t.planned_date, t.status, t.actual_date || ''])] },
    ];
    sendFile(res, writeXlsx(sheets), { filename: `会议纪要_${m.title}_${m.meeting_date || ''}.xlsx`, mime: files.mimeOf('.xlsx') });
  });

  // ---------- 任务 ----------
  r.get('/api/meetings/:id/tasks', async (req, res, x) => repo.find('tasks', { meeting_id: Number(x.params.id) }, { order: 'id' }));
  r.post('/api/meetings/:id/tasks', async (req, res, x) => {
    if (!x.body.task_description) throw new HttpError(400, '任务内容必填');
    const id = await repo.insert('tasks', { status: '待处理', ...x.body, meeting_id: Number(x.params.id) });
    return { success: true, id, notify: false };
  }, { perm: 'meeting.edit' });
  // 任务状态：负责人本人或有会议编辑权限的人可改
  r.put('/api/tasks/:id', async (req, res, x) => {
    const t = await repo.get('tasks', x.params.id);
    if (!t) throw new HttpError(404, '任务不存在');
    const canEdit = x.user.perms.includes('*') || x.user.perms.includes('meeting.edit');
    if (!canEdit && t.owner !== x.user.name) throw new HttpError(403, '只有责任人或会议编辑者可以修改');
    const patch = { ...x.body }; delete patch.meeting_id;
    if (patch.status === '已完成' && !patch.actual_date) patch.actual_date = repo.today();
    if (patch.status && patch.status !== '已完成') patch.actual_date = null;
    await repo.update('tasks', t.id, patch);
    return { success: true };
  });
  r.delete('/api/tasks/:id', async (req, res, x) => { await repo.remove('tasks', x.params.id); return { success: true }; }, { perm: 'meeting.edit' });
  r.post('/api/tasks/:id/notify', async (req, res, x) => {
    const t = await repo.get('tasks', x.params.id);
    if (!t) throw new HttpError(404, '任务不存在');
    const m = await repo.get('meetings', t.meeting_id);
    const r1 = await notify.send(repo, { to: t.owner, title: `会议待办提醒：${m ? m.title : ''}`, content: `${t.task_description}（计划完成 ${t.planned_date || '未定'}）` });
    return { success: r1.ok, message: r1.message };
  });
  r.post('/api/meetings/:id/notify_tasks', async (req, res, x) => {
    const m = await repo.get('meetings', x.params.id);
    if (!m) throw new HttpError(404, '会议不存在');
    const detail = [];
    for (const t of await repo.find('tasks', { meeting_id: m.id })) {
      if (t.status === '已完成') continue;
      const r1 = await notify.send(repo, { to: t.owner, title: `会议待办：${m.title}`, content: `${t.task_description}（计划 ${t.planned_date || '未定'}）` });
      detail.push({ owner: t.owner, ok: r1.ok, message: r1.message });
    }
    return { success: true, message: `已下发 ${detail.filter((d) => d.ok).length} 条通知`, detail };
  });

  // ---------- 材料 ----------
  r.get('/api/meetings/:id/materials', async (req, res, x) => (await repo.find('materials', { meeting_id: Number(x.params.id) }, { order: 'id DESC' })).map(({ stored_path, ...m }) => m));
  r.post('/api/meetings/:id/materials', async (req, res, x) => {
    const id = Number(x.params.id);
    if (!(await repo.get('meetings', id))) throw new HttpError(404, '会议不存在');
    let count = 0;
    for (const f of x.files || []) {
      const s = files.save('materials', f);
      await repo.insert('materials', { meeting_id: id, filename: f.filename, ...s, uploaded_by: x.user.name });
      count++;
    }
    if (count) await repo.update('meetings', id, { material_name: (x.files[0] || {}).filename });
    return { success: true, count };
  }, { perm: 'meeting.edit' });
  const download = async (res, mat, inline) => {
    const buf = mat && files.read(mat.stored_path);
    if (!buf) throw new HttpError(404, '文件不存在');
    sendFile(res, buf, { filename: mat.filename, mime: mat.mime || files.mimeOf(mat.filename), inline });
  };
  r.get('/api/materials/:id/download', async (req, res, x) => download(res, await repo.get('materials', x.params.id)));
  r.get('/api/meetings/:id/material', async (req, res, x) => download(res, (await repo.find('materials', { meeting_id: Number(x.params.id) }, { order: 'id DESC', limit: 1 }))[0]));
  r.delete('/api/materials/:id', async (req, res, x) => {
    const m = await repo.get('materials', x.params.id);
    if (m) { files.remove(m.stored_path); await repo.remove('materials', m.id); }
    return { success: true };
  }, { perm: 'meeting.edit' });

  // ---------- AI 提取纪要 ----------
  async function summarize(text) {
    const out = ai.parseJsonLoose(await ai.tryChat([{ role: 'system', content: MEETING_PROMPT }, { role: 'user', content: String(text).slice(0, 20000) }], { json: true }));
    if (out && out.title) return { meeting: { material_name: '', consensus: [], tasks: [], ...out }, engine: 'llm' };
    return { meeting: ruleExtract(text), engine: 'rule' };
  }
  r.post('/api/meetings/ai-summarize', async (req, res, x) => ai.respondTask(x.body, async (report) => {
    if (!String(x.body.text || '').trim()) return { success: false, message: '请粘贴会议记录原文' };
    report({ current: 0, total: 1, thought: '正在提取会议要素…' });
    const r1 = await summarize(x.body.text);
    return { success: true, meeting: r1.meeting, engine: r1.engine, message: r1.engine === 'rule' ? '未配置大模型，已按规则提取，请核对' : '' };
  }));
  r.post('/api/meetings/ai-summarize-batch', async (req, res, x) => {
    const oem = x.fields.oem || x.body.oem || '';
    const inputs = (x.files && x.files.length)
      ? x.files.map((f) => ({ filename: f.filename, text: extractText(f), oem }))
      : (x.body.texts || []).map((t) => ({ filename: t.filename, text: t.text, oem: t.oem || oem }));
    const body = { ...x.body, stream: x.body.stream || x.fields.stream };
    return ai.respondTask(body, async (report) => {
      const results = [];
      for (const [i, it] of inputs.entries()) {
        report({ current: i, total: inputs.length, thought: `正在提取：${it.filename || '第 ' + (i + 1) + ' 场'}` });
        try {
          if (!String(it.text || '').trim()) throw new Error('未能读取到文本（支持 txt / md / docx）');
          const r1 = await summarize(it.text);
          results.push({ filename: it.filename, oem: it.oem, success: true, meeting: r1.meeting });
        } catch (e) { results.push({ filename: it.filename, oem: it.oem, success: false, error: e.message }); }
      }
      return { success: true, results };
    });
  });
}

module.exports = { register, ruleExtract };
