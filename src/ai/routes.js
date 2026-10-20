'use strict';
/**
 * AI 模块的 HTTP 接口，契约对齐原型前端（Page6 Q&A 知识库、Page9 数智分析、AgentProgress 组件）。
 * 负责前缀：/api/agent/*  /api/task/progress/*  /api/qa*  /api/knowledge*  /api/nl2sql/*  /api/ai/*
 */
const fs = require('node:fs');
const path = require('node:path');
const { sendJson, ensureBody } = require('./http');
const { parseFile, parseQaFile } = require('./kb/ingest');
const { markdownToHtml, tableHtml, tableMarkdown } = require('./render');

const PREFIXES = ['/api/agent/', '/api/task/progress/', '/api/qa', '/api/knowledge', '/api/nl2sql/', '/api/ai/'];

function userKey(req) { return req.user ? String(req.user.id ?? req.user.username ?? '') : ''; }
function userName(req) { return (req.user && (req.user.name || req.user.username)) || ''; }
function canEdit(req) {
  if (!req.user) return true;   // 独立运行（无平台鉴权）
  const p = req.user.perms || [];
  return p.includes('*') || p.includes('knowledge.edit');
}
function forbid(res) { sendJson(res, 403, { success: false, ok: false, error: '无权限（需要 knowledge.edit）' }); }

