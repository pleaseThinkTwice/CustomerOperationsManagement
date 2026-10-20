'use strict';
/**
 * AI 模块独立演示服务：打开原型 HTML，问答（Q&A 知识库）与数智分析两页走真实后端，其它页面仍用原型内置假数据。
 *
 *   npm run ai:demo            → http://localhost:3100/
 *
 * 原型 HTML 不做任何修改：返回页面时在离线拦截器前后各注入一小段脚本，
 * 让 AI 相关前缀的请求绕过拦截器发到本服务。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createAi, PREFIXES } = require('./index');
const { seed } = require('./demo/seed');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML = path.join(ROOT, '客户运营管理平台离线演示.html');
const PORT = Number(process.env.AI_DEMO_PORT || 3100);

function injectPassthrough(html) {
  const marker = '<!-- ==== 离线演示数据拦截器';
  const i = html.indexOf(marker);
  if (i < 0) return html;
  const end = html.indexOf('</script>', i) + '</script>'.length;
  const before = '<script>window.__AI_REAL_FETCH__ = window.fetch.bind(window);</script>\n';
  const after = `\n<script>
(function () {
  var mock = window.fetch, real = window.__AI_REAL_FETCH__, P = ${JSON.stringify(PREFIXES)};
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
    for (var k = 0; k < P.length; k++) {
      var p = P[k];
      if (u === p.replace(/\\/$/, '') || u.indexOf(p) === 0) return real(input, init);
    }
    return mock(input, init);
  };
})();
</script>`;
  return html.slice(0, i) + before + html.slice(i, end) + after + html.slice(end);
}

function main() {
  const ai = createAi();
  if (ai.cfg.sql.type === 'sqlite' && !fs.existsSync(ai.cfg.sql.file) && /demo_business\.sqlite$/.test(ai.cfg.sql.file)) {
    console.log('生成演示业务库：', seed(ai.cfg.sql.file));
  }
  const page = injectPassthrough(fs.readFileSync(HTML, 'utf8'));
  const server = http.createServer(async (req, res) => {
    try {
      if (await ai.handle(req, res)) return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: e.message }));
    }
    if (req.url === '/' || req.url.startsWith('/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  server.listen(PORT, () => {
    console.log(`AI 演示服务：http://localhost:${PORT}/  （Q&A 知识库 / 数智分析页走真实接口）`);
    console.log(`大模型：${ai.llm.enabled() ? ai.cfg.llm.model : '未配置（离线兜底模式）'}；业务库：${ai.cfg.sql.type} ${ai.cfg.sql.type === 'sqlite' ? ai.cfg.sql.file : ''}`);
  });
}

if (require.main === module) main();

module.exports = { injectPassthrough };
