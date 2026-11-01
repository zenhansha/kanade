// Phase 2 の記号：アーティキュレーション・強弱/発想記号・スラーなどの線（Finale の Smart Shape）・
// 歌詞・コードネーム・装飾音符・反復記号、それと移調楽器の記譜表示・パート譜で使う計算
//
// ■ どこに持つか（全部 .kanade にそのまま保存される）
//   ev.art   … 音符に付く記号の名前の配列        例: ['stacc', 'acc']
//   ev.lyr   … 歌詞。番号（1番・2番…）ごと      例: [{ t: 'さ', h: true }]  h = 次の音節へハイフンでつなぐ
//   ev.grace … その音符の前に付く装飾音符        例: [{ type: 'eighth', slash: true, notes: [pitch] }]
//   sm.dirs  … 譜表の小節の中の位置 t に付く文字・記号
//              { t, k: 'dyn', v: 'mf' } / { t, k: 'text', text, pos: 'above'|'below', it: true } / { t, k: 'chord', text: 'Cm7' }
//   sm.spans … その小節の t から始まる線     { k: 'slur'|'cresc'|'dim'|'8va'|'8vb'|'15ma'|'ped'|'trill', v, t, dm, t2 }
//              終わりは「dm 小節あとの t2 から始まる音符」。相対で持つので、小節の挿入やコピーをしてもずれない
//   score.measures[m] … repeatStart / repeatEnd（回数）/ ending { nums, len } / segno / coda / fine / toCoda / jump
import { measureAttrs, INST, evTicks } from './score.js';
import { positions, findEvent, nextEvent, getVoice, staffMeasure, expandMeasureRest } from './edit.js';
import { transposeInterval, fifthsForSemis, spellMidi, midiOf, diatonic, fromDiatonic, keyAlter } from './music.js';

// ───────── 一覧（パレット・メニュー・浄書・再生・MusicXML で共通に使う） ─────────
// g = SMuFL のグリフ名（Above/Below があるものは付けずに書く）、side: 'note' = 符頭側、'above' = 常に譜表の上
export const ARTICS = {
  stacc: { ja: 'スタッカート', g: 'articStaccato', side: 'note', key: 'Shift+S' },
  staccss: { ja: 'スタッカーティッシモ', g: 'articStaccatissimo', side: 'note' },
  ten: { ja: 'テヌート', g: 'articTenuto', side: 'note', key: 'Shift+N' },
  acc: { ja: 'アクセント', g: 'articAccent', side: 'note', key: 'Shift+V' },
  marc: { ja: 'マルカート', g: 'articMarcato', side: 'above', key: 'Shift+O' },
  ferm: { ja: 'フェルマータ', g: 'fermata', side: 'above', key: 'Shift+U' },
  tr: { ja: 'トリル', g: 'ornamentTrill', side: 'above', single: true },
  mord: { ja: 'モルデント', g: 'ornamentMordent', side: 'above', single: true },
  prall: { ja: 'プラルトリラー', g: 'ornamentShortTrill', side: 'above', single: true },
  turn: { ja: 'ターン', g: 'ornamentTurn', side: 'above', single: true },
  down: { ja: 'ダウンボウ', g: 'stringsDownBow', side: 'above', single: true },
  up: { ja: 'アップボウ', g: 'stringsUpBow', side: 'above', single: true },
  breath: { ja: 'ブレス', g: 'breathMarkComma', side: 'after', single: true },
};

