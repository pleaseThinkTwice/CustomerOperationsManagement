'use strict';
// 通知发送（会议待办提醒、阶段总结邮件等）。可插拔：
//   NOTIFY_DRIVER=log      默认，只写服务端日志并返回成功，便于演示
//   NOTIFY_DRIVER=webhook  POST JSON 到 NOTIFY_WEBHOOK（企业微信/飞书/钉钉机器人或公司消息网关）
const config = require('../config');

async function send(repo, { to, cc, title, content }) {
  const users = to ? await repo.find('users', {}) : [];
  const target = users.find((u) => u.name === to || u.username === to);
  const msg = { to, to_email: target ? target.email : '', cc: cc || '', title, content };
  if (config.NOTIFY.driver === 'webhook' && config.NOTIFY.webhook) {
    try {
      const r = await fetch(config.NOTIFY.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
      return { ok: r.ok, message: r.ok ? `已通知 ${to}` : `通知网关返回 HTTP ${r.status}` };
    } catch (e) { return { ok: false, message: '通知发送失败：' + e.message }; }
  }
  console.log('[notify]', JSON.stringify(msg));
  return { ok: true, message: `已通知 ${to}（演示模式：仅记录日志）` };
}

module.exports = { send };
