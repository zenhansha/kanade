// 音源：Web Audio で鳴らす
//   ・まずは内蔵シンセ（倍音を組み合わせた簡易音色。オフラインでも必ず鳴る）
//   ・ネットにつながっていれば、楽器ごとの高音質サンプル（FluidR3 GM、MIT ライセンス）を
//     自動で取得してキャッシュし、以後はそちらで鳴らす
//   ・ピアノだけは、強さごとに録音した専用の音源（piano.js）で鳴らす
import { PIANO_SF, PIANO_TRIM, NO_DAMPER, PianoBank, pianoPick, pianoRate, pianoGain, damperTau, findOnset } from './piano.js';
import { ROOMS, reverbIR, resonanceIR } from './room.js';
import { PIANO } from './pianodata.js';

const SF_BASE = 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/';
const SF_BASE2 = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/'; // CDN が断る楽器（オルガン・合唱など）はこちらから
const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PIANO_NAMES = PIANO.names;

// 音色ファミリーごとの倍音構成とエンベロープ
function family(program) {
  if (program < 8) return 'piano';
  if (program < 16) return 'mallet';
  if (program < 24) return 'organ';
  if (program < 32) return 'guitar';
  if (program < 40) return 'bass';
  if (program < 52) return 'strings';
  if (program < 56) return 'choir';
  if (program < 64) return 'brass';
  if (program < 72) return 'reed';
  return 'pipe';
}
const TIMBRE = {
  piano: { h: [1, 0.55, 0.32, 0.18, 0.12, 0.07, 0.05, 0.03], a: 0.004, d: 2.6, s: 0.0, r: 0.35, lp: 5200, decay: true },
  mallet: { h: [1, 0, 0.12, 0, 0.05], a: 0.002, d: 0.9, s: 0, r: 0.3, lp: 7000, decay: true },
  organ: { h: [1, 0.7, 0.45, 0.3, 0.2, 0.1, 0.1, 0.05], a: 0.02, d: 0.1, s: 0.85, r: 0.08, lp: 6000 },
  guitar: { h: [1, 0.6, 0.35, 0.22, 0.1, 0.05], a: 0.003, d: 1.1, s: 0, r: 0.25, lp: 3800, decay: true },
  bass: { h: [1, 0.5, 0.2, 0.1], a: 0.005, d: 1.2, s: 0.15, r: 0.15, lp: 1800, decay: true },
  strings: { h: [1, 0.5, 0.33, 0.25, 0.2, 0.16, 0.13, 0.1], a: 0.09, d: 0.2, s: 0.8, r: 0.25, lp: 4200 },
  choir: { h: [1, 0.35, 0.12, 0.05], a: 0.12, d: 0.2, s: 0.8, r: 0.3, lp: 3000 },
  brass: { h: [1, 0.75, 0.55, 0.42, 0.3, 0.2, 0.12], a: 0.04, d: 0.15, s: 0.8, r: 0.12, lp: 3600 },
  reed: { h: [1, 0.1, 0.55, 0.08, 0.35, 0.05, 0.2], a: 0.03, d: 0.15, s: 0.8, r: 0.1, lp: 4200 },
  pipe: { h: [1, 0.25, 0.08, 0.03], a: 0.05, d: 0.1, s: 0.85, r: 0.12, lp: 6000 },
};

// なめらかな頭打ち（割れ止め）。先読みがないので、聞こえる遅れを増やさない。小さい音にはまったく触らない
function softClipCurve() {
  const n = 8193, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = ((i / (n - 1)) * 2 - 1) * 2, a = Math.abs(s); // 入口で半分にしているので、±2 までを受ける
    c[i] = Math.sign(s) * (a < 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
  }
  return c;
}
const RES_LEVEL = 0.028;  // ペダルの共鳴の大きさ
const SAMPLE_GAIN = 3.4;  // GM 音源の録音はとても小さい（-26 dB ほど）ので、ピアノやドラムとそろえる
const MAX_PIANO = 90;   // 同時に鳴らすピアノの音の数（超えたら古い音から静かに止める）

