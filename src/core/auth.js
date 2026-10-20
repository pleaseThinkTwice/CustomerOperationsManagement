'use strict';
// 账号与会话：密码 scrypt 加盐哈希；会话存内存（重启需重新登录），cookie 名 cop_sid。
const crypto = require('node:crypto');
const config = require('../config');

const SESSIONS = new Map();
const COOKIE = 'cop_sid';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(String(pw), salt, 32);
  const want = Buffer.from(hash, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res, userId) {
  const sid = crypto.randomBytes(24).toString('hex');
  SESSIONS.set(sid, { userId, expires: Date.now() + config.SESSION_TTL_HOURS * 3600e3 });
  res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.SESSION_TTL_HOURS * 3600}`);
  return sid;
}
function destroySession(req, res) {
  SESSIONS.delete(parseCookies(req)[COOKIE]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}
function sessionUserId(req) {
  const s = SESSIONS.get(parseCookies(req)[COOKIE]);
  if (!s) return null;
  if (s.expires < Date.now()) { SESSIONS.delete(parseCookies(req)[COOKIE]); return null; }
  return s.userId;
}
function dropUserSessions(userId) {
  for (const [sid, s] of SESSIONS) if (s.userId === userId) SESSIONS.delete(sid);
}

// 组装 req.user：角色权限 + 个人模块覆盖（覆盖只作用于 pageN.view 类菜单权限）
async function loadUser(repo, id) {
  const u = await repo.get('users', id);
  if (!u || !u.is_active) return null;
  const role = u.role_id ? await repo.get('roles', u.role_id) : null;
  let perms = (role && role.permissions) || [];
  if (Array.isArray(u.module_override) && !perms.includes('*')) {
    perms = perms.filter((p) => !/^page\d+\.view$|^user\.manage$/.test(p)).concat(u.module_override);
  }
  return {
    id: u.id, username: u.username, name: u.name || u.username, role_id: u.role_id,
    role_name: role ? role.name : '', role_code: role ? role.code : '', role: role ? role.code : '',
    department: u.department || '', position: u.position || '', employee_id: u.employee_id || '',
    oem_perms: u.oem_perms || [], perms, must_change_password: !!u.must_change_password,
  };
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, sessionUserId, dropUserSessions, loadUser };
