'use strict';
// 预警闭环台账、外发规则、失效模式判定逻辑、AI 预警分析、阶段总结
const { writeXlsx } = require('../core/xlsx');
const { sendFile } = require('../http/router');
const files = require('../core/files');
const notify = require('../core/notify');

function register(r, { repo, analytics, ai, HttpError }) {
  const custName = async () => new Map((await repo.find('customers', {})).map((c) => [c.oem, c]));

  // ---------- 预警闭环台账 ----------
  r.get('/api/warnings', async (req, res, x) => {
    const q = x.query; const where = {};
    if (q.oem) where.oem = q.oem;
    if (q.capacity_ah) where.capacity_ah = analytics.capKey(q.capacity_ah);
    if (q.closure_status) where.closure_status = q.closure_status;
    if (q.failure_mode) where.failure_mode = q.failure_mode;
    const cs = await custName();
    const rows = (await repo.find('warnings', where, { order: 'id DESC' })).map((w) => {
      const c = cs.get(w.oem) || {};
      return { ...w, name_cn: c.name_cn || w.oem, oem_ch: c.oem_ch || w.oem };
    });
    const pageSize = Number(q.page_size || 0);
    if (!pageSize) return rows;
    const page = Math.max(1, Number(q.page || 1));
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), page, total: rows.length, pages: Math.ceil(rows.length / pageSize) || 1 };
  });
  const closeFields = (body, user, prev) => {
    const out = { ...body };
    if (out.capacity_ah != null) out.capacity_ah = analytics.capKey(out.capacity_ah);
    if (out.closure_status === '已闭环' && (!prev || prev.closure_status !== '已闭环')) { out.closed_by = out.closed_by || user.name; out.closed_at = out.closed_at || repo.today(); out.unclosed_reason = ''; }
    if (out.closure_status === '未闭环') { out.closed_by = ''; out.closed_at = null; }
    return out;
  };
  r.post('/api/warnings', async (req, res, x) => {
    if (!x.body.oem || !x.body.failure_mode) throw new HttpError(400, '客户与失效模式必填');
    return { success: true, id: await repo.insert('warnings', closeFields({ closure_status: '未闭环', ...x.body }, x.user)) };
  }, { perm: 'warning.edit' });
  r.put('/api/warnings/:id', async (req, res, x) => {
    const w = await repo.get('warnings', x.params.id);
    if (!w) throw new HttpError(404, '预警不存在');
    await repo.update('warnings', w.id, closeFields(x.body, x.user, w));
    return { success: true };
  }, { perm: 'warning.edit' });
  r.delete('/api/warnings/:id', async (req, res, x) => { await repo.remove('warnings', x.params.id); return { success: true }; }, { perm: 'warning.edit' });

  // ---------- AI 预警分析 ----------
  r.get('/api/warnings/analyses', async (req, res, x) => ({ items: await repo.find('warning_analyses', x.query.oem ? { oem: x.query.oem } : {}, { order: 'id DESC', limit: 20 }) }));
  r.post('/api/warnings/ai-analyze', async (req, res, x) => ai.respondTask(x.body, async (report) => {
    const oem = x.body.oem;
    if (!oem) return { success: false, message: '请先选择客户' };
    report({ current: 0, total: 3, thought: '汇总数仓预警口径…' });
    const kpi = await analytics.warningKpi(oem);
    const modes = await analytics.failureModeRows(oem);
    report({ current: 1, total: 3, thought: '汇总闭环台账…' });
    const ledger = await repo.find('warnings', { oem });
    const open = ledger.filter((w) => w.closure_status !== '已闭环');
    const facts = {
      客户: oem, 外发预警: kpi.alarm, 已闭环: kpi.closed, 闭环率: kpi.alarm ? Math.round(kpi.closed / kpi.alarm * 100) + '%' : '-',
      近7天外发: kpi.alarm7, 超期未闭环: kpi.overdue, 客诉: kpi.complaint,
      失效模式TOP: modes.slice(0, 5).map((m) => `${m.cell_cap}Ah ${m.fault_type} ${m.outgoing_count} 条（闭环 ${m.closed_count}）`),
      台账未闭环: open.map((w) => `${w.failure_mode}（${w.unclosed_reason || '原因未填'}）`).slice(0, 10),
    };
    report({ current: 2, total: 3, thought: '生成分析结论…' });
    let analysis = await ai.tryChat([
      { role: 'system', content: '你是动力电池客户质量分析专家。根据给定的预警统计，用中文输出：1) 总体判断 2) 重点失效模式与风险 3) 闭环短板 4) 下一步建议（3-5 条，可执行）。不要编造数据。' },
      { role: 'user', content: JSON.stringify(facts, null, 2) },
    ]);
    if (!analysis) {
      const top = facts.失效模式TOP;
      analysis = [
        `【总体】${oem} 累计外发预警 ${kpi.alarm} 条，已闭环 ${kpi.closed} 条（闭环率 ${facts.闭环率}），近 7 天新增外发 ${kpi.alarm7} 条，超期（>7 天）未闭环 ${kpi.overdue} 条，形成客诉 ${kpi.complaint} 条。`,
        `【重点失效模式】${top.length ? top.join('；') : '暂无'}。`,
        `【闭环短板】台账中未闭环 ${open.length} 项${open.length ? '：' + facts.台账未闭环.join('、') : ''}。`,
        '【建议】1) 对超期未闭环预警逐条指定责任人并设定闭环日期；2) TOP1 失效模式发起专项 8D；3) 近 7 天新增较多时复核外发阈值是否过敏；4) 客诉关联的批次纳入批次追溯。',
        '（未配置大模型，以上为规则化生成的分析）',
      ].join('\n');
    }
    await repo.insert('warning_analyses', { oem, analysis, created_by: x.user.name });
    return { success: true, analysis };
  }));

  // ---------- 外发规则 ----------
  r.get('/api/warning_rules', async () => ({ success: true, rows: await repo.find('warning_rules', {}, { order: 'top_order, id' }) }));
  r.post('/api/warning_rules/manage', async (req, res, x) => {
    if (!x.body.oem) throw new HttpError(400, '客户 OEM 必填');
    return { success: true, id: await repo.insert('warning_rules', { status: '启用', ...x.body, create_time: repo.now() }) };
  }, { perm: 'warning.edit' });
  r.put('/api/warning_rules/manage/:id', async (req, res, x) => { await repo.update('warning_rules', x.params.id, x.body); return { success: true }; }, { perm: 'warning.edit' });
  r.delete('/api/warning_rules/manage/:id', async (req, res, x) => { await repo.remove('warning_rules', x.params.id); return { success: true }; }, { perm: 'warning.edit' });

  // ---------- 失效模式判定逻辑（首页失效模式表的“外发逻辑”说明） ----------
  r.post('/api/warning_logic', async (req, res, x) => {
    const { oem, fault_type: ft, logic_text: text } = x.body;
    const cell_cap = analytics.capKey(x.body.cell_cap);
    if (!oem || !ft) throw new HttpError(400, '客户与失效模式必填');
    const exist = await repo.findOne('warning_logic', { oem, cell_cap, fault_type: ft });
    if (exist) await repo.update('warning_logic', exist.id, { logic_text: text, updated_by: x.user.name });
    else await repo.insert('warning_logic', { oem, cell_cap, fault_type: ft, logic_text: text, updated_by: x.user.name });
    return { success: true };
  }, { perm: 'warning.edit' });

  // ---------- 阶段总结 ----------
  const stageRows = async (q) => {
    let rows = await repo.find('stage_summary', q.oem ? { oem: q.oem } : {}, { order: 'summary_date DESC, id DESC' });
    if (q.start_date) rows = rows.filter((d) => d.summary_date >= q.start_date);
    if (q.end_date) rows = rows.filter((d) => d.summary_date <= q.end_date);
    const cs = await custName();
    return rows.map((d) => ({ ...d, name_cn: (cs.get(d.oem) || {}).name_cn || d.oem }));
  };
  r.get('/api/stage_summary', async (req, res, x) => stageRows(x.query));
  r.post('/api/stage_summary/:id/milestone', async (req, res, x) => {
    const d = await repo.get('stage_summary', x.params.id);
    if (!d) throw new HttpError(404, '记录不存在');
    const on = !d.is_milestone;
    await repo.update('stage_summary', d.id, { is_milestone: on, milestone_note: on ? (x.body.note || '') : '' });
    return { success: true, is_milestone: on };
  });
  // 生成本周快照：每个客户 × 失效模式，本周外发数与上周对比（口径见报告）
  r.post('/api/stage_summary/generate', async (req, res, x) => {
    const oems = x.body.oem ? [x.body.oem] : (await repo.find('customers', {})).map((c) => c.oem);
    const week = (offset) => { const d = new Date(); d.setDate(d.getDate() - d.getDay() + 1 - offset * 7); return d.toISOString().slice(0, 10); };
    const [thisStart, lastStart] = [week(0), week(1)];
    let created = 0;
    for (const oem of oems) {
      const rows = await analytics.db.all(`SELECT fault_type, SUM(CASE WHEN warning_time >= ? THEN 1 ELSE 0 END) AS cur, SUM(CASE WHEN warning_time >= ? AND warning_time < ? THEN 1 ELSE 0 END) AS prev
        FROM ${analytics.T('dwd_warning')} WHERE is_outgoing = 1 AND oem = ? GROUP BY fault_type`, [thisStart, lastStart, thisStart, oem]);
      for (const rw of rows) {
        const exist = await repo.findOne('stage_summary', { oem, summary_date: thisStart, failure_mode: rw.fault_type });
        const data = { oem, summary_date: thisStart, failure_mode: rw.fault_type, dispatch_count: Number(rw.cur || 0), reduced_breakdown: Number(rw.prev || 0) - Number(rw.cur || 0) };
        if (exist) await repo.update('stage_summary', exist.id, data); else { await repo.insert('stage_summary', data); created++; }
      }
    }
    return { success: true, created, summary_date: thisStart };
  }, { perm: 'warning.edit' });
  r.get('/api/stage_summary/export', async (req, res, x) => {
    const rows = await stageRows(x.query);
    const sheet = [['客户', '总结日期', '失效模式', '外发数', '较上期减少', '里程碑', '里程碑说明'], ...rows.map((d) => [d.name_cn, d.summary_date, d.failure_mode, d.dispatch_count, d.reduced_breakdown, d.is_milestone ? '是' : '', d.milestone_note || ''])];
    sendFile(res, writeXlsx([{ name: '阶段总结', rows: sheet }]), { filename: `阶段总结_${repo.today()}.xlsx`, mime: files.mimeOf('.xlsx') });
  });
  r.post('/api/stage_summary/email', async (req, res, x) => {
    const rows = await stageRows(x.body);
    const to = String(x.body.to || '').split(/[,;，；\s]+/).filter(Boolean);
    if (!to.length) throw new HttpError(400, '收件人必填');
    const content = rows.map((d) => `${d.summary_date} ${d.name_cn} ${d.failure_mode}：外发 ${d.dispatch_count}，较上期减少 ${d.reduced_breakdown}${d.is_milestone ? '【里程碑】' + (d.milestone_note || '') : ''}`).join('\n');
    for (const t of to) await notify.send(repo, { to: t, cc: x.body.cc, title: x.body.subject || '阶段总结', content });
    return { success: true, sent_to: to.length, records: rows.length };
  });
}

module.exports = { register };
