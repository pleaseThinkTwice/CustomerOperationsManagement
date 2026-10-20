'use strict';
// 项目日志：任务树（方向 → 迭代 → 任务/子任务）、会议与行动项、待完善池、周会汇报、周报/月报导出
const { sendFile } = require('../http/router');

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// ISO 周：返回 [年, 周号]，与前端 _weekOf 一致
function isoWeek(s) {
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return null;
  const t = new Date(d); t.setDate(t.getDate() - ((d.getDay() + 6) % 7) + 3);
  const ft = new Date(t.getFullYear(), 0, 4); ft.setDate(ft.getDate() - ((ft.getDay() + 6) % 7) + 3);
  return [d.getFullYear(), 1 + Math.round((t - ft) / 604800000)];
}
// "2026-W38" → 该周周一~周日
function weekRange(yw) {
  const m = String(yw || '').match(/^(\d{4})-W(\d{1,2})$/);
  const now = new Date();
  const [y, w] = m ? [Number(m[1]), Number(m[2])] : isoWeek(fmt(now));
  const jan4 = new Date(y, 0, 4);
  const mon = new Date(jan4); mon.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (w - 1) * 7);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { yw: `${y}-W${pad(w)}`, start: fmt(mon), end: fmt(sun) };
}
const effDate = (l) => String(l.actual_date || l.due_date || l.start_date || l.meeting_date || l.created_at || '').slice(0, 10);
const OPEN = ['待办', '进行中', '暂停', '待讨论'];