// 強弱記号：glyph と再生の強さ（0〜1）
export const DYNAMICS = {
  ppp: { g: 'dynamicPPP', vel: 0.22 }, pp: { g: 'dynamicPP', vel: 0.32 }, p: { g: 'dynamicPiano', vel: 0.44 },
  mp: { g: 'dynamicMP', vel: 0.55 }, mf: { g: 'dynamicMF', vel: 0.66 }, f: { g: 'dynamicForte', vel: 0.78 },
  ff: { g: 'dynamicFF', vel: 0.9 }, fff: { g: 'dynamicFFF', vel: 1 },
  fp: { g: 'dynamicFortePiano', vel: 0.44, accent: 0.78 }, sf: { g: 'dynamicSforzando', accent: 0.9 },
  sfz: { g: 'dynamicSforzato', accent: 0.95 }, sfp: { g: 'dynamicSforzandoPiano', vel: 0.44, accent: 0.9 },
  rfz: { g: 'dynamicRinforzando2', accent: 0.88 },
};
export const DYN_ORDER = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'fp', 'sf', 'sfz', 'sfp', 'rfz'];

// よく使う文字の表情記号（Finale の「発想記号」セレクタに相当）
export const TEXT_PRESETS = [
  { text: 'cresc.', pos: 'below', it: true }, { text: 'dim.', pos: 'below', it: true }, { text: 'poco a poco', pos: 'below', it: true },
  { text: 'dolce', pos: 'above', it: true }, { text: 'espress.', pos: 'above', it: true }, { text: 'cantabile', pos: 'above', it: true },
  { text: 'legato', pos: 'above', it: true }, { text: 'rit.', pos: 'above', it: true }, { text: 'rall.', pos: 'above', it: true },
  { text: 'accel.', pos: 'above', it: true }, { text: 'a tempo', pos: 'above', it: false }, { text: 'Tempo I', pos: 'above', it: false },
  { text: 'pizz.', pos: 'above', it: false }, { text: 'arco', pos: 'above', it: false }, { text: 'con sord.', pos: 'above', it: false },
  { text: 'senza sord.', pos: 'above', it: false }, { text: 'solo', pos: 'above', it: false }, { text: 'tutti', pos: 'above', it: false },
];

// 線の記号（Smart Shape）。shift = 再生で何半音ずらすか
export const SPANS = {
  slur: { ja: 'スラー', key: 'S' },
  cresc: { ja: 'クレッシェンド（松葉）', key: '<' },
  dim: { ja: 'デクレッシェンド（松葉）', key: '>' },
  '8va': { ja: '8va（1オクターブ上で演奏）', shift: 12, g: 'ottavaAlta' },
  '8vb': { ja: '8vb（1オクターブ下で演奏）', shift: -12, g: 'ottavaBassaVb' },
  '15ma': { ja: '15ma（2オクターブ上で演奏）', shift: 24, g: 'quindicesimaAlta' },
  ped: { ja: 'ペダル（Ped. 〜 *）' },
  trill: { ja: 'トリル（波線つき）' },
};

// 反復の「飛ぶ」指示
export const JUMPS = {
  dc: { text: 'D.C.', ja: 'D.C.（ダ・カーポ：最初へ）', to: 'start' },
  dcFine: { text: 'D.C. al Fine', ja: 'D.C. al Fine（最初へ戻って Fine で終わる）', to: 'start', until: 'fine' },
  dcCoda: { text: 'D.C. al Coda', ja: 'D.C. al Coda（最初へ戻って To Coda からコーダへ）', to: 'start', until: 'coda' },
  ds: { text: 'D.S.', ja: 'D.S.（ダル・セーニョ：𝄋 へ）', to: 'segno' },
  dsFine: { text: 'D.S. al Fine', ja: 'D.S. al Fine（𝄋 へ戻って Fine で終わる）', to: 'segno', until: 'fine' },
  dsCoda: { text: 'D.S. al Coda', ja: 'D.S. al Coda（𝄋 へ戻って To Coda からコーダへ）', to: 'segno', until: 'coda' },
};

