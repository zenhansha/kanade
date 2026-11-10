// マイクで聞く（鼻歌入力・演奏についてくる）
//
// ここにあるのは「波形 → 音の高さ・音名」の計算だけで、画面には触らない（node のテストでも動く）。
//   ・yin()          1つの音の高さ（基本周波数）を測る。YIN という方法：波形を少しずつずらして自分自身と重ね、
//                    いちばんよく重なるずらし幅 = 1周期 を探す。声は1度に1つの音なので、これでよく測れる
//   ・HumSegmenter   高さの流れ（10ms ごと）→「何秒から何秒まで、どの高さ」の音に区切る
//   ・humPitches     区切った音の高さ（小数）→ 楽譜の音。歌い手ごとのずれ（全体に少し高い・低い）を直し、
//                    調の音にそろえ、譜表に合うオクターブへ動かす
//   ・Chroma         音を12の音名（ド〜シ）ごとの強さにまとめる。ピアノの和音でも「今どの音名が鳴ったか」が分かる
//   ・MicInput       マイクを開いて、10ms ごとに最新の波形を渡す（音は端末の中で処理するだけで、どこにも送らない）

// ───────── 音の高さ（YIN） ─────────
// x: 波形, sr: サンプリング周波数。戻り値 { f: 周波数（Hz）, clarity: 0〜1（1 に近いほどはっきりした音） }
export function yin(x, sr, o = {}) {
  const fmin = o.fmin ?? 60, fmax = o.fmax ?? 1100, th = o.thresh ?? 0.15;
  const n = x.length;
  const tauMax = Math.min(Math.floor(sr / fmin), Math.floor(n / 2));
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const W = n - tauMax;
  const d = new Float32Array(tauMax + 2);
  let run = 0;
  d[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const v = x[i] - x[i + tau]; s += v * v; }
    run += s;
    d[tau] = run > 0 ? (s * tau) / run : 1; // 累積平均で割る（ずらし幅が小さいところで 0 に近づくのを防ぐ）
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (d[t] < th) { while (t + 1 <= tauMax && d[t + 1] < d[t]) t++; tau = t; break; }
  }
  if (tau < 0) { let best = tauMin; for (let t = tauMin; t <= tauMax; t++) if (d[t] < d[best]) best = t; tau = best; }
  // となりの値で放物線を引いて、ずらし幅を小数まで求める（高さの精度が上がる）
  let t0 = tau;
  if (tau > 1 && tau < tauMax) {
    const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a + c - 2 * b;
    if (den > 0) t0 = tau + (a - c) / (2 * den);
  }
  return { f: sr / t0, clarity: Math.max(0, Math.min(1, 1 - d[tau])) };
}

export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); }

// 中央値（並べて真ん中）。外れた値に引っぱられない
export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// ───────── 音に区切る ─────────
// feed({ time（ms）, f, clarity, rms }) を 10ms ごとに呼ぶ。区切れた音は { a, b（ms）, f（MIDI 番号の小数）, peak } で返す。
//   ・声が出ている（はっきりした高さ・十分な大きさ）フレームが続いたら音の始まり
//   ・声が途切れたら音の終わり。息つぎくらいの短い途切れはつなげない
//   ・声を出したまま高さが変わったら、そこで区切る（レガートで歌ったとき）
//   ・同じ高さで「ん、ん」と区切ったとき（音量が一度下がってまた上がる）も区切る
export class HumSegmenter {
  constructor(o = {}) {
    this.o = { minClarity: 0.8, minRms: 0.004, onFrames: 3, offFrames: 6, minLen: 80, change: 0.8, changeFrames: 5, ...o };
    this.noise = null;
    this.cur = null;     // 今の音 { a, frames:[{time, m, rms}], peak, dipped, lastVoiced }
    this.pend = [];      // 始まりかけのフレーム
    this.cand = [];      // 高さが変わりかけのフレーム
    this.off = 0;
  }
  get active() { return !!this.cur; }
  // 今の声の高さ（画面の表示用）
  get now() { return this.cur ? median(this.cur.frames.slice(-5).map(x => x.m)) : null; }

