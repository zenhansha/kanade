// 再生：楽譜を「何秒に・どの音を・何秒間」のリストにして、少し先読みしながら鳴らす
import { TPQ, midiOf } from '../core/music.js';
import { measureAttrs, evTicks, INST } from '../core/score.js';

// 楽譜 → 演奏リスト。タイでつながった音は1つの長い音にまとめる
export function buildPerformance(score) {
  const A = measureAttrs(score);
  // テンポ表：小節ごとの開始秒
  const secAt = [];
  let sec = 0;
  A.forEach((a, m) => { secAt[m] = sec; sec += (a.len / TPQ) * (60 / a.bpm); });
  const total = sec;
  const tickToSec = (m, t) => secAt[m] + (t / TPQ) * (60 / A[m].bpm);
  const notes = [];
  score.parts.forEach((part, p) => {
    const inst = INST[part.inst] || {};
    const oct = inst.oct || 0;
    part.staves.forEach((st, s) => {
      const maxV = Math.max(...st.measures.map(sm => sm.voices.length));
      for (let v = 0; v < maxV; v++) {
        let pending = new Map(); // midi → 伸ばし中の音（タイ）
        st.measures.forEach((sm, m) => {
          const voice = sm.voices[v];
          if (!voice) { pending = new Map(); return; }
          let t = 0;
          for (const ev of voice) {
            const d = evTicks(ev);
            const start = tickToSec(m, t), end = tickToSec(m, t + d);
            const next = new Map();
            if (!ev.rest) {
              for (const n of ev.notes) {
                const midi = midiOf(n) + oct;
                let nn = pending.get(midi);
                if (nn) nn.end = end;
                else { nn = { start, end, midi, program: part.program, sf: inst.sf, p, s, v, m, t, id: ev.id, ids: [] }; notes.push(nn); }
                nn.ids.push(ev.id);
                if (n.tie) next.set(midi, nn);
              }
            }
            pending = next;
            t += d;
          }
        });
      }
    });
  });
  notes.sort((a, b) => a.start - b.start);
  // 再生カーソル用：秒 → (小節, ティック)
  const secToPos = (x) => {
    let m = 0;
    while (m + 1 < A.length && secAt[m + 1] <= x) m++;
    const t = ((x - secAt[m]) * A[m].bpm * TPQ) / 60;
    return { m, t: Math.min(t, A[m].len) };
  };
  return { notes, total, secAt, tickToSec, secToPos, attrs: A };
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
    const fromSec = perf.secAt[Math.min(fromMeasure, perf.secAt.length - 1)] || 0;
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
      this.synth.play({ midi: n.midi, program: n.program, sf: n.sf, when, dur: Math.max(0.05, n.end - n.start - 0.01), vel: 0.75 });
    }
  }

  stop(silent = false) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    this.synth.stopAll();
    if (!silent && this.onStop) this.onStop();
    else if (silent && this.onStop) this.onStop();
  }
}
