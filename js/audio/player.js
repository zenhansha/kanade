// 再生：楽譜を「何秒に・どの音を・何秒間・どの強さで」のリストにして、少し先読みしながら鳴らす
//
// Phase 2 で反映するもの
//   ・反復記号・カッコ・D.C./D.S./Coda/Fine の順番（marks.js の playOrder）
//   ・強弱記号と松葉（だんだん強く/弱く）、sf などの一瞬のアクセント
//   ・スタッカート（短く）・テヌート・アクセント・マルカート、フェルマータ（全体の時間を止める）
//   ・8va / 15ma（オクターブ上げて鳴らす）、ペダル（離すまで音を伸ばす）
//   ・装飾音符（拍の直前に短く）、トリル・モルデント・ターン
import { TPQ, midiOf, keyAlter, fromDiatonic, diatonic } from '../core/music.js';
import { measureAttrs, INST } from '../core/score.js';
import { positions } from '../core/edit.js';
import { playOrder, DYNAMICS, SPANS, spanEnd } from '../core/marks.js';

const DEFAULT_VEL = 0.7;

export function buildPerformance(score) {
  const A = measureAttrs(score);
  const order = playOrder(score);
  const absT = (m, t) => A[m].start + t;

  // ── フェルマータ：その音の長さのぶん、全パートの時間を止める ──
  const pauses = A.map(() => []);
  forEachEvent(score, (ev, x, m) => {
    if (!ev.art || !ev.art.includes('ferm')) return;
    const add = ((x.end - x.start) / TPQ) * (60 / A[m].bpm);
    const ex = pauses[m].find(p => p.t === x.end);
    if (ex) ex.add = Math.max(ex.add, add); else pauses[m].push({ t: x.end, add });
  });
  const pauseUpTo = (m, t) => pauses[m].reduce((a, p) => a + (p.t <= t ? p.add : 0), 0);
  const seqStart = [];
  let sec = 0;
  order.forEach((m, i) => { seqStart[i] = sec; sec += (A[m].len / TPQ) * (60 / A[m].bpm) + pauseUpTo(m, A[m].len); });
  const total = sec;
  const tickToSec = (i, t) => seqStart[i] + (t / TPQ) * (60 / A[order[i]].bpm) + pauseUpTo(order[i], t);
  // 小節をまたぐ長さ（ペダル・タイ）用：i 番目の小節から楽譜どおり進んだとして m2 の t2 は何秒か
  const secAhead = (i, m2, t2) => {
    let j = i;
    while (j + 1 < order.length && order[j] < m2 && order[j + 1] === order[j] + 1) j++;
    return order[j] === m2 ? tickToSec(j, t2) : tickToSec(j, A[order[j]].len);
  };

  const notes = [];
  score.parts.forEach((part, p) => {
    const inst = INST[part.inst] || {};
    const oct = inst.oct || 0;
    // 強弱は譜表ごと。強弱記号がない譜表（ピアノの左手など）は1段目のものを使う
    const curves = part.staves.map(st => dynamicCurve(st, A, absT));
    const hasDyn = part.staves.map(st => st.measures.some(sm => sm.dirs?.some(d => d.k === 'dyn')) || st.measures.some(sm => sm.spans?.some(sp => sp.k === 'cresc' || sp.k === 'dim')));
    part.staves.forEach((st, s) => {
      const curve = hasDyn[s] ? curves[s] : curves[0];
      const shifts = [], peds = [], trills = [];
      st.measures.forEach((sm, m) => (sm.spans || []).forEach(sp => {
        const e = spanEnd(m, sp);
        if (e.m >= A.length) return;
        const endEv = eventAt(st, e.m, sp.v, e.t);
        const item = { a: absT(m, sp.t), b: absT(e.m, endEv ? endEv.end : e.t + TPQ), m, e: { m: e.m, t: endEv ? endEv.end : e.t + TPQ } };
        if (SPANS[sp.k]?.shift) shifts.push({ ...item, shift: SPANS[sp.k].shift });
        if (sp.k === 'ped') peds.push(item);
        if (sp.k === 'trill') trills.push(item);
      }));
      const inSpan = (list, at) => list.find(x => at >= x.a && at < x.b);
      const maxV = Math.max(...st.measures.map(sm => sm.voices.length));
      for (let v = 0; v < maxV; v++) {
        let pending = new Map(); // midi → 伸ばし中の音（タイ）
        order.forEach((m, i) => {
          if (i > 0 && order[i - 1] !== m - 1) pending = new Map();
          const voice = st.measures[m].voices[v];
          if (!voice) { pending = new Map(); return; }
          const fifths = A[m].fifths;
          for (const x of positions(voice)) {
            const ev = x.ev;
            const start = tickToSec(i, x.start), end = tickToSec(i, x.end);
            const next = new Map();
            if (!ev.rest) {
              const at = absT(m, x.start);
              const art = ev.art || [];
              const shift = inSpan(shifts, at)?.shift || 0;
              const ped = inSpan(peds, at);
              let vel = curve.velAt(at) + curve.accentAt(at);
              if (art.includes('acc')) vel += 0.14;
              if (art.includes('marc')) vel += 0.2;
              vel = Math.max(0.08, Math.min(1, vel));
              let len = end - start;
              if (art.includes('stacc')) len *= 0.5;
              else if (art.includes('staccss')) len *= 0.3;
              else if (art.includes('marc')) len *= 0.75;
              else if (!art.includes('ten')) len -= Math.min(0.03, len * 0.08);
              // 装飾音：拍の直前に短く
              if (ev.grace) {
                const gd = Math.min(0.075, (end - start) / 3);
                ev.grace.forEach((g, gi) => g.notes.forEach(n => notes.push({
                  start: Math.max(0, start - (ev.grace.length - gi) * gd), end: Math.max(0, start - (ev.grace.length - gi - 1) * gd) - 0.005,
                  midi: midiOf(n) + oct + shift, program: part.program, sf: inst.sf, vel: vel * 0.85, p, s, v, m, t: x.start, id: ev.id, ids: [ev.id],
                })));
              }
              const orn = art.includes('tr') || inSpan(trills, at) ? 'tr' : art.includes('mord') ? 'mord' : art.includes('prall') ? 'prall' : art.includes('turn') ? 'turn' : null;
              for (const n of ev.notes) {
                const midi = midiOf(n) + oct + shift;
                let nn = pending.get(midi);
                if (nn) { nn.end = Math.max(nn.end, start + len); nn.ids.push(ev.id); }
                else if (orn && n === ev.notes[ev.notes.length - 1]) {
                  ornament(notes, orn, n, fifths, { start, end: start + len, oct: oct + shift, program: part.program, sf: inst.sf, vel, p, s, v, m, t: x.start, id: ev.id });
                } else {
                  nn = { start, end: start + len, midi, program: part.program, sf: inst.sf, vel, p, s, v, m, t: x.start, id: ev.id, ids: [ev.id] };
                  notes.push(nn);
                }
                if (nn && ped) nn.end = Math.max(nn.end, secAhead(i, ped.e.m, ped.e.t) - 0.02);
                if (nn && n.tie) next.set(midi, nn);
              }
            }
            pending = next;
          }
        });
      }
    });
  });
  notes.sort((a, b) => a.start - b.start);
  // 再生カーソル用：秒 → (小節, ティック)
  const secToPos = (x) => {
    let i = 0;
    while (i + 1 < order.length && seqStart[i + 1] <= x) i++;
    const m = order[i] ?? 0;
    const t = ((x - seqStart[i]) * A[m].bpm * TPQ) / 60;
    return { m, t: Math.max(0, Math.min(t, A[m].len)) };
  };
  // m 小節目から再生するときの開始秒（反復で何度も出てくる小節なら最初の1回）
  const secOfMeasure = (m) => {
    let i = order.indexOf(m);
    if (i < 0) i = order.findIndex(x => x >= m);
    return i < 0 ? total : seqStart[i];
  };
  return { notes, total, order, seqStart, tickToSec, secToPos, secOfMeasure, attrs: A };
}

