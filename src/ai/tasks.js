'use strict';
/**
 * 后台任务登记表：前端 AgentProgress 组件统一轮询 GET /api/task/progress/:id。
 * 进度结构：{ success, status: running|done|error|waiting_input, current, total, thought, result }
 * 任务函数返回 { need_input: true, ... } 时，状态记为 waiting_input（Agent 反问用户）。
 */
const crypto = require('node:crypto');

const TTL_MS = 60 * 60 * 1000;

function createTasks() {
  const tasks = new Map();

  function gc() {
    const now = Date.now();
    for (const [id, t] of tasks) if (t.status !== 'running' && now - t.updatedAt > TTL_MS) tasks.delete(id);
  }

  function start(fn, meta = {}) {
    gc();
    const id = crypto.randomUUID();
    const t = { id, status: 'running', current: 0, total: 1, thought: '', result: null, error: null, meta, updatedAt: Date.now() };
    tasks.set(id, t);
    const report = (p = {}) => {
      if (p.current !== undefined) t.current = p.current;
      if (p.total !== undefined) t.total = p.total;
      if (p.thought !== undefined) t.thought = String(p.thought);
      t.updatedAt = Date.now();
    };
    Promise.resolve()
      .then(() => fn(report))
      .then(result => {
        t.result = result;
        t.status = result && result.need_input ? 'waiting_input' : 'done';
        if (t.status === 'done') t.current = t.total;
      })
      .catch(err => {
        t.status = 'error';
        t.error = err && err.message ? err.message : String(err);
        t.result = { ok: false, success: false, error: t.error };
      })
      .finally(() => { t.updatedAt = Date.now(); });
    return id;
  }

  function get(id) {
    const t = tasks.get(id);
    if (!t) return null;
    return { success: true, status: t.status, current: t.current, total: t.total, thought: t.thought, result: t.result, error: t.error };
  }

  /** 同步等待（测试与非 stream 调用使用）。 */
  async function wait(id, timeoutMs = 600000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const t = get(id);
      if (!t || t.status !== 'running') return t;
      if (Date.now() > end) throw new Error('任务等待超时');
      await new Promise(r => setTimeout(r, 50));
    }
  }

  return { start, get, wait };
}

module.exports = { createTasks };
