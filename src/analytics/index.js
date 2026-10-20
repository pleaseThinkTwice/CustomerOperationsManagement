'use strict';
// 分析层：所有看板/洞察口径都在这里，用一套 SQL 同时跑在本地 demo sqlite 与公司 Doris/MySQL 上。
// 业务口径（报告里同步说明）：
//   接入数 access：dwd_vehicle_access 行数（每车一行）
//   出货：dws_shipment 按 ship_level 汇总 qty；接入率 = 接入数 ÷ Pack 出货数
//   预警 alarm：dwd_warning 中 is_outgoing=1 的条数（“外发预警”）；closed：其中 is_closed=1
//   近 7 天：warning_time >= 今天-7 天；超期 overdue：外发未闭环且触发已超过 7 天
//   活跃车辆 active：last_online_date >= 指定日期（默认近 30 天）
//   在保 insured：质保起算日 + 年限未到期 且 里程未超限（年限/里程取平台质保设置，无则取数仓质保政策，再无则 8 年/不限里程）
//   过保 overdue（看板 KPI/项目/车型）：接入车辆中 质保起算日 + 年限已到期 或 里程超限 的车数；insured = 接入 − 过保
//   pack_id 缺失 packIdMiss：接入车辆中 pack_id 为空的车数
//   失效车辆 fieldWo：现场工单（dwd_work_order.wo_type='现场'）涉及的去重 VIN 数
//   失效率 ppm（电芯视角）：失效车辆 ÷ 接入车辆 × 1e6；批次 ppm：批次外发预警数 ÷ 批次出货电芯数 × 1e6；PN 追溯 ppm：PN 现场工单数 ÷ PN 出货电芯数 × 1e6
const config = require('../config');
const { openDb } = require('../db');
const { tables } = require('./schema');

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => fmtDate(new Date(Date.now() - n * 86400e3));
const num = (v) => Number(v || 0);
const capKey = (v) => String(v == null ? '' : v).replace(/\s*Ah$/i, '').trim();

