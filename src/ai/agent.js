'use strict';
/**
 * 内置引擎：问答（mode=qa）与数智分析 / Text2SQL（mode=analysis）共用一个工具调用 Agent。
 *
 * 不做 RAG：Q&A、知识片段、表结构（语义层）数据量小，全量放进系统提示词，模型一次看全。
 * 工具：query_sql（只读查数，带校验与自我修正）、describe_table、ask_user（反问澄清）。
 * 三档降级：
 *   1. 模型支持 function calling → 多步 Agent
 *   2. 不支持（toolCalling=false）→ 固定流程：生成 SQL → 执行（出错带报错重试 2 次）→ 总结
 *   3. 未配置大模型 → 离线兜底：问答按关键词匹配知识条目；分析匹配语义层里的示例问题并执行其 SQL
 */
const crypto = require('node:crypto');
const { Bm25Index } = require('./kb/search');
const { markdownToHtml, tableHtml, tableMarkdown, esc } = require('./render');

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'query_sql',
      description: '在业务库上执行一条只读 SQL（SELECT/WITH），返回列名和数据（最多前 50 行给你看）。出错会返回报错信息，请据此修正后重试。',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: '单条只读 SQL，只能使用系统提示中列出的表和字段' },
          purpose: { type: 'string', description: '这条 SQL 要回答什么（一句话）' },
        },
        required: ['sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_table',
      description: '查看某张表的全部字段、类型和含义',
      parameters: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '问题存在关键歧义、无法合理假设时，向用户反问澄清。能合理假设时不要反问，直接在回答里说明假设。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: '2~5 个候选答案' },
        },
        required: ['question'],
      },
    },
  },
];

function today() { return new Date().toISOString().slice(0, 10); }
function clip(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }

