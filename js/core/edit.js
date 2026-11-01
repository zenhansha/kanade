// 編集操作（音符の入力・削除・音価変更・連符・タイ・小節操作など）
//
// 基本の考え方は「上書き」：位置 t から長さ d の音符を書くと、[t, t+d) にあった
// 音符/休符は消え、はみ出た部分は休符で埋め直される（MuseScore / Dorico と同じ方式）。
// 小節線をまたぐ長さなら、自動で分割してタイでつなぐ。
//
// 位置は loc = { p: パート, s: 譜表, m: 小節, v: 声部(0〜3), t: 小節内ティック } で表す。
import { dottedTicks, splitSpan, diatonic, transposeSemis, midiOf, measureTicks } from './music.js';
import { evTicks, measureRest, newId, measureAttrs, fillMeasures } from './score.js';
import { shiftSpansForInsert, shiftSpansForDelete } from './marks.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

export function staffMeasure(score, p, s, m) { return score.parts[p]?.staves[s]?.measures[m]; }

export function getVoice(score, p, s, m, v, create = false, A = null) {
  const sm = staffMeasure(score, p, s, m);
  if (!sm) return null;
  if (!sm.voices[v] && create) {
    const len = (A || measureAttrs(score))[m].len;
    sm.voices[v] = [measureRest(len)];
  }
  return sm.voices[v] || null;
}

// 声部のイベントに開始・終了ティックをつけて返す
export function positions(voice) {
  const out = [];
  let t = 0;
  (voice || []).forEach((ev, i) => { const d = evTicks(ev); out.push({ ev, i, start: t, end: t + d }); t += d; });
  return out;
}

export function eventAt(score, loc) {
  const voice = getVoice(score, loc.p, loc.s, loc.m, loc.v);
  return positions(voice).find(x => x.start === loc.t) || null;
}
export function eventCovering(score, loc) {
  const voice = getVoice(score, loc.p, loc.s, loc.m, loc.v);
  return positions(voice).find(x => x.start <= loc.t && loc.t < x.end) || null;
}
export function findEvent(score, id) {
  for (let p = 0; p < score.parts.length; p++) {
    const part = score.parts[p];
    for (let s = 0; s < part.staves.length; s++) {
      const ms = part.staves[s].measures;
      for (let m = 0; m < ms.length; m++) {
        const vs = ms[m].voices;
        for (let v = 0; v < vs.length; v++) {
          if (!vs[v]) continue;
          let t = 0;
          for (let i = 0; i < vs[v].length; i++) {
            const ev = vs[v][i];
            if (ev.id === id) return { ev, p, s, m, v, i, t };
            t += evTicks(ev);
          }
        }
      }
    }
  }
  return null;
}

function restEvents(a, b, attr) {
  if (a >= b) return [];
  if (a === 0 && b === attr.len) return [measureRest(attr.len)];
  const offset = attr.full - attr.len; // 弱起小節は「小節の後ろ側」として拍をそろえる
  return splitSpan(a, b, attr.time, offset).map(x => ({ id: newId(), rest: true, type: x.type, dots: x.dots, notes: [] }));
}

// 同じ中身（音符ならタイでつなぐ）で [a, b) を埋める
function likeEvents(src, a, b, attr) {
  if (src.rest) return restEvents(a, b, attr);
  const pieces = splitSpan(a, b, attr.time, attr.full - attr.len);
  return pieces.map((x, k) => ({
    id: newId(), rest: false, type: x.type, dots: x.dots,
    notes: src.notes.map(n => ({ ...n, tie: k < pieces.length - 1 ? true : false })),
  }));
}