  feed(fr) {
    const o = this.o, out = [];
    const m = fr.f > 0 ? hzToMidi(fr.f) : NaN;
    const gate = Math.max(o.minRms, (this.noise ?? 0) * 3);
    const voiced = fr.clarity >= o.minClarity && fr.rms >= gate && m >= 33 && m <= 96;
    // 声が出ていないときの大きさ = 部屋の雑音の大きさ（ゆっくり追いかける）
    if (!voiced && !this.cur) this.noise = this.noise == null ? fr.rms : this.noise * 0.97 + fr.rms * 0.03;
    const F = { time: fr.time, m, rms: fr.rms };

    if (!this.cur) {
      if (!voiced) { this.pend = []; return out; }
      this.pend.push(F);
      // 始まりかけのフレームの高さがそろっていなければ、古いほうから捨てる（雑音の切れ端を音にしない）
      while (this.pend.length > 1 && Math.max(...this.pend.map(x => x.m)) - Math.min(...this.pend.map(x => x.m)) > 1.2) this.pend.shift();
      if (this.pend.length >= o.onFrames) this.begin(this.pend[0].time, this.pend);
      return out;
    }

    const c = this.cur;
    if (!voiced) {
      this.off++;
      this.cand = [];
      if (this.off >= o.offFrames) { this.end(c.lastVoiced + this.hop(), out); }
      return out;
    }
    this.off = 0;
    const ref = median(c.frames.slice(0, 12).map(x => x.m));
    if (Math.abs(m - ref) >= o.change) {
      // 高さが変わりかけている。同じ新しい高さがしばらく続いたら区切る
      this.cand.push(F);
      const cm = this.cand.map(x => x.m);
      if (Math.max(...cm) - Math.min(...cm) > 0.9) this.cand = [F];
      else if (this.cand.length >= o.changeFrames) {
        const at = this.cand[0].time, frames = this.cand, hop = this.hop();
        // 途切れてから高さが変わったときは、前の音は声が途切れたところで終わり
        this.end(at - c.lastVoiced > hop * 1.5 ? c.lastVoiced + hop : at, out);
        this.begin(at, frames);
      }
      return out;
    }
    if (this.cand.length) { c.frames.push(...this.cand); this.cand = []; }
    c.frames.push(F);
    c.lastVoiced = fr.time;
    // 同じ高さのまま音量が一度下がってまた上がった → 言い直し（新しい音）
    if (fr.rms > c.peak) c.peak = fr.rms;
    if (fr.rms < c.peak * 0.3) c.dipped = true;
    else if (c.dipped && fr.rms > c.peak * 0.6) { this.end(fr.time, out); this.begin(fr.time, [F]); }
    return out;
  }
  hop() { const f = this.cur.frames; return f.length > 1 ? (f[f.length - 1].time - f[0].time) / (f.length - 1) : 10; }
  begin(a, frames) {
    this.cur = { a, frames: [...frames], peak: Math.max(...frames.map(x => x.rms)), dipped: false, lastVoiced: frames[frames.length - 1].time };
    this.pend = []; this.cand = []; this.off = 0;
  }
  end(b, out) {
    const c = this.cur;
    this.cur = null; this.cand = []; this.off = 0;
    if (!c || b - c.a < this.o.minLen) return;
    // 出だしのしゃくり上げ（下から入る）を除いた高さの中央値
    const fr = c.frames, cut = Math.min(3, Math.floor(fr.length / 4));
    out.push({ a: c.a, b, f: median(fr.slice(cut).map(x => x.m)), peak: c.peak });
  }
  // 最後まで来たとき（止めたとき）：鳴っている音を閉じる
  flush(time) { const out = []; if (this.cur) this.end(time ?? this.cur.lastVoiced + this.hop(), out); return out; }
}

