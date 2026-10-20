'use strict';
// 系统管理：用户、角色权限、个人可见模块、客户数据权限、自定义列、登录/操作日志、行为统计
const auth = require('../core/auth');
const { PAGES, EDITS } = require('../core/perms');

const PAGE_NAME = Object.fromEntries(PAGES.map((p) => [p.perm.replace('.view', ''), p.name]));

function register(r, { repo, HttpError }) {
  const M = { perm: 'user.manage' };
  const roleMap = async () => new Map((await repo.find('roles', {})).map((ro) => [ro.id, ro]));
  const publicUser = (u, roles) => {
    const ro = roles.get(u.role_id) || {};
    const { password_hash: pw, ...rest } = u;
    return { ...rest, role_name: ro.name || '', role_code: ro.code || '', role: ro.code || '', has_password: !!pw, is_admin: (ro.permissions || []).includes('*') };
  };

  // ---------- 用户 ----------
  r.get('/api/users', async () => {
    const roles = await roleMap();
    return (await repo.find('users', {}, { order: 'id' })).map((u) => publicUser(u, roles));
  });
  r.get('/api/users/all-detail', async () => {
    const roles = await roleMap();
    const users = (await repo.find('users', {}, { order: 'id' })).map((u) => {
      const pu = publicUser(u, roles);
      return { ...pu, module_override: Array.isArray(u.module_override), module_modules: u.module_override || [] };
    });
    return { success: true, users, dynamic_cols: await repo.find('user_dynamic_cols', {}, { order: 'id' }), permissions: [...PAGES, ...EDITS] };
  }, M);
  r.post('/api/users', async (req, res, x) => {
    const b = x.body;
    if (!b.username || !b.password) throw new HttpError(400, '用户名和密码必填');
    if (await repo.findOne('users', { username: b.username })) throw new HttpError(409, '用户名已存在');
    const id = await repo.insert('users', { ...b, password_hash: auth.hashPassword(b.password), is_active: true, account_status: '在职', must_change_password: true, oem_perms: [], dynamic_cols: {} });
    return { success: true, id };
  }, M);
  r.put('/api/users/:id', async (req, res, x) => {
    const u = await repo.get('users', x.params.id);
    if (!u) throw new HttpError(404, '用户不存在');
    const { password, password_hash: ignored, ...patch } = x.body; void ignored;
    if (password) patch.password_hash = auth.hashPassword(password);
    if (patch.username && patch.username !== u.username && await repo.findOne('users', { username: patch.username })) throw new HttpError(409, '用户名已存在');
    await repo.update('users', u.id, patch);
    return { success: true };
  }, M);
  r.delete('/api/users/:id', async (req, res, x) => {
    if (Number(x.params.id) === x.user.id) return { success: false, message: '不能删除当前登录账号' };
    auth.dropUserSessions(Number(x.params.id));
    await repo.remove('users', x.params.id);
    return { success: true };
  }, M);
  r.put('/api/users/:id/toggle-active', async (req, res, x) => {
    const u = await repo.get('users', x.params.id);
    if (!u) throw new HttpError(404, '用户不存在');
    if (u.id === x.user.id) return { success: false, message: '不能停用当前登录账号' };
    await repo.update('users', u.id, { is_active: !u.is_active });
    if (u.is_active) auth.dropUserSessions(u.id);
    return { success: true, is_active: !u.is_active };
  }, M);
  r.put('/api/users/:id/oem-perms', async (req, res, x) => { await repo.update('users', x.params.id, { oem_perms: x.body.oems || [] }); return { success: true }; }, M);
  r.put('/api/users/:id/account-info', async (req, res, x) => {
    const patch = {};
    if (x.body.account_status !== undefined) patch.account_status = x.body.account_status;
    if (x.body.dynamic_cols !== undefined) patch.dynamic_cols = x.body.dynamic_cols;
    await repo.update('users', x.params.id, patch);
    return { success: true };
  }, M);
  r.get('/api/users/:id/module-perms', async (req, res, x) => {
    const u = await repo.get('users', x.params.id);
    if (!u) throw new HttpError(404, '用户不存在');
    const ro = u.role_id ? await repo.get('roles', u.role_id) : null;
    const rp = (ro && ro.permissions) || [];
    return {
      success: true, role_code: ro ? ro.code : '', is_override: Array.isArray(u.module_override), override_modules: u.module_override || [],
      role_default_modules: rp.includes('*') ? PAGES.map((p) => p.perm) : PAGES.map((p) => p.perm).filter((p) => rp.includes(p)),
      all_modules: PAGES.map((p) => ({ perm: p.perm, name: p.name, page: p.perm.replace('.view', '') })),
    };
  }, M);
  r.put('/api/users/:id/module-perms', async (req, res, x) => { await repo.update('users', x.params.id, { module_override: x.body.modules || [] }); return { success: true }; }, M);
  r.delete('/api/users/:id/module-perms', async (req, res, x) => { await repo.update('users', x.params.id, { module_override: null }); return { success: true, message: '已恢复为跟随角色默认' }; }, M);

  // 自定义列：列定义在 user_dynamic_cols，值存每个用户的 dynamic_cols JSON
  r.post('/api/user-dynamic-cols', async (req, res, x) => {
    const name = String(x.body.col_name || '').trim();
    if (!name) return { success: false, message: '列名必填' };
    const id = await repo.insert('user_dynamic_cols', { col_name: name, col_key: 'c' + Date.now().toString(36) });
    return { success: true, id };
  }, M);
  r.delete('/api/user-dynamic-cols', async (req, res, x) => {
    const col = await repo.findOne('user_dynamic_cols', { col_key: x.body.col_key || x.query.col_key });
    if (col) await repo.remove('user_dynamic_cols', col.id);
    return { success: true };
  }, M);

  // ---------- 角色 ----------
  r.get('/api/roles', async () => repo.find('roles', {}, { order: 'id' }));
  r.get('/api/permissions/pages', async () => ({ pages: PAGES, edits: EDITS }));
  r.get('/api/roles/:id/permissions', async (req, res, x) => {
    const ro = await repo.get('roles', x.params.id);
    if (!ro) throw new HttpError(404, '角色不存在');
    return { success: true, role: ro, permissions: ro.permissions || [] };
  }, M);
  r.put('/api/roles/:id/permissions', async (req, res, x) => {
    const ro = await repo.get('roles', x.params.id);
    if (!ro) throw new HttpError(404, '角色不存在');
    if ((ro.permissions || []).includes('*') && ro.is_builtin) return { success: false, message: '内置管理员角色拥有全部权限，无需修改' };
    await repo.update('roles', ro.id, { permissions: x.body.permissions || [] });
    return { success: true };
  }, M);
  r.post('/api/roles', async (req, res, x) => {
    if (!x.body.name || !x.body.code) throw new HttpError(400, '角色名和编码必填');
    return { success: true, id: await repo.insert('roles', { ...x.body, is_builtin: false, permissions: x.body.permissions || [] }) };
  }, M);
  r.delete('/api/roles/:id', async (req, res, x) => {
    const ro = await repo.get('roles', x.params.id);
    if (ro && ro.is_builtin) return { success: false, message: '内置角色不可删除' };
    if (await repo.count('users', { role_id: Number(x.params.id) })) return { success: false, message: '仍有用户使用该角色' };
    await repo.remove('roles', x.params.id);
    return { success: true };
  }, M);

  // ---------- 日志 ----------
  r.get('/api/login_logs', async () => repo.find('login_logs', {}, { order: 'id DESC', limit: 300 }), M);
  r.get('/api/operation_logs', async () => repo.find('operation_logs', {}, { order: 'id DESC', limit: 300 }), M);
  r.get('/api/activity/stats', async (req, res, x) => {
    const where = { type: x.query.type || 'page' };
    if (x.query.username) where.username = x.query.username;
    const rows = await repo.query(null, `SELECT username, target, COUNT(*) AS count, MAX(created_at) AS updated_at FROM activity_logs WHERE type = ?${where.username ? ' AND username = ?' : ''} GROUP BY username, target ORDER BY count DESC LIMIT 300`,
      [where.type, ...(where.username ? [where.username] : [])]);
    return { success: true, rows: rows.map((rw) => ({ ...rw, count: Number(rw.count), page_name: PAGE_NAME[rw.target] || '' })) };
  }, M);
}

module.exports = { register };
