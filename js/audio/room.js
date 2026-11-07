// 響きを計算で作る（ConvolverNode に渡すインパルス応答）。ファイルを増やさず、オフライン書き出しでも同じ音になる
export const ROOMS = {
  off: { ja: 'なし', wet: 0 },
  room: { ja: '部屋', wet: 0.2, rt: 0.9, pre: 0.006, damp: 5200 },
  hall: { ja: 'ホール', wet: 0.28, rt: 2.0, pre: 0.02, damp: 3800 },
};
const cache = new Map();

// 部屋の響き：はじめの数回の反射（壁からのはね返り）＋だんだん暗くなりながら消えるノイズ
export function reverbIR(ctx, name) {
  const P = ROOMS[name], sr = ctx.sampleRate, key = name + ':' + sr;
  if (cache.has(key)) return cache.get(key);
  const len = Math.ceil(sr * P.rt * 1.15);
  const buf = ctx.createBuffer(2, len, sr);
  const decay = Math.exp(-6.91 / (P.rt * sr));
  const pre = Math.floor(P.pre * sr), build = sr * 0.035;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let x = c ? 2463534242 : 88172645, lp = 0, env = 1, a = 1;
    for (let i = pre; i < len; i++) {
      if ((i & 63) === 0) a = 1 - Math.exp((-2 * Math.PI * (300 + P.damp * Math.exp(-(i / sr) / (P.rt * 0.45)))) / sr);
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      lp += a * ((x | 0) / 2147483648 - lp);
      d[i] = lp * env * Math.min(1, (i - pre) / build);
      env *= decay;
    }
    // 壁からのはね返り（左右で少し違う時間に）
    const taps = c ? [[11, 0.5], [19, -0.4], [31, 0.34], [47, 0.26], [67, -0.2]] : [[9, 0.55], [23, 0.42], [29, -0.32], [41, 0.28], [59, -0.22]];
    for (const [ms, g] of taps) { const i = pre + Math.floor((ms * sr) / 1000); if (i < len) d[i] += g; }
  }
  cache.set(key, buf);
  return buf;
}

// ペダルを踏んでいるときの弦の共鳴：ダンパーが上がった全部の弦（の倍音）が、弾いた音に合わせて小さく鳴り続ける。
// 「弦の高さで鳴り続ける音」を重ねたものをインパルス応答にすると、弾いた音と高さが合う弦だけが響く
export function resonanceIR(ctx) {
  const sr = ctx.sampleRate, key = 'res:' + sr;
  if (cache.has(key)) return cache.get(key);
  const len = Math.ceil(sr * 2.4);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let seed = 12345;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let m = 21; m <= 88; m++) {
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    const B = 0.00015 * Math.pow(2, (m - 21) / 24); // 弦の硬さで倍音が少し高くなる
    const pan = (m - 54) / 70;
    for (let k = 1; k <= 6; k++) {
      const f = k * f0 * Math.sqrt(1 + B * k * k);
      if (f > 5000) break;
      const tau = Math.min(0.9, 0.2 + 120 / f);
      const n = Math.min(len, Math.floor(tau * 4.6 * sr));
      const w = (2 * Math.PI * f) / sr, dec = Math.exp(-1 / (tau * sr)), amp = 1 / (k * Math.sqrt(k));
      const al = amp * (1 - pan) * 0.5, ar = amp * (1 + pan) * 0.5;
      // くり返しの計算で正弦波を作る（Math.sin を毎回呼ばない）
      const co = 2 * Math.cos(w);
      const p1 = rnd() * 6.283, p2 = rnd() * 6.283;
      let l0 = Math.sin(p1), l1 = Math.sin(p1 - w), r0 = Math.sin(p2), r1 = Math.sin(p2 - w), e = 1;
      for (let i = 0; i < n; i++) {
        L[i] += l0 * e * al; R[i] += r0 * e * ar;
        const l2 = co * l0 - l1, r2 = co * r0 - r1;
        l1 = l0; l0 = l2; r1 = r0; r0 = r2;
        e *= dec;
      }
    }
  }
  cache.set(key, buf);
  return buf;
}
