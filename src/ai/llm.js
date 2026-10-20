'use strict';
/**
 * OpenAI 兼容的大模型客户端（零依赖，使用 Node 自带 fetch）。
 * 公司换模型只改配置：baseUrl 指向 /v1 前缀，例如
 *   https://api.deepseek.com/v1、https://dashscope.aliyuncs.com/compatible-mode/v1、http://vllm:8000/v1
 */

function llmError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function createLlm(cfg) {
  const c = cfg.llm;
  const enabled = () => !!(c.baseUrl && c.model);

  async function post(base, key, pathName, body, timeoutMs) {
    const url = base.replace(/\/+$/, '') + pathName;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 120000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw llmError(`大模型接口返回 ${res.status}: ${text.slice(0, 300)}`, 'LLM_HTTP');
      return JSON.parse(text);
    } catch (e) {
      if (e.name === 'AbortError') throw llmError('大模型接口超时', 'LLM_TIMEOUT');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 返回完整 assistant message（含 tool_calls）。 */
  async function complete(messages, opts = {}) {
    if (!enabled()) throw llmError('未配置大模型（AI_LLM_BASE_URL / AI_LLM_MODEL）', 'LLM_DISABLED');
    const body = {
      model: opts.model || c.model,
      messages,
      temperature: opts.temperature ?? c.temperature,
    };
    if (opts.tools && opts.tools.length) { body.tools = opts.tools; body.tool_choice = 'auto'; }
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    const data = await post(c.baseUrl, c.apiKey, '/chat/completions', body, opts.timeoutMs || c.timeoutMs);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw llmError('大模型返回格式异常', 'LLM_BAD_RESPONSE');
    return msg;
  }

  /** 供其它模块使用的简单接口：返回字符串。 */
  async function chat(messages, opts = {}) {
    const msg = await complete(messages, opts);
    return msg.content || '';
  }

  return { enabled, complete, chat };
}

module.exports = { createLlm, llmError };
