// 伴奏の自動生成
//
// コードネーム（C, Am7, F/G …）から、ピアノの伴奏の音符を書き込む。
//   ・メロディーがピアノの右手にあるときは左手だけ、ほかのパート（歌・フルートなど）にあるときは両手
//   ・型（スタイル）：シンプル・アルペジオ・バラード・ズンチャッ（ワルツ）・ボサノバ・8ビート
//   ・和音は前の和音から近い形（転回形）を選ぶ（なめらかにつながる。ボイスリーディング）
//   ・音名はコードに合わせて綴る（B♭ のコードの 3度は A♯ ではなく D）
// コードネームがない小節は、メロディーの音から合いそうなコードを推定して書き込める（estimateChords）。
import { TPQ, STEPS, midiOf, spellMidi, beatTicks, isCompound } from './music.js';
import { measureAttrs, INST, createPart, fillMeasures } from './score.js';
import { parseChord, addDir } from './marks.js';
import { readStream, writeStream } from './stream.js';

const PCS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const mod12 = (x) => ((x % 12) + 12) % 12;
const E8 = TPQ / 2, Q = TPQ;

export const STYLES = [
  { id: 'whole', ja: 'シンプル', desc: 'コードを長くのばす' },
  { id: 'arp', ja: 'アルペジオ', desc: '8分音符の分散和音（ド・ソ・ド・ミ）' },
  { id: 'ballad', ja: 'バラード', desc: 'ゆったり上がる左手と、2分音符の和音' },
  { id: 'waltz', ja: 'ズンチャッ', desc: 'ベースと和音を交互に（3拍子ならワルツ）' },
  { id: 'bossa', ja: 'ボサノバ', desc: '跳ねるベースと、ずらした和音（4拍子）' },
  { id: 'beat8', ja: '8ビート', desc: '8分音符のベースと4分音符の和音（ポップス）' },
];

// ───────── コードの構成音 ─────────
// 戻り値 { root, bass（音名の番号 0〜11）, tones: [{ semi（根音からの半音）, deg（何度）}], c }
export function chordTones(c) {
  const q = (c.quality || '').replace(/add\d+/g, '');
  let t = [[0, 1], [4, 3], [7, 5]];
  if (/^(m(?!aj)|min|-)/.test(q)) t = [[0, 1], [3, 3], [7, 5]];
  if (/dim|°/.test(q)) t = [[0, 1], [3, 3], [6, 5]];
  if (/aug|\+/.test(q)) t = [[0, 1], [4, 3], [8, 5]];
  if (/sus2/.test(q)) t = [[0, 1], [2, 2], [7, 5]];
  else if (/sus/.test(q)) t = [[0, 1], [5, 4], [7, 5]];
  if (/maj7|M7|Δ/.test(q)) t.push([11, 7]);
  else if (/m7b5|m7♭5|ø/.test(q)) t = [[0, 1], [3, 3], [6, 5], [10, 7]];
  else if (/dim7|°7/.test(q)) t = [[0, 1], [3, 3], [6, 5], [9, 7]];
  else if (/7|9|11|13/.test(q)) t.push([10, 7]);
  else if (/6/.test(q)) t.push([9, 6]);
  const root = mod12(PCS[c.root] + c.alter);
  const bass = c.bass ? mod12(PCS[c.bass] + c.bassAlter) : root;
  return { root, bass, tones: t.map(([semi, deg]) => ({ semi, deg })), c };
}

// その音名（step）で midi の高さを書く（変化記号は ±2 まで）
function pitchFor(step, midi) {
  let best = null;
  for (let o = Math.floor(midi / 12) - 3; o <= Math.floor(midi / 12) + 1; o++) {
    const alter = midi - midiOf({ step, alter: 0, octave: o });
    if (Math.abs(alter) <= 2 && (!best || Math.abs(alter) < Math.abs(best.alter))) best = { step, alter, octave: o };
  }
  return best || spellMidi(midi);
}
const DEG_STEP = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 };
function spellTone(ct, deg, midi) { return pitchFor(STEPS[(STEPS.indexOf(ct.c.root) + DEG_STEP[deg]) % 7], midi); }
function spellBass(ct, midi) { return ct.c.bass ? pitchFor(ct.c.bass, midi) : spellTone(ct, 1, midi); }