// 声部の [t, t + 新イベントの合計長) を newEvs で置き換える（中心となる処理）
export function replaceSpan(score, A, p, s, m, v, t, newEvs) {
  const sm = staffMeasure(score, p, s, m);
  const voice = getVoice(score, p, s, m, v, true, A);
  const attr = A[m];
  const span = newEvs.reduce((a, e) => a + evTicks(e), 0);
  let a = t, b = Math.min(t + span, attr.len);
  const pos = positions(voice);
  // 連符の途中にかかったら、その連符全体を置き換え範囲に含める
  for (const x of pos) {
    if (x.ev.tuplet && x.end > a && x.start < b) {
      const grp = pos.filter(y => y.ev.tuplet && y.ev.tuplet.id === x.ev.tuplet.id);
      a = Math.min(a, grp[0].start); b = Math.max(b, grp[grp.length - 1].end);
    }
  }
  // その位置にあった音符の装飾音は、上書きした新しい音符へ引き継ぐ（装飾音 → 本音符の順に入力できるように）
  const graceFrom = pos.find(x => x.start === t && x.ev.grace);
  if (graceFrom && newEvs[0] && !newEvs[0].grace) newEvs[0].grace = graceFrom.ev.grace;
  const before = [], after = [];
  let tail = [];
  for (const x of pos) {
    if (x.end <= a) before.push(x.ev);
    else if (x.start >= b) after.push(x.ev);
    else {
      if (x.start < a) before.push(...likeEvents(x.ev, x.start, a, attr));
      if (x.end > b) tail = restEvents(b, x.end, attr);
    }
  }
  sm.voices[v] = [...before, ...restEvents(a, t, attr), ...newEvs, ...restEvents(t + span, b, attr), ...tail, ...after];
  normalizeVoice(score, A, p, s, m, v);
}

// 小節全体の休符を、拍にそろった普通の休符に分ける（装飾音など「その位置の音符」が必要なとき）
export function expandMeasureRest(score, p, s, m, v) {
  const voice = getVoice(score, p, s, m, v, true);
  if (!voice || voice.length !== 1 || !voice[0].mr) return false;
  const attr = measureAttrs(score)[m];
  staffMeasure(score, p, s, m).voices[v] = splitSpan(0, attr.len, attr.time, attr.full - attr.len).map(x => ({ id: newId(), rest: true, type: x.type, dots: x.dots, notes: [] }));
  return true;
}

// 休符だけになった声部を整理（声部1は全休符に、声部2〜4は消す）
export function normalizeVoice(score, A, p, s, m, v) {
  const sm = staffMeasure(score, p, s, m);
  const voice = sm.voices[v];
  if (!voice) return;
  if (voice.every(e => e.rest && !e.tuplet && !e.grace && !e.art)) {
    if (v === 0) sm.voices[0] = [measureRest(A[m].len)];
    else sm.voices[v] = null;
  }
  while (sm.voices.length > 1 && !sm.voices[sm.voices.length - 1]) sm.voices.pop();
}

export function appendMeasures(score, count = 1, at = score.measures.length) {
  const last = score.measures[score.measures.length - 1];
  const finalBar = last && last.barline === 'final';
  if (finalBar && at === score.measures.length) delete last.barline;
  shiftSpansForInsert(score, at, count);
  for (let i = 0; i < count; i++) {
    score.measures.splice(at, 0, {});
    for (const part of score.parts) for (const st of part.staves) st.measures.splice(at, 0, null);
  }
  if (finalBar && at + count === score.measures.length) score.measures[score.measures.length - 1].barline = 'final';
  fillMeasures(score);
}

export function deleteMeasures(score, from, to) {
  const n = score.measures.length;
  if (to - from + 1 >= n) return false; // 全部は消さない
  // 消える小節にある拍子・調・テンポの変更は、次の小節へ引き継ぐ
  const carry = {};
  for (let i = from; i <= to; i++) for (const k of ['time', 'key', 'tempo']) if (score.measures[i][k]) carry[k] = score.measures[i][k];
  const finalBar = score.measures[n - 1].barline === 'final';
  shiftSpansForDelete(score, from, to);
  score.measures.splice(from, to - from + 1);
  for (const part of score.parts) for (const st of part.staves) {
    let clef = null;
    for (let i = from; i <= to; i++) if (st.measures[i]?.clef) clef = st.measures[i].clef;
    st.measures.splice(from, to - from + 1);
    if (clef && st.measures[from] && !st.measures[from].clef) st.measures[from].clef = clef;
  }
  if (score.measures[from]) for (const k in carry) if (!score.measures[from][k]) score.measures[from][k] = carry[k];
  if (from === 0) for (const k of ['time', 'key', 'tempo']) if (!score.measures[0][k]) score.measures[0][k] = carry[k] || (k === 'time' ? { beats: 4, beatType: 4 } : k === 'key' ? { fifths: 0 } : { bpm: 100 });
  if (finalBar) score.measures[score.measures.length - 1].barline = 'final';
  refitAll(score);
  return true;
}