export class Synth {
  // opts.ctx = 書き出し用の OfflineAudioContext、opts.samplesFrom = 読み込み済みのサンプルを借りる Synth
  constructor(opts = {}) {
    this.ctx = null;
    this.waves = {};
    this.samples = opts.samplesFrom ? opts.samplesFrom.samples : {};      // sfName → { midi: AudioBuffer }
    this.piano = opts.samplesFrom ? opts.samplesFrom.piano : new PianoBank();
    this.loading = {};
    this.useSamples = opts.samplesFrom ? opts.samplesFrom.useSamples : true;
    this.reverb = opts.samplesFrom ? opts.samplesFrom.reverb : 'hall';
    this.keys = new Map();      // 鍵盤ごとの、いま鳴っているピアノの音
    this.held = new Map();      // 押さえている鍵（MIDI キーボード・画面鍵盤）
    this.sustained = new Set(); // ペダルで伸ばしている音
    this.sustain = false;
    this.voices = new Set();
    this.channels = new Map(); // パートごとの音量・左右（ミキサー）
    this.offline = !!opts.ctx;
    if (opts.ctx) this.setup(opts.ctx);
  }
  setup(ctx) {
    this.ctx = ctx;
    // 出口：なめらかな頭打ちだけ（先読みなし）
    this.clip = ctx.createGain();
    this.clip.gain.value = 0.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve();
    this.clip.connect(shaper).connect(ctx.destination);
    // 再生の通り道：楽器がたくさん重なったときだけ軽く抑える。
    // コンプレッサーは 6ms 先読みするので、弾いた音の通り道（live）には入れない
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -9; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    comp.connect(this.clip);
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(comp);
    this.live = ctx.createGain();
    this.live.gain.value = 0.7;
    this.live.connect(this.clip);
    this.clickOut = ctx.createGain();
    this.clickOut.gain.value = 0.7;
    this.clickOut.connect(this.clip);
    // 部屋の響き（低い音は濁るので入れない）
    this.verbIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 110;
    this.conv = ctx.createConvolver();
    this.verbOut = ctx.createGain();
    this.master.connect(this.verbIn); this.live.connect(this.verbIn);
    this.verbIn.connect(hp).connect(this.conv).connect(this.verbOut).connect(this.clip);
    // ペダルの弦の共鳴
    this.resIn = ctx.createGain();
    this.resOut = ctx.createGain();
    this.resConv = ctx.createConvolver();
    this.resIn.connect(this.resConv).connect(this.resOut).connect(this.clip);
    // 響きの計算には少し時間がかかるので、最初の音を遅らせないように後回しにする（書き出しのときはすぐ）
    if (this.offline) { this.applyReverb(); this.resConv.buffer = resonanceIR(ctx); }
    else setTimeout(() => { this.applyReverb(); this.resConv.buffer = resonanceIR(ctx); }, 60);
  }
  setReverb(name) { this.reverb = ROOMS[name] ? name : 'hall'; if (this.ctx) this.applyReverb(); }
  applyReverb() {
    const P = ROOMS[this.reverb] || ROOMS.hall;
    this.verbIn.gain.value = P.wet ? 1 : 0;
    this.verbOut.gain.value = P.wet;
    if (P.wet) this.conv.buffer = reverbIR(this.ctx, this.reverb);
  }

