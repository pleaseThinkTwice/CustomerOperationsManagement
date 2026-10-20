'use strict';
// 首页看板：三视角（客户 / 项目 / 电芯）、旧版客户看板（fast + doris 渐进加载）、趋势、分布、车辆明细、自定义图表模块
const { writeXlsx } = require('../core/xlsx');
const { sendFile } = require('../http/router');
const files = require('../core/files');
const { daysAgo } = require('../analytics');

const VISIT_ST = (v) => (v.is_completed ? ['g', '已完成'] : (v.visit_date && v.visit_date < new Date().toISOString().slice(0, 10) ? ['r', '待拜访(已过期)'] : ['o', '待拜访']));
const EVENT_ST = { 已闭环: 'g', 处理中: 'o', 待处理: 'r' };

function register(r, { repo, analytics, ai, HttpError }) {
  const A = analytics;
  const capsOf = (q) => String(q.cell_cap || q.caps || '').split(',').map(A.capKey).filter(Boolean);

  // 质保条件：平台质保设置优先，其次数仓质保政策
  async function policyResolver(oem, caps) {
    const local = await repo.find('warranty_settings', oem ? { oem } : {});
    const remote = await A.warrantyPolicies(oem, caps);
    return (row) => {
      const key = (p) => `${p.oem || row.oem || oem}|${A.capKey(p.cell_cap)}|${p.vehicle_model}`;
      const want = `${row.oem || oem}|${A.capKey(row.cell_cap)}|${row.vehicle_model}`;
      return local.find((p) => key(p) === want) || remote.find((p) => key(p) === want) || null;
    };
  }
  async function opsBlocks(oem) {
    const persons = oem ? await repo.find('key_persons', { oem }, { order: 'id' }) : [];
    const visits = oem ? await repo.find('visit_plans', { oem }, { order: 'visit_date DESC', limit: 10 }) : [];
    const meetings = oem ? await repo.find('meetings', { oem }, { order: 'meeting_date DESC', limit: 10 }) : [];
    for (const m of meetings) {
      m.consensus = await repo.find('meeting_consensus', { meeting_id: m.id }, { order: 'sort_order' });
      m.tasks = await repo.find('tasks', { meeting_id: m.id }, { order: 'id' });
      m.task_total = m.tasks.length;
      const mat = (await repo.find('materials', { meeting_id: m.id }, { order: 'id DESC', limit: 1 }))[0];
      m.material_name = mat ? mat.filename : '';
    }
    return { persons, visits, meetings };
  }
  async function eventsOf(oem, caps) {
    let evs = await repo.find('events', oem ? { oem } : {}, { order: 'occur_at DESC', limit: 30 });
    if (caps && caps.length) evs = evs.filter((e) => !e.cell_cap || caps.includes(String(e.cell_cap)));
    return evs.slice(0, 12).map((e) => ({ id: e.id, date: e.occur_at, title: e.title, st: EVENT_ST[e.status] || 'b', desc: e.description || '', event_type: e.event_type, status: e.status }));
  }
  async function trendBlock(oem, caps) {
    const months = (await A.accessTrend(oem, caps, 'month_all')).slice(-12);
    const days = await A.accessTrend(oem, caps, 'day15');
    const years = (await A.accessTrend(oem, caps, 'year')).slice(-3);
    return {
      labels: months.map((m) => m.month.slice(2)), data: months.map((m) => m.count),
      days_labels: days.map((d) => d.month.slice(5)), days_data: days.map((d) => d.count),
      year_labels: years.map((y) => y.month), year_data: years.map((y) => y.count),
    };
  }
  const sumBy = (rows, k) => rows.reduce((s, x) => s + Number(x[k] || 0), 0);

  // ---------- 三视角 ----------
  async function customerView(oem, user) {
    const pol = await policyResolver(oem);
    const acc = await A.accessGroups(oem, [], pol, ['cell_cap', 'cell_structure']);
    const ship = await A.shipments(oem, [], ['cell_cap']);
    const shipT = await A.shipTotals(oem);
    const wk = await A.warningKpi(oem);
    const wByCap = await A.warningGroups(oem, [], ['cell_cap']);
    const prods = await A.products(oem);
    const todo = await myTodoStats(repo, user);
    const projects = [...new Set(prods.map((p) => String(p.cell_cap)))].map((cap) => {
      const p = prods.find((x) => String(x.cell_cap) === cap);
      const a = acc.filter((x) => String(x.cell_cap) === cap);
      const s = ship.find((x) => String(x.cell_cap) === cap) || {};
      const w = wByCap.find((x) => String(x.cell_cap) === cap) || {};
      const conn = sumBy(a, 'access_count'); const pack = Number(s.pack || 0);
      const capProds = prods.filter((x) => String(x.cell_cap) === cap);
      const sop = capProds.map((x) => x.sop_date).sort()[0] || '';
      const structs = [...new Set(capProds.map((x) => x.cell_structure).filter(Boolean))];
      // overdue = 过保车辆数；alarmOverdue = 外发预警超 7 天未闭环
      return { name: `${cap}Ah ${p.cell_structure}`, cap: Number(cap), cellType: p.cell_type || '', struct: structs.length > 1 ? structs : (structs[0] || ''), sop: sop.slice(0, 7), pack, conn, connRate: pack ? Math.round(conn / pack * 1000) / 10 : 0,
        packIdMiss: sumBy(a, 'pack_id_miss'), overdue: sumBy(a, 'expired_cnt'), alarmOverdue: w.overdue || 0, alarm: w.alarm || 0, closed: w.closed || 0, alarm7: w.alarm7 || 0 };
    }).sort((a, b) => b.cap - a.cap);
    const { persons, visits, meetings } = await opsBlocks(oem);
    const conn = sumBy(acc, 'access_count');
    return {
      view: 'customer', oem, cellCap: '',
      kpi: { cellShip: shipT.cell, packShip: shipT.pack, conn, packIdMiss: sumBy(acc, 'pack_id_miss'), insured: conn - sumBy(acc, 'expired_cnt'), overdue: sumBy(acc, 'expired_cnt'), alarmOverdue: wk.overdue, active: sumBy(acc, 'active30'), alarm: wk.alarm, closed: wk.closed, alarm7: wk.alarm7, closed7: wk.closed7, todoDone: todo.done, todoAll: todo.total },
      trend: await trendBlock(oem, []), projects, quality: await A.quality(oem, []), outgoingModes: await A.modes(oem, [], { outgoing: true }),
      contacts: persons.filter((p) => p.type === 'external').map((p) => ({ name: p.name, role: p.position || p.department, tel: p.phone })),
      visits: visits.map((v) => { const [st, stTxt] = VISIT_ST(v); return { t: v.subject, who: v.contact_person || v.created_by, st, stTxt, date: v.visit_date }; }),
      meetings: meetings.map((m) => ({ id: m.id, t: m.title, m: m.meeting_date })),
      events: await eventsOf(oem),
    };
  }
  async function projectView(oem, capsIn) {
    const caps = capsIn.length ? capsIn : (await A.cellCaps(oem)).slice(0, 1);
    const pol = await policyResolver(oem, caps);
    const acc = await A.accessGroups(oem, caps, pol, ['vehicle_model', 'cell_structure']);
    const shipT = await A.shipTotals(oem, caps);
    const wk = await A.warningKpi(oem, caps);
    const wByModel = await A.warningGroups(oem, caps, ['vehicle_model']);
    const prods = await A.products(oem, caps);
    const p0 = prods[0] || {};
    let ws = [];
    for (const cap of caps) ws = ws.concat(await repo.find('warranty_settings', oem ? { oem, cell_cap: cap } : { cell_cap: cap }));
    const pols = ws.length ? ws : (await A.warrantyPolicies(oem, caps)).map((p) => ({ ...p, id: null }));
    const pol0 = pols[0] || {};
    const conn = sumBy(acc, 'access_count');
    const mil = await A.mileageAdjust(oem, caps, 0, 0);
    return {
      view: 'project', oem, cellCap: caps.join(','),
      info: {
        packShip: shipT.pack, moduleShip: shipT.module, cellShip: shipT.cell, conn, access15: sumBy(acc, 'access15'), connRate: shipT.pack ? Math.round(conn / shipT.pack * 1000) / 10 : 0,
        packIdMiss: sumBy(acc, 'pack_id_miss'), insured: conn - sumBy(acc, 'expired_cnt'), overdue: sumBy(acc, 'expired_cnt'), alarmOverdue: wk.overdue, alarm: wk.alarm, closed: wk.closed, alarm7: wk.alarm7, closed7: wk.closed7,
        struct: p0.cell_structure || '', cellType: p0.cell_type || '', cap: Number(caps[0] || 0), s: p0.series_count || 0, sop: (prods.map((p) => p.sop_date).sort()[0] || '').slice(0, 7),
        qy: pol0.passenger_years ? `${pol0.passenger_years}年` : '-', qkm: pol0.passenger_mileage ? `${Math.round(pol0.passenger_mileage / 10000)}万` : '-', qsoh: pol0.passenger_soh || '-',
      },
      trend: await trendBlock(oem, caps),
      cars: acc.map((a) => { const w = wByModel.find((x) => x.vehicle_model === a.vehicle_model) || {}; return { name: a.vehicle_model, vehicle_model: a.vehicle_model, struct: a.cell_structure, conn: a.access_count, packIdMiss: a.pack_id_miss, overdue: a.expired_cnt, alarmOverdue: w.overdue || 0, alarm: w.alarm || 0 }; }),
      sohBox: await A.sohBox(oem, caps),
      warranty: pols.map((p) => ({ id: p.id, cell_cap: p.cell_cap, vehicle_model: p.vehicle_model, pn: p.pn, years: p.passenger_years, mileage: p.passenger_mileage, soh: p.passenger_soh })),
      modesDetail: await A.modes(oem, caps, { outgoing: false }), modes: await A.modes(oem, caps, { outgoing: true }), outgoingModes: await A.modes(oem, caps, { outgoing: true }),
      quality: await A.quality(oem, caps), active: sumBy(acc, 'active30'), mileage: mil.count, events: await eventsOf(oem, caps),
    };
  }
  async function cellView(capsIn) {
    const caps = capsIn.length ? capsIn : (await A.cellCaps('')).slice(0, 1);
    const pol = await policyResolver('', caps);
    const acc = await A.accessGroups('', caps, pol, ['oem']);
    const ship = await A.shipments('', caps, ['oem']);
    const wByOem = await A.warningGroups('', caps, ['oem']);
    const shipT = await A.shipTotals('', caps);
    const wk = await A.warningKpi('', caps);
    const wo = await A.workOrderGroups('', caps, ['oem']);
    const rows = acc.map((a) => {
      const s = ship.find((x) => x.oem === a.oem) || {}; const w = wByOem.find((x) => x.oem === a.oem) || {};
      const fieldWo = (wo.find((x) => x.oem === a.oem) || {}).n || 0;
      return { oem: a.oem, cap: Number(caps[0]), pack: Number(s.pack || 0), cell: Number(s.cell || 0), conn: a.access_count, packIdMiss: a.pack_id_miss, fieldWo, year: a.this_year, alarm: w.alarm || 0, closed: w.closed || 0 };
    }).sort((a, b) => b.conn - a.conn);
    const ppm = await A.ppmTrend('', caps);
    const conn = sumBy(rows, 'conn'); const fieldWo = sumBy(rows, 'fieldWo');
    return {
      view: 'cell', cellCap: caps.join(','), rows,
      // 失效率 ppm = 现场工单车辆数 ÷ 接入车辆数 × 1e6
      info: { pack: shipT.pack, cell: shipT.cell, conn, packIdMiss: sumBy(rows, 'packIdMiss'), fieldWo, alarm: wk.alarm, closed: wk.closed, ppm: conn ? Math.round(fieldWo / conn * 1e6) : 0, year: sumBy(rows, 'year'), custCount: rows.length },
      modes: await A.modes('', caps, { outgoing: false }), outgoingModes: await A.modes('', caps, { outgoing: true }),
      batches: await A.batches('', caps), risks: await A.risks('', caps), quality: await A.quality('', caps), events: await eventsOf('', caps),
      failModes: await A.failModes('', caps), sohDist: await A.sohDist('', caps), ppmLabels: ppm.labels, ppmTrend: ppm.series, pnTrace: await A.pnTrace('', caps),
    };
  }
  r.get('/api/dashboard/three_view', async (req, res, x) => {
    const view = String(x.query.view || 'customer').toLowerCase();
    const caps = capsOf(x.query);
    if (view === 'project') return projectView(x.query.oem || '', caps);
    if (view === 'cell') return cellView(caps);
    if (!x.query.oem) throw new HttpError(400, '请选择客户');
    return customerView(x.query.oem, x.user);
  });

  // ---------- 旧版客户看板：fast（本地运营数据，快）+ doris（数仓，慢），dashboard = 两者合并 ----------
  async function fast(oem, caps) {
    const { persons, visits, meetings } = await opsBlocks(oem);
    return {
      oem, cell_cap: caps.join(','),
      external_persons: persons.filter((p) => p.type === 'external'), internal_persons: persons.filter((p) => p.type !== 'external'),
      all_visits: visits.map((v) => ({ ...v, date: v.visit_date })), meetings,
    };
  }
  async function doris(oem, caps) {
    const pol = await policyResolver(oem, caps);
    const acc = await A.accessGroups(oem, caps, pol, ['cell_cap', 'cell_structure', 'vehicle_model']);
    const ship = await A.shipments(oem, caps, ['cell_cap', 'vehicle_model']);
    const ws = await repo.find('warranty_settings', { oem });
    const logic = await repo.find('warning_logic', { oem });
    const wk = await A.warningKpi(oem, caps);
    const rows = acc.map((a) => {
      const s = ship.find((x) => String(x.cell_cap) === String(a.cell_cap) && x.vehicle_model === a.vehicle_model) || {};
      const w = ws.find((x) => String(x.cell_cap) === String(a.cell_cap) && x.vehicle_model === a.vehicle_model) || {};
      const prod = Number(s.pack || 0);
      return {
        cell_cap: String(a.cell_cap), cell_structure: a.cell_structure, vehicle_model: a.vehicle_model, access_count: a.access_count,
        system_ship: prod, pack_cnt: prod, module_ship: Number(s.module || 0), module_cnt: Number(s.module || 0), cell_ship: Number(s.cell || 0), cell_cnt: Number(s.cell || 0),
        access_rate: prod ? Math.round(a.access_count / prod * 1000) / 10 : 0, warranty_total_cnt: a.access_count, expired_cnt: a.expired_cnt,
        expired_rate: a.access_count ? Math.round(a.expired_cnt / a.access_count * 1000) / 10 : 0, warranty_id: w.id || null,
        passenger_years: w.passenger_years, passenger_mileage: w.passenger_mileage, passenger_soh: w.passenger_soh,
        commercial_years: w.commercial_years, commercial_mileage: w.commercial_mileage, commercial_soh: w.commercial_soh,
      };
    });
    const fm = (await A.failureModeRows(oem, caps)).map((f) => ({ ...f, logic_text: ((logic.find((l) => String(l.cell_cap) === f.cell_cap && l.fault_type === f.fault_type)) || {}).logic_text || '' }));
    return { access_stats: { rows }, access_total: sumBy(rows, 'access_count'), failure_modes: { rows: fm }, warning_stats: { total: wk.alarm, last7: wk.alarm7, closed: wk.closed } };
  }
  r.get('/api/dashboard/fast', async (req, res, x) => fast(x.query.oem || '', capsOf(x.query)));
  r.get('/api/dashboard/doris', async (req, res, x) => doris(x.query.oem || '', capsOf(x.query)));
  r.get('/api/dashboard', async (req, res, x) => ({ ...(await fast(x.query.oem || '', capsOf(x.query))), ...(await doris(x.query.oem || '', capsOf(x.query))) }));

  // 项目详情（旧版项目视角）
  r.get('/api/dashboard/project-detail', async (req, res, x) => {
    const oems = String(x.query.oem || '').split(',').filter(Boolean);
    const caps = capsOf(x.query);
    const oem = oems.length === 1 ? oems[0] : '';
    const pol = await policyResolver(oem, caps);
    const cars = await A.accessGroups(oem, caps, pol, ['vehicle_model', 'cell_structure']);
    const wk = await A.warningKpi(oem, caps);
    const trend = await A.accessTrend(oem, caps, 'month_all');
    const c = oem ? await repo.findOne('customers', { oem }) : null;
    return {
      success: true, cust_name: c ? c.oem_ch : (oems.join('、') || '全部客户'),
      kpi: { access_total: sumBy(cars, 'access_count'), this_year: sumBy(cars, 'this_year'), warn_total: wk.alarm, warn_7d: wk.alarm7 },
      month_trend: trend.map((t) => ({ period: t.month, count: t.count })), cars,
      modes: await A.modes(oem, caps, { outgoing: true }), modes_detail: await A.failureModeRows(oem, caps),
      warranty: await repo.find('warranty_settings', oem ? { oem } : {}), warranty_settings: await A.warrantyPolicies(oem, caps),
    };
  });
  // 电芯视角（旧版）：同一容量下各客户对比
  r.get('/api/dashboard/cell', async (req, res, x) => {
    const caps = capsOf(x.query);
    if (!caps.length) throw new HttpError(400, '请选择容量');
    const pol = await policyResolver('', caps);
    const acc = await A.accessGroups('', caps, pol, ['oem']);
    const ship = await A.shipments('', caps, ['oem']);
    const w = await A.warningGroups('', caps, ['oem']);
    const top = await A.warningGroups('', caps, ['oem', 'fault_type']);
    const rows = acc.map((a) => {
      const t = top.filter((z) => z.oem === a.oem).sort((p, q) => q.alarm - p.alarm)[0] || {};
      const wo = w.find((z) => z.oem === a.oem) || {};
      return { oem: a.oem, access_total: a.access_count, ship_system: Number((ship.find((s) => s.oem === a.oem) || {}).pack || 0), this_year: a.this_year, warn_total: wo.alarm || 0, warn_7d: wo.alarm7 || 0, top_fault: t.fault_type || '', top_fault_cnt: t.alarm || 0 };
    });
    const trend = await A.accessTrend('', caps, 'month_all');
    return { success: true, rows, modes: await A.modes('', caps), month_trend: trend.map((t) => ({ period: t.month, count: t.count })) };
  });

  // ---------- 趋势 / 分布 ----------
  r.get('/api/access_trend', async (req, res, x) => {
    const g = x.query.group === 'year' ? 'year' : x.query.group === 'day15' ? 'day15' : 'month_all';
    const caps = capsOf(x.query);
    const months = await A.accessTrend(x.query.oem || '', caps, g);
    const all = await A.accessTrend(x.query.oem || '', caps, 'month_all');
    const thisMonth = (all.find((m) => m.month === new Date().toISOString().slice(0, 7)) || {}).count || 0;
    const thisYear = all.filter((m) => m.month.startsWith(String(new Date().getFullYear()))).reduce((s, m) => s + m.count, 0);
    return { success: true, months, summary: { this_month: thisMonth, this_year: thisYear, has_month: true, has_year: true } };
  });
  r.get('/api/warning_distribution', async (req, res, x) => {
    const group = ['month', 'type'].includes(x.query.group) ? x.query.group : 'month_type';
    return { success: true, group, data: await A.warningDistribution(x.query.oem || '', capsOf(x.query), group) };
  });

  // ---------- 车辆明细 ----------
  const since = (q) => q.active_since || daysAgo(30);
  r.get('/api/active_vehicles', async (req, res, x) => ({ success: true, ...(await A.activeVehicles(x.query.oem || '', capsOf(x.query), since(x.query), Number(x.query.limit || 50))) }));
  r.get('/api/mileage_adjust', async (req, res, x) => ({ success: true, ...(await A.mileageAdjust(x.query.oem || '', capsOf(x.query), Number(x.query.threshold || 0), Number(x.query.limit || 50))) }));
  r.get('/api/active_vehicles/export', async (req, res, x) => {
    const d = await A.activeVehicles(x.query.oem || '', capsOf(x.query), since(x.query), 0);
    const rows = [['VIN', '设备号', '客户', '容量', '车型', '最近上线', '累计里程km'], ...d.rows.map((v) => [v.vin, v.deviceid, v.oem, v.cell_cap, v.vehicle_model, v.last_online_date, Number(v.mileage_km || 0)])];
    sendFile(res, writeXlsx([{ name: '活跃车辆', rows }]), { filename: `活跃车辆_${x.query.oem || '全部'}_${since(x.query)}起.xlsx`, mime: files.mimeOf('.xlsx') });
  });
  r.get('/api/mileage_adjust/export', async (req, res, x) => {
    const d = await A.mileageAdjust(x.query.oem || '', capsOf(x.query), Number(x.query.threshold || 0), 0);
    const rows = [['VIN', '客户', '容量', '检测日期', '里程差'], ...d.rows.map((v) => [v.vin, v.oem, v.cell_cap, v.check_date, v.diff])];
    sendFile(res, writeXlsx([{ name: '疑似调表', rows }]), { filename: `疑似调表_${x.query.oem || '全部'}.xlsx`, mime: files.mimeOf('.xlsx') });
  });
  r.get('/api/oem_comparison', async (req, res, x) => {
    const caps = capsOf(x.query);
    if (!caps.length) return { success: false, error: '请选择容量' };
    const oems = await A.oemList();
    const rows = [];
    for (const o of await A.oemsByCap(caps.join(','))) {
      const act = await A.activeVehicles(o, caps, since(x.query), 1);
      const mil = await A.mileageAdjust(o, caps, Number(x.query.threshold || 0), 1);
      const acc = await A.countBy('dwd_vehicle_access', 'oem', { oem: o, caps });
      rows.push({ oem: o, oem_ch: ((oems.find((z) => z.oem === o)) || {}).oem_ch || o, access_count: Number((acc[0] || {}).n || 0), active_count: act.count, mileage_count: mil.count });
    }
    return { success: true, cell_cap: caps.join(','), rows: rows.sort((a, b) => b.access_count - a.access_count) };
  });

  // ---------- 自定义图表模块 ----------
  r.get('/api/dashboard/modules', async () => repo.find('dashboard_modules', {}, { order: 'sort_order, id' }));
  r.post('/api/dashboard/modules', async (req, res, x) => ({ success: true, id: await repo.insert('dashboard_modules', { ...x.body, created_by: x.user.name }) }));
  r.put('/api/dashboard/modules/:id', async (req, res, x) => { await repo.update('dashboard_modules', x.params.id, x.body); return { success: true }; });
  r.delete('/api/dashboard/modules/:id', async (req, res, x) => { await repo.remove('dashboard_modules', x.params.id); return { success: true }; });
  // AI 生成图表：把自然语言描述解析成 {title, display_type, data}；无大模型时尝试解析“名称 数值”行
  r.post('/api/dashboard/modules/ai-generate', async (req, res, x) => ai.respondTask(x.body, async (report) => {
    const text = String(x.body.text || '').trim();
    if (!text) return { success: false, message: '请描述要生成的图表' };
    report({ current: 0, total: 1, thought: '正在理解需求…' });
    const out = ai.parseJsonLoose(await ai.tryChat([
      { role: 'system', content: '把用户的图表描述转换为 JSON：{"title":"标题","display_type":"bar|line|pie|table|number","data":{"labels":["…"],"values":[数字]},"needs_clarification":false,"clarification":""}。数据不足时 needs_clarification=true 并在 clarification 里追问。只输出 JSON。' },
      { role: 'user', content: text },
    ], { json: true }));
    if (out && out.title) return { success: true, config: out };
    const pairs = [...text.matchAll(/([一-龥A-Za-z0-9_-]+)\s*[:：=\s]\s*(-?\d+(?:\.\d+)?)/g)];
    if (pairs.length >= 2) return { success: true, config: { title: text.split(/\r?\n/)[0].slice(0, 30), display_type: 'bar', data: { labels: pairs.map((p) => p[1]), values: pairs.map((p) => Number(p[2])) } } };
    return { success: true, config: { needs_clarification: true, clarification: '未配置大模型。请按「名称 数值」每行一项给出数据，例如：\n小米 120\n理想 80' } };
  }));
}

// 我的待办统计（首页 KPI 用；完整列表见 workbench）
async function myTodoStats(repo, user) {
  const name = user ? user.name : null;
  const tasks = await repo.find('tasks', name ? { owner: name } : {});
  return { total: tasks.length, done: tasks.filter((t) => t.status === '已完成').length };
}

module.exports = { register };