// 拍子が変わったときなどに、各小節の中身を新しい長さに合わせる（はみ出しは切り捨て、足りなければ休符）
export function refitAll(score) {
  const A = measureAttrs(score);
  for (let p = 0; p < score.parts.length; p++) for (let s = 0; s < score.parts[p].staves.length; s++) {
    const st = score.parts[p].staves[s];
    for (let m = 0; m < st.measures.length; m++) {
      const sm = st.measures[m];
      if (!sm) continue;
      for (let v = 0; v < sm.voices.length; v++) {
        const voice = sm.voices[v];
        if (!voice) continue;
        if (voice.length === 1 && voice[0].mr) { voice[0].mrTicks = A[m].len; continue; }
        const pos = positions(voice);
        const total = pos.length ? pos[pos.length - 1].end : 0;
        if (total === A[m].len) continue;
        const keep = [];
        let end = 0;
        for (const x of pos) {
          if (x.end <= A[m].len) { keep.push(x.ev); end = x.end; }
          else if (x.start < A[m].len && !x.ev.tuplet) { keep.push(...likeEvents(x.ev, x.start, A[m].len, A[m])); end = A[m].len; break; }
          else break;
        }
        sm.voices[v] = [...keep, ...restEvents(end, A[m].len, A[m])];
        normalizeVoice(score, A, p, s, m, v);
      }
    }
  }
  fillMeasures(score);
}

function sortNotes(notes) { notes.sort((a, b) => diatonic(a) - diatonic(b) || (a.alter || 0) - (b.alter || 0)); return notes; }

// ───────── 音符入力 ─────────
// spec = { type, dots, pitches: [{step,alter,octave}] | null（休符） }
// 戻り値: { next: 次のカーソル位置, ids: 書いたイベントの id（タイで分割されたら複数） }
export function enterNote(score, loc, spec) {
  let A = measureAttrs(score);
  let { p, s, m, v, t } = loc;
  getVoice(score, p, s, m, v, true, A);
  // カーソルが連符の中なら、その音符を差し替えるだけ（長さは連符のまま）
  const at = eventAt(score, { p, s, m, v, t });
  if (at && at.ev.tuplet) {
    at.ev.rest = !spec.pitches;
    at.ev.notes = spec.pitches ? sortNotes(spec.pitches.map(x => ({ step: x.step, alter: x.alter || 0, octave: x.octave }))) : [];
    let nt = at.end, nm = m;
    if (nt >= A[m].len) { nm++; nt = 0; }
    if (nm >= score.measures.length) { appendMeasures(score, 1); }
    return { next: { p, s, m: nm, v, t: nt }, ids: [at.ev.id] };
  }
  let remaining = dottedTicks(spec.type, spec.dots || 0);
  const ids = [];
  let first = true;
  let lastEvs = null;
  while (remaining > 0) {
    if (m >= score.measures.length) { appendMeasures(score, 1); A = measureAttrs(score); }
    getVoice(score, p, s, m, v, true, A);
    const attr = A[m];
    const avail = attr.len - t;
    const use = Math.min(remaining, avail);
    let pieces;
    if (first && use === remaining) pieces = [{ type: spec.type, dots: spec.dots || 0 }];
    else pieces = splitSpan(t, t + use, attr.time, attr.full - attr.len);
    remaining -= use;
    const evs = pieces.map((x, k) => ({
      id: newId(), rest: !spec.pitches, type: x.type, dots: x.dots,
      notes: spec.pitches ? sortNotes(spec.pitches.map(n => ({ step: n.step, alter: n.alter || 0, octave: n.octave, tie: remaining > 0 || k < pieces.length - 1 }))) : [],
    }));
    replaceSpan(score, A, p, s, m, v, t, evs);
    evs.forEach(e => ids.push(e.id));
    lastEvs = evs;
    t += use;
    first = false;
    if (t >= attr.len && remaining > 0) { m++; t = 0; }
  }
  if (t >= A[m].len) { m++; t = 0; }
  if (m >= score.measures.length) appendMeasures(score, 1);
  return { next: { p, s, m, v, t }, ids };
}

