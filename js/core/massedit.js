// 一括編集（Phase 3）：範囲を選んでまとめて変える。Finale の「ユーティリティ」メニューに相当
//
// range = { m1, m2, staves: [[p, s], ...] }（app.rangeStaves の形）
//   ・移調（音程・オクターブ、コードネームも一緒に）
//   ・音価を2倍 / 半分（後ろの小節は詰めたり押し出したりする）、逆行
//   ・アーティキュレーションをまとめて付ける / 外す、項目を選んで消去
//   ・異名同音の書き換え（C♯ ⇔ D♭）
//   ・エクスプロード（和音を下の譜表へ分ける）/ インプロード（複数の譜表を1つの和音にまとめる）
import { transposeInterval, midiOf, spellMidi, diatonic, fifthsForSemis } from './music.js';
import { measureAttrs, measureRest } from './score.js';
import { staffMeasure, positions } from './edit.js';
import { readStream, writeStream, splitVoices } from './stream.js';
import { transposeChord } from './marks.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
// TAB 譜表（表示だけ）とドラム譜は音高をいじらない
const pitched = (score, p, s) => { const st = score.parts[p]?.staves[s]; return st && st.tabOf == null && st.clef !== 'percussion'; };
const plain = (score, p, s) => { const st = score.parts[p]?.staves[s]; return st && st.tabOf == null; };
function eachEvent(score, range, fn, filter = plain) {
  for (const [p, s] of range.staves) {
    if (!filter(score, p, s)) continue;
    for (let m = range.m1; m <= range.m2; m++) {
      const sm = staffMeasure(score, p, s, m);
      sm?.voices.forEach((v, vi) => v && v.forEach(e => fn(e, { p, s, m, v: vi, sm })));
    }
  }
}
function sortNotes(ns) { return ns.sort((a, b) => diatonic(a) - diatonic(b) || (a.alter || 0) - (b.alter || 0)); }

// ───────── 移調 ─────────
// dia = 全音階で何度（長2度上なら +1）、chrom = 半音数（長2度なら +2）。調号もずらすなら keys = true
export function transposeBy(score, range, dia, chrom, { keys = false, chords = true } = {}) {
  eachEvent(score, range, (e) => {
    if (e.rest) return;
    e.notes = sortNotes(e.notes.map(n => ({ ...n, ...transposeInterval(n, dia, chrom), tie: n.tie })));
    if (e.grace) e.grace.forEach(g => (g.notes = g.notes.map(n => ({ ...n, ...transposeInterval(n, dia, chrom) }))));
  }, pitched);
  if (chords) for (const [p, s] of range.staves) for (let m = range.m1; m <= range.m2; m++) {
    const sm = staffMeasure(score, p, s, m);
    (sm?.dirs || []).forEach(d => { if (d.k === 'chord' && d.text) d.text = transposeChord(d.text, chrom, 0); });
  }
  if (keys && chrom % 12) {
    const A = measureAttrs(score);
    const df = fifthsForSemis(chrom);
    for (let m = range.m1; m <= range.m2; m++) {
      const ms = score.measures[m];
      if (m === range.m1 || ms.key) {
        let f = A[m].fifths + df;
        if (f > 7) f -= 12; if (f < -7) f += 12;
        ms.key = { fifths: f };
      }
    }
    // 範囲のすぐ後ろは元の調に戻す
    const after = range.m2 + 1;
    if (after < score.measures.length && !score.measures[after].key) score.measures[after].key = { fifths: A[after].fifths };
  }
}

// 異名同音の書き換え：♯ の音は ♭ に、♭ の音は ♯ に（ナチュラルの音はそのまま）
export function respell(score, range) {
  let n = 0;
  eachEvent(score, range, (e) => {
    if (e.rest) return;
    e.notes = sortNotes(e.notes.map(q => {
      if (!q.alter) return q;
      n++;
      return { ...q, ...spellMidi(midiOf(q), q.alter > 0 ? -6 : 6), tie: q.tie };
    }));
  }, pitched);
  return n;
}

// ───────── アーティキュレーション ─────────
export function setArticAll(score, range, key, on = true) {
  let n = 0;
  eachEvent(score, range, (e) => {
    if (e.rest || e.mr) return;
    const has = e.art?.includes(key);
    if (on && !has) { e.art = [...(e.art || []), key]; n++; }
    if (!on && has) { e.art = e.art.filter(k => k !== key); if (!e.art.length) delete e.art; n++; }
  });
  return n;
}

// ───────── 項目を選んで消去（Finale の「項目を選択して消去」） ─────────
// what: { notes, art, dyn, text, chords, lyrics, slurs, hairs, lines, grace }
export function clearItems(score, range, what) {
  const A = measureAttrs(score);
  for (const [p, s] of range.staves) for (let m = range.m1; m <= range.m2; m++) {
    const sm = staffMeasure(score, p, s, m);
    if (!sm) continue;
    if (sm.dirs) {
      sm.dirs = sm.dirs.filter(d => !((what.dyn && d.k === 'dyn') || (what.text && d.k === 'text') || (what.chords && d.k === 'chord')));
      if (!sm.dirs.length) delete sm.dirs;
    }
    if (sm.spans) {
      sm.spans = sm.spans.filter(sp => !((what.slurs && sp.k === 'slur') || (what.hairs && (sp.k === 'cresc' || sp.k === 'dim')) || (what.lines && !['slur', 'cresc', 'dim'].includes(sp.k))));
      if (!sm.spans.length) delete sm.spans;
    }
    sm.voices.forEach(v => v && v.forEach(e => {
      if (what.art) delete e.art;
      if (what.lyrics) delete e.lyr;
      if (what.grace) delete e.grace;
    }));
  }
  if (what.notes) {
    // 音符を消した小節は全休符に（fillMeasures と同じ形）
    for (const [p, s] of range.staves) for (let m = range.m1; m <= range.m2; m++) {
      const sm = staffMeasure(score, p, s, m);
      if (sm) sm.voices = [[measureRest(A[m].len)]];
    }
  }
}