async function createAnalytics() {
  const cfg = config.ANALYTICS_DB;
  const db = openDb(cfg.driver === 'mysql' ? { driver: 'mysql', url: cfg.url } : { driver: 'sqlite', file: cfg.file });
  if (cfg.driver !== 'mysql') {
    const has = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='dwd_vehicle_access'");
    if (!has) {
      const { generate } = require('./demo-data');
      const stat = await generate(db);
      console.log(`[analytics] 已生成演示数仓数据：车辆 ${stat.vehicles}，预警 ${stat.warnings}，出货 ${stat.shipments}`);
    }
  }
  const d = db.dialect;
  const T = (name) => process.env['ANALYTICS_TABLE_' + name] || (cfg.tablePrefix + name);

  // 过滤条件拼装：oem 单值、cell_cap 多值（逗号分隔）
  function filt({ oem, caps, alias = '' } = {}) {
    const a = alias ? alias + '.' : '';
    const parts = []; const params = [];
    if (oem) { parts.push(`${a}oem = ?`); params.push(oem); }
    const list = (Array.isArray(caps) ? caps : String(caps || '').split(',')).map(capKey).filter(Boolean);
    if (list.length) { parts.push(`${a}cell_cap IN (${list.map(() => '?').join(',')})`); params.push(...list); }
    return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
  }
  const all = (sql, params) => db.all(sql, params);
  const one = async (sql, params) => (await db.get(sql, params)) || {};

  const api = {
    driver: cfg.driver,
    db,
    T,
    tables,
    capKey,

    // ---------- 维度 ----------
    async oemList() { return all(`SELECT oem, oem_ch, cust_grp_name FROM ${T('dim_oem')} ORDER BY oem`); },
    async custGrpList() {
      return (await all(`SELECT o.cust_grp_name, COUNT(v.vin) AS cnt FROM ${T('dim_oem')} o LEFT JOIN ${T('dwd_vehicle_access')} v ON v.oem = o.oem GROUP BY o.cust_grp_name ORDER BY cnt DESC`))
        .map((r) => ({ cust_grp_name: r.cust_grp_name, cnt: num(r.cnt) }));
    },
    async cellCaps(oem) {
      const f = filt({ oem });
      const rows = await all(`SELECT DISTINCT cell_cap FROM ${T('dim_cell_product')} WHERE ${f.sql}`, f.params);
      return rows.map((r) => String(r.cell_cap)).sort((a, b) => Number(b) - Number(a));
    },
    async cellProducts(oem) {
      const f = filt({ oem });
      return all(`SELECT DISTINCT cell_cap, cell_structure, pn_system FROM ${T('dim_cell_product')} WHERE ${f.sql} ORDER BY cell_cap DESC`, f.params);
    },
    async oemsByCap(cap) {
      const f = filt({ caps: cap });
      return (await all(`SELECT DISTINCT oem FROM ${T('dim_cell_product')} WHERE ${f.sql} ORDER BY oem`, f.params)).map((r) => r.oem);
    },
    async products(oem, caps) {
      const f = filt({ oem, caps });
      return all(`SELECT * FROM ${T('dim_cell_product')} WHERE ${f.sql} ORDER BY cell_cap DESC, vehicle_model`, f.params);
    },
    async warrantyPolicies(oem, caps) {
      const f = filt({ oem, caps });
      return all(`SELECT * FROM ${T('dim_warranty_policy')} WHERE ${f.sql}`, f.params);
    },

    // ---------- 出货 / 接入 ----------
    async shipments(oem, caps, groupBy = ['cell_cap', 'vehicle_model']) {
      const f = filt({ oem, caps });
      const g = groupBy.join(', ');
      return all(`SELECT ${g}, SUM(CASE WHEN ship_level='pack' THEN qty ELSE 0 END) AS pack, SUM(CASE WHEN ship_level='module' THEN qty ELSE 0 END) AS module,
        SUM(CASE WHEN ship_level='cell' THEN qty ELSE 0 END) AS cell FROM ${T('dws_shipment')} WHERE ${f.sql} GROUP BY ${g}`, f.params);
    },
    async shipTotals(oem, caps) {
      const f = filt({ oem, caps });
      const r = await one(`SELECT SUM(CASE WHEN ship_level='pack' THEN qty ELSE 0 END) AS pack, SUM(CASE WHEN ship_level='module' THEN qty ELSE 0 END) AS module,
        SUM(CASE WHEN ship_level='cell' THEN qty ELSE 0 END) AS cell FROM ${T('dws_shipment')} WHERE ${f.sql}`, f.params);
      return { pack: num(r.pack), module: num(r.module), cell: num(r.cell) };
    },
    async accessGroups(oem, caps, policies, groupBy = ['cell_cap', 'cell_structure', 'vehicle_model']) {
      // 质保到期判定需要按组用不同年限/里程，所以先按 (分组 + 用途) 拿到每组的过保条件再统计
      const f = filt({ oem, caps });
      const g = groupBy.join(', ');
      const base = await all(`SELECT ${g}, usage_type, COUNT(*) AS access_count,
          SUM(CASE WHEN last_online_date >= ? THEN 1 ELSE 0 END) AS active30,
          SUM(CASE WHEN access_date >= ? THEN 1 ELSE 0 END) AS access15,
          SUM(CASE WHEN access_date >= ? THEN 1 ELSE 0 END) AS this_year,
          SUM(CASE WHEN pack_id IS NULL OR pack_id = '' THEN 1 ELSE 0 END) AS pack_id_miss
        FROM ${T('dwd_vehicle_access')} WHERE ${f.sql} GROUP BY ${g}, usage_type`, [daysAgo(30), daysAgo(15), `${new Date().getFullYear()}-01-01`, ...f.params]);
      const out = new Map();
      for (const r of base) {
        const key = groupBy.map((k) => r[k]).join('|');
        const o = out.get(key) || Object.assign(Object.fromEntries(groupBy.map((k) => [k, r[k]])), { access_count: 0, active30: 0, access15: 0, this_year: 0, pack_id_miss: 0, expired_cnt: 0 });
        o.access_count += num(r.access_count); o.active30 += num(r.active30); o.access15 += num(r.access15); o.this_year += num(r.this_year); o.pack_id_miss += num(r.pack_id_miss);
        // 过保：起算日早于 今天-年限 或 里程超限
        const pol = policies(r) || {};
        const commercial = r.usage_type === 'commercial';
        const years = num(commercial ? pol.commercial_years : pol.passenger_years) || 8;
        const km = num(commercial ? pol.commercial_mileage : pol.passenger_mileage) || 1e12;
        const cut = new Date(); cut.setFullYear(cut.getFullYear() - Math.floor(years)); cut.setDate(cut.getDate() - Math.round((years % 1) * 365));
        const ff = filt({ oem, caps });
        const keyCond = groupBy.map((k) => `${k} = ?`).join(' AND ');
        const ex = await one(`SELECT COUNT(*) AS n FROM ${T('dwd_vehicle_access')} WHERE ${ff.sql} AND ${keyCond} AND usage_type = ? AND (warranty_start_date < ? OR mileage_km > ?)`,
          [...ff.params, ...groupBy.map((k) => r[k]), r.usage_type, fmtDate(cut), km]);
        o.expired_cnt += num(ex.n);
        out.set(key, o);
      }
      return [...out.values()];
    },

    // ---------- 预警 ----------
    async warningKpi(oem, caps) {
      const f = filt({ oem, caps });
      const r = await one(`SELECT COUNT(*) AS alarm, SUM(is_closed) AS closed,
          SUM(CASE WHEN warning_time >= ? THEN 1 ELSE 0 END) AS alarm7,
          SUM(CASE WHEN warning_time >= ? AND is_closed = 1 THEN 1 ELSE 0 END) AS closed7,
          SUM(CASE WHEN is_closed = 0 AND warning_time < ? THEN 1 ELSE 0 END) AS overdue,
          SUM(is_complaint) AS complaint, COUNT(DISTINCT vin) AS vins
        FROM ${T('dwd_warning')} WHERE is_outgoing = 1 AND ${f.sql}`, [daysAgo(7), daysAgo(7), daysAgo(7), ...f.params]);
      return { alarm: num(r.alarm), closed: num(r.closed), alarm7: num(r.alarm7), closed7: num(r.closed7), overdue: num(r.overdue), complaint: num(r.complaint), vins: num(r.vins) };
    },
    async warningGroups(oem, caps, groupBy) {
      const f = filt({ oem, caps });
      const g = groupBy.join(', ');
      return (await all(`SELECT ${g}, COUNT(*) AS alarm, SUM(is_closed) AS closed,
          SUM(CASE WHEN warning_time >= ? THEN 1 ELSE 0 END) AS alarm7,
          SUM(CASE WHEN is_closed = 0 AND warning_time < ? THEN 1 ELSE 0 END) AS overdue
        FROM ${T('dwd_warning')} WHERE is_outgoing = 1 AND ${f.sql} GROUP BY ${g}`, [daysAgo(7), daysAgo(7), ...f.params]))
        .map((r) => ({ ...r, alarm: num(r.alarm), closed: num(r.closed), alarm7: num(r.alarm7), overdue: num(r.overdue) }));
    },
    // 失效模式计数：outgoing=true 只算外发；否则算全部触发
    async modes(oem, caps, { outgoing = true } = {}) {
      const f = filt({ oem, caps });
      return (await all(`SELECT fault_type AS name, COUNT(*) AS count FROM ${T('dwd_warning')} WHERE ${outgoing ? 'is_outgoing = 1 AND ' : ''}${f.sql} GROUP BY fault_type ORDER BY count DESC`, f.params))
        .map((r) => ({ name: r.name, count: num(r.count) }));
    },
    async failureModeRows(oem, caps) {
      const f = filt({ oem, caps });
      return (await all(`SELECT cell_cap, fault_type, COUNT(*) AS outgoing_count, SUM(is_closed) AS closed_count FROM ${T('dwd_warning')} WHERE is_outgoing = 1 AND ${f.sql} GROUP BY cell_cap, fault_type ORDER BY outgoing_count DESC`, f.params))
        .map((r) => ({ cell_cap: String(r.cell_cap), fault_type: r.fault_type, outgoing_count: num(r.outgoing_count), closed_count: num(r.closed_count) }));
    },
    // 质量矩阵：近 N 月（默认 48）按失效模式的 触发/闭环/客诉 + 工单（预警/批改/现场）
    // 结构：{ labels:['YY-MM'], alarm:{模式:{'YY-MM':n}}, closed, complaint, workorder, workorder_type:{类型:{模式:{'YY-MM':n}}} }
    async quality(oem, caps, monthsN = 48) {
      const months = lastMonths(monthsN);
      const labels = months.map((l) => l.slice(2));
      const f = filt({ oem, caps });
      const since = months[0] + '-01';
      const q = { labels, alarm: {}, closed: {}, complaint: {}, workorder: {}, workorder_type: { 预警: {}, 批改: {}, 现场: {} } };
      const put = (obj, mode, m, v) => { if (!v) return; const l = m.slice(2); if (!labels.includes(l)) return; (obj[mode] = obj[mode] || {})[l] = (obj[mode][l] || 0) + v; };
      const rows = await all(`SELECT ${d.month('warning_time')} AS m, fault_type, COUNT(*) AS alarm, SUM(is_closed) AS closed, SUM(is_complaint) AS complaint
        FROM ${T('dwd_warning')} WHERE is_outgoing = 1 AND warning_time >= ? AND ${f.sql} GROUP BY ${d.month('warning_time')}, fault_type`, [since, ...f.params]);
      for (const r of rows) { put(q.alarm, r.fault_type, r.m, num(r.alarm)); put(q.closed, r.fault_type, r.m, num(r.closed)); put(q.complaint, r.fault_type, r.m, num(r.complaint)); }
      const wo = await all(`SELECT ${d.month('create_time')} AS m, wo_type, fault_type, COUNT(*) AS n
        FROM ${T('dwd_work_order')} WHERE create_time >= ? AND ${f.sql} GROUP BY ${d.month('create_time')}, wo_type, fault_type`, [since, ...f.params]);
      for (const r of wo) {
        put(q.workorder, r.fault_type, r.m, num(r.n));
        if (q.workorder_type[r.wo_type]) put(q.workorder_type[r.wo_type], r.fault_type, r.m, num(r.n));
      }
      return q;
    },

    // ---------- 工单 / 失效（现场工单 = 失效车辆口径） ----------
    async workOrderGroups(oem, caps, groupBy, woType = '现场') {
      const f = filt({ oem, caps });
      const g = groupBy.join(', ');
      return (await all(`SELECT ${g}, COUNT(DISTINCT vin) AS n FROM ${T('dwd_work_order')} WHERE wo_type = ? AND ${f.sql} GROUP BY ${g}`, [woType, ...f.params]))
        .map((r) => ({ ...r, n: num(r.n) }));
    },
    // 失效模式构成：按客户 × 失效模式的现场工单车辆数
    async failModes(oem, caps) {
      const rows = await api.workOrderGroups(oem, caps, ['oem', 'fault_type']);
      const m = new Map();
      for (const r of rows) { const o = m.get(r.oem) || { oem: r.oem, counts: {} }; o.counts[r.fault_type] = r.n; m.set(r.oem, o); }
      return [...m.values()];
    },
    // PN 追溯：电芯出货（PN × 客户）对上现场工单数
    async pnTrace(oem, caps) {
      const f = filt({ oem, caps });
      const ships = await all(`SELECT pn, oem, MAX(plant) AS plant, SUM(qty) AS qty FROM ${T('dws_shipment')} WHERE ship_level = 'cell' AND pn IS NOT NULL AND ${f.sql} GROUP BY pn, oem`, f.params);
      const fails = await api.workOrderGroups(oem, caps, ['pn', 'oem']);
      const fm = new Map(fails.map((r) => [r.pn + '|' + r.oem, r.n]));
      return ships.map((s) => ({ pn: s.pn, cust: s.oem, plant: s.plant, qty: num(s.qty), failed: fm.get(s.pn + '|' + s.oem) || 0 }))
        .sort((a, b) => a.pn.localeCompare(b.pn) || a.cust.localeCompare(b.cust));
    },
    // 累计失效率走势：近 N 月每月末 累计现场工单车辆 ÷ 累计接入车辆 × 1e6，按客户
    async ppmTrend(oem, caps, monthsN = 10) {
      const months = lastMonths(monthsN);
      const f = filt({ oem, caps });
      const acc = await all(`SELECT oem, ${d.month('access_date')} AS m, COUNT(*) AS n FROM ${T('dwd_vehicle_access')} WHERE ${f.sql} GROUP BY oem, ${d.month('access_date')}`, f.params);
      const wo = await all(`SELECT oem, ${d.month('create_time')} AS m, COUNT(DISTINCT vin) AS n FROM ${T('dwd_work_order')} WHERE wo_type = '现场' AND ${f.sql} GROUP BY oem, ${d.month('create_time')}`, f.params);
      const oems = [...new Set(acc.map((r) => r.oem))].sort();
      const cum = (rows, o, m) => rows.filter((r) => r.oem === o && r.m <= m).reduce((s, r) => s + num(r.n), 0);
      return {
        labels: months.map((m) => m.slice(2)),
        series: oems.map((o) => ({ oem: o, data: months.map((m) => { const c = cum(acc, o, m); return c ? Math.round(cum(wo, o, m) / c * 1e6) : 0; }) })),
      };
    },
    // SOH 分布：按客户各 SOH 区间占比（%）
    async sohDist(oem, caps) {
      const f = filt({ oem, caps });
      const rows = await all(`SELECT oem, SUM(CASE WHEN soh < 90 THEN 1 ELSE 0 END) AS b0, SUM(CASE WHEN soh >= 90 AND soh < 92 THEN 1 ELSE 0 END) AS b1,
          SUM(CASE WHEN soh >= 92 AND soh < 94 THEN 1 ELSE 0 END) AS b2, SUM(CASE WHEN soh >= 94 AND soh < 96 THEN 1 ELSE 0 END) AS b3,
          SUM(CASE WHEN soh >= 96 AND soh < 98 THEN 1 ELSE 0 END) AS b4, SUM(CASE WHEN soh >= 98 THEN 1 ELSE 0 END) AS b5
        FROM ${T('dwd_vehicle_access')} WHERE soh IS NOT NULL AND ${f.sql} GROUP BY oem ORDER BY oem`, f.params);
      return rows.map((r) => {
        const v = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'].map((k) => num(r[k])); const t = v.reduce((a, b) => a + b, 0) || 1;
        return { oem: r.oem, data: v.map((x) => Math.round(x / t * 1000) / 10) };
      });
    },
    // SOH 箱线：按累计里程 / 累计循环分桶的 min/Q1/中位/Q3/max，整体 + 按 Pack PN
    async sohBox(oem, caps) {
      const f = filt({ oem, caps });
      const rows = await all(`SELECT pack_pn, soh, mileage_km, cycle_count FROM ${T('dwd_vehicle_access')} WHERE soh IS NOT NULL AND ${f.sql}`, f.params);
      const build = (list) => ({ mileage: boxes(list, 'mileage_km', MILEAGE_BUCKETS), cycle: boxes(list, 'cycle_count', CYCLE_BUCKETS) });
      const byPn = {};
      const groups = new Map();
      for (const r of rows) { if (!r.pack_pn) continue; (groups.get(r.pack_pn) || groups.set(r.pack_pn, []).get(r.pack_pn)).push(r); }
      for (const [pn, list] of groups) byPn[pn] = build(list);
      return { ...build(rows), byPn };
    },

    async warningDistribution(oem, caps, group) {
      const f = filt({ oem, caps });
      const since = lastMonths(12)[0] + '-01';
      if (group === 'type') {
        return (await all(`SELECT fault_type AS label, COUNT(*) AS count FROM ${T('dwd_warning')} WHERE is_outgoing = 1 AND warning_time >= ? AND ${f.sql} GROUP BY fault_type ORDER BY count DESC`, [since, ...f.params]))
          .map((r) => ({ label: r.label, count: num(r.count) }));
      }
      if (group === 'month') {
        return (await all(`SELECT ${d.month('warning_time')} AS label, COUNT(*) AS count FROM ${T('dwd_warning')} WHERE is_outgoing = 1 AND warning_time >= ? AND ${f.sql} GROUP BY ${d.month('warning_time')} ORDER BY label`, [since, ...f.params]))
          .map((r) => ({ label: r.label, count: num(r.count) }));
      }
      return (await all(`SELECT ${d.month('warning_time')} AS month, fault_type, COUNT(*) AS count FROM ${T('dwd_warning')} WHERE is_outgoing = 1 AND warning_time >= ? AND ${f.sql} GROUP BY ${d.month('warning_time')}, fault_type ORDER BY month`, [since, ...f.params]))
        .map((r) => ({ month: r.month, fault_type: r.fault_type, count: num(r.count) }));
    },
    async batches(oem, caps, limit = 8) {
      const f = filt({ oem, caps, alias: 's' });
      const ships = await all(`SELECT s.oem, s.batch_no, MAX(s.plant) AS plant, SUM(s.qty) AS qty FROM ${T('dws_shipment')} s WHERE s.ship_level = 'cell' AND ${f.sql} GROUP BY s.oem, s.batch_no`, f.params);
      const fw = filt({ oem, caps });
      const fails = await all(`SELECT oem, batch_no, COUNT(*) AS failed FROM ${T('dwd_warning')} WHERE is_outgoing = 1 AND ${fw.sql} GROUP BY oem, batch_no`, fw.params);
      const fm = new Map(fails.map((r) => [r.oem + '|' + r.batch_no, num(r.failed)]));
      return ships.map((s) => {
        const failed = fm.get(s.oem + '|' + s.batch_no) || 0; const qty = num(s.qty);
        const ppm = qty ? Math.round(failed / qty * 1e6) : 0;
        return { cust: s.oem, batch: s.batch_no, plant: s.plant, qty, failed, ppm, status: ppm >= 30 ? '预警中' : (ppm >= 10 ? '关注' : '正常') };
      }).sort((a, b) => b.ppm - a.ppm).slice(0, limit);
    },
    async risks(oem, caps, limit = 8) {
      const f = filt({ oem, caps });
      return (await all(`SELECT oem, vin, pack_no, cell_pos, fault_type, soh, is_closed, warning_time FROM ${T('dwd_warning')}
        WHERE is_outgoing = 1 AND is_closed = 0 AND ${f.sql} ORDER BY soh ASC, warning_time DESC LIMIT ${Number(limit)}`, f.params))
        .map((r) => ({ cust: r.oem, vin: r.vin, pack: r.pack_no, pos: r.cell_pos, mode: r.fault_type, soh: num(r.soh), st: num(r.soh) < 70 ? 'r' : 'o', stTxt: num(r.soh) < 70 ? '需更换' : '待核查' }));
    },

    // ---------- 趋势 ----------
    async accessTrend(oem, caps, group) {
      const f = filt({ oem, caps });
      const tv = T('dwd_vehicle_access');
      if (group === 'year') {
        return (await all(`SELECT ${d.year('access_date')} AS month, COUNT(*) AS count FROM ${tv} WHERE ${f.sql} GROUP BY ${d.year('access_date')} ORDER BY month`, f.params)).map((r) => ({ month: String(r.month), count: num(r.count) }));
      }
      if (group === 'day15') {
        const days = Array.from({ length: 15 }, (_, i) => daysAgo(14 - i));
        const rows = await all(`SELECT ${d.day('access_date')} AS day, COUNT(*) AS count FROM ${tv} WHERE access_date >= ? AND ${f.sql} GROUP BY ${d.day('access_date')}`, [days[0], ...f.params]);
        const m = new Map(rows.map((r) => [r.day, num(r.count)]));
        return days.map((x) => ({ month: x, count: m.get(x) || 0 }));
      }
      const rows = await all(`SELECT ${d.month('access_date')} AS month, COUNT(*) AS count FROM ${tv} WHERE ${f.sql} GROUP BY ${d.month('access_date')} ORDER BY month`, f.params);
      return rows.map((r) => ({ month: r.month, count: num(r.count) }));
    },

    // ---------- 车辆明细 ----------
    async activeVehicles(oem, caps, since, limit) {
      const f = filt({ oem, caps });
      const tv = T('dwd_vehicle_access');
      const c = await one(`SELECT COUNT(*) AS n FROM ${tv} WHERE last_online_date >= ? AND ${f.sql}`, [since, ...f.params]);
      const rows = await all(`SELECT vin, deviceid, oem, cell_cap, vehicle_model, last_online_date, mileage_km FROM ${tv} WHERE last_online_date >= ? AND ${f.sql} ORDER BY last_online_date DESC, vin${limit ? ' LIMIT ' + Number(limit) : ''}`, [since, ...f.params]);
      return { count: num(c.n), rows };
    },
    async mileageAdjust(oem, caps, threshold, limit) {
      const f = filt({ oem, caps });
      const tm = T('dwd_mileage_adjust');
      const c = await one(`SELECT COUNT(*) AS n FROM ${tm} WHERE mileage_diff_km >= ? AND ${f.sql}`, [threshold, ...f.params]);
      const rows = await all(`SELECT vin, oem, cell_cap, check_date, mileage_diff_km AS diff FROM ${tm} WHERE mileage_diff_km >= ? AND ${f.sql} ORDER BY mileage_diff_km DESC${limit ? ' LIMIT ' + Number(limit) : ''}`, [threshold, ...f.params]);
      return { count: num(c.n), rows: rows.map((r) => ({ ...r, diff: num(r.diff) })) };
    },
    async countBy(table, groupCol, where = {}) {
      const f = filt(where);
      return all(`SELECT ${groupCol} AS k, COUNT(*) AS n FROM ${T(table)} WHERE ${f.sql} GROUP BY ${groupCol}`, f.params);
    },

    // ---------- 通用：洞察 / 工具箱 ----------
    async listTables() {
      const out = [];
      for (const [name, t] of Object.entries(tables)) {
        let rows = null;
        try { rows = num((await one(`SELECT COUNT(*) AS n FROM ${T(name)}`)).n); } catch (e) { rows = null; }
        out.push({ name, full_name: T(name), comment: t.comment, rows, columns: Object.entries(t.cols).map(([k, v]) => ({ name: k, type: v.type, comment: v.comment })) });
      }
      return out;
    },
    // 只读 SQL：仅允许单条 SELECT/WITH，自动加 LIMIT
    async readonlyQuery(sql, params = [], maxRows = 500) {
      const s = String(sql || '').trim().replace(/;+\s*$/, '');
      if (!/^(select|with)\b/i.test(s) || s.includes(';')) throw Object.assign(new Error('只允许单条只读 SELECT 语句'), { status: 400 });
      const limited = /\blimit\s+\d+\s*$/i.test(s) ? s : `${s} LIMIT ${Number(maxRows)}`;
      const rows = await all(limited, params);
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
    },
  };
  return api;
}