// 和音に音を足す（タイでつながった続きにも足す）
export function addToChord(score, id, pitch) {
  let f = findEvent(score, id);
  if (!f) return false;
  const add = (ev, tie) => {
    if (ev.rest) { ev.rest = false; ev.notes = []; }
    if (ev.notes.some(n => n.step === pitch.step && n.octave === pitch.octave && (n.alter || 0) === (pitch.alter || 0))) return;
    ev.notes.push({ step: pitch.step, alter: pitch.alter || 0, octave: pitch.octave, tie });
    sortNotes(ev.notes);
  };
  const chainTie = f.ev.notes.length > 0 && f.ev.notes.every(n => n.tie);
  add(f.ev, chainTie);
  // タイの続き
  let cur = f;
  while (chainTie && cur) {
    const nx = nextEvent(score, cur);
    if (!nx || nx.ev.rest) break;
    const tied = cur.ev.notes.every(n => n.tie);
    if (!tied) break;
    const contTie = nx.ev.notes.every(n => n.tie);
    add(nx.ev, contTie);
    cur = contTie ? nx : null;
  }
  return true;
}

// 同じ声部の次のイベント（小節をまたぐ）
export function nextEvent(score, f) {
  const voice = getVoice(score, f.p, f.s, f.m, f.v);
  if (voice && f.i + 1 < voice.length) return { ...f, ev: voice[f.i + 1], i: f.i + 1, t: f.t + evTicks(f.ev) };
  const nv = getVoice(score, f.p, f.s, f.m + 1, f.v);
  if (nv && nv.length) return { ...f, m: f.m + 1, ev: nv[0], i: 0, t: 0 };
  return null;
}
export function prevEvent(score, f) {
  const voice = getVoice(score, f.p, f.s, f.m, f.v);
  if (voice && f.i > 0) return { ...f, ev: voice[f.i - 1], i: f.i - 1, t: f.t - evTicks(voice[f.i - 1]) };
  if (f.m === 0) return null;
  const pv = getVoice(score, f.p, f.s, f.m - 1, f.v);
  if (!pv || !pv.length) return null;
  const pos = positions(pv);
  const last = pos[pos.length - 1];
  return { ...f, m: f.m - 1, ev: last.ev, i: last.i, t: last.start };
}

// 選んだ音符（和音なら noteIndex の音、null なら全部）の音高を変える
export function mapPitches(score, id, fn, noteIndex = null) {
  const f = findEvent(score, id);
  if (!f || f.ev.rest) return false;
  f.ev.notes = f.ev.notes.map((n, i) => (noteIndex === null || i === noteIndex ? { ...fn(n), tie: n.tie } : n));
  sortNotes(f.ev.notes);
  return true;
}
export function shiftSemis(score, id, semis, fifths, noteIndex = null) {
  return mapPitches(score, id, n => transposeSemis(n, semis, fifths), noteIndex);
}
export function shiftDiatonic(score, id, steps, noteIndex = null) {
  return mapPitches(score, id, n => {
    const dn = diatonic(n) + steps;
    return { step: ['C', 'D', 'E', 'F', 'G', 'A', 'B'][((dn % 7) + 7) % 7], alter: n.alter || 0, octave: Math.floor(dn / 7) };
  }, noteIndex);
}
export function setAlter(score, id, alter, noteIndex = null) {
  return mapPitches(score, id, n => ({ step: n.step, alter, octave: n.octave }), noteIndex);
}

// 音符→休符（長さはそのまま）
export function toRest(score, id) {
  const f = findEvent(score, id);
  if (!f) return null;
  // 前の音符からのタイは切る
  const pv = prevEvent(score, f);
  if (pv && !pv.ev.rest) pv.ev.notes.forEach(n => (n.tie = false));
  f.ev.rest = true; f.ev.notes = [];
  // 休符に残せるのはフェルマータだけ
  if (f.ev.art) { f.ev.art = f.ev.art.filter(k => k === 'ferm'); if (!f.ev.art.length) delete f.ev.art; }
  delete f.ev.lyr; delete f.ev.grace;
  normalizeVoice(score, measureAttrs(score), f.p, f.s, f.m, f.v);
  return f;
}

