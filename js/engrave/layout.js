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
//   5. vertical  … 上下にはみ出す音符を避けながら譜表の間隔を決め、ページに割り付ける
import { SMUFL } from '../smufl.js';
import { TPQ, TYPE_FLAGS, CLEFS, keyAlter, keyOrder, diatonic, isCompound, beatTicks } from '../core/music.js';
import { measureAttrs, staffList, clefAt, evTicks } from '../core/score.js';
import { positions } from '../core/edit.js';

const G = SMUFL.glyphs, D = SMUFL.defaults;
const STEM_W = D.stemThickness, LEDGER_W = D.legerLineThickness, LEDGER_EXT = D.legerLineExtension;
const BEAM_T = D.beamThickness, BEAM_GAP = D.beamThickness + D.beamSpacing;
const LINE_W = D.staffLineThickness, THIN = D.thinBarlineThickness, THICK = D.thickBarlineThickness;
const f = (n) => Math.round(n * 1000) / 1000;
const yOf = (pos) => 2 - pos / 2;
const gw = (name) => (G[name] && G[name].ne ? G[name].ne[0] : 1);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const HEAD = { breve: 'noteheadDoubleWhole', whole: 'noteheadWhole', half: 'noteheadHalf' };
const REST = { breve: 'restDoubleWhole', whole: 'restWhole', half: 'restHalf', quarter: 'restQuarter', eighth: 'rest8th', '16th': 'rest16th', '32nd': 'rest32nd', '64th': 'rest64th', '128th': 'rest128th' };
const FLAG = ['', '8th', '16th', '32nd', '64th', '128th'];
const ACC = { '-2': 'accidentalDoubleFlat', '-1': 'accidentalFlat', 0: 'accidentalNatural', 1: 'accidentalSharp', 2: 'accidentalDoubleSharp' };

// 音符間の理想的な間隔（長さの 0.6 乗に比例。2倍長い音符でも間隔は約1.5倍）
const ideal = (d) => 1.3 + 2.2 * Math.pow(d / TPQ, 0.6);

