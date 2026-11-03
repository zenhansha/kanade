// 「音の流れ」と小節の行き来（Phase 3）
//
// MIDI ファイルの読み込み・リアルタイム録音（HyperScribe）・音価の一括変更・インプロードは、
// どれも「何ティック目から何ティック目まで、どの音が鳴るか」という流れ（ストリーム）を作ってから
// 小節に書き込む。書き込むときに小節線・拍の頭で分けてタイでつなぎ、3連符の拍は連符にする。
//
// ストリームの1要素 item = { start, end（楽譜の先頭からのティック）, pitches:[{step,alter,octave,…}], art?, lyr?, grace? }
import { TPQ, splitSpan, measureTicks, spellMidi, ticksToType, midiOf, diatonic } from './music.js';
import { measureAttrs, newId, measureRest, evTicks } from './score.js';
import { positions, appendMeasures, normalizeVoice, staffMeasure } from './edit.js';

// ───────── クオンタイズ（演奏のズレを譜面のマス目にそろえる） ─────────
// notes: [{ start, end, midi, vel }]（ティック）。grid: 2進のマス目（TPQ/4 = 16分）。triplets: 3連符も使う
// 1拍ごとに「2進でそろえる」と「3連でそろえる」のズレを比べ、少ない方を選ぶ（2進を少しひいきする）
export function quantize(notes, { grid = TPQ / 4, triplets = false } = {}) {
  const snap = (x, g) => Math.round(x / g) * g;
  const tg = TPQ / 3 / (grid < TPQ / 2 ? 2 : 1); // 16分のときは16分3連、8分のときは8分3連
  const beatOf = (x) => Math.floor((x + grid / 2) / TPQ);
  const useTrip = new Map();
  if (triplets) {
    const err = new Map(); // beat → [2進の誤差, 3連の誤差]
    for (const n of notes) for (const x of [n.start, n.end]) {
      const b = beatOf(x);
      const e = err.get(b) || [0, 0];
      e[0] += Math.abs(x - snap(x, grid)); e[1] += Math.abs(x - snap(x, tg));
      err.set(b, e);
    }
    for (const [b, e] of err) useTrip.set(b, e[1] < e[0] * 0.6);
  }
  const q = (x) => snap(x, useTrip.get(beatOf(x)) ? tg : grid);
  const out = [];
  for (const n of notes) {
    const s = Math.max(0, q(n.start));
    let e = q(n.end);
    if (e <= s) e = s + (useTrip.get(beatOf(s)) ? tg : grid);
    out.push({ ...n, start: s, end: e });
  }
  return out;
}

// ───────── 声部に分ける ─────────
// 同じタイミングで始まる音は和音。和音の長さは「次の音が始まるまで」。
// 次の音が始まっても長く伸ばしている音（ピアノの左手の全音符など）は、空いていれば声部2へ。
// notes: [{ start, end, pitch }] → [voice1Items, voice2Items]
export function splitVoices(notes, { minLong = TPQ } = {}) {
  const groups = new Map();
  for (const n of notes) { if (!groups.has(n.start)) groups.set(n.start, []); groups.get(n.start).push(n); }
  const onsets = [...groups.keys()].sort((a, b) => a - b);
  const v1 = [], v2 = [];
  let v2end = 0, v1end = 0;
  onsets.forEach((t, i) => {
    const g = groups.get(t);
    const next = i + 1 < onsets.length ? onsets[i + 1] : Infinity;
    const long = g.filter(n => n.end >= next + minLong);
    let main = g.filter(n => !long.includes(n));
    if (long.length && main.length && v2end <= t) {
      const e = Math.max(...long.map(n => n.end));
      v2.push({ start: t, end: e, pitches: long.map(n => n.pitch), src: long });
      v2end = e;
    } else main = g;
    if (!main.length) return;
    if (t < v1end && v1.length) { // 前の和音がまだ鳴っている（声部2が使えなかった）→ 前の和音を切る
      const last = v1[v1.length - 1];
      last.end = t;
    }
    const end = Math.min(Math.max(...main.map(n => n.end)), next);
    v1.push({ start: t, end, pitches: main.map(n => n.pitch), src: main });
    v1end = end;
  });
  // 声部2の音が声部1の次の音と重なるのは OK（別の声部なので）
  return [v1, v2];
}

// ───────── 小節に書き込む ─────────
// 楽譜の先頭からの絶対ティック → (小節, 小節内ティック)
export function absToLoc(A, abs) {
  for (let m = 0; m < A.length; m++) if (abs < A[m].start + A[m].len) return { m, t: abs - A[m].start };
  const last = A[A.length - 1];
  const over = abs - (last.start + last.len);
  return { m: A.length + Math.floor(over / last.full), t: over % last.full };
}