function forEachEvent(score, fn) {
  for (const part of score.parts) for (const st of part.staves) st.measures.forEach((sm, m) => sm.voices.forEach(v => v && positions(v).forEach(x => fn(x.ev, x, m))));
}
function eventAt(st, m, v, t) {
  const sm = st.measures[m];
  if (!sm) return null;
  return positions(sm.voices[v] || sm.voices[0]).find(x => x.start === t) || null;
}

// 強弱のカーブ：強弱記号の位置で段差、松葉の区間はなめらかに変える
function dynamicCurve(st, A, absT) {
  const pts = [];          // { at, vel, from? }（from があれば from〜at を直線で変化）
  const accents = new Map();
  st.measures.forEach((sm, m) => (sm.dirs || []).forEach(d => {
    if (d.k !== 'dyn' || !DYNAMICS[d.v]) return;
    const D = DYNAMICS[d.v];
    const at = absT(m, d.t);
    if (D.vel != null) pts.push({ at, vel: D.vel });
    if (D.accent) accents.set(at, D.accent - (D.vel ?? 0));
  }));
  pts.sort((a, b) => a.at - b.at);
  const base = (at) => { let v = DEFAULT_VEL; for (const q of pts) { if (q.at <= at) v = q.vel; else break; } return v; };
  const hairs = [];
  st.measures.forEach((sm, m) => (sm.spans || []).forEach(sp => {
    if (sp.k !== 'cresc' && sp.k !== 'dim') return;
    const e = spanEnd(m, sp);
    if (e.m >= A.length) return;
    const endEv = eventAt(st, e.m, sp.v, e.t);
    hairs.push({ a: absT(m, sp.t), b: absT(e.m, endEv ? endEv.end : e.t + TPQ), up: sp.k === 'cresc' });
  }));
  for (const h of hairs) {
    const from = base(h.a);
    // 終わりのすぐ後（1拍以内）に強弱記号があればそこへ、なければ一段階ぶん変える
    const tgt = pts.find(q => q.at >= h.b - 1 && q.at <= h.b + TPQ);
    const to = tgt ? tgt.vel : Math.max(0.15, Math.min(1, from + (h.up ? 0.2 : -0.2)));
    h.from = from; h.to = to;
    if (!tgt) pts.push({ at: h.b, vel: to });
  }
  pts.sort((a, b) => a.at - b.at);
  return {
    velAt(at) {
      const h = hairs.find(x => at >= x.a && at < x.b);
      if (h) return h.from + (h.to - h.from) * ((at - h.a) / Math.max(1, h.b - h.a));
      return base(at);
    },
    accentAt(at) { return accents.get(at) || 0; },
  };
}