// ───────── 高さの小数 → 楽譜の音 ─────────
// 調の音（長調の7音 ＋ 和声的短音階の導音）
export function scalePcs(fifths) {
  const tonic = ((fifths * 7) % 12 + 12) % 12;
  return new Set([0, 2, 4, 5, 7, 9, 11, 8].map(x => (tonic + x) % 12));
}
// 歌い手の「全体のずれ」：音の高さの端数（-0.5〜0.5）を、長さで重みをつけて円の上で平均する
export function tuningOffset(notes) {
  let sx = 0, sy = 0;
  for (const n of notes) {
    const w = Math.max(1, (n.b - n.a) / 100), ang = 2 * Math.PI * (n.f - Math.round(n.f));
    sx += w * Math.cos(ang); sy += w * Math.sin(ang);
  }
  if (!sx && !sy) return 0;
  return Math.atan2(sy, sx) / (2 * Math.PI);
}
// 譜表ごとの「書きやすい高さ」（MIDI 番号）
export const CLEF_RANGE = { treble: [59, 84], treble8vb: [47, 72], bass: [40, 64], alto: [50, 74], tenor: [47, 71] };
// notes: [{ a, b, f }] → [{ ...n, midi }]
// o: { fifths, snap（調の音にそろえる）, octave: 'auto' | 0 | 12 | -12, clef, offset（ずれ。省略すると自動） }
export function humPitches(notes, o = {}) {
  if (!notes.length) return [];
  const off = o.offset ?? tuningOffset(notes);
  const sc = scalePcs(o.fifths || 0);
  const pick = (g) => {
    const n = Math.round(g);
    if (!o.snap || sc.has(((n % 12) + 12) % 12)) return n;
    const up = sc.has((((n + 1) % 12) + 12) % 12), dn = sc.has((((n - 1) % 12) + 12) % 12);
    if (up && dn) return g >= n ? n + 1 : n - 1;
    return up ? n + 1 : n - 1;
  };
  const ms = notes.map(n => pick(n.f - off));
  let shift = 0;
  if (o.octave === 'auto' || o.octave == null) {
    const [lo, hi] = CLEF_RANGE[o.clef] || CLEF_RANGE.treble;
    const mid = median(ms);
    while (mid + shift < lo - 2 && shift < 36) shift += 12;
    while (mid + shift > hi + 2 && shift > -36) shift -= 12;
  } else shift = +o.octave || 0;
  return notes.map((n, i) => ({ ...n, midi: ms[i] + shift }));
}

// 鼻歌（リズムも）：音と音のすきまが短い（息つぎ・子音）ときは、前の音を次の音までのばす
// （「4分音符 + 16分休符」だらけにしない）。すきまが minGap より長く、音と音の間隔の3割より長ければ休符として残す
export function legato(notes, minGap) {
  const s = [...notes].sort((x, y) => x.a - y.a);
  for (let i = 0; i + 1 < s.length; i++) {
    const gap = s[i + 1].a - s[i].b, ioi = s[i + 1].a - s[i].a;
    if (gap > 0 && gap < Math.max(minGap, ioi * 0.3)) s[i] = { ...s[i], b: s[i + 1].a };
  }
  return s;
}

// ───────── 12の音名ごとの強さ（クロマ） ─────────
// 実数の FFT（2の累乗の長さ）。re, im を書き換える
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export class Chroma {
  constructor(sr, n = 4096) {
    this.sr = sr; this.n = n;
    this.win = new Float32Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    this.re = new Float32Array(n); this.im = new Float32Array(n);
    // 周波数の箱（ビン）→ 音名。半音の真ん中に近いほど重く
    this.k0 = Math.max(1, Math.floor((55 * n) / sr)); this.k1 = Math.min(n / 2 - 1, Math.ceil((2600 * n) / sr));
    this.pc = new Int8Array(n / 2); this.w = new Float32Array(n / 2);
    for (let k = this.k0; k <= this.k1; k++) {
      const m = hzToMidi((k * sr) / n), r = Math.round(m);
      this.pc[k] = ((r % 12) + 12) % 12;
      this.w[k] = Math.max(0, 1 - 2 * Math.abs(m - r)) * (m < 48 ? 0.6 : 1); // 低い音は倍音のほうが頼りになる
    }
    this.prev = null;
  }
  // x: 長さ n の波形 → { chroma（12、合計 1）, flux（前のフレームからの増え方 = 音の出だしの強さ）, energy }
  frame(x) {
    const { n, re, im, win } = this;
    for (let i = 0; i < n; i++) { re[i] = x[i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(n / 2), ch = new Float32Array(12);
    let flux = 0, energy = 0;
    for (let k = this.k0; k <= this.k1; k++) {
      const v = Math.log1p(100 * Math.hypot(re[k], im[k]) / n); // 対数でつぶす（大きい音に引っぱられすぎない）
      mag[k] = v; energy += v;
      if (this.prev) flux += Math.max(0, v - this.prev[k]);
      ch[this.pc[k]] += v * this.w[k];
    }
    this.prev = mag;
    const sum = ch.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < 12; i++) ch[i] /= sum;
    return { chroma: ch, flux, energy };
  }
}
// 自動の音量合わせ（オートゲイン）：最近いちばん大きかった音（ゆっくり忘れる）が target になるように増幅する。
// マイクとピアノの距離や部屋で音の大きさは何十倍も変わるので、音の出だしを見つける前にそろえておく
export class Agc {
  constructor({ target = 0.1, tau = 8, hop = 0.02, maxGain = 300 } = {}) {
    this.target = target; this.maxGain = maxGain; this.decay = Math.exp(-hop / tau); this.peak = 0; this.out = null;
  }
  apply(x) {
    const r = rms(x);
    this.peak = Math.max(r, this.peak * this.decay);
    const g = Math.min(this.maxGain, this.target / Math.max(this.peak, 1e-6));
    if (!this.out || this.out.length !== x.length) this.out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) this.out[i] = x[i] * g;
    return this.out;
  }
}

