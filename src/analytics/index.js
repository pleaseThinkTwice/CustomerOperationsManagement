'use strict';
// 分析层：所有看板/洞察口径都在这里，用一套 SQL 同时跑在本地 demo sqlite 与公司 Doris/MySQL 上。
// 业务口径（报告里同步说明）：
//   接入数 access：dwd_vehicle_access 行数（每车一行）
//   出货：dws_shipment 按 ship_level 汇总 qty；接入率 = 接入数 ÷ Pack 出货数
//   预警 alarm：dwd_warning 中 is_outgoing=1 的条数（“外发预警”）；closed：其中 is_closed=1
//   近 7 天：warning_time >= 今天-7 天；超期 overdue：外发未闭环且触发已超过 7 天
//   活跃车辆 active：last_online_date >= 指定日期（默认近 30 天）
//   在保 insured：质保起算日 + 年限未到期 且 里程未超限（年限/里程取平台质保设置，无则取数仓质保政策，再无则 8 年/不限里程）
//   PPM：外发预警涉及电芯数 ÷ 出货电芯数 × 1e6
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
          SUM(CASE WHEN access_date >= ? THEN 1 ELSE 0 END) AS this_year
        FROM ${T('dwd_vehicle_access')} WHERE ${f.sql} GROUP BY ${g}, usage_type`, [daysAgo(30), daysAgo(15), `${new Date().getFullYear()}-01-01`, ...f.params]);
      const out = new Map();
      for (const r of base) {
        const key = groupBy.map((k) => r[k]).join('|');
        const o = out.get(key) || Object.assign(Object.fromEntries(groupBy.map((k) => [k, r[k]])), { access_count: 0, active30: 0, access15: 0, this_year: 0, expired_cnt: 0 });
        o.access_count += num(r.access_count); o.active30 += num(r.active30); o.access15 += num(r.access15); o.this_year += num(r.this_year);
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
    // 近 12 个月按失效模式的 触发/闭环/客诉 矩阵
    async quality(oem, caps, monthsN = 12) {
      const labels = lastMonths(monthsN);
      const f = filt({ oem, caps });
      const rows = await all(`SELECT ${d.month('warning_time')} AS m, fault_type, COUNT(*) AS alarm, SUM(is_closed) AS closed, SUM(is_complaint) AS complaint
        FROM ${T('dwd_warning')} WHERE warning_time >= ? AND ${f.sql} GROUP BY ${d.month('warning_time')}, fault_type`, [labels[0] + '-01', ...f.params]);
      const modes = [...new Set(rows.map((r) => r.fault_type))].sort();
      const q = { labels: labels.map((l) => l.slice(2)), alarm: {}, closed: {}, complaint: {} };
      for (const m of modes) { q.alarm[m] = labels.map(() => 0); q.closed[m] = labels.map(() => 0); q.complaint[m] = labels.map(() => 0); }
      for (const r of rows) {
        const i = labels.indexOf(r.m); if (i < 0) continue;
        q.alarm[r.fault_type][i] = num(r.alarm); q.closed[r.fault_type][i] = num(r.closed); q.complaint[r.fault_type][i] = num(r.complaint);
      }
      return q;
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

function lastMonths(n) {
  const out = []; const now = new Date();
  for (let i = n - 1; i >= 0; i--) { const x = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push(`${x.getFullYear()}-${pad(x.getMonth() + 1)}`); }
  return out;
}

module.exports = { createAnalytics, lastMonths, daysAgo, fmtDate };
