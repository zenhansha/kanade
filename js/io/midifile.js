// MIDI ファイル（.mid / Standard MIDI File）の読み書き（Phase 3）
//
// 書き出し：聞こえるとおり（反復・強弱・表情付き再生込み）を、小節線がそろうテンポ表つきで書く。
//   DAW に読み込むと小節が合い、再生すると KANADE と同じタイミングで鳴る。
// 読み込み：MIDI の音をクオンタイズ（16分や3連にそろえる）して楽譜にする。
//   トラック/チャンネルごとにパート、10ch はドラム譜、ピアノは真ん中のドで右手・左手に分ける。
import { TPQ, measureTicks, spellMidi } from '../core/music.js';
import { createScore, measureAttrs, measureRest, INSTRUMENTS, INST } from '../core/score.js';
import { buildPerformance } from '../audio/player.js';
import { quantize, splitVoices, writeStream, absToLoc } from '../core/stream.js';
import { drumForGm, drumPitch } from '../core/perc.js';

const DIV = 480;

// ═════════ 書き出し ═════════
export function exportMidi(score, perf = buildPerformance(score)) {
  const A = perf.attrs, order = perf.order, ss = perf.seqStart;
  // 小節ごとの「実際にかかった時間」から、その小節の平均テンポを出す（フェルマータ・rit. も含めて小節線がそろう）
  const seqTick = [], bpmEff = [];
  let tk = 0;
  order.forEach((m, i) => {
    seqTick[i] = tk;
    const beats = A[m].len / TPQ;
    const dur = (i + 1 < order.length ? ss[i + 1] : perf.total) - ss[i];
    bpmEff[i] = dur > 0 ? (beats / dur) * 60 : A[m].bpm;
    tk += Math.round(beats * DIV);
  });
  const secToTick = (sec) => {
    let lo = 0, hi = order.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ss[mid] <= sec) lo = mid; else hi = mid - 1; }
    return Math.max(0, Math.round(seqTick[lo] + ((sec - ss[lo]) * bpmEff[lo] / 60) * DIV));
  };
  const tracks = [];
  // トラック0：テンポ・拍子・調
  const meta = [];
  meta.push({ t: 0, d: metaEv(0x03, utf8(score.meta.title || 'KANADE')) });
  let lastBpm = null, lastTime = null, lastKey = null;
  order.forEach((m, i) => {
    const bpm = Math.round(bpmEff[i] * 100) / 100;
    if (bpm !== lastBpm) { const us = Math.round(60000000 / bpm); meta.push({ t: seqTick[i], d: metaEv(0x51, [us >> 16 & 255, us >> 8 & 255, us & 255]) }); lastBpm = bpm; }
    const ts = A[m].time, tsKey = ts.beats + '/' + ts.beatType + (A[m].len !== A[m].full ? 'p' + A[m].len : '');
    if (tsKey !== lastTime) {
      // 弱起小節は「短い拍子」として書く（DAW で小節がずれないように）
      let beats = ts.beats, bt = ts.beatType;
      if (A[m].len !== A[m].full) { beats = Math.max(1, Math.round(A[m].len / (TPQ * 4 / bt))); }
      meta.push({ t: seqTick[i], d: metaEv(0x58, [beats, Math.log2(bt), 24, 8]) }); lastTime = tsKey;
    }
    if (A[m].fifths !== lastKey) { meta.push({ t: seqTick[i], d: metaEv(0x59, [A[m].fifths & 255, 0]) }); lastKey = A[m].fifths; }
  });
  tracks.push(meta);
  // パートごとのトラック
  let ch = 0;
  score.parts.forEach((part, p) => {
    const notes = perf.notes.filter(n => n.p === p);
    const drum = notes.some(n => n.drum) || part.inst === 'drumset';
    const c = drum ? 9 : ch;
    if (!drum) { ch++; if (ch === 9) ch++; if (ch > 15) ch = 0; }
    const ev = [{ t: 0, d: metaEv(0x03, utf8(part.name)) }];
    if (!drum) ev.push({ t: 0, d: [0xc0 | c, (part.program || 0) & 127] });
    const mix = part.mix || {};
    ev.push({ t: 0, d: [0xb0 | c, 7, Math.round((mix.vol ?? 0.8) * 127)] });
    ev.push({ t: 0, d: [0xb0 | c, 10, Math.round(((mix.pan ?? 0) + 1) * 63.5)] });
    for (const n of notes) {
      const a = secToTick(n.start), b = Math.max(a + 1, secToTick(n.end));
      const vel = Math.max(1, Math.min(127, Math.round((n.vel ?? 0.7) * 127)));
      ev.push({ t: a, d: [0x90 | c, n.midi & 127, vel], on: 1 });
      ev.push({ t: b, d: [0x80 | c, n.midi & 127, 64], on: 0 });
    }
    tracks.push(ev);
  });
  const chunks = [chunk('MThd', [0, 1, tracks.length >> 8 & 255, tracks.length & 255, DIV >> 8, DIV & 255])];
  for (const tr of tracks) {
    tr.sort((x, y) => x.t - y.t || (x.on ?? 2) - (y.on ?? 2));
    const bytes = [];
    let prev = 0;
    for (const e of tr) { bytes.push(...vlq(e.t - prev), ...e.d); prev = e.t; }
    bytes.push(0, 0xff, 0x2f, 0);
    chunks.push(chunk('MTrk', bytes));
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
const metaEv = (type, data) => [0xff, type, ...vlq(data.length), ...data];
const utf8 = (s) => [...new TextEncoder().encode(String(s))];
function vlq(n) {
  const out = [n & 127];
  while ((n >>= 7)) out.unshift((n & 127) | 128);
  return out;
}
function chunk(id, data) {
  const out = new Uint8Array(8 + data.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  const n = data.length;
  out[4] = n >>> 24 & 255; out[5] = n >> 16 & 255; out[6] = n >> 8 & 255; out[7] = n & 255;
  out.set(data, 8);
  return out;
}

// ═════════ 読み込み ═════════
export function parseMidi(buf) {
  const d = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let pos = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d[pos + i]); pos += n; return s; };
  const u32 = () => { const v = (d[pos] << 24 | d[pos + 1] << 16 | d[pos + 2] << 8 | d[pos + 3]) >>> 0; pos += 4; return v; };
  const u16 = () => { const v = d[pos] << 8 | d[pos + 1]; pos += 2; return v; };
  const rv = () => { let v = 0, b; do { b = d[pos++]; v = (v << 7) | (b & 127); } while (b & 128 && pos < d.length); return v; };
  if (str(4) !== 'MThd') throw new Error('MIDI ファイルではありません');
  const hl = u32();
  const format = u16(), ntr = u16(), div = u16();
  pos = 8 + hl;
  if (div & 0x8000) throw new Error('SMPTE 形式の MIDI ファイルには対応していません');
  const tracks = [];
  for (let k = 0; k < ntr && pos < d.length; k++) {
    const id = str(4), len = u32(), end = pos + len;
    if (id !== 'MTrk') { pos = end; continue; }
    const tr = { name: '', events: [] };
    let t = 0, run = 0;
    while (pos < end) {
      t += rv();
      let st = d[pos];
      if (st & 0x80) pos++; else st = run;
      if (st === 0xff) {
        const type = d[pos++], l = rv(), data = d.slice(pos, pos + l); pos += l;
        tr.events.push({ t, meta: type, data });
        if (type === 0x03 && !tr.name) tr.name = new TextDecoder().decode(data);
        if (type === 0x2f) break;
      } else if (st === 0xf0 || st === 0xf7) { const l = rv(); pos += l; }
      else {
        run = st;
        const cmd = st & 0xf0, ch = st & 15;
        const a = d[pos++], b = cmd === 0xc0 || cmd === 0xd0 ? 0 : d[pos++];
        tr.events.push({ t, cmd, ch, a, b });
      }
    }
    pos = end;
    tracks.push(tr);
  }
  return { format, div, tracks };
}

