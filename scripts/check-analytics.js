'use strict';
// 接公司数仓前的自检：按 src/analytics/schema.js 逐表逐字段检查当前配置的分析库，输出缺表 / 缺字段 / 行数 / 样例。
// 用法：配置好 .env 的 ANALYTICS_DB_* 后运行 npm run check-analytics
const config = require('../src/config');
const { createAnalytics } = require('../src/analytics');
const { tables } = require('../src/analytics/schema');

(async () => {
  const cfg = config.ANALYTICS_DB;
  if (cfg.driver !== 'mysql') console.log('提示：当前 ANALYTICS_DB_DRIVER=demo，检查的是本地演示库。接公司库请设为 mysql 并配置 ANALYTICS_DB_URL。\n');
  const { db, T } = await createAnalytics();
  let bad = 0;
  for (const [name, t] of Object.entries(tables)) {
    const full = T(name);
    const cols = Object.keys(t.cols);
    try {
      const n = (await db.get(`SELECT COUNT(*) AS n FROM ${full}`)).n;
      const missing = [];
      for (const c of cols) { try { await db.get(`SELECT ${c} FROM ${full} LIMIT 1`); } catch (e) { missing.push(c); } }
      const ok = cols.filter((c) => !missing.includes(c));
      const sample = ok.length ? await db.get(`SELECT ${ok.join(', ')} FROM ${full} LIMIT 1`) : null;
      if (missing.length) bad++;
      console.log(`${missing.length ? '✗' : '✓'} ${name} → ${full}  行数 ${n}${missing.length ? '  缺字段: ' + missing.map((c) => `${c}（${t.cols[c].comment}）`).join('、') : ''}`);
      if (sample) console.log('    样例:', JSON.stringify(sample).slice(0, 300));
    } catch (e) {
      bad++;
      console.log(`✗ ${name} → ${full}  无法读取：${e.message.split('\n')[0]}`);
    }
  }
  await db.close();
  console.log(bad ? `\n${bad} 张表有问题，见上。字段名不同时建议在数仓建视图对齐（见 docs/数据需求.md）。` : '\n全部表与字段就绪。');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
