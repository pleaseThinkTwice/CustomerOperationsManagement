'use strict';
// 端到端接口冒烟：用临时数据目录启动应用，登录后逐个调用页面会用到的接口，校验状态码与关键字段。
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cop-test-'));
process.env.DATA_DIR = DATA;
const { createApp } = require('../src/app');

let base; let cookie = ''; let server;
async function call(method, url, body, { raw } = {}) {
  const headers = { cookie };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  if (raw) return r;
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json, text };
}
const ok = async (method, url, body) => {
  const r = await call(method, url, body);
  assert.ok(r.status < 400, `${method} ${url} → ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
};

test.before(async () => {
  const app = await createApp();
  server = http.createServer(app.handle);
  await new Promise((res) => server.listen(0, res));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('未登录访问接口返回 401，首页跳登录', async () => {
  assert.strictEqual((await call('GET', '/api/me')).status, 401);
  const r = await call('GET', '/', undefined, { raw: true });
  assert.strictEqual(r.status, 302);
});

test('登录与当前用户', async () => {
  assert.strictEqual((await call('POST', '/api/login', { username: 'admin', password: 'bad' })).status, 401);
  const r = await ok('POST', '/api/login', { username: 'admin', password: 'admin123' });
  assert.ok(r.success);
  const me = await ok('GET', '/api/me');
  assert.deepStrictEqual(me.user.perms, ['*']);
  const page = await call('GET', '/', undefined, { raw: true });
  const html = await page.text();
  assert.ok(html.includes('window.__offlineMockInstalled = true'), '应注入关闭离线 mock 的开关');
});

test('看板与分析接口', async () => {
  const caps = await ok('GET', '/api/customers/cell_caps?oem=XMS');
  assert.ok(caps.includes('153'));
  const cv = await ok('GET', '/api/dashboard/three_view?view=customer&oem=XMS');
  assert.ok(cv.kpi.conn > 0 && cv.kpi.packShip > 0 && cv.projects.length);
  assert.ok(cv.quality.labels.length === 48);
  const qMode = Object.keys(cv.quality.alarm)[0];
  assert.ok(qMode && typeof cv.quality.alarm[qMode] === 'object' && !Array.isArray(cv.quality.alarm[qMode]), '质量矩阵为 {模式:{YY-MM:n}}');
  assert.ok(Object.keys(cv.quality.workorder_type['现场']).length);
  assert.ok(cv.kpi.packIdMiss > 0 && cv.kpi.overdue >= 0 && cv.projects[0].cellType);
  const pv = await ok('GET', '/api/dashboard/three_view?view=project&oem=XMS&cell_cap=153');
  assert.ok(pv.info.conn > 0 && pv.cars.length === 2);
  assert.ok(pv.sohBox.mileage.length === 8 && pv.sohBox.cycle.length === 7 && Object.keys(pv.sohBox.byPn).length);
  assert.ok(pv.warranty.every((w) => 'id' in w));
  const cell = await ok('GET', '/api/dashboard/three_view?view=cell&cell_cap=153');
  assert.ok(cell.rows.length >= 3 && cell.batches.length);
  assert.ok(cell.info.fieldWo > 0 && cell.failModes.length && cell.sohDist[0].data.length === 6 && cell.ppmTrend[0].data.length === 10 && cell.pnTrace.length);
  const fast = await ok('GET', '/api/dashboard/fast?oem=XMS');
  assert.ok(Array.isArray(fast.external_persons));
  const dor = await ok('GET', '/api/dashboard/doris?oem=XMS');
  assert.ok(dor.access_stats.rows.length && dor.failure_modes.rows.length);
  for (const g of ['month_all', 'year', 'day15']) assert.ok((await ok('GET', `/api/access_trend?oem=XMS&group=${g}`)).months.length);
  for (const g of ['month', 'type', 'month_type']) assert.ok((await ok('GET', `/api/warning_distribution?oem=XMS&group=${g}`)).data.length);
  assert.ok((await ok('GET', '/api/active_vehicles?oem=XMS&limit=5')).rows.length === 5);
  await ok('GET', '/api/mileage_adjust?oem=XMS&threshold=1&limit=5');
  assert.ok((await ok('GET', '/api/oem_comparison?cell_cap=153')).rows.length >= 3);
  assert.ok((await ok('GET', '/api/dashboard/project-detail?oem=XMS&cell_cap=153')).success);
  assert.ok((await ok('GET', '/api/dashboard/cell?cell_cap=153')).rows.length);
  assert.ok(Array.isArray(await ok('GET', '/api/customers/by_cap?cell_cap=153')));
  const ex = await call('GET', '/api/active_vehicles/export?oem=XMS', undefined, { raw: true });
  assert.strictEqual(ex.status, 200);
});

test('业务 CRUD 主流程', async () => {
  await ok('POST', '/api/customers', { oem: 'TST', oem_ch: '测试客户', name_cn: '测试客户', level: 'B级' });
  assert.ok((await ok('GET', '/api/customers/TST')).oem === 'TST');
  const kp = await ok('POST', '/api/key_persons', { oem: 'TST', name: '王五', type: 'external' });
  await ok('PUT', `/api/key_persons/${kp.id}`, { position: '经理' });
  const m = await ok('POST', '/api/meetings', { oem: 'TST', title: '测试会', meeting_date: '2026-10-01', consensus: ['共识A'] });
  const t = await ok('POST', `/api/meetings/${m.id}/tasks`, { task_description: '做事', owner: '系统管理员', planned_date: '2026-10-30' });
  await ok('PUT', `/api/tasks/${t.id}`, { status: '已完成' });
  const det = await ok('GET', `/api/meetings/${m.id}`);
  assert.strictEqual(det.consensus[0].content, '共识A');
  assert.strictEqual(det.tasks[0].status, '已完成');
  const fd = new FormData(); fd.append('files', new Blob(['hello']), '纪要.txt');
  assert.strictEqual((await ok('POST', `/api/meetings/${m.id}/materials`, fd)).count, 1);
  const mats = await ok('GET', `/api/meetings/${m.id}/materials`);
  const dl = await call('GET', `/api/materials/${mats[0].id}/download`, undefined, { raw: true });
  assert.strictEqual(await dl.text(), 'hello');
  const paged = await ok('GET', '/api/meetings?page=1&page_size=50');
  assert.ok(paged.items.length && paged.total >= 4);
  const w = await ok('POST', '/api/warnings', { oem: 'TST', failure_mode: '绝缘故障', capacity_ah: '153' });
  await ok('PUT', `/api/warnings/${w.id}`, { closure_status: '已闭环' });
  assert.ok((await ok('GET', '/api/warnings?oem=TST'))[0].closed_by);
  const d = await ok('POST', '/api/demands', { title: '需求一', source_oem: 'TST' });
  await ok('POST', `/api/demands/${d.id}/review`, { action: 'approve' });
  const c = await ok('POST', '/api/contracts', { title: '合同一', oem: 'TST', amount: 100, status: '执行中' });
  assert.ok((await ok('GET', '/api/contracts/stats')).total_amount > 100);
  const cfd = new FormData(); cfd.append('file', new Blob(['%PDF-1.4']), 'c.pdf');
  await ok('POST', `/api/contracts/${c.id}/file`, cfd);
  assert.ok((await ok('GET', `/api/contracts/${c.id}/file-info`)).has_file);
  const xl = await call('GET', '/api/contracts/export', undefined, { raw: true });
  const buf = Buffer.from(await xl.arrayBuffer());
  const imp = new FormData(); imp.append('file', new Blob([buf]), '合同.xlsx');
  const ir = await ok('POST', '/api/contracts/import', imp);
  assert.ok(ir.updated >= 1, JSON.stringify(ir));
  await ok('POST', '/api/warranty_settings/init?oem=XMS&cell_cap=153');
  assert.ok((await ok('GET', '/api/warranty_settings?oem=XMS&cell_cap=153')).length >= 2);
  await ok('DELETE', '/api/customers/TST');
});

test('AI 任务（无大模型走规则兜底）', async () => {
  const st = await ok('POST', '/api/meetings/ai-summarize', { text: '小米季度会\n2026-10-01\n共识：按期交付\n待办：\n1. 提交报告 负责人：李强 2026-10-20', stream: true });
  assert.ok(st.task_id);
  let p;
  for (let i = 0; i < 50; i++) { p = await ok('GET', `/api/task/progress/${st.task_id}`); if (p.status !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.strictEqual(p.status, 'done');
  assert.strictEqual(p.result.meeting.tasks[0].owner, '李强');
  const an = await ok('POST', '/api/warnings/ai-analyze', { oem: 'XMS' });
  assert.ok(an.analysis.includes('XMS'));
  const lr = await ok('POST', '/api/insights/learn', { table_name: 'dwd_warning' });
  assert.ok(lr.ok);
  const det = await ok('GET', `/api/insights/${lr.id}`);
  assert.ok(det.charts.length && det.conclusions.length);
});

test('其余页面 GET 接口全部可用', async () => {
  const urls = ['/api/customers/list', '/api/customers', '/api/customers/cell_products?oem=XMS', '/api/events?oem=XMS', '/api/workbench/my_todos',
    '/api/warnings?page=1&page_size=50', '/api/warnings/analyses?oem=XMS', '/api/warning_rules', '/api/stage_summary', '/api/documents', '/api/oem_mapping',
    '/api/doris/oem_list', '/api/doris/cust_grp_list', '/api/demands', '/api/demand-pool/meta', '/api/demand-pool', '/api/contracts', '/api/users',
    '/api/users/all-detail', '/api/users/1/module-perms', '/api/roles', '/api/permissions/pages', '/api/roles/1/permissions', '/api/login_logs',
    '/api/operation_logs', '/api/activity/stats?type=page', '/api/devlogs', '/api/devlogs/tree', '/api/devlogs/todo', '/api/devlogs/stats',
    '/api/devlogs/weekly', '/api/devlogs/weekly-brief', '/api/devlogs/weekly-meeting', '/api/insights', '/api/insights/overview', '/api/insights/signals',
    '/api/insights/followups', '/api/insights/learnable', '/api/insights/learnable/columns?table=dwd_warning', '/api/insights/assets-by-domain',
    '/api/insights/search?q=预警', '/api/insights/export', '/api/tools', '/api/opinions', '/api/adg/systems', '/api/handbook/list', '/api/dataview',
    '/api/dataview/customers', '/api/dashboard/modules', '/api/visit_plans'];
  for (const u of urls) await ok('GET', u);
  const tools = await ok('GET', '/api/tools');
  const run = await ok('POST', `/api/tools/${tools.items[0].id}/run`, { params: { oem: 'XMS', cell_cap: '' } });
  assert.ok(run.success && run.rows.length, JSON.stringify(run));
});

test('下载类接口返回文件', async () => {
  for (const u of ['/api/meetings/1/export/xlsx', '/api/stage_summary/export', '/api/devlogs/report?kind=week', '/api/devlogs/export-md', '/api/devlogs/todo/export', '/api/key_persons/template?oem=XMS', '/api/documents/1/download', '/api/devlogs/4/meeting-export']) {
    const r = await call('GET', u, undefined, { raw: true });
    assert.strictEqual(r.status, 200, u);
    assert.ok(/attachment|inline/.test(r.headers.get('content-disposition') || ''), u);
  }
});

test('权限：只读访客不能改客户', async () => {
  await ok('POST', '/api/logout', {});
  await ok('POST', '/api/login', { username: 'guest', password: '123456' });
  assert.strictEqual((await call('POST', '/api/customers', { oem: 'X1' })).status, 403);
  assert.strictEqual((await call('GET', '/api/users/all-detail')).status, 403);
});