function createRoutes(ctx) {
  const { cfg, store, catalog, tasks, llm, engineFor } = ctx;

  // ---------- Agent ----------
  async function agentRun(params, report) {
    const engine = engineFor(params.mode);
    return engine.run(params, report);
  }

  function startOrRun(req, res, fn) {
    if (req.body.stream) {
      const id = tasks.start(fn, { user: userKey(req) });
      return sendJson(res, 200, { success: true, task_id: id });
    }
    return Promise.resolve(fn(() => {})).then(r => sendJson(res, 200, r))
      .catch(e => sendJson(res, 200, { success: false, ok: false, error: e.message }));
  }

  // ---------- 知识库文件夹同步 ----------
  function syncFolder(scope) {
    const dir = path.join(cfg.kbFolder, scope);
    if (!fs.existsSync(dir)) return 0;
    let added = 0;
    const walk = d => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (ent.name.startsWith('.') || /readme/i.test(ent.name)) continue;
        const ref = 'folder:' + path.relative(cfg.kbFolder, p);
        if (store.kb.exists(scope, ref)) continue;
        try {
          const { kind, chunks } = parseFile(ent.name, fs.readFileSync(p));
          const cat = path.relative(dir, d) || '';
          for (const c of chunks) {
            store.kb.create({ scope, title: c.title, content: c.content, category: cat, source_type: 'folder', kind: c.kind || kind, source_ref: ref });
            added++;
          }
        } catch (e) { /* 单个文件失败不影响其它 */ }
      }
    };
    walk(dir);
    return added;
  }

  // ---------- 常用问题快照 ----------
  async function refreshSnapshots() {
    const qs = [...new Set([...(catalog.semantic().commonQuestions || []), ...store.favorites.all().map(f => f.question)])];
    const items = [];
    let ok = 0; let failed = 0;
    for (const q of qs) {
      try {
        const r = await agentRun({ query: q, mode: 'analysis', history: [] });
        const good = r && r.ok !== false && !r.error;
        items.push({ question: q, ok: !!good, columns: r.columns || [], rows: (r.rows || []).slice(0, 200), row_count: r.row_count || 0, report_html: r.report_html || '', error: r.error || '' });
        good ? ok++ : failed++;
      } catch (e) {
        items.push({ question: q, ok: false, columns: [], rows: [], row_count: 0, error: e.message });
        failed++;
      }
    }
    store.snapshots.save(new Date().toISOString().slice(0, 10), items);
    return { ok, failed };
  }

  // ---------- 路由表 ----------
  const routes = [
    // 任务进度
    ['GET', /^\/api\/task\/progress\/([\w-]+)$/, (req, res, m) => {
      const t = tasks.get(m[1]);
      sendJson(res, 200, t || { success: false, error: '任务不存在或已过期' });
    }],
    ['GET', /^\/api\/ai\/status$/, async (req, res) => {
      let tables = 0; let dbError = '';
      try { tables = (await catalog.tables()).length; } catch (e) { dbError = e.message; }
      sendJson(res, 200, {
        success: true, engine: cfg.engine, llm_enabled: llm.enabled(), llm_model: cfg.llm.model || '',
        tool_calling: cfg.llm.toolCalling !== false, sql_type: cfg.sql.type, tables, db_error: dbError,
        qa_records: store.qa.count(), kb_qa: store.kb.count('qa'), kb_analysis: store.kb.count('analysis'),
      });
    }],

    // Agent
    ['POST', /^\/api\/agent\/query$/, (req, res) => {
      const { query, mode, history } = req.body;
      if (!query || !String(query).trim()) return sendJson(res, 400, { success: false, error: '问题不能为空' });
      return startOrRun(req, res, report => agentRun({ query: String(query).trim(), mode, history, user: req.user }, report));
    }],
    ['POST', /^\/api\/agent\/continue$/, (req, res) => {
      const { sid, answer } = req.body;
      return startOrRun(req, res, report => ctx.agent.resume({ sid, answer: String(answer ?? '') }, report));
    }],
    ['POST', /^\/api\/agent\/refine$/, async (req, res) => {
      const { answer, prompt } = req.body;
      if (!answer || !prompt) return sendJson(res, 200, { ok: false, error: '缺少内容或修改要求' });
      try { sendJson(res, 200, { ok: true, answer: await ctx.agent.refine({ answer, prompt }) }); }
      catch (e) { sendJson(res, 200, { ok: false, error: e.code === 'LLM_DISABLED' ? '未配置大模型，无法优化' : e.message }); }
    }],
    ['POST', /^\/api\/agent\/feedback$/, (req, res) => {
      const { trace_id, feedback, feedback_text } = req.body;
      const n = store.traces.feedback(Number(trace_id), Number(feedback) || 0, feedback_text || '');
      sendJson(res, 200, { success: n > 0 });
    }],

    // Q&A 记录
    ['GET', /^\/api\/qa\/status$/, (req, res) => {
      const ext = cfg.engine.qa !== 'builtin';
      sendJson(res, 200, {
        total_records: store.qa.count(), kb_records: store.kb.count('qa'), llm_enabled: ext || llm.enabled(),
        search_engine: ext ? `外部引擎：${cfg.engine.qa}` : (llm.enabled() ? `全量上下文 · ${cfg.llm.model}` : '关键词匹配（未配置大模型）'),
      });
    }],
    ['GET', /^\/api\/qa\/export$/, (req, res) => {
      const rows = store.qa.list().map(r => [r.category, r.question, r.answer, r.keywords, r.maintainer]);
      const head = ['分类', '问题', '回答', '关键词', '维护人'];
      let XLSX = null;
      try { XLSX = require('xlsx'); } catch (e) { /* 可选依赖 */ }
      if (XLSX) {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), 'QA');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="qa_records.xlsx"' });
        return res.end(buf);
      }
      const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = '﻿' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="qa_records.csv"' });
      res.end(csv);
    }],
    ['POST', /^\/api\/qa\/upload$/, (req, res) => {
      if (!canEdit(req)) return forbid(res);
      const f = (req.files || [])[0];
      if (!f) return sendJson(res, 400, { success: false, error: '未收到文件' });
      try {
        const recs = parseQaFile(f.filename, f.buffer);
        recs.forEach(r => store.qa.create({ ...r, maintainer: r.maintainer || userName(req) }));
        sendJson(res, 200, { success: true, count: recs.length });
      } catch (e) { sendJson(res, e.status || 400, { success: false, error: e.message }); }
    }],
    ['GET', /^\/api\/qa$/, (req, res, m, url) => sendJson(res, 200, store.qa.list({ category: url.searchParams.get('category') || '' }))],
    ['POST', /^\/api\/qa$/, (req, res) => {
      if (!canEdit(req)) return forbid(res);
      const b = req.body;
      if (!b.category || !b.question || !b.answer) return sendJson(res, 400, { success: false, error: '分类、问题、回答为必填项' });
      sendJson(res, 200, { success: true, id: store.qa.create({ ...b, maintainer: b.maintainer || userName(req) }) });
    }],
    ['PUT', /^\/api\/qa\/(\d+)$/, (req, res, m) => {
      if (!canEdit(req)) return forbid(res);
      const b = req.body;
      if (!b.category || !b.question || !b.answer) return sendJson(res, 400, { success: false, error: '分类、问题、回答为必填项' });
      sendJson(res, 200, { success: store.qa.update(Number(m[1]), b) > 0 });
    }],
    ['DELETE', /^\/api\/qa\/(\d+)$/, (req, res, m) => {
      if (!canEdit(req)) return forbid(res);
      sendJson(res, 200, { success: store.qa.remove(Number(m[1])) > 0 });
    }],

    // 知识片段
    ['GET', /^\/api\/knowledge\/status$/, (req, res) => {
      const cats = scope => store.kb.categories(scope).map((c, i) => ({ id: i + 1, parent_id: 0, name: `${c.name}（${c.cnt}）` }));
      sendJson(res, 200, {
        qa: { total: store.kb.count('qa'), categories: cats('qa') },
        analysis: { total: store.kb.count('analysis'), categories: cats('analysis') },
        general: { categories: cats('qa') },
      });
    }],
    ['GET', /^\/api\/knowledge\/user$/, (req, res) => {
      sendJson(res, 200, { success: true, items: store.kb.list({ scope: 'analysis', source_type: 'user', user_id: userKey(req) }) });
    }],
    ['POST', /^\/api\/knowledge\/user$/, (req, res) => {
      const { title, content } = req.body;
      if (!title || !content) return sendJson(res, 400, { success: false, error: '标题和内容都不能为空' });
      const id = store.kb.create({ scope: 'analysis', title, content, source_type: 'user', category: '自定义知识', user_id: userKey(req) });
      sendJson(res, 200, { success: true, id });
    }],
    ['DELETE', /^\/api\/knowledge\/user\/(\d+)$/, (req, res, m) => {
      const k = store.kb.get(Number(m[1]));
      if (!k || k.source_type !== 'user' || (k.user_id !== userKey(req) && !canEdit(req))) return sendJson(res, 200, { success: false, error: '不存在或无权限' });
      sendJson(res, 200, { success: store.kb.remove(k.id) > 0 });
    }],
    ['POST', /^\/api\/knowledge\/upload$/, (req, res) => {
      if (!canEdit(req)) return forbid(res);
      const f = (req.files || [])[0];
      if (!f) return sendJson(res, 400, { ok: false, error: '未收到文件' });
      const scope = (req.fields && req.fields.scope) === 'analysis' ? 'analysis' : 'qa';
      try {
        const { kind, chunks } = parseFile(f.filename, f.buffer);
        const ext = path.extname(f.filename).slice(1).toLowerCase() || 'txt';
        chunks.forEach(c => store.kb.create({ scope, title: c.title, content: c.content, source_type: ext, kind: c.kind || kind, source_ref: f.filename }));
        sendJson(res, 200, { ok: true, filename: f.filename, kind, added: chunks.length });
      } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
    }],
    ['POST', /^\/api\/knowledge\/sync-qa$/, (req, res) => {
      // Q&A 记录已全量参与问答上下文，无需再复制成知识片段
      sendJson(res, 200, { success: true, added: 0, message: 'Q&A 记录已直接参与问答，无需同步' });
    }],
    ['POST', /^\/api\/knowledge\/sync-folder$/, (req, res) => {
      if (!canEdit(req)) return forbid(res);
      const scope = req.body.scope === 'analysis' ? 'analysis' : 'qa';
      sendJson(res, 200, { success: true, added: syncFolder(scope) });
    }],
    ['POST', /^\/api\/knowledge\/rebuild$/, (req, res) => {
      if (!canEdit(req)) return forbid(res);
      store.kb.removeBy("source_type = 'folder'");
      sendJson(res, 200, { success: true, added: syncFolder('qa') + syncFolder('analysis') });
    }],
    ['POST', /^\/api\/knowledge\/enrich$/, async (req, res) => {
      if (!canEdit(req)) return forbid(res);
      if (!llm.enabled()) return sendJson(res, 200, { success: false, enriched: 0, error: '未配置大模型' });
      const todo = [...store.kb.all('qa'), ...store.kb.all('analysis')].filter(k => !k.keywords).slice(0, 50);
      let n = 0;
      for (const k of todo) {
        try {
          const kw = await llm.chat([{ role: 'user', content: `为下面这段知识生成 5 个用户可能用来提问的关键词或短问句，用逗号分隔，只输出结果：\n${k.title}\n${k.content.slice(0, 1500)}` }]);
          store.kb.setKeywords(k.id, kw.replace(/\n/g, ',').slice(0, 300));
          n++;
        } catch (e) { break; }
      }
      sendJson(res, 200, { success: true, enriched: n });
    }],
    ['GET', /^\/api\/knowledge$/, (req, res, m, url) => {
      const q = url.searchParams;
      sendJson(res, 200, store.kb.list({ scope: q.get('scope') || 'qa', source_type: q.get('source_type') || '', search: q.get('search') || '' }));
    }],
    ['POST', /^\/api\/knowledge$/, (req, res) => {
      if (!canEdit(req)) return forbid(res);
      const b = req.body;
      if (!b.title || !b.content) return sendJson(res, 400, { success: false, error: '标题和内容为必填项' });
      sendJson(res, 200, { success: true, id: store.kb.create({ ...b, scope: b.scope === 'analysis' ? 'analysis' : 'qa' }) });
    }],
    ['PUT', /^\/api\/knowledge\/(\d+)$/, (req, res, m) => {
      if (!canEdit(req)) return forbid(res);
      const b = req.body;
      if (!b.title || !b.content) return sendJson(res, 400, { success: false, error: '标题和内容为必填项' });
      sendJson(res, 200, { success: store.kb.update(Number(m[1]), b) > 0 });
    }],
    ['DELETE', /^\/api\/knowledge\/(\d+)$/, (req, res, m) => {
      if (!canEdit(req)) return forbid(res);
      sendJson(res, 200, { success: store.kb.remove(Number(m[1])) > 0 });
    }],

    // 数智分析：可查表目录
    ['GET', /^\/api\/nl2sql\/tables$/, async (req, res) => {
      try { sendJson(res, 200, { success: true, tables: await catalog.tables() }); }
      catch (e) { sendJson(res, 200, { success: false, error: e.message, tables: [] }); }
    }],
    ['GET', /^\/api\/nl2sql\/tables\/columns$/, async (req, res, m, url) => {
      try {
        const c = await catalog.columns(url.searchParams.get('table') || '');
        sendJson(res, 200, c || { error: '表不存在或不在可查范围内' });
      } catch (e) { sendJson(res, 200, { error: e.message }); }
    }],
    ['GET', /^\/api\/nl2sql\/tables\/view$/, async (req, res, m, url) => {
      const table = url.searchParams.get('table') || '';
      const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 200));
      try {
        const allow = await catalog.allowList();
        const t = allow.find(x => x.toLowerCase() === table.toLowerCase());
        if (!t) return sendJson(res, 200, { ok: false, error: '表不存在或不在可查范围内' });
        const q = catalog.dialect() === 'mysql' ? `\`${t}\`` : `"${t}"`;
        const r = await catalog.run(`SELECT * FROM ${q} LIMIT ${limit}`, { maxRows: limit });
        sendJson(res, 200, r.ok ? { ok: true, table: t, columns: r.columns, rows: r.rows, row_count: r.row_count } : { ok: false, error: r.error });
      } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
    }],

    // 常用问题快照与统一报告
    ['GET', /^\/api\/nl2sql\/snapshots$/, (req, res) => {
      const s = store.snapshots.latest();
      sendJson(res, 200, s ? { success: true, date: s.date, items: s.items } : { success: true, date: '', items: [] });
    }],
    ['POST', /^\/api\/nl2sql\/snapshots\/refresh$/, async (req, res) => {
      try { sendJson(res, 200, { success: true, ...(await refreshSnapshots()) }); }
      catch (e) { sendJson(res, 200, { error: e.message }); }
    }],
    ['POST', /^\/api\/nl2sql\/report$/, async (req, res) => {
      const items = (req.body.items || []).slice(0, 20);
      if (!items.length) return sendJson(res, 200, { ok: false, error: '没有选中的问题' });
      const material = items.map((it, i) => `### ${i + 1}. ${it.question}\n${tableMarkdown(it.columns || [], it.rows || [], 30)}`).join('\n\n');
      if (!llm.enabled()) {
        return sendJson(res, 200, { ok: true, report: material, report_html: items.map(it => `<h3>${require('./render').esc(it.question)}</h3>${tableHtml(it.columns || [], it.rows || [], 30)}`).join('') });
      }
      try {
        const report = await llm.chat([
          { role: 'system', content: '你是客户运营数据分析师。根据给定的多组查询结果写一份统一的中文分析报告（Markdown）：先给 3~5 条核心结论，再分主题展开，引用具体数字，不要编造数据。' },
          { role: 'user', content: `${req.body.prompt ? '额外要求：' + req.body.prompt + '\n\n' : ''}数据：\n${material}` },
        ]);
        sendJson(res, 200, { ok: true, report, report_html: markdownToHtml(report) });
      } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
    }],

    // 我的常见问题
    ['GET', /^\/api\/nl2sql\/user-favorites$/, (req, res) => sendJson(res, 200, { success: true, items: store.favorites.list(userKey(req)) })],
    ['POST', /^\/api\/nl2sql\/user-favorites$/, (req, res) => {
      const q = String(req.body.question || '').trim();
      if (!q) return sendJson(res, 200, { success: false, error: '问题为空' });
      sendJson(res, 200, { success: true, id: store.favorites.create(userKey(req), q) });
    }],
    ['DELETE', /^\/api\/nl2sql\/user-favorites\/(\d+)$/, (req, res, m) => {
      sendJson(res, 200, { success: store.favorites.remove(userKey(req), Number(m[1])) > 0 });
    }],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!PREFIXES.some(x => p === x.replace(/\/$/, '') || p.startsWith(x))) return false;
    for (const [method, re, fn] of routes) {
      if (method !== req.method) continue;
      const m = re.exec(p);
      if (!m) continue;
      try {
        await ensureBody(req);
        await fn(req, res, m, url);
      } catch (e) {
        sendJson(res, e.status || 500, { success: false, ok: false, error: e.message });
      }
      return true;
    }
    return false;   // 前缀匹配但没有对应路由：交还平台处理（例如平台自己的 /api/qa_xxx）
  }

  return { handle, refreshSnapshots, syncFolder };
}

module.exports = { createRoutes, PREFIXES };
