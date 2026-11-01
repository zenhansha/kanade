// 浄書エンジン：楽譜データ → ページごとの SVG
//
// 単位はすべて「譜線間隔（sp）」。五線の高さ = 4sp。SMuFL フォントは 1em = 4sp で設計されている。
// 譜表ローカル座標では、第5線（いちばん上の線）が y=0、第1線が y=4、第3線が y=2。
// 音の位置 pos は「第3線から何段（線と間）上か」。y = 2 - pos/2。
//
// 処理の流れ
//   1. prep      … 各小節・各譜表の音符について、臨時記号・符尾の向き・連桁グループ・幅を決める
//   2. spacing   … 小節ごとに、全譜表の発音タイミング（オンセット）をそろえて横の間隔を決める
//   3. breaking  … 小節を段（システム）に詰め、余りを均等に広げて行の右端をそろえる
//   4. draw      … 段ごとに五線・音符・符尾・連桁・連符・タイを描く（譜表ローカル座標）
//   5. marks     … スラー・強弱・松葉・歌詞・コードネームなどを、音符にぶつからない高さに置く（スカイライン）
//   6. vertical  … 上下にはみ出すものを避けながら譜表の間隔を決め、ページに割り付ける
//
// opts.parts = [p]   パート譜（そのパートだけを表示し、続く休みの小節を1つにまとめる）
// opts.transposed    移調楽器を記譜音で表示（false なら実音＝コンサートピッチ）
import { SMUFL } from '../smufl.js';
import { TPQ, TYPE_FLAGS, CLEFS, keyAlter, diatonic, isCompound, beatTicks } from '../core/music.js';
import { measureAttrs, staffList, clefAt, evTicks, INST } from '../core/score.js';
import { positions } from '../core/edit.js';
import { ARTICS, DYNAMICS, SPANS, JUMPS, parseChord, partTrans, writtenFifths, writtenScore } from '../core/marks.js';

const G = SMUFL.glyphs, D = SMUFL.defaults;
const STEM_W = D.stemThickness, LEDGER_W = D.legerLineThickness, LEDGER_EXT = D.legerLineExtension;
const BEAM_T = D.beamThickness, BEAM_GAP = D.beamThickness + D.beamSpacing;
const LINE_W = D.staffLineThickness, THIN = D.thinBarlineThickness, THICK = D.thickBarlineThickness;
const f = (n) => Math.round(n * 1000) / 1000;
const yOf = (pos) => 2 - pos / 2;
const gw = (name) => (G[name] && G[name].ne ? G[name].ne[0] : 1);
const gh = (name) => (G[name] && G[name].ne ? G[name].ne[1] - G[name].sw[1] : 1);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const HEAD = { breve: 'noteheadDoubleWhole', whole: 'noteheadWhole', half: 'noteheadHalf' };
const REST = { breve: 'restDoubleWhole', whole: 'restWhole', half: 'restHalf', quarter: 'restQuarter', eighth: 'rest8th', '16th': 'rest16th', '32nd': 'rest32nd', '64th': 'rest64th', '128th': 'rest128th' };
const FLAG = ['', '8th', '16th', '32nd', '64th', '128th'];
const ACC = { '-2': 'accidentalDoubleFlat', '-1': 'accidentalFlat', 0: 'accidentalNatural', 1: 'accidentalSharp', 2: 'accidentalDoubleSharp' };
const GS = 0.62;                       // 装飾音符の大きさ（普通の音符に対する比）
const GHW = gw('noteheadBlack') * GS;  // 装飾音符の符頭の幅
const NEAR_ORDER = ['stacc', 'staccss', 'ten', 'acc'];
const LYR = 2.2, CHORD = 2.5, TXT = 2.2;   // 文字の大きさ（sp）
const MR_W = 10;                            // まとめた休み（複数小節休符）の幅

// 音符間の理想的な間隔（長さの 0.6 乗に比例。2倍長い音符でも間隔は約1.5倍）
const ideal = (d) => 1.3 + 2.2 * Math.pow(d / TPQ, 0.6);

function glyph(name, x, y, cls = '', extra = '') {
  return `<text class="g${cls ? ' ' + cls : ''}" x="${f(x)}" y="${f(y)}"${extra}>${G[name].c}</text>`;
}
// グリフの外枠の中心を (xc, yc) に置く
function glyphC(name, xc, yc, cls = '') {
  const g = G[name];
  return glyph(name, xc - (g.ne[0] + g.sw[0]) / 2, yc + (g.ne[1] + g.sw[1]) / 2, cls);
}
function line(x1, y1, x2, y2, w, cls = '', extra = '') {
  return `<line${cls ? ` class="${cls}"` : ''} x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke-width="${f(w)}"${extra}/>`;
}
function poly(pts, cls = '') {
  return `<polygon${cls ? ` class="${cls}"` : ''} points="${pts.map(p => f(p[0]) + ',' + f(p[1])).join(' ')}"/>`;
}
function text(s, x, y, size, extra = '') {
  return `<text class="t" x="${f(x)}" y="${f(y)}" font-size="${size}"${extra}>${esc(s)}</text>`;
}

// 調号の各記号の位置（ト音記号基準）。他の音部記号はずらして使う
const SHARP_POS = [4, 1, 5, 2, -1, 3, 0];
const FLAT_POS = [0, 3, -1, 2, -2, 1, -3];
function keyPositions(fifths, clefKey) {
  const clef = CLEFS[clefKey] || CLEFS.treble;
  let shift = (((34 - clef.mid) % 7) + 7) % 7;
  if (shift > 3) shift -= 7;
  const base = fifths >= 0 ? SHARP_POS : FLAT_POS;
  return base.slice(0, Math.abs(fifths)).map(p => { let q = p + shift; if (q > 5) q -= 7; if (q < -4) q += 7; return q; });
}
function keySigItems(fifths, prevFifths, clefKey, withCancel) {
  // [{glyph, pos}] の並び。調が変わるときは、消える記号にナチュラルを付ける
  const items = [];
  if (withCancel && prevFifths !== 0 && prevFifths !== fifths) {
    const sameSide = Math.sign(prevFifths) === Math.sign(fifths);
    const cancelN = fifths === 0 || !sameSide ? Math.abs(prevFifths) : Math.max(0, Math.abs(prevFifths) - Math.abs(fifths));
    if (cancelN > 0) {
      const pp = keyPositions(prevFifths, clefKey);
      const start = fifths === 0 || !sameSide ? 0 : Math.abs(fifths);
      for (let i = start; i < start + cancelN && i < pp.length; i++) items.push({ g: 'accidentalNatural', pos: pp[i] });
    }
  }
  const g = fifths > 0 ? 'accidentalSharp' : 'accidentalFlat';
  for (const pos of keyPositions(fifths, clefKey)) items.push({ g, pos });
  return items;
}
const keyItemsWidth = (items) => items.reduce((a, it) => a + gw(it.g) + 0.12, 0);

function timeSigGlyphs(time) {
  if (time.symbol === 'common') return { common: 'timeSigCommon' };
  if (time.symbol === 'cut') return { common: 'timeSigCutCommon' };
  return { top: String(time.beats).split('').map(d => 'timeSig' + d), bot: String(time.beatType).split('').map(d => 'timeSig' + d) };
}
function timeSigWidth(time) {
  const t = timeSigGlyphs(time);
  if (t.common) return gw(t.common);
  const w = (arr) => arr.reduce((a, g) => a + gw(g), 0);
  return Math.max(w(t.top), w(t.bot));
}

// ═════════ 1. prep ═════════
function autoUp(posList) {
  const hi = Math.max(...posList), lo = Math.min(...posList);
  return hi + lo < 0;
}

function beamGroups(pes, time) {
  const beat = beatTicks(time);
  const groups = [];
  // 4/4 で拍2つぶんが全部8分音符なら4つまとめて連桁（Finale の初期設定と同じ）
  const halfBarKey = {};
  if (time.beats === 4 && time.beatType === 4) {
    for (let h = 0; h < 2; h++) {
      const inside = pes.filter(pe => pe.start >= h * 2 * TPQ && pe.start < (h + 1) * 2 * TPQ);
      if (inside.length === 4 && inside.every(pe => !pe.rest && pe.type === 'eighth' && !pe.dots && !pe.tuplet)) inside.forEach(pe => (halfBarKey[pe.id] = 'H' + h));
    }
  }
  let cur = null;
  for (const pe of pes) {
    const beamable = !pe.rest && pe.flags > 0;
    if (!beamable) { cur = null; continue; }
    const key = pe.tuplet ? 'T' + pe.tuplet.id : halfBarKey[pe.id] || 'B' + Math.floor(pe.start / beat);
    if (cur && cur.key === key) cur.members.push(pe);
    else { cur = { key, members: [pe] }; groups.push(cur); }
  }
  return groups.filter(g => g.members.length > 1);
}

function prepStaffMeasure(sm, attr, clefKey, prevLast) {
  const clef = CLEFS[clefKey] || CLEFS.treble;
  const active = [];
  sm.voices.forEach((v, i) => { if (v && v.length) active.push(i); });
  const multi = active.length > 1;
  const res = { multi, voices: [] };
  const mapNote = (n, k) => ({ n, k, dn: diatonic(n), pos: diatonic(n) - clef.mid, acc: null, side: 0 });
  for (const v of active) {
    const pes = positions(sm.voices[v]).map(x => {
      const ev = x.ev;
      return {
        id: ev.id, ev, v, start: x.start, end: x.end, rest: ev.rest, mr: !!ev.mr, type: ev.type, dots: ev.dots || 0,
        flags: TYPE_FLAGS[ev.type] || 0, tuplet: ev.tuplet || null,
        notes: ev.rest ? [] : ev.notes.map(mapNote).sort((a, b) => a.pos - b.pos),
        art: ev.art && ev.art.length ? ev.art : null, lyr: ev.lyr || null,
        grace: ev.grace && ev.grace.length && !ev.mr ? ev.grace.map(g => ({ type: g.type, slash: g.slash, flags: Math.max(1, TYPE_FLAGS[g.type] || 1), notes: g.notes.map(mapNote).sort((a, b) => a.pos - b.pos) })) : null,
        up: true, beam: null, prev: null,
      };
    });
    // 前のイベント（タイの続きかどうかの判定用）
    pes.forEach((pe, i) => (pe.prev = i > 0 ? pes[i - 1] : prevLast[v] || null));
    res.voices[v] = pes;
  }
  // 臨時記号：譜表内の全声部を時間順に見て、調号と「その小節で前に付いた記号」から決める（装飾音も含む）
  const all = [];
  for (const v of active) for (const pe of res.voices[v]) if (!pe.rest || pe.grace) all.push(pe);
  all.sort((a, b) => a.start - b.start || a.v - b.v);
  const state = {};
  for (const pe of all) {
    if (pe.grace) for (const g of pe.grace) for (const nt of g.notes) {
      const n = nt.n, key = n.step + n.octave, alt = n.alter || 0;
      const cur = key in state ? state[key] : keyAlter(attr.fifths, n.step);
      if (alt !== cur || n.acc) nt.acc = ACC[alt];
      state[key] = alt;
    }
    for (const nt of pe.notes) {
      const n = nt.n, key = n.step + n.octave, alt = n.alter || 0;
      const cur = key in state ? state[key] : keyAlter(attr.fifths, n.step);
      const tiedIn = pe.prev && !pe.prev.rest && pe.prev.ev.notes.some(q => q.tie && q.step === n.step && q.octave === n.octave && (q.alter || 0) === alt);
      nt.tiedIn = !!tiedIn;
      if (tiedIn) { state[key] = alt; continue; }
      if (alt !== cur || n.acc) nt.acc = ACC[alt];
      state[key] = alt;
    }
  }
  // 符尾の向き・連桁
  for (const v of active) {
    const pes = res.voices[v];
    const groups = beamGroups(pes, attr.time);
    for (const g of groups) {
      const up = multi ? v % 2 === 0 : autoUp(g.members.flatMap(pe => pe.notes.map(n => n.pos)));
      g.up = up; g.v = v;
      g.members.forEach(pe => { pe.beam = g; pe.up = up; });
    }
    res.voices[v].groups = groups;
    for (const pe of pes) {
      if (pe.rest || pe.beam) continue;
      pe.up = multi ? v % 2 === 0 : autoUp(pe.notes.map(n => n.pos));
    }
    for (const pe of pes) finishPE(pe, multi);
  }
  return res;
}

