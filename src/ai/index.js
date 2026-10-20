'use strict';
/**
 * 客户运营管理平台 · AI 模块（知识库问答 + 数智分析 Text2SQL），即插即用。
 *
 * 挂载（平台后端，鉴权之后调用）：
 *   const ai = require('./ai');
 *   const aiRouter = ai.createAiRouter();          // 可传配置覆盖
 *   if (await aiRouter(req, res)) return;          // 已处理返回 true
 *
 * 其它模块复用：
 *   ai.llm.chat(messages, opts)                   → string，未配置时抛 code='LLM_DISABLED'
 *   ai.tasks.start(async (report) => result)      → task_id，前端轮询 /api/task/progress/:id
 */
const { loadConfig } = require('./config');
const { createLlm } = require('./llm');
const { createTasks } = require('./tasks');
const { createStore } = require('./store');
const { createCatalog } = require('./sql/catalog');
const { createAgent } = require('./agent');
const { createDifyEngine, createOpenAiAppEngine } = require('./engines/external');
const { createRoutes, PREFIXES } = require('./routes');
const { seedKnowledge } = require('./demo/knowledge');

let shared = null;

function createAi(overrides = {}) {
  const cfg = loadConfig(overrides);
  const llm = createLlm(cfg);
  const tasks = createTasks();
  const store = createStore(cfg.storeDb);
  const catalog = createCatalog(cfg);
  const agent = createAgent({ cfg, llm, store, catalog });
  const external = { dify: createDifyEngine(cfg), openai_app: createOpenAiAppEngine(cfg) };
  const engineFor = mode => {
    const name = (mode === 'qa' ? cfg.engine.qa : cfg.engine.analysis) || 'builtin';
    return name === 'builtin' ? agent : (external[name] || agent);
  };
  if (cfg.seedDemoKnowledge !== false) seedKnowledge(store);
  const routes = createRoutes({ cfg, store, catalog, tasks, llm, agent, engineFor });
  return { cfg, llm, tasks, store, catalog, agent, engineFor, routes, handle: routes.handle };
}

function instance() {
  if (!shared) shared = createAi();
  return shared;
}

/** 返回 (req, res) => Promise<boolean> */
function createAiRouter(overrides) {
  if (overrides && Object.keys(overrides).length) shared = createAi(overrides);
  const ai = instance();
  return (req, res) => ai.handle(req, res);
}

module.exports = {
  createAiRouter,
  createAi,
  PREFIXES,
  // 懒加载的共享实例：平台其它模块的 AI 任务也走同一个大模型与任务表
  llm: { chat: (...a) => instance().llm.chat(...a), enabled: () => instance().llm.enabled() },
  tasks: { start: (...a) => instance().tasks.start(...a), get: id => instance().tasks.get(id) },
  // 供平台定时任务每日刷新常用问题快照
  refreshSnapshots: () => instance().routes.refreshSnapshots(),
};
