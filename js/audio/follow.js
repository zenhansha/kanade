// 演奏についてくる（スコアフォロー）
//
// 楽譜の音を「同時に鳴る音のまとまり（グループ）」の列にして、弾いた音がどのグループに当たるかを探し、
// 今の位置を進めていく。テンポは見ない（ゆっくり弾いても、途中で止まっても、ついてくる）。
//   ・ついてくるモード：少し先まで探す。弾きまちがいや弾きとばしがあっても進み、
//                       見失ったら（知らない音が続いたら）曲の中から今の場所を探し直す
//   ・練習モード（待ちモード）：次のグループの音を全部正しく弾くまで進まない。間違えた音を数える
//   ・MIDI キーボード：音の高さで照らし合わせる（正確）
//   ・マイク：音名ごとの強さ（クロマ）の似ている度合いで照らし合わせる（和音もいけるが、MIDI より大まか）
import { expectedChroma, cosine } from './listen.js';

// 当たりの並び [{ T（秒）, sec（楽譜の秒）}] → 楽譜が1秒に何秒進むか（直線の傾き。1.5秒ぶん以上の並びがないときは 1）
// 外れに強いよう、1秒以上はなれた2点ずつの傾きの中央値をとる（タイル・セン法）
export function tempoRate(hits) {
  const sl = [];
  for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
    const dt = hits[j].T - hits[i].T;
    if (dt >= 1) sl.push((hits[j].sec - hits[i].sec) / dt);
  }
  if (sl.length < 2) return 1;
  sl.sort((a, b) => a - b);
  return Math.max(0.6, Math.min(1.7, sl[sl.length >> 1]));
}

// buildPerformance の結果 → グループの列。p = ついていくパート（null = 全部）
export function buildGroups(perf, p = null) {
  const notes = perf.notes.filter(n => !n.drum && !n.grace && n.id && (p == null || n.p === p)).sort((a, b) => a.start - b.start);
  const groups = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && n.start - g.sec < 0.035) {
      if (!g.midis.includes(n.midi)) g.midis.push(n.midi);
      if (!g.ids.includes(n.id)) g.ids.push(n.id);
    } else groups.push({ sec: n.start, m: n.m, t: n.t, i: n.i, midis: [n.midi], ids: [n.id] });
  }
  groups.forEach((g, k) => { g.k = k; g.midis.sort((a, b) => a - b); g.pcs = expectedChroma(g.midis); g.beat = 60 / ((perf.attrs?.[g.m]?.bpm || 100) * (perf.scale || 1)); });
  return groups;
}

export class Follower {
  // o: { strict（練習モード）, ahead（先まで探すグループ数） }
  constructor(groups, o = {}) {
    this.g = groups;
    this.o = { strict: false, ahead: 8, ...o };
    this.cur = -1;          // 最後に弾けたグループ
    this.got = new Map();   // グループ → そこで弾けた音
    this.recent = [];       // 最近の観測（見失ったときに探し直す材料）
    this.lost = 0;          // 当たらない観測が続いた数
    this.ok = 0; this.wrong = 0; this.skipped = 0;
    this.wrongAt = new Map(); // 小節 → 間違えた数
    this.lastAdv = -Infinity;
    this.rate = 1; this.lastT = null; this.lastSec = 0; // マイク：テンポの見積もり
  }
  get done() { return this.cur >= this.g.length - 1; }
  // 次に弾く（まだ弾き終わっていない）グループ
  get next() { return this.g[this.cur + 1] || null; }
  start(k = 0) { this.cur = k - 1; this.got.clear(); this.recent = []; this.lost = 0; this.lastT = null; this.rate = 1; this.hits = []; this.b = null; }

  advance(j, time) {
    if (j > this.cur + 1) this.skipped += j - this.cur - 1;
    this.cur = j;
    this.lastAdv = time;
    for (const k of [...this.got.keys()]) if (k <= j - 1) this.got.delete(k);
    this.lost = 0;
  }
  miss(m) { this.wrong++; this.wrongAt.set(m, (this.wrongAt.get(m) || 0) + 1); }