function glyph(name, x, y, cls = '', extra = '') {
  return `<text class="g${cls ? ' ' + cls : ''}" x="${f(x)}" y="${f(y)}"${extra}>${G[name].c}</text>`;
}
function line(x1, y1, x2, y2, w, cls = '') {
  return `<line${cls ? ` class="${cls}"` : ''} x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke-width="${f(w)}"/>`;
}
function poly(pts, cls = '') {
  return `<polygon${cls ? ` class="${cls}"` : ''} points="${pts.map(p => f(p[0]) + ',' + f(p[1])).join(' ')}"/>`;
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
  for (const v of active) {
    const pes = positions(sm.voices[v]).map(x => {
      const ev = x.ev;
      return {
        id: ev.id, ev, v, start: x.start, end: x.end, rest: ev.rest, mr: !!ev.mr, type: ev.type, dots: ev.dots || 0,
        flags: TYPE_FLAGS[ev.type] || 0, tuplet: ev.tuplet || null,
        notes: ev.rest ? [] : ev.notes.map((n, k) => ({ n, k, dn: diatonic(n), pos: diatonic(n) - clef.mid, acc: null, side: 0 })).sort((a, b) => a.pos - b.pos),
        up: true, beam: null, prev: null,
      };
    });
    // 前のイベント（タイの続きかどうかの判定用）
    pes.forEach((pe, i) => (pe.prev = i > 0 ? pes[i - 1] : prevLast[v] || null));
    res.voices[v] = pes;
  }
  // 臨時記号：譜表内の全声部を時間順に見て、調号と「その小節で前に付いた記号」から決める
  const all = [];
  for (const v of active) for (const pe of res.voices[v]) if (!pe.rest) all.push(pe);
  all.sort((a, b) => a.start - b.start || a.v - b.v);
  const state = {};
  for (const pe of all) {
    for (const nt of pe.notes) {
      const n = nt.n, key = n.step + n.octave, alt = n.alter || 0;
      const cur = key in state ? state[key] : keyAlter(attr.fifths, n.step);
      const tiedIn = pe.prev && !pe.prev.rest && pe.prev.ev.notes.some(q => q.tie && q.step === n.step && q.octave === n.octave && (q.alter || 0) === alt);
      nt.tiedIn = !!tiedIn;
      if (tiedIn && pe.start === 0 && !n.acc) { state[key] = alt; continue; }
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
}

// ═════════ メイン ═════════
export function layoutScore(score, opts = {}) {
  const measureText = opts.measureText || ((s, size) => [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55), 0) * size);
  const A = measureAttrs(score);
  const SL = staffList(score);
  const M = score.measures.length;
  const spMm = score.settings.staffMm / 4;
  const pageW = score.settings.page.w / spMm, pageH = score.settings.page.h / spMm;
  const mg = { t: score.settings.margin.t / spMm, b: score.settings.margin.b / spMm, l: score.settings.margin.l / spMm, r: score.settings.margin.r / spMm };

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
      const pr = prepStaffMeasure(sm, A[m], ck, prevLast[r]);
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
      on.set(pe.start, o);
    })));
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
    MS[m] = { ons: ons.map((o, i) => ({ t: o.t, x: xs[i] })), ideals, cw, startPad: 1.1, allMr };
  }
  // 段の途中で拍子・調・音部記号が変わる小節の頭に必要な幅
  const chgW = (m) => {
    if (m === 0) return 0;
    let w = 0;
    if (SL.some((row, r) => row.staff.measures[m]?.clef)) w += 2.4;
    if (score.measures[m].key) w += keyItemsWidth(keySigItems(A[m].fifths, A[m].prevFifths, 'treble', true)) + 0.6;
    if (score.measures[m].time) w += timeSigWidth(A[m].time) + 0.8;
    return w;
  };
  const sysHeader = (m) => {
    const clefW = Math.max(...SL.map((row, r) => gw(CLEFS[clefs[m][r]]?.glyph || 'gClef')));
    let w = 0.7 + clefW + 0.9;
    const ks = keySigItems(A[m].fifths, A[m].prevFifths, 'treble', m > 0 && !!score.measures[m].key);
    if (ks.length) w += keyItemsWidth(ks) + 0.6;
    if (A[m].timeChanged) w += timeSigWidth(A[m].time) + 0.9;
    return w;
  };

  // ── 3. breaking（改段） ──
  const nameSize = 2.0;
  const multiPart = score.parts.length > 1;
  const hasBrace = score.parts.some(p => p.staves.length > 1);
  const bracketW = (multiPart ? 1.6 : 0) + (hasBrace ? 1.4 : 0);
  const fullNameW = Math.max(0, ...score.parts.map(p => measureText(p.name, nameSize)));
  const abbrW = multiPart ? Math.max(0, ...score.parts.map(p => measureText(p.abbr, nameSize))) : 0;
  const indent0 = (fullNameW ? fullNameW + 1.6 : 0) + bracketW;
  const indentN = (abbrW ? abbrW + 1.6 : 0) + bracketW;
  const right = pageW - mg.r;
  const systems = [];
  for (let i = 0; i < M;) {
    const x0 = mg.l + (systems.length === 0 ? indent0 : indentN);
    const hdr = sysHeader(i);
    const avail = right - x0 - hdr;
    const ms = [];
    let used = 0;
    let j = i;
    while (j < M) {
      const w = MS[j].startPad + MS[j].cw + (j > i ? chgW(j) : 0);
      if (ms.length && used + w > avail) break;
      ms.push(j); used += w; j++;
      if (score.measures[j - 1].sysBreak) break;
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
    sy.ms.forEach((m, idx) => {
      const ms = MS[m];
      const nat = ms.startPad + ms.cw;
      const add = (extra * nat) / sy.used;
      const sumIdeal = ms.ideals.reduce((a, b) => a + b, 0);
      const c = idx > 0 ? chgW(m) : 0;
      const xStart = x;
      const cx = x + c + ms.startPad;
      let shift = 0;
      const ons = ms.ons.map((o, i) => { const r = { t: o.t, x: cx + o.x + shift }; shift += (add * ms.ideals[i]) / sumIdeal; return r; });
      const w = c + nat + add;
      ms.geo = { sys: k, x0: xStart, x1: xStart + w, cx, ons, len: A[m].len, chg: c };
      x += w;
    });
  });

  // ── 4. draw ──
  const evGeom = {};
  const rowsOut = systems.map(() => SL.map(() => ({ s: [], top: -1, bot: 5 })));
  const ext = (k, r, top, bot) => { const o = rowsOut[k][r]; o.top = Math.min(o.top, top); o.bot = Math.max(o.bot, bot); };
  const tieReqs = [];

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
      const ks = keySigItems(A[m0].fifths, A[m0].prevFifths, ck, m0 > 0 && !!score.measures[m0].key);
      if (ks.length) { for (const it of ks) { out.push(glyph(it.g, hx, yOf(it.pos))); hx += gw(it.g) + 0.12; } hx += 0.6; }
      if (A[m0].timeChanged) drawTime(out, A[m0].time, hx);

      sy.ms.forEach((m, idx) => {
        const geo = MS[m].geo;
        // 段の途中の変更
        if (idx > 0 && geo.chg) {
          let x = geo.x0 + 0.5;
          const sm = row.staff.measures[m];
          if (sm.clef) { const c2 = CLEFS[sm.clef]; out.push(glyph(c2.glyph, x, yOf(c2.glyphPos), 'gs')); }
          if (SL.some(rr => rr.staff.measures[m]?.clef)) x += 2.4;
          if (score.measures[m].key) {
            for (const it of keySigItems(A[m].fifths, A[m].prevFifths, clefs[m][r], true)) { out.push(glyph(it.g, x, yOf(it.pos))); x += gw(it.g) + 0.12; }
            x += 0.6;
          }
          if (score.measures[m].time) drawTime(out, A[m].time, x);
        }
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

  function drawMeasure(out, k, r, row, m, geo) {
    const pr = prep[m][r];
    pr.voices.forEach((pes, v) => {
      if (!pes) return;
      for (const pe of pes) drawEvent(out, k, r, row, m, geo, pe);
      for (const g of pes.groups || []) drawBeam(out, k, r, g);
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
    out.push(`<g class="${cls}" data-id="${pe.id}">${g.join('')}</g>`);
    ext(k, r, geom.top, geom.bot);
    evGeom[pe.id] = geom;
    pe.geom = geom;
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
          const left = i === pts.length - 1 || (i > 0 && pts[i - 1].pe.flags < pts[i].pe.flags && pts[i].pe.dots === 0 && false);
          const xA = left ? pts[i].sx - 1.1 : pts[i].sx - STEM_W / 2;
          const xB = left ? pts[i].sx + STEM_W / 2 : pts[i].sx + 1.1;
          g.push(beamPoly(xA, xB, off));
        }
        i = j + 1;
      }
    }
    out.push(`<g class="beamgrp v${grp.v}">${g.join('')}</g>`);
    const ys = pts.map(p => by(p.sx));
    if (up) ext(k, r, Math.min(...ys) - 0.2, 4); else ext(k, r, 0, Math.max(...ys) + 0.2);
    grp.beamY = by;
    grp.yMin = Math.min(...ys); grp.yMax = Math.max(...ys);
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
      if (up) y = Math.min(-0.5, ...mem.map(pe => Math.min(pe.geom.top, pe.geom.stemEnd ?? 99))) - 1.2;
      else y = Math.max(4.5, ...mem.map(pe => Math.max(pe.geom.bot, pe.geom.stemEnd ?? -99))) + 1.2;
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
      ext(k, r, up ? y - 1 : 0, up ? 4 : y + 1);
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
    if (from.rest === false && prep[0] && fg && from.v !== undefined && prep[fg.m][fg.r].multi) upCurve = from.v % 2 === 0;
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
    const th = 0.18 * (upCurve ? -1 : 1);
    const c1 = x1 + w * 0.22, c2 = x2 - w * 0.22;
    return `<path class="tie" d="M${f(x1)} ${f(y0)}C${f(c1)} ${f(y0 + h)} ${f(c2)} ${f(y0 + h)} ${f(x2)} ${f(y0)}C${f(c2)} ${f(y0 + h + th)} ${f(c1)} ${f(y0 + h + th)} ${f(x1)} ${f(y0)}Z"/>`;
  }

  // テンポ表示・小節番号（段の一番上の譜表に）
  systems.forEach((sy, k) => {
    const out = rowsOut[k][0].s;
    sy.ms.forEach((m, idx) => {
      const tp = score.measures[m].tempo;
      if (tp) {
        const x = (idx === 0 ? sy.x0 + sy.hdr : MS[m].geo.x0) + 0.3;
        const y = Math.min(-2.5, rowsOut[k][0].top - 1.2);
        const label = tp.text ? esc(tp.text) + ' ' : '';
        out.push(`<g class="tempo"><text class="t tempo-t" x="${f(x)}" y="${f(y)}" font-size="2.2">${label}</text>` +
          `<text class="g" x="${f(x + (tp.text ? measureText(tp.text + ' ', 2.2) : 0))}" y="${f(y)}" font-size="2.6">${G.metNoteQuarterUp.c}</text>` +
          `<text class="t tempo-t" x="${f(x + (tp.text ? measureText(tp.text + ' ', 2.2) : 0) + 1.3)}" y="${f(y)}" font-size="2.2"> = ${tp.bpm}</text></g>`);
        ext(k, 0, y - 2.5, 4);
      }
    });
    if (k > 0) {
      const y = Math.min(-1.4, rowsOut[k][0].top - 0.4);
      out.push(`<text class="t mnum" x="${f(sy.x0 + 0.2)}" y="${f(y)}" font-size="1.6">${sy.first + 1}</text>`);
      ext(k, 0, y - 1.6, 4);
    }
  });

  // ── 5. 縦の配置とページ割り ──
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
  // タイトル類
  const meta = score.meta;
  let y = mg.t;
  const head = [];
  if (meta.title) { y += 4.6; head.push(`<text class="t title" x="${f(pageW / 2)}" y="${f(y)}" font-size="4.6" text-anchor="middle">${esc(meta.title)}</text>`); }
  if (meta.subtitle) { y += 3.2; head.push(`<text class="t subtitle" x="${f(pageW / 2)}" y="${f(y)}" font-size="2.6" text-anchor="middle">${esc(meta.subtitle)}</text>`); }
  if (meta.composer || meta.lyricist || meta.arranger) {
    y += 3.6;
    if (meta.composer) head.push(`<text class="t composer" x="${f(right)}" y="${f(y)}" font-size="2.2" text-anchor="end">${esc(meta.composer)}</text>`);
    if (meta.lyricist) head.push(`<text class="t lyricist" x="${f(mg.l)}" y="${f(y)}" font-size="2.2">${esc(meta.lyricist)}</text>`);
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
    sy.ms.forEach((m) => {
      const geo = MS[m].geo;
      const bl = score.measures[m].barline;
      for (const p in partRows) {
        const rs = partRows[p];
        const y1 = staffYs[rs[0]], y2 = staffYs[rs[rs.length - 1]] + 4;
        const x = geo.x1;
        if (bl === 'final') {
          parts.push(line(x - THICK / 2, y1, x - THICK / 2, y2, THICK, 'barline'));
          parts.push(line(x - THICK - 0.4 - THIN / 2, y1, x - THICK - 0.4 - THIN / 2, y2, THIN, 'barline'));
        } else if (bl === 'double') {
          parts.push(line(x - THIN / 2, y1, x - THIN / 2, y2, THIN, 'barline'));
          parts.push(line(x - THIN * 1.5 - 0.4, y1, x - THIN * 1.5 - 0.4, y2, THIN, 'barline'));
        } else parts.push(line(x - THIN / 2, y1, x - THIN / 2, y2, THIN, 'barline'));
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
    if (score.parts.length > 1) {
      const x = bx - 0.5;
      parts.push(line(x, topY - 0.25, x, botY + 0.25, THICK, 'bracket'));
      parts.push(glyph('bracketTop', x - THICK / 2, topY - 0.25));
      parts.push(glyph('bracketBottom', x - THICK / 2, botY + 0.25));
      bx = x - 1;
    }
    // 楽器名（最初の段はフルネーム、以降は略称）
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
  const measures = MS.map((ms, m) => ({ m, sys: ms.geo.sys, x0: ms.geo.x0, x1: ms.geo.x1, cx: ms.geo.cx, ons: ms.geo.ons, len: ms.geo.len }));
  // evGeom を「ページ座標」に
  for (const id in evGeom) {
    const g = evGeom[id];
    const si = sysInfo[g.k];
    g.page = si.page;
    g.oy = si.staffYs[g.r];
  }
  return { pages: pageSvgs, systems: sysInfo, measures, rows: SL.map(r => ({ p: r.p, s: r.s })), clefs, evGeom, attrs: A, pageW, pageH };
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