// items（重ならない並び）を (p, s, v) の [from, to) に書き込む。範囲内にあった中身は置き換わる。
// to を省略すると、最後の item が終わる小節の終わりまで。足りなければ小節を足す。
export function writeStream(score, p, s, v, items, { from = null, to = null } = {}) {
  items = items.filter(it => it.end > it.start).sort((a, b) => a.start - b.start);
  let A = measureAttrs(score);
  const lastEnd = items.length ? items[items.length - 1].end : 0;
  const f0 = from ?? (items.length ? items[0].start : 0);
  const mFrom = absToLoc(A, f0).m;
  let endLoc = absToLoc(A, Math.max(f0, (to ?? lastEnd) - 1));
  if (endLoc.m >= score.measures.length) { appendMeasures(score, endLoc.m - score.measures.length + 1); A = measureAttrs(score); endLoc = absToLoc(A, Math.max(f0, (to ?? lastEnd) - 1)); }
  const mTo = endLoc.m;
  for (let m = mFrom; m <= mTo; m++) {
    const a = A[m];
    const m0 = a.start, m1 = a.start + a.len;
    // この小節にかかる部分を切り出す（小節線をまたぐ音はタイ）
    const slots = [];
    for (const it of items) {
      if (it.end <= m0 || it.start >= m1) continue;
      const s0 = Math.max(it.start, m0) - m0, s1 = Math.min(it.end, m1) - m0;
      slots.push({ start: s0, end: s1, item: it, head: it.start >= m0, tieOut: it.end > m1 });
    }
    const sm = staffMeasure(score, p, s, m);
    if (!sm) continue;
    if (!sm.voices[v] && !slots.length) continue;
    // 範囲が小節の途中から/途中までのときは、範囲外の元の中身を残す
    const keepA = Math.max(0, (from ?? m0) - m0), keepB = Math.min(a.len, (to ?? m1) - m0);
    const old = sm.voices[v] ? positions(sm.voices[v]) : [];
    const kept = old.filter(x => (x.end <= keepA || x.start >= keepB) && !x.ev.mr && !x.ev.rest).map(x => ({ start: x.start, end: x.end, ev: x.ev }));
    const evs = buildEvents(slots, kept, a);
    sm.voices[v] = evs;
    normalizeVoice(score, A, p, s, m, v);
  }
  return { m1: mFrom, m2: mTo };
}