// ───────── アーティキュレーション ─────────
// ids の音符すべてに付ける（全部に付いていたら外す）。休符にはフェルマータだけ付けられる
export function toggleArtic(score, ids, key) {
  const evs = ids.map(id => findEvent(score, id)?.ev).filter(ev => ev && (!ev.rest || key === 'ferm'));
  if (!evs.length) return null;
  const on = !evs.every(ev => ev.art && ev.art.includes(key));
  for (const ev of evs) {
    const a = (ev.art || []).filter(k => k !== key);
    if (on) {
      a.push(key);
      // 同時に付けない組み合わせ（スタッカートとスタッカーティッシモ、アクセントとマルカート）
      const excl = { stacc: 'staccss', staccss: 'stacc', acc: 'marc', marc: 'acc', up: 'down', down: 'up' }[key];
      if (excl) a.splice(0, a.length, ...a.filter(k => k !== excl));
    }
    if (a.length) ev.art = a; else delete ev.art;
  }
  return on;
}
export function clearArtics(score, ids) {
  for (const id of ids) { const f = findEvent(score, id); if (f) delete f.ev.art; }
}

// ───────── 文字・強弱・コードネーム（sm.dirs） ─────────
export function addDir(score, p, s, m, dir) {
  const sm = staffMeasure(score, p, s, m);
  if (!sm) return -1;
  const list = sm.dirs || (sm.dirs = []);
  // 同じ位置の強弱記号・コードネームは置き換える
  if (dir.k === 'dyn' || dir.k === 'chord') {
    const i = list.findIndex(d => d.k === dir.k && d.t === dir.t);
    if (i >= 0) list.splice(i, 1);
  }
  list.push(dir);
  list.sort((a, b) => a.t - b.t);
  return list.indexOf(dir);
}
export function removeDir(score, p, s, m, idx) {
  const sm = staffMeasure(score, p, s, m);
  if (!sm?.dirs?.[idx]) return false;
  sm.dirs.splice(idx, 1);
  if (!sm.dirs.length) delete sm.dirs;
  return true;
}

// ───────── 線（sm.spans） ─────────
export function addSpan(score, p, s, v, a, b, k) {
  if (b.m < a.m || (b.m === a.m && b.t < a.t)) [a, b] = [b, a];
  const sm = staffMeasure(score, p, s, a.m);
  if (!sm) return -1;
  const sp = { k, v, t: a.t, dm: b.m - a.m, t2: b.t };
  (sm.spans || (sm.spans = [])).push(sp);
  return sm.spans.length - 1;
}
export function removeSpan(score, p, s, m, idx) {
  const sm = staffMeasure(score, p, s, m);
  if (!sm?.spans?.[idx]) return false;
  sm.spans.splice(idx, 1);
  if (!sm.spans.length) delete sm.spans;
  return true;
}
export const spanEnd = (m, sp) => ({ m: m + sp.dm, t: sp.t2 });

// 線の端を前後の音符へ動かす（which = 'end' | 'start'、dir = +1 / -1）。範囲がなくなる動きはしない
export function nudgeSpan(score, p, s, m, idx, which, dir) {
  const sm = staffMeasure(score, p, s, m);
  const sp = sm?.spans?.[idx];
  if (!sp) return null;
  const onsets = voiceOnsets(score, p, s, sp.v);
  const key = (x) => x.m * 1e7 + x.t;
  const a = { m, t: sp.t }, b = spanEnd(m, sp);
  const cur = which === 'end' ? b : a;
  let i = onsets.findIndex(o => key(o) === key(cur));
  if (i < 0) i = onsets.findIndex(o => key(o) > key(cur)) - (dir > 0 ? 1 : 0);
  const j = i + dir;
  if (j < 0 || j >= onsets.length) return null;
  const nx = onsets[j];
  if (which === 'end') {
    if (key(nx) < key(a)) return null;
    sp.dm = nx.m - m; sp.t2 = nx.t;
    return { m, idx };
  }
  if (key(nx) > key(b)) return null;
  // 始まりが別の小節へ移るときは、その小節の spans に引っ越す
  sm.spans.splice(idx, 1);
  if (!sm.spans.length) delete sm.spans;
  const ns = staffMeasure(score, p, s, nx.m);
  const moved = { ...sp, t: nx.t, dm: b.m - nx.m, t2: b.t };
  (ns.spans || (ns.spans = [])).push(moved);
  return { m: nx.m, idx: ns.spans.length - 1 };
}

