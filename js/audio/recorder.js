// リアルタイム入力（Finale の HyperScribe に相当、Phase 3）
//
// メトロノーム（とほかのパートの伴奏）に合わせて MIDI キーボードや画面鍵盤を弾くと、
// 音をクオンタイズ（16分・3連などのマス目にそろえる）して楽譜に書き込む。
// 指を離して長さが決まった音から順に楽譜に出していき、止めたところで全部をまとめて書き直す。
//   ・ピアノのように2段ある楽器は、分割点（初期値：真ん中のド）で右手・左手に分ける
//   ・同時に押さえた音は和音、長く伸ばした音は声部2に
//   ・聞こえる音の遅れ（出力レイテンシ）のぶんは差し引いて合わせる
import { TPQ, spellMidi } from '../core/music.js';
import { measureAttrs } from '../core/score.js';
import { quantize, splitVoices, writeStream, absToLoc } from '../core/stream.js';
import { drumForGm, drumPitch } from '../core/perc.js';

export class Recorder {
  constructor(app) {
    this.app = app;
    this.active = false;
  }

  // o: { p, s（-1 = 2段とも）, m, grid, triplets, countIn, playOthers, tempoScale, split }
  async start(o) {
    const app = this.app;
    this.o = o;
    this.notes = [];
    this.open = new Map();
    this.active = true;
    const part = app.score.parts[o.p];
    // 録音前の楽譜：途中経過を書き込むので、止めたらここへ戻してから書き直す（「元に戻す」1回で録音前に戻れるように）
    this.base = JSON.stringify(app.score);
    this.A = measureAttrs(app.score);
    this.shown = false;
    // 録音する譜表（TAB は除く）
    this.staves = o.s >= 0 ? [o.s] : part.staves.map((st, s) => (st.tabOf == null ? s : -1)).filter(s => s >= 0);
    const target = new Set(this.staves.map(s => o.p + ':' + s));
    await app.player.start(app.score, o.m, {
      click: true, countIn: o.countIn, linear: true, tempoScale: o.tempoScale, keepGoing: true,
      filter: (n) => o.playOthers && !target.has(n.p + ':' + n.s),
    });
    this.perf = app.player.perf;
  }

  // performance.now() の時刻 → 演奏の秒（再生の時計に合わせ、聞こえる遅れを引く）
  secAt(stamp) {
    const ctx = this.app.synth.ctx;
    // getOutputTimestamp は「いまスピーカーから出ている音の時刻」なので、聞こえる遅れはもう含まれている。
    // 使えないブラウザでは currentTime（これから鳴らす時刻）から遅れのぶんを引く
    let t = null;
    if (stamp != null && ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.performanceTime) t = ts.contextTime + (stamp - ts.performanceTime) / 1000;
    }
    if (t == null) t = ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0) - (stamp != null ? (performance.now() - stamp) / 1000 : 0);
    return t - this.app.player.t0 + this.app.player.fromSec;
  }
  noteOn(midi, vel = 90, stamp = performance.now()) {
    if (!this.active) return;
    if (this.open.has(midi)) this.noteOff(midi, stamp);
    this.open.set(midi, { sec: this.secAt(stamp), vel });
  }
  noteOff(midi, stamp = performance.now()) {
    const n = this.open.get(midi);
    if (!n) return;
    this.open.delete(midi);
    this.notes.push({ a: n.sec, b: Math.max(n.sec + 0.03, this.secAt(stamp)), midi, vel: n.vel });
    this.scheduleShow();
  }
  // 確定した音を楽譜に出す。書き直しは重いので、かかった時間に合わせて間引く（弾くのをじゃましない）
  scheduleShow() {
    if (this.showT || !this.active) return;
    this.showT = setTimeout(() => {
      this.showT = null;
      if (!this.active || !this.perf) return;
      try {
        const raw = this.rawNotes();
        if (!raw.length) return;
        this.writeNotes(raw);
        this.shown = true;
        this.app.relayout();
      } catch (e) { console.warn('途中経過の表示に失敗', e); }
    }, Math.max(100, (this.app.layoutMs || 0) * 5));
  }
  // いまの位置（小節）：画面の表示用
  where() { const p = this.perf.secToPos(Math.max(0, this.app.player.position())); return p.m; }

  // 止めて楽譜に書き込む。戻り値：書き込んだ音の数
  stop() {
    if (!this.active) return 0;
    const app = this.app;
    const now = performance.now();
    for (const m of [...this.open.keys()]) this.noteOff(m, now);
    this.active = false;
    clearTimeout(this.showT); this.showT = null;
    app.player.stop();
    const raw = this.rawNotes();
    if (this.shown) { app.score = JSON.parse(this.base); this.shown = false; }
    if (!raw.length) { app.relayout(); return 0; }
    app.edit('リアルタイム入力', () => this.writeNotes(raw));
    return raw.length;
  }

  // 録音した音（秒）→ 楽譜の先頭からのティック
  rawNotes() {
    const o = this.o, perf = this.perf, A = this.A;
    // 秒 → 楽譜の先頭からのティック（最後の小節を過ぎたら、そのテンポのまま続いているとみなす）
    const last = A.length - 1;
    const toTick = (sec) => {
      const start0 = A[o.m].start;
      if (sec <= perf.seqStart[o.m]) return start0;
      if (sec >= perf.total) return A[last].start + A[last].len + ((sec - perf.total) * A[last].bpm * perf.scale / 60) * TPQ;
      const pos = perf.secToPos(sec);
      return A[pos.m].start + pos.t;
    };
    return this.notes.map(n => ({ start: toTick(n.a), end: toTick(n.b), midi: n.midi, vel: n.vel })).filter(n => n.end > n.start);
  }

  // 楽譜に書き込む（クオンタイズ → 右手・左手 → 声部）
  writeNotes(raw) {
    const app = this.app, o = this.o;
    const q = quantize(raw, { grid: o.grid, triplets: o.triplets });
    const from = this.A[o.m].start;
    const part = app.score.parts[o.p];
    const perc = part.staves[this.staves[0]].clef === 'percussion';
    const split = o.split ?? 60;
    const lastEnd = Math.max(...q.map(n => n.end));
    let A2 = measureAttrs(app.score);
    const endLoc = absToLoc(A2, lastEnd - 1);
    // 最後の音が入っている小節の終わりまでを書き換える
    const to = endLoc.m < A2.length ? A2[endLoc.m].start + A2[endLoc.m].len : lastEnd + TPQ * 4;
    this.staves.forEach((s, k) => {
      const mine = q.filter(n => this.staves.length < 2 || (k === 0 ? n.midi >= split : n.midi < split)).map(n => {
        const fifths = A2[Math.min(absToLoc(A2, n.start).m, A2.length - 1)].fifths;
        return { ...n, pitch: perc ? drumPitch(drumForGm(n.midi)) : spellMidi(n.midi, fifths) };
      });
      const list = perc ? mine.map(n => ({ ...n, end: n.start + TPQ })) : mine;
      const [v1, v2] = splitVoices(list, { minLong: perc ? Infinity : TPQ });
      writeStream(app.score, o.p, s, 0, v1, { from, to });
      writeStream(app.score, o.p, s, 1, v2, { from, to });
      A2 = measureAttrs(app.score);
    });
  }
}
