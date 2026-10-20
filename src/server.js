'use strict';
const http = require('node:http');
const config = require('./config');
const { createApp } = require('./app');

createApp().then(({ handle }) => {
  const server = http.createServer((req, res) => { handle(req, res); });
  server.listen(config.PORT, () => {
    console.log(`客户运营管理平台已启动：http://localhost:${config.PORT}`);
  });
}).catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
