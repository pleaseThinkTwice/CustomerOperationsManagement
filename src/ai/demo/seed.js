'use strict';
/**
 * 生成 text2sql 演示业务库（SQLite，确定性随机数，可重复生成）。
 * 表结构只是原型演示用的「占位口径」，到公司后用真实 test 库替换：改 AI_SQL_* 连接 + config/semantic.json 即可。
 *
 *   node src/ai/demo/seed.js [输出文件]
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE cust_oem (
  oem TEXT PRIMARY KEY, oem_ch TEXT, name_cn TEXT, level TEXT, relationship_status TEXT, region TEXT
);
CREATE TABLE cust_project (
  project_id INTEGER PRIMARY KEY, oem TEXT, cell_cap INTEGER, cell_structure TEXT, pn_system TEXT, sop_month TEXT, pack_count INTEGER
);
CREATE TABLE veh_access (
  vin TEXT PRIMARY KEY, oem TEXT, cell_cap INTEGER, access_date TEXT, last_online_date TEXT, mileage_km REAL
);
CREATE TABLE warn_record (
  warn_id INTEGER PRIMARY KEY, vin TEXT, oem TEXT, cell_cap INTEGER, warn_date TEXT, fault_type TEXT,
  risk_level TEXT, closure_status TEXT, dispatched INTEGER, close_date TEXT
);
CREATE TABLE demand (
  demand_id INTEGER PRIMARY KEY, oem TEXT, title TEXT, category TEXT, status TEXT, priority TEXT, created_date TEXT, owner TEXT
);
CREATE TABLE contract (
  contract_id INTEGER PRIMARY KEY, oem TEXT, name TEXT, amount REAL, status TEXT, sign_date TEXT, end_date TEXT
);
`;

const CUSTOMERS = [
  ['SHEV', '用户中心北京', '理想汽车', 'S级', '战略合作', '华北'],
  ['CNEV', '中汽工程', '东风汽车', 'B级', '稳定合作', '华中'],
  ['BYD', '比亚迪', '比亚迪', 'A级', '深度绑定', '华南'],
  ['XMS', '小米汽车', '小米汽车', 'S级', '战略合作', '华北'],
  ['NIO', '蔚来汽车', '蔚来', 'A级', '稳定合作', '华东'],
];
const PROJECTS = [[153, '1P204S', 'XR153', '2025-06'], [100, '1P96S', 'XF100', '2024-10'], [75, '1P120S', 'XB75', '2023-05']];
const MODES = ['绝缘故障', 'SOC 一致性', '容量衰减', '自放电异常', '压差报警', '热失控预警'];
const RISK = ['高', '中', '中', '低', '低'];
const DEMAND_CAT = ['数据接入', '预警策略', '报表需求', '算法优化', '系统对接'];
const DEMAND_STATUS = ['待评审', '开发中', '已上线', '已上线', '已关闭'];
const OWNERS = ['张伟', '李娜', '王强', '刘洋'];
const TODAY = new Date('2026-10-20T00:00:00Z');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function seed(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const r = rng(20261020);
  const pick = a => a[Math.floor(r() * a.length)];
  const day = (from, span) => new Date(from.getTime() + Math.floor(r() * span) * 86400000).toISOString().slice(0, 10);

  db.exec('BEGIN');
  const insOem = db.prepare('INSERT INTO cust_oem VALUES (?,?,?,?,?,?)');
  CUSTOMERS.forEach(c => insOem.run(...c));

  const insProj = db.prepare('INSERT INTO cust_project VALUES (?,?,?,?,?,?,?)');
  const insVeh = db.prepare('INSERT INTO veh_access VALUES (?,?,?,?,?,?)');
  const insWarn = db.prepare('INSERT INTO warn_record VALUES (?,?,?,?,?,?,?,?,?,?)');
  let pid = 0; let wid = 0; let vseq = 0;
  for (const [oem] of CUSTOMERS) {
    for (const [cap, struct, pn, sop] of PROJECTS) {
      if (r() < 0.25) continue;                       // 不是每个客户都有每个容量的项目
      const packs = 300 + Math.floor(r() * 900);
      insProj.run(++pid, oem, cap, struct, `${pn}-${oem}`, sop, packs);
      const accessed = Math.floor(packs * (0.6 + r() * 0.35));
      for (let i = 0; i < accessed; i++) {
        const vin = `L${oem.slice(0, 3)}${String(cap).padStart(3, '0')}${String(++vseq).padStart(8, '0')}`;
        const acc = day(new Date(sop + '-01T00:00:00Z'), Math.max(30, Math.floor((TODAY - new Date(sop + '-01')) / 86400000)));
        const last = r() < 0.8 ? day(new Date(TODAY.getTime() - 30 * 86400000), 30) : day(new Date(acc), 200);
        insVeh.run(vin, oem, cap, acc, last < acc ? acc : last, Math.round(r() * 120000));
        if (r() < 0.12) {
          const wd = day(new Date('2025-11-01T00:00:00Z'), 353);
          const closed = r() < 0.7;
          const cd = closed ? new Date(new Date(wd).getTime() + Math.floor(1 + r() * 20) * 86400000).toISOString().slice(0, 10) : null;
          insWarn.run(++wid, vin, oem, cap, wd, pick(MODES), pick(RISK), closed ? '已闭环' : '未闭环', r() < 0.6 ? 1 : 0, cd);
        }
      }
    }
  }

  const insDem = db.prepare('INSERT INTO demand VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 1; i <= 60; i++) {
    const cat = pick(DEMAND_CAT);
    insDem.run(i, pick(CUSTOMERS)[0], `${cat}需求 #${i}`, cat, pick(DEMAND_STATUS), pick(['高', '中', '低']), day(new Date('2025-10-01T00:00:00Z'), 384), pick(OWNERS));
  }
  const insCon = db.prepare('INSERT INTO contract VALUES (?,?,?,?,?,?,?)');
  let cid = 0;
  for (const [oem, , name] of CUSTOMERS) {
    for (let k = 0; k < 3; k++) {
      const sign = day(new Date('2024-01-01T00:00:00Z'), 900);
      const end = new Date(new Date(sign).getTime() + 730 * 86400000).toISOString().slice(0, 10);
      insCon.run(++cid, oem, `${name}数据服务合同-${k + 1}`, Math.round((50 + r() * 950)) * 10000, end < '2026-10-20' ? '已到期' : pick(['生效中', '履行中']), sign, end);
    }
  }
  db.exec('COMMIT');
  const counts = Object.fromEntries(['cust_oem', 'cust_project', 'veh_access', 'warn_record', 'demand', 'contract']
    .map(t => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  db.close();
  return counts;
}

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', 'data', 'demo_business.sqlite'));
  console.log(out, seed(out));
}

module.exports = { seed };
