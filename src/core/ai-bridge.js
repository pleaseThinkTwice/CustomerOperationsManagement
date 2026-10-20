'use strict';
// AI 能力桥接：优先使用 src/ai 模块（QA / text2sql 线程实现，提供 tasks + llm + createAiRouter）；
// 该模块不存在时用这里的同接口本地实现，保证业务路由始终可用。
//   tasks.start(async (report) => result) → task_id；report({ current, total, thought })
//   tasks.get(id) → { success, status, current, total, thought, result }
//   llm.chat(messages, opts) → string；未配置时抛出 code = 'LLM_DISABLED'
const crypto = require('node:crypto');

let external = null;
try { external = require('../ai'); } catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes('../ai')) throw e;
}

function createLocalTasks() {
  const TASKS = new Map();
  return {
    start(fn) {
      const id = crypto.randomBytes(8).toString('hex');
      const t = { success: true, status: 'running', current: 0, total: 1, thought: '', result: null, created: Date.now() };
      TASKS.set(id, t);
      const report = (p) => Object.assign(t, p || {});
      Promise.resolve().then(() => fn(report)).then(
        (result) => Object.assign(t, { status: 'done', current: t.total, result }),
        (err) => Object.assign(t, { status: 'error', result: { success: false, ok: false, error: err.message, message: err.message } }),
      );
      // 清理 1 小时前的任务
      for (const [k, v] of TASKS) if (Date.now() - v.created > 3600e3) TASKS.delete(k);
      return id;
    },
    get(id) { return TASKS.get(id) || null; },
  };
}

function createLocalLlm() {
  const base = process.env.LLM_BASE_URL; const key = process.env.LLM_API_KEY; const model = process.env.LLM_MODEL;
  return {
    enabled: !!(base && model),
    async chat(messages, opts = {}) {
      if (!base || !model) throw Object.assign(new Error('未配置大模型（LLM_BASE_URL / LLM_MODEL）'), { code: 'LLM_DISABLED' });
      const r = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.2, ...(opts.json ? { response_format: { type: 'json_object' } } : {}) }),
      });
      if (!r.ok) throw new Error(`LLM 调用失败 HTTP ${r.status}`);
      const j = await r.json();
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    },
  };
}

const tasks = (external && external.tasks) || createLocalTasks();
const llm = (external && external.llm) || createLocalLlm();

// 调用 LLM，失败（含未配置）时返回 null，由调用方走规则化兜底
async function tryChat(messages, opts) {
  try { return await llm.chat(messages, opts); } catch (e) {
    if (e.code !== 'LLM_DISABLED') console.warn('[llm]', e.message);
    return null;
  }
}
function parseJsonLoose(text) {
  if (!text) return null;
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = m ? m[1] : text;
  try { return JSON.parse(s); } catch (e) {
    const i = s.indexOf('{'); const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e2) { return null; } }
    return null;
  }
}

// 前端 AgentProgress 约定：请求体带 stream=true 时立即返回 { task_id } 再轮询进度；否则同步返回结果
async function respondTask(body, fn) {
  const stream = body && (body.stream === true || body.stream === 'true' || body.stream === '1');
  if (stream) return { success: true, task_id: tasks.start(fn) };
  return fn(() => {});
}

module.exports = { external, tasks, llm, tryChat, parseJsonLoose, respondTask };
