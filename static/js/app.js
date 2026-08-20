// 客户运营平台前端：两 Tab（QA / NL2SQL）
'use strict';

function $(sel) { return document.querySelector(sel); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------- Tab 切换 ----------------
document.querySelectorAll('.tab').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('#panel-' + btn.dataset.tab).classList.add('active');
  });
});

// ---------------- 状态栏 ----------------
async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    const llm = s.llm_enabled ? ('LLM：' + (s.llm_model || '已启用')) : 'LLM：未启用';
    const doris = s.doris_configured ? 'Doris：已配置' : 'Doris：未配置';
    $('#statusBar').textContent =
      `知识片段 ${s.knowledge_count} · Q&A ${s.qa_count} · ${llm} · ${doris}`;
  } catch (e) {
    $('#statusBar').textContent = '状态获取失败';
  }
}

// ---------------- QA ----------------
async function askQA() {
  const q = $('#qaInput').value.trim();
  if (!q) return;
  const box = $('#qaAnswer');
  box.innerHTML = '<div class="loading">思考中…</div>';
  $('#qaBtn').disabled = true;
  try {
    const r = await fetch('/api/qa/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q })
    });
    const d = await r.json();
    let badge = '';
    if (d.mode === 'direct') badge = '<span class="badge direct">库内标准答案</span>';
    else if (d.mode === 'llm') badge = '<span class="badge">LLM 生成</span>';
    else if (d.mode && d.mode.indexOf('error') >= 0) badge = '<span class="badge err">LLM 异常</span>';
    else badge = '<span class="badge">离线</span>';
    box.innerHTML = '<h4>回答' + badge + '</h4><div class="text">' +
      esc(d.answer) + '</div>';
  } catch (e) {
    box.innerHTML = '<div class="err-box">请求失败：' + esc(e.message) + '</div>';
  } finally {
    $('#qaBtn').disabled = false;
  }
}
$('#qaBtn').addEventListener('click', askQA);
$('#qaInput').addEventListener('keydown', e => { if (e.key === 'Enter') askQA(); });

// 上传文档
$('#kbFile').addEventListener('change', async function () {
  const f = this.files[0];
  if (!f) return;
  $('#kbMsg').textContent = '上传解析中…';
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await fetch('/api/knowledge/upload', { method: 'POST', body: fd });
    const d = await r.json();
    $('#kbMsg').textContent = d.ok
      ? `已导入「${d.filename}」，${d.chunks} 个片段`
      : ('失败：' + (d.error || '未知'));
  } catch (e) {
    $('#kbMsg').textContent = '上传失败：' + e.message;
  }
  this.value = '';
  loadStatus();
});

// 重新同步
$('#kbSync').addEventListener('click', async function () {
  $('#kbMsg').textContent = '同步中…';
  const r = await fetch('/api/knowledge/sync', { method: 'POST' });
  const d = await r.json();
  $('#kbMsg').textContent = `同步完成：qa ${d.qa_chunks} · 文件夹 ${d.folder_chunks}`;
  loadStatus();
});

// ---------------- NL2SQL ----------------
async function askSQL() {
  const q = $('#sqlInput').value.trim();
  if (!q) return;
  const box = $('#sqlAnswer');
  box.innerHTML = '<div class="loading">生成 SQL 并查询中…</div>';
  $('#sqlBtn').disabled = true;
  try {
    const r = await fetch('/api/nl2sql/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q })
    });
    const d = await r.json();
    let html = '';
    if (d.report) html += '<h4>分析报告</h4><div class="text">' + esc(d.report) + '</div>';
    if (d.sql) html += '<h4>执行的 SQL</h4><pre class="sql">' + esc(d.sql) + '</pre>';
    if (d.error) {
      html += '<div class="err-box">【' + esc(d.stage || '错误') + '】' + esc(d.error) + '</div>';
    }
    if (d.ok && d.columns && d.columns.length) {
      html += '<h4>数据（' + d.row_count + ' 行）</h4>' + renderTable(d.columns, d.rows);
    } else if (d.ok) {
      html += '<div class="text">查询成功，但无数据返回。</div>';
    }
    box.innerHTML = html || '<div class="text">无结果</div>';
  } catch (e) {
    box.innerHTML = '<div class="err-box">请求失败：' + esc(e.message) + '</div>';
  } finally {
    $('#sqlBtn').disabled = false;
  }
}
function renderTable(cols, rows) {
  let h = '<div class="result-table"><table><thead><tr>';
  cols.forEach(c => h += '<th>' + esc(c) + '</th>');
  h += '</tr></thead><tbody>';
  rows.forEach(row => {
    h += '<tr>';
    row.forEach(v => h += '<td>' + esc(v) + '</td>');
    h += '</tr>';
  });
  h += '</tbody></table></div>';
  return h;
}
$('#sqlBtn').addEventListener('click', askSQL);
$('#sqlInput').addEventListener('keydown', e => { if (e.key === 'Enter') askSQL(); });

// schema 展示
async function loadSchema() {
  try {
    const r = await fetch('/api/nl2sql/schema');
    const s = await r.json();
    if (s.error) { $('#schemaBox').innerHTML = '<span class="err-box">' + esc(s.error) + '</span>'; return; }
    if (!s.tables || !s.tables.length) { $('#schemaBox').textContent = '暂无登记表，请在 schema_config.yaml 中配置。'; return; }
    let h = '';
    s.tables.forEach(t => {
      h += '<div class="tbl"><span class="tname">' + esc(t.name) + '</span> — ' + esc(t.desc || '') + '<br>';
      const cols = t.columns || {};
      h += Object.keys(cols).map(c => esc(c) + '(' + esc(cols[c]) + ')').join('、');
      h += '</div>';
    });
    $('#schemaBox').innerHTML = h;
  } catch (e) {
    $('#schemaBox').textContent = 'schema 加载失败';
  }
}

// 初始化
loadStatus();
loadSchema();