const MILEAGE_BUCKETS = [['0~2万', 0, 2e4], ['2~4万', 2e4, 4e4], ['4~6万', 4e4, 6e4], ['6~8万', 6e4, 8e4], ['8~10万', 8e4, 1e5], ['10~15万', 1e5, 1.5e5], ['15~20万', 1.5e5, 2e5], ['20万+', 2e5, Infinity]];
const CYCLE_BUCKETS = [['0~100', 0, 100], ['100~200', 100, 200], ['200~300', 200, 300], ['300~500', 300, 500], ['500~800', 500, 800], ['800~1200', 800, 1200], ['1200+', 1200, Infinity]];
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)) * 10) / 10;
}
function boxes(rows, key, buckets) {
  return buckets.map(([range, lo, hi]) => {
    const v = rows.filter((r) => r[key] != null && Number(r[key]) >= lo && Number(r[key]) < hi).map((r) => Number(r.soh)).sort((a, b) => a - b);
    return { range, n: v.length, min: quantile(v, 0), q1: quantile(v, 0.25), median: quantile(v, 0.5), q3: quantile(v, 0.75), max: quantile(v, 1) };
  });
}

function lastMonths(n) {
  const out = []; const now = new Date();
  for (let i = n - 1; i >= 0; i--) { const x = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push(`${x.getFullYear()}-${pad(x.getMonth() + 1)}`); }
  return out;
}

module.exports = { createAnalytics, lastMonths, daysAgo, fmtDate };