// 1小節ぶんのスロットをイベント列にする（空きは休符。3連の拍は連符でまとめる）
function buildEvents(slots, kept, a) {
  const len = a.len, time = a.time, offset = a.full - a.len;
  // 中身の並び：{start, end, kind: 'item'|'keep', ...}
  const all = [...slots.map(x => ({ ...x, kind: 'item' })), ...kept.map(x => ({ ...x, kind: 'keep' }))].sort((x, y) => x.start - y.start);
  const evs = [];
  const simple = time.beatType === 4 || time.beatType === 2;
  const beat = TPQ; // 3連の判定は4分音符の拍で
  const tripBeat = (b0) => simple && all.some(x => x.kind === 'item' && [x.start, x.end].some(q => q > b0 && q < b0 + beat && (q + offset) % (TPQ / 8) !== 0));
  let cur = 0;
  const pushRest = (a0, b0) => { if (b0 > a0) evs.push(...restPieces(a0, b0)); };
  const restPieces = (a0, b0) => {
    const out = [];
    let x = a0;
    while (x < b0) {
      const bb = Math.floor((x + offset) / beat) * beat - offset;
      if (tripBeat(bb) && bb >= 0) {
        const e = Math.min(b0, bb + beat);
        out.push(...tripletPieces(x, e, bb, null, false));
        x = e;
      } else {
        // 次の3連の拍の手前まで普通の休符
        let e = b0;
        for (let q = bb + beat; q < b0; q += beat) if (tripBeat(q)) { e = q; break; }
        out.push(...splitSpan(x, e, time, offset).map(z => ({ id: newId(), rest: true, type: z.type, dots: z.dots, notes: [] })));
        x = e;
      }
    }
    return out;
  };
  const tripIds = new Map();
  // 3連の拍の中の [x, e)：単位 = 拍/3（8分3連）か 拍/6（16分3連）
  function tripletPieces(x, e, bb, pitches, tieOut) {
    const u6 = TPQ / 6, u3 = TPQ / 3;
    const fine = all.some(z => z.kind === 'item' && [z.start, z.end].some(q => q > bb && q < bb + beat && (q - bb) % u3 !== 0));
    const unit = fine ? u6 : u3;
    const id = tripIds.get(bb) || (tripIds.set(bb, newId()), tripIds.get(bb));
    const out = [];
    let y = x;
    while (y < e) {
      let n = Math.round((e - y) / unit);
      // 1つの音符で表せる長さに（16分3連：1,2,3,4 / 8分3連：1,2）
      const allowed = fine ? [4, 3, 2, 1] : [2, 1];
      n = allowed.find(k => k <= n && y + k * unit <= e + 1) || 1;
      const base = fine ? { 1: ['16th', 0], 2: ['eighth', 0], 3: ['eighth', 1], 4: ['quarter', 0] }[n] : { 1: ['eighth', 0], 2: ['quarter', 0] }[n];
      const ev = { id: newId(), rest: !pitches, type: base[0], dots: base[1], notes: [], tuplet: { id, actual: fine ? 6 : 3, normal: fine ? 4 : 2 } };
      y += n * unit;
      if (pitches) ev.notes = pitches.map(q => ({ ...q, tie: y < e || tieOut }));
      out.push(ev);
    }
    return out;
  }
  for (const x of all) {
    if (x.start < cur) continue; // 重なりは先のものを優先
    pushRest(cur, x.start);
    if (x.kind === 'keep') { evs.push(x.ev); cur = x.end; continue; }
    const pitches = sortPitches(x.item.pitches.map(q => ({ ...q })));
    const pieces = [];
    let y = x.start;
    while (y < x.end) {
      const bb = Math.floor((y + offset) / beat) * beat - offset;
      if (bb >= 0 && tripBeat(bb)) {
        const e = Math.min(x.end, bb + beat);
        pieces.push(...tripletPieces(y, e, bb, pitches, true));
        y = e;
      } else {
        let e = x.end;
        for (let q = bb + beat; q < x.end; q += beat) if (tripBeat(q)) { e = q; break; }
        const sp = splitSpan(y, e, time, offset);
        // 拍の頭にそろった1つの音価で書けるならそのまま（付点2分など）
        const one = ticksToType(e - y, 2);
        const useOne = one && (y + offset) % Math.min(e - y, beat) === 0 && sp.length > 1 && (e - y) <= len;
        for (const z of useOne ? [{ type: one.type, dots: one.dots }] : sp) pieces.push({ id: newId(), rest: false, type: z.type, dots: z.dots, notes: pitches.map(q => ({ ...q, tie: true })) });
        y = e;
      }
    }
    pieces.forEach((ev, i) => { if (i === pieces.length - 1) ev.notes.forEach(n => (n.tie = !!x.tieOut)); });
    // 記号・歌詞・装飾音は最初の音符に
    if (x.head && pieces[0]) for (const k of ['art', 'lyr', 'grace']) if (x.item[k]) pieces[0][k] = JSON.parse(JSON.stringify(x.item[k]));
    evs.push(...pieces);
    cur = x.end;
  }
  pushRest(cur, len);
  if (evs.every(e => e.rest && !e.tuplet)) return [measureRest(len)];
  return evs;
}

function sortPitches(ps) { return ps.sort((a, b) => diatonic(a) - diatonic(b) || (a.alter || 0) - (b.alter || 0)); }

// ───────── 小節から読み出す ─────────
// (p, s, v) の [m1, m2] をストリームにする。タイでつながった音は1つにまとめる。
export function readStream(score, p, s, v, m1, m2, A = measureAttrs(score)) {
  const items = [];
  let open = null; // タイが続いている item
  for (let m = m1; m <= m2; m++) {
    const sm = staffMeasure(score, p, s, m);
    const voice = sm?.voices[v];
    if (!voice) { open = null; continue; }
    for (const x of positions(voice)) {
      const ev = x.ev;
      const a = A[m].start + x.start, b = A[m].start + x.end;
      if (ev.rest) { open = null; continue; }
      const same = open && open.end === a && open.pitches.length === ev.notes.length && open.pitches.every((q, i) => midiOf(q) === midiOf(ev.notes[i]));
      if (same) open.end = b;
      else {
        const it = { start: a, end: b, pitches: ev.notes.map(n => { const q = { ...n }; delete q.tie; return q; }) };
        for (const k of ['art', 'lyr', 'grace']) if (ev[k]) it[k] = ev[k];
        items.push(it);
        open = it;
      }
      if (!ev.notes.every(n => n.tie)) open = null;
    }
  }
  return items;
}

// MIDI 番号の並び → ストリーム用の音（調号に合わせて綴る）
export function spellNotes(notes, A, extra = {}) {
  return notes.map(n => {
    const loc = absToLoc(A, n.start);
    const fifths = A[Math.min(loc.m, A.length - 1)].fifths;
    return { ...n, pitch: { ...spellMidi(n.midi, fifths), ...(extra.pitch ? extra.pitch(n) : {}) } };
  });
}

export { measureTicks, evTicks };
