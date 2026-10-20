'use strict';
// 应用装配：数据库 → 种子数据 → 分析层 → 路由；导出 handle(req, res) 供 http.createServer 使用。
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { openDb } = require('./db');
const { createRepo } = require('./db/repo');
const { seed } = require('./db/seed');
const { createAnalytics } = require('./analytics');
const { Router, HttpError, sendJson } = require('./http/router');
const { parseBody } = require('./http/body');
const auth = require('./core/auth');
const ai = require('./core/ai-bridge');
const { buildSemantic } = require('./core/ai-semantic');

const ROUTE_MODULES = [
  'auth', 'customers', 'meetings', 'warnings', 'dashboard', 'workbench', 'demands', 'contracts', 'documents',
  'system', 'insights', 'misc',
];

async function createApp() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const db = openDb(config.OPS_DB);
  const repo = createRepo(db);
  if (await seed(db, repo)) console.log('[ops] 已初始化运营库（管理员 admin / ' + (process.env.ADMIN_PASSWORD ? '已按 ADMIN_PASSWORD 设置' : config.ADMIN_PASSWORD) + '）');
  const analytics = await createAnalytics();

  const router = new Router();
  const ctx = { db, repo, analytics, ai, config, HttpError };
  for (const m of ROUTE_MODULES) require('./routes/' + m).register(router, ctx);

  // QA / text2sql 模块（另一线程实现）存在时挂载；否则只提供任务进度接口
  const aiRouter = ai.external && typeof ai.external.createAiRouter === 'function'
    ? ai.external.createAiRouter(aiOverrides())
    : null;
  if (!aiRouter) {
    router.get('/api/task/progress/:id', async (req, res, x) => {
      const t = ai.tasks.get(x.params.id);
      if (!t) return { success: false, error: '任务不存在或已过期' };
      return { success: true, status: t.status, current: t.current, total: t.total, thought: t.thought, result: t.result };
    });
  }

  const html = loadPrototype();
  const loginHtml = fs.readFileSync(path.join(config.ROOT, 'public', 'login.html'));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        if (!auth.sessionUserId(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html());
      }
      if (req.method === 'GET' && p === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginHtml);
      }
      if (p === '/health') return sendJson(res, 200, { status: 'ok', service: 'CustomerOperationsManagement', ops_db: config.OPS_DB.driver, analytics_db: analytics.driver, llm: !!(ai.llm && ai.llm.enabled) });
      if (!p.startsWith('/api/')) return sendJson(res, 404, { error: 'Not Found' });

      const parsed = await parseBody(req);
      req.body = parsed.body; req.files = parsed.files; req.fields = parsed.fields;
      const query = Object.fromEntries(url.searchParams);
      const match = router.match(req.method, p);

      const isPublic = match && match.route.opts.public;
      let user = null;
      const uid = auth.sessionUserId(req);
      if (uid) user = await auth.loadUser(repo, uid);
      if (!user && !isPublic) return sendJson(res, 401, { success: false, error: '未登录或会话已过期' });
      req.user = user;
      if (match && match.route.opts.perm && !require('./core/perms').hasPerm(user, match.route.opts.perm)) {
        return sendJson(res, 403, { success: false, error: '权限不足', message: '权限不足' });
      }

      let result;
      if (match) {
        result = await match.route.handler(req, res, { params: match.params, query, body: req.body || {}, files: req.files, fields: req.fields, user, url });
      } else if (aiRouter && await aiRouter(req, res)) {
        result = undefined;
      } else {
        return sendJson(res, 404, { success: false, error: `接口不存在：${req.method} ${p}` });
      }
      if (req.method !== 'GET' && user && !p.startsWith('/api/activity') && !p.startsWith('/api/task')) {
        repo.insert('operation_logs', { username: user.username, method: req.method, path: p, status: res.statusCode || 200 }).catch(() => {});
      }
      if (result !== undefined) sendJson(res, 200, result);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[api]', req.method, p, e);
      sendJson(res, status, { success: false, error: e.message, message: e.message, ...(e.extra || {}) });
    }
  }
  return { handle, db, repo, analytics };
}

// 读取原型 HTML，并在最前面注入开关让内置的离线 mock 拦截器失效（页面改走真实接口）
function loadPrototype() {
  let cache = null; let mtime = 0;
  return () => {
    const st = fs.statSync(config.PROTOTYPE_HTML);
    if (!cache || st.mtimeMs !== mtime) {
      const src = fs.readFileSync(config.PROTOTYPE_HTML, 'utf8');
      const inject = '<script>window.__offlineMockInstalled = true; window.__COP_BACKEND = true;</script>';
      cache = src.replace(/<head>/i, '<head>\n' + inject).replace(/<title>([^<]*)离线演示版<\/title>/, '<title>$1在线版</title>');
      mtime = st.mtimeMs;
    }
    return cache;
  };
}

// 数智分析默认查分析库（与看板同一份数据）；单独设置了 AI_SQL_* 时以 AI 模块自己的配置为准
function aiOverrides() {
  const o = { storeDb: path.join(config.DATA_DIR, 'ai.sqlite'), kbFolder: path.join(config.DATA_DIR, 'kb') };
  if (process.env.AI_SQL_TYPE || process.env.AI_SQL_FILE || process.env.AI_SQL_URL) return o;
  const A = config.ANALYTICS_DB;
  const tableName = (t) => process.env['ANALYTICS_TABLE_' + t] || (A.tablePrefix + t);
  o.semanticFile = buildSemantic({ root: config.ROOT, dataDir: config.DATA_DIR, tableName });
  o.sql = A.driver === 'demo' ? { type: 'sqlite', file: A.file } : { type: 'doris', url: A.url };
  return o;
}

module.exports = { createApp };
