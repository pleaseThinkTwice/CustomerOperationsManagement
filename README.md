# CustomerOperationsManagement

这是一个基础的客户运营管理项目初始化模板，已搭建最小可运行的 Node.js 服务。

## 目录结构

- `src/server.js` - 服务入口
- `package.json` - 项目脚本配置

## 快速开始

```bash
npm install
npm start
```

启动后访问：

- http://localhost:3000/
- http://localhost:3000/health

## 开发模式

```bash
npm run dev
```

该模板可作为后续功能开发的基础骨架，后续可以扩展客户管理、工单、运营报表等模块。

## AI 模块：知识库问答 + 数智分析（Text2SQL）

`src/ai/` 是即插即用的 AI 模块，为原型的「Q&A知识库」「数智分析」两页提供真实后端，零依赖（Node 22.13+）。

```bash
npm run ai:demo   # http://localhost:3100/ ，未配置大模型时为离线兜底模式
npm test
```

接真实大模型和业务库只需设置环境变量或 `config/ai.json`。逻辑说明、配置项和到公司需要提供的数据清单见 [docs/AI模块-问答与Text2SQL接入说明.md](docs/AI模块-问答与Text2SQL接入说明.md)。
