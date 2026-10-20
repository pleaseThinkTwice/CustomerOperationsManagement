'use strict';
// 上传文件存储：落盘到 data/uploads/<分类>/<时间戳>_<随机>_<原名>，数据库只记相对路径。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', '.html': 'text/html; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeOf = (name) => MIME[path.extname(name || '').toLowerCase()] || 'application/octet-stream';

function save(category, file) {
  const dir = path.join(config.UPLOAD_DIR, category);
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(file.filename || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120);
  const rel = path.join(category, `${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${safe}`);
  fs.writeFileSync(path.join(config.UPLOAD_DIR, rel), file.buffer);
  return { stored_path: rel, file_size: file.buffer.length, mime: file.mimetype || mimeOf(safe) };
}
function read(rel) {
  if (!rel) return null;
  const abs = path.resolve(config.UPLOAD_DIR, rel);
  if (!abs.startsWith(path.resolve(config.UPLOAD_DIR)) || !fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}
function remove(rel) {
  if (!rel) return;
  const abs = path.resolve(config.UPLOAD_DIR, rel);
  if (abs.startsWith(path.resolve(config.UPLOAD_DIR))) fs.rmSync(abs, { force: true });
}

module.exports = { save, read, remove, mimeOf };