// ───────── 楽譜のコードネームを集める ─────────
export function collectChords(score, A = measureAttrs(score)) {
  const out = [];
  score.parts.forEach(part => part.staves.forEach(st => st.measures.forEach((sm, m) => (sm?.dirs || []).forEach(d => {
    if (d.k !== 'chord' || !A[m]) return;
    const c = parseChord(d.text);
    if (c) out.push({ abs: A[m].start + d.t, m, t: d.t, text: d.text, ct: chordTones(c) });
  }))));
  out.sort((a, b) => a.abs - b.abs);
  return out.filter((c, i) => i === 0 || c.abs !== out[i - 1].abs);
}

// ───────── 型（1小節ぶん。at・dur は小節の頭からのティック） ─────────
// role：B = ベース、B8 = ベース＋オクターブ上、B5 = ベースの近くの5度、A0〜A3 = 分散和音（1・5・8・10度）、
//       LC = 左手の和音（真ん中のドの下あたり）、RC = 右手の和音
export function pattern(style, a) {
  const full = a.full, time = a.time, bt = beatTicks(time), nb = Math.max(1, Math.round(full / bt));
  const comp = isCompound(time), n8 = Math.max(1, Math.floor(full / E8));
  const lh = [], rh = [];
  const ev = (list, at, dur, role) => { if (at < full && dur > 0) list.push({ at, dur: Math.min(dur, full - at), role }); };
  const arp = () => {
    const seq = comp || n8 % 4 !== 0 ? [0, 1, 2, 3, 2, 1] : [0, 1, 2, 3];
    for (let k = 0; k < n8; k++) ev(lh, k * E8, E8, 'A' + seq[k % seq.length]);
  };
  if (style === 'bossa' && (comp || nb !== 4 || time.beatType !== 4)) style = 'ballad';
  switch (style) {
    case 'whole':
      ev(lh, 0, full, 'B8'); ev(rh, 0, full, 'RC');
      break;
    case 'arp':
      arp(); ev(rh, 0, full, 'RC');
      break;
    case 'ballad':
      if (!comp && nb === 4) { ev(lh, 0, 1.5 * Q, 'A0'); ev(lh, 1.5 * Q, E8, 'A1'); ev(lh, 2 * Q, 2 * Q, 'A2'); }
      else if (!comp && nb === 3) { ev(lh, 0, Q, 'A0'); ev(lh, Q, Q, 'A1'); ev(lh, 2 * Q, Q, 'A2'); }
      else if (!comp && nb === 2) { ev(lh, 0, 1.5 * Q, 'A0'); ev(lh, 1.5 * Q, E8, 'A1'); }
      else arp();
      if (nb % 2 === 0 && nb > 1) { ev(rh, 0, full / 2, 'RC'); ev(rh, full / 2, full / 2, 'RC'); } else ev(rh, 0, full, 'RC');
      break;
    case 'waltz':
      for (let k = 0; k < nb; k++) ev(lh, k * bt, bt, k === 0 ? 'B' : nb === 4 && k === 2 ? 'B5' : 'LC');
      ev(rh, 0, full, 'RC');
      break;
    case 'bossa':
      ev(lh, 0, 1.5 * Q, 'B'); ev(lh, 1.5 * Q, E8, 'B5'); ev(lh, 2 * Q, 1.5 * Q, 'B5'); ev(lh, 3.5 * Q, E8, 'B');
      ev(rh, 0, Q, 'RC'); ev(rh, 1.5 * Q, Q, 'RC'); ev(rh, 3 * Q, Q, 'RC');
      break;
    case 'beat8':
    default:
      for (let k = 0; k < n8; k++) ev(lh, k * E8, E8, 'B');
      for (let k = 0; k < nb; k++) ev(rh, k * bt, bt, 'RC');
      break;
  }
  return { lh, rh };
}

