'use strict';
/**
 * AI 模块配置：默认值 ← config/ai.json ← 环境变量（后者覆盖前者）。
 * 所有与公司相关的东西（模型地址、密钥、业务库连接、表口径）都只在这里进入模块。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULTS = {
  // 引擎：builtin = 本模块自带的 RAG + Text2SQL Agent；dify / openai_app = 转发给外部平台
  engine: { qa: 'builtin', analysis: 'builtin' },
  llm: {
    // 任何 OpenAI 兼容接口：OpenAI、DeepSeek、通义千问 DashScope 兼容模式、vLLM、Ollama、Xinference、One API 等
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.1,
    timeoutMs: 120000,
    // 模型不支持 function calling 时改为 false，Agent 会退化为「检索 → 生成 SQL → 执行 → 总结」固定流程
    toolCalling: true,
  },
  storeDb: path.join(ROOT, 'data', 'ai.sqlite'),
  kbFolder: path.join(ROOT, 'data', 'kb'),
  sql: {
    // 业务库（只读）。type: sqlite | mysql | doris | postgres
    type: 'sqlite',
    // sqlite 用 file；mysql/doris/postgres 用 url，例如 mysql://ro_user:pwd@host:9030/test
    file: path.join(ROOT, 'data', 'demo_business.sqlite'),
    url: '',
    maxRows: 5000,
    timeoutMs: 30000,
    // 只允许查询这些表（空 = 语义层里登记过的表；'*' = 库里所有表）
    allowTables: [],
  },
  semanticFile: path.join(ROOT, 'config', 'semantic.json'),
  agent: { maxSteps: 8, historyTurns: 6 },
  // 全量放入提示词的上限（字符）。Q&A、知识片段和表结构都较小，默认全量进上下文、不做 RAG；超出时才截断
  contextBudgetChars: 60000,
  external: {
    dify: { baseUrl: '', qaKey: '', analysisKey: '' },
    // RAGFlow / MaxKB / FastGPT 等提供 OpenAI 兼容对话接口的知识库平台
    openai_app: { qaUrl: '', qaKey: '', qaModel: 'model', analysisUrl: '', analysisKey: '', analysisModel: 'model' },
  },
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function fromEnv(env) {
  const o = { llm: {}, sql: {}, engine: {}, external: { dify: {}, openai_app: {} } };
  const set = (obj, key, val, fn) => { if (val !== undefined && val !== '') obj[key] = fn ? fn(val) : val; };
  set(o.llm, 'baseUrl', env.AI_LLM_BASE_URL || env.LLM_BASE_URL);
  set(o.llm, 'apiKey', env.AI_LLM_API_KEY || env.LLM_API_KEY);
  set(o.llm, 'model', env.AI_LLM_MODEL || env.LLM_MODEL);
  set(o.llm, 'toolCalling', env.AI_LLM_TOOL_CALLING, v => v !== 'false' && v !== '0');
  set(o.sql, 'type', env.AI_SQL_TYPE);
  set(o.sql, 'file', env.AI_SQL_FILE, v => path.resolve(ROOT, v));
  set(o.sql, 'url', env.AI_SQL_URL);
  set(o.sql, 'maxRows', env.AI_SQL_MAX_ROWS, Number);
  set(o.sql, 'allowTables', env.AI_SQL_ALLOW_TABLES, v => v.split(',').map(s => s.trim()).filter(Boolean));
  set(o.engine, 'qa', env.AI_ENGINE_QA);
  set(o.engine, 'analysis', env.AI_ENGINE_ANALYSIS);
  set(o.external.dify, 'baseUrl', env.AI_DIFY_BASE_URL);
  set(o.external.dify, 'qaKey', env.AI_DIFY_QA_KEY);
  set(o.external.dify, 'analysisKey', env.AI_DIFY_ANALYSIS_KEY);
  set(o.external.openai_app, 'qaUrl', env.AI_APP_QA_URL);
  set(o.external.openai_app, 'qaKey', env.AI_APP_QA_KEY);
  set(o.external.openai_app, 'analysisUrl', env.AI_APP_ANALYSIS_URL);
  set(o.external.openai_app, 'analysisKey', env.AI_APP_ANALYSIS_KEY);
  if (env.AI_STORE_DB) o.storeDb = path.resolve(ROOT, env.AI_STORE_DB);
  if (env.AI_SEMANTIC_FILE) o.semanticFile = path.resolve(ROOT, env.AI_SEMANTIC_FILE);
  if (env.AI_KB_FOLDER) o.kbFolder = path.resolve(ROOT, env.AI_KB_FOLDER);
  return o;
}

function loadConfig(overrides = {}, env = process.env) {
  let fileCfg = {};
  const file = env.AI_CONFIG_FILE ? path.resolve(ROOT, env.AI_CONFIG_FILE) : path.join(ROOT, 'config', 'ai.json');
  if (fs.existsSync(file)) fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return deepMerge(deepMerge(deepMerge(DEFAULTS, fileCfg), fromEnv(env)), overrides);
}

module.exports = { loadConfig, ROOT };
