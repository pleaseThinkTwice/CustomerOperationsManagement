'use strict';
/**
 * HTTP 小工具。挂载到平台后端时请求体已由平台解析（req.body / req.files / req.fields），
 * 只有独立运行（req.body === undefined）时才在这里读取请求流。
 */

function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readRaw(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return { fields: {}, files: [] };
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}; const files = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(boundary, start);
    if (next === -1) break;
    const part = buf.slice(start + 2, next - 2);   // 去掉开头 \r\n 和结尾 \r\n
    const sep = part.indexOf('\r\n\r\n');
    const head = part.slice(0, sep).toString('utf8');
    const body = part.slice(sep + 4);
    const name = (/name="([^"]*)"/i.exec(head) || [])[1];
    const filename = (/filename="([^"]*)"/i.exec(head) || [])[1];
    const mimetype = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || 'application/octet-stream';
    if (filename !== undefined) files.push({ field: name, filename, mimetype, buffer: body });
    else if (name) fields[name] = body.toString('utf8');
    pos = next;
  }
  return { fields, files };
}

/** 确保 req.body / req.files / req.fields 可用 */
async function ensureBody(req) {
  if (req.body !== undefined) { req.files = req.files || []; req.fields = req.fields || {}; return; }
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') { req.body = {}; req.files = []; req.fields = {}; return; }
  const raw = await readRaw(req);
  const ct = req.headers['content-type'] || '';
  if (/multipart\/form-data/i.test(ct)) {
    const { fields, files } = parseMultipart(raw, ct);
    req.fields = fields; req.files = files; req.body = { ...fields };
  } else {
    req.files = []; req.fields = {};
    try { req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) { req.body = {}; }
  }
}

module.exports = { sendJson, ensureBody, parseMultipart };