// MIDI → 楽譜。opts: { grid: TPQ/4, triplets: true, split: 60 }
export function importMidi(buf, opts = {}) {
  const mf = parseMidi(buf);
  const sc = (t) => Math.round((t * TPQ) / mf.div);
  const grid = opts.grid || TPQ / 4, triplets = opts.triplets ?? true, split = opts.split ?? 60;
  // テンポ・拍子・調
  const tempos = [], times = [], keys = [];
  const groups = new Map(); // `${track}:${ch}` → { notes, program, name }
  mf.tracks.forEach((tr, ti) => {
    const open = new Map();
    for (const e of tr.events) {
      if (e.meta === 0x51) tempos.push({ t: sc(e.t), bpm: Math.round(60000000 / (e.data[0] << 16 | e.data[1] << 8 | e.data[2])) });
      else if (e.meta === 0x58) times.push({ t: sc(e.t), beats: e.data[0], beatType: 2 ** e.data[1] });
      else if (e.meta === 0x59) keys.push({ t: sc(e.t), fifths: (e.data[0] << 24) >> 24 });
      if (e.cmd == null) continue;
      const key = ti + ':' + e.ch;
      if (!groups.has(key)) groups.set(key, { notes: [], program: null, ch: e.ch, name: tr.name, ti });
      const g = groups.get(key);
      if (e.cmd === 0xc0 && g.program == null) g.program = e.a;
      const on = e.cmd === 0x90 && e.b > 0, off = e.cmd === 0x80 || (e.cmd === 0x90 && e.b === 0);
      const nk = key + ':' + e.a;
      if (on) { if (open.has(nk)) closeNote(open, nk, e.t); open.set(nk, { start: e.t, midi: e.a, vel: e.b, g }); }
      else if (off && open.has(nk)) closeNote(open, nk, e.t);
    }
    for (const nk of [...open.keys()]) closeNote(open, nk, open.get(nk).start + mf.div);
  });
  function closeNote(open, nk, t) {
    const n = open.get(nk);
    open.delete(nk);
    n.g.notes.push({ start: sc(n.start), end: sc(Math.max(t, n.start + 1)), midi: n.midi, vel: n.vel });
  }
  const parts = [...groups.values()].filter(g => g.notes.length).sort((a, b) => a.ti - b.ti || a.ch - b.ch);
  if (!parts.length) throw new Error('音符が入っていない MIDI ファイルです');
  const lastEnd = Math.max(...parts.flatMap(g => g.notes.map(n => n.end)));
  // 小節を作る
  times.sort((a, b) => a.t - b.t); tempos.sort((a, b) => a.t - b.t); keys.sort((a, b) => a.t - b.t);
  const time0 = times.find(x => x.t === 0) || { beats: 4, beatType: 4 };
  const insts = parts.map(g => pickInst(g));
  const score = createScore({ insts: insts.map(x => x.id), measures: 1, time: { beats: time0.beats, beatType: time0.beatType }, bpm: tempos.find(x => x.t <= 0)?.bpm || 120, fifths: keys.find(x => x.t === 0)?.fifths || 0, title: opts.title || 'MIDI' });
  // 小節の頭ごとに拍子・テンポ・調を当てはめながら、最後の音まで小節を並べる
  const ms = [];
  let t = 0, cur = { beats: time0.beats, beatType: time0.beatType };
  while (t < lastEnd || !ms.length) {
    const ts = times.filter(x => x.t <= t).pop();
    const m = {};
    if (ts && (ts.beats !== cur.beats || ts.beatType !== cur.beatType)) { cur = { beats: ts.beats, beatType: ts.beatType }; m.time = { ...cur }; }
    ms.push(m);
    const len = measureTicks(cur);
    const tp = tempos.filter(x => x.t >= t && x.t < t + len)[0];
    if (tp && ms.length > 1) m.tempo = { bpm: tp.bpm };
    const ky = keys.filter(x => x.t > 0 && x.t >= t && x.t < t + len)[0];
    if (ky) m.key = { fifths: ky.fifths };
    t += len;
    if (ms.length > 2000) break;
  }
  Object.assign(ms[0], score.measures[0], ms[0]);
  delete ms[0].barline;
  ms[ms.length - 1].barline = 'final';
  score.measures = ms;
  for (const part of score.parts) for (const st of part.staves) st.measures = [];
  // fillMeasures の代わり（createScore の中身を作り直す）
  const A0 = measureAttrs(score);
  for (const part of score.parts) for (const st of part.staves) st.measures = A0.map(a => ({ voices: [[measureRest(a.len)]] }));
  const A = measureAttrs(score);
  parts.forEach((g, p) => {
    const part = score.parts[p];
    part.name = g.name && g.name.trim() ? g.name.trim() : part.name;
    if (g.program != null && insts[p].id !== 'drumset') part.program = g.program;
    let notes = quantize(g.notes, { grid, triplets });
    const drum = insts[p].id === 'drumset';
    const staffNotes = part.staves.map(() => []);
    for (const n of notes) {
      const pitch = drum ? drumPitch(drumForGm(n.midi)) : spellMidi(n.midi, A[Math.min(absToLoc(A, n.start).m, A.length - 1)].fifths);
      const s = part.staves.length > 1 && !part.staves[1].tabOf && n.midi < split ? 1 : 0;
      staffNotes[s].push({ ...n, pitch });
    }
    staffNotes.forEach((list, s) => {
      if (!list.length) return;
      if (drum) {
        // ドラムは長さを気にしない（次の音まで）。手（シンバル・太鼓）は声部1で符尾上、足（バスドラ・ペダル）は声部2で下
        list = list.map(n => ({ ...n, end: n.start + TPQ }));
        const feet = (n) => n.pitch.drum === 'kick' || n.pitch.drum === 'hhp';
        writeStream(score, p, s, 0, splitVoices(list.filter(n => !feet(n)), { minLong: Infinity })[0], { from: 0 });
        const low = splitVoices(list.filter(feet), { minLong: Infinity })[0];
        if (low.length) writeStream(score, p, s, 1, low);
        return;
      }
      const [v1, v2] = splitVoices(list, { minLong: TPQ });
      writeStream(score, p, s, 0, v1, { from: 0 });
      if (v2.length) writeStream(score, p, s, 1, v2);
    });
  });
  return score;
}

// GM 音色番号 → KANADE の楽器（同じ音色がなければ近い系統）
function pickInst(g) {
  if (g.ch === 9) return INST.drumset || INST.piano;
  const prog = g.program ?? 0;
  const exact = INSTRUMENTS.find(i => i.program === prog && !i.trans);
  if (exact) return exact;
  const any = INSTRUMENTS.find(i => i.program === prog);
  if (any) return any;
  const fam = Math.floor(prog / 8);
  return INSTRUMENTS.find(i => Math.floor(i.program / 8) === fam && i.id !== 'drumset') || INST.piano;
}
