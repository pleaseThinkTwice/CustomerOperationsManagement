'use strict';
// 演示数仓数据生成：在本地 sqlite 里按 analytics/schema.js 建表并灌入确定性的随机数据（固定种子，结果可复现）。
// 日期以「生成当天」为基准向前铺开，保证“近 7 天 / 今年”等口径有数据。
const { tables } = require('./schema');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OEMS = [
  { oem: 'XMS', oem_ch: '小米汽车', grp: '小米汽车科技有限公司' },
  { oem: 'SHEV', oem_ch: '理想汽车', grp: '北京车和家信息技术有限公司' },
  { oem: 'BYD', oem_ch: '比亚迪', grp: '比亚迪汽车工业有限公司' },
  { oem: 'CNEV', oem_ch: '东风汽车', grp: '东风汽车集团有限公司' },
  { oem: 'NIO', oem_ch: '蔚来汽车', grp: '上海蔚来汽车有限公司' },
];
// 项目：客户 × 容量 × 车型
const PRODUCTS = [
  { oem: 'XMS', cap: '153', struct: '1P204S', s: 204, pn: 'XR153', model: 'SU7', sop: '2024-03-28', n: 2600 },
  { oem: 'XMS', cap: '153', struct: '1P204S', s: 204, pn: 'XR153', model: 'YU7', sop: '2025-06-26', n: 1300 },
  { oem: 'XMS', cap: '100', struct: '1P96S', s: 96, pn: 'XF100', model: 'SU7 标准版', sop: '2024-10-15', n: 900 },
  { oem: 'SHEV', cap: '153', struct: '1P180S', s: 180, pn: 'LX153', model: 'L7', sop: '2023-02-08', n: 2100 },
  { oem: 'SHEV', cap: '100', struct: '1P108S', s: 108, pn: 'LX100', model: 'L6', sop: '2024-04-18', n: 1500 },
  { oem: 'BYD', cap: '75', struct: '1P120S', s: 120, pn: 'BD075', model: '海豹', sop: '2023-05-20', n: 1800 },
  { oem: 'BYD', cap: '50', struct: '2P90S', s: 180, pn: 'BD050', model: '海鸥', sop: '2023-01-10', n: 1200 },
  { oem: 'CNEV', cap: '100', struct: '1P96S', s: 96, pn: 'DF100', model: '风神 E70', sop: '2023-09-01', n: 800 },
  { oem: 'CNEV', cap: '50', struct: '2P90S', s: 180, pn: 'DF050', model: '纳米 01', sop: '2024-01-12', n: 600 },
  { oem: 'NIO', cap: '153', struct: '1P192S', s: 192, pn: 'NE153', model: 'ET5', sop: '2023-06-01', n: 1400 },
  { oem: 'NIO', cap: '75', struct: '1P112S', s: 112, pn: 'NE075', model: 'ES6', sop: '2023-11-20', n: 700 },
];
const CELL_TYPE = { 153: 'LFP', 100: 'NCM', 75: 'LFP', 50: 'NCM' };
// 同一电芯 PN 下按车型编号 Pack PN（质保条款按 Pack PN 维护）
PRODUCTS.forEach((p, i) => { p.ppn = `${p.pn}-${String(PRODUCTS.slice(0, i).filter((q) => q.pn === p.pn).length + 1).padStart(2, '0')}`; });
const MODES = ['绝缘故障', 'SOC 一致性', '容量衰减', '自放电异常', '压差报警', '热失控预警'];
const MODE_W = [0.22, 0.2, 0.18, 0.14, 0.2, 0.06];
const PLANTS = ['宁德基地', '溧阳基地', '宜宾基地'];

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDt = (d) => `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);

async function generate(db) {
  const q = db.dialect.quote;
  const types = { text: 'TEXT', int: 'INTEGER', real: 'REAL', date: 'TEXT', datetime: 'TEXT' };
  for (const [name, t] of Object.entries(tables)) {
    await db.exec(`DROP TABLE IF EXISTS ${q(name)}; CREATE TABLE ${q(name)} (${Object.entries(t.cols).map(([k, d]) => `${q(k)} ${types[d.type]}`).join(', ')});`);
  }
  const rnd = mulberry32(20260921);
  const pick = (arr, w) => { if (!w) return arr[Math.floor(rnd() * arr.length)]; let r = rnd(); for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; } return arr[arr.length - 1]; };
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const insert = async (table, rows) => {
    if (!rows.length) return;
    const keys = Object.keys(tables[table].cols);
    const sql = `INSERT INTO ${q(table)} (${keys.map(q).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    await db.tx(async () => { for (const r of rows) await db.run(sql, keys.map((k) => (r[k] === undefined ? null : r[k]))); });
  };

  await insert('dim_oem', OEMS.map((o) => ({ oem: o.oem, oem_ch: o.oem_ch, cust_grp_name: o.grp })));
  await insert('dim_cell_product', PRODUCTS.map((p) => ({
    oem: p.oem, cell_cap: p.cap, cell_structure: p.struct, pn_system: p.pn, cell_type: CELL_TYPE[p.cap], vehicle_model: p.model, series_count: p.s, sop_date: p.sop, plant: pick(PLANTS),
  })));
  await insert('dim_warranty_policy', PRODUCTS.map((p) => ({
    oem: p.oem, cell_cap: p.cap, vehicle_model: p.model, pn: p.ppn,
    passenger_years: 8, passenger_mileage: 160000 + Math.round(rnd() * 3) * 70000, passenger_soh: 70 + Math.round(rnd() * 2) * 5,
    commercial_years: 5, commercial_mileage: 300000, commercial_soh: 70,
  })));

  const vehicles = []; const warnings = []; const ships = []; const adjusts = []; const orders = [];
  let wid = 1; let woId = 1;
  const order = (type, w, t) => t > today ? 0 : orders.push({ wo_id: `WO${String(woId++).padStart(7, '0')}`, wo_type: type, vin: w.vin, oem: w.oem, cell_cap: w.cell_cap, vehicle_model: w.vehicle_model, pn: w.pn, fault_type: w.fault_type, create_time: fmtDt(t), close_time: ((c) => (rnd() < 0.8 && c <= today ? fmtDt(c) : null))(addDays(t, 2 + Math.floor(rnd() * 15))), plant: w.plant });
  for (const p of PRODUCTS) {
    const sop = new Date(p.sop + 'T12:00:00');
    const spanDays = Math.max(30, Math.round((today - sop) / 86400e3));
    const batches = Array.from({ length: 6 }, (_, i) => `B${p.cap}${String.fromCharCode(65 + i)}${pad(Math.floor(rnd() * 90) + 10)}`);
    const cellPns = [`P${p.cap}-A`, `P${p.cap}-B`, `P${p.cap}-C`].slice(0, 2 + Math.floor(rnd() * 2));
    // 出货：从 SOP 起按月出货，Pack 总量 ≈ 接入车辆 × 1.2
    const months = Math.ceil(spanDays / 30);
    const packTotal = Math.round(p.n * 1.2);
    for (let m = 0; m < months; m++) {
      const d = addDays(sop, m * 30 + Math.floor(rnd() * 20));
      if (d > today) break;
      const packQty = Math.max(1, Math.round(packTotal / months * (0.6 + rnd() * 0.8)));
      const batch = pick(batches); const plant = pick(PLANTS); const cpn = cellPns[Math.floor(rnd() * cellPns.length)];
      ships.push({ oem: p.oem, cell_cap: p.cap, vehicle_model: p.model, ship_level: 'pack', qty: packQty, ship_date: fmtDate(d), pn: p.ppn, batch_no: batch, plant });
      ships.push({ oem: p.oem, cell_cap: p.cap, vehicle_model: p.model, ship_level: 'module', qty: packQty * 6, ship_date: fmtDate(d), pn: p.ppn, batch_no: batch, plant });
      ships.push({ oem: p.oem, cell_cap: p.cap, vehicle_model: p.model, ship_level: 'cell', qty: packQty * p.s, ship_date: fmtDate(d), pn: cpn, batch_no: batch, plant });
    }
    for (let i = 0; i < p.n; i++) {
      const vin = `L${p.oem.slice(0, 2)}${p.cap}${String(100000 + vehicles.length).slice(1)}${pad(Math.floor(rnd() * 99))}`;
      // 接入时间偏向近期（产量爬坡）
      const access = addDays(sop, Math.floor(Math.pow(rnd(), 0.6) * spanDays));
      const lastOnline = rnd() < 0.85 ? addDays(today, -Math.floor(rnd() * 25)) : addDays(access, Math.floor(rnd() * Math.max(1, (today - access) / 86400e3)));
      const commercial = rnd() < 0.12;
      const ageDays = (today - access) / 86400e3;
      // 部分早期营运车按 5 年质保会过保：把质保起算日适当前移制造少量过保样本
      const wStart = addDays(access, -(commercial && rnd() < 0.3 ? 365 * 4 + Math.floor(rnd() * 400) : Math.floor(rnd() * 30)));
      const mileage = Math.round(ageDays * (commercial ? 260 : 45) * (0.5 + rnd()));
      const soh = Math.round((100 - ageDays / 365 * (commercial ? 4 : 2.2) - rnd() * 3) * 10) / 10;
      vehicles.push({
        vin, deviceid: `DEV${p.pn}${String(i).padStart(5, '0')}`, oem: p.oem, cell_cap: p.cap, cell_structure: p.struct, vehicle_model: p.model,
        pack_pn: p.ppn, pack_id: rnd() < 0.015 ? null : `PK${p.cap}${String(vehicles.length).padStart(7, '0')}`, usage_type: commercial ? 'commercial' : 'passenger',
        access_date: fmtDate(access), last_online_date: fmtDate(lastOnline), warranty_start_date: fmtDate(wStart), mileage_km: mileage, soh,
        cycle_count: Math.round(mileage / (420 + rnd() * 160)),
      });
      // 预警：约 9% 的车出过预警，营运车概率更高
      if (rnd() < (commercial ? 0.2 : 0.08)) {
        const k = 1 + Math.floor(rnd() * 3);
        for (let j = 0; j < k; j++) {
          const wt = addDays(access, Math.floor(Math.pow(rnd(), 0.5) * Math.max(1, ageDays)));
          wt.setHours(Math.floor(rnd() * 24), Math.floor(rnd() * 60), Math.floor(rnd() * 60));
          const out = rnd() < 0.72 ? 1 : 0;
          const age = (today - wt) / 86400e3;
          const closed = out && rnd() < (age > 7 ? 0.86 : 0.35) ? 1 : 0;
          const wr = {
            warning_id: `W${String(wid++).padStart(7, '0')}`, vin, oem: p.oem, cell_cap: p.cap, vehicle_model: p.model,
            fault_type: pick(MODES, MODE_W), warning_time: fmtDt(wt), is_outgoing: out, is_closed: closed,
            close_time: closed ? fmtDt(addDays(wt, 1 + Math.floor(rnd() * 12))) : null, is_complaint: out && rnd() < 0.08 ? 1 : 0,
            batch_no: pick(batches), pack_no: `P${pad(Math.floor(rnd() * 20))}`, cell_pos: `C${1 + Math.floor(rnd() * p.s)}`, soh: Math.max(60, soh - Math.round(rnd() * 8)),
          };
          warnings.push(wr);
          // 工单：外发预警约 45% 开预警工单，其中约 35% 升级为现场工单（现场更换 = 失效车辆）
          const wctx = { ...wr, pn: cellPns[Math.floor(rnd() * cellPns.length)], plant: pick(PLANTS) };
          if (out && rnd() < 0.45) {
            order('预警', wctx, addDays(wt, 1));
            if (rnd() < 0.35) order('现场', wctx, addDays(wt, 3 + Math.floor(rnd() * 10)));
          }
        }
      }
      if (rnd() < 0.008) order('批改', { vin, oem: p.oem, cell_cap: p.cap, vehicle_model: p.model, pn: cellPns[0], fault_type: pick(MODES, MODE_W), plant: pick(PLANTS) }, addDays(access, Math.floor(rnd() * Math.max(1, ageDays))));
      if (rnd() < 0.006) adjusts.push({ vin, oem: p.oem, cell_cap: p.cap, check_date: fmtDate(addDays(today, -Math.floor(rnd() * 90))), mileage_diff_km: Math.round((1 + rnd() * 9) * 10) / 10 });
    }
  }
  await insert('dws_shipment', ships);
  await insert('dwd_vehicle_access', vehicles);
  await insert('dwd_warning', warnings);
  await insert('dwd_mileage_adjust', adjusts);
  await insert('dwd_work_order', orders);
  return { vehicles: vehicles.length, warnings: warnings.length, shipments: ships.length, orders: orders.length };
}

module.exports = { generate, OEMS, PRODUCTS, MODES };
