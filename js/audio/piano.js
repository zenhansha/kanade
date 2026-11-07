// ピアノの録音（Salamander Grand Piano：ヤマハ C5。作者 Alexander Holm、CC BY 3.0）
//   ・強さごとの録音（6段階）：弱く弾くとやわらかく、強く弾くと硬く明るい音になる
//   ・3半音おきの録音を、再生速度で ±1 半音ずらして 88 鍵すべてに使う
//   ・最初は「ふつうの強さ」だけ読み込み、ほかの強さは必要になったものから読む（メモリの節約）
import { PIANO } from './pianodata.js';

const BASE = 'sounds/piano/';
export const PIANO_SF = 'acoustic_grand_piano';
export const NO_DAMPER = 89;   // F6 から上の弦にはダンパーがない（指を離しても鳴り続ける）
export const PIANO_TRIM = 1;   // ほかの楽器（GM 音源）と音量をそろえる（dB）
const LAYER_TOP = [26, 46, 64, 90, 112, 127]; // この強さ（1〜127）までを、その録音で鳴らす
const BASE_LAYER = 3;
const MAX_JOBS = 4;

// どの録音を使うか。vel は 0〜1
export function pianoPick(midi, vel) {
  const v = Math.max(1, Math.min(127, vel * 127));
  return { v, point: Math.max(0, Math.min(PIANO.midi.length - 1, Math.round((midi - 21) / 3))), layer: LAYER_TOP.findIndex(t => v <= t) };
}
export function pianoRate(midi, point) { return Math.pow(2, (midi - PIANO.midi[point]) / 12); }

// 音量：録音どうしの音量差（layerDb）を強さに合わせてなめらかにつなぐ。
// 録音のままだと pp と ff の差が小さいので、強さに応じて少し広げる（元の SFZ の amp_veltrack と同じ考え方）
export function pianoGain(v, layer) {
  const c = PIANO.center, L = PIANO.layerDb;
  let i = 0;
  while (i < c.length - 2 && v > c[i + 1]) i++;
  const natural = L[i] + ((L[i + 1] - L[i]) * (v - c[i])) / (c[i + 1] - c[i]);
  const wider = 20 * Math.log10(0.35 + 0.65 * (v / 127) ** 2);
  return Math.pow(10, (natural + wider - L[layer] - PIANO.headroom + PIANO_TRIM) / 20);
}
// 指を離したときに音が消える速さ（時定数・秒）。低い弦ほどゆっくり止まる
export function damperTau(midi) { return 0.16 - (0.115 * Math.max(0, Math.min(67, midi - 21))) / 67; }

// 音の始まりの位置（秒）。MP3 は先頭に少し無音が入るので、そのぶんを飛ばす（押してから鳴るまでの遅れをなくす）
export function findOnset(buf) {
  const n = Math.min(buf.length, Math.floor(buf.sampleRate * 0.4));
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(a[i]), Math.abs(b[i]));
  const th = peak * 0.02;
  const cap = Math.floor(buf.sampleRate * 0.12);
  for (let i = 0; i < Math.min(n, cap); i++) if (Math.abs(a[i]) > th || Math.abs(b[i]) > th) return Math.max(0, i - 16) / buf.sampleRate;
  return 0;
}

export class PianoBank {
  constructor() {
    this.bufs = new Map();  // ファイル名 → { buf, onset }
    this.jobs = new Map();  // ファイル名 → 読み込み中の Promise
    this.queue = [];
    this.running = 0;
    this.base = null;
    this.failedAt = 0;
  }
  get ready() { return this.bufs.size >= PIANO.names.length; }
  name(point, layer) { return PIANO.names[point] + 'v' + PIANO.layers[layer]; }
  get(file) { return this.bufs.get(file) || null; }

  load(ctx, file) {
    if (this.bufs.has(file)) return Promise.resolve(true);
    if (this.jobs.has(file)) return this.jobs.get(file);
    const job = new Promise((done) => {
      this.queue.push(async () => {
        let ok = false;
        try {
          const res = await fetch(BASE + file + '.mp3');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.arrayBuffer();
          const buf = await new Promise((yes, no) => ctx.decodeAudioData(data, yes, no));
          this.bufs.set(file, { buf, onset: findOnset(buf) });
          ok = true;
        } catch (e) { this.failedAt = performance.now(); console.warn('ピアノの音を読み込めませんでした', file, e); }
        this.jobs.delete(file);
        this.running--;
        this.next();
        done(ok);
      });
      this.next();
    });
    this.jobs.set(file, job);
    return job;
  }
  next() { while (this.running < MAX_JOBS && this.queue.length) { this.running++; this.queue.shift()(); } }

  // まず「ふつうの強さ」を全部の高さで読む。読めたら、指を離す音とペダルの音も読んでおく
  ensureBase(ctx) {
    if (this.base) return this.base;
    this.base = Promise.all(PIANO.names.map((_, p) => this.load(ctx, this.name(p, BASE_LAYER)))).then((r) => {
      const ok = r.filter(Boolean).length >= PIANO.names.length - 2;
      if (ok) this.extras(ctx); else this.base = null;
      return ok;
    });
    return this.base;
  }
  extras(ctx) {
    if (!this.extraJob) this.extraJob = Promise.all([...PIANO.names.map(n => 'rel' + n), 'pedalD1', 'pedalD2', 'pedalU1', 'pedalU2'].map(f => this.load(ctx, f)));
    return this.extraJob;
  }
  // 足りない録音を裏で読む（失敗したばかりのときは、しばらく試さない）
  want(ctx, point, layer) {
    if (performance.now() - this.failedAt < 30000) return;
    this.load(ctx, this.name(point, layer));
  }
  // 曲で使う高さ・強さの録音を読む
  ensureNotes(ctx, notes) {
    const files = new Set();
    for (const n of notes) {
      if (n.sf !== PIANO_SF || n.drum) continue;
      const w = pianoPick(n.midi, n.vel ?? 0.7);
      files.add(this.name(w.point, w.layer));
    }
    return Promise.all([...files].map(f => this.load(ctx, f)));
  }
  // いちばん近い読み込み済みの録音（同じ高さの近い強さ → 隣の高さ）
  nearest(point, layer) {
    const hit = (p, j) => {
      if (p < 0 || p >= PIANO.names.length || j < 0 || j >= PIANO.layers.length) return null;
      const s = this.bufs.get(this.name(p, j));
      return s ? { ...s, point: p, layer: j } : null;
    };
    for (let dp = 0; dp <= 2; dp++) {
      for (let dj = 0; dj < PIANO.layers.length; dj++) {
        for (const p of dp ? [point - dp, point + dp] : [point]) {
          for (const j of dj ? [layer + dj, layer - dj] : [layer]) {
            const s = hit(p, j);
            if (s) return s;
          }
        }
      }
    }
    return null;
  }
}