// 和音から1音だけ消す（最後の1音なら休符に）
export function removeNote(score, id, noteIndex) {
  const f = findEvent(score, id);
  if (!f || f.ev.rest) return false;
  if (f.ev.notes.length <= 1) { toRest(score, id); return true; }
  f.ev.notes.splice(noteIndex, 1);
  return true;
}

// 音価を変える（連符の中なら何もしない）
export function setDuration(score, id, type, dots) {
  const f = findEvent(score, id);
  if (!f || f.ev.tuplet) return null;
  const pitches = f.ev.rest ? null : f.ev.notes.map(n => ({ step: n.step, alter: n.alter, octave: n.octave }));
  const tieOut = !f.ev.rest && f.ev.notes.every(n => n.tie);
  const keep = { art: f.ev.art, lyr: f.ev.lyr, grace: f.ev.grace };
  const r = enterNote(score, { p: f.p, s: f.s, m: f.m, v: f.v, t: f.t }, { type, dots, pitches });
  if (tieOut && r.ids.length) {
    const last = findEvent(score, r.ids[r.ids.length - 1]);
    if (last && !last.ev.rest) last.ev.notes.forEach(n => (n.tie = true));
  }
  // アーティキュレーション・歌詞・装飾音は長さを変えても残す
  const first = r.ids.length && findEvent(score, r.ids[0]);
  if (first) for (const k in keep) if (keep[k]) first.ev[k] = keep[k];
  return r;
}

// タイの切り替え（次の音に同じ高さがあるときだけ線が描かれる）
export function toggleTie(score, id) {
  const f = findEvent(score, id);
  if (!f || f.ev.rest) return false;
  const on = !f.ev.notes.every(n => n.tie);
  f.ev.notes.forEach(n => (n.tie = on));
  return on;
}

// 連符を作る：カーソル位置に「type の音符 n 個を、normal 個分の長さで」入れる箱を作る
export function makeTuplet(score, loc, n, type) {
  const normal = { 2: 3, 3: 2, 4: 3, 5: 4, 6: 4, 7: 4, 9: 8 }[n] || 2;
  const A = measureAttrs(score);
  const span = dottedTicks(type, 0) * normal;
  if (loc.t + span > A[loc.m].len) return null;
  const tid = newId();
  const evs = [];
  for (let i = 0; i < n; i++) evs.push({ id: newId(), rest: true, type, dots: 0, notes: [], tuplet: { id: tid, actual: n, normal } });
  getVoice(score, loc.p, loc.s, loc.m, loc.v, true, A);
  replaceSpan(score, A, loc.p, loc.s, loc.m, loc.v, loc.t, evs);
  return evs[0].id;
}

// ───────── 小節の属性 ─────────
export function setTime(score, m, time) {
  score.measures[m].time = { beats: time.beats, beatType: time.beatType, ...(time.symbol ? { symbol: time.symbol } : {}) };
  if (m > 0) {
    const A = measureAttrs(score);
    const prev = A[m - 1].time;
    if (prev.beats === time.beats && prev.beatType === time.beatType && prev.symbol === time.symbol) delete score.measures[m].time;
  }
  if (m === 0 && score.measures[0].pickup) {
    score.measures[0].pickup = Math.min(score.measures[0].pickup, measureTicks(time));
  }
  refitAll(score);
}
export function setKey(score, m, fifths) {
  score.measures[m].key = { fifths };
  if (m > 0 && measureAttrs(score)[m - 1].fifths === fifths) delete score.measures[m].key;
}
export function setTempo(score, m, bpm) {
  if (m === 0 || bpm) score.measures[m].tempo = { bpm: Math.max(20, Math.min(400, Math.round(bpm))) };
}
export function setClef(score, p, s, m, clef) {
  const st = score.parts[p].staves[s];
  if (m === 0) { st.clef = clef; if (st.measures[0]) delete st.measures[0].clef; return; }
  st.measures[m].clef = clef;
}
export function setPickup(score, ticks) {
  if (ticks) score.measures[0].pickup = ticks; else delete score.measures[0].pickup;
  refitAll(score);
}

