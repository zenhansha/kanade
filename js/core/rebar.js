// 拍子を変えて小節を組み直す（Finale の「小節の再構成」・MuseScore の拍子の変更と同じ）
//
// 第 m 小節から、次に拍子が変わる小節の手前までの音を「楽譜の頭からのティック」の流れとして取り出し、
// 新しい拍子の小節線で切り直して書き込む。小節線をまたぐ音はタイでつなぐ。
// 強弱・文字・コードネーム（dirs）や線（spans）、音部記号の変更、テンポ・調の変更も、同じ時間の位置へ移す。
import { measureAttrs, measureRest, fillMeasures } from './score.js';
import { measureTicks } from './music.js';
import { readStream, writeStream, absToLoc } from './stream.js';

export function rebar(score, m, time) {
  const A0 = measureAttrs(score);
  const M0 = score.measures.length;
  // 組み直す範囲：m 〜（次に拍子が変わる小節の手前）
  let end = M0;
  for (let k = m + 1; k < M0; k++) if (score.measures[k].time) { end = k; break; }
  const start = A0[m].start;
  const segEnd = A0[end - 1].start + A0[end - 1].len;
  const segLen = segEnd - start;
  const pickup = m === 0 ? score.measures[0].pickup || 0 : 0;
  const newLen = measureTicks(time);
  // 弱起はそのまま残す（第1小節の長さは変えない）
  const firstLen = pickup ? Math.min(pickup, newLen) : newLen;
  const count = Math.max(1, firstLen >= segLen ? 1 : 1 + Math.ceil((segLen - firstLen) / newLen));
  const absToNew = (abs) => {
    const d = abs - start;
    if (d < firstLen) return { k: 0, t: d };
    const q = d - firstLen;
    return { k: 1 + Math.floor(q / newLen), t: q % newLen };
  };

  // 1. 取り出す
  const streams = [], staffMarks = [];
  score.parts.forEach((part, p) => part.staves.forEach((st, s) => {
    if (st.tabOf != null) return;
    const maxV = Math.max(1, ...st.measures.slice(m, end).map(sm => sm?.voices.length || 1));
    for (let v = 0; v < maxV; v++) streams.push({ p, s, v, items: readStream(score, p, s, v, m, end - 1, A0) });
    const dirs = [], spans = [], clefs = [];
    for (let k = m; k < end; k++) {
      const sm = st.measures[k];
      if (!sm) continue;
      for (const d of sm.dirs || []) dirs.push({ abs: A0[k].start + d.t, d });
      for (const sp of sm.spans || []) {
        const e = k + (sp.dm || 0);
        spans.push({ abs: A0[k].start + sp.t, absEnd: e < M0 ? A0[e].start + sp.t2 : null, eAfter: e >= end ? e - end : null, sp });
      }
      if (sm.clef && k > m) clefs.push({ abs: A0[k].start, clef: sm.clef });
    }
    staffMarks.push({ p, s, st, dirs, spans, clefs, firstClef: st.measures[m]?.clef });
  }));
  // 範囲より前の小節から始まって、範囲の中で終わる線の終わりも直す
  const before = [];
  score.parts.forEach((part, p) => part.staves.forEach((st, s) => st.measures.forEach((sm, k) => {
    if (k >= m) return;
    for (const sp of sm?.spans || []) { const e = k + (sp.dm || 0); if (e >= m && e < end) before.push({ k, sp, absEnd: A0[e].start + sp.t2 }); else if (e >= end) sp.dm += count - (end - m); }
  })));
  // 小節ごとの情報（テンポ・調・反復など）も時間の位置で移す
  const old = score.measures.slice(m, end);
  const lastOld = old[old.length - 1];
  const moved = [];
  old.forEach((ms, i) => {
    if (i === 0) return;
    for (const key of ['key', 'tempo', 'reh', 'segno', 'coda', 'repeatStart']) if (ms[key]) moved.push({ abs: A0[m + i].start, key, val: ms[key] });
    if (ms.stext) moved.push({ abs: A0[m + i].start, key: 'stext', val: ms.stext });
  });

  // 2. 小節を作り直す
  const first = { ...old[0], time: { beats: time.beats, beatType: time.beatType, ...(time.symbol ? { symbol: time.symbol } : {}) } };
  for (const k of ['barline', 'repeatEnd', 'fine', 'toCoda', 'jump', 'sysBreak', 'pageBreak', 'keep']) delete first[k];
  const fresh = [first];
  for (let i = 1; i < count; i++) fresh.push({});
  for (const x of moved) { const n = absToNew(x.abs); if (n.k < count) fresh[n.k][x.key] = x.val; }
  // 小節の終わりに付くもの（小節線・反復の終わり・Fine …）は、同じ時間の位置で終わる新しい小節へ
  old.forEach((ms, i) => {
    const endAbs = A0[m + i].start + A0[m + i].len;
    const k = Math.min(count - 1, absToNew(endAbs - 1).k);
    for (const key of ['barline', 'repeatEnd', 'fine', 'toCoda', 'jump', 'sysBreak', 'pageBreak']) if (ms[key]) fresh[k][key] = ms[key];
  });
  void lastOld;
  if (m === 0 && pickup) fresh[0].pickup = firstLen;
  score.measures.splice(m, end - m, ...fresh);
  for (const sm of staffMarks) {
    const blank = [];
    for (let i = 0; i < count; i++) blank.push({ voices: [[measureRest(i === 0 ? firstLen : newLen)]] });
    if (sm.firstClef) blank[0].clef = sm.firstClef;
    for (const c of sm.clefs) { const n = absToNew(c.abs); if (n.k < count) blank[n.k].clef = c.clef; }
    sm.st.measures.splice(m, end - m, ...blank);
  }
  // TAB の譜表は五線の小節数に合わせるだけ
  for (const part of score.parts) for (const st of part.staves) if (st.tabOf != null) st.measures.splice(m, end - m, ...fresh.map(() => ({ voices: [[measureRest(newLen)]] })));
  fillMeasures(score);

  // 3. 音を書き込む
  const A1 = measureAttrs(score);
  const s0 = A1[m].start, s1 = A1[m + count - 1].start + A1[m + count - 1].len;
  for (const x of streams) {
    const items = x.items.map(it => ({ ...it, start: it.start - start + s0, end: Math.min(it.end - start + s0, s1) }));
    writeStream(score, x.p, x.s, x.v, items, { from: s0, to: s1 });
  }
  // 4. 記号を同じ時間の位置へ
  const locOf = (abs) => { const n = absToNew(abs); return { m: m + Math.min(n.k, count - 1), t: n.k < count ? n.t : 0 }; };
  for (const sm of staffMarks) {
    for (const { abs, d } of sm.dirs) {
      const L = locOf(abs);
      const tgt = sm.st.measures[L.m];
      (tgt.dirs || (tgt.dirs = [])).push({ ...d, t: L.t });
    }
    for (const x of sm.spans) {
      const a = locOf(x.abs);
      const b = x.absEnd != null && x.eAfter == null ? locOf(x.absEnd) : null;
      const sp = { ...x.sp, t: a.t };
      if (b) { sp.dm = b.m - a.m; sp.t2 = b.t; } else if (x.eAfter != null) sp.dm = (m + count + x.eAfter) - a.m;
      const tgt = sm.st.measures[a.m];
      (tgt.spans || (tgt.spans = [])).push(sp);
    }
  }
  for (const x of before) { const b = locOf(x.absEnd); x.sp.dm = b.m - x.k; x.sp.t2 = b.t; }
  void A1; void absToLoc;
  return { m1: m, m2: m + count - 1, count };
}
