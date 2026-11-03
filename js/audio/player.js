// 再生：楽譜を「何秒に・どの音を・何秒間・どの強さで」のリストにして、少し先読みしながら鳴らす
//
// Phase 2 で反映するもの
//   ・反復記号・カッコ・D.C./D.S./Coda/Fine の順番（marks.js の playOrder）
//   ・強弱記号と松葉（だんだん強く/弱く）、sf などの一瞬のアクセント
//   ・スタッカート（短く）・テヌート・アクセント・マルカート、フェルマータ（全体の時間を止める）
//   ・8va / 15ma（オクターブ上げて鳴らす）、ペダル（離すまで音を伸ばす）
//   ・装飾音符（拍の直前に短く）、トリル・モルデント・ターン
// Phase 3（表情付き再生 = Finale の Human Playback）
//   ・rit. / rall.（だんだん遅く）・accel.（だんだん速く）・meno mosso / più mosso・a tempo
//   ・スウィング（8分音符を跳ねる）、拍の頭を少し強く、人間らしい小さな揺れ
//   ・ドラム譜（GM ドラム）、ミキサー（音量・左右・ミュート・ソロ）、メトロノーム・カウントイン
import { TPQ, midiOf, keyAlter, fromDiatonic, diatonic, beatTicks } from '../core/music.js';
import { measureAttrs, INST } from '../core/score.js';
import { positions } from '../core/edit.js';
import { playOrder, DYNAMICS, SPANS, spanEnd } from '../core/marks.js';
import { DRUM, drumOf } from '../core/perc.js';

const DEFAULT_VEL = 0.7;
const RES = TPQ / 12; // テンポ表のきざみ（ティック）

// 文字の表情記号のうち、テンポを変えるもの
const TEMPO_WORDS = [
  { re: /^(rit|ritard|rall|allarg)/i, ramp: 0.72 },
  { re: /^(accel|string)/i, ramp: 1.25 },
  { re: /^meno\s*mosso/i, step: 0.85 },
  { re: /^(più|piu)\s*mosso/i, step: 1.15 },
  { re: /^(a\s*tempo|tempo\s*(i|primo|1))/i, reset: true },
];

export function playbackSettings(score) {
  return { human: true, swing: 0, click: false, countIn: 1, ...(score.settings?.playback || {}) };
}