  // MIDI の音を1つ弾いた。戻り値 { kind: 'ok' | 'wrong' | 'again', moved（位置が進んだ）, k }
  noteOn(midi, time = 0) {
    const G = this.g;
    if (!G.length) return { kind: 'wrong', moved: false };
    this.recent.push({ midi, time });
    if (this.recent.length > 8) this.recent.shift();
    const cur = this.cur;
    // 今のグループの音の弾き直し（少し遅れて押した和音の音など）は、間違いにしない
    if (cur >= 0 && G[cur].midis.includes(midi) && time - this.lastAdv < 400) return { kind: 'again', moved: false, k: cur };

    if (this.o.strict) {
      const g = G[cur + 1];
      if (!g) return { kind: 'again', moved: false };
      if (!g.midis.includes(midi)) { this.miss(g.m); return { kind: 'wrong', moved: false, k: cur + 1 }; }
      const j = cur + 1, s = this.got.get(j) || new Set();
      s.add(midi); this.got.set(j, s);
      this.ok++;
      if (s.size >= g.midis.length) { this.advance(j, time); return { kind: 'ok', moved: true, k: j }; }
      return { kind: 'ok', moved: false, k: j };
    }

    // ついてくるモード：近い順に、その音を含み、まだその音を弾いていないグループを探す
    for (let j = cur + 1; j < Math.min(G.length, cur + 1 + this.o.ahead); j++) {
      const g = G[j];
      if (!g.midis.includes(midi)) continue;
      const s = this.got.get(j) || new Set();
      if (s.has(midi)) continue;
      s.add(midi); this.got.set(j, s);
      this.ok++;
      // 和音は半分以上そろったら「そこまで来た」とみなす（全部を押さえなくても進む）
      if (s.size >= Math.ceil(g.midis.length / 2)) { this.advance(j, time); return { kind: 'ok', moved: true, k: j }; }
      return { kind: 'ok', moved: false, k: j };
    }
    this.wrong++;
    this.lost++;
    if (this.lost >= 4) { const k = this.relocate(); if (k != null) { this.advance(k, time); return { kind: 'ok', moved: true, k, jumped: true }; } }
    return { kind: 'wrong', moved: false };
  }