// ───────── 和音の形（ボイシング） ─────────
// tones: [{ pc, deg }] を center あたりに密集させて並べる。前の和音（prev）からの動きが少ない形を選ぶ
function voiceClose(tones, center, prev) {
  let best = null;
  for (let r = 0; r < tones.length; r++) {
    const order = [...tones.slice(r), ...tones.slice(0, r)];
    for (const shift of [-12, 0, 12]) {
      const v = [order[0].pc + 12 * Math.round((center - 5 - order[0].pc) / 12) + shift];
      for (let i = 1; i < order.length; i++) { let x = order[i].pc + 12 * Math.floor(v[i - 1] / 12); while (x <= v[i - 1]) x += 12; v.push(x); }
      const mean = v.reduce((s, x) => s + x, 0) / v.length;
      let cost = Math.abs(mean - center) * 0.6 + Math.max(0, Math.abs(mean - center) - 5) * 2;
      if (prev?.length) cost += v.reduce((s, x) => s + Math.min(...prev.map(p => Math.abs(p - x))), 0) / v.length;
      if (!best || cost < best.cost) best = { cost, notes: v.map((x, i) => ({ midi: x, deg: order[i].deg })) };
    }
  }
  return best.notes;
}

// 役割（role）とコード → 音（pitch の並び）。st は前の音を覚えておく入れ物（なめらかにつなぐため）
function realize(role, ct, st) {
  const P = (midi, deg) => (deg === 'bass' ? spellBass(ct, midi) : spellTone(ct, deg, midi));
  const toneOf = (deg) => ct.tones.find(t => t.deg === deg);
  const fifthSemi = (toneOf(5) || ct.tones[ct.tones.length - 1]).semi;
  const third = toneOf(3) || toneOf(4) || toneOf(2) || ct.tones[1];
  // ベース：前のベースに近く、低すぎず高すぎない高さ（ド2〜レ3）
  const bassMidi = () => {
    let best = null;
    for (let x = 36; x <= 50; x++) {
      if (mod12(x) !== ct.bass) continue;
      const cost = Math.abs(x - st.bass) + 0.4 * Math.abs(x - 42);
      if (!best || cost < best.cost) best = { x, cost };
    }
    st.bass = best.x;
    return best.x;
  };
  const above = (pc, from) => { let x = from + 1; while (mod12(x) !== pc) x++; return x; };
  const fifthTone = toneOf(5) || ct.tones[ct.tones.length - 1];
  const fifthPc = mod12(ct.root + fifthSemi);
  switch (role) {
    case 'B': { const b = bassMidi(); return [P(b, 'bass')]; }
    case 'B8': { const b = bassMidi(); return [P(b, 'bass'), P(b + 12, 'bass')]; }
    case 'B5': {
      // ベースの5度下。低くなりすぎるとき（ミ2より下）は5度上
      const b = st.bass ?? bassMidi();
      let x = above(fifthPc, b - 12);
      if (x >= b) x -= 12;
      if (x < 40) x += 12;
      return [P(x, fifthTone.deg)];
    }
    case 'A0': case 'A1': case 'A2': case 'A3': {
      const a0 = role === 'A0' ? bassMidi() : st.bass;
      const a1 = above(fifthPc, a0), a2 = above(ct.root, a1), a3 = above(mod12(ct.root + third.semi), a2);
      const k = +role[1];
      return [[P(a0, 'bass'), P(a1, fifthTone.deg), P(a2, 1), P(a3, third.deg)][k]];
    }
    case 'LC': {
      let tones = ct.tones.map(t => ({ pc: mod12(ct.root + t.semi), deg: t.deg }));
      if (tones.length > 3) tones = tones.filter(t => t.deg !== 1); // 4和音は根音を抜く（ベースが弾いている）
      const v = voiceClose(tones, 55, st.lc);
      st.lc = v.map(x => x.midi);
      return v.map(x => P(x.midi, x.deg));
    }
    case 'RC': {
      const tones = ct.tones.map(t => ({ pc: mod12(ct.root + t.semi), deg: t.deg }));
      const v = voiceClose(tones, 66, st.rc);
      st.rc = v.map(x => x.midi);
      return v.map(x => P(x.midi, x.deg));
    }
  }
  return [];
}