// ───────── 範囲（複数小節 × 譜表）の操作 ─────────
// range = { m1, m2, staves: [ [p,s], ... ] }
export function clearRange(score, range) {
  const A = measureAttrs(score);
  for (const [p, s] of range.staves) for (let m = range.m1; m <= range.m2; m++) {
    const sm = staffMeasure(score, p, s, m);
    if (sm) { sm.voices = [[measureRest(A[m].len)]]; delete sm.dirs; delete sm.spans; }
  }
}
export function copyRange(score, range) {
  const rows = range.staves.map(([p, s]) => {
    const ms = [];
    for (let m = range.m1; m <= range.m2; m++) ms.push(clone(staffMeasure(score, p, s, m)));
    return ms;
  });
  return { kind: 'kanade-clip', count: range.m2 - range.m1 + 1, rows };
}
export function pasteRange(score, clip, at) {
  // at = { m, staves: [[p,s], ...] }（コピーした段数ぶん、上から順に貼る）
  const A0 = measureAttrs(score);
  const need = at.m + clip.count - score.measures.length;
  if (need > 0) appendMeasures(score, need);
  const A = measureAttrs(score);
  const fresh = (sm) => { const c = clone(sm); delete c.clef; c.voices.forEach(v => v && v.forEach(e => { e.id = newId(); if (e.tuplet) e.tuplet = { ...e.tuplet }; })); remapTuplets(c); return c; };
  clip.rows.forEach((row, k) => {
    const target = at.staves[k];
    if (!target) return;
    const [p, s] = target;
    row.forEach((sm, j) => {
      const m = at.m + j;
      const st = score.parts[p].staves[s];
      const c = fresh(sm);
      const keepClef = st.measures[m]?.clef;
      if (keepClef) c.clef = keepClef;
      st.measures[m] = c;
    });
  });
  void A0; void A;
  refitAll(score);
}
function remapTuplets(sm) {
  const map = {};
  sm.voices.forEach(v => v && v.forEach(e => { if (e.tuplet) { map[e.tuplet.id] = map[e.tuplet.id] || newId(); e.tuplet.id = map[e.tuplet.id]; } }));
}
export function transposeRange(score, range, semis, fifths) {
  for (const [p, s] of range.staves) for (let m = range.m1; m <= range.m2; m++) {
    const sm = staffMeasure(score, p, s, m);
    if (!sm) continue;
    sm.voices.forEach(v => v && v.forEach(e => {
      if (e.rest) return;
      e.notes = sortNotes(e.notes.map(n => ({ ...transposeSemis(n, semis, fifths), tie: n.tie })));
    }));
  }
}
export function rangeEventIds(score, range) {
  const ids = [];
  for (const [p, s] of range.staves) for (let m = range.m1; m <= range.m2; m++) {
    const sm = staffMeasure(score, p, s, m);
    sm?.voices.forEach(v => v && v.forEach(e => ids.push(e.id)));
  }
  return ids;
}

// ───────── カーソル移動 ─────────
export function caretNext(score, loc) {
  const voice = getVoice(score, loc.p, loc.s, loc.m, loc.v);
  const A = measureAttrs(score);
  const x = positions(voice).find(y => y.start <= loc.t && loc.t < y.end);
  let t = x ? x.end : A[loc.m].len;
  let m = loc.m;
  if (t >= A[m].len) { if (m + 1 >= score.measures.length) return { ...loc, t: A[m].len }; m++; t = 0; }
  return { ...loc, m, t };
}
export function caretPrev(score, loc) {
  const voice = getVoice(score, loc.p, loc.s, loc.m, loc.v);
  const pos = positions(voice);
  const before = pos.filter(y => y.start < loc.t);
  if (before.length) return { ...loc, t: before[before.length - 1].start };
  if (loc.m === 0) return { ...loc, t: 0 };
  const pv = positions(getVoice(score, loc.p, loc.s, loc.m - 1, loc.v));
  return { ...loc, m: loc.m - 1, t: pv.length ? pv[pv.length - 1].start : 0 };
}

export { midiOf };