// その声部の音符（休符以外）の始まりを、楽譜の頭から順に
export function voiceOnsets(score, p, s, v) {
  const out = [];
  const st = score.parts[p]?.staves[s];
  if (!st) return out;
  st.measures.forEach((sm, m) => {
    const voice = sm.voices[v] || (v > 0 ? null : sm.voices[0]);
    for (const x of positions(voice)) if (!x.ev.rest) out.push({ m, t: x.start, id: x.ev.id });
  });
  return out;
}

// 小節の挿入・削除で、小節をまたぐ線の長さ（dm）を合わせる
export function shiftSpansForInsert(score, at, count) {
  for (const part of score.parts) for (const st of part.staves) st.measures.forEach((sm, m) => {
    if (m >= at || !sm?.spans) return;
    for (const sp of sm.spans) if (m + sp.dm >= at) sp.dm += count;
  });
}
export function shiftSpansForDelete(score, from, to) {
  const n = to - from + 1;
  for (const part of score.parts) for (const st of part.staves) st.measures.forEach((sm, m) => {
    if (m >= from || !sm?.spans) return;
    sm.spans = sm.spans.filter(sp => {
      const e = m + sp.dm;
      if (e > to) { sp.dm -= n; return true; }
      if (e >= from) { sp.dm = from - 1 - m; sp.t2 = lastOnsetIn(st.measures[from - 1], sp.v) ?? sp.t; return sp.dm >= 0; }
      return true;
    });
    if (!sm.spans.length) delete sm.spans;
  });
}
function lastOnsetIn(sm, v) {
  const pos = positions(sm?.voices[v] || sm?.voices[0]).filter(x => !x.ev.rest);
  return pos.length ? pos[pos.length - 1].start : null;
}

// ───────── 歌詞 ─────────
export function setLyric(score, id, verse, text, hyphen = false) {
  const f = findEvent(score, id);
  if (!f) return false;
  const ev = f.ev;
  const lyr = ev.lyr ? [...ev.lyr] : [];
  const t = String(text || '').trim();
  if (t) lyr[verse] = hyphen ? { t, h: true } : { t };
  else lyr[verse] = null;
  while (lyr.length && !lyr[lyr.length - 1]) lyr.pop();
  if (lyr.length) ev.lyr = lyr.map(x => x || null); else delete ev.lyr;
  return true;
}
// 歌詞を入れる次の音符（休符と、タイの続きの音は飛ばす）
export function nextLyricTarget(score, id, dir = 1) {
  let f = findEvent(score, id);
  let guard = 0;
  while (f && guard++ < 5000) {
    f = dir > 0 ? nextEvent(score, f) : prevEventSameVoice(score, f);
    if (!f) return null;
    if (f.ev.rest) continue;
    const pv = prevEventSameVoice(score, f);
    const tiedIn = pv && !pv.ev.rest && pv.ev.notes.length && pv.ev.notes.every(n => n.tie);
    if (tiedIn) continue;
    return f.ev.id;
  }
  return null;
}
function prevEventSameVoice(score, f) {
  const voice = getVoice(score, f.p, f.s, f.m, f.v);
  if (voice && f.i > 0) return { ...f, ev: voice[f.i - 1], i: f.i - 1, t: f.t - evTicks(voice[f.i - 1]) };
  if (f.m === 0) return null;
  const pv = getVoice(score, f.p, f.s, f.m - 1, f.v);
  if (!pv || !pv.length) return null;
  const pos = positions(pv);
  const last = pos[pos.length - 1];
  return { ...f, m: f.m - 1, ev: last.ev, i: last.i, t: last.start };
}

