'use strict';
// 客户需求（会议来源、审批流、AI 拆解）与内部需求池（提报 → 审批 → 完成）
const notify = require('../core/notify');
const { hasPerm } = require('../core/perms');

const DEMAND_PROMPT = `你是客户需求分析助手。把用户给的客户沟通记录拆解为若干条可执行的需求，只输出 JSON：
{"demands":[{"title":"需求标题（20 字内）","background":"背景与诉求","tags":"标签，逗号分隔","owner":"建议负责人（原文未提则留空）","priority":"高|中|低","due_date":"YYYY-MM-DD 或空"}]}`;

function ruleDemands(text) {
  const items = String(text || '').split(/\r?\n|[。；;]/).map((s) => s.trim().replace(/^[\d一二三四五六七八九十]+[.、)）]\s*|^[-*•]\s*/, ''))
    .filter((s) => s.length >= 6 && /需|要求|希望|建议|增加|新增|优化|支持|提供|改进/.test(s));
  return items.slice(0, 10).map((s) => ({
    title: s.slice(0, 20), background: s, tags: /质量|预警|故障/.test(s) ? '质量' : (/数据|报表|看板/.test(s) ? '数据' : '功能'),
    owner: '', priority: /紧急|尽快|立即|马上/.test(s) ? '高' : '中', due_date: (s.match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/) || [''])[0].replace(/[/.]/g, '-'),
  }));
}

