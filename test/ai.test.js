'use strict';
/**
 * AI 模块端到端测试：用本地模拟的 OpenAI 兼容服务代替真实大模型，覆盖
 * 多步 Agent（SQL 出错 → 自我修正 → 总结）、反问续答、问答、离线兜底、SQL 安全校验和前端用到的各接口。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAi } = require('../src/ai');
const { seed } = require('../src/ai/demo/seed');
const { checkSql } = require('../src/ai/sql/guard');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-test-'));
const BIZ = path.join(TMP, 'biz.sqlite');
seed(BIZ);

// ---------- 模拟大模型 ----------
const llmLog = [];
function mockLlm(handler) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body);
        llmLog.push(j);
        const message = handler(j);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }));
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

const call = (name, args, id = 'c' + Math.random().toString(36).slice(2, 7)) =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function scripted(j) {
  const msgs = j.messages;
  const sys = msgs[0].content;
  const user = msgs.filter(m => m.role === 'user').pop().content;
  const tools = msgs.filter(m => m.role === 'tool');
  if (!j.tools) return { content: '（总结）' + user.slice(0, 20) };
  if (sys.includes('知识库问答助手')) {
    return { content: '绝缘阻值连续 3 帧低于 500Ω/V 触发一级预警 [Q1]。' };
  }
  if (user.includes('反问')) {
    if (!tools.length) return { content: null, tool_calls: [call('ask_user', { question: '统计哪个客户？', options: ['小米汽车', '全部'] })] };
    const ans = JSON.parse(tools[tools.length - 1].content).user_answer;
    return { content: `好的，按「${ans}」统计。` };
  }
  // 数智分析：第一次故意写错表名，看到报错后修正
  if (tools.length === 0) return { content: '先查各客户接入车辆。', tool_calls: [call('query_sql', { sql: 'SELECT oem, COUNT(*) FROM vehicle GROUP BY oem', purpose: '接入车辆数' })] };
  if (tools.length === 1) {
    assert.match(tools[0].content, /白名单|no such table/);
    return { content: null, tool_calls: [call('query_sql', { sql: 'SELECT o.oem_ch AS 客户, COUNT(*) AS 接入车辆数 FROM veh_access v JOIN cust_oem o ON o.oem = v.oem GROUP BY o.oem_ch ORDER BY 2 DESC', purpose: '修正表名' })] };
  }
  const data = JSON.parse(tools[1].content);
  return { content: `接入车辆最多的是 **${data.rows[0][0]}**。\n\n| 客户 | 接入车辆数 |\n| --- | --- |\n${data.rows.map(r => `| ${r[0]} | ${r[1]} |`).join('\n')}` };
}

async function withServer(ai, fn) {
  const srv = http.createServer(async (req, res) => {
    if (!(await ai.handle(req, res))) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return t; }
  };
  try { await fn(api, base); } finally { srv.close(); }
}

async function poll(api, taskId) {
  for (let i = 0; i < 200; i++) {
    const p = await api('GET', `/api/task/progress/${taskId}`);
    assert.equal(p.success, true);
    if (p.status !== 'running') return p;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

test('SQL 安全校验', () => {
  const allow = ['veh_access', 'cust_oem'];
  assert.equal(checkSql('DELETE FROM veh_access', { allowTables: allow }).ok, false);
  assert.equal(checkSql('SELECT 1; DROP TABLE veh_access', { allowTables: allow }).ok, false);
  assert.equal(checkSql('SELECT * FROM veh_access, contract', { allowTables: allow }).ok, false);
  assert.equal(checkSql('SELECT * FROM "contract"', { allowTables: allow }).ok, false);
  assert.equal(checkSql("SELECT * FROM veh_access WHERE vin = 'x; delete'", { allowTables: allow }).ok, true);
  const r = checkSql('SELECT * FROM veh_access', { allowTables: allow, maxRows: 10 });
  assert.match(r.sql, /LIMIT 10$/);
});

test('多步 Agent：出错自我修正 + 前端接口', async () => {
  const llmSrv = await mockLlm(scripted);
  const ai = createAi({
    storeDb: path.join(TMP, 'store1.sqlite'),
    sql: { type: 'sqlite', file: BIZ },
    llm: { baseUrl: `http://127.0.0.1:${llmSrv.address().port}/v1`, model: 'mock' },
  });
  try {
    await withServer(ai, async api => {
      // 数智分析（stream → 轮询）
      const start = await api('POST', '/api/agent/query', { query: '各客户接入车辆数', mode: 'analysis', history: [], stream: true });
      assert.ok(start.task_id);
      const done = await poll(api, start.task_id);
      assert.equal(done.status, 'done');
      const res = done.result;
      assert.equal(res.ok, true);
      assert.deepEqual(res.tools_used, ['query_sql']);
      assert.equal(res.trace.length, 2);
      assert.equal(res.trace[0].ok, false);           // 第一次表名错误被拦截
      assert.equal(res.trace[1].ok, true);
      assert.equal(res.columns[0], '客户');
      assert.ok(res.row_count >= 3);
      assert.match(res.report_html, /<table>/);
      assert.match(res.report_html, /执行的 SQL/);
      // 系统提示里带全量语义层与口径
      const sys = llmLog.find(j => j.messages[0].content.includes('数智分析助手')).messages[0].content;
      assert.match(sys, /warn_record/);
      assert.match(sys, /接入率/);

      // 反馈
      assert.equal((await api('POST', '/api/agent/feedback', { trace_id: String(res.trace_id), feedback: 1 })).success, true);

      // 反问 → 续答
      const s2 = await api('POST', '/api/agent/query', { query: '帮我统计一下（反问）', mode: 'analysis', stream: true });
      const w = await poll(api, s2.task_id);
      assert.equal(w.status, 'waiting_input');
      assert.equal(w.result.need_input, true);
      assert.deepEqual(w.result.options, ['小米汽车', '全部']);
      const c = await api('POST', '/api/agent/continue', { sid: w.result.sid, answer: '小米汽车', stream: true });
      const d2 = await poll(api, c.task_id);
      assert.match(d2.result.answer, /小米汽车/);

      // 问答：全量知识进上下文
      const qa = await api('POST', '/api/agent/query', { query: '绝缘故障怎么触发', mode: 'qa' });
      assert.match(qa.answer, /\[Q1\]/);
      const qaSys = llmLog.find(j => j.messages[0].content.includes('知识库问答助手')).messages[0].content;
      assert.match(qaSys, /压差报警的阈值/);         // 全量 Q&A 都在上下文里

      // 可查表目录
      const tables = await api('GET', '/api/nl2sql/tables');
      assert.equal(tables.tables.length, 6);
      const cols = await api('GET', '/api/nl2sql/tables/columns?table=warn_record');
      assert.ok(cols.fields.find(f => f.col === 'fault_type').desc.includes('绝缘故障'));
      const view = await api('GET', '/api/nl2sql/tables/view?table=cust_oem&limit=3');
      assert.equal(view.ok, true);
      assert.equal(view.rows.length, 3);
      assert.equal((await api('GET', '/api/nl2sql/tables/view?table=sqlite_master')).ok, false);

      // 收藏 + 快照 + 统一报告
      assert.equal((await api('POST', '/api/nl2sql/user-favorites', { question: '各客户接入车辆数' })).success, true);
      const favs = await api('GET', '/api/nl2sql/user-favorites');
      assert.equal(favs.items.length, 1);
      const snap = await api('POST', '/api/nl2sql/snapshots/refresh');
      assert.ok(snap.ok >= 1);
      const pulled = await api('GET', '/api/nl2sql/snapshots?action=pull');
      assert.ok(pulled.items.length >= 1);
      const rep = await api('POST', '/api/nl2sql/report', { items: [{ question: 'x', columns: ['a'], rows: [[1]] }] });
      assert.equal(rep.ok, true);

      // 改写
      const rf = await api('POST', '/api/agent/refine', { answer: '原结论', prompt: '改成表格' });
      assert.equal(rf.ok, true);
    });
  } finally { llmSrv.close(); }
});

test('Q&A 与知识库接口（离线兜底，无大模型）', async () => {
  const ai = createAi({ storeDb: path.join(TMP, 'store2.sqlite'), sql: { type: 'sqlite', file: BIZ }, llm: { baseUrl: '', model: '' } });
  await withServer(ai, async (api, base) => {
    const st = await api('GET', '/api/qa/status');
    assert.equal(st.llm_enabled, false);
    assert.ok(st.total_records >= 10);                // 演示数据

    const id = (await api('POST', '/api/qa', { category: '服务流程', question: '测试问题：电池鼓包怎么办', answer: '停用并联系售后', keywords: '鼓包' })).id;
    assert.ok((await api('GET', '/api/qa?category=' + encodeURIComponent('服务流程'))).some(r => r.id === id));
    assert.equal((await api('PUT', `/api/qa/${id}`, { category: '服务流程', question: '电池鼓包怎么办', answer: '立即停用并联系售后', keywords: '鼓包' })).success, true);

    const off = await api('POST', '/api/agent/query', { query: '电池鼓包怎么办', mode: 'qa' });
    assert.match(off.answer, /立即停用/);
    assert.equal(off.offline, true);

    // 离线数智分析：命中示例问题 → 执行预置 SQL
    const a = await api('POST', '/api/agent/query', { query: '各客户的接入车辆数和接入率', mode: 'analysis' });
    assert.equal(a.offline, true);
    assert.ok(a.row_count > 0);
    const miss = await api('POST', '/api/agent/query', { query: '明年会怎样', mode: 'analysis' });
    assert.match(miss.answer, /未配置大模型/);

    // 知识片段 CRUD + 上传
    const kid = (await api('POST', '/api/knowledge', { title: '充电问题', content: '慢充不跳枪请检查 BMS 版本', scope: 'qa', source_type: 'manual' })).id;
    assert.ok((await api('GET', '/api/knowledge?scope=qa&search=' + encodeURIComponent('跳枪'))).some(k => k.id === kid));
    const fd = new FormData();
    fd.append('file', new Blob(['# 售后手册\n\n## 退换货\n\n7 天内可退换。\n\n## 保修\n\n电芯质保 8 年。']), '售后手册.md');
    fd.append('scope', 'qa');
    const up = await (await fetch(base + '/api/knowledge/upload', { method: 'POST', body: fd })).json();
    assert.equal(up.ok, true);
    assert.equal(up.added, 2);
    const ks = await api('GET', '/api/knowledge/status');
    assert.ok(Array.isArray(ks.qa.categories));

    // Q&A 批量导入（CSV）
    const fd2 = new FormData();
    fd2.append('file', new Blob(['﻿分类,问题,回答\n数据质量,"SOC 跳变?","检查 BMS 上报"\n']), 'qa.csv');
    const imp = await (await fetch(base + '/api/qa/upload', { method: 'POST', body: fd2 })).json();
    assert.equal(imp.count, 1);

    // 自定义知识
    assert.equal((await api('POST', '/api/knowledge/user', { title: '口径', content: '容量差异 = SOH 差异' })).success, true);
    const uk = await api('GET', '/api/knowledge/user');
    assert.equal(uk.items.length, 1);
    assert.equal((await api('DELETE', `/api/knowledge/user/${uk.items[0].id}`)).success, true);

    // 导出
    const exp = await fetch(base + '/api/qa/export');
    assert.equal(exp.status, 200);
  });
});

test('权限：平台注入 req.user 时只读用户不能改知识库', async () => {
  const ai = createAi({ storeDb: path.join(TMP, 'store3.sqlite'), sql: { type: 'sqlite', file: BIZ }, llm: { baseUrl: '', model: '' } });
  const srv = http.createServer(async (req, res) => {
    req.user = { id: 7, username: 'u', perms: ['page6.view'] };
    req.body = req.method === 'POST' ? { category: 'a', question: 'b', answer: 'c' } : undefined;
    await ai.handle(req, res);
  });
  await new Promise(r => srv.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/qa`, { method: 'POST' });
  assert.equal(r.status, 403);
  srv.close();
});

test('外部引擎：Dify 适配器', async () => {
  const dify = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b);
      assert.equal(req.url, '/v1/chat-messages');
      assert.equal(req.headers.authorization, 'Bearer app-qa');
      assert.equal(j.response_mode, 'blocking');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer: `Dify 回答：${j.query}`, conversation_id: 'conv1', metadata: { retriever_resources: [{ document_name: '手册.pdf', content: '...' }] } }));
    });
  });
  await new Promise(r => dify.listen(0, r));
  const ai = createAi({
    storeDb: path.join(TMP, 'store4.sqlite'), sql: { type: 'sqlite', file: BIZ },
    engine: { qa: 'dify', analysis: 'builtin' },
    external: { dify: { baseUrl: `http://127.0.0.1:${dify.address().port}`, qaKey: 'app-qa', analysisKey: '' } },
  });
  const r = await ai.engineFor('qa').run({ query: '保修多久', mode: 'qa', history: [] });
  assert.equal(r.answer, 'Dify 回答：保修多久');
  assert.equal(r.trace[0].args, '手册.pdf');
  dify.close();
});