// トリル・モルデント・ターンを細かい音に分けて鳴らす（上の音は調号に合わせる）
function ornament(notes, kind, n, fifths, o) {
  const dn = diatonic(n);
  const nb = (d) => { const q = fromDiatonic(dn + d); q.alter = keyAlter(fifths, q.step); return midiOf(q) + o.oct; };
  const main = midiOf(n) + o.oct, up = nb(1), down = nb(-1);
  const seq = [];
  const step = 0.07;
  if (kind === 'tr') {
    let t = o.start, k = 0;
    while (t < o.end - step * 0.5) { seq.push({ midi: k % 2 ? up : main, start: t, end: Math.min(o.end, t + step) }); t += step; k++; }
  } else {
    const head = kind === 'mord' ? [main, down] : kind === 'prall' ? [main, up] : [up, main, down];
    head.forEach((mm, i) => seq.push({ midi: mm, start: o.start + i * step, end: o.start + (i + 1) * step }));
    seq.push({ midi: main, start: o.start + head.length * step, end: Math.max(o.end, o.start + (head.length + 1) * step) });
  }
  for (const q of seq) notes.push({ ...o, start: q.start, end: q.end - 0.005, midi: q.midi, ids: [o.id], oct: undefined });
}

export class Player {
  constructor(synth) {
    this.synth = synth;
    this.playing = false;
    this.onTick = null;
    this.onStop = null;
  }

  async start(score, fromMeasure = 0) {
    this.stop(true);
    const ctx = this.synth.ensure();
    const perf = buildPerformance(score);
    this.perf = perf;
    // 使われている楽器の高音質サンプルを読み込み（初回だけ少し待つ。最大1.5秒）
    const sfs = [...new Set(score.parts.map(p => (INST[p.inst] || {}).sf).filter(Boolean))];
    const loads = Promise.all(sfs.map(s => this.synth.loadSamples(s)));
    await Promise.race([loads, new Promise(r => setTimeout(r, 1500))]);
    const fromSec = perf.secOfMeasure(fromMeasure);
    this.fromSec = fromSec;
    this.t0 = ctx.currentTime + 0.12;
    this.idx = perf.notes.findIndex(n => n.start >= fromSec - 1e-6);
    if (this.idx < 0) this.idx = perf.notes.length;
    this.playing = true;
    this.timer = setInterval(() => this.pump(), 25);
    this.pump();
    const frame = () => {
      if (!this.playing) return;
      const pos = this.position();
      if (pos > perf.total + 0.3) { this.stop(); return; }
      if (this.onTick) this.onTick(perf.secToPos(Math.min(pos, perf.total - 1e-6)), pos);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  position() { return this.synth.now - this.t0 + this.fromSec; }

  pump() {
    const perf = this.perf;
    const horizon = this.position() + 0.25;
    while (this.idx < perf.notes.length && perf.notes[this.idx].start < horizon) {
      const n = perf.notes[this.idx++];
      const when = this.t0 + (n.start - this.fromSec);
      this.synth.play({ midi: n.midi, program: n.program, sf: n.sf, when, dur: Math.max(0.04, n.end - n.start), vel: n.vel ?? DEFAULT_VEL });
    }
  }

  stop(silent = false) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    this.synth.stopAll();
    if (this.onStop) this.onStop();
    void silent;
  }
}
