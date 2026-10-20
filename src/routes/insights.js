'use strict';
// 数据洞察：对分析库表做“学习”（字段画像 + 自动图表 + 结论），沉淀为可检索、可收藏、可跟进的洞察资产。
// 学习流程（无大模型也可用）：
//   1) 取行数与每列 distinct / 空值率 → columns_meta
//   2) 识别时间列（date/datetime）→ 按月计数趋势图；识别低基数分类列（distinct ≤ 30）→ Top10 分布图
//   3) 规则化结论：数据量、时间覆盖、最近一月环比、集中度（Top1 占比）、空值率异常
//   4) 配置了大模型时，把画像交给大模型补充业务结论
const { tables: ATABLES } = require('../analytics/schema');

const THEME = { dwd_warning: ['warning_cluster', '预警聚集'], dwd_vehicle_access: ['warranty', '质保/接入'], dwd_mileage_adjust: ['data_quality', '数据质量'], dws_shipment: ['fault_predict', '出货/批次'] };

function register(r, { repo, analytics, ai, HttpError }) {
  const A = analytics;
  const short = (full) => String(full).split('.').pop();
  const catalog = async () => (await A.listTables()).map((t) => ({ db: t.full_name.includes('.') ? t.full_name.split('.')[0] : (A.driver === 'demo' ? 'demo' : 'default'), table: t.name, name: t.name, full_name: t.full_name, desc: t.comment, table_desc: t.comment, rows: t.rows, field_count: t.columns.length, columns: t.columns }));

  async function learn(tableName, user, report = () => {}) {
    const cat = await catalog();
    const t = cat.find((c) => c.table === short(tableName) || c.full_name === tableName);
    if (!t) throw new HttpError(404, `分析库中没有表 ${tableName}`);
    const q = A.db.dialect.quote;
    const T = t.full_name.includes('.') ? t.full_name : q(t.full_name);
    const queries = [];
    const run = async (sql, purpose) => { const rows = await A.db.all(sql); queries.push({ sql, purpose, verdict: 'ok', ts: new Date().toISOString() }); return rows; };
    report({ current: 0, total: 4, thought: `统计 ${t.table} 行数与字段画像…` });
    const total = Number(((await run(`SELECT COUNT(*) AS n FROM ${T}`, '总行数'))[0] || {}).n || 0);
    const columns_meta = [];
    for (const c of t.columns) {
      const s = (await run(`SELECT COUNT(DISTINCT ${q(c.name)}) AS d, SUM(CASE WHEN ${q(c.name)} IS NULL OR ${q(c.name)} = '' THEN 1 ELSE 0 END) AS nul FROM ${T}`, `字段画像 ${c.name}`))[0] || {};
      const nullRate = total ? Math.round(Number(s.nul || 0) / total * 1000) / 10 : 0;
      columns_meta.push({ col: c.name, type: c.type, comment: c.comment, distinct: Number(s.d || 0), null_rate: nullRate, issues: nullRate > 30 ? [`空值率 ${nullRate}%`] : [] });
    }
    report({ current: 1, total: 4, thought: '生成图表…' });
    const charts = []; const conclusions = [];
    const dateCol = t.columns.find((c) => c.type === 'date' || c.type === 'datetime');
    let timeRange = '';
    if (dateCol) {
      const col = q(dateCol.name);
      const rg = (await run(`SELECT MIN(${col}) AS a, MAX(${col}) AS b FROM ${T}`, '时间范围'))[0] || {};
      timeRange = `${String(rg.a || '').slice(0, 10)} ~ ${String(rg.b || '').slice(0, 10)}`;
      const m = await run(`SELECT ${A.db.dialect.month(col)} AS m, COUNT(*) AS n FROM ${T} GROUP BY ${A.db.dialect.month(col)} ORDER BY m`, '按月趋势');
      const last = m.slice(-12);
      charts.push({ title: `${dateCol.comment || dateCol.name} 按月记录数`, type: 'line', labels: last.map((x) => x.m), values: last.map((x) => Number(x.n)), unit: '条' });
      if (last.length >= 3) {
        const [p, c] = [Number(last[last.length - 3].n), Number(last[last.length - 2].n)];
        const ch = p ? Math.round((c - p) / p * 100) : 0;
        conclusions.push({ level: Math.abs(ch) >= 20 ? '重点' : '一般', title: `最近完整月环比 ${ch >= 0 ? '+' : ''}${ch}%`, body: `${last[last.length - 2].m} 共 ${c} 条，上月 ${p} 条。`, col: dateCol.name });
      }
    }
    for (const c of columns_meta.filter((x) => x.type === 'text' && x.distinct > 1 && x.distinct <= 30).slice(0, 3)) {
      const top = await run(`SELECT ${q(c.col)} AS k, COUNT(*) AS n FROM ${T} GROUP BY ${q(c.col)} ORDER BY n DESC LIMIT 10`, `${c.col} 分布`);
      charts.push({ title: `${c.comment || c.col} 分布 Top10`, type: 'bar', labels: top.map((x) => String(x.k)), values: top.map((x) => Number(x.n)), unit: '条' });
      const share = total ? Math.round(Number(top[0].n) / total * 100) : 0;
      if (share >= 40) conclusions.push({ level: '重点', title: `${c.comment || c.col} 高度集中`, body: `「${top[0].k}」占 ${share}%，建议关注其结构性原因。`, col: c.col });
    }
    for (const c of columns_meta.filter((x) => x.issues.length)) conclusions.push({ level: '一般', title: `字段 ${c.col} 数据质量`, body: c.issues.join('；'), col: c.col });
    conclusions.unshift({ level: '一般', title: `数据规模 ${total.toLocaleString()} 行`, body: `${t.desc}${timeRange ? '，时间覆盖 ' + timeRange : ''}。` });
    report({ current: 3, total: 4, thought: '整理结论…' });
    const llm = ai.parseJsonLoose(await ai.tryChat([
      { role: 'system', content: '你是数据分析师。根据表的字段画像和统计，补充 2-4 条业务洞察，只输出 JSON：{"conclusions":[{"level":"重点|一般","title":"…","body":"…"}]}' },
      { role: 'user', content: JSON.stringify({ table: t.table, desc: t.desc, rows: total, columns_meta, charts }).slice(0, 12000) },
    ], { json: true }));
    if (llm && Array.isArray(llm.conclusions)) conclusions.push(...llm.conclusions.map((c) => ({ ...c, source: 'llm' })));
    const data = {
      table_name: t.table, db: t.db, status: 'done', trigger_by: user.name, columns_meta, charts, conclusions,
      meta: { rows: total, count: total, time_range: timeRange, grain: dateCol ? '月' : '', key_fields: columns_meta.filter((c) => c.distinct === total && total).map((c) => c.col), desc: t.desc, queries },
    };
    const exist = await repo.findOne('insights', { table_name: t.table });
    const id = exist ? (await repo.update('insights', exist.id, data), exist.id) : await repo.insert('insights', data);
    return { ok: true, success: true, id, table_name: t.table };
  }
  const listItems = async () => (await repo.find('insights', {}, { order: 'updated_at DESC' })).map((it) => ({
    id: it.id, table_name: it.table_name, table: it.table_name, db: it.db, status: it.status, starred: !!it.starred, note: it.note, trigger_by: it.trigger_by, updated_at: it.updated_at,
    table_desc: (ATABLES[it.table_name] || {}).comment || '', field_count: (it.columns_meta || []).length,
    has_charts: !!(it.charts || []).length, has_conclusions: !!(it.conclusions || []).length,
  }));
  const toMd = (it) => [`## ${it.table_name}`, '', `- 行数：${(it.meta || {}).rows || 0}　时间覆盖：${(it.meta || {}).time_range || '-'}`, '', ...(it.conclusions || []).map((c) => `- 【${c.level}】${c.title}：${c.body}`), ''].join('\n');

  r.get('/api/insights', async () => ({ items: await listItems() }));
  r.get('/api/insights/overview', async () => {
    const items = await repo.find('insights', {});
    const cat = await catalog();
    const byDb = new Map();
    for (const it of items) { const o = byDb.get(it.db) || { db: it.db, count: 0, with_charts: 0 }; o.count++; if ((it.charts || []).length) o.with_charts++; byDb.set(it.db, o); }
    const highlights = items.flatMap((it) => (it.conclusions || []).filter((c) => c.level === '重点').map((c) => ({ level: c.level, title: c.title, table: it.table_name, body: c.body }))).slice(0, 8);
    return { total: items.length, by_db: [...byDb.values()], catalog_total: cat.length, with_charts: items.filter((i) => (i.charts || []).length).length, with_conclusions: items.filter((i) => (i.conclusions || []).length).length, highlights, recent: (await listItems()).slice(0, 5) };
  });
  r.get('/api/insights/learnable', async () => {
    const learned = new Set((await repo.find('insights', {})).map((i) => i.table_name));
    return { items: (await catalog()).map(({ columns, ...t }) => ({ ...t, learned: learned.has(t.table) })) };
  });
  r.get('/api/insights/learnable/columns', async (req, res, x) => {
    const t = (await catalog()).find((c) => c.table === short(x.query.table || ''));
    return { columns: t ? t.columns.map((c) => ({ name: c.name, col: c.name, type: c.type, comment: c.comment })) : [] };
  });
  r.get('/api/insights/assets-by-domain', async () => {
    const items = await listItems();
    const g = new Map();
    for (const it of items) { const dom = (THEME[it.table_name] || [null, '其他'])[1]; if (!g.has(dom)) g.set(dom, []); g.get(dom).push({ table_name: it.table_name, desc: it.table_desc, id: it.id }); }
    return { total: items.length, items: [...g].map(([domain, tables]) => ({ domain, tables })) };
  });
  r.post('/api/insights/learn', async (req, res, x) => ai.respondTask(x.body, (report) => learn(x.body.table_name, x.user, report)));
  r.post('/api/insights/learn-many', async (req, res, x) => ai.respondTask(x.body, async (report) => {
    const list = x.body.tables || []; let ok = 0; const errors = [];
    for (const [i, t] of list.entries()) {
      report({ current: i, total: list.length, thought: `学习 ${t}（${i + 1}/${list.length}）` });
      try { await learn(t, x.user); ok++; } catch (e) { errors.push({ table: t, error: e.message }); }
    }
    return { ok: true, success: true, total: list.length, succeeded: ok, errors };
  }));
  r.get('/api/insights/search', async (req, res, x) => {
    const kw = String(x.query.q || '').trim();
    if (!kw) return { items: [] };
    const items = [];
    for (const it of await repo.find('insights', {})) {
      const hits = [];
      for (const c of it.conclusions || []) if ((c.title + c.body).includes(kw)) hits.push(c.title);
      for (const c of it.columns_meta || []) if ((c.col + (c.comment || '')).includes(kw)) hits.push('字段 ' + c.col);
      if (it.table_name.includes(kw)) hits.push('表名');
      if (hits.length) items.push({ table: it.table_name, id: it.id, table_desc: (ATABLES[it.table_name] || {}).comment || '', matches: hits.slice(0, 5), match_count: hits.length });
    }
    return { items };
  });
  r.get('/api/insights/export', async (req, res, x) => {
    const rows = await repo.find('insights', x.query.table ? { table_name: short(x.query.table) } : {});
    if (!rows.length) return { error: '没有可导出的洞察' };
    return { filename: `数据洞察_${x.query.table ? short(x.query.table) : '汇总'}_${repo.today()}.md`, content: ['# 数据洞察', '', ...rows.map(toMd)].join('\n') };
  });
  r.post('/api/insights/report', async (req, res, x) => {
    const rows = (await repo.find('insights', {})).filter((it) => x.body.scope !== 'starred' || it.starred);
    let content = ['# 数据洞察报告', '', `生成时间：${repo.now()}`, '', ...rows.map(toMd)].join('\n');
    const llm = await ai.tryChat([{ role: 'system', content: '把以下多张表的洞察整理成一份给管理层看的中文 Markdown 报告：先给 3-5 条核心结论，再分主题展开。不要编造数字。' }, { role: 'user', content: content.slice(0, 15000) }]);
    if (llm) content = llm;
    return { success: true, content, count: rows.length, scope: x.body.scope || 'all' };
  });

  // 信号：所有“重点”结论；按表映射主题；带跟进状态
  r.get('/api/insights/signals', async () => {
    const fus = await repo.find('insight_followups', {});
    const signals = [];
    for (const it of await repo.find('insights', {})) {
      for (const c of (it.conclusions || []).filter((z) => z.level === '重点')) {
        const fu = fus.find((f) => f.table_name === it.table_name && f.title === c.title);
        signals.push({ table: it.table_name, theme: (THEME[it.table_name] || ['data_quality'])[0], severity: 'high', title: c.title, conclusions: [c], followup_status: fu ? fu.status : '', followup_id: fu ? fu.id : null, time_range: (it.meta || {}).time_range, rows: (it.meta || {}).rows, field_count: (it.columns_meta || []).length, charts: (it.charts || []).length });
      }
    }
    const themes = Object.values(THEME).map(([key, name]) => ({ key, name, count: signals.filter((s) => s.theme === key).length })).filter((t) => t.count);
    const followup_stats = {};
    for (const f of fus) followup_stats[f.status] = (followup_stats[f.status] || 0) + 1;
    return { signals, themes, followup_stats };
  });
  r.get('/api/insights/followups', async () => ({ items: (await repo.find('insight_followups', {}, { order: 'id DESC' })).map((f) => ({ ...f, signal_table: f.table_name, signal_title: f.title })) }));
  r.post('/api/insights/followups', async (req, res, x) => {
    const exist = await repo.findOne('insight_followups', { table_name: x.body.table, title: x.body.title });
    if (exist) return { success: true, id: exist.id };
    return { success: true, id: await repo.insert('insight_followups', { table_name: x.body.table, title: x.body.title, status: '待跟进', created_by: x.user.name }) };
  });
  r.put('/api/insights/followups/:id', async (req, res, x) => { await repo.update('insight_followups', x.params.id, { status: x.body.status, action_note: x.body.action_note }); return { success: true }; });
  r.delete('/api/insights/followups/:id', async (req, res, x) => { await repo.remove('insight_followups', x.params.id); return { success: true }; });

  // 同步到知识库：洞察以 Markdown 形式交给 AI 模块的知识库（若其提供 knowledge.upsert），否则只返回统计
  r.post('/api/insights/kb-sync', async () => {
    const rows = await repo.find('insights', {});
    const kb = ai.external && ai.external.knowledge && ai.external.knowledge.upsert;
    if (kb) for (const it of rows) await kb({ scope: 'analysis', title: `数据洞察：${it.table_name}`, content: toMd(it), source_type: 'insight', source_file: `insight/${it.table_name}` });
    return { success: true, tables_synced: rows.length, analysis_kb_total: rows.length, message: kb ? '' : '知识库模块未接入，仅统计' };
  });

  r.post('/api/insights/run-query', async (req, res, x) => {
    try { return { ok: true, ...(await A.readonlyQuery(x.body.sql, [], Number(x.body.max_rows || 30))) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  r.get('/api/insights/:id', async (req, res, x) => {
    const it = await repo.get('insights', x.params.id);
    if (!it) throw new HttpError(404, '洞察不存在');
    return { ...it, queries: (it.meta || {}).queries || [], columns: (it.columns_meta || []).map((c) => c.col), table_desc: (ATABLES[it.table_name] || {}).comment || '' };
  });
  r.delete('/api/insights/:id', async (req, res, x) => { await repo.remove('insights', x.params.id); return { success: true }; });
  r.post('/api/insights/:id/star', async (req, res, x) => { await repo.update('insights', x.params.id, { starred: !!Number(x.body.starred), note: x.body.note || '' }); return { success: true }; });
  // 关联候选：与本表共享字段的其他表，按共享字段数打分
  r.get('/api/insights/:id/related', async (req, res, x) => {
    const it = await repo.get('insights', x.params.id);
    if (!it) throw new HttpError(404, '洞察不存在');
    const mine = new Set(Object.keys((ATABLES[it.table_name] || {}).cols || {}));
    const items = (await catalog()).filter((t) => t.table !== it.table_name).map((t) => {
      const shared = t.columns.map((c) => c.name).filter((c) => mine.has(c));
      return { full_name: t.full_name, table: t.table, shared_cols: shared, points: shared.length * 10 + (shared.includes('vin') ? 20 : 0) };
    }).filter((t) => t.shared_cols.length).sort((a, b) => b.points - a.points);
    return { items };
  });
  // 跨表联动：按共享键关联，计算匹配率
  r.post('/api/insights/:id/ties', async (req, res, x) => ai.respondTask(x.body, async (report) => {
    const it = await repo.get('insights', x.params.id);
    if (!it) return { ok: false, error: '洞察不存在' };
    const q = A.db.dialect.quote; const joins = [];
    const mineCols = Object.keys((ATABLES[it.table_name] || {}).cols || {});
    for (const [i, full] of (x.body.related || []).entries()) {
      report({ current: i, total: (x.body.related || []).length, thought: `关联 ${full}` });
      const other = short(full);
      const key = ['vin', 'oem', 'cell_cap'].find((k) => mineCols.includes(k) && ((ATABLES[other] || {}).cols || {})[k]);
      if (!key) { joins.push({ table: other, relation: '无共享键', level: '一般', insight: '无法直接关联' }); continue; }
      const a = (await A.db.all(`SELECT COUNT(DISTINCT ${q(key)}) AS n FROM ${A.T(it.table_name)}`))[0].n;
      const b = (await A.db.all(`SELECT COUNT(DISTINCT t.${q(key)}) AS n FROM ${A.T(it.table_name)} t WHERE t.${q(key)} IN (SELECT ${q(key)} FROM ${A.T(other)})`))[0].n;
      const rate = a ? Math.round(b / a * 100) : 0;
      joins.push({ table: other, relation: `${key} 关联`, level: rate < 80 ? '重点' : '一般', insight: `${it.table_name} 中 ${rate}% 的 ${key} 能在 ${other} 中找到（${b}/${a}）。` });
    }
    await repo.update('insights', it.id, { joins });
    return { ok: true, success: true, joins };
  }));
  r.post('/api/insights/:id/ask', async (req, res, x) => {
    const it = await repo.get('insights', x.params.id);
    if (!it) return { ok: false, error: '洞察不存在' };
    const answer = await ai.tryChat([
      { role: 'system', content: '你是数据分析师，只根据给定的表画像和结论回答问题，用中文，100 字以内。' },
      { role: 'user', content: JSON.stringify({ table: it.table_name, meta: it.meta, conclusions: it.conclusions, columns: it.columns_meta }).slice(0, 10000) + '\n\n问题：' + x.body.question },
    ]);
    if (!answer) return { ok: false, error: '追问需要配置大模型（LLM_BASE_URL / LLM_MODEL）' };
    const conclusion = { level: '一般', title: `追问：${String(x.body.question).slice(0, 30)}`, body: answer, source: 'ask' };
    await repo.update('insights', it.id, { conclusions: [...(it.conclusions || []), conclusion] });
    return { ok: true, conclusion };
  });
}

module.exports = { register };