// ───────── メロディーとピアノの役わり ─────────
const isKeyboard = (part) => INST[part.inst]?.fam === '鍵盤' && part.staves.filter(s => s.tabOf == null && s.clef !== 'percussion').length >= 2;
function hasNotes(part, s, m1, m2) {
  const st = part.staves[s];
  for (let m = m1; m <= m2; m++) for (const v of st?.measures[m]?.voices || []) if (v?.some(e => !e.rest)) return true;
  return false;
}
// melody: メロディーのある譜表 / target: 伴奏を書くピアノ（lh = 左手の譜表、rh = 右手の譜表。null なら右手は書かない）
export function findRoles(score, m1 = 0, m2 = score.measures.length - 1) {
  const kb = score.parts.findIndex(isKeyboard);
  let melody = null;
  score.parts.forEach((part, p) => {
    if (melody || p === kb || part.staves.some(st => st.clef === 'percussion')) return;
    if (hasNotes(part, 0, m1, m2)) melody = { p, s: 0 };
  });
  if (!melody) melody = kb >= 0 ? { p: kb, s: 0 } : { p: 0, s: 0 };
  const target = kb >= 0 ? { p: kb, lh: 1, rh: melody.p === kb ? null : 0 } : null;
  return { melody, target };
}

// ───────── メロディーからコードを推定 ─────────
// 小節ごとに、調の主なコード（I ii iii IV V V7 vi / 短調は i iv V V7 VI III VII）から合うものを選ぶ。
//   ・メロディーの音がコードの音なら＋、そうでなければ−（強拍の長い音ほど重く数える）
//   ・つながりの自然さ（V → I、IV → V、ii → V …）と、終わりは I で終わること、を足して、
//     全体でいちばん点の高い並びを選ぶ（ビタビ法：1小節ずつ「ここまでの最高点」を伸ばしていく）
const MAJOR = [[0, '', 'I', 0.12], [2, 'm', 'ii', 0.02], [4, 'm', 'iii', -0.05], [5, '', 'IV', 0.08], [7, '', 'V', 0.08], [7, '7', 'V7', 0], [9, 'm', 'vi', 0.03]];
const MINOR = [[0, 'm', 'I', 0.12], [5, 'm', 'IV', 0.06], [7, '', 'V', 0.08], [7, '7', 'V7', 0], [8, '', 'VI', 0.03], [3, '', 'III', 0], [10, '', 'VII', -0.03]];
const TRANS = { 'V>I': 0.25, 'V7>I': 0.3, 'IV>V': 0.1, 'IV>V7': 0.1, 'ii>V': 0.15, 'ii>V7': 0.15, 'IV>I': 0.05, 'vi>ii': 0.06, 'vi>IV': 0.06, 'I>IV': 0.05, 'I>V': 0.04, 'I>vi': 0.04, 'V>IV': -0.1, 'VI>V': 0.08, 'VII>III': 0.1, 'III>VI': 0.06 };
function trans(a, b) {
  if (a.fn === 'V7' && b.fn !== 'I' && b.fn !== 'vi' && b.fn !== 'VI') return -0.2;
  return TRANS[a.fn + '>' + b.fn] || 0;
}
export function chordName(pc, q, fifths) {
  const p = spellMidi(60 + pc, fifths);
  return p.step + (p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter)) + q;
}
export function estimateChords(score, { p, s, m1 = 0, m2 = score.measures.length - 1, A = measureAttrs(score) }) {
  // メロディー：声部1（和音なら一番上の音）
  const items = readStream(score, p, s, 0, m1, m2, A);
  const per = [];
  for (let m = m1; m <= m2; m++) per[m] = [];
  const hist = new Array(12).fill(0);
  let last = null;
  for (const it of items) {
    const top = it.pitches.reduce((a, q) => (midiOf(q) > midiOf(a) ? q : a));
    const pc = mod12(midiOf(top));
    for (let m = m1; m <= m2; m++) {
      const a = A[m], s0 = Math.max(it.start, a.start), s1 = Math.min(it.end, a.start + a.len);
      if (s1 <= s0) continue;
      const rel = s0 - a.start + (a.full - a.len), bt = beatTicks(a.time);
      const strong = rel === 0 ? 1.5 : rel % bt === 0 ? 1.1 : 0.8;
      const w = ((s1 - s0) / TPQ) * strong;
      per[m].push({ pc, w });
      hist[pc] += w;
    }
    last = pc;
  }
  // 長調か短調か：主音・3度・導音（短調の G♯ など）の多さと、最後の音で決める
  const fifths = A[m1].fifths, T = mod12(fifths * 7), t = mod12(T + 9);
  const total = hist.reduce((a, b) => a + b, 0) || 1;
  const maj = hist[T] + 0.6 * hist[mod12(T + 4)] + 0.4 * hist[mod12(T + 7)] + (last === T ? 0.3 * total : 0);
  const min = hist[t] + 0.6 * hist[mod12(t + 3)] + 1.2 * hist[mod12(t + 11)] + (last === t ? 0.3 * total : 0);
  const minor = min > maj;

  const ms = [];
  for (let m = m1; m <= m2; m++) ms.push(m);
  const candsFor = (m) => {
    const f = A[m].fifths, tonic = minor ? mod12(f * 7 + 9) : mod12(f * 7);
    const scale = new Set((minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11]).map(x => mod12(tonic + x)));
    return (minor ? MINOR : MAJOR).map(([iv, q, fn, prior]) => {
      const root = mod12(tonic + iv);
      const ct = chordTones({ root: 'C', alter: 0, quality: q, bass: null, bassAlter: 0 });
      return { root, q, fn, prior, pcs: new Set(ct.tones.map(x => mod12(root + x.semi))), scale, text: chordName(root, q, f) };
    });
  };
  const fit = (m, c) => {
    const ns = per[m];
    let sum = 0, wt = 0;
    for (const n of ns) {
      wt += n.w;
      if (c.pcs.has(n.pc)) sum += n.w * (n.pc === c.root ? 1.1 : 1);
      else sum -= n.w * (c.scale.has(n.pc) ? 0.3 : 0.6);
    }
    let v = wt ? sum / wt : 0;
    if (c.q === '7' && !ns.some(n => n.pc === mod12(c.root + 10))) v -= 0.08; // 7の音がないなら素直な3和音を選ぶ
    return v;
  };
  // ビタビ法
  const layers = ms.map(candsFor);
  const dp = [], back = [];
  ms.forEach((m, i) => {
    dp[i] = []; back[i] = [];
    layers[i].forEach((c, j) => {
      let local = fit(m, c) + c.prior;
      if (i === 0 && c.fn === 'I') local += 0.2;
      if (i === ms.length - 1 && c.fn === 'I') local += 0.6;
      if (i === ms.length - 2 && (c.fn === 'V' || c.fn === 'V7')) local += 0.2;
      if (i === 0) { dp[i][j] = local; back[i][j] = -1; return; }
      let best = -Infinity, bi = 0;
      layers[i - 1].forEach((pc, k) => { const v = dp[i - 1][k] + trans(pc, c); if (v > best) { best = v; bi = k; } });
      dp[i][j] = best + local; back[i][j] = bi;
    });
  });
  let j = dp[ms.length - 1].reduce((bi, v, k, arr) => (v > arr[bi] ? k : bi), 0);
  const out = [];
  for (let i = ms.length - 1; i >= 0; i--) { out[i] = { m: ms[i], text: layers[i][j].text, fn: layers[i][j].fn }; j = back[i][j]; }
  return { chords: out, minor };
}