  // iPad では「ユーザーのタップの中で」AudioContext を作る/再開する必要がある
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.setup(new AC({ latencyHint: 'interactive' }));
      // iOS のマナーモードでも音が出るように（Safari 17 以降）
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* 未対応 */ }
    }
    if (!this.offline && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  wave(fam) {
    if (!this.waves[fam]) {
      const h = TIMBRE[fam].h;
      const real = new Float32Array(h.length + 1), imag = new Float32Array(h.length + 1);
      h.forEach((a, i) => (imag[i + 1] = a));
      this.waves[fam] = this.ctx.createPeriodicWave(real, imag);
    }
    return this.waves[fam];
  }

  // 高音質サンプルを読み込む（失敗したら内蔵シンセのまま）
  async loadSamples(sfName) {
    if (!sfName || !this.useSamples || this.samples[sfName] || this.loading[sfName]) return this.loading[sfName];
    this.ensure();
    this.loading[sfName] = (async () => {
      if (sfName === PIANO_SF && await this.piano.ensureBase(this.ctx)) return true; // 読めなければ下の GM 音源へ
      try {
        let res = await fetch(SF_BASE + sfName + '-mp3.js', { cache: 'force-cache' }).catch(() => null);
        if (!res || !res.ok) res = await fetch(SF_BASE2 + sfName + '-mp3.js', { cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const txt = await res.text();
        // 中身は「MIDI.Soundfont.名前 = { "A0": "data:audio/mp3;base64,...", ... }」という JS なので、{ } の部分だけ JSON として読む
        const head = txt.indexOf('MIDI.Soundfont.' + sfName);
        const body = txt.slice(txt.indexOf('{', head), txt.lastIndexOf('}') + 1).replace(/,\s*}$/, '}');
        const map = JSON.parse(body);
        const out = {};
        await Promise.all(Object.entries(map).map(async ([name, uri]) => {
          const m = /^([A-G]b?)(-?\d)$/.exec(name);
          if (!m) return;
          const midi = 12 * (+m[2] + 1) + NOTE_NAMES.indexOf(m[1]);
          const b64 = uri.slice(uri.indexOf(',') + 1);
          const bin = atob(b64);
          const buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          out[midi] = await new Promise((ok, ng) => this.ctx.decodeAudioData(buf.buffer, ok, ng));
          out[midi].onset = findOnset(out[midi]);
        }));
        this.samples[sfName] = out;
        return true;
      } catch (e) {
        console.warn('サンプル読み込み失敗（内蔵シンセで再生します）', sfName, e);
        this.samples[sfName] = null;
        return false;
      }
    })();
    return this.loading[sfName];
  }

  // 曲で使う強さのピアノの録音を読み込む
  loadPianoFor(notes) {
    if (!this.useSamples || !notes.some(n => n.sf === PIANO_SF)) return Promise.resolve();
    this.ensure();
    return this.piano.ensureNotes(this.ctx, notes);
  }

  // 1音を鳴らす。when: AudioContext の時刻（秒。なければ今すぐ＝弾いた音）、dur: 長さ（秒）
  // drum = ドラムの種類（perc.js の id）、ch = パート番号（ミキサーの音量・左右を通す）
  // ped = ペダルを踏んでいる、hold = 長さを決めずに鳴らし始める（noteOff まで）
  play({ midi, program = 0, sf = null, when = null, dur = 0.5, vel = 0.8, drum = null, ch = null, ped = false, hold = false }) {
    const ctx = this.ensure();
    const t0 = Math.max(when ?? ctx.currentTime, ctx.currentTime);
    this.out = ch != null && this.channels.has(ch) ? this.channels.get(ch).g : when == null ? this.live : this.master;
    if (drum) return this.playDrum(drum, t0, vel);
    if (sf === PIANO_SF && this.useSamples) {
      const v = this.playPiano(midi, t0, dur, vel, ped, hold);
      if (v) return v;
    }
    const smp = sf && this.samples[sf];
    if (smp && smp[midi]) return this.playSample(smp[midi], t0, dur, vel, program);
    return this.playSynth(midi, program, t0, dur, vel);
  }

  // ───────── ピアノ ─────────
  playPiano(midi, t0, dur, vel, ped, hold) {
    const ctx = this.ctx, want = pianoPick(midi, vel);
    const s = this.piano.nearest(want.point, want.layer);
    if (!s) return null;
    if (s.point !== want.point || s.layer !== want.layer) this.piano.want(ctx, want.point, want.layer);
    // 同じ鍵を弾き直すと、前の音はハンマーに止められて急に弱まる
    const prev = this.keys.get(midi);
    if (prev) this.pianoDamp(prev, t0, 0.1);
    const out = this.out || this.master;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = s.buf;
    src.playbackRate.value = pianoRate(midi, s.point);
    const peak = pianoGain(want.v, s.layer);
    g.gain.value = peak;
    src.connect(g).connect(out);
    if (ped) {
      const r = ctx.createGain();
      r.gain.value = RES_LEVEL * (out === this.master || out === this.live ? 1 : out.gain.value);
      g.connect(r).connect(this.resIn);
    }
    src.start(t0, s.onset);
    const v = this.track(src, g);
    Object.assign(v, { piano: true, midi, peak, t0, vel: want.v, point: s.point, out, off: null, rel: null });
    this.keys.set(midi, v);
    if (!hold) this.pianoOff(v, t0 + Math.max(0.05, dur));
    if (!this.offline) this.limitPiano(t0);
    return v;
  }
  // 指を離す：ダンパーが弦に触れて音が止まる。そのときの小さな音（ダンパーと鍵盤の音）も鳴らす
  pianoOff(v, at) {
    if (v.off != null) return;
    v.off = at;
    if (v.midi >= NO_DAMPER) return;
    const tau = damperTau(v.midi);
    v.g.gain.setValueAtTime(v.peak, at);
    v.g.gain.setTargetAtTime(0, at, tau);
    v.src.stop(at + tau * 9);
    this.keyNoise(v, at);
  }
  keyNoise(v, at) {
    const s = this.piano.get('rel' + PIANO_NAMES[v.point]);
    if (!s) return;
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    const db = -37 + PIANO_TRIM - 2 * Math.max(0, at - v.t0); // 長く押さえたあとほど小さい（元の SFZ と同じ）
    g.gain.value = Math.pow(10, db / 20) * (0.18 + 0.82 * (v.vel / 127) ** 2);
    src.buffer = s.buf;
    src.connect(g).connect(v.out);
    src.start(at, s.onset);
    v.rel = this.track(src, g);
  }
  pianoDamp(v, at, tau) {
    if (v.off != null && v.off <= at && v.midi < NO_DAMPER) return;
    v.off = at;
    v.g.gain.cancelScheduledValues(at);
    v.g.gain.setTargetAtTime(0, at, tau);
    v.src.stop(at + tau * 8);
    if (v.rel) { try { v.rel.src.stop(at); } catch (e) { /* 停止済み */ } }
  }
  limitPiano(t0) {
    let n = 0, oldest = null;
    for (const v of this.voices) if (v.piano && !v.limited) { n++; oldest = oldest || v; }
    if (n > MAX_PIANO && oldest) { oldest.limited = true; this.pianoDamp(oldest, t0, 0.12); }
  }
  // ペダルの音。踏むと共鳴が鳴り、離すと止まる
  pedal(kind, when, ch = null) {
    const ctx = this.ensure();
    const t = Math.max(when ?? ctx.currentTime, ctx.currentTime);
    this.resOut.gain.setTargetAtTime(kind === 'up' ? 0 : 1, t, kind === 'up' ? 0.06 : 0.01);
    const s = this.piano.get((kind === 'up' ? 'pedalU' : 'pedalD') + (Math.random() < 0.5 ? 1 : 2));
    if (!s) return;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    g.gain.value = Math.pow(10, ((kind === 'up' ? -19 : -20) + PIANO_TRIM) / 20);
    src.buffer = s.buf;
    src.connect(g).connect(ch != null && this.channels.has(ch) ? this.channels.get(ch).g : when == null ? this.live : this.master);
    src.start(t, s.onset);
    this.track(src, g);
  }
  // 鍵盤を押しているあいだ鳴らす（MIDI キーボード・画面鍵盤）。ピアノ以外は決まった長さで鳴る
  noteOn(key, o) {
    const v = this.play({ ...o, hold: true, ped: this.sustain });
    if (v?.piano) this.held.set(key, v);
  }
  noteOff(key) {
    const v = this.held.get(key);
    if (!v) return;
    this.held.delete(key);
    if (this.sustain) this.sustained.add(v); else this.pianoOff(v, this.ctx.currentTime);
  }
  setSustain(on) {
    if (on === this.sustain) return;
    this.sustain = on;
    if (!this.ctx) return;
    this.pedal(on ? 'down' : 'up');
    if (!on) { for (const v of this.sustained) this.pianoOff(v, this.ctx.currentTime); this.sustained.clear(); }
  }

  // ミキサー：パート ch の音量（0〜1）と左右（-1〜1）
  setChannel(ch, vol = 0.8, pan = 0) {
    const ctx = this.ensure();
    let c = this.channels.get(ch);
    if (!c) {
      c = { g: ctx.createGain(), p: ctx.createStereoPanner ? ctx.createStereoPanner() : null };
      if (c.p) c.g.connect(c.p).connect(this.master); else c.g.connect(this.master);
      this.channels.set(ch, c);
    }
    c.g.gain.value = Math.max(0, Math.min(1.25, vol / 0.8));
    if (c.p) c.p.pan.value = Math.max(-1, Math.min(1, pan));
  }

  // メトロノームのクリック（小節の頭は高い音）
  click(when, accent = false) {
    const ctx = this.ensure();
    const t0 = Math.max(when, ctx.currentTime);
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(accent ? 0.22 : 0.14, t0 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    osc.connect(g).connect(this.clickOut);
    osc.start(t0); osc.stop(t0 + 0.07);
    this.track(osc, g);
  }

  // ドラム：太鼓は「音程が下がるサイン波＋ノイズ」、シンバルは「高い音だけ残したノイズ」で作る（オフラインでも鳴る）
  noise() {
    if (!this.noiseBuf || this.noiseBuf.sampleRate !== this.ctx.sampleRate) {
      const n = this.ctx.sampleRate * 2, b = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = b.getChannelData(0);
      let x = 1;
      for (let i = 0; i < n; i++) { x = (x * 16807) % 2147483647; d[i] = (x / 2147483647) * 2 - 1; }
      this.noiseBuf = b;
    }
    return this.noiseBuf;
  }
  playDrum(id, t0, vel) {
    const ctx = this.ctx;
    const out = this.out || this.master;
    const v = Math.max(0.05, Math.min(1, vel));
    const tone = (f0, f1, dec, amp) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + dec * 0.6);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(amp * v, t0 + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dec);
      o.connect(g).connect(out); o.start(t0); o.stop(t0 + dec + 0.05); this.track(o, g);
    };
    const hiss = (type, freq, q, dec, amp) => {
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = this.noise();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(amp * v, t0 + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dec);
      src.connect(f).connect(g).connect(out); src.start(t0, Math.random()); src.stop(t0 + dec + 0.05); this.track(src, g);
    };
    switch (id) {
      case 'kick': tone(150, 45, 0.45, 0.9); hiss('lowpass', 900, 0.7, 0.03, 0.25); break;
      case 'snare': tone(220, 160, 0.12, 0.35); hiss('bandpass', 2400, 0.6, 0.22, 0.55); break;
      case 'stick': tone(800, 500, 0.04, 0.4); hiss('bandpass', 3000, 2, 0.04, 0.3); break;
      case 'tom1': tone(260, 170, 0.35, 0.6); break;
      case 'tom2': tone(190, 120, 0.4, 0.6); break;
      case 'floor': tone(130, 80, 0.5, 0.65); break;
      case 'hh': hiss('highpass', 8000, 0.8, 0.06, 0.35); break;
      case 'hhp': hiss('highpass', 7000, 0.8, 0.05, 0.25); break;
      case 'hho': hiss('highpass', 7500, 0.8, 0.4, 0.3); break;
      case 'ride': hiss('highpass', 6000, 0.6, 0.9, 0.16); tone(5200, 5000, 0.5, 0.03); break;
      case 'bell': tone(2600, 2550, 0.7, 0.12); hiss('highpass', 7000, 0.6, 0.4, 0.08); break;
      case 'crash': hiss('highpass', 4500, 0.5, 1.6, 0.4); break;
      default: hiss('bandpass', 2000, 1, 0.1, 0.3);
    }
  }

  playSample(buf, t0, dur, vel, program) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const fam = family(program);
    const sustained = !TIMBRE[fam].decay;
    const rel = sustained ? 0.12 : 0.3;
    const end = t0 + Math.max(0.05, dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vel * SAMPLE_GAIN, t0 + 0.002);
    g.gain.setValueAtTime(vel * SAMPLE_GAIN, end);
    g.gain.exponentialRampToValueAtTime(0.0008, end + rel);
    src.connect(g).connect(this.out || this.master);
    src.start(t0, buf.onset || 0);
    src.stop(end + rel + 0.05);
    this.track(src, g);
  }

  playSynth(midi, program, t0, dur, vel) {
    const ctx = this.ctx;
    const fam = family(program);
    const T = TIMBRE[fam];
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.wave(fam));
    osc.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(T.lp + freq * 2, 16000);
    lp.Q.value = 0.4;
    const g = ctx.createGain();
    const peak = vel * 0.32 * Math.min(1, 300 / Math.max(120, freq) + 0.35);
    const end = t0 + Math.max(0.05, dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + T.a);
    if (T.decay) {
      // 減衰する楽器：鍵盤を押している間も音は小さくなっていく
      const dd = T.d * Math.max(0.35, 1.4 - (midi - 48) / 48);
      g.gain.setTargetAtTime(peak * 0.0001 + 0.0001, t0 + T.a, dd / 3);
      g.gain.cancelScheduledValues(end);
      g.gain.setTargetAtTime(0.0001, end, T.r / 3);
      if (fam === 'piano' || fam === 'guitar') lp.frequency.setTargetAtTime(Math.min(1400 + freq, 8000), t0, 0.5);
    } else {
      g.gain.setTargetAtTime(peak * T.s, t0 + T.a, T.d / 3);
      g.gain.setValueAtTime(peak * T.s, end);
      g.gain.setTargetAtTime(0.0001, end, T.r / 3);
    }
    osc.connect(lp).connect(g).connect(this.out || this.master);
    osc.start(t0);
    osc.stop(end + T.r * 2 + 0.1);
    this.track(osc, g);
  }

  track(src, g) {
    const v = { src, g };
    this.voices.add(v);
    src.onended = () => {
      this.voices.delete(v);
      if (v.piano && this.keys.get(v.midi) === v) this.keys.delete(v.midi);
      try { g.disconnect(); } catch (e) { /* もう外れている */ }
    };
    return v;
  }

  // 全部止める（再生停止ボタン）
  stopAll() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0.0001, t, 0.02); v.src.stop(t + 0.1); } catch (e) { /* 停止済み */ }
    }
    this.keys.clear(); this.held.clear(); this.sustained.clear();
    this.resOut.gain.cancelScheduledValues(t);
    this.resOut.gain.setTargetAtTime(1, t + 0.2, 0.01);
  }
}