  // 見失った：最近弾いた音の並びが、曲のどこにいちばん合うかを探す
  relocate() {
    const G = this.g, rec = this.recent.slice(-6).map(r => r.midi);
    if (rec.length < 4) return null;
    let best = null, bestScore = 0;
    for (let k = 0; k < G.length; k++) {
      // k を最後のグループとして、後ろから順に当てていく（1グループに複数の音が入ってもよい）
      let j = k, sc = 0;
      for (let r = rec.length - 1; r >= 0 && j >= 0; r--) {
        let found = -1;
        for (let q = j; q >= Math.max(0, j - 2); q--) if (G[q].midis.includes(rec[r])) { found = q; break; }
        if (found >= 0) { sc++; j = found; } else j--;
      }
      // 同じくらい合うなら、今の位置に近いほうを選ぶ
      const score = sc - Math.abs(k - this.cur) * 0.0005;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return bestScore >= rec.length - 1 ? best : null;
  }

  // マイク：音の出だしで聞こえた音名の強さ（12）。戻り値は noteOn と同じ形。
  // 同じ和音は曲の中に何度も出てくるので、「今いる場所」を1つに決めつけず、候補ごとの確からしさ（確率）を持っておく
  // （隠れマルコフモデル）。音の出だしが聞こえるたびに：
  //   ① 進み具合：前の出だしからの時間 × テンポ（rate）ぶん先へ進んだはず。その近くへ確率を動かす
  //      （聞き逃した音があってもよいよう、少し先までなだらかに。同じ場所にとどまる＝弾き直し・残響も少しだけ）
  //   ② 音の似かた：聞こえた音名の強さと楽譜の和音が似ている場所ほど確率を上げる
  //   ③ いちばん確率の高い場所を「今の位置」にする
  // テンポは、はっきり当たったときの並びから見積もる（2点ずつの傾きの中央値。外れに強い）。
  // 1.5秒以上音がなかったら、止まっていたとみなして「次の音」から待つ。
  hear(chroma, time = 0) {
    const G = this.g, N = G.length;
    if (!N) return { kind: 'wrong', moved: false };
    const T = time / 1000, W = 14;
    const prev = this.b;
    const nb = new Float64Array(N);
    if (!prev || this.lastT == null) {
      // 最初の出だし：はじめの位置か、その少し先
      const k0 = Math.max(0, this.cur + 1);
      for (let k = k0; k < Math.min(N, k0 + 6); k++) nb[k] = Math.exp(-((k - k0) ** 2) / 2);
    } else {
      const dt = T - this.lastT;
      for (let j = 0; j < N; j++) {
        const p = prev[j];
        if (p < 1e-7) continue;
        const beat = G[j].beat;
        const D = dt > 1.5 ? beat : this.rate * dt;              // 進んだはずの楽譜の秒
        const sig = dt > 1.5 ? 2.5 * beat : Math.max(0.4 * beat, 0.3 * D);
        nb[j] += p * 0.04;                                       // とどまる
        for (let k = j + 1; k < Math.min(N, j + W); k++) {
          const d = G[k].sec - G[j].sec;
          nb[k] += p * Math.exp(-((d - D) ** 2) / (2 * sig * sig));
        }
      }
    }
    let sum = 0, best = -1, maxSim = 0;
    for (let k = 0; k < N; k++) {
      if (!nb[k]) continue;
      const sim = cosine(chroma, G[k].pcs);
      if (sim > maxSim) maxSim = sim;
      nb[k] *= Math.exp(8 * sim);
      sum += nb[k];
    }
    this.recent.push({ chroma, time });
    if (this.recent.length > 6) this.recent.shift();
    if (sum > 0) {
      for (let k = 0; k < N; k++) nb[k] /= sum;
      for (let k = 0; k < N; k++) if (best < 0 || nb[k] > nb[best]) best = k;
    }
    // 近くにまったく似ていない（ほかの場所を弾いている・雑音）：数回続いたら、曲の中から探し直す
    if (maxSim < 0.55 || best < 0) {
      this.lost++;
      if (this.lost >= 5) {
        const obs = this.recent.slice(-4).filter(r => r.chroma);
        let bk = null, bs = 0;
        for (let k = obs.length - 1; k < N; k++) {
          let s = 0;
          for (let r = 0; r < obs.length; r++) s += cosine(obs[r].chroma, G[k - (obs.length - 1 - r)].pcs);
          s /= obs.length;
          if (s > bs) { bs = s; bk = k; }
        }
        if (bk != null && bs >= 0.7) {
          this.b = new Float64Array(N); this.b[bk] = 1;
          this.advance(bk, time); this.lastT = T; this.hits = [];
          return { kind: 'ok', moved: true, k: bk, jumped: true };
        }
      }
      return { kind: 'wrong', moved: false, sim: maxSim };
    }
    this.lost = 0;
    this.b = nb;
    this.lastT = T;
    // はっきりしているとき（確率が高い）だけ、テンポの見積もりに使う
    if (nb[best] >= 0.6 && best > this.cur) { // 進んだときだけ（とどまった出だしを入れると遅く見積もってしまう）
      this.hits = (this.hits || []).filter(h => T - h.T < 6);
      this.hits.push({ T, sec: G[best].sec });
      this.rate = tempoRate(this.hits);
    }
    if (best === this.cur) return { kind: 'again', moved: false, k: best };
    this.ok++;
    this.advance(best, time);
    return { kind: 'ok', moved: true, k: best, p: nb[best] };
  }

  // 練習の結果：間違いの多かった小節（多い順）
  report() {
    const total = this.ok + this.wrong;
    const worst = [...this.wrongAt.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([m, n]) => ({ m, n }));
    return { ok: this.ok, wrong: this.wrong, rate: total ? this.ok / total : 1, worst, reached: this.cur, total: this.g.length };
  }
}

// マイクの音から「音の出だし」を見つける（クロマの flux の山）。
// push(frame, stamp) を 10〜20ms ごとに呼ぶと、出だしのあと少し待ってから { chroma, stamp } を返す
export class OnsetPicker {
  constructor(o = {}) {
    this.o = { wait: 3, gap: 90, k: 1.5, ...o };
    this.hist = [];   // 最近の flux
    this.frames = []; // 最近のフレーム
    this.pending = null;
    this.lastOn = -Infinity;
  }
  push(fr, stamp) {
    const o = this.o, out = [];
    this.frames.push({ ...fr, stamp });
    if (this.frames.length > 12) this.frames.shift();
    const h = this.hist;
    const mean = h.length ? h.reduce((a, b) => a + b, 0) / h.length : 0;
    const dev = h.length ? Math.sqrt(h.reduce((a, b) => a + (b - mean) * (b - mean), 0) / h.length) : 0;
    // 出だし：flux がふだんより目立って大きく、ある程度の大きさがある
    const isOn = h.length >= 5 && fr.flux > mean + o.k * dev + 0.02 * fr.energy && fr.flux > 0.5 && stamp - this.lastOn > o.gap;
    h.push(fr.flux);
    if (h.length > 25) h.shift();
    if (isOn && !this.pending) {
      this.pending = { at: stamp, left: o.wait, before: this.frames[this.frames.length - 3]?.chroma || null };
      this.lastOn = stamp;
    }
    if (this.pending && --this.pending.left <= 0) {
      // 出だしの少しあと（音が落ち着いたころ）の音名から、前から鳴っていた音のぶんを引く
      const p = this.pending, c = Float32Array.from(fr.chroma);
      if (p.before) for (let i = 0; i < 12; i++) c[i] = Math.max(0, c[i] - 0.6 * p.before[i]);
      const s = c.reduce((a, b) => a + b, 0);
      out.push({ chroma: s > 0.05 ? c : fr.chroma, stamp: p.at });
      this.pending = null;
    }
    return out;
  }
}
