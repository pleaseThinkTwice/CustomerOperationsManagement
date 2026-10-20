'use strict';
/**
 * 关键词匹配：中文二元切分 + BM25，零依赖。
 * 只用于「未配置大模型」时的离线兜底；配置了大模型时问答直接全量进上下文，不做检索。
 */

const STOP = new Set(['的', '了', '是', '在', '和', '与', '及', '或', '吗', '呢', '么', '什', '怎', '如何', '什么', '怎么', '哪些', '一个', '请问']);

function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const re = /[a-z0-9_.%]+|[一-鿿]+/g;
  let m;
  while ((m = re.exec(s))) {
    const w = m[0];
    if (/^[一-鿿]+$/.test(w)) {
      if (w.length === 1) { if (!STOP.has(w)) out.push(w); continue; }
      for (let i = 0; i < w.length - 1; i++) {
        const bg = w.slice(i, i + 2);
        if (!STOP.has(bg)) out.push(bg);
      }
    } else if (w.length > 1 || /\d/.test(w)) {
      out.push(w);
    }
  }
  return out;
}

class Bm25Index {
  constructor(docs, field = d => d.text, { k1 = 1.4, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.docs = docs;
    this.tf = []; this.len = []; this.df = new Map();
    let total = 0;
    docs.forEach((d, i) => {
      const toks = tokenize(field(d));
      const m = new Map();
      for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
      this.tf[i] = m; this.len[i] = toks.length; total += toks.length;
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    });
    this.avg = docs.length ? total / docs.length : 0;
  }

  search(query, topK = 5) {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const scores = [];
    for (let i = 0; i < N; i++) {
      let s = 0;
      const tf = this.tf[i];
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / (this.avg || 1)));
      }
      if (s > 0) scores.push({ i, score: s });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK).map(x => ({ doc: this.docs[x.i], score: x.score }));
  }
}

module.exports = { tokenize, Bm25Index };