// ───────── コードネーム ─────────
// 文字（C, F#m7, Bbmaj7/D …）を 根音・付け足し・ベース に分ける
export function parseChord(text) {
  const m = /^\s*([A-Ga-g])([#♯b♭]{0,2})(.*?)(?:\/([A-Ga-g])([#♯b♭]{0,2}))?\s*$/.exec(text || '');
  if (!m) return null;
  const alt = (s) => [...(s || '')].reduce((a, c) => a + (c === '#' || c === '♯' ? 1 : -1), 0);
  return { root: m[1].toUpperCase(), alter: alt(m[2]), quality: m[3] || '', bass: m[4] ? m[4].toUpperCase() : null, bassAlter: alt(m[5]) };
}
// コードネームを移調（半音数・調号は綴りを決めるため）
export function transposeChord(text, semis, fifths = 0) {
  const c = parseChord(text);
  if (!c || !semis) return text;
  const sp = (step, alter) => { const q = spellMidi(midiOf({ step, alter, octave: 4 }) + semis, fifths); return q.step + (q.alter > 0 ? '#'.repeat(q.alter) : 'b'.repeat(-q.alter)); };
  return sp(c.root, c.alter) + c.quality + (c.bass ? '/' + sp(c.bass, c.bassAlter) : '');
}

// ───────── 装飾音符 ─────────
// loc の位置の音符（なければそこを覆う音符）の前に装飾音を足す。chord = 直前の装飾音に重ねる
export function addGrace(score, loc, pitch, opts = {}) {
  expandMeasureRest(score, loc.p, loc.s, loc.m, loc.v);
  const voice = getVoice(score, loc.p, loc.s, loc.m, loc.v, true);
  const x = positions(voice).find(y => y.start === loc.t) || positions(voice).find(y => y.start <= loc.t && loc.t < y.end);
  if (!x) return null;
  const ev = x.ev;
  const list = ev.grace || (ev.grace = []);
  const pt = { step: pitch.step, alter: pitch.alter || 0, octave: pitch.octave };
  if (opts.chord && list.length) {
    const g = list[list.length - 1];
    if (!g.notes.some(n => n.step === pt.step && n.octave === pt.octave && n.alter === pt.alter)) g.notes.push(pt);
    g.notes.sort((a, b) => diatonic(a) - diatonic(b));
  } else list.push({ type: opts.type || 'eighth', slash: opts.slash ?? true, notes: [pt] });
  return ev.id;
}
export function removeLastGrace(score, id) {
  const f = findEvent(score, id);
  if (!f?.ev.grace?.length) return false;
  f.ev.grace.pop();
  if (!f.ev.grace.length) delete f.ev.grace;
  return true;
}

// ───────── 反復の演奏順 ─────────
// 反復記号・カッコ・D.C./D.S./Coda/Fine をたどって、実際に演奏する小節の順番を返す
export function playOrder(score) {
  const ms = score.measures;
  const n = ms.length;
  const order = [];
  const segno = ms.findIndex(m => m.segno);
  const coda = ms.findIndex(m => m.coda);
  let i = 0, guard = 0;
  let repStart = 0, pass = 1;
  const count = {};      // 後ろ向き反復の小節 → 何回くり返したか
  let jumped = null;     // D.C. / D.S. のあと：{ until }。以降は反復しない
  // そのカッコの次にも続きのカッコがあるか（D.C. 後は最後のカッコだけ演奏する）
  const hasNextEnding = (k) => { const e = ms[k].ending; return !!(e && ms[k + (e.len || 1)]?.ending); };
  while (i < n && guard++ < 20000) {
    const m = ms[i];
    if (m.repeatStart && !jumped && repStart !== i) { repStart = i; pass = 1; }
    if (m.ending) {
      const len = Math.max(1, m.ending.len || 1);
      const take = jumped ? !hasNextEnding(i) : (m.ending.nums || [1]).includes(pass);
      if (!take) { i += len; continue; }
    }
    order.push(i);
    if (m.repeatEnd && !jumped) {
      const times = m.repeatEnd.times || 2;
      const c = count[i] || 1;
      if (c < times) { count[i] = c + 1; pass++; i = repStart; continue; }
      count[i] = 1;
      repStart = i + 1; pass = 1;
    }
    if (jumped && jumped.until === 'fine' && m.fine) break;
    if (jumped && jumped.until === 'coda' && m.toCoda && coda >= 0) { i = coda; continue; }
    if (m.jump && JUMPS[m.jump] && !jumped) {
      const J = JUMPS[m.jump];
      jumped = { until: J.until || null };
      i = J.to === 'segno' && segno >= 0 ? segno : 0;
      pass = 1;
      continue;
    }
    i++;
  }
  return order;
}

// ───────── 移調楽器の記譜表示 ─────────
// 楽譜データは実音で持っている（オクターブだけずれる楽器は記譜で持つ）。記譜音で見せるときの差
export function partTrans(part) {
  const inst = INST[part.inst];
  return inst && inst.trans && !inst.oct ? inst.trans : null;
}
// 記譜の調号 = 実音の調号 + 差。7個を超えたら異名同音の調に（嬰ト長調 → 変イ長調）
export function writtenFifths(fifths, trans) {
  if (!trans) return fifths;
  let w = fifths + fifthsForSemis(-trans.chromatic);
  if (w > 7) w -= 12;
  if (w < -7) w += 12;
  return w;
}
export function toWritten(p, trans, wFifths) {
  if (!trans) return p;
  const q = transposeInterval(p, -trans.diatonic, -trans.chromatic);
  // 調号を異名同音に回したときは綴りも合わせる
  if (wFifths != null && Math.abs(q.alter) >= 1 && keyAlter(wFifths, q.step) !== q.alter) {
    const r = spellMidi(midiOf(q), wFifths);
    if (Math.abs(r.alter) <= Math.abs(q.alter)) return r;
  }
  return q;
}
export function toConcert(p, trans) {
  if (!trans) return p;
  return transposeInterval(p, trans.diatonic, trans.chromatic);
}

// 記譜音で表示するための楽譜のコピー（音符の高さと装飾音・コードネームを記譜に直す）。調号は浄書側で直す
export function writtenScore(score) {
  const A = measureAttrs(score);
  const need = score.parts.some(p => partTrans(p));
  if (!need) return score;
  const out = { ...score, parts: score.parts.map(part => {
    const tr = partTrans(part);
    if (!tr) return part;
    const cp = JSON.parse(JSON.stringify(part));
    cp.staves.forEach(st => st.measures.forEach((sm, m) => {
      const wf = writtenFifths(A[m].fifths, tr);
      const conv = (n) => ({ ...toWritten(n, tr, wf), ...(n.tie ? { tie: true } : {}), ...(n.acc ? { acc: n.acc } : {}) });
      sm.voices.forEach(v => v && v.forEach(ev => {
        if (!ev.rest) ev.notes = ev.notes.map(conv).sort((a, b) => diatonic(a) - diatonic(b));
        if (ev.grace) ev.grace.forEach(g => (g.notes = g.notes.map(conv)));
      }));
      if (sm.dirs) sm.dirs.forEach(d => { if (d.k === 'chord') d.text = transposeChord(d.text, -tr.chromatic, wf); });
    }));
    cp._trans = tr;
    return cp;
  }) };
  return out;
}

// 小節に「何か」があるか（パート譜で休みの小節をまとめるときの判定）
export function measureHasMarks(score, m) {
  const ms = score.measures[m];
  return !!(ms.repeatStart || ms.repeatEnd || ms.ending || ms.segno || ms.coda || ms.fine || ms.toCoda || ms.jump || ms.sysBreak);
}

export { fromDiatonic };
