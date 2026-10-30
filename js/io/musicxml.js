// MusicXML の読み書き（Finale / MuseScore / Dorico / Sibelius と楽譜をやり取りする共通形式）
import { parseXML, kid, kids, txt, num } from './xml.js';
import { TPQ, TYPES, dottedTicks, splitSpan, diatonic, fromDiatonic, midiOf, keyAlter, clefKeyFromXml, CLEFS, beatTicks, TYPE_FLAGS } from '../core/music.js';
import { createScore, measureAttrs, evTicks, measureRest, newId, INSTRUMENTS, INST, fillMeasures } from '../core/score.js';
import { positions, normalizeVoice } from '../core/edit.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const ACC_NAME = { '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };

// ═════════ 書き出し ═════════
export function exportMusicXML(score) {
  const A = measureAttrs(score);
  // 全ての長さが整数になる最小の divisions を求める
  let g = TPQ;
  for (const part of score.parts) for (const st of part.staves) st.measures.forEach((sm, m) => {
    g = gcd(g, A[m].len);
    sm.voices.forEach(v => v && v.forEach(ev => (g = gcd(g, evTicks(ev)))));
  });
  const div = TPQ / g;
  const dur = (ticks) => Math.round(ticks / g);
  const meta = score.meta;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="4.0">');
  if (meta.title) out.push(`  <work><work-title>${esc(meta.title)}</work-title></work>`);
  if (meta.subtitle) out.push(`  <movement-title>${esc(meta.subtitle)}</movement-title>`);
  out.push('  <identification>');
  for (const t of ['composer', 'lyricist', 'arranger']) if (meta[t]) out.push(`    <creator type="${t}">${esc(meta[t])}</creator>`);
  if (meta.copyright) out.push(`    <rights>${esc(meta.copyright)}</rights>`);
  out.push(`    <encoding><software>KANADE</software><encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date></encoding>`);
  out.push('  </identification>');
  if (meta.title) out.push(`  <credit page="1"><credit-type>title</credit-type><credit-words justify="center" valign="top" font-size="22">${esc(meta.title)}</credit-words></credit>`);
  if (meta.composer) out.push(`  <credit page="1"><credit-type>composer</credit-type><credit-words justify="right" valign="top">${esc(meta.composer)}</credit-words></credit>`);
  out.push('  <part-list>');
  score.parts.forEach((p, i) => {
    const id = 'P' + (i + 1);
    out.push(`    <score-part id="${id}"><part-name>${esc(p.name)}</part-name><part-abbreviation>${esc(p.abbr)}</part-abbreviation>` +
      `<score-instrument id="${id}-I1"><instrument-name>${esc(p.name)}</instrument-name></score-instrument>` +
      `<midi-instrument id="${id}-I1"><midi-channel>${(i % 15) + 1 + (i % 15 >= 9 ? 1 : 0)}</midi-channel><midi-program>${p.program + 1}</midi-program></midi-instrument></score-part>`);
  });
  out.push('  </part-list>');

  score.parts.forEach((part, pi) => {
    const inst = INST[part.inst] || {};
    out.push(`  <part id="P${pi + 1}">`);
    const nst = part.staves.length;
    const tieOpen = {}; // `${s}:${v}:${midi}` → true（前の音からタイが来ている）
    for (let m = 0; m < score.measures.length; m++) {
      const ms = score.measures[m];
      const a = A[m];
      out.push(`    <measure number="${ms.pickup && m === 0 ? 0 : m + (score.measures[0].pickup ? 0 : 1)}"${ms.pickup && m === 0 ? ' implicit="yes"' : ''}>`);
      // attributes
      const at = [];
      if (m === 0) at.push(`<divisions>${div}</divisions>`);
      if (m === 0 || ms.key) at.push(`<key><fifths>${a.fifths}</fifths></key>`);
      if (m === 0 || ms.time) at.push(`<time${a.time.symbol ? ` symbol="${a.time.symbol}"` : ''}><beats>${a.time.beats}</beats><beat-type>${a.time.beatType}</beat-type></time>`);
      if (m === 0 && nst > 1) at.push(`<staves>${nst}</staves>`);
      part.staves.forEach((st, s) => {
        const ck = m === 0 ? st.clef : st.measures[m].clef;
        if (!ck) return;
        const c = CLEFS[ck] || CLEFS.treble;
        at.push(`<clef${nst > 1 ? ` number="${s + 1}"` : ''}><sign>${c.sign}</sign>${c.sign === 'percussion' ? '' : `<line>${c.line}</line>`}${c.oct ? `<clef-octave-change>${c.oct}</clef-octave-change>` : ''}</clef>`);
      });
      if (m === 0 && inst.oct) at.push(`<transpose><diatonic>${inst.trans.diatonic}</diatonic><chromatic>${inst.trans.chromatic}</chromatic></transpose>`);
      if (at.length) out.push(`      <attributes>${at.join('')}</attributes>`);
      if (ms.tempo && pi === 0) {
        out.push(`      <direction placement="above"><direction-type>${ms.tempo.text ? `<words font-weight="bold">${esc(ms.tempo.text)}</words></direction-type><direction-type>` : ''}<metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>${ms.tempo.bpm}</per-minute></metronome></direction-type><sound tempo="${ms.tempo.bpm}"/></direction>`);
      }
      let first = true;
      part.staves.forEach((st, s) => {
        const sm = st.measures[m];
        const accs = accidentalMap(sm, a.fifths);
        sm.voices.forEach((voice, v) => {
          if (!voice) return;
          if (!first) out.push(`      <backup><duration>${dur(a.len)}</duration></backup>`);
          first = false;
          const beams = beamStates(voice, a.time);
          let tupOpen = null;
          positions(voice).forEach((x, idx) => {
            const ev = x.ev;
            const d = dur(x.end - x.start);
            const vn = s * 4 + v + 1;
            const tm = ev.tuplet ? `<time-modification><actual-notes>${ev.tuplet.actual}</actual-notes><normal-notes>${ev.tuplet.normal}</normal-notes></time-modification>` : '';
            let tupN = '';
            if (ev.tuplet) {
              const nextEv = voice[idx + 1];
              if (tupOpen !== ev.tuplet.id) { tupN += '<tuplet type="start" bracket="yes"/>'; tupOpen = ev.tuplet.id; }
              if (!nextEv || !nextEv.tuplet || nextEv.tuplet.id !== ev.tuplet.id) { tupN += '<tuplet type="stop"/>'; tupOpen = null; }
            }
            const staffT = nst > 1 ? `<staff>${s + 1}</staff>` : '';
            const typeT = ev.mr ? '' : `<type>${ev.type}</type>${'<dot/>'.repeat(ev.dots || 0)}`;
            if (ev.rest) {
              out.push(`      <note><rest${ev.mr ? ' measure="yes"' : ''}/><duration>${d}</duration><voice>${vn}</voice>${typeT}${tm}${staffT}${tupN ? `<notations>${tupN}</notations>` : ''}</note>`);
              return;
            }
            ev.notes.forEach((n, k) => {
              const midi = midiOf(n);
              const key = `${s}:${v}:${midi}`;
              const stop = tieOpen[key];
              delete tieOpen[key];
              if (n.tie) tieOpen[key] = true;
              const ties = (stop ? '<tie type="stop"/>' : '') + (n.tie ? '<tie type="start"/>' : '');
              const tied = (stop ? '<tied type="stop"/>' : '') + (n.tie ? '<tied type="start"/>' : '');
              const acc = accs.get(n) ? `<accidental>${ACC_NAME[n.alter || 0]}</accidental>` : '';
              const beamT = k === 0 && beams[idx] ? beams[idx].map((b, li) => `<beam number="${li + 1}">${b}</beam>`).join('') : '';
              const notations = tied + (k === 0 ? tupN : '');
              out.push(`      <note>${k > 0 ? '<chord/>' : ''}<pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ''}<octave>${n.octave}</octave></pitch>` +
                `<duration>${d}</duration>${ties}<voice>${vn}</voice>${typeT}${acc}${tm}${staffT}${beamT}${notations ? `<notations>${notations}</notations>` : ''}</note>`);
            });
          });
        });
      });
      if (ms.barline === 'final') out.push('      <barline location="right"><bar-style>light-heavy</bar-style></barline>');
      else if (ms.barline === 'double') out.push('      <barline location="right"><bar-style>light-light</bar-style></barline>');
      out.push('    </measure>');
    }
    out.push('  </part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}

// 書き出し用：どの音に臨時記号を表示するか（浄書エンジンと同じ規則）
function accidentalMap(sm, fifths) {
  const res = new Map();
  const all = [];
  sm.voices.forEach((voice, v) => voice && positions(voice).forEach(x => { if (!x.ev.rest) all.push({ ...x, v }); }));
  all.sort((a, b) => a.start - b.start || a.v - b.v);
  const state = {};
  for (const x of all) for (const n of x.ev.notes) {
    const key = n.step + n.octave, alt = n.alter || 0;
    const cur = key in state ? state[key] : keyAlter(fifths, n.step);
    if (alt !== cur) res.set(n, true);
    state[key] = alt;
  }
  return res;
}

// 書き出し用：連桁（begin / continue / end / forward hook / backward hook）
function beamStates(voice, time) {
  const beat = beatTicks(time);
  const pos = positions(voice);
  const out = [];
  let grp = [];
  const flush = () => {
    if (grp.length > 1) {
      const maxL = Math.max(...grp.map(x => TYPE_FLAGS[x.ev.type]));
      grp.forEach((x, i) => {
        const arr = [];
        for (let L = 1; L <= maxL; L++) {
          const has = TYPE_FLAGS[x.ev.type] >= L;
          if (!has) break;
          const prev = i > 0 && TYPE_FLAGS[grp[i - 1].ev.type] >= L;
          const next = i < grp.length - 1 && TYPE_FLAGS[grp[i + 1].ev.type] >= L;
          arr.push(prev && next ? 'continue' : prev ? 'end' : next ? 'begin' : i === grp.length - 1 ? 'backward hook' : 'forward hook');
        }
        out[x.i] = arr;
      });
    }
    grp = [];
  };
  let key = null;
  for (const x of pos) {
    const ok = !x.ev.rest && TYPE_FLAGS[x.ev.type] > 0;
    if (!ok) { flush(); key = null; continue; }
    const k = x.ev.tuplet ? 'T' + x.ev.tuplet.id : 'B' + Math.floor(x.start / beat);
    if (k !== key) flush();
    key = k;
    grp.push(x);
  }
  flush();
  return out;
}

// ═════════ 読み込み ═════════
function guessInst(name, program) {
  const n = (name || '').toLowerCase();
  const table = [
    [/piccolo|ピッコロ/, 'piccolo'], [/flute|フルート/, 'flute'], [/oboe|オーボエ/, 'oboe'], [/bass\s*clar|バス・?クラ/, 'bassclarinet'], [/clarinet|クラリネット/, 'clarinet'],
    [/bassoon|fagott|ファゴット|バスーン/, 'bassoon'], [/recorder|リコーダー/, 'recorder'],
    [/soprano\s*sax|ソプラノ・?サックス/, 'sopsax'], [/alto\s*sax|アルト・?サックス/, 'altosax'], [/tenor\s*sax|テナー・?サックス/, 'tenorsax'], [/bari(tone)?\s*sax|バリトン・?サックス/, 'barisax'],
    [/trumpet|cornet|トランペット/, 'trumpet'], [/horn|ホルン/, 'horn'], [/trombone|トロンボーン/, 'trombone'], [/euphonium|ユーフォ/, 'euphonium'], [/tuba|テューバ|チューバ/, 'tuba'],
    [/violin|ヴァイオリン|バイオリン/, 'violin'], [/viola|ヴィオラ/, 'viola'], [/cello|チェロ/, 'cello'], [/contrabass|double\s*bass|コントラバス/, 'contrabass'],
    [/bass\s*guitar|electric\s*bass|ベース/, 'bassguitar'], [/guitar|ギター/, 'guitar'], [/harp(?!s)|ハープ/, 'harp'],
    [/harpsichord|cembalo|チェンバロ/, 'harpsichord'], [/organ|オルガン/, 'organ'], [/e(lectric)?\.?\s*piano/, 'epiano'], [/piano|pno|ピアノ/, 'piano'],
    [/timpani|ティンパニ/, 'timpani'], [/marimba|マリンバ/, 'marimba'], [/xylophone|シロフォン/, 'xylophone'], [/vibraphone|ヴィブラフォン/, 'vibraphone'], [/glockenspiel|グロッケン/, 'glockenspiel'],
    [/soprano|ソプラノ/, 'soprano'], [/alto|アルト/, 'alto'], [/tenor|テノール|テナー/, 'tenor'], [/^bass|バス$|basso/, 'bass'], [/voice|vocal|voix|歌|melody|メロディ/, 'voice'],
  ];
  for (const [re, id] of table) if (re.test(n)) return id;
  if (program != null) { const f = INSTRUMENTS.find(i => i.program === program); if (f) return f.id; }
  return 'piano';
}

function transposePitch(p, dia, chrom) {
  if (!dia && !chrom) return p;
  const q = fromDiatonic(diatonic(p) + dia);
  const target = midiOf(p) + chrom;
  q.alter = target - midiOf({ ...q, alter: 0 });
  if (Math.abs(q.alter) > 2) return { ...p, octave: p.octave + Math.round(chrom / 12) };
  return q;
}

export function importMusicXML(xmlText) {
  const root = parseXML(xmlText);
  if (!root) throw new Error('XML として読めません');
  if (root.name === 'score-timewise') throw new Error('score-timewise 形式は未対応です（partwise で書き出してください）');
  if (root.name !== 'score-partwise') throw new Error('MusicXML ファイルではないようです');

  // ── メタ情報 ──
  const meta = { title: '', subtitle: '', composer: '', lyricist: '', arranger: '', copyright: '' };
  meta.title = txt(kid(root, 'work'), 'work-title') || txt(root, 'movement-title');
  if (txt(kid(root, 'work'), 'work-title') && txt(root, 'movement-title') && txt(root, 'movement-title') !== meta.title) meta.subtitle = txt(root, 'movement-title');
  const ident = kid(root, 'identification');
  for (const c of kids(ident, 'creator')) { const t = c.attrs.type; if (t in meta && !meta[t]) meta[t] = c.text.trim(); }
  meta.copyright = txt(ident, 'rights');
  for (const cr of kids(root, 'credit')) {
    const type = txt(cr, 'credit-type');
    const words = kids(cr, 'credit-words').map(w => w.text.trim()).join(' ');
    if (type === 'title' && !meta.title) meta.title = words;
    if (type === 'subtitle' && !meta.subtitle) meta.subtitle = words;
    if (type === 'composer' && !meta.composer) meta.composer = words;
    if (type === 'lyricist' && !meta.lyricist) meta.lyricist = words;
  }

  // ── パート一覧 ──
  const plist = kid(root, 'part-list');
  const pinfo = {};
  for (const sp of kids(plist, 'score-part')) {
    const prog = num(kid(sp, 'midi-instrument'), 'midi-program', 0);
    pinfo[sp.attrs.id] = { name: txt(sp, 'part-name') || txt(sp, 'part-name-display'), abbr: txt(sp, 'part-abbreviation'), program: prog ? prog - 1 : null };
  }

  const xparts = kids(root, 'part');
  if (!xparts.length) throw new Error('パートがありません');
  const nMeasures = Math.max(...xparts.map(p => kids(p, 'measure').length));
  const score = createScore({ insts: [], measures: nMeasures });
  score.parts = [];
  score.meta = { ...score.meta, ...meta, title: meta.title || '無題' };
  // 小節の属性は最初のパートから取る
  const gm = score.measures;
  gm.forEach((m, i) => { delete m.time; delete m.key; delete m.tempo; delete m.barline; void i; });

  xparts.forEach((xp, pi) => {
    const info = pinfo[xp.attrs.id] || { name: 'Part ' + (pi + 1) };
    const instId = guessInst(info.name, info.program);
    const inst = INST[instId];
    // 譜表数
    let nStaves = 1;
    for (const xm of kids(xp, 'measure')) { const at = kid(xm, 'attributes'); if (at && kid(at, 'staves')) { nStaves = num(at, 'staves', 1); break; } }
    const part = {
      id: newId(), inst: instId, name: info.name || inst.ja, abbr: info.abbr || inst.abbr,
      program: info.program ?? inst.program,
      staves: Array.from({ length: nStaves }, (_, s) => ({ clef: inst.clefs[s] || (s === 0 ? 'treble' : 'bass'), measures: [] })),
    };
    score.parts.push(part);
    let divisions = 1;
    let trans = { dia: 0, chrom: 0 };
    const voiceMap = Array.from({ length: nStaves }, () => ({})); // 譜表ごと：MusicXML の voice 番号 → 声部 0〜3
    const pendingClef = {};
    // 小節の長さは後で計算するので、まず生のイベントを集める
    const raw = []; // raw[m] = { evs: { 's:v': [{start, ev}] }, len }
    kids(xp, 'measure').forEach((xm, m) => {
      const bucket = {};
      let pos = 0, maxPos = 0;
      let lastEv = null;
      let tupletId = {}; // 's:v' → 現在の連符 id
      const mAttr = gm[m];
      if (m === 0 && xm.attrs.implicit === 'yes') mAttr._implicit = true;
      for (const k in pendingClef) { part.staves[+k].measures[m] = { voices: [], clef: pendingClef[k] }; delete pendingClef[k]; }
      for (const el of xm.children) {
        if (el.name === 'attributes') {
          if (kid(el, 'divisions')) divisions = num(el, 'divisions', 1);
          const tr0 = kid(el, 'transpose');
          if (tr0) trans = { dia: num(tr0, 'diatonic', 0) + num(tr0, 'octave-change', 0) * 7, chrom: num(tr0, 'chromatic', 0) + num(tr0, 'octave-change', 0) * 12 };
          if (pi === 0 && kid(el, 'key')) {
            // 移調楽器の調号は「記譜上の調」なので、実音の調に直す（B♭管なら ♭2つぶん）
            let f = num(kid(el, 'key'), 'fifths', 0) + ((((trans.chrom * 7) % 12) + 18) % 12 - 6);
            if (f > 7) f -= 12; if (f < -7) f += 12;
            if (m === 0 || pos === 0) mAttr.key = { fifths: f }; else if (gm[m + 1]) gm[m + 1].key = { fifths: f };
          }
          if (pi === 0 && kid(el, 'time')) {
            const t = kid(el, 'time');
            const beats = parseInt(txt(t, 'beats'), 10) || 4, bt = num(t, 'beat-type', 4);
            const tt = { beats, beatType: bt };
            if (t.attrs.symbol === 'common' || t.attrs.symbol === 'cut') tt.symbol = t.attrs.symbol;
            if (m === 0 || pos === 0) mAttr.time = tt; else if (gm[m + 1]) gm[m + 1].time = tt;
          }
          for (const c of kids(el, 'clef')) {
            const s = (parseInt(c.attrs.number, 10) || 1) - 1;
            if (s >= nStaves) continue;
            const ck = clefKeyFromXml(txt(c, 'sign'), num(c, 'line', 0), num(c, 'clef-octave-change', 0));
            if (m === 0 && pos === 0) part.staves[s].clef = ck;
            else if (pos === 0) { part.staves[s].measures[m] = part.staves[s].measures[m] || { voices: [] }; part.staves[s].measures[m].clef = ck; }
            else pendingClef[s] = ck; // 小節の途中の変更は次の小節の頭で
          }
        } else if (el.name === 'backup') {
          pos -= Math.round((num(el, 'duration', 0) * TPQ) / divisions);
          if (pos < 0) pos = 0;
        } else if (el.name === 'forward') {
          pos += Math.round((num(el, 'duration', 0) * TPQ) / divisions);
          maxPos = Math.max(maxPos, pos);
        } else if (el.name === 'direction') {
          if (pi !== 0 && Object.keys(gm[m]).includes('tempo')) continue;
          const snd = kid(el, 'sound');
          let bpm = snd && snd.attrs.tempo ? parseFloat(snd.attrs.tempo) : null;
          let text = '';
          for (const dt of kids(el, 'direction-type')) {
            const met = kid(dt, 'metronome');
            if (met && !bpm) { const pm = num(met, 'per-minute', 0); const bu = txt(met, 'beat-unit'); const dotted = !!kid(met, 'beat-unit-dot'); if (pm) bpm = pm * (TYPES.includes(bu) ? dottedTicks(bu, dotted ? 1 : 0) / TPQ : 1); }
            const w = kid(dt, 'words');
            if (w && /^[A-Za-z][A-Za-z .]{2,24}$/.test(w.text.trim()) && /(adagio|andante|allegr|moderato|presto|largo|lento|vivace|grave|tempo|rit|accel)/i.test(w.text)) text = w.text.trim();
          }
          if (bpm && !gm[m].tempo) gm[m].tempo = { bpm: Math.round(bpm), ...(text ? { text } : {}) };
        } else if (el.name === 'barline' && pi === 0) {
          const st = txt(el, 'bar-style');
          if (st === 'light-heavy') gm[m].barline = 'final';
          else if (st === 'light-light') gm[m].barline = 'double';
        } else if (el.name === 'note') {
          if (kid(el, 'grace')) continue; // 装飾音は Phase 2
          const isChord = !!kid(el, 'chord');
          const s = Math.min(nStaves, parseInt(txt(el, 'staff'), 10) || 1) - 1;
          const vid = txt(el, 'voice') || '1';
          const vm = voiceMap[s];
          if (!(vid in vm)) vm[vid] = Math.min(3, Object.keys(vm).length);
          const v = vm[vid];
          const key = s + ':' + v;
          const type = txt(el, 'type');
          const dots = kids(el, 'dot').length;
          const tmod = kid(el, 'time-modification');
          const xdur = num(el, 'duration', 0);
          const rest = kid(el, 'rest');
          let ticks;
          if (TYPES.includes(type)) ticks = dottedTicks(type, dots) * (tmod ? num(tmod, 'normal-notes', 1) / num(tmod, 'actual-notes', 1) : 1);
          else ticks = Math.round((xdur * TPQ) / divisions);
          ticks = Math.round(ticks);
          // 音高
          let pitch = null;
          const pt = kid(el, 'pitch');
          if (pt) pitch = { step: txt(pt, 'step', 'C'), alter: Math.round(num(pt, 'alter', 0)), octave: num(pt, 'octave', 4) };
          const up = kid(el, 'unpitched');
          if (up) pitch = { step: txt(up, 'display-step', 'B'), alter: 0, octave: num(up, 'display-octave', 4) };
          if (pitch) {
            pitch = transposePitch(pitch, trans.dia, trans.chrom); // 記譜音 → 実音
            if (inst.oct) pitch = transposePitch(pitch, -Math.round(inst.oct / 12) * 7, -inst.oct); // オクターブ移調楽器は記譜で持つ
          }
          const tie = kids(el, 'tie').some(t => t.attrs.type === 'start') || kids(kid(el, 'notations'), 'tied').some(t => t.attrs.type === 'start');
          if (isChord && lastEv && pitch) {
            lastEv.ev.rest = false;
            if (!lastEv.ev.notes.some(q => q.step === pitch.step && q.octave === pitch.octave && q.alter === pitch.alter)) lastEv.ev.notes.push({ ...pitch, tie });
            continue;
          }
          const start = pos;
          const ev = { id: newId(), rest: !pitch, type: TYPES.includes(type) ? type : 'quarter', dots, notes: pitch ? [{ ...pitch, tie }] : [] };
          if (rest && (rest.attrs.measure === 'yes' || !type)) ev._mr = true;
          if (!TYPES.includes(type) && !ev._mr) {
            // type がない音符：長さから音価を推測
            for (const ty of TYPES) for (let d2 = 0; d2 <= 2; d2++) if (dottedTicks(ty, d2) === ticks) { ev.type = ty; ev.dots = d2; }
          }
          if (tmod) {
            const actual = num(tmod, 'actual-notes', 3), normal = num(tmod, 'normal-notes', 2);
            const tups = kids(kid(el, 'notations'), 'tuplet');
            if (tups.some(t => t.attrs.type === 'start') || !tupletId[key] || tupletId[key].ratio !== actual + '/' + normal || tupletId[key].left <= 0) {
              tupletId[key] = { id: newId(), ratio: actual + '/' + normal, left: Math.round(dottedTicks(ev.type, 0) * normal) };
            }
            ev.tuplet = { id: tupletId[key].id, actual, normal };
            tupletId[key].left -= ticks;
            if (tups.some(t => t.attrs.type === 'stop')) tupletId[key].left = 0;
          }
          (bucket[key] = bucket[key] || []).push({ start, ev, ticks });
          lastEv = { ev };
          pos += ticks;
          maxPos = Math.max(maxPos, pos);
        }
      }
      raw[m] = { bucket, maxPos };
    });
    part._raw = raw;
  });

  // 小節の長さが決まったので、各声部を「すき間なく」組み立てる
  if (!gm[0].time) gm[0].time = { beats: 4, beatType: 4 };
  if (!gm[0].key) gm[0].key = { fifths: 0 };
  if (!gm[0].tempo) gm[0].tempo = { bpm: 100 };
  let A = measureAttrs(score);
  if (gm[0]._implicit) {
    const used = Math.max(...score.parts.map(p => p._raw[0]?.maxPos || 0));
    if (used > 0 && used < A[0].full) gm[0].pickup = used;
  }
  gm.forEach(m => delete m._implicit);
  if (!gm.some(m => m.barline === 'final')) gm[gm.length - 1].barline = 'final';
  A = measureAttrs(score);
  score.parts.forEach((part, p) => {
    part.staves.forEach((st, s) => {
      for (let m = 0; m < gm.length; m++) {
        const sm = st.measures[m] || { voices: [] };
        st.measures[m] = sm;
        sm.voices = [];
        const raw = part._raw[m];
        const len = A[m].len;
        for (let v = 0; v < 4; v++) {
          const list = raw && raw.bucket[s + ':' + v];
          if (!list || !list.length) continue;
          list.sort((a, b) => a.start - b.start);
          const evs = [];
          let t = 0;
          const fill = (to) => {
            if (to <= t) return;
            for (const x of splitSpan(t, to, A[m].time, A[m].full - len)) evs.push({ id: newId(), rest: true, type: x.type, dots: x.dots, notes: [] });
            t = to;
          };
          for (const x of list) {
            if (x.start < t || x.start >= len) continue; // 重なり・はみ出しは捨てる
            fill(x.start);
            let ev = x.ev;
            let d = x.ticks;
            if (ev._mr) { delete ev._mr; if (x.start === 0) { ev = measureRest(len); d = len; } else ev.type = 'whole'; }
            if (t + d > len) {
              // 小節からはみ出す音符は切り詰める
              d = len - t;
              const q = splitSpan(t, len, A[m].time)[0];
              if (q) { ev.type = q.type; ev.dots = q.dots; d = q.ticks; delete ev.tuplet; }
            }
            ev.notes.sort((a, b) => diatonic(a) - diatonic(b));
            evs.push(ev);
            t += d;
          }
          fill(len);
          sm.voices[v] = evs;
        }
        if (!sm.voices[0]) sm.voices[0] = [measureRest(len)];
        for (let v = 0; v < sm.voices.length; v++) if (sm.voices[v]) normalizeVoice(score, A, p, s, m, v);
        for (let v = 0; v < sm.voices.length; v++) if (sm.voices[v] === undefined) sm.voices[v] = null;
      }
    });
    delete part._raw;
  });
  fillMeasures(score);
  return score;
}

export { CLEFS };