// 2つの12次元の向きの近さ（1 = 同じ向き）
export function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < 12; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}
// 楽譜の和音（MIDI 番号の並び）→ 聞こえるはずの音名の強さ（倍音のぶんも少し足す）
export function expectedChroma(midis) {
  const c = new Float32Array(12);
  for (const m of midis) { const p = ((m % 12) + 12) % 12; c[p] += 1; c[(p + 7) % 12] += 0.35; c[(p + 4) % 12] += 0.12; }
  return c;
}

// ───────── マイク ─────────
// onFrame(buf, stamp)：buf = 最新の波形（size サンプル）、stamp = その波形の真ん中の時刻（performance.now() の ms）
export class MicInput {
  constructor(ctx) { this.ctx = ctx; this.on = false; }
  static get supported() { return !!(typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia); }
  async start(onFrame, { size = 4096, lowpass = 0, hop = 10, echo = true } = {}) {
    const ctx = this.ctx;
    // 雑音の除去と自動の音量調整は切る（のばした声を「雑音」として消してしまうことがある）。
    // エコーの打ち消しは入れる（スピーカーのメトロノームや伴奏をなるべく拾わない）
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: echo, noiseSuppression: false, autoGainControl: false } });
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    this.src = ctx.createMediaStreamSource(this.stream);
    let node = this.src;
    this.filters = [];
    if (lowpass) for (let i = 0; i < 2; i++) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; f.Q.value = 0.6; node.connect(f); node = f; this.filters.push(f); }
    this.an = ctx.createAnalyser();
    this.an.fftSize = size;
    this.an.smoothingTimeConstant = 0;
    node.connect(this.an);
    // 出力につながっていないノードを処理しないブラウザがあるので、音量 0 で出力へつないでおく
    this.mute = ctx.createGain(); this.mute.gain.value = 0;
    this.an.connect(this.mute); this.mute.connect(ctx.destination);
    const track = this.stream.getAudioTracks()[0];
    const lat = track?.getSettings?.().latency;
    this.inLatency = (typeof lat === 'number' && lat > 0 && lat < 0.3 ? lat : 0.015) * 1000; // マイクの遅れ（ms）
    this.buf = new Float32Array(size);
    this.on = true;
    this.timer = setInterval(() => {
      if (!this.on) return;
      this.an.getFloatTimeDomainData(this.buf);
      const stamp = performance.now() - this.inLatency - ((size / 2) / ctx.sampleRate) * 1000;
      onFrame(this.buf, stamp);
    }, hop);
    return this;
  }
  stop() {
    this.on = false;
    clearInterval(this.timer);
    try { this.src?.disconnect(); this.an?.disconnect(); this.mute?.disconnect(); this.filters?.forEach(f => f.disconnect()); } catch (e) { /* もう外れている */ }
    this.stream?.getTracks().forEach(t => t.stop()); // マイクを使っている印も消える
    this.stream = null;
  }
}

// 波形を間引く（高さを測るのに 12kHz あれば足りる。計算が 1/16 になる）
export function decimate(x, k, out) {
  const n = Math.floor(x.length / k);
  out = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < k; j++) s += x[i * k + j]; out[i] = s / k; }
  return out;
}
