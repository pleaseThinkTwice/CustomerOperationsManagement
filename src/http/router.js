'use strict';
// 零依赖的极简路由：method + 路径模板（:param），处理函数返回值自动序列化为 JSON。
// 处理函数签名：async (req, res, ctx) => any，ctx = { params, query, body, user, files, fields }
//   返回 undefined 表示已自行写响应；返回 HttpError 子类或抛出时给出对应状态码。

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts, pattern });
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  const s = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function sendFile(res, buf, { filename, mime, inline } = {}) {
  const disp = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename || 'download')}`;
  res.writeHead(200, { 'Content-Type': mime || 'application/octet-stream', 'Content-Disposition': disp, 'Content-Length': buf.length });
  res.end(buf);
}

module.exports = { Router, HttpError, sendJson, sendFile };