// ───────── 伴奏を書き込む ─────────
// o: { m1, m2, style, estimate（コードがない小節は推定して書く） }
// 戻り値 { ok, reason?, added（推定して書いたコード）, target, measures }
export function addAccompaniment(score, o) {
  const m1 = o.m1 ?? 0, m2 = Math.min(o.m2 ?? score.measures.length - 1, score.measures.length - 1);
  const roles = findRoles(score, m1, m2);
  let A = measureAttrs(score);
  // 推定：コードネームが1つもない小節だけに書く（書いてあるコードはそのまま使う）
  const added = [];
  const chordMeasures = new Set(collectChords(score, A).map(c => c.m));
  if (o.estimate && [...Array(m2 - m1 + 1).keys()].some(i => !chordMeasures.has(m1 + i))) {
    const { chords } = estimateChords(score, { ...roles.melody, m1, m2, A });
    let prev = null;
    for (const c of chords) {
      if (chordMeasures.has(c.m)) { prev = null; continue; }
      if (c.text !== prev) { addDir(score, roles.melody.p, roles.melody.s, c.m, { t: 0, k: 'chord', text: c.text }); added.push(c); }
      prev = c.text;
    }
  }
  const chords = collectChords(score, A);
  const inRange = chords.filter(c => c.abs < A[m2].start + A[m2].len);
  if (!inRange.length) return { ok: false, reason: 'nochords' };
  // ピアノがなければ伴奏用のピアノのパートを足す
  let target = roles.target;
  if (!target) {
    const part = createPart('piano');
    part.name = 'ピアノ（伴奏）'; part.abbr = 'Pno.';
    score.parts.push(part);
    fillMeasures(score);
    target = { p: score.parts.length - 1, lh: 1, rh: 0 };
    A = measureAttrs(score);
  }
  const chordAt = (abs) => { let c = null; for (const x of chords) { if (x.abs <= abs) c = x; else break; } return c; };
  const st = { bass: 42, lc: null, rc: null };
  const lh = [], rh = [];
  const covered = [];
  for (let m = m1; m <= m2; m++) {
    const a = A[m], off = a.full - a.len, end = a.start + a.len;
    if (!chordAt(end - 1)) continue; // まだコードが始まっていない小節
    covered.push(m);
    const pat = pattern(o.style || 'arp', a);
    for (const [list, out] of [[pat.lh, lh], [target.rh != null ? pat.rh : [], rh]]) {
      for (const e of list) {
        if (e.at < off) continue; // 弱起の小節は後ろの部分だけ
        const s = a.start + e.at - off, en = Math.min(s + e.dur, end);
        // コードが変わるところで切る
        const cuts = [s, ...chords.filter(c => c.abs > s && c.abs < en).map(c => c.abs), en];
        for (let k = 0; k + 1 < cuts.length; k++) {
          const ps = cuts[k], pe = cuts[k + 1];
          if (pe - ps < TPQ / 4 && cuts.length > 2) continue;
          const c = chordAt(ps);
          if (!c) continue;
          const pitches = realize(e.role, c.ct, st);
          if (pitches.length) out.push({ start: ps, end: pe, pitches });
        }
      }
    }
  }
  // コードのある小節のまとまりごとに書き込む（コードのない小節の中身は残す）
  const runs = [];
  for (const m of covered) { const r = runs[runs.length - 1]; if (r && r.m2 === m - 1) r.m2 = m; else runs.push({ m1: m, m2: m }); }
  for (const r of runs) {
    const from = A[r.m1].start, to = A[r.m2].start + A[r.m2].len;
    const pick = (list) => list.filter(it => it.start >= from && it.start < to);
    writeStream(score, target.p, target.lh, 0, pick(lh), { from, to });
    if (target.rh != null) writeStream(score, target.p, target.rh, 0, pick(rh), { from, to });
  }
  return { ok: true, added, target, measures: covered.length, roles };
}