// opts: { linear: 反復を無視して順番どおり, tempoScale: テンポの倍率（録音の練習用）, human: 表情付き再生の上書き }
export function buildPerformance(score, opts = {}) {
  const A = measureAttrs(score);
  const PB = playbackSettings(score);
  const human = opts.human ?? PB.human;
  const scale = opts.tempoScale || 1;
  const order = opts.linear ? A.map((_, m) => m) : playOrder(score);
  const absT = (m, t) => A[m].start + t;

  // ── フェルマータ：その音の長さのぶん、全パートの時間を止める ──
  const pauses = A.map(() => []);
  forEachEvent(score, (ev, x, m) => {
    if (!ev.art || !ev.art.includes('ferm')) return;
    const add = ((x.end - x.start) / TPQ) * (60 / (A[m].bpm * scale));
    const ex = pauses[m].find(p => p.t === x.end);
    if (ex) ex.add = Math.max(ex.add, add); else pauses[m].push({ t: x.end, add });
  });
  const pauseUpTo = (m, t) => pauses[m].reduce((a, p) => a + (p.t <= t ? p.add : 0), 0);

  // ── テンポの揺れ（rit. / accel. …）：演奏順に並べた位置 g → 倍率 ──
  const gStart = [];
  let g = 0;
  order.forEach((m, i) => { gStart[i] = g; g += A[m].len; });
  const words = A.map(() => []);
  for (const part of score.parts) for (const st of part.staves) st.measures.forEach((sm, m) => (sm.dirs || []).forEach(d => {
    if (d.k !== 'text' || !d.text) return;
    const w = TEMPO_WORDS.find(x => x.re.test(d.text.trim()));
    if (w && !words[m].some(q => q.t === d.t)) words[m].push({ t: d.t, w });
  }));
  const evs = [];
  order.forEach((m, i) => {
    if (score.measures[m].tempo && i > 0) evs.push({ g: gStart[i], w: { reset: true } });
    words[m].sort((a, b) => a.t - b.t).forEach(q => evs.push({ g: gStart[i] + q.t, w: q.w, i }));
  });
  const pts = [{ g: 0, f: 1, step: true }];
  const fAt = (x) => {
    let k = 0;
    while (k + 1 < pts.length && pts[k + 1].g <= x) k++;
    const p = pts[k], n = pts[k + 1];
    if (n && !n.step) return p.f + (n.f - p.f) * ((x - p.g) / Math.max(1, n.g - p.g));
    return p.f;
  };
  if (human) evs.forEach((e, k) => {
    const cur = fAt(e.g);
    if (e.w.reset) pts.push({ g: e.g, f: 1, step: true });
    else if (e.w.step) pts.push({ g: e.g, f: cur * e.w.step, step: true });
    else if (e.w.ramp) {
      // 次のテンポの指示か、次の小節の終わりまでで変化させ、そのあとはそのテンポのまま
      const i = e.i, limit = i + 1 < order.length ? gStart[i + 1] + A[order[i + 1]].len : gStart[i] + A[order[i]].len;
      const end = Math.min(limit, evs[k + 1] ? evs[k + 1].g : Infinity);
      pts.push({ g: e.g, f: cur, step: true }, { g: Math.max(e.g + RES, end), f: Math.max(0.35, Math.min(2.5, cur * e.w.ramp)) });
    }
    pts.sort((a, b) => a.g - b.g);
  });

  // ── スウィング：拍の後ろ半分の8分音符を遅らせる（4分の拍子だけ） ──
  const swing = Math.max(0, Math.min(1, PB.swing || 0)) / 6;
  const warp = (m, t) => {
    if (!swing || A[m].time.beatType !== 4) return t;
    const off = A[m].full - A[m].len;
    const b = Math.floor((t + off) / TPQ) * TPQ - off, u = (t - b) / TPQ;
    const w = u <= 0.5 ? u * (0.5 + swing) / 0.5 : 0.5 + swing + (u - 0.5) * (0.5 - swing) / 0.5;
    return b + w * TPQ;
  };

  // ── 秒への変換表（演奏順の小節ごと） ──
  const tables = [], seqStart = [];
  let sec = 0;
  order.forEach((m, i) => {
    seqStart[i] = sec;
    const n = Math.ceil(A[m].len / RES);
    const cum = [0];
    for (let k = 0; k < n; k++) {
      const dt = Math.min(RES, A[m].len - k * RES);
      const f = fAt(gStart[i] + k * RES + dt / 2);
      cum.push(cum[k] + (dt / TPQ) * (60 / (A[m].bpm * scale * f)));
    }
    tables[i] = cum;
    sec += cum[n] + pauseUpTo(m, A[m].len);
  });
  const total = sec;
  const inTable = (i, t) => {
    const cum = tables[i], x = Math.max(0, t) / RES, k = Math.min(cum.length - 2, Math.floor(x));
    if (k < 0) return 0;
    return cum[k] + (cum[k + 1] - cum[k]) * (x - k);
  };
  const tickToSec = (i, t) => seqStart[i] + inTable(i, warp(order[i], t)) + pauseUpTo(order[i], t);
  // 小節をまたぐ長さ（ペダル・タイ）用：i 番目の小節から楽譜どおり進んだとして m2 の t2 は何秒か
  const secAhead = (i, m2, t2) => {
    let j = i;
    while (j + 1 < order.length && order[j] < m2 && order[j + 1] === order[j] + 1) j++;
    return order[j] === m2 ? tickToSec(j, t2) : tickToSec(j, A[order[j]].len);
  };

  // ── 人間らしさ：同じ楽譜なら毎回同じになる「ゆらぎ」 ──
  const jitter = (k, amp) => { const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453; return (x - Math.floor(x) - 0.5) * 2 * amp; };
  const beatAccent = (m, t) => {
    if (!human) return 0;
    const off = A[m].full - A[m].len, bt = beatTicks(A[m].time);
    if ((t + off) === 0) return 0.05;
    if ((t + off) % bt === 0) return ((t + off) === A[m].full / 2 ? 0.03 : 0.015);
    return 0;
  };

  const anySolo = score.parts.some(p => p.mix?.solo);
  const notes = [];
  let nk = 0;
  score.parts.forEach((part, p) => {
    if (anySolo ? !part.mix?.solo : part.mix?.mute) return;
    const inst = INST[part.inst] || {};
    const oct = inst.oct || 0;
    const staves = part.staves.map((st, s) => ({ st, s })).filter(x => x.st.tabOf == null);
    // 強弱は譜表ごと。強弱記号がない譜表（ピアノの左手など）は1段目のものを使う
    const curves = part.staves.map(st => dynamicCurve(st, A, absT));
    const hasDyn = part.staves.map(st => st.measures.some(sm => sm.dirs?.some(d => d.k === 'dyn')) || st.measures.some(sm => sm.spans?.some(sp => sp.k === 'cresc' || sp.k === 'dim')));
    staves.forEach(({ st, s }) => {
      const perc = st.clef === 'percussion';
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
            let start = tickToSec(i, x.start);
            const end = tickToSec(i, x.end);
            const next = new Map();
            if (!ev.rest) {
              const at = absT(m, x.start);
              const art = ev.art || [];
              const shift = perc ? 0 : inSpan(shifts, at)?.shift || 0;
              const ped = perc ? null : inSpan(peds, at);
              let vel = curve.velAt(at) + curve.accentAt(at) + beatAccent(m, x.start);
              if (art.includes('acc')) vel += 0.14;
              if (art.includes('marc')) vel += 0.2;
              if (human) { vel += jitter(nk, 0.035); start += jitter(nk + 7, 0.006); nk++; }
              vel = Math.max(0.08, Math.min(1, vel));
              let len = end - start;
              if (art.includes('stacc')) len *= 0.5;
              else if (art.includes('staccss')) len *= 0.3;
              else if (art.includes('marc')) len *= 0.75;
              else if (!art.includes('ten')) len -= Math.min(0.03, len * 0.08);
              const base = { program: part.program, sf: inst.sf, p, s, v, m, t: x.start, id: ev.id, ids: [ev.id], i };
              if (perc) {
                // ドラム：長さは関係なく叩くだけ。装飾音（フラム）も
                if (ev.grace) ev.grace.forEach((gr, gi) => gr.notes.forEach(n => { const d = drumOf(n); notes.push({ ...base, start: Math.max(0, start - (ev.grace.length - gi) * 0.03), end: start, midi: d.gm, drum: d.id, vel: vel * 0.6 }); }));
                for (const n of ev.notes) { const d = drumOf(n); notes.push({ ...base, start, end: start + Math.max(0.08, len), midi: d.gm, drum: d.id, vel }); }
                pending = next;
                continue;
              }
              // 装飾音：拍の直前に短く
              if (ev.grace) {
                const gd = Math.min(0.075, (end - start) / 3);
                ev.grace.forEach((gr, gi) => gr.notes.forEach(n => notes.push({
                  ...base, start: Math.max(0, start - (ev.grace.length - gi) * gd), end: Math.max(0, start - (ev.grace.length - gi - 1) * gd) - 0.005,
                  midi: midiOf(n) + oct + shift, vel: vel * 0.85,
                })));
              }
              const orn = art.includes('tr') || inSpan(trills, at) ? 'tr' : art.includes('mord') ? 'mord' : art.includes('prall') ? 'prall' : art.includes('turn') ? 'turn' : null;
              for (const n of ev.notes) {
                const midi = midiOf(n) + oct + shift;
                let nn = pending.get(midi);
                if (nn) { nn.end = Math.max(nn.end, start + len); nn.ids.push(ev.id); }
                else if (orn && n === ev.notes[ev.notes.length - 1]) {
                  ornament(notes, orn, n, fifths, { ...base, start, end: start + len, oct: oct + shift, vel });
                } else {
                  nn = { ...base, start, end: start + len, midi, vel, ids: [ev.id] };
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
  // メトロノーム：拍ごと（小節の頭は強く）
  const clicks = [];
  order.forEach((m, i) => {
    const bt = beatTicks(A[m].time), off = A[m].full - A[m].len;
    for (let t = (bt - (off % bt)) % bt; t < A[m].len; t += bt) clicks.push({ start: tickToSec(i, t), accent: t + off === 0, click: true });
  });
  // 再生カーソル用：秒 → (小節, ティック)
  const secToPos = (x) => {
    let i = 0;
    while (i + 1 < order.length && seqStart[i + 1] <= x) i++;
    const m = order[i] ?? 0;
    const cum = tables[i] || [0];
    let rel = x - seqStart[i] - 0;
    let k = 0;
    while (k + 1 < cum.length && cum[k + 1] + pauseUpTo(m, (k + 1) * RES) <= rel) k++;
    const c0 = cum[k] + pauseUpTo(m, k * RES), c1 = (cum[k + 1] ?? cum[k]) + pauseUpTo(m, (k + 1) * RES);
    const t = k * RES + (c1 > c0 ? ((rel - c0) / (c1 - c0)) * RES : 0);
    return { m, t: Math.max(0, Math.min(t, A[m].len)), i };
  };
  // m 小節目から再生するときの開始秒（反復で何度も出てくる小節なら最初の1回）
  const secOfMeasure = (m) => {
    let i = order.indexOf(m);
    if (i < 0) i = order.findIndex(x => x >= m);
    return i < 0 ? total : seqStart[i];
  };
  return { notes, clicks, total, order, seqStart, tickToSec, secToPos, secOfMeasure, attrs: A, scale };
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
    this.midiOut = null; // 外部 MIDI 音源へ送るとき（midi.js の MidiInput）
  }

  // opts: { click: メトロノーム, countIn: カウントインの小節数, filter: 鳴らす音を選ぶ, keepGoing: 最後まで行っても止めない（録音用）,
  //         linear / tempoScale: buildPerformance へ }
  async start(score, fromMeasure = 0, opts = {}) {
    this.stop(true);
    const ctx = this.synth.ensure();
    const perf = buildPerformance(score, opts);
    if (opts.filter) perf.notes = perf.notes.filter(opts.filter);
    this.perf = perf;
    this.opts = opts;
    // ミキサー（パートごとの音量・左右）
    score.parts.forEach((p, i) => this.synth.setChannel(i, p.mix?.vol ?? 0.8, p.mix?.pan ?? 0));
    // 使われている楽器の高音質サンプルを読み込み（初回だけ少し待つ。最大1.5秒）
    const sfs = [...new Set(score.parts.map(p => (INST[p.inst] || {}).sf).filter(Boolean))];
    const loads = Promise.all(sfs.map(s => this.synth.loadSamples(s)));
    await Promise.race([loads, new Promise(r => setTimeout(r, 1500))]);
    const fromSec = perf.secOfMeasure(fromMeasure);
    this.fromSec = fromSec;
    // カウントイン：最初の小節の拍子・テンポで、指定した小節数ぶんクリックを先に鳴らす
    const A = perf.attrs, m0 = perf.order[perf.order.indexOf(fromMeasure)] ?? fromMeasure;
    const a0 = A[Math.min(m0, A.length - 1)];
    const beatSec = (beatTicks(a0.time) / TPQ) * (60 / (a0.bpm * perf.scale));
    const nBeats = Math.round((opts.countIn || 0) * (a0.full / beatTicks(a0.time)));
    const countSec = nBeats * beatSec;
    let clicks = opts.click ? perf.clicks.filter(c => c.start >= fromSec - 1e-6) : [];
    if (opts.keepGoing && opts.click) {
      // 楽譜の終わりを過ぎても（録音を続けるときは）同じテンポでクリックを続ける
      const last = A[A.length - 1], bs = (beatTicks(last.time) / TPQ) * (60 / (last.bpm * perf.scale)), per = Math.round(last.full / beatTicks(last.time));
      for (let k = 0; k < per * 200; k++) clicks.push({ start: perf.total + k * bs, accent: k % per === 0, click: true });
    }
    const pre = [];
    for (let k = 0; k < nBeats; k++) pre.push({ start: fromSec - countSec + k * beatSec, accent: k % Math.max(1, Math.round(a0.full / beatTicks(a0.time))) === 0, click: true });
    this.queue = [...pre, ...clicks, ...perf.notes.filter(n => n.start >= fromSec - 1e-6)].sort((a, b) => a.start - b.start);
    // 外部 MIDI 音源：パートごとにチャンネル（ドラムは 10ch）と音色を送っておく
    this.chOf = [];
    if (this.midiOut?.out) {
      let c = 0;
      score.parts.forEach((p, i) => {
        const drum = p.staves.some(st => st.clef === 'percussion');
        this.chOf[i] = drum ? 9 : c;
        if (!drum) { this.midiOut.send([0xc0 | c, (p.program || 0) & 127]); c = c + 1 === 9 ? 10 : (c + 1) % 16; }
        this.midiOut.send([0xb0 | this.chOf[i], 7, Math.round((p.mix?.vol ?? 0.8) * 127)]);
        this.midiOut.send([0xb0 | this.chOf[i], 10, Math.round(((p.mix?.pan ?? 0) + 1) * 63.5)]);
      });
    }
    this.t0 = ctx.currentTime + 0.12 + countSec;
    this.idx = 0;
    this.playing = true;
    this.timer = setInterval(() => this.pump(), 25);
    this.pump();
    const frame = () => {
      if (!this.playing) return;
      const pos = this.position();
      if (pos > perf.total + 0.3 && !opts.keepGoing) { this.stop(); return; }
      if (this.onTick && pos >= fromSec) this.onTick(perf.secToPos(Math.min(pos, perf.total - 1e-6)), pos);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  position() { return this.synth.now - this.t0 + this.fromSec; }

  pump() {
    const horizon = this.position() + 0.25;
    while (this.idx < this.queue.length && this.queue[this.idx].start < horizon) {
      const n = this.queue[this.idx++];
      const when = this.t0 + (n.start - this.fromSec);
      if (n.click) { this.synth.click(when, n.accent); continue; }
      if (this.midiOut?.out) {
        const c = this.chOf[n.p] ?? 0, ms = (w) => performance.now() + (w - this.synth.now) * 1000;
        this.midiOut.send([0x90 | c, n.midi & 127, Math.max(1, Math.round((n.vel ?? DEFAULT_VEL) * 127))], ms(when));
        this.midiOut.send([0x80 | c, n.midi & 127, 64], ms(when + Math.max(0.04, n.end - n.start)));
        continue;
      }
      this.synth.play({ midi: n.midi, program: n.program, sf: n.sf, drum: n.drum, ch: n.p, when, dur: Math.max(0.04, n.end - n.start), vel: n.vel ?? DEFAULT_VEL });
    }
  }

  stop(silent = false) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    this.synth.stopAll();
    if (this.midiOut?.out) { this.midiOut.out.clear?.(); this.midiOut.allOff(); }
    if (this.onStop && !silent) this.onStop();
  }
}

// オーディオ書き出し：演奏をまるごと WAV にする（ネットにつながっていれば高音質サンプルで）
export async function renderWav(score, synth, SynthClass, onProgress) {
  const perf = buildPerformance(score);
  const rate = 44100;
  const len = Math.ceil((perf.total + 2.5) * rate);
  const off = new OfflineAudioContext(2, len, rate);
  const s2 = new SynthClass({ ctx: off, samplesFrom: synth });
  score.parts.forEach((p, i) => s2.setChannel(i, p.mix?.vol ?? 0.8, p.mix?.pan ?? 0));
  const sfs = [...new Set(score.parts.map(p => (INST[p.inst] || {}).sf).filter(Boolean))];
  await Promise.all(sfs.map(s => synth.loadSamples(s)));
  for (const n of perf.notes) s2.play({ midi: n.midi, program: n.program, sf: n.sf, drum: n.drum, ch: n.p, when: n.start + 0.05, dur: Math.max(0.04, n.end - n.start), vel: n.vel ?? DEFAULT_VEL });
  if (onProgress) onProgress(0.5);
  const buf = await off.startRendering();
  return encodeWav(buf);
}
function encodeWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, rate = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let peak = 0;
  for (const d of data) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  const gain = peak > 0.98 ? 0.98 / peak : 1;
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i] * gain)); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

export { DRUM };