function createAgent({ cfg, llm, store, catalog, kbSearch }) {
  const sessions = new Map();   // ask_user 反问时暂存的会话（sid → state）

  // ---------- 上下文 ----------
  function qaKnowledgeText(budget) {
    const parts = [];
    for (const r of store.qa.list().reverse()) parts.push(`[Q${r.id}]（${r.category}）问：${r.question}\n答：${r.answer}`);
    for (const k of store.kb.all('qa')) parts.push(`[K${k.id}] ${k.title}${k.category ? '（' + k.category + '）' : ''}\n${k.content}`);
    return fitBudget(parts, budget);
  }

  function analysisKnowledgeText(budget) {
    const parts = store.kb.all('analysis').map(k => `[K${k.id}] ${k.title}\n${k.content}`);
    return fitBudget(parts, budget);
  }

  function fitBudget(parts, budget) {
    let total = 0; const out = [];
    for (const p of parts) {
      if (total + p.length > budget) { out.push(`…（还有 ${parts.length - out.length} 条因长度限制未放入）`); break; }
      out.push(p); total += p.length + 2;
    }
    return out.join('\n\n');
  }

  async function systemPrompt(mode) {
    const budget = cfg.contextBudgetChars || 60000;
    let schema = '';
    try { schema = await catalog.schemaPrompt(Math.floor(budget * 0.5)); } catch (e) { schema = `（业务库不可用：${e.message}）`; }
    if (mode === 'qa') {
      return [
        `你是客户运营管理平台的知识库问答助手。今天是 ${today()}。`,
        '下面是全部 Q&A 记录和知识片段（全量提供，不需要检索）。回答规则：',
        '1. 优先依据知识回答，在句末用 [Q编号] 或 [K编号] 标注出处；知识里没有的内容不要编造，直接说明「知识库中暂无相关内容」。',
        '2. 如果问题需要实时数据（数量、比例、明细），可以调用 query_sql 查业务库。',
        '3. 用简洁的中文 Markdown 回答。',
        '', '# 知识库', qaKnowledgeText(Math.floor(budget * 0.5)) || '（知识库为空）',
        '', '# 业务库（需要查数时使用）', schema,
      ].join('\n');
    }
    return [
      `你是客户运营管理平台的数智分析助手，负责把业务问题转成 SQL 查数并给出结论。今天是 ${today()}。`,
      '工作方式：',
      '1. 只使用下面列出的表和字段；严格遵守「业务口径」。不确定字段含义时先用 describe_table。',
      '2. 用 query_sql 执行只读 SQL；报错时根据报错修正后重试；结果为空时检查条件取值是否和枚举值一致。',
      '3. 复杂问题可分多步查询。问题有关键歧义且无法合理假设时才用 ask_user 反问。',
      '4. 最终回答用中文 Markdown：先一句话结论，再给关键数据表格（Markdown 表格，最多 20 行），最后用「口径说明」列出所用口径和假设。不要编造未查到的数字。',
      '', '# 业务库', schema,
      '', '# 自定义知识（口径、字段说明、查询经验）', analysisKnowledgeText(Math.floor(budget * 0.2)) || '（暂无）',
    ].join('\n');
  }

  // ---------- 工具执行 ----------
  async function execTool(name, args, st) {
    if (name === 'query_sql') {
      const r = await catalog.run(args.sql || '');
      st.sqls.push(r.sql || args.sql);
      if (r.ok) {
        st.lastResult = r;
        const preview = { columns: r.columns, rows: r.rows.slice(0, 50), row_count: r.row_count };
        return { ok: true, text: JSON.stringify(preview), brief: `返回 ${r.row_count} 行` };
      }
      return { ok: false, text: JSON.stringify({ error: r.error }), brief: r.error };
    }
    if (name === 'describe_table') {
      const c = await catalog.columns(args.table || '');
      if (!c) return { ok: false, text: JSON.stringify({ error: `表 ${args.table} 不存在或不可查` }), brief: '表不存在' };
      return { ok: true, text: JSON.stringify(c), brief: `${c.fields.length} 个字段` };
    }
    return { ok: false, text: JSON.stringify({ error: `未知工具 ${name}` }), brief: '未知工具' };
  }

  // ---------- 1. 多步 Agent ----------
  async function runToolLoop(st, report) {
    const maxSteps = cfg.agent.maxSteps || 8;
    while (st.steps < maxSteps) {
      st.steps++;
      report({ current: st.steps, total: maxSteps, thought: st.steps === 1 ? '理解问题，规划查询…' : '根据上一步结果继续分析…' });
      const msg = await llm.complete(st.messages, { tools: TOOL_DEFS });
      st.messages.push({ role: 'assistant', content: msg.content || null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
      const calls = msg.tool_calls || [];
      if (!calls.length) return finish(st, msg.content || '');
      if (msg.content) report({ thought: clip(msg.content, 200) });
      for (const call of calls) {
        const name = call.function && call.function.name;
        let args = {};
        try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch (e) { args = {}; }
        if (name === 'ask_user') {
          const sid = crypto.randomUUID();
          st.pendingCallId = call.id;
          sessions.set(sid, st);
          setTimeout(() => sessions.delete(sid), 30 * 60 * 1000).unref();
          st.trace.push({ tool: 'ask_user', args: args.question || '', text: '', ok: true });
          return { need_input: true, sid, question: args.question || '请补充信息', options: args.options || [] };
        }
        report({ thought: name === 'query_sql' ? `执行 SQL：${clip(args.purpose || args.sql, 120)}` : `查看表结构：${args.table}` });
        const r = await execTool(name, args, st);
        if (!st.toolsUsed.includes(name)) st.toolsUsed.push(name);
        st.trace.push({ tool: name, args: name === 'query_sql' ? (args.sql || '') : JSON.stringify(args), text: clip(r.brief, 300), ok: r.ok });
        st.messages.push({ role: 'tool', tool_call_id: call.id, content: clip(r.text, 12000) });
      }
    }
    // 步数用尽：要求直接总结
    st.messages.push({ role: 'user', content: '已达到最大步数，请基于已有结果直接给出最终回答。' });
    const msg = await llm.complete(st.messages);
    return finish(st, msg.content || '');
  }

  // ---------- 2. 不支持工具调用的模型：固定流程 ----------
  async function runPipeline(st, report) {
    if (st.mode === 'qa') {
      report({ current: 1, total: 1, thought: '依据知识库生成回答…' });
      const msg = await llm.complete(st.messages);
      return finish(st, msg.content || '');
    }
    const ask = [...st.messages, { role: 'user', content: '先只输出一条可执行的 SQL，放在 ```sql 代码块里，不要解释。' }];
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      st.steps++;
      report({ current: attempt, total: 4, thought: attempt === 1 ? '生成 SQL…' : `SQL 出错，正在修正（第 ${attempt - 1} 次）…` });
      const out = await llm.chat(lastErr ? [...ask, { role: 'user', content: `上一条 SQL 报错：${lastErr}\n请修正后重新输出。` }] : ask);
      const m = /```sql\s*([\s\S]*?)```/i.exec(out) || /```\s*([\s\S]*?)```/.exec(out);
      const sql = (m ? m[1] : out).trim();
      const r = await execTool('query_sql', { sql }, st);
      if (!st.toolsUsed.includes('query_sql')) st.toolsUsed.push('query_sql');
      st.trace.push({ tool: 'query_sql', args: sql, text: r.brief, ok: r.ok });
      if (r.ok) {
        report({ current: 4, total: 4, thought: '总结结论…' });
        const sum = await llm.chat([...st.messages, { role: 'user', content: `已执行 SQL：\n${sql}\n结果：${clip(r.text, 12000)}\n请按要求给出最终回答。` }]);
        return finish(st, sum);
      }
      lastErr = r.brief;
    }
    return finish(st, `抱歉，多次尝试后 SQL 仍然出错：${lastErr}`);
  }

  // ---------- 3. 未配置大模型：离线兜底 ----------
  function runOffline(st) {
    if (st.mode === 'qa') {
      const docs = [
        ...store.qa.list().map(r => ({ ref: `Q${r.id}`, title: r.question, text: `${r.question} ${r.question} ${r.keywords} ${r.answer}`, body: r.answer, cat: r.category })),
        ...store.kb.all('qa').map(k => ({ ref: `K${k.id}`, title: k.title, text: `${k.title} ${k.keywords} ${k.content}`, body: k.content, cat: k.category })),
      ];
      const hits = new Bm25Index(docs).search(st.query, 3);
      st.toolsUsed.push('search_kb');
      st.trace.push({ tool: 'search_kb', args: st.query, text: `命中 ${hits.length} 条`, ok: true });
      if (!hits.length) return finish(st, '未配置大模型，且知识库中没有找到相关内容。', { offline: true });
      const md = ['> 未配置大模型，以下为关键词匹配到的知识条目：', '',
        ...hits.map((h, i) => `**${i + 1}. ${h.doc.title}** [${h.doc.ref}]\n\n${h.doc.body}`)].join('\n');
      return finish(st, md, { offline: true });
    }
    return null;   // analysis 走异步分支
  }

  async function runOfflineAnalysis(st, report) {
    const sem = catalog.semantic();
    const ex = sem.examples || [];
    const hit = new Bm25Index(ex, e => e.question).search(st.query, 1)[0];
    const qTokens = new Set(require('./kb/search').tokenize(st.query));
    const overlap = hit ? require('./kb/search').tokenize(hit.doc.question).filter(t => qTokens.has(t)).length / Math.max(1, qTokens.size) : 0;
    if (!hit || overlap < 0.5) {
      const list = ex.map(e => `- ${e.question}`).join('\n');
      return finish(st, `未配置大模型，暂时只能回答语义层里登记过的示例问题：\n\n${list || '（暂无示例）'}\n\n配置 AI_LLM_BASE_URL / AI_LLM_MODEL 后即可自由提问。`, { offline: true });
    }
    report({ current: 1, total: 1, thought: `匹配到示例问题「${hit.doc.question}」，执行其 SQL…` });
    const r = await execTool('query_sql', { sql: hit.doc.sql }, st);
    st.toolsUsed.push('query_sql');
    st.trace.push({ tool: 'query_sql', args: hit.doc.sql, text: r.brief, ok: r.ok });
    if (!r.ok) return finish(st, `示例 SQL 执行失败：${r.brief}`, { offline: true });
    const lr = st.lastResult;
    return finish(st, `> 未配置大模型，已按示例问题「${hit.doc.question}」执行预置 SQL。\n\n${tableMarkdown(lr.columns, lr.rows, 20)}`, { offline: true });
  }

  // ---------- 结果 ----------
  function finish(st, answer, extra = {}) {
    const lr = st.lastResult;
    let html = markdownToHtml(answer);
    if (lr && lr.columns && !/<table>/.test(html)) {
      html += `\n<details><summary>查询结果（${lr.row_count} 行）</summary>${tableHtml(lr.columns, lr.rows)}</details>`;
    }
    if (st.sqls.length) {
      html += `\n<details><summary>执行的 SQL（${st.sqls.length} 条）</summary>${st.sqls.map(s => `<pre><code>${esc(s)}</code></pre>`).join('')}</details>`;
    }
    const traceId = store.traces.create({
      user_id: st.userId, mode: st.mode, query: st.query, answer, tools: st.toolsUsed, sql: st.sqls[st.sqls.length - 1] || '', steps: st.trace,
    });
    return {
      success: true, ok: true, mode: st.mode, engine: 'builtin', answer, report_html: html,
      tools_used: st.toolsUsed, trace: st.trace, steps: st.steps, trace_id: traceId,
      sql: st.sqls[st.sqls.length - 1] || '', columns: lr ? lr.columns : [], rows: lr ? lr.rows.slice(0, 500) : [], row_count: lr ? lr.row_count : 0,
      ...extra,
    };
  }

  async function newState({ query, mode, history, user }) {
    const messages = [{ role: 'system', content: await systemPrompt(mode) }];
    const turns = (history || []).slice(-(cfg.agent.historyTurns || 6));
    for (const h of turns) if (h && h.content && (h.role === 'user' || h.role === 'assistant')) messages.push({ role: h.role, content: clip(h.content, 2000) });
    messages.push({ role: 'user', content: query });
    return { query, mode, messages, steps: 0, trace: [], toolsUsed: [], sqls: [], lastResult: null, userId: user ? String(user.id ?? user.username ?? '') : '' };
  }

  async function run({ query, mode = 'analysis', history = [], user = null }, report = () => {}) {
    mode = mode === 'qa' ? 'qa' : 'analysis';
    if (!llm.enabled()) {
      const st = { query, mode, steps: 1, trace: [], toolsUsed: [], sqls: [], lastResult: null, userId: user ? String(user.id ?? '') : '' };
      return runOffline(st) || runOfflineAnalysis(st, report);
    }
    const st = await newState({ query, mode, history, user });
    return cfg.llm.toolCalling === false ? runPipeline(st, report) : runToolLoop(st, report);
  }

  /** 用户回答反问后继续 */
  async function resume({ sid, answer }, report = () => {}) {
    const st = sessions.get(sid);
    if (!st) return { success: false, ok: false, error: '会话已过期，请重新提问' };
    sessions.delete(sid);
    st.messages.push({ role: 'tool', tool_call_id: st.pendingCallId, content: JSON.stringify({ user_answer: answer }) });
    return runToolLoop(st, report);
  }

  /** 按提示词改写已有结论 */
  async function refine({ answer, prompt }) {
    const out = await llm.chat([
      { role: 'system', content: '你是报告编辑。按用户要求改写给定内容，保持数据准确，不要编造新数字，输出 Markdown。' },
      { role: 'user', content: `原内容：\n${answer}\n\n修改要求：${prompt}` },
    ]);
    return out;
  }

  return { run, resume, refine, systemPrompt };
}

module.exports = { createAgent, TOOL_DEFS };