// 2度でぶつかる符頭をずらし、臨時記号の列を決め、左右に必要な幅を計算する
function finishPE(pe, multi) {
  if (pe.rest) {
    const g = pe.mr ? 'restWhole' : REST[pe.type];
    pe.headG = g; pe.headW = gw(g);
    let pos = pe.mr || pe.type === 'whole' || pe.type === 'breve' ? 2 : 0;
    if (multi) pos += pe.v % 2 === 0 ? (pe.mr || pe.type === 'whole' ? 2 : 4) : (pe.mr || pe.type === 'whole' ? -4 : -4);
    pe.restPos = pos;
    pe.leftW = 0;
    pe.rightW = pe.headW + (pe.dots ? 0.3 + pe.dots * 0.5 : 0);
    finishGrace(pe);
    return;
  }
  const headG = HEAD[pe.type] || 'noteheadBlack';
  pe.headG = headG; pe.headW = gw(headG);
  const ns = pe.notes; // 下から順
  const stemless = pe.type === 'whole' || pe.type === 'breve';
  if (pe.up || stemless) {
    for (let i = 1; i < ns.length; i++) if (ns[i].pos - ns[i - 1].pos === 1 && !ns[i - 1].side) ns[i].side = 1;
  } else {
    for (let i = ns.length - 2; i >= 0; i--) if (ns[i + 1].pos - ns[i].pos === 1 && !ns[i + 1].side) ns[i].side = -1;
  }
  const shift = stemless ? pe.headW : pe.headW - STEM_W;
  ns.forEach(n => (n.dx = n.side * shift));
  // 臨時記号の列：上から順に、6度以内に別の記号がない列に入れる
  const cols = [];
  [...ns].reverse().forEach(n => {
    if (!n.acc) return;
    let c = 0;
    while (cols[c] && cols[c].some(o => Math.abs(o.pos - n.pos) < 6)) c++;
    (cols[c] = cols[c] || []).push(n);
    n.col = c;
  });
  const leftDisp = ns.some(n => n.side < 0) ? shift : 0;
  const colW = cols.map(c => Math.max(...c.map(n => gw(n.acc))) + 0.12);
  pe.accRight = []; // 列ごとの右端位置（符頭の左端からの距離）
  let acc = leftDisp + 0.2;
  colW.forEach((w, i) => { pe.accRight[i] = acc; acc += w; });
  ns.forEach(n => { if (n.acc) n.accX = -pe.accRight[n.col] - gw(n.acc); });
  pe.leftW = (cols.length ? acc : 0) + leftDisp;
  const rightDisp = ns.some(n => n.side > 0) ? shift : 0;
  const flagW = !pe.beam && pe.flags && pe.up ? gw('flag8thUp') : 0;
  pe.dotX = pe.headW + rightDisp + 0.3;
  pe.rightW = pe.headW + rightDisp + (pe.dots ? 0.3 + pe.dots * 0.5 : 0) + flagW;
  if (pe.art && pe.art.includes('breath')) pe.rightW += 1.1;
  finishGrace(pe);
}
// 装飾音符の幅：本音符の左（臨時記号のさらに左）に並べる
function finishGrace(pe) {
  pe.leftMain = pe.leftW;
  if (!pe.grace) return;
  let w = 0;
  for (const g of pe.grace) {
    const accs = g.notes.filter(n => n.acc);
    g.accW = accs.length ? Math.max(...accs.map(n => gw(n.acc))) * GS + 0.1 : 0;
    g.w = g.accW + GHW + 0.42;
    w += g.w;
  }
  if (pe.grace.length === 1 && pe.grace[0].flags) w += 0.45;
  pe.graceW = w + 0.15;
  pe.leftW += pe.graceW;
}

