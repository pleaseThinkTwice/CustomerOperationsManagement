# 客户运营管理平台

原型页面 `客户运营管理平台离线演示.html` + 零依赖 Node 后端。后端实现了原型用到的全部 `/api/*` 接口，数据层可插拔：本地开箱用 sqlite 和自动生成的演示数仓数据，到公司改 `.env` 即可接 MySQL / Doris。

## 快速开始

需要 Node 22.13 及以上，不需要 `npm install`。

```bash
npm start            # http://localhost:3000 ，管理员 admin / admin123
npm test             # 接口测试
npm run reset-data   # 清空本地数据，下次启动重新生成
```

首次启动会在 `data/` 下建运营库 `ops.sqlite`（含演示业务数据）和演示数仓 `analytics-demo.sqlite`。服务直接托管原型页面，并关闭页面内置的离线 mock，所有请求走真实接口。换原型文件用 `PROTOTYPE_HTML=路径`。

## 接公司数据

1. 复制 `.env.example` 为 `.env`，配置 `ANALYTICS_DB_DRIVER=mysql`、`ANALYTICS_DB_URL`、表名前缀或单表映射。
2. `npm i mysql2`
3. `npm run check-analytics` 逐表逐字段自检。
4. `npm start`

详细见 [docs/数据需求.md](docs/数据需求.md)。

## 文档

- [docs/业务逻辑.md](docs/业务逻辑.md)：每个页面的逻辑、指标口径、待决策事项
- [docs/页面逻辑说明.md](docs/页面逻辑说明.md) / [docs/页面逻辑问题清单.md](docs/页面逻辑问题清单.md)：前端各页面逻辑与待处理问题
- [docs/数据需求.md](docs/数据需求.md)：公司侧要准备的表、取值约定、接入步骤
- [docs/数据表DDL.md](docs/数据表DDL.md)：分析库 / 运营库字段与建表语句（生成）
- [docs/API.md](docs/API.md)：接口清单（生成）

改了路由或表结构后运行 `npm run docs` 重新生成两份生成文档。

## 目录

```
src/
  server.js / app.js     入口、路由装配、登录校验、操作日志
  config.js              .env 读取
  http/                  路由、请求体解析（JSON / 表单 / 文件上传）
  core/                  鉴权、权限、文件存储、xlsx 读写、通知、AI 桥接
  db/                    运营库：驱动（sqlite / mysql）、表结构、通用增删改查、初始化数据
  analytics/             分析库：表结构（公司侧要提供的表）、全部看板口径、演示数据生成
  routes/                按页面划分的接口
  ai/                    Q&A 知识库问答 + 数智分析（text2sql），挂在同一个服务上
public/login.html        登录页
scripts/                 数仓自检、文档生成
test/                    node:test 接口测试
```

## AI：Q&A 知识库 + 数智分析

`npm start` 后直接可用。数智分析默认查分析库（与首页看板同一份数据），不配大模型时问答走关键词匹配、数智分析执行示例 SQL。接大模型配 `.env` 里的 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`。细节见 [docs/AI模块-问答与Text2SQL接入说明.md](docs/AI模块-问答与Text2SQL接入说明.md)。
