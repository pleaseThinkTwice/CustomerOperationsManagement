'use strict';
// 登录 / 会话 / 当前用户 / 改密 / 页面访问埋点
const auth = require('../core/auth');

function register(r, { repo, HttpError }) {
  r.post('/api/login', async (req, res, x) => {
    const username = String(x.body.username || '').trim();
    const u = username ? await repo.findOne('users', { username }) : null;
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
    const ok = !!(u && u.is_active && auth.verifyPassword(x.body.password || '', u.password_hash));
    await repo.insert('login_logs', { username, ip, success: ok, detail: ok ? '登录成功' : (u && !u.is_active ? '账号已停用' : '账号或密码错误') });
    if (!ok) throw new HttpError(401, u && !u.is_active ? '账号已停用' : '账号或密码错误');
    auth.createSession(res, u.id);
    await repo.update('users', u.id, { last_login_at: repo.now() });
    return { success: true, user: await auth.loadUser(repo, u.id) };
  }, { public: true });

  r.post('/api/logout', async (req, res) => { auth.destroySession(req, res); return { success: true }; }, { public: true });

  r.get('/api/me', async (req, res, x) => ({ success: true, user: x.user }));

  r.post('/api/change_password', async (req, res, x) => {
    const { old_password: oldPw, new_password: newPw } = x.body;
    if (!newPw || String(newPw).length < 6) return { success: false, message: '新密码至少 6 位' };
    const u = await repo.get('users', x.user.id);
    if (!auth.verifyPassword(oldPw || '', u.password_hash)) return { success: false, message: '原密码错误' };
    await repo.update('users', u.id, { password_hash: auth.hashPassword(newPw), must_change_password: false });
    return { success: true, message: '已修改' };
  });

  r.post('/api/activity/track', async (req, res, x) => {
    await repo.insert('activity_logs', { username: x.user.username, type: x.body.type || 'page', target: x.body.target || '' });
    return { success: true };
  });
}

module.exports = { register };
