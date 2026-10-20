'use strict';
/**
 * 外部平台适配器：公司已有（或后续部署）Dify / RAGFlow / MaxKB / FastGPT / SQLBot 等时，
 * 只改配置就把问答或数智分析转发过去，前端和接口不变。
 *
 *  - dify：Dify 应用 API  POST {baseUrl}/v1/chat-messages（blocking 模式）
 *          可以在 Dify 里编排「知识库问答」或「问数」工作流（例如接 SQLBot / DB-GPT 工具）
 *  - openai_app：任何 OpenAI 兼容的对话应用接口（完整 URL），例如
 *          RAGFlow  {host}/api/v1/openai/{chat_id}/chat/completions
 *          MaxKB / FastGPT 应用的 OpenAI 兼容接口
 */
const { markdownToHtml } = require('../render');

async function postJson(url, key, body, timeoutMs = 180000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`外部平台返回 ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('外部平台接口超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function result(mode, engine, answer, extra = {}) {
  return {
    success: true, ok: true, mode, engine, answer, report_html: markdownToHtml(answer),
    tools_used: [engine], trace: extra.trace || [], steps: 1, columns: [], rows: [], row_count: 0, ...extra,
  };
}

function createDifyEngine(cfg) {
  const conv = new Map();   // `${user}:${mode}` → conversation_id，用于多轮对话
  return {
    name: 'dify',
    async run({ query, mode, history, user }) {
      const c = cfg.external.dify;
      const key = mode === 'qa' ? c.qaKey : c.analysisKey;
      if (!c.baseUrl || !key) throw new Error('Dify 未配置（AI_DIFY_BASE_URL / AI_DIFY_QA_KEY / AI_DIFY_ANALYSIS_KEY）');
      const uid = user ? String(user.username || user.id || 'anonymous') : 'anonymous';
      const ck = `${uid}:${mode}`;
      if (!history || !history.length) conv.delete(ck);   // 前端「新会话」时 history 为空
      const data = await postJson(c.baseUrl.replace(/\/+$/, '') + '/v1/chat-messages', key, {
        inputs: {}, query, response_mode: 'blocking', user: uid, conversation_id: conv.get(ck) || '',
      });
      if (data.conversation_id) conv.set(ck, data.conversation_id);
      const refs = (data.metadata && data.metadata.retriever_resources) || [];
      const trace = refs.map(r => ({ tool: 'dify_retrieve', args: r.document_name || r.dataset_name || '', text: (r.content || '').slice(0, 200), ok: true }));
      return result(mode, 'dify', data.answer || '', { trace });
    },
  };
}

function createOpenAiAppEngine(cfg) {
  return {
    name: 'openai_app',
    async run({ query, mode, history }) {
      const c = cfg.external.openai_app;
      const url = mode === 'qa' ? c.qaUrl : c.analysisUrl;
      const key = mode === 'qa' ? c.qaKey : c.analysisKey;
      const model = (mode === 'qa' ? c.qaModel : c.analysisModel) || 'model';
      if (!url) throw new Error('外部对话应用未配置（AI_APP_QA_URL / AI_APP_ANALYSIS_URL）');
      const messages = [...(history || []).filter(h => h && h.content).slice(-6), { role: 'user', content: query }];
      const data = await postJson(url, key, { model, messages, stream: false });
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const chunks = (msg.reference && msg.reference.chunks) || [];
      const trace = (Array.isArray(chunks) ? chunks : Object.values(chunks)).slice(0, 10)
        .map(r => ({ tool: 'retrieve', args: r.document_name || r.doc_name || '', text: String(r.content || '').slice(0, 200), ok: true }));
      return result(mode, 'openai_app', msg.content || '', { trace });
    },
  };
}

module.exports = { createDifyEngine, createOpenAiAppEngine };