// ═════════ メイン ═════════
export function layoutScore(score0, opts = {}) {
  const measureText = opts.measureText || ((s, size) => [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55), 0) * size);
  const showParts = opts.parts && opts.parts.length ? opts.parts : null;
  const score = opts.transposed ? writtenScore(score0) : score0;
  const A = measureAttrs(score);
  const SL = staffList(score).filter(row => !showParts || showParts.includes(row.p));
  const M = score.measures.length;
  const spMm = score.settings.staffMm / 4;
  const pageW = score.settings.page.w / spMm, pageH = score.settings.page.h / spMm;
  const mg = { t: score.settings.margin.t / spMm, b: score.settings.margin.b / spMm, l: score.settings.margin.l / spMm, r: score.settings.margin.r / spMm };
  const shown = showParts ? showParts.map(p => score.parts[p]) : score.parts;

  // 記譜音で表示するときは、移調楽器の譜表だけ調号が変わる
  const rowTrans = SL.map(row => (opts.transposed ? partTrans(score0.parts[row.p]) : null));
  const fifthsR = (r, m) => writtenFifths(A[m].fifths, rowTrans[r]);
  const prevFifthsR = (r, m) => writtenFifths(A[m].prevFifths, rowTrans[r]);
  const attrR = (r, m) => (rowTrans[r] ? { ...A[m], fifths: fifthsR(r, m), prevFifths: prevFifthsR(r, m) } : A[m]);
  const keyW = (m, withCancel) => Math.max(0, ...SL.map((row, r) => keyItemsWidth(keySigItems(fifthsR(r, m), prevFifthsR(r, m), 'treble', withCancel))));

  // ── 1. prep ──
  const prep = []; // prep[m][row]
  const clefs = []; // clefs[m][row]
  const prevLast = SL.map(() => ({}));
  for (let m = 0; m < M; m++) {
    prep[m] = []; clefs[m] = [];
    SL.forEach((row, r) => {
      const ck = clefAt(row.staff, m);
      clefs[m][r] = ck;
      const sm = row.staff.measures[m];
      const pr = prepStaffMeasure(sm, attrR(r, m), ck, prevLast[r]);
      prep[m][r] = pr;
      pr.voices.forEach((pes, v) => { if (pes && pes.length) prevLast[r][v] = pes[pes.length - 1]; });
      // 使われていない声部は「前の最後」を消す（タイの誤判定を防ぐ）
      for (const v of Object.keys(prevLast[r])) if (!pr.voices[v]) delete prevLast[r][v];
    });
  }

  // ── 2. spacing ──
  const MS = []; // 小節ごとの横配置
  for (let m = 0; m < M; m++) {
    const on = new Map();
    let allMr = true;
    prep[m].forEach(pr => pr.voices.forEach(pes => pes && pes.forEach(pe => {
      if (pe.mr) return;
      allMr = false;
      const o = on.get(pe.start) || { t: pe.start, leftW: 0, rightW: 0 };
      o.leftW = Math.max(o.leftW, pe.leftW); o.rightW = Math.max(o.rightW, pe.rightW);
      // 歌詞は符頭の中央にそろえるので、長い単語のぶんだけ左右を空ける
      if (pe.lyr) for (const ly of pe.lyr) {
        if (!ly || !ly.t) continue;
        const half = measureText(ly.t, LYR) / 2;
        o.leftW = Math.max(o.leftW, half - pe.headW / 2 + 0.15);
        o.rightW = Math.max(o.rightW, half + pe.headW / 2 + (ly.h ? 0.9 : 0.3));
      }
      on.set(pe.start, o);
    })));
    // コードネームが次のコードとぶつからないように
    SL.forEach(row => (row.staff.measures[m].dirs || []).forEach(d => {
      if (d.k !== 'chord') return;
      const o = on.get(d.t);
      if (o) o.rightW = Math.max(o.rightW, chordWidth(d.text) + 0.8);
    }));
    const len = A[m].len;
    let ons = [...on.values()].sort((a, b) => a.t - b.t);
    if (!ons.length) ons = [{ t: 0, leftW: 0, rightW: 0 }];
    const xs = [], ideals = [];
    let x = ons[0].leftW;
    ons.forEach((o, i) => {
      xs.push(x);
      const nextT = i + 1 < ons.length ? ons[i + 1].t : len;
      const id = ideal(nextT - o.t);
      ideals.push(id);
      const need = i + 1 < ons.length ? o.rightW + ons[i + 1].leftW + 0.45 : o.rightW + 0.9;
      x += Math.max(id, need);
    });
    let cw = x;
    if (allMr) cw = Math.max(cw, 8);
    if (score.measures[m].repeatEnd) cw += 1.4;
    const startPad = 1.1 + (score.measures[m].repeatStart ? 1.5 : 0);
    MS[m] = { ons: ons.map((o, i) => ({ t: o.t, x: xs[i] })), ideals, cw, startPad, allMr };
  }
  // 段の途中で拍子・調・音部記号が変わる小節の頭に必要な幅
  const chgW = (m) => {
    if (m === 0) return 0;
    let w = 0;
    if (SL.some((row) => row.staff.measures[m]?.clef)) w += 2.4;
    if (score.measures[m].key) w += keyW(m, true) + 0.6;
    if (score.measures[m].time) w += timeSigWidth(A[m].time) + 0.8;
    return w;
  };
  const sysHeader = (m) => {
    const clefW = Math.max(...SL.map((row, r) => gw(CLEFS[clefs[m][r]]?.glyph || 'gClef')));
    let w = 0.7 + clefW + 0.9;
    const kw = keyW(m, m > 0 && !!score.measures[m].key);
    if (kw) w += kw + 0.6;
    if (A[m].timeChanged) w += timeSigWidth(A[m].time) + 0.9;
    return w;
  };

  // パート譜：何もない休みの小節が続くところは1つの「複数小節休符」にまとめる
  const mrGroups = {};
  if (showParts && opts.multiRest !== false) {
    const plain = (m) => SL.every(row => {
      const sm = row.staff.measures[m];
      return sm.voices.length === 1 && sm.voices[0].length === 1 && sm.voices[0][0].mr && !sm.dirs?.length && !sm.spans?.length && !sm.voices[0][0].art;
    }) && !['repeatStart', 'repeatEnd', 'ending', 'segno', 'coda', 'fine', 'toCoda', 'jump'].some(k => score.measures[m][k]);
    // 途中で拍子・調・テンポ・音部記号が変わる小節は、まとまりの先頭にしかなれない
    const changes = (m) => !!(score.measures[m].time || score.measures[m].key || score.measures[m].tempo || SL.some(row => row.staff.measures[m].clef));
    let m = 0;
    while (m < M) {
      if (!plain(m)) { m++; continue; }
      let j = m + 1;
      while (j < M && plain(j) && !changes(j) && !score.measures[j - 1].barline) j++;
      if (j - m >= 2) { const g = { first: m, last: j - 1, count: j - m }; for (let q = m; q < j; q++) mrGroups[q] = g; }
      m = j;
    }
  }

  // ── 3. breaking（改段） ──
  const nameSize = 2.0;
  const multiPart = shown.length > 1;
  const hasBrace = shown.some(p => p.staves.length > 1);
  const bracketW = (multiPart ? 1.6 : 0) + (hasBrace ? 1.4 : 0);
  const fullNameW = showParts ? 0 : Math.max(0, ...shown.map(p => measureText(p.name, nameSize)));
  const abbrW = multiPart && !showParts ? Math.max(0, ...shown.map(p => measureText(p.abbr, nameSize))) : 0;
  const indent0 = (fullNameW ? fullNameW + 1.6 : showParts ? 3 : 0) + bracketW;
  const indentN = (abbrW ? abbrW + 1.6 : 0) + bracketW;
  const right = pageW - mg.r;
  const systems = [];
  const unitW = (j, i) => {
    const g = mrGroups[j];
    return MS[j].startPad + (g ? MR_W : MS[j].cw) + (j > i ? chgW(j) : 0);
  };
  for (let i = 0; i < M;) {
    const x0 = mg.l + (systems.length === 0 ? indent0 : indentN);
    const hdr = sysHeader(i);
    const avail = right - x0 - hdr;
    const ms = [];
    let used = 0;
    let j = i;
    while (j < M) {
      const w = unitW(j, i);
      if (ms.length && used + w > avail) break;
      const g = mrGroups[j];
      if (g) { for (let q = g.first; q <= g.last; q++) ms.push(q); j = g.last + 1; } else { ms.push(j); j++; }
      used += w;
      if (!showParts && score.measures[j - 1].sysBreak) break;
    }
    systems.push({ x0, x1: right, hdr, ms, used, avail, first: i });
    i = j;
  }
  // 右端をそろえる（最後の段は短ければ詰めたまま）
  systems.forEach((sy, k) => {
    const last = k === systems.length - 1;
    let extra = sy.avail - sy.used;
    if (last && sy.used < sy.avail * 0.6) extra = 0;
    if (extra < 0) extra = 0;
    let x = sy.x0 + sy.hdr;
    let firstUnit = true;
    sy.ms.forEach((m) => {
      const g = mrGroups[m];
      if (g && m !== g.first) { MS[m].geo = { ...MS[g.first].geo, grp: g }; return; }
      const ms = MS[m];
      const nat = ms.startPad + (g ? MR_W : ms.cw);
      const add = (extra * nat) / sy.used;
      const sumIdeal = ms.ideals.reduce((a, b) => a + b, 0);
      const c = !firstUnit ? chgW(m) : 0;
      const xStart = x;
      const cx = x + c + ms.startPad;
      let shift = 0;
      const ons = ms.ons.map((o, i) => { const r = { t: o.t, x: cx + o.x + shift }; shift += (add * ms.ideals[i]) / sumIdeal; return r; });
      const w = c + nat + add;
      ms.geo = { sys: k, x0: xStart, x1: xStart + w, cx, ons, len: A[m].len, chg: c, grp: g || null };
      x += w;
      firstUnit = false;
    });
  });

  // ── 4. draw ──
  const evGeom = {};
  const rowsOut = systems.map(() => SL.map(() => ({ s: [], top: -1, bot: 5 })));
  const ext = (k, r, top, bot) => { const o = rowsOut[k][r]; o.top = Math.min(o.top, top); o.bot = Math.max(o.bot, bot); };
  // スカイライン：置いたものの外枠。あとから置く記号は、この上（下）にぶつからない高さを探す
  const sky = systems.map(() => SL.map(() => []));
  const box = (k, r, x0, x1, top, bot) => { sky[k][r].push({ x0, x1, t: top, b: bot }); ext(k, r, top, bot); };
  const skyTop = (k, r, x0, x1) => { let y = 0; for (const b of sky[k][r]) if (b.x1 > x0 && b.x0 < x1) y = Math.min(y, b.t); return y; };
  const skyBot = (k, r, x0, x1) => { let y = 4; for (const b of sky[k][r]) if (b.x1 > x0 && b.x0 < x1) y = Math.max(y, b.b); return y; };
  const tieReqs = [];
  const onsetMap = new Map(); // `${r}:${m}:${t}` → その位置の音符たち
  const marks = []; // 選べる記号の位置（強弱・線・歌詞など）

  systems.forEach((sy, k) => {
    const m0 = sy.ms[0];
    SL.forEach((row, r) => {
      const out = rowsOut[k][r].s;
      // 五線
      let d = '';
      for (let i = 0; i < 5; i++) d += `M${f(sy.x0)} ${i}H${f(MS[sy.ms[sy.ms.length - 1]].geo.x1)}`;
      out.push(`<path class="staff" d="${d}" stroke-width="${LINE_W}"/>`);
      // 段の頭：音部記号・調号・拍子
      let hx = sy.x0 + 0.7;
      const ck = clefs[m0][r];
      const ci = CLEFS[ck] || CLEFS.treble;
      out.push(glyph(ci.glyph, hx, yOf(ci.glyphPos)));
      hx += gw(ci.glyph) + 0.9;
      const ks = keySigItems(fifthsR(r, m0), prevFifthsR(r, m0), ck, m0 > 0 && !!score.measures[m0].key);
      if (ks.length) { for (const it of ks) { out.push(glyph(it.g, hx, yOf(it.pos))); hx += gw(it.g) + 0.12; } hx += 0.6; }
      if (A[m0].timeChanged) drawTime(out, A[m0].time, hx);

      sy.ms.forEach((m, idx) => {
        const geo = MS[m].geo;
        if (geo.grp && m !== geo.grp.first) { groupGeom(k, r, row, m, geo); return; }
        // 段の途中の変更
        if (idx > 0 && geo.chg) {
          let x = geo.x0 + 0.5;
          const sm = row.staff.measures[m];
          if (sm.clef) { const c2 = CLEFS[sm.clef]; out.push(glyph(c2.glyph, x, yOf(c2.glyphPos), 'gs')); }
          if (SL.some(rr => rr.staff.measures[m]?.clef)) x += 2.4;
          if (score.measures[m].key) {
            for (const it of keySigItems(fifthsR(r, m), prevFifthsR(r, m), clefs[m][r], true)) { out.push(glyph(it.g, x, yOf(it.pos))); x += gw(it.g) + 0.12; }
            x += 0.6;
          }
          if (score.measures[m].time) drawTime(out, A[m].time, x);
        }
        if (geo.grp) { drawMultiRest(out, k, r, row, m, geo); return; }
        drawMeasure(out, k, r, row, m, geo);
      });
    });
  });

  function drawTime(out, time, x) {
    const t = timeSigGlyphs(time);
    if (t.common) { out.push(glyph(t.common, x, 2)); return; }
    const w = timeSigWidth(time);
    const put = (arr, y) => {
      let tw = arr.reduce((a, g) => a + gw(g), 0);
      let xx = x + (w - tw) / 2;
      for (const g of arr) { out.push(glyph(g, xx, y)); xx += gw(g); }
    };
    put(t.top, 1); put(t.bot, 3);
  }

  function onsetX(geo, t) {
    const o = geo.ons.find(q => q.t === t);
    if (o) return o.x;
    // 見つからない（他の譜表にない位置）ときは補間
    let a = geo.ons[0], b = null;
    for (const q of geo.ons) { if (q.t <= t) a = q; else { b = q; break; } }
    const bx = b ? b.x : geo.x1 - 1, bt = b ? b.t : geo.len;
    return a.x + ((t - a.t) / Math.max(1, bt - a.t)) * (bx - a.x);
  }

  // まとめた休み：太い横棒と小節数
  function drawMultiRest(out, k, r, row, m, geo) {
    const g = geo.grp;
    const xa = geo.cx + 0.6, xb = geo.x1 - 1.6;
    const s = [];
    s.push(`<rect x="${f(xa)}" y="1.45" width="${f(xb - xa)}" height="1.1"/>`);
    s.push(line(xa, 1, xa, 3, THIN * 1.4), line(xb, 1, xb, 3, THIN * 1.4));
    const digits = String(g.count).split('').map(dg => 'timeSig' + dg);
    let xx = (xa + xb) / 2 - digits.reduce((a, d) => a + gw(d), 0) / 2;
    if (r === 0 || !SL.slice(0, r).some(rr => rr.p === row.p)) for (const dg of digits) { s.push(glyph(dg, xx, -1.4)); xx += gw(dg); }
    const ev = row.staff.measures[m].voices[0][0];
    out.push(`<g class="ev v0" data-id="${ev.id}">${s.join('')}</g>`);
    box(k, r, xa, xb, -2.6, 4);
    groupGeom(k, r, row, m, geo);
  }
  function groupGeom(k, r, row, m, geo) {
    const ev = row.staff.measures[m].voices[0][0];
    evGeom[ev.id] = { id: ev.id, k, r, p: row.p, s: row.s, m, v: 0, t: 0, x: geo.cx, xr: geo.x1 - 1.6, top: 0, bot: 4, notes: [], up: true, rest: true };
  }

  function drawMeasure(out, k, r, row, m, geo) {
    const pr = prep[m][r];
    pr.voices.forEach((pes, v) => {
      if (!pes) return;
      for (const pe of pes) drawEvent(out, k, r, row, m, geo, pe);
      for (const g of pes.groups || []) drawBeam(out, k, r, g);
      drawArtics(out, k, r, pes, pr.multi);
      drawTuplets(out, k, r, pes);
    });
  }

  function drawEvent(out, k, r, row, m, geo, pe) {
    const cls = `ev v${pe.v}`;
    const x = pe.mr ? (geo.x0 + geo.x1) / 2 - pe.headW / 2 + (geo.chg ? geo.chg / 2 : 0) : onsetX(geo, pe.start);
    const g = [];
    const geom = { id: pe.id, k, r, p: row.p, s: row.s, m, v: pe.v, t: pe.start, x, xr: x + pe.headW, top: 0, bot: 4, notes: [], up: pe.up, rest: pe.rest };
    if (pe.rest) {
      const y = yOf(pe.restPos);
      g.push(glyph(pe.headG, x, y));
      const bb = G[pe.headG];
      geom.top = y - bb.ne[1]; geom.bot = y - bb.sw[1];
      if (pe.dots) { let dx = x + pe.headW + 0.3; const dy = yOf(pe.restPos % 2 === 0 ? pe.restPos + 1 : pe.restPos); for (let i = 0; i < pe.dots; i++) { g.push(glyph('augmentationDot', dx, dy)); dx += 0.5; } }
    } else {
      const ns = pe.notes;
      const top = ns[ns.length - 1].pos, bot = ns[0].pos;
      // 加線
      const minX = x + Math.min(0, ...ns.map(n => n.dx)) - LEDGER_EXT, maxX = x + pe.headW + Math.max(0, ...ns.map(n => n.dx)) + LEDGER_EXT;
      for (let L = 6; L <= top; L += 2) g.push(line(minX, yOf(L), maxX, yOf(L), LEDGER_W, 'ledger'));
      for (let L = -6; L >= bot; L -= 2) g.push(line(minX, yOf(L), maxX, yOf(L), LEDGER_W, 'ledger'));
      for (const n of ns) {
        const y = yOf(n.pos);
        g.push(glyph(pe.headG, x + n.dx, y));
        if (n.acc) g.push(glyph(n.acc, x + n.accX, y));
        geom.notes.push({ pos: n.pos, y, hx: x + n.dx, k: n.k, n: n.n });
      }
      if (pe.dots) {
        const seen = new Set();
        for (const n of ns) {
          let dp = n.pos % 2 === 0 ? n.pos + (pe.v % 2 === 1 && prep[m][r].multi ? -1 : 1) : n.pos;
          if (seen.has(dp)) continue; seen.add(dp);
          let dx = x + pe.dotX;
          for (let i = 0; i < pe.dots; i++) { g.push(glyph('augmentationDot', dx, yOf(dp))); dx += 0.5; }
        }
      }
      geom.top = Math.min(yOf(top) - 0.5, geom.top);
      geom.bot = Math.max(yOf(bot) + 0.5, geom.bot);
      geom.headTop = yOf(top) - 0.5; geom.headBot = yOf(bot) + 0.5;
      // 符尾と旗（連桁がある音符は drawBeam で描く）
      if (pe.type !== 'whole' && pe.type !== 'breve' && !pe.beam) {
        const a = G[pe.headG].a;
        const extra = pe.flags > 2 ? (pe.flags - 2) * 0.75 : 0;
        if (pe.up) {
          const sx = x + a.stemUpSE[0] - STEM_W / 2;
          const y1 = yOf(bot) - a.stemUpSE[1];
          const y2 = Math.min(yOf(top) - 3.5 - extra, 2);
          g.push(line(sx, y1, sx, y2, STEM_W, 'stem'));
          if (pe.flags) { const fg = 'flag' + FLAG[pe.flags] + 'Up'; const an = G[fg].a.stemUpNW; g.push(glyph(fg, sx - STEM_W / 2 - an[0], y2 + an[1])); }
          geom.top = Math.min(geom.top, y2);
          geom.stemX = sx; geom.stemEnd = y2;
        } else {
          const sx = x + a.stemDownNW[0] + STEM_W / 2;
          const y1 = yOf(top) - a.stemDownNW[1];
          const y2 = Math.max(yOf(bot) + 3.5 + extra, 2);
          g.push(line(sx, y1, sx, y2, STEM_W, 'stem'));
          if (pe.flags) { const fg = 'flag' + FLAG[pe.flags] + 'Down'; const an = G[fg].a.stemDownSW; g.push(glyph(fg, sx - STEM_W / 2 - an[0], y2 + an[1])); }
          geom.bot = Math.max(geom.bot, y2);
          geom.stemX = sx; geom.stemEnd = y2;
        }
      }
      // タイ
      ns.forEach(n => { if (n.n.tie) tieReqs.push({ from: pe, note: n, k, r }); });
    }
    let x0 = x - pe.leftMain;
    if (pe.grace) x0 = drawGrace(g, pe, x, geom);
    out.push(`<g class="${cls}" data-id="${pe.id}">${g.join('')}</g>`);
    if (!pe.mr) box(k, r, x0, x + pe.rightW, geom.top, geom.bot);
    else ext(k, r, geom.top, geom.bot);
    geom.x0 = x0;
    evGeom[pe.id] = geom;
    pe.geom = geom;
    const key = `${r}:${m}:${pe.start}`;
    if (!onsetMap.has(key)) onsetMap.set(key, []);
    onsetMap.get(key).push(pe);
  }

  // 装飾音符：小さい音符を符尾上向きで。1つなら旗（＋斜線）、2つ以上なら連桁でつなぐ
  function drawGrace(g, pe, x, geom) {
    const startX = x - pe.leftMain - pe.graceW + 0.05;
    let gx = startX;
    const heads = [];
    const an = G.noteheadBlack.a.stemUpSE;
    const sw = STEM_W * 0.85;
    for (const c of pe.grace) {
      gx += c.accW;
      const top = c.notes[c.notes.length - 1].pos, bot = c.notes[0].pos;
      for (let L = 6; L <= top; L += 2) g.push(line(gx - 0.25, yOf(L), gx + GHW + 0.25, yOf(L), LEDGER_W * 0.8, 'ledger'));
      for (let L = -6; L >= bot; L -= 2) g.push(line(gx - 0.25, yOf(L), gx + GHW + 0.25, yOf(L), LEDGER_W * 0.8, 'ledger'));
      for (const nt of c.notes) {
        g.push(glyph('noteheadBlack', gx, yOf(nt.pos), 'gg'));
        if (nt.acc) g.push(glyph(nt.acc, gx - 0.08 - gw(nt.acc) * GS, yOf(nt.pos), 'gg'));
      }
      const sx = gx + an[0] * GS - sw / 2;
      heads.push({ sx, y1: yOf(bot) - an[1] * GS, y2: Math.min(yOf(top) - 2.5, 3), c });
      geom.top = Math.min(geom.top, yOf(top) - 2.6);
      geom.bot = Math.max(geom.bot, yOf(bot) + 0.4);
      gx += GHW + 0.42;
    }
    if (heads.length === 1) {
      const h = heads[0];
      g.push(line(h.sx, h.y1, h.sx, h.y2, sw, 'stem'));
      const fl = Math.min(h.c.flags, 5);
      if (fl) {
        const fg = 'flag' + FLAG[fl] + 'Up';
        const a = G[fg].a.stemUpNW;
        g.push(glyph(fg, h.sx - sw / 2 - a[0] * GS, h.y2 + a[1] * GS, 'gg'));
      }
      if (h.c.slash) g.push(line(h.sx - 0.55, h.y2 + 1.45, h.sx + 0.75, h.y2 + 0.55, 0.11, 'stem'));
    } else {
      const by = Math.min(...heads.map(h => h.y2));
      for (const h of heads) g.push(line(h.sx, h.y1, h.sx, by, sw, 'stem'));
      const x1 = heads[0].sx - sw / 2, x2 = heads[heads.length - 1].sx + sw / 2;
      const nb = Math.min(3, Math.min(...heads.map(h => h.c.flags)));
      for (let i = 0; i < nb; i++) { const y = by + i * BEAM_GAP * GS; g.push(poly([[x1, y], [x2, y], [x2, y + BEAM_T * GS], [x1, y + BEAM_T * GS]], 'beam')); }
      geom.top = Math.min(geom.top, by);
      if (heads[0].c.slash) g.push(line(heads[0].sx - 0.5, by + 1.5, heads[0].sx + 0.8, by + 0.3, 0.11, 'stem'));
    }
    return startX - 0.1;
  }

  function drawBeam(out, k, r, grp) {
    const mem = grp.members;
    const up = grp.up;
    const pts = mem.map(pe => {
      const a = G[pe.headG].a;
      const x = pe.geom.x;
      const ns = pe.notes;
      const sx = up ? x + a.stemUpSE[0] - STEM_W / 2 : x + a.stemDownNW[0] + STEM_W / 2;
      const near = up ? yOf(ns[ns.length - 1].pos) : yOf(ns[0].pos);
      const far = up ? yOf(ns[0].pos) - a.stemUpSE[1] : yOf(ns[ns.length - 1].pos) - a.stemDownNW[1];
      return { pe, sx, near, far };
    });
    const maxFlags = Math.max(...mem.map(pe => pe.flags));
    const L = 3.25 + Math.max(0, maxFlags - 2) * BEAM_GAP;
    const first = pts[0], last = pts[pts.length - 1];
    let dy = last.near - first.near;
    // 内側の音が両端より外にはみ出す（山なり・谷なり）なら水平にする
    const inner = pts.slice(1, -1);
    if (up && inner.some(p => p.near < Math.min(first.near, last.near))) dy = 0;
    if (!up && inner.some(p => p.near > Math.max(first.near, last.near))) dy = 0;
    dy = Math.max(-1, Math.min(1, dy));
    const dx = Math.max(0.01, last.sx - first.sx);
    const slope = dy / dx;
    let b;
    if (up) {
      b = Math.min(...pts.map(p => p.near - L - slope * (p.sx - first.sx)));
      b = Math.min(b, ...pts.map(p => 2 - slope * (p.sx - first.sx) + (p.near > 2 ? 0 : 99)));
    } else {
      b = Math.max(...pts.map(p => p.near + L - slope * (p.sx - first.sx)));
      b = Math.max(b, ...pts.map(p => 2 - slope * (p.sx - first.sx) - (p.near < 2 ? 0 : 99)));
    }
    const by = (x) => b + slope * (x - first.sx);
    const g = [];
    for (const p of pts) {
      const s = line(p.sx, p.far, p.sx, by(p.sx), STEM_W, 'stem');
      g.push(`<g class="ev v${p.pe.v}" data-id="${p.pe.id}">${s}</g>`);
      p.pe.geom.stemX = p.sx; p.pe.geom.stemEnd = by(p.sx);
      if (up) p.pe.geom.top = Math.min(p.pe.geom.top, by(p.sx)); else p.pe.geom.bot = Math.max(p.pe.geom.bot, by(p.sx));
    }
    const sgn = up ? 1 : -1;
    const beamPoly = (x1, x2, off) => {
      const y1 = by(x1) + sgn * off, y2 = by(x2) + sgn * off;
      return up ? poly([[x1, y1], [x2, y2], [x2, y2 + BEAM_T], [x1, y1 + BEAM_T]], 'beam') : poly([[x1, y1 - BEAM_T], [x2, y2 - BEAM_T], [x2, y2], [x1, y1]], 'beam');
    };
    g.push(beamPoly(first.sx - STEM_W / 2, last.sx + STEM_W / 2, 0));
    for (let lev = 2; lev <= maxFlags; lev++) {
      const off = (lev - 1) * BEAM_GAP;
      let i = 0;
      while (i < pts.length) {
        if (pts[i].pe.flags < lev) { i++; continue; }
        let j = i;
        while (j + 1 < pts.length && pts[j + 1].pe.flags >= lev) j++;
        if (j > i) g.push(beamPoly(pts[i].sx - STEM_W / 2, pts[j].sx + STEM_W / 2, off));
        else {
          // 1つだけ：短い「部分連桁」。最後の音なら左向き、それ以外は右向き
          const left = i === pts.length - 1;
          const xA = left ? pts[i].sx - 1.1 : pts[i].sx - STEM_W / 2;
          const xB = left ? pts[i].sx + STEM_W / 2 : pts[i].sx + 1.1;
          g.push(beamPoly(xA, xB, off));
        }
        i = j + 1;
      }
    }
    out.push(`<g class="beamgrp v${grp.v}">${g.join('')}</g>`);
    const ys = pts.map(p => by(p.sx));
    const deep = (maxFlags - 1) * BEAM_GAP + BEAM_T;
    if (up) box(k, r, first.sx - 0.2, last.sx + 0.2, Math.min(...ys) - 0.2, Math.max(...ys) + deep);
    else box(k, r, first.sx - 0.2, last.sx + 0.2, Math.min(...ys) - deep, Math.max(...ys) + 0.2);
    grp.beamY = by;
    grp.yMin = Math.min(...ys); grp.yMax = Math.max(...ys);
  }

  // アーティキュレーション：スタッカートなどは符頭側（符尾の反対）、フェルマータや装飾記号は譜表の上
  function drawArtics(out, k, r, pes, multi) {
    for (const pe of pes) {
      if (!pe.art || !pe.geom || pe.mr && !pe.art.includes('ferm')) continue;
      const gm = pe.geom;
      const s = [];
      const xc = gm.x + pe.headW / 2;
      const near = pe.rest ? [] : pe.art.filter(a => ARTICS[a]?.side === 'note').sort((a, b) => NEAR_ORDER.indexOf(a) - NEAR_ORDER.indexOf(b));
      const far = pe.art.filter(a => ARTICS[a]?.side === 'above');
      const below = multi ? pe.v % 2 === 1 : pe.rest ? false : pe.up;
      if (near.length) {
        let y;
        if (multi && !pe.rest) y = below ? Math.max(gm.stemEnd ?? gm.headBot, gm.headBot) + 0.75 : Math.min(gm.stemEnd ?? gm.headTop, gm.headTop) - 0.75;
        else y = below ? gm.headBot + 0.55 : gm.headTop - 0.55;
        for (const a of near) {
          const gname = ARTICS[a].g + (below ? 'Below' : 'Above');
          const h = gh(gname);
          let yc = below ? y + h / 2 : y - h / 2;
          if ((a === 'stacc' || a === 'staccss' || a === 'ten') && yc > 0 && yc < 4) {
            yc = below ? Math.ceil(yc - 0.5) + 0.5 : Math.floor(yc - 0.5) + 0.5;
          } else if (a === 'acc') yc = below ? Math.max(yc, 4.7) : Math.min(yc, -0.7);
          s.push(glyphC(gname, xc, yc));
          box(k, r, xc - gw(gname) / 2, xc + gw(gname) / 2, yc - h / 2, yc + h / 2);
          y = below ? yc + h / 2 + 0.3 : yc - h / 2 - 0.3;
        }
      }
      const farBelow = multi && pe.v % 2 === 1;
      for (const a of far) {
        const gname = a === 'ferm' ? (farBelow ? 'fermataBelow' : 'fermataAbove') : a === 'marc' ? (farBelow ? 'articMarcatoBelow' : 'articMarcatoAbove') : ARTICS[a].g;
        const w = gw(gname), h = gh(gname);
        const x0 = xc - w / 2, x1 = xc + w / 2;
        if (farBelow) {
          const top = skyBot(k, r, x0, x1) + 0.5;
          s.push(glyphC(gname, xc, top + h / 2));
          box(k, r, x0, x1, top, top + h);
        } else {
          const bot = Math.min(-0.3, skyTop(k, r, x0, x1)) - 0.5;
          s.push(glyphC(gname, xc, bot - h / 2));
          box(k, r, x0, x1, bot - h, bot);
        }
      }
      if (pe.art.includes('breath')) {
        const bx = gm.x + pe.rightW - 0.9;
        s.push(glyph('breathMarkComma', bx, -0.5));
        box(k, r, bx, bx + 0.7, -1.6, -0.4);
      }
      if (s.length) out.push(`<g class="ev v${pe.v}" data-id="${pe.id}">${s.join('')}</g>`);
    }
  }

  function drawTuplets(out, k, r, pes) {
    const seen = new Map();
    for (const pe of pes) if (pe.tuplet) { if (!seen.has(pe.tuplet.id)) seen.set(pe.tuplet.id, []); seen.get(pe.tuplet.id).push(pe); }
    for (const [, mem] of seen) {
      const t = mem[0].tuplet;
      const notes = mem.filter(pe => !pe.rest);
      const up = notes.length ? notes.filter(pe => pe.up).length * 2 >= notes.length : true;
      const x1 = mem[0].geom.x, x2 = mem[mem.length - 1].geom.xr;
      const sameBeam = mem.every(pe => pe.beam && pe.beam === mem[0].beam) && mem[0].beam.members.length === mem.length;
      let y;
      if (up) y = Math.min(-0.5, skyTop(k, r, x1, x2)) - 1.2;
      else y = Math.max(4.5, skyBot(k, r, x1, x2)) + 1.2;
      const digits = String(t.actual).split('').map(dg => 'tuplet' + dg);
      const nw = digits.reduce((a, g) => a + gw(g), 0);
      const cx = (x1 + x2) / 2;
      let xx = cx - nw / 2;
      const s = [];
      for (const dg of digits) { s.push(glyph(dg, xx, y + 0.75)); xx += gw(dg); }
      if (!sameBeam) {
        const hook = up ? 0.7 : -0.7;
        const gap = nw / 2 + 0.4;
        s.push(`<path class="tbr" d="M${f(x1)} ${f(y + hook)}V${f(y)}H${f(cx - gap)}M${f(cx + gap)} ${f(y)}H${f(x2)}V${f(y + hook)}" stroke-width="0.13" fill="none"/>`);
      }
      out.push(`<g class="tuplet v${mem[0].v}">${s.join('')}</g>`);
      box(k, r, x1, x2, up ? y - 0.8 : y - 0.8, up ? y + 0.8 : y + 0.8);
    }
  }

  // ── タイ（次の音が別の段にあることもあるので最後にまとめて描く） ──
  const nextOf = {};
  for (let r = 0; r < SL.length; r++) {
    const lastByV = {};
    for (let m = 0; m < M; m++) prep[m][r].voices.forEach((pes, v) => {
      if (!pes) return;
      for (const pe of pes) { if (lastByV[v]) nextOf[lastByV[v].id] = pe; lastByV[v] = pe; }
    });
  }
  for (const req of tieReqs) {
    const from = req.from, n = req.note.n;
    const to = nextOf[from.id];
    if (!to || to.rest) continue;
    const tn = to.notes.find(q => q.n.step === n.step && q.n.octave === n.octave && (q.n.alter || 0) === (n.alter || 0));
    if (!tn) continue;
    const fg = from.geom, tg = to.geom;
    if (!fg || !tg) continue;
    // 向き：和音なら上半分は上向き、下半分は下向き。単音なら符尾と反対
    const ns = from.notes;
    const idx = ns.indexOf(req.note);
    let upCurve;
    if (ns.length > 1) upCurve = idx >= ns.length / 2;
    else upCurve = !from.up;
    if (prep[fg.m][fg.r].multi) upCurve = from.v % 2 === 0;
    const y = yOf(req.note.pos);
    const xa = fg.x + req.note.dx + from.headW + 0.15;
    if (tg.k === fg.k) {
      const xb = tg.x + tn.dx - 0.15;
      rowsOut[fg.k][fg.r].s.push(tiePath(xa, xb, y, upCurve));
    } else {
      const sysA = systems[fg.k], sysB = systems[tg.k];
      rowsOut[fg.k][fg.r].s.push(tiePath(xa, sysA.x1 - 0.4, y, upCurve));
      rowsOut[tg.k][tg.r].s.push(tiePath(sysB.x0 + sysB.hdr - 0.4, tg.x + tn.dx - 0.15, y, upCurve));
    }
  }
  function tiePath(x1, x2, y, upCurve) {
    const w = Math.max(0.5, x2 - x1);
    const h = Math.min(2.0, 0.55 + w * 0.06) * (upCurve ? -1 : 1);
    const y0 = y + (upCurve ? -0.55 : 0.55);
    return curve(x1, y0, x2, y0, h, 0.18);
  }
  // 両端が (x1,y1)-(x2,y2) で、中央が h だけふくらむ三日月形（タイ・スラー共通）
  function curve(x1, y1, x2, y2, h, thick, cls = 'tie') {
    const w = x2 - x1;
    const c1 = x1 + w * 0.22, c2 = x2 - w * 0.22;
    const th = thick * Math.sign(h || 1);
    return `<path class="${cls}" d="M${f(x1)} ${f(y1)}C${f(c1)} ${f(y1 + h)} ${f(c2)} ${f(y2 + h)} ${f(x2)} ${f(y2)}C${f(c2)} ${f(y2 + h + th)} ${f(c1)} ${f(y1 + h + th)} ${f(x1)} ${f(y1)}Z"/>`;
  }

  // ═════════ 5. marks ═════════
  // その位置（小節 m・ティック t）にある音符。声部 v を優先
  const findPE = (r, m, t, v) => {
    const arr = onsetMap.get(`${r}:${m}:${t}`);
    if (!arr) return null;
    return arr.find(pe => pe.v === v) || arr.find(pe => !pe.rest) || arr[0];
  };
  const sysOf = (m) => MS[m].geo.sys;
  const xAt = (m, t) => onsetX(MS[m].geo, t);
  const dynAbove = SL.map(row => (INST[row.part.inst]?.fam === '声楽') || row.staff.measures.some(sm => sm.voices.some(v => v && v.some(ev => ev.lyr && ev.lyr.length))));
  const addMark = (mk) => marks.push(mk);

  // 線の記号（スラー・松葉・8va・ペダル・トリル）を段ごとの区間に分ける
  const spanList = [];
  SL.forEach((row, r) => row.staff.measures.forEach((sm, m) => (sm.spans || []).forEach((sp, idx) => {
    const b = { m: Math.min(M - 1, m + (sp.dm || 0)), t: sp.t2 };
    if (b.m < m || !SPANS[sp.k]) return;
    spanList.push({ r, row, m, idx, sp, a: { m, t: sp.t }, b, key: `s:${row.p}:${row.s}:${m}:${idx}` });
  })));
  const segmentsOf = (it) => {
    const ka = sysOf(it.a.m), kb = sysOf(it.b.m);
    const pa = findPE(it.r, it.a.m, it.a.t, it.sp.v), pb = findPE(it.r, it.b.m, it.b.t, it.sp.v);
    const segs = [];
    for (let k = ka; k <= kb; k++) {
      const sy = systems[k];
      const xa = k === ka ? (pa?.geom ? pa.geom.x : xAt(it.a.m, it.a.t)) : sy.x0 + sy.hdr - 0.3;
      const xb = k === kb ? (pb?.geom ? pb.geom.x + pb.headW : xAt(it.b.m, it.b.t) + 1.2) : sy.x1 - 0.3;
      segs.push({ k, xa, xb, first: k === ka, last: k === kb, pa: k === ka ? pa : null, pb: k === kb ? pb : null });
    }
    return segs;
  };

  // a. スラー
  for (const it of spanList.filter(x => x.sp.k === 'slur')) {
    const segs = segmentsOf(it);
    const r = it.r;
    // 向き：符尾がすべて上なら下側、それ以外は上側（多声部なら声部で決める）
    const inside = [];
    for (let m = it.a.m; m <= it.b.m; m++) {
      const pes = prep[m][r].voices[it.sp.v] || [];
      for (const pe of pes) {
        if (pe.rest || !pe.geom) continue;
        if (m === it.a.m && pe.start < it.a.t) continue;
        if (m === it.b.m && pe.start > it.b.t) continue;
        inside.push(pe);
      }
    }
    const multi = prep[it.a.m][r].multi;
    const above = multi ? it.sp.v % 2 === 0 : !(inside.length && inside.every(pe => pe.up && pe.type !== 'whole'));
    for (const sg of segs) {
      // 端の位置：符尾の側なら符尾の先、反対側なら符頭のすぐ外
      const endPt = (pe) => {
        const gm = pe.geom;
        const hc = gm.x + pe.headW / 2;
        if (above) return pe.up && gm.stemEnd != null && !pe.beam ? { x: gm.stemX, y: gm.stemEnd - 0.5 } : pe.up && gm.stemEnd != null ? { x: gm.stemX, y: gm.stemEnd - 0.6 } : { x: hc, y: gm.headTop - 0.3 };
        return !pe.up && gm.stemEnd != null ? { x: gm.stemX, y: gm.stemEnd + 0.5 } : { x: hc, y: gm.headBot + 0.3 };
      };
      const midPEs = inside.filter(pe => pe.geom.k === sg.k);
      const ext0 = above ? Math.min(0.5, ...midPEs.map(pe => pe.geom.headTop)) - 0.6 : Math.max(3.5, ...midPEs.map(pe => pe.geom.headBot)) + 0.6;
      const A0 = sg.pa?.geom ? endPt(sg.pa) : null, B0 = sg.pb?.geom ? endPt(sg.pb) : null;
      const xa = A0 ? A0.x : sg.xa, xb = B0 ? B0.x : sg.xb;
      let ya = A0 ? A0.y : B0 ? B0.y : ext0;
      let yb = B0 ? B0.y : A0 ? A0.y : ext0;
      const w = Math.max(1, xb - xa);
      let h = Math.min(2.2, 0.7 + w * 0.05);
      // 間の音符をよける：曲線のふくらみ 3u(1-u)h が足りなければ高くする
      for (const pe of midPEs) {
        if (pe === sg.pa || pe === sg.pb) continue;
        const gm = pe.geom;
        const xm = gm.x + pe.headW / 2;
        const u = Math.min(0.95, Math.max(0.05, (xm - xa) / w));
        const lineY = ya + (yb - ya) * u;
        const obst = above ? Math.min(gm.headTop, pe.up && gm.stemEnd != null ? gm.stemEnd : 99) - 0.5 : Math.max(gm.headBot, !pe.up && gm.stemEnd != null ? gm.stemEnd : -99) + 0.5;
        const need = above ? (lineY - obst) / (3 * u * (1 - u)) : (obst - lineY) / (3 * u * (1 - u));
        h = Math.max(h, need);
      }
      if (h > 4) { const lift = (h - 4) * 0.75; ya += above ? -lift : lift; yb += above ? -lift : lift; h = 4; }
      // 3次ベジェの中央のふくらみは制御点の高さの 3/4 なので、4/3 倍して渡す
      const hh = above ? -h : h;
      const svg = curve(xa, ya, xb, yb, hh * 1.33, 0.2, 'slur');
      const yTop = Math.min(ya, yb, Math.min(ya, yb) + hh), yBot = Math.max(ya, yb, Math.max(ya, yb) + hh);
      box(sg.k, r, xa, xb, yTop - 0.2, yBot + 0.2);
      addMark({ key: it.key, ref: { type: 'span', p: it.row.p, s: it.row.s, m: it.m, idx: it.idx }, k: sg.k, r, x0: xa, x1: xb, y0: yTop - 0.4, y1: yBot + 0.4, curve: { xa, ya, xb, yb, h: hh * 1.33 } });
      rowsOut[sg.k][r].s.push(`<g class="mk" data-id="${it.key}">${svg}</g>`);
    }
  }

  // b. 8va / 8vb / 15ma・トリルの波線
  for (const it of spanList.filter(x => ['8va', '8vb', '15ma', 'trill'].includes(x.sp.k))) {
    const r = it.r;
    const down = it.sp.k === '8vb';
    for (const sg of segmentsOf(it)) {
      const s = [];
      const gname = it.sp.k === 'trill' ? 'ornamentTrill' : SPANS[it.sp.k].g;
      const gwid = gw(gname) * (it.sp.k === 'trill' ? 1 : 0.85);
      const xa = sg.xa - (it.sp.k === 'trill' ? 0 : 0.3), xb = Math.max(sg.xb, xa + gwid + 1);
      const hgt = 2.0;
      let base;
      if (down) { const top = Math.max(4.4, skyBot(sg.k, r, xa, xb)) + 0.5; base = top + 1.7; box(sg.k, r, xa, xb, top, top + hgt); }
      else { const bot = Math.min(-0.4, skyTop(sg.k, r, xa, xb)) - 0.5; base = bot - 0.15; box(sg.k, r, xa, xb, bot - hgt, bot); }
      if (it.sp.k === 'trill') {
        s.push(glyph(gname, xa, base));
        const wl = G.wiggleTrill.a?.repeatOffset?.[0] || 0.948;
        const n = Math.max(0, Math.floor((xb - xa - gwid - 0.4) / wl));
        if (n) s.push(`<text class="g" x="${f(xa + gwid + 0.3)}" y="${f(base - 0.75)}">${G.wiggleTrill.c.repeat(n)}</text>`);
      } else {
        s.push(`<text class="g" x="${f(xa)}" y="${f(base)}" style="font-size:3.4px">${G[gname].c}</text>`);
        const ly = down ? base - 0.6 : base - 1.0;
        s.push(line(xa + gwid + 0.3, ly, xb, ly, D.octaveLineThickness || 0.16, 'oct', ' stroke-dasharray="0.6 0.45"'));
        if (sg.last) s.push(line(xb, ly, xb, ly + (down ? -1.2 : 1.2), D.octaveLineThickness || 0.16, 'oct'));
      }
      rowsOut[sg.k][r].s.push(`<g class="mk" data-id="${it.key}">${s.join('')}</g>`);
      addMark({ key: it.key, ref: { type: 'span', p: it.row.p, s: it.row.s, m: it.m, idx: it.idx }, k: sg.k, r, x0: xa, x1: xb, y0: down ? base - 2.2 : base - 2.2, y1: base + 0.6 });
    }
  }

  // c. 強弱記号・松葉・文字の表情記号
  //    強弱と松葉は「強弱の帯」に置き、近くにあるものどうしは同じ高さにそろえる
  const dynItems = systems.map(() => SL.map(() => []));
  const aboveTexts = [], chordItems = [];
  SL.forEach((row, r) => row.staff.measures.forEach((sm, m) => (sm.dirs || []).forEach((d, idx) => {
    if (!MS[m].geo || MS[m].geo.grp && m !== MS[m].geo.grp.first) return;
    const k = sysOf(m);
    const key = `d:${row.p}:${row.s}:${m}:${idx}`;
    const ref = { type: 'dir', p: row.p, s: row.s, m, idx };
    const pe = findPE(r, m, d.t, 0);
    const x = pe?.geom ? pe.geom.x : xAt(m, d.t);
    if (d.k === 'dyn' && DYNAMICS[d.v]) {
      const gname = DYNAMICS[d.v].g;
      const oc = G[gname].a?.opticalCenter?.[0] ?? gw(gname) / 2;
      const xs = x + (pe ? pe.headW / 2 : 0.6) - oc;
      dynItems[k][r].push({ kind: 'dyn', x0: xs, x1: xs + gw(gname), gname, key, ref, m, t: d.t });
    } else if (d.k === 'text') {
      const w = measureText(d.text, TXT);
      const item = { kind: 'text', x0: x, x1: x + w, d, key, ref, m, t: d.t };
      if ((d.pos || 'above') === 'below') dynItems[k][r].push(item);
      else aboveTexts.push({ ...item, k, r });
    } else if (d.k === 'chord') chordItems.push({ k, r, x, d, key, ref });
  })));
  // 松葉
  for (const it of spanList.filter(x => x.sp.k === 'cresc' || x.sp.k === 'dim')) {
    for (const sg of segmentsOf(it)) dynItems[sg.k][it.r].push({ kind: 'hair', x0: sg.xa, x1: sg.xb, it, sg, key: it.key, ref: { type: 'span', p: it.row.p, s: it.row.s, m: it.m, idx: it.idx } });
  }
  dynItems.forEach((rows, k) => rows.forEach((items, r) => {
    if (!items.length) return;
    // 同じ位置で始まる強弱記号のあとに松葉が続くときは、記号の右から始める
    for (const h of items.filter(i => i.kind === 'hair')) {
      const st = items.find(i => i.kind === 'dyn' && Math.abs(i.x0 - h.x0) < 2.2 && i.x1 > h.x0);
      if (st) h.x0 = st.x1 + 0.4;
      const en = items.find(i => i.kind === 'dyn' && i.x0 >= h.x0 && i.x0 < h.x1 + 0.3);
      if (en) h.x1 = Math.min(h.x1, en.x0 - 0.4);
      if (h.x1 < h.x0 + 1.2) h.x1 = h.x0 + 1.2;
    }
    const above = dynAbove[r];
    items.sort((a, b) => a.x0 - b.x0);
    const H = 2.4;
    // 近いものどうしをグループにして高さをそろえる
    const groups = [];
    for (const it of items) {
      const g = groups[groups.length - 1];
      if (g && it.x0 - g.x1 < 1.5) { g.items.push(it); g.x1 = Math.max(g.x1, it.x1); } else groups.push({ items: [it], x0: it.x0, x1: it.x1 });
    }
    for (const g of groups) {
      let top;
      if (above) top = Math.min(-0.6, ...g.items.map(it => skyTop(k, r, it.x0, it.x1))) - 0.7 - H;
      else top = Math.max(4.6, ...g.items.map(it => skyBot(k, r, it.x0, it.x1))) + 0.7;
      const base = top + 1.75; // 強弱記号の文字の基準線
      for (const it of g.items) {
        let svg;
        if (it.kind === 'dyn') svg = glyph(it.gname, it.x0, base);
        else if (it.kind === 'text') svg = text(it.d.text, it.x0, base - 0.25, TXT, it.d.it === false ? '' : ' font-style="italic"');
        else {
          const cy = base - 0.6, hw = 0.65;
          const cresc = it.it.sp.k === 'cresc';
          // 段をまたぐ松葉は、続きの側を少し開いた形にする
          const openA = cresc ? (it.sg.first ? 0 : hw * 0.5) : hw, openB = cresc ? hw : (it.sg.last ? 0 : hw * 0.5);
          const w = D.hairpinThickness || 0.16;
          svg = `<path class="hair" d="M${f(it.x1)} ${f(cy - openB)}L${f(it.x0)} ${f(cy - openA)}M${f(it.x0)} ${f(cy + openA)}L${f(it.x1)} ${f(cy + openB)}" stroke-width="${w}" fill="none"/>`;
          if (cresc && it.sg.first) svg = `<path class="hair" d="M${f(it.x1)} ${f(cy - hw)}L${f(it.x0)} ${f(cy)}L${f(it.x1)} ${f(cy + hw)}" stroke-width="${w}" fill="none"/>`;
          if (!cresc && it.sg.last) svg = `<path class="hair" d="M${f(it.x0)} ${f(cy - hw)}L${f(it.x1)} ${f(cy)}L${f(it.x0)} ${f(cy + hw)}" stroke-width="${w}" fill="none"/>`;
        }
        rowsOut[k][r].s.push(`<g class="mk" data-id="${it.key}">${svg}</g>`);
        box(k, r, it.x0 - 0.1, it.x1 + 0.1, top, top + H);
        addMark({ key: it.key, ref: it.ref, k, r, x0: it.x0 - 0.2, x1: it.x1 + 0.2, y0: top - 0.2, y1: top + H + 0.2 });
      }
    }
  }));

  // d. 文字の表情記号（上）：dolce・rit.・pizz. など
  for (const it of aboveTexts) {
    const bot = Math.min(-0.5, skyTop(it.k, it.r, it.x0, it.x1)) - 0.5;
    const svg = text(it.d.text, it.x0, bot - 0.45, TXT, it.d.it === false ? ' font-weight="600"' : ' font-style="italic"');
    rowsOut[it.k][it.r].s.push(`<g class="mk" data-id="${it.key}">${svg}</g>`);
    box(it.k, it.r, it.x0, it.x1, bot - 2.2, bot);
    addMark({ key: it.key, ref: it.ref, k: it.k, r: it.r, x0: it.x0 - 0.2, x1: it.x1 + 0.2, y0: bot - 2.4, y1: bot + 0.2 });
  }

  // e. 歌詞：段ごとに、その譜表のいちばん下の音符より下に1行ずつ（1番・2番…）
  const lyrBase = systems.map(() => SL.map(() => null));
  const lyrSeq = {}; // `${r}:${verse}` → 置いた音節（ハイフン用）
  for (let r = 0; r < SL.length; r++) for (let m = 0; m < M; m++) {
    const geo = MS[m].geo;
    if (!geo || geo.grp) continue;
    const k = geo.sys;
    prep[m][r].voices.forEach(pes => pes && pes.forEach(pe => {
      if (!pe.lyr || !pe.geom) return;
      if (lyrBase[k][r] == null) {
        const sy = systems[k];
        lyrBase[k][r] = Math.max(5, skyBot(k, r, sy.x0, sy.x1)) + 2.4;
      }
      pe.lyr.forEach((ly, verse) => {
        if (!ly || !ly.t) return;
        const y = lyrBase[k][r] + verse * 2.8;
        const w = measureText(ly.t, LYR);
        const xc = pe.geom.x + pe.headW / 2;
        const key = `l:${pe.id}:${verse}`;
        rowsOut[k][r].s.push(`<g class="mk lyr" data-id="${key}">${text(ly.t, xc, y, LYR, ' text-anchor="middle"')}</g>`);
        ext(k, r, 0, y + 0.8);
        addMark({ key, ref: { type: 'lyr', id: pe.id, verse }, k, r, x0: xc - w / 2 - 0.2, x1: xc + w / 2 + 0.2, y0: y - 2, y1: y + 0.6 });
        (lyrSeq[`${r}:${verse}`] = lyrSeq[`${r}:${verse}`] || []).push({ k, x0: xc - w / 2, x1: xc + w / 2, y, h: !!ly.h, m, t: pe.start });
      });
    }));
  }
  for (const key in lyrSeq) {
    const seq = lyrSeq[key].sort((a, b) => a.m - b.m || a.t - b.t);
    const r = +key.split(':')[0];
    seq.forEach((a, i) => {
      if (!a.h) return;
      const b = seq[i + 1];
      let xa = a.x1 + 0.25, xb;
      if (b && b.k === a.k) xb = b.x0 - 0.25; else xb = Math.min(systems[a.k].x1, xa + 2.4);
      const gap = xb - xa;
      if (gap < 0.5) return;
      const hw = Math.min(0.45, gap * 0.25);
      const cx = (xa + xb) / 2;
      rowsOut[a.k][r].s.push(line(cx - hw, a.y - 0.6, cx + hw, a.y - 0.6, 0.12, 'hyph'));
    });
  }

  // f. ペダル：いちばん下（Ped. 〜 *）
  for (const it of spanList.filter(x => x.sp.k === 'ped')) {
    for (const sg of segmentsOf(it)) {
      const s = [];
      const top = Math.max(4.6, skyBot(sg.k, it.r, sg.xa, sg.xb)) + 0.6;
      const base = top + G.keyboardPedalPed.ne[1];
      if (sg.first) s.push(glyph('keyboardPedalPed', sg.xa - 0.4, base));
      if (sg.last) s.push(glyph('keyboardPedalUp', sg.xb - gw('keyboardPedalUp') * 0.5, top + gh('keyboardPedalUp')));
      if (!sg.first) s.push(text('(Ped.)', sg.xa, base - 0.3, 1.8, ' font-style="italic"'));
      rowsOut[sg.k][it.r].s.push(`<g class="mk" data-id="${it.key}">${s.join('')}</g>`);
      box(sg.k, it.r, sg.xa - 0.4, sg.xb + 1, top, top + 2.3);
      addMark({ key: it.key, ref: { type: 'span', p: it.row.p, s: it.row.s, m: it.m, idx: it.idx }, k: sg.k, r: it.r, x0: sg.xa - 0.5, x1: sg.xb + 1.2, y0: top - 0.2, y1: top + 2.5 });
    }
  }

  // g. コードネーム：段ごとに、その譜表のいちばん上にそろえる
  const chordBase = {};
  for (const it of chordItems) {
    const id = `${it.k}:${it.r}`;
    if (chordBase[id] == null) { const sy = systems[it.k]; chordBase[id] = Math.min(-1.2, skyTop(it.k, it.r, sy.x0, sy.x1)) - 0.9; }
  }
  for (const it of chordItems) {
    const y = chordBase[`${it.k}:${it.r}`];
    const c = chordSvg(it.d.text, it.x, y);
    rowsOut[it.k][it.r].s.push(`<g class="mk chord" data-id="${it.key}">${c.svg}</g>`);
    ext(it.k, it.r, y - 2.4, 4);
    addMark({ key: it.key, ref: it.ref, k: it.k, r: it.r, x0: it.x - 0.2, x1: it.x + c.w + 0.2, y0: y - 2.4, y1: y + 0.5 });
  }
  for (const it of chordItems) { const y = chordBase[`${it.k}:${it.r}`]; box(it.k, it.r, it.x, it.x + chordWidth(it.d.text), y - 2.3, y + 0.4); }
  function chordWidth(t) { return chordSvg(t, 0, 0).w; }
  // C, F♯m7, B♭maj7/D …（♯♭ は楽譜フォントの記号で）
  function chordSvg(t, x, y) {
    const c = parseChord(t);
    if (!c) return { svg: text(t, x, y, CHORD), w: measureText(t, CHORD) };
    const out = [];
    let xx = x;
    const put = (s, size = CHORD) => { if (!s) return; out.push(text(s, xx, y, size)); xx += measureText(s, size); };
    const acc = (alter) => {
      if (!alter) return;
      const gname = alter > 0 ? 'csymAccidentalSharp' : 'csymAccidentalFlat';
      for (let i = 0; i < Math.abs(alter); i++) { out.push(`<text class="g" x="${f(xx + 0.05)}" y="${f(y - 0.05)}" style="font-size:2.6px">${G[gname].c}</text>`); xx += gw(gname) * 0.65 + 0.12; }
    };
    put(c.root); acc(c.alter);
    put(c.quality.replace(/b(?=\d)/g, '♭').replace(/#(?=\d)/g, '♯'), CHORD * 0.86);
    if (c.bass) { put('/'); put(c.bass); acc(c.bassAlter); }
    return { svg: out.join(''), w: xx - x };
  }

  // h. 段全体の記号（いちばん上の譜表の上）：反復のカッコ・セーニョ・コーダ・D.C. など・テンポ・小節番号
  systems.forEach((sy, k) => {
    const out = rowsOut[k][0].s;
    const r = 0;
    // カッコ（1番・2番）
    sy.ms.forEach((m) => {
      for (let m2 = m; m2 >= 0 && m2 > m - 64; m2--) {
        const e = score.measures[m2].ending;
        if (!e) continue;
        const len = Math.max(1, e.len || 1);
        if (m2 + len - 1 < m) break;
        // この段でカッコが始まる小節（＝最初の小節か、段の頭）でだけ描く
        if (m !== m2 && m !== sy.ms[0]) break;
        const last = m2 + len - 1;
        const endM = sy.ms.includes(last) ? last : sy.ms[sy.ms.length - 1];
        const xa = MS[m].geo.x0 + 0.3, xb = MS[endM].geo.x1 - 0.5;
        const bot = Math.min(-1.2, skyTop(k, r, xa, xb)) - 0.6;
        const yT = bot - 2.0;
        const closed = endM === last && score.measures[last].repeatEnd;
        const firstSeg = m === m2;
        const lw = D.repeatEndingLineThickness || 0.16;
        let d = `M${f(xa)} ${f(firstSeg ? bot : yT)}${firstSeg ? `V${f(yT)}` : ''}H${f(xb)}`;
        if (closed) d += `V${f(bot)}`;
        const key = `m:${m2}:ending`;
        const lbl = firstSeg ? text((e.nums || [1]).join('., ') + '.', xa + 0.5, yT + 1.75, 1.9) : '';
        out.push(`<g class="mk" data-id="${key}"><path class="ending" d="${d}" stroke-width="${lw}" fill="none"/>${lbl}</g>`);
        box(k, r, xa, xb, yT - 0.2, bot);
        addMark({ key, ref: { type: 'meas', m: m2, what: 'ending' }, k, r, x0: xa, x1: xb, y0: yT - 0.4, y1: bot });
        break;
      }
    });
    sy.ms.forEach((m) => {
      const ms = score.measures[m];
      const geo = MS[m].geo;
      if (geo.grp && m !== geo.grp.first && m !== geo.grp.last) return;
      const put = (what, svgFn, w, atEnd) => {
        const xa = atEnd ? geo.x1 - 0.4 - w : geo.x0 + 0.3;
        const bot = Math.min(-0.8, skyTop(k, r, xa, xa + w)) - 0.5;
        const { svg, h } = svgFn(xa, bot);
        const key = `m:${m}:${what}`;
        out.push(`<g class="mk" data-id="${key}">${svg}</g>`);
        box(k, r, xa, xa + w, bot - h, bot);
        addMark({ key, ref: { type: 'meas', m, what }, k, r, x0: xa - 0.2, x1: xa + w + 0.2, y0: bot - h - 0.2, y1: bot + 0.2 });
      };
      const word = (s) => (xa, bot) => ({ svg: text(s, xa, bot - 0.4, 2.2, ' font-style="italic" font-weight="700"'), h: 2.2 });
      if (ms.segno) put('segno', (xa, bot) => ({ svg: glyph('segno', xa, bot - 0.1), h: gh('segno') }), gw('segno'));
      if (ms.coda) put('coda', (xa, bot) => ({ svg: glyph('coda', xa, bot - 0.65), h: gh('coda') }), gw('coda'));
      if (ms.fine) put('fine', word('Fine'), measureText('Fine', 2.2) + 0.2, true);
      if (ms.toCoda) put('toCoda', (xa, bot) => ({ svg: text('To Coda', xa, bot - 0.4, 2.2, ' font-style="italic" font-weight="700"') + `<text class="g" x="${f(xa + measureText('To Coda ', 2.2))}" y="${f(bot - 0.45)}" style="font-size:2.6px">${G.coda.c}</text>`, h: 2.4 }), measureText('To Coda ', 2.2) + gw('coda') * 0.65 + 0.2, true);
      if (ms.jump && JUMPS[ms.jump]) put('jump', word(JUMPS[ms.jump].text), measureText(JUMPS[ms.jump].text, 2.2) + 0.2, true);
    });
    // テンポ
    sy.ms.forEach((m, idx) => {
      const tp = score.measures[m].tempo;
      if (!tp || (MS[m].geo.grp && m !== MS[m].geo.grp.first)) return;
      const x = (idx === 0 ? sy.x0 + sy.hdr : MS[m].geo.x0) + 0.3;
      const tw = (tp.text ? measureText(tp.text + ' ', 2.2) : 0);
      const w = tw + 1.3 + measureText(' = ' + tp.bpm, 2.2);
      const y = Math.min(-2.5, skyTop(k, r, x, x + w) - 1.0);
      const label = tp.text ? esc(tp.text) + ' ' : '';
      out.push(`<g class="tempo"><text class="t tempo-t" x="${f(x)}" y="${f(y)}" font-size="2.2">${label}</text>` +
        `<text class="g" x="${f(x + tw)}" y="${f(y)}" style="font-size:2.6px">${G.metNoteQuarterUp.c}</text>` +
        `<text class="t tempo-t" x="${f(x + tw + 1.3)}" y="${f(y)}" font-size="2.2"> = ${tp.bpm}</text></g>`);
      box(k, r, x, x + w, y - 2.5, y + 0.3);
    });
    if (k > 0) {
      const y = Math.min(-1.4, skyTop(k, r, sy.x0, sy.x0 + 2) - 0.4);
      out.push(`<text class="t mnum" x="${f(sy.x0 + 0.2)}" y="${f(y)}" font-size="1.6">${sy.first + 1}</text>`);
      ext(k, r, y - 1.6, 4);
    }
  });

  // ═════════ 6. 縦の配置とページ割り ═════════
  const rowGapIn = 6.5, rowGapPart = 7.5, sysGap = 7;
  const sysBlocks = systems.map((sy, k) => {
    const rows = rowsOut[k];
    const ys = [];
    let y = Math.max(0, -rows[0].top);
    SL.forEach((row, r) => {
      if (r > 0) {
        const prev = rows[r - 1];
        const def = SL[r - 1].p === row.p ? rowGapIn : rowGapPart;
        y += 4 + Math.max(def, prev.bot - 4 + -rows[r].top + 1.2);
      }
      ys.push(y);
    });
    const height = ys[ys.length - 1] + Math.max(4, rows[rows.length - 1].bot);
    return { ys, height };
  });

  const pages = [];
  let cur = null;
  const contentBottom = pageH - mg.b;
  const newPage = () => { cur = { items: [], sys: [], top: mg.t }; pages.push(cur); };
  newPage();
  // タイトル類（パート譜は左上にパート名）
  const meta = score.meta;
  let y = mg.t;
  const head = [];
  if (meta.title) { y += 4.6; head.push(`<text class="t title" x="${f(pageW / 2)}" y="${f(y)}" font-size="4.6" text-anchor="middle">${esc(meta.title)}</text>`); }
  if (meta.subtitle) { y += 3.2; head.push(`<text class="t subtitle" x="${f(pageW / 2)}" y="${f(y)}" font-size="2.6" text-anchor="middle">${esc(meta.subtitle)}</text>`); }
  if (meta.composer || meta.lyricist || meta.arranger || showParts) {
    y += 3.6;
    if (meta.composer) head.push(`<text class="t composer" x="${f(right)}" y="${f(y)}" font-size="2.2" text-anchor="end">${esc(meta.composer)}</text>`);
    if (showParts) head.push(`<text class="t partname" x="${f(mg.l)}" y="${f(y)}" font-size="2.6" font-weight="600">${esc(shown.map(p => p.name).join(' / '))}</text>`);
    else if (meta.lyricist) head.push(`<text class="t lyricist" x="${f(mg.l)}" y="${f(y)}" font-size="2.2">${esc(meta.lyricist)}</text>`);
    if (meta.arranger) { y += 2.8; head.push(`<text class="t arranger" x="${f(right)}" y="${f(y)}" font-size="2.0" text-anchor="end">${esc(meta.arranger)}</text>`); }
  }
  cur.head = head;
  let cy = y + (head.length ? 5 : 2);
  systems.forEach((sy, k) => {
    const blk = sysBlocks[k];
    if (cur.sys.length && cy + blk.height > contentBottom) { newPage(); cy = mg.t + 2; }
    cur.sys.push({ k, y: cy });
    cy += blk.height + sysGap;
  });
  // ページ内で段の間隔を均等に広げる（最後のページで余白が多いときは詰めたまま）
  pages.forEach((pg, pi) => {
    if (pg.sys.length < 2) return;
    const lastS = pg.sys[pg.sys.length - 1];
    const usedBottom = lastS.y + sysBlocks[lastS.k].height;
    const free = contentBottom - usedBottom;
    const isLast = pi === pages.length - 1;
    if (isLast && free > (contentBottom - pg.sys[0].y) * 0.35) return;
    const add = Math.min(free / (pg.sys.length - 1), 12);
    pg.sys.forEach((s, i) => (s.y += add * i));
  });

  // ── SVG を組み立てる ──
  const sysInfo = [];
  const pageSvgs = pages.map((pg, pi) => {
    const parts = [];
    parts.push(`<rect class="paper" x="0" y="0" width="${f(pageW)}" height="${f(pageH)}"/>`);
    if (pi === 0) parts.push(...pg.head);
    else parts.push(`<text class="t pnum" x="${f(pi % 2 ? right : mg.l)}" y="${f(mg.t - 2)}" font-size="2" text-anchor="${pi % 2 ? 'end' : 'start'}">${pi + 1}</text>`);
    for (const ps of pg.sys) {
      const sy = systems[ps.k];
      const blk = sysBlocks[ps.k];
      const staffYs = blk.ys.map(v => v + ps.y);
      sysInfo[ps.k] = { page: pi, x0: sy.x0, x1: sy.x1, contentX: sy.x0 + sy.hdr, staffYs, top: ps.y, bottom: ps.y + blk.height, ms: sy.ms };
      SL.forEach((row, r) => parts.push(`<g transform="translate(0 ${f(staffYs[r])})">${rowsOut[ps.k][r].s.join('')}</g>`));
      drawSystemFrame(parts, ps.k, sy, staffYs);
    }
    return { w: pageW, h: pageH, svg: parts.join('') };
  });

  function drawSystemFrame(parts, k, sy, staffYs) {
    const topY = staffYs[0], botY = staffYs[staffYs.length - 1] + 4;
    if (SL.length > 1) parts.push(line(sy.x0, topY, sy.x0, botY, THIN, 'barline'));
    // 小節線（パートごとにつなぐ）
    const partRows = {};
    SL.forEach((row, r) => (partRows[row.p] = partRows[row.p] || []).push(r));
    const dots = (x, rs) => { for (const r of rs) { parts.push(glyphC('repeatDot', x, staffYs[r] + 1.5), glyphC('repeatDot', x, staffYs[r] + 2.5)); } };
    sy.ms.forEach((m, idx) => {
      const geo = MS[m].geo;
      if (geo.grp && m !== geo.grp.last) return;
      const ms = score.measures[m];
      const bl = ms.barline;
      const nextM = sy.ms[idx + 1];
      const nextStart = nextM != null && score.measures[nextM].repeatStart && !(MS[nextM].geo.grp && nextM !== MS[nextM].geo.grp.first);
      for (const p in partRows) {
        const rs = partRows[p];
        const y1 = staffYs[rs[0]], y2 = staffYs[rs[rs.length - 1]] + 4;
        const x = geo.x1;
        if (ms.repeatEnd) {
          parts.push(line(x - THICK / 2, y1, x - THICK / 2, y2, THICK, 'barline'));
          parts.push(line(x - THICK - 0.4 - THIN / 2, y1, x - THICK - 0.4 - THIN / 2, y2, THIN, 'barline'));
          dots(x - THICK - 0.4 - THIN - 0.55, rs);
          if (ms.repeatEnd.times > 2) parts.push(text(`×${ms.repeatEnd.times}`, x - 2.4, y1 - 0.8, 1.8, ' font-style="italic"'));
        } else if (nextStart) {
          // 次の小節の反復開始（太線＋細線）がこの位置に描かれる
        } else if (bl === 'final') {
          parts.push(line(x - THICK / 2, y1, x - THICK / 2, y2, THICK, 'barline'));
          parts.push(line(x - THICK - 0.4 - THIN / 2, y1, x - THICK - 0.4 - THIN / 2, y2, THIN, 'barline'));
        } else if (bl === 'double') {
          parts.push(line(x - THIN / 2, y1, x - THIN / 2, y2, THIN, 'barline'));
          parts.push(line(x - THIN * 1.5 - 0.4, y1, x - THIN * 1.5 - 0.4, y2, THIN, 'barline'));
        } else parts.push(line(x - THIN / 2, y1, x - THIN / 2, y2, THIN, 'barline'));
      }
    });
    // 反復の始まり（太線・細線・点）
    sy.ms.forEach((m, idx) => {
      const geo = MS[m].geo;
      if (!score.measures[m].repeatStart || (geo.grp && m !== geo.grp.first)) return;
      const prevM = sy.ms[idx - 1];
      const shared = prevM != null && score.measures[prevM].repeatEnd;
      for (const p in partRows) {
        const rs = partRows[p];
        const y1 = staffYs[rs[0]], y2 = staffYs[rs[rs.length - 1]] + 4;
        let x = geo.x0 + geo.chg;
        if (!shared) { parts.push(line(x + THICK / 2, y1, x + THICK / 2, y2, THICK, 'barline')); x += THICK; }
        parts.push(line(x + 0.4 + THIN / 2, y1, x + 0.4 + THIN / 2, y2, THIN, 'barline'));
        dots(x + 0.4 + THIN + 0.55, rs);
      }
    });
    // 括弧（ブレース・ブラケット）
    let bx = sy.x0 - 0.4;
    for (const p in partRows) {
      const rs = partRows[p];
      if (rs.length > 1) {
        const y1 = staffYs[rs[0]], y2 = staffYs[rs[rs.length - 1]] + 4;
        const sc = (y2 - y1) / 4;
        const w = gw('brace') * sc;
        parts.push(`<text class="g" transform="translate(${f(sy.x0 - 0.35 - w)} ${f(y2)}) scale(${f(sc)})" x="0" y="0">${G.brace.c}</text>`);
        bx = Math.min(bx, sy.x0 - 0.35 - w - 0.4);
      }
    }
    if (shown.length > 1) {
      const x = bx - 0.5;
      parts.push(line(x, topY - 0.25, x, botY + 0.25, THICK, 'bracket'));
      parts.push(glyph('bracketTop', x - THICK / 2, topY - 0.25));
      parts.push(glyph('bracketBottom', x - THICK / 2, botY + 0.25));
      bx = x - 1;
    }
    // 楽器名（最初の段はフルネーム、以降は略称。パート譜では出さない）
    if (showParts) return;
    for (const p in partRows) {
      const rs = partRows[p];
      const part = score.parts[p];
      const name = k === 0 ? part.name : (multiPart ? part.abbr : '');
      if (!name) continue;
      const cyy = (staffYs[rs[0]] + staffYs[rs[rs.length - 1]] + 4) / 2 + nameSize * 0.35;
      parts.push(`<text class="t iname" x="${f(bx - 0.3)}" y="${f(cyy)}" font-size="${nameSize}" text-anchor="end">${esc(name)}</text>`);
    }
  }

  // 入力・再生で使う位置情報
  const measures = MS.map((ms, m) => ({ m, sys: ms.geo.sys, x0: ms.geo.x0, x1: ms.geo.x1, cx: ms.geo.cx, ons: ms.geo.ons, len: ms.geo.len, grp: ms.geo.grp }));
  // evGeom・記号の位置を「ページ座標」に
  for (const id in evGeom) {
    const g = evGeom[id];
    const si = sysInfo[g.k];
    g.page = si.page;
    g.oy = si.staffYs[g.r];
  }
  for (const mk of marks) { const si = sysInfo[mk.k]; mk.page = si.page; mk.oy = si.staffYs[mk.r]; }
  return {
    pages: pageSvgs, systems: sysInfo, measures, rows: SL.map(r => ({ p: r.p, s: r.s })), clefs, evGeom, marks, attrs: A, pageW, pageH,
    fifthsAt: fifthsR, rowTrans, partView: !!showParts, transposed: !!opts.transposed,
  };
}

// 位置情報からティック → x（再生カーソル・入力カーソル用）
export function tickToX(mg, t) {
  const ons = mg.ons;
  let a = ons[0], b = null;
  for (const q of ons) { if (q.t <= t) a = q; else { b = q; break; } }
  if (a.t === t) return a.x;
  const bx = b ? b.x : mg.x1 - 0.8, bt = b ? b.t : mg.len;
  if (t < a.t) return mg.cx + ((a.x - mg.cx) * t) / Math.max(1, a.t);
  return a.x + ((t - a.t) / Math.max(1, bt - a.t)) * (bx - a.x);
}

export { evTicks, isCompound };
