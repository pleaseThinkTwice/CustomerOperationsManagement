'use strict';
// 我的待办：汇总当前登录人名下的 会议任务 / 认领预警 / 需求池事项
const DONE = ['已完成', '已闭环', '已通过'];

function register(r, { repo }) {
  r.get('/api/workbench/my_todos', async (req, res, x) => {
    const me = x.user.name;
    const items = [];
    const meetings = new Map((await repo.find('meetings', {})).map((m) => [m.id, m]));
    for (const t of await repo.find('tasks', { owner: me }, { order: 'planned_date' })) {
      const m = meetings.get(t.meeting_id) || {};
      const overdue = t.status !== '已完成' && t.planned_date && t.planned_date < repo.today();
      items.push({ kind: 'meeting_task', id: t.id, title: t.task_description, status: overdue ? '已逾期' : (t.status || '待处理'), raw_status: t.status, actual_date: t.actual_date, meta: `${m.title || ''}${t.planned_date ? ' · 计划 ' + t.planned_date : ''}` });
    }
    for (const w of await repo.find('warnings', { owner: me })) {
      items.push({ kind: 'warning', id: w.id, title: `${w.oem} ${w.failure_mode}`, status: w.closure_status, meta: w.unclosed_reason || '' });
    }
    for (const d of await repo.find('demand_pool', {})) {
      if (d.owner !== me && d.submitter !== me) continue;
      items.push({ kind: 'pool', id: d.id, title: d.description, status: d.status, meta: d.planned_date ? '计划 ' + d.planned_date : '' });
    }
    const done = items.filter((it) => DONE.includes(it.raw_status || it.status)).length;
    return { success: true, name: x.user.name, username: x.user.username, total: items.length, done, todo: items.length - done, items };
  });
}

module.exports = { register };