// ───────── 音価を何倍かに（2倍 = 拡大、0.5 = 縮小）・逆行 ─────────
// その譜表の後ろの音楽は、伸び縮みしたぶんだけ後ろ/前にずれる（Finale の「小節の再構成」と同じ）
export function scaleDurations(score, range, factor) {
  let A = measureAttrs(score);
  const a = A[range.m1].start, b = A[range.m2].start + A[range.m2].len;
  const delta = (b - a) * (factor - 1);
  const lastM = score.measures.length - 1;
  for (const [p, s] of range.staves) {
    if (!plain(score, p, s)) continue;
    const st = score.parts[p].staves[s];
    const nv = Math.max(...st.measures.map(sm => sm.voices.length));
    for (let v = 0; v < nv; v++) {
      const items = readStream(score, p, s, v, range.m1, lastM, A);
      const out = [];
      for (const it of items) {
        if (it.start >= b) out.push({ ...it, start: it.start + delta, end: it.end + delta });
        else if (it.start >= a) {
          const end = it.end <= b ? a + (it.end - a) * factor : it.end + delta;
          out.push({ ...it, start: a + (it.start - a) * factor, end });
        } else out.push(it);
      }
      const keep = out.filter(it => it.start >= a);
      // 前からかかっている音（範囲の前から伸びている音）はそのまま
      writeStream(score, p, s, v, keep, { from: a, to: Math.max(A[lastM].start + A[lastM].len, keep.length ? keep[keep.length - 1].end : 0) });
      A = measureAttrs(score);
    }
  }
}
export function retrograde(score, range) {
  const A = measureAttrs(score);
  const a = A[range.m1].start, b = A[range.m2].start + A[range.m2].len;
  for (const [p, s] of range.staves) {
    if (!plain(score, p, s)) continue;
    const sm0 = score.parts[p].staves[s];
    const nv = Math.max(...sm0.measures.slice(range.m1, range.m2 + 1).map(sm => sm.voices.length));
    for (let v = 0; v < nv; v++) {
      const items = readStream(score, p, s, v, range.m1, range.m2, A).filter(it => it.start >= a && it.end <= b);
      const out = items.map(it => ({ ...it, start: a + (b - it.end), end: a + (b - it.start) }));
      writeStream(score, p, s, v, out, { from: a, to: b });
    }
  }
}

// ───────── エクスプロード / インプロード ─────────
// エクスプロード：1つ目の譜表の和音を、上の音から順に2つ目以降の譜表へ分ける。
//   譜表を1つしか選んでいなければ、その下にある譜表（和音の音の数だけ）を使う。
export function explode(score, range, rows) {
  const [src, ...tg] = range.staves;
  let targets = tg;
  if (!targets.length) {
    const r0 = rows.findIndex(x => x.p === src[0] && x.s === src[1]);
    let maxN = 1;
    for (let m = range.m1; m <= range.m2; m++) staffMeasure(score, src[0], src[1], m)?.voices[0]?.forEach(e => { if (!e.rest) maxN = Math.max(maxN, e.notes.length); });
    targets = rows.slice(r0 + 1, r0 + 1 + maxN).map(x => [x.p, x.s]).filter(([p, s]) => pitched(score, p, s));
  }
  if (!targets.length) return 0;
  const all = [src, ...targets];
  for (let m = range.m1; m <= range.m2; m++) {
    const sm = staffMeasure(score, src[0], src[1], m);
    if (!sm) continue;
    const base = clone(sm.voices[0]);
    all.forEach(([p, s], k) => {
      const tsm = staffMeasure(score, p, s, m);
      if (!tsm) return;
      const v0 = base.map(e => {
        const c = clone(e);
        c.id = e.id + (k ? '_' + k : '');
        if (!e.rest) {
          const desc = [...e.notes].sort((x, y) => midiOf(y) - midiOf(x));
          const n = desc[k];
          if (n) c.notes = [n]; else { c.rest = true; c.notes = []; delete c.art; }
          if (k > 0) delete c.lyr;
        }
        return c;
      });
      tsm.voices = [v0];
    });
  }
  return targets.length + 1;
}

// インプロード：選んだ譜表（2つ以上）の音を、いちばん上の譜表に和音としてまとめる（ほかの譜表はそのまま）
export function implode(score, range) {
  const st = range.staves.filter(([p, s]) => pitched(score, p, s));
  if (st.length < 2) return false;
  const A = measureAttrs(score);
  const a = A[range.m1].start, b = A[range.m2].start + A[range.m2].len;
  const notes = [];
  for (const [p, s] of st) for (const it of readStream(score, p, s, 0, range.m1, range.m2, A)) for (const q of it.pitches) {
    if (!notes.some(n => n.start === it.start && midiOf(n.pitch) === midiOf(q))) notes.push({ start: it.start, end: it.end, pitch: q });
  }
  const [v1, v2] = splitVoices(notes);
  const [p0, s0] = st[0];
  writeStream(score, p0, s0, 0, v1, { from: a, to: b });
  writeStream(score, p0, s0, 1, v2, { from: a, to: b });
  return true;
}

export { positions };