function register(r, { repo, HttpError }) {
  const all = () => repo.find('devlogs', {}, { order: 'id' });
  const today = () => repo.today();

  r.get('/api/devlogs', async (req, res, x) => {
    let rows = await all();
    if (x.query.done === '1') {
      rows = rows.filter((l) => l.status === '已完成' && l.actual_date);
      if (x.query.owner) rows = rows.filter((l) => l.owner === x.query.owner);
      if (x.query.from) rows = rows.filter((l) => l.actual_date >= x.query.from);
      if (x.query.to) rows = rows.filter((l) => l.actual_date <= x.query.to);
    }
    return rows.sort((a, b) => (effDate(b) || '').localeCompare(effDate(a) || ''));
  });
  r.post('/api/devlogs', async (req, res, x) => {
    if (!x.body.title) throw new HttpError(400, '标题不能为空');
    const data = { entry_type: 'task', status: '待办', ...x.body, created_by: x.body.created_by || x.user.username };
    if (data.status === '已完成' && !data.actual_date) data.actual_date = today();
    return { success: true, id: await repo.insert('devlogs', data) };
  });
  r.put('/api/devlogs/:id', async (req, res, x) => {
    const l = await repo.get('devlogs', x.params.id);
    if (!l) throw new HttpError(404, '记录不存在');
    const patch = { ...x.body }; delete patch.created_by;
    if (patch.status === '已完成' && !patch.actual_date && !l.actual_date) patch.actual_date = today();
    if (patch.status && patch.status !== '已完成') patch.actual_date = null;
    await repo.update('devlogs', l.id, patch);
    return { success: true };
  });
  r.delete('/api/devlogs/:id', async (req, res, x) => {
    const rows = await all();
    const kill = new Set([Number(x.params.id)]);
    let grew = true;
    while (grew) { grew = false; for (const l of rows) if (l.parent_id && kill.has(l.parent_id) && !kill.has(l.id)) { kill.add(l.id); grew = true; } }
    for (const id of kill) await repo.remove('devlogs', id);
    return { success: true, deleted: kill.size };
  });

  // 树：方向 → 迭代 → 任务（递归子任务）
  r.get('/api/devlogs/tree', async () => {
    const rows = (await all()).filter((l) => l.entry_type !== 'meeting');
    const byParent = new Map();
    for (const l of rows) { const k = l.parent_id || 0; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(l); }
    const ids = new Set(rows.map((l) => l.id));
    const build = (l, depth) => ({ ...l, depth, children: (byParent.get(l.id) || []).map((c) => build(c, depth + 1)) });
    const roots = rows.filter((l) => !l.parent_id || !ids.has(l.parent_id)).map((l) => build(l, 0));
    const flat = (n) => [n, ...n.children.flatMap(flat)];
    const stat = (nodes) => { const f = nodes.flatMap(flat); const done = f.filter((t) => t.status === '已完成').length; return { total: f.length, done, doing: f.filter((t) => t.status === '进行中').length, progress: f.length ? Math.round(done / f.length * 100) : 0 }; };
    const dirs = new Map();
    for (const n of roots) {
      const dn = n.direction || '未分方向'; const it = n.iteration || '未分迭代';
      if (!dirs.has(dn)) dirs.set(dn, new Map());
      if (!dirs.get(dn).has(it)) dirs.get(dn).set(it, []);
      dirs.get(dn).get(it).push(n);
    }
    return [...dirs].map(([name, iters]) => {
      const iterations = [...iters].map(([iname, tasks]) => ({ name: iname, tasks, ...stat(tasks) }));
      return { name, iterations, ...stat(iterations.flatMap((i) => i.tasks)) };
    });
  });
  r.get('/api/devlogs/stats', async () => {
    const rows = (await all()).filter((l) => l.entry_type !== 'meeting');
    const count = (k) => { const m = {}; for (const l of rows) m[l[k] || '未填'] = (m[l[k] || '未填'] || 0) + 1; return m; };
    const st = count('status');
    return {
      total: rows.length, overdue: rows.filter((l) => OPEN.includes(l.status) && l.due_date && l.due_date < today()).length,
      by_status: Object.entries(st).map(([label, value]) => ({ label, value })), by_owner: count('owner'),
    };
  });
  // 有记录的周列表（倒序）
  r.get('/api/devlogs/weekly', async () => {
    const keys = new Map();
    for (const l of await all()) { const w = isoWeek(effDate(l)); if (w) keys.set(w.join('-'), w); }
    const weeks = [...keys.values()].sort((a, b) => b[0] - a[0] || b[1] - a[1]).map((w) => {
      const rg = weekRange(`${w[0]}-W${pad(w[1])}`);
      return { key: w, label: `${w[0]} 第${w[1]}周`, start: rg.start, end: rg.end };
    });
    return { weeks };
  });

  // ---------- 待完善池 ----------
  r.get('/api/devlogs/todo', async () => repo.find('devlog_todos', {}, { order: 'id DESC' }));
  r.post('/api/devlogs/todo', async (req, res, x) => {
    if (!x.body.title) throw new HttpError(400, '标题必填');
    return { success: true, id: await repo.insert('devlog_todos', { status: '待完善', ...x.body, created_by: x.body.created_by || x.user.username }) };
  });
  r.put('/api/devlogs/todo/:id', async (req, res, x) => { await repo.update('devlog_todos', x.params.id, x.body); return { success: true }; });
  r.delete('/api/devlogs/todo/:id', async (req, res, x) => { await repo.remove('devlog_todos', x.params.id); return { success: true }; });
  r.get('/api/devlogs/todo/export', async (req, res) => {
    const rows = await repo.find('devlog_todos', {}, { order: 'status, id' });
    const md = ['# 待完善清单', '', `导出时间：${repo.now()}`, '', '| # | 标题 | 状态 | 优先级 | 来源 | 客户 | 详情 |', '|---|---|---|---|---|---|---|',
      ...rows.map((t, i) => `| ${i + 1} | ${t.title} | ${t.status || ''} | ${t.priority || ''} | ${t.source || ''} | ${t.oem || ''} | ${String(t.detail || '').replace(/\n/g, ' ')} |`)].join('\n');
    sendFile(res, Buffer.from(md, 'utf8'), { filename: `待完善清单_${repo.today()}.md`, mime: 'text/markdown; charset=utf-8' });
  });

  // ---------- 周会汇报 ----------
  r.get('/api/devlogs/weekly-brief', async (req, res, x) => {
    const rg = weekRange(x.query.yw);
    const rows = await all();
    const tasks = rows.filter((l) => l.entry_type !== 'meeting');
    const inWeek = (s) => s && s >= rg.start && s <= rg.end;
    const done = tasks.filter((l) => l.status === '已完成' && inWeek(l.actual_date));
    const doing = tasks.filter((l) => l.status === '进行中');
    const todo = tasks.filter((l) => ['待办', '暂停'].includes(l.status) && l.due_date && l.due_date <= rg.end);
    const overdue = tasks.filter((l) => OPEN.includes(l.status) && l.due_date && l.due_date < rg.end && l.due_date < today());
    const group = (k) => {
      const m = new Map();
      for (const l of [...done, ...doing, ...todo]) { const key = l[k] || (k === 'direction' ? '未分方向' : '未指派'); const o = m.get(key) || { [k]: key, done: 0, total: 0 }; o.total++; if (l.status === '已完成') o.done++; m.set(key, o); }
      return [...m.values()];
    };
    const demands = (await repo.find('demands', {})).filter((d) => !['已完成', '已驳回'].includes(d.status));
    const cs = new Map((await repo.find('customers', {})).map((c) => [c.oem, c.oem_ch]));
    const warnings = (await repo.find('warnings', { closure_status: '未闭环' })).map((w) => ({ id: w.id, closure_status: w.closure_status, failure_mode: w.failure_mode, customer: cs.get(w.oem) || w.oem, count: w.warning_count, owner: w.owner || '' }));
    return {
      yw: rg.yw, start: rg.start, end: rg.end,
      summary: { total: done.length + doing.length + todo.length, done: done.length, doing: doing.length, todo: todo.length, overdue: overdue.length },
      done, doing, todo, overdue, dirs: group('direction'), owners: group('owner'),
      meetings: rows.filter((l) => l.entry_type === 'meeting' && inWeek(l.meeting_date || effDate(l))).map((m) => ({ id: m.id, title: m.title, owner: m.created_by, date: m.meeting_date })),
      demands, warnings, todos: (await repo.find('devlog_todos', {})).filter((t) => t.status !== '已完成'),
    };
  });
  r.get('/api/devlogs/weekly-meeting', async (req, res, x) => {
    const rg = weekRange(x.query.yw);
    const n = await repo.findOne('weekly_meetings', { yw: rg.yw });
    return n ? { ...n, exists: true } : { yw: rg.yw, agenda: '', recap: '', risks: '', blockers: '', next_plan: '', exists: false };
  });
  r.put('/api/devlogs/weekly-meeting', async (req, res, x) => {
    const rg = weekRange(x.body.yw);
    const data = { yw: rg.yw, agenda: x.body.agenda, recap: x.body.recap, risks: x.body.risks, blockers: x.body.blockers, next_plan: x.body.next_plan };
    const n = await repo.findOne('weekly_meetings', { yw: rg.yw });
    if (n) await repo.update('weekly_meetings', n.id, data); else await repo.insert('weekly_meetings', data);
    return { success: true };
  });
  r.get('/api/devlogs/weekly-meeting/export', async (req, res, x) => {
    const rg = weekRange(x.query.yw);
    const n = (await repo.findOne('weekly_meetings', { yw: rg.yw })) || {};
    const md = [`# 周会纪要 ${rg.yw}（${rg.start} ~ ${rg.end}）`, '', '## 议程', n.agenda || '-', '', '## 上周回顾', n.recap || '-', '', '## 风险', n.risks || '-', '', '## 阻塞', n.blockers || '-', '', '## 下周计划', n.next_plan || '-'].join('\n');
    sendFile(res, Buffer.from(md, 'utf8'), { filename: `周会纪要_${rg.yw}.md`, mime: 'text/markdown; charset=utf-8' });
  });
  // 周会上认领：kind = demand | warning | todo | task
  r.post('/api/devlogs/weekly-claim', async (req, res, x) => {
    const table = { demand: 'demands', warning: 'warnings', todo: 'devlog_todos', task: 'devlogs' }[x.body.kind];
    if (!table) throw new HttpError(400, '未知类型');
    await repo.update(table, x.body.id, { owner: x.body.owner || x.user.name });
    return { success: true };
  });

  // ---------- 导出 ----------
  const mdTable = (rows) => ['| 标题 | 责任人 | 状态 | 开始 | 截止 | 完成 |', '|---|---|---|---|---|---|', ...rows.map((l) => `| ${l.title} | ${l.owner || ''} | ${l.status || ''} | ${l.start_date || ''} | ${l.due_date || ''} | ${l.actual_date || ''} |`)].join('\n');
  r.get('/api/devlogs/report', async (req, res, x) => {
    const month = x.query.kind === 'month';
    const now = new Date();
    const start = month ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01` : weekRange().start;
    const rows = (await all()).filter((l) => l.entry_type !== 'meeting');
    const done = rows.filter((l) => l.status === '已完成' && l.actual_date >= start);
    const doing = rows.filter((l) => l.status === '进行中');
    const late = rows.filter((l) => OPEN.includes(l.status) && l.due_date && l.due_date < today());
    const md = [`# 项目${month ? '月' : '周'}报（${start} ~ ${today()}）`, '', `完成 ${done.length} 项，进行中 ${doing.length} 项，逾期 ${late.length} 项。`, '', '## 本期完成', mdTable(done), '', '## 进行中', mdTable(doing), '', '## 逾期', mdTable(late)].join('\n');
    sendFile(res, Buffer.from(md, 'utf8'), { filename: `项目${month ? '月' : '周'}报_${today()}.md`, mime: 'text/markdown; charset=utf-8' });
  });
  r.get('/api/devlogs/export-md', async (req, res) => {
    const rows = await all();
    const md = ['# 项目记录', '', `导出时间：${repo.now()}`, '', '## 任务', mdTable(rows.filter((l) => l.entry_type !== 'meeting')), '', '## 会议',
      ...rows.filter((l) => l.entry_type === 'meeting').map((m) => `### ${m.meeting_date || ''} ${m.title}\n参会：${m.attendees || ''}\n\n${m.minutes || ''}\n`)].join('\n');
    sendFile(res, Buffer.from(md, 'utf8'), { filename: `项目记录_${today()}.md`, mime: 'text/markdown; charset=utf-8' });
  });
  // 会议纪要导出 Word：生成 Word 可直接打开的 HTML 文档（.doc）
  r.get('/api/devlogs/:id/meeting-export', async (req, res, x) => {
    const m = await repo.get('devlogs', x.params.id);
    if (!m) throw new HttpError(404, '记录不存在');
    const acts = (await all()).filter((l) => l.parent_id === m.id);
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    const html = `<html><head><meta charset="utf-8"><title>${esc(m.title)}</title></head><body style="font-family:宋体">
<h2>${esc(m.title)}</h2><p>时间：${esc(m.meeting_date)} ${esc(m.meeting_time)}　地点：${esc(m.meeting_location)}</p><p>参会：${esc(m.attendees)}</p>
<h3>议题</h3><p>${esc(m.topics)}</p><h3>纪要</h3><p>${esc(m.minutes)}</p>
<h3>行动项</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>事项</th><th>责任人</th><th>截止</th><th>状态</th></tr>${acts.map((a) => `<tr><td>${esc(a.title)}</td><td>${esc(a.owner)}</td><td>${esc(a.due_date)}</td><td>${esc(a.status)}</td></tr>`).join('')}</table></body></html>`;
    sendFile(res, Buffer.from(html, 'utf8'), { filename: `${m.title}.doc`, mime: 'application/msword' });
  });
  // 导入到运营会议纪要（meetings 表）；已导入过时返回 409，merge=true 时覆盖更新
  r.post('/api/devlogs/:id/to-operations-meeting', async (req, res, x) => {
    const m = await repo.get('devlogs', x.params.id);
    if (!m || m.entry_type !== 'meeting') throw new HttpError(404, '会议记录不存在');
    if (!x.body.oem) throw new HttpError(400, '请选择归属客户');
    const exist = await repo.findOne('meetings', { source_devlog_id: m.id });
    if (exist && !x.body.merge) throw new HttpError(409, '该会议已导入过运营会议纪要，勾选“合并”可覆盖更新', { meeting_id: exist.id });
    const data = { oem: x.body.oem, title: m.title, meeting_date: m.meeting_date, purpose: m.topics, participants_internal: m.attendees, recorder: m.created_by, source_devlog_id: m.id, created_by: x.user.name };
    const mid = exist ? (await repo.update('meetings', exist.id, data), exist.id) : await repo.insert('meetings', data);
    await repo.removeWhere('meeting_consensus', { meeting_id: mid });
    const lines = String(m.minutes || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const [i, content] of lines.entries()) await repo.insert('meeting_consensus', { meeting_id: mid, content, sort_order: i });
    await repo.removeWhere('tasks', { meeting_id: mid });
    for (const a of (await all()).filter((l) => l.parent_id === m.id)) {
      await repo.insert('tasks', { meeting_id: mid, task_description: a.title, owner: a.owner, planned_date: a.due_date, status: a.status === '已完成' ? '已完成' : '待处理', actual_date: a.actual_date });
    }
    return { success: true, meeting_id: mid, merged: !!exist };
  });
}

module.exports = { register, isoWeek, weekRange };
