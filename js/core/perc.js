// ドラム譜と TAB 譜（Phase 3）
//
// ■ ドラム譜
//   打楽器記号の五線。音符は普通の音高 { step, octave } で「五線のどこに書くか」を持ち、
//   n.drum に「どの太鼓/シンバルか」を持つ（MusicXML の unpitched + instrument と同じ考え方）。
//   再生は GM のドラム番号（36 = バスドラム …）で鳴らす。
//
// ■ TAB 譜
//   ギター・ベースの「五線＋TAB」。TAB の譜表は staff.tabOf（五線の譜表番号）を持ち、中身は持たない。
//   五線に入れた音から、弦とフレットを自動で決めて表示する（n.str で弦を指定することもできる）。
import { midiOf, diatonic } from './music.js';

export const DRUMS = [
  { id: 'kick', ja: 'バスドラム', gm: 36, step: 'F', octave: 4 },
  { id: 'snare', ja: 'スネア', gm: 38, step: 'C', octave: 5 },
  { id: 'stick', ja: 'サイドスティック', gm: 37, step: 'C', octave: 5, head: 'circlex' },
  { id: 'tom1', ja: 'ハイタム', gm: 48, step: 'E', octave: 5 },
  { id: 'tom2', ja: 'ロータム', gm: 45, step: 'D', octave: 5 },
  { id: 'floor', ja: 'フロアタム', gm: 43, step: 'A', octave: 4 },
  { id: 'hh', ja: 'ハイハット（クローズ）', gm: 42, step: 'G', octave: 5, head: 'x' },
  { id: 'hho', ja: 'ハイハット（オープン）', gm: 46, step: 'G', octave: 5, head: 'circlex' },
  { id: 'hhp', ja: 'ハイハット（ペダル）', gm: 44, step: 'D', octave: 4, head: 'x' },
  { id: 'ride', ja: 'ライド', gm: 51, step: 'F', octave: 5, head: 'x' },
  { id: 'bell', ja: 'ライドのカップ', gm: 53, step: 'F', octave: 5, head: 'diamond' },
  { id: 'crash', ja: 'クラッシュ', gm: 49, step: 'A', octave: 5, head: 'x' },
];
export const DRUM = Object.fromEntries(DRUMS.map(d => [d.id, d]));

// GM のドラム番号 → いちばん近いドラム
const GM_ALIAS = { 35: 'kick', 36: 'kick', 37: 'stick', 38: 'snare', 39: 'snare', 40: 'snare', 41: 'floor', 43: 'floor', 45: 'tom2', 47: 'tom2', 48: 'tom1', 50: 'tom1', 42: 'hh', 44: 'hhp', 46: 'hho', 49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash', 51: 'ride', 59: 'ride', 53: 'bell', 54: 'hh', 56: 'bell', 69: 'hh', 70: 'hh' };
export function drumForGm(n) { return DRUM[GM_ALIAS[n]] || (n < 41 ? DRUM.kick : n < 50 ? DRUM.tom1 : DRUM.crash); }

export const drumPitch = (d) => ({ step: d.step, alter: 0, octave: d.octave, drum: d.id });
// 五線の位置（音高）→ そこに書くドラム（同じ位置に2つあるときは先に並んでいる方）
export function drumAt(p) {
  const dn = diatonic(p);
  let best = DRUMS[0], bd = 99;
  for (const d of DRUMS) { const x = Math.abs(diatonic(d) - dn); if (x < bd) { bd = x; best = d; } }
  return best;
}
export function drumOf(n) { return DRUM[n.drum] || drumAt(n); }
export function isPercStaff(staff) { return staff && staff.clef === 'percussion'; }

// ───────── TAB ─────────
// 1弦（いちばん高い弦）から順の開放弦の MIDI 番号
export const TUNINGS = {
  guitar: { ja: 'ギター（標準）', notes: [64, 59, 55, 50, 45, 40] },
  dropd: { ja: 'ギター（ドロップD）', notes: [64, 59, 55, 50, 45, 38] },
  bass: { ja: 'ベース（4弦）', notes: [43, 38, 33, 28] },
  bass5: { ja: 'ベース（5弦）', notes: [43, 38, 33, 28, 23] },
};
export function isTabStaff(staff) { return staff && staff.tabOf != null; }

// 和音の各音に弦とフレットを割り当てる。高い音から、空いている弦のうちフレットが一番小さいものへ。
// n.str（弦の指定）があればそれを優先する。戻り値は notes と同じ順の [{ str, fret }]（弾けなければ null）
export function tabFrets(notes, tuning, maxFret = 24) {
  const out = notes.map(() => null);
  const used = new Set();
  const order = notes.map((n, i) => ({ n, i, m: midiOf(n) })).sort((a, b) => b.m - a.m);
  for (const x of order) {
    const s = x.n.str;
    if (s && !used.has(s) && tuning[s - 1] != null && x.m - tuning[s - 1] >= 0 && x.m - tuning[s - 1] <= maxFret) { out[x.i] = { str: s, fret: x.m - tuning[s - 1] }; used.add(s); }
  }
  for (const x of order) {
    if (out[x.i]) continue;
    let best = null;
    tuning.forEach((open, k) => {
      const fret = x.m - open;
      if (used.has(k + 1) || fret < 0 || fret > maxFret) return;
      if (!best || fret < best.fret) best = { str: k + 1, fret };
    });
    if (best) { out[x.i] = best; used.add(best.str); }
  }
  return out;
}
