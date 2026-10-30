// 音源：Web Audio で鳴らす
//   ・まずは内蔵シンセ（倍音を組み合わせた簡易音色。オフラインでも必ず鳴る）
//   ・ネットにつながっていれば、楽器ごとの高音質サンプル（FluidR3 GM、MIT ライセンス）を
//     自動で取得してキャッシュし、以後はそちらで鳴らす
const SF_BASE = 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/';
const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

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

export class Synth {
  constructor() {
    this.ctx = null;
    this.waves = {};
    this.samples = {};      // sfName → { midi: AudioBuffer }
    this.loading = {};
    this.useSamples = true;
    this.voices = new Set();
  }

  // iPad では「ユーザーのタップの中で」AudioContext を作る/再開する必要がある
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
      // iOS のマナーモードでも音が出るように（Safari 17 以降）
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* 未対応 */ }
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
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
      try {
        const res = await fetch(SF_BASE + sfName + '-mp3.js', { cache: 'force-cache' });
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

  // 1音を鳴らす。when: AudioContext の時刻（秒）、dur: 長さ（秒）
  play({ midi, program = 0, sf = null, when = null, dur = 0.5, vel = 0.8 }) {
    const ctx = this.ensure();
    const t0 = Math.max(when ?? ctx.currentTime, ctx.currentTime);
    const smp = sf && this.samples[sf];
    if (smp && smp[midi]) return this.playSample(smp[midi], t0, dur, vel, program);
    return this.playSynth(midi, program, t0, dur, vel);
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
    g.gain.linearRampToValueAtTime(vel * 0.9, t0 + 0.005);
    g.gain.setValueAtTime(vel * 0.9, end);
    g.gain.exponentialRampToValueAtTime(0.0008, end + rel);
    src.connect(g).connect(this.master);
    src.start(t0);
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
    osc.connect(lp).connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(end + T.r * 2 + 0.1);
    this.track(osc, g);
  }

  track(src, g) {
    const v = { src, g };
    this.voices.add(v);
    src.onended = () => { this.voices.delete(v); try { g.disconnect(); } catch (e) { /* もう外れている */ } };
  }

  // 全部止める（再生停止ボタン）
  stopAll() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0.0001, t, 0.02); v.src.stop(t + 0.1); } catch (e) { /* 停止済み */ }
    }
  }
}
