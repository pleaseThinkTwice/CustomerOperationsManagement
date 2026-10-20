'use strict';
// 请求体解析：JSON / x-www-form-urlencoded / multipart/form-data（文件读入内存，单请求上限 MAX_BYTES）。
const MAX_BYTES = 200 * 1024 * 1024;

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, boundary) {
  const fields = {}; const files = [];
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (buf[pos] === 45 && buf[pos + 1] === 45) break; // "--" 结束
    pos += 2; // CRLF
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd === -1) break;
    const head = buf.slice(pos, headEnd).toString('utf8');
    const next = buf.indexOf(delim, headEnd + 4);
    if (next === -1) break;
    const content = buf.slice(headEnd + 4, next - 2);
    const name = (head.match(/name="([^"]*)"/i) || [])[1];
    const fnStar = head.match(/filename\*=UTF-8''([^;\r\n]+)/i);
    const fn = fnStar ? decodeURIComponent(fnStar[1]) : (head.match(/filename="([^"]*)"/i) || [])[1];
    const mime = (head.match(/content-type:\s*([^\r\n]+)/i) || [])[1];
    if (fn !== undefined) {
      if (fn) files.push({ field: name, filename: fn, mimetype: mime || 'application/octet-stream', buffer: content });
    } else if (name) {
      fields[name] = content.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

async function parseBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return { body: {}, files: [], fields: {} };
  const type = String(req.headers['content-type'] || '');
  const raw = await readRaw(req);
  if (type.startsWith('multipart/form-data')) {
    const boundary = (type.match(/boundary=(?:"([^"]+)"|([^;]+))/i) || []).slice(1).find(Boolean);
    const { fields, files } = parseMultipart(raw, boundary);
    return { body: { ...fields }, files, fields };
  }
  if (!raw.length) return { body: {}, files: [], fields: {} };
  const text = raw.toString('utf8');
  if (type.includes('application/x-www-form-urlencoded')) {
    return { body: Object.fromEntries(new URLSearchParams(text)), files: [], fields: {} };
  }
  try { return { body: JSON.parse(text), files: [], fields: {} }; } catch (e) {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

module.exports = { parseBody };
