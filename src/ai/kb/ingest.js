'use strict';
/**
 * 文件解析与切片：md / txt / csv / tsv / json / html / 代码文件，零依赖；
 * xlsx 需要可选依赖 `xlsx`（npm i xlsx），未安装时提示改传 csv。
 */
const path = require('node:path');

const CODE_EXT = new Set(['.sql', '.py', '.js', '.ts', '.java', '.go', '.sh']);
const MAX_CHUNK = 900;

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** 按标题和段落切片，单片不超过 MAX_CHUNK 字。 */
function chunkText(text, baseTitle) {
  const sections = [];
  let cur = { title: baseTitle, lines: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const h = /^(#{1,4})\s+(.+)/.exec(line);
    if (h) {
      if (cur.lines.join('').trim()) sections.push(cur);
      cur = { title: `${baseTitle} · ${h[2].trim()}`, lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.join('').trim()) sections.push(cur);
  const out = [];
  for (const s of sections) {
    const paras = s.lines.join('\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    let buf = '';
    for (const p of paras) {
      if (buf && (buf.length + p.length) > MAX_CHUNK) { out.push({ title: s.title, content: buf }); buf = ''; }
      if (p.length > MAX_CHUNK) {
        for (let i = 0; i < p.length; i += MAX_CHUNK) out.push({ title: s.title, content: p.slice(i, i + MAX_CHUNK) });
      } else {
        buf = buf ? `${buf}\n\n${p}` : p;
      }
    }
    if (buf) out.push({ title: s.title, content: buf });
  }
  return out;
}

function parseCsv(text, sep) {
  const rows = []; let row = []; let f = ''; let q = false;
  const s = String(text).replace(/^﻿/, '');
  sep = sep || (s.split('\n')[0].includes('\t') ? '\t' : ',');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(f); f = ''; if (row.some(x => x !== '')) rows.push(row); row = [];
    } else f += ch;
  }
  row.push(f); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

function readXlsx(buffer) {
  let XLSX;
  try { XLSX = require('xlsx'); } catch (e) {
    const err = new Error('解析 Excel 需要安装可选依赖：npm i xlsx（或把表格另存为 CSV 上传）');
    err.status = 400;
    throw err;
  }
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return wb.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) }));
}

/** 表格 → 行对象（首行为表头） */
function rowsToObjects(rows) {
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h).trim());
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : String(r[i]).trim()])));
}

/** 解析上传文件为知识片段 [{title, content, kind}] */
function parseFile(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext);
  if (CODE_EXT.has(ext)) {
    return { kind: 'code', chunks: chunkText(buffer.toString('utf8'), base).map(c => ({ ...c, kind: 'code' })) };
  }
  let tables = null;
  if (ext === '.csv' || ext === '.tsv') tables = [{ name: base, rows: parseCsv(buffer.toString('utf8'), ext === '.tsv' ? '\t' : undefined) }];
  if (ext === '.xlsx' || ext === '.xls') tables = readXlsx(buffer);
  if (tables) {
    // 表格：每行一个片段，「列名：值」拼接，便于大模型理解
    const chunks = [];
    for (const t of tables) {
      for (const o of rowsToObjects(t.rows)) {
        const content = Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}：${v}`).join('\n');
        if (content) chunks.push({ title: `${base}${tables.length > 1 ? ' · ' + t.name : ''}`, content });
      }
    }
    return { kind: 'document', chunks };
  }
  if (ext === '.json') {
    const data = JSON.parse(buffer.toString('utf8'));
    const arr = Array.isArray(data) ? data : [data];
    return {
      kind: 'document',
      chunks: arr.map((o, i) => ({
        title: o.title || o.question || `${base} #${i + 1}`,
        content: o.content || o.answer || JSON.stringify(o, null, 2),
      })),
    };
  }
  const text = ext === '.html' || ext === '.htm' ? stripHtml(buffer.toString('utf8')) : buffer.toString('utf8');
  return { kind: 'document', chunks: chunkText(text, base) };
}

/** Q&A 批量导入：识别 分类/问题/回答/关键词/维护人 列（中英文表头均可） */
function parseQaFile(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  const tables = ext === '.xlsx' || ext === '.xls' ? readXlsx(buffer) : [{ rows: parseCsv(buffer.toString('utf8')) }];
  const pick = (o, keys) => { for (const k of keys) if (o[k]) return o[k]; return ''; };
  const out = [];
  for (const t of tables) {
    for (const o of rowsToObjects(t.rows)) {
      const r = {
        category: pick(o, ['分类', '类别', 'category']) || '未分类',
        question: pick(o, ['问题', 'question', 'Q']),
        answer: pick(o, ['回答', '答案', 'answer', 'A']),
        keywords: pick(o, ['关键词', '搜索关键词', 'keywords']),
        maintainer: pick(o, ['维护人', 'maintainer']),
      };
      if (r.question && r.answer) out.push(r);
    }
  }
  return out;
}

module.exports = { parseFile, parseQaFile, parseCsv, chunkText, stripHtml };
