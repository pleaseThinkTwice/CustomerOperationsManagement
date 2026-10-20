'use strict';
// 全部配置走环境变量（可放 .env，见 .env.example）。与公司系统相关的只有 *_DB_* 与 LLM_*。
const path = require('node:path');
const fs = require('node:fs');

// 极简 .env 读取（不覆盖已存在的环境变量），避免引入 dotenv 依赖
(function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
})();

const env = process.env;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');

module.exports = {
  ROOT,
  DATA_DIR,
  PORT: Number(env.PORT || 3000),
  PROTOTYPE_HTML: path.resolve(ROOT, env.PROTOTYPE_HTML || '客户运营管理平台离线演示.html'),
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  SESSION_TTL_HOURS: Number(env.SESSION_TTL_HOURS || 12),
  // 运营库：平台自己的业务表（客户档案、会议、预警闭环、合同…）。sqlite=本地文件；mysql=公司 MySQL
  OPS_DB: {
    driver: env.OPS_DB_DRIVER || 'sqlite',
    file: path.resolve(DATA_DIR, env.OPS_DB_FILE || 'ops.sqlite'),
    url: env.OPS_DB_URL || '',
  },
  // 分析库：公司数仓（Doris）只读数据。demo=本地生成演示数据；mysql=Doris/MySQL 协议直连
  ANALYTICS_DB: {
    driver: env.ANALYTICS_DB_DRIVER || 'demo',
    file: path.resolve(DATA_DIR, env.ANALYTICS_DB_FILE || 'analytics-demo.sqlite'),
    url: env.ANALYTICS_DB_URL || '',
    // 表名映射：公司库里表名不同可用 ANALYTICS_TABLE_<逻辑名>=实际库.表 覆盖
    tablePrefix: env.ANALYTICS_TABLE_PREFIX || '',
  },
  // 邮件/通知：未配置时只记录日志、返回模拟成功
  NOTIFY: { driver: env.NOTIFY_DRIVER || 'log', webhook: env.NOTIFY_WEBHOOK || '' },
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || 'admin123',
};