function register(r, { repo, ai, HttpError }) {
  // ---------- 客户需求 ----------
  r.get('/api/demands', async () => {
    const meetings = new Map((await repo.find('meetings', {})).map((m) => [m.id, m]));
    return (await repo.find('demands', {}, { order: 'id DESC' })).map((d) => {
      const m = meetings.get(d.meeting_id) || {};
      return { ...d, meeting_title: m.title || '', meeting_date: m.meeting_date || '' };
    });
  });
  r.post('/api/demands', async (req, res, x) => {
    if (!x.body.title) throw new HttpError(400, '需求标题必填');
    const id = await repo.insert('demands', { status: '待审批', priority: '中', ...x.body, created_by: x.user.name });
    return { success: true, id };
  }, { perm: 'demand.edit' });
  r.put('/api/demands/:id', async (req, res, x) => {
    const patch = { ...x.body }; delete patch.status;
    if (!(await repo.update('demands', x.params.id, patch))) throw new HttpError(404, '需求不存在');
    return { success: true };
  }, { perm: 'demand.edit' });
  r.delete('/api/demands/:id', async (req, res, x) => { await repo.remove('demands', x.params.id); return { success: true }; }, { perm: 'demand.delete' });
  // 审批：approve → 已通过；reject → 已驳回；notify=true 时通知负责人
  r.post('/api/demands/:id/review', async (req, res, x) => {
    const d = await repo.get('demands', x.params.id);
    if (!d) throw new HttpError(404, '需求不存在');
    const status = x.body.action === 'approve' ? '已通过' : x.body.action === 'reject' ? '已驳回' : x.body.action === 'done' ? '已完成' : null;
    if (!status) throw new HttpError(400, 'action 只能是 approve / reject / done');
    await repo.update('demands', d.id, { status, review_comment: x.body.comment || '', reviewed_by: x.user.name, reviewed_at: repo.now() });
    let notified = null;
    if (x.body.notify && d.owner) notified = await notify.send(repo, { to: d.owner, title: `需求${status}：${d.title}`, content: x.body.comment || '' });
    return { success: true, status, message: notified ? notified.message : '' };
  }, { perm: 'demand.approve' });
  r.post('/api/demands/ai-generate', async (req, res, x) => ai.respondTask(x.body, async (report) => {
    const text = String(x.body.text || '').trim();
    if (!text) return { success: false, message: '请输入沟通记录' };
    report({ current: 0, total: 1, thought: '正在拆解需求…' });
    const out = ai.parseJsonLoose(await ai.tryChat([{ role: 'system', content: DEMAND_PROMPT }, { role: 'user', content: text.slice(0, 20000) }], { json: true }));
    const demands = (out && Array.isArray(out.demands) && out.demands.length ? out.demands : ruleDemands(text)).map((d) => ({ ...d, source_oem: x.body.source_oem || d.source_oem || '' }));
    return { success: true, demands, engine: out ? 'llm' : 'rule', message: demands.length ? '' : '未识别到需求，请补充描述' };
  }));

  // ---------- 内部需求池 ----------
  r.get('/api/demand-pool/meta', async (req, res, x) => {
    const users = await repo.find('users', { is_active: 1 }, { order: 'id' });
    const roles = new Map((await repo.find('roles', {})).map((ro) => [ro.id, ro]));
    const approvers = users.filter((u) => { const p = (roles.get(u.role_id) || {}).permissions || []; return p.includes('*') || p.includes('demand.approve'); })
      .map((u) => ({ username: u.username, name: u.name }));
    return { can_approve: hasPerm(x.user, 'demand.approve'), approvers, categories: await repo.find('demand_categories', {}, { order: 'id' }), me: { username: x.user.username, name: x.user.name } };
  });
  r.get('/api/demand-pool', async (req, res, x) => {
    const where = x.query.status ? { status: x.query.status } : {};
    let rows = await repo.find('demand_pool', where, { order: 'id DESC' });
    if (x.query.mine === '1') rows = rows.filter((d) => d.submitter === x.user.name || d.owner === x.user.name);
    return rows.map((d) => ({ ...d, title: d.description, requested_by: d.submitter, requested_name: d.submitter }));
  });
  r.post('/api/demand-pool', async (req, res, x) => {
    if (!x.body.description) throw new HttpError(400, '需求描述必填');
    return { success: true, id: await repo.insert('demand_pool', { ...x.body, status: '待审批', submitter: x.user.name }) };
  });
  r.put('/api/demand-pool/:id', async (req, res, x) => {
    const d = await repo.get('demand_pool', x.params.id);
    if (!d) throw new HttpError(404, '需求不存在');
    if (d.submitter !== x.user.name && !hasPerm(x.user, 'demand.approve')) throw new HttpError(403, '只能修改自己提报的需求');
    if (x.body._reopen) { await repo.update('demand_pool', d.id, { status: '待审批', review_comment: '' }); return { success: true }; }
    const patch = { ...x.body }; delete patch.status; delete patch.submitter;
    await repo.update('demand_pool', d.id, patch);
    return { success: true };
  });
  r.post('/api/demand-pool/:id/review', async (req, res, x) => {
    const d = await repo.get('demand_pool', x.params.id);
    if (!d) throw new HttpError(404, '需求不存在');
    const status = x.body.action === 'approve' ? '已通过' : '已驳回';
    await repo.update('demand_pool', d.id, { status, reviewer: x.user.name, review_comment: x.body.comment || '' });
    return { success: true, status };
  }, { perm: 'demand.approve' });
  r.post('/api/demand-pool/:id/complete', async (req, res, x) => {
    const d = await repo.get('demand_pool', x.params.id);
    if (!d) throw new HttpError(404, '需求不存在');
    if (d.status !== '已通过') return { success: false, message: '只有已通过的需求可以标记完成' };
    await repo.update('demand_pool', d.id, { status: '已完成', actual_date: x.body.actual_date || repo.today() });
    return { success: true };
  });
  r.delete('/api/demand-pool/:id', async (req, res, x) => {
    const d = await repo.get('demand_pool', x.params.id);
    if (!d) return { success: true };
    if (d.submitter !== x.user.name && !hasPerm(x.user, 'demand.delete')) return { success: false, message: '只能删除自己提报的需求' };
    await repo.remove('demand_pool', d.id);
    return { success: true };
  });
}

module.exports = { register, ruleDemands };
