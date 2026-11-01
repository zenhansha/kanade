// MusicXML の読み書き（Finale / MuseScore / Dorico / Sibelius と楽譜をやり取りする共通形式）
//
// Phase 2 で増えたもの：アーティキュレーション・強弱/文字の表情記号・コードネーム・スラー・松葉・8va・ペダル・トリル線・
// 歌詞・装飾音符・反復記号（|: :|・カッコ）・セーニョ/コーダ/Fine/D.C./D.S.
import { parseXML, kid, kids, txt, num } from './xml.js';
import { TPQ, TYPES, dottedTicks, splitSpan, diatonic, midiOf, keyAlter, clefKeyFromXml, CLEFS, beatTicks, TYPE_FLAGS, transposeInterval } from '../core/music.js';
import { createScore, measureAttrs, evTicks, measureRest, newId, INSTRUMENTS, INST, fillMeasures } from '../core/score.js';
import { positions, normalizeVoice } from '../core/edit.js';
import { ARTICS, DYNAMICS, JUMPS, parseChord, spanEnd } from '../core/marks.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const ACC_NAME = { '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };

// アーティキュレーション ⇄ MusicXML（どの要素の中に書くか）
const ART_XML = {
  stacc: ['articulations', 'staccato'], staccss: ['articulations', 'staccatissimo'], ten: ['articulations', 'tenuto'],
  acc: ['articulations', 'accent'], marc: ['articulations', 'strong-accent'], breath: ['articulations', 'breath-mark'],
  tr: ['ornaments', 'trill-mark'], mord: ['ornaments', 'mordent'], prall: ['ornaments', 'inverted-mordent'], turn: ['ornaments', 'turn'],
  up: ['technical', 'up-bow'], down: ['technical', 'down-bow'], ferm: [null, 'fermata'],
};
const XML_ART = Object.fromEntries(Object.entries(ART_XML).map(([k, [, el]]) => [el, k]));
// コードネームの種類（MusicXML の kind）。読み込みは text 属性を優先し、なければこの表で記号にする
const KINDS = [
  ['', 'major'], ['m', 'minor'], ['7', 'dominant'], ['maj7', 'major-seventh'], ['M7', 'major-seventh'], ['m7', 'minor-seventh'],
  ['dim', 'diminished'], ['dim7', 'diminished-seventh'], ['m7b5', 'half-diminished'], ['aug', 'augmented'], ['+', 'augmented'],
  ['6', 'major-sixth'], ['m6', 'minor-sixth'], ['9', 'dominant-ninth'], ['maj9', 'major-ninth'], ['m9', 'minor-ninth'],
  ['sus4', 'suspended-fourth'], ['sus2', 'suspended-second'], ['7sus4', 'suspended-fourth'], ['mM7', 'major-minor'], ['11', 'dominant-11th'], ['13', 'dominant-13th'],
];
const kindOf = (q) => (KINDS.find(k => k[0] === q) || [q, q.startsWith('m') && !q.startsWith('maj') ? 'minor' : /7|9|11|13/.test(q) ? 'dominant' : 'major'])[1];
const qualityOf = (kind) => (KINDS.find(k => k[1] === kind) || ['', ''])[0];

// ═════════ 書き出し ═════════
export function exportMusicXML(score) {
  const A = measureAttrs(score);
  // 全ての長さが整数になる最小の divisions を求める
  let g = TPQ;
  for (const part of score.parts) for (const st of part.staves) st.measures.forEach((sm, m) => {
    g = gcd(g, A[m].len);
    sm.voices.forEach(v => v && v.forEach(ev => (g = gcd(g, evTicks(ev)))));
    (sm.dirs || []).forEach(d => (g = gcd(g, d.t || TPQ)));
    (sm.spans || []).forEach(sp => (g = gcd(g, gcd(sp.t || TPQ, sp.t2 || TPQ))));
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
  // カッコの終わり：その小節で終わるカッコ
  const endingStop = {};
  score.measures.forEach((ms, m) => { if (ms.ending) endingStop[m + Math.max(1, ms.ending.len || 1) - 1] = ms.ending; });

  score.parts.forEach((part, pi) => {
    const inst = INST[part.inst] || {};
    out.push(`  <part id="P${pi + 1}">`);
    const nst = part.staves.length;
    const tieOpen = {}; // `${s}:${v}:${midi}` → true（前の音からタイが来ている）
    // スラー・トリル線：始まりと終わりの音符 id → 番号
    const noteMarks = {}; // id → { start: [xml], stop: [xml] }
    const nm = (id) => (noteMarks[id] = noteMarks[id] || { start: [], stop: [] });
    // 譜表の小節ごとの「位置つきの指示」（強弱・文字・コードネーム・松葉・8va・ペダル）
    const posDirs = part.staves.map(() => score.measures.map(() => []));
    part.staves.forEach((st, s) => {
      let slurNo = 0;
      st.measures.forEach((sm, m) => {
        const staffT = nst > 1 ? `<staff>${s + 1}</staff>` : '';
        for (const d of sm.dirs || []) {
          if (d.k === 'dyn') posDirs[s][m].push({ t: d.t, xml: (off) => `<direction placement="${'below'}"><direction-type><dynamics><${d.v}/></dynamics></direction-type>${off}${staffT}</direction>` });
          else if (d.k === 'text') posDirs[s][m].push({ t: d.t, xml: (off) => `<direction placement="${d.pos === 'below' ? 'below' : 'above'}"><direction-type><words${d.it === false ? '' : ' font-style="italic"'}>${esc(d.text)}</words></direction-type>${off}${staffT}</direction>` });
          else if (d.k === 'chord') posDirs[s][m].push({ t: d.t, harmony: true, xml: (off) => harmonyXml(d.text, off, staffT) });
        }
        (sm.spans || []).forEach(sp => {
          const e = spanEnd(m, sp);
          if (e.m >= score.measures.length) return;
          const startEv = positions(sm.voices[sp.v] || sm.voices[0]).find(x => x.start === sp.t);
          const endPos = positions(st.measures[e.m].voices[sp.v] || st.measures[e.m].voices[0]).find(x => x.start === e.t);
          if (sp.k === 'slur' || sp.k === 'trill') {
            if (!startEv || !endPos) return;
            const no = (slurNo++ % 6) + 1;
            if (sp.k === 'slur') { nm(startEv.ev.id).start.push(`<slur type="start" number="${no}"/>`); nm(endPos.ev.id).stop.push(`<slur type="stop" number="${no}"/>`); }
            else { nm(startEv.ev.id).start.push(`<ornaments><trill-mark/><wavy-line type="start" number="${no}"/></ornaments>`); nm(endPos.ev.id).stop.push(`<ornaments><wavy-line type="stop" number="${no}"/></ornaments>`); }
            return;
          }
          const stopT = endPos ? endPos.end : e.t;
          const [st0, sp0, pl] = sp.k === 'cresc' ? ['<wedge type="crescendo"/>', '<wedge type="stop"/>', 'below'] : sp.k === 'dim' ? ['<wedge type="diminuendo"/>', '<wedge type="stop"/>', 'below']
            : sp.k === 'ped' ? ['<pedal type="start" line="no" sign="yes"/>', '<pedal type="stop" line="no" sign="yes"/>', 'below']
            : sp.k === '8vb' ? ['<octave-shift type="up" size="8"/>', '<octave-shift type="stop" size="8"/>', 'below']
            : [`<octave-shift type="down" size="${sp.k === '15ma' ? 15 : 8}"/>`, `<octave-shift type="stop" size="${sp.k === '15ma' ? 15 : 8}"/>`, 'above'];
          posDirs[s][m].push({ t: sp.t, xml: (off) => `<direction placement="${pl}"><direction-type>${st0}</direction-type>${off}${staffT}</direction>` });
          posDirs[s][e.m].push({ t: stopT, xml: (off) => `<direction placement="${pl}"><direction-type>${sp0}</direction-type>${off}${staffT}</direction>` });
        });
      });
    });
    const lyrPrev = {}; // `${s}:${v}:${verse}` → 前の音節がハイフンでつながっているか

    for (let m = 0; m < score.measures.length; m++) {
      const ms = score.measures[m];
      const a = A[m];
      out.push(`    <measure number="${ms.pickup && m === 0 ? 0 : m + (score.measures[0].pickup ? 0 : 1)}"${ms.pickup && m === 0 ? ' implicit="yes"' : ''}>`);
      // 左の小節線（反復の始まり・カッコの始まり）
      if (ms.repeatStart || ms.ending) {
        const nums = ms.ending ? (ms.ending.nums || [1]) : null;
        out.push(`      <barline location="left">${ms.repeatStart ? '<bar-style>heavy-light</bar-style>' : ''}${nums ? `<ending number="${nums.join(', ')}" type="start">${nums.join('., ')}.</ending>` : ''}${ms.repeatStart ? '<repeat direction="forward"/>' : ''}</barline>`);
      }
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
      if (pi === 0 && ms.segno) out.push('      <direction placement="above"><direction-type><segno/></direction-type><sound segno="segno"/></direction>');
      if (pi === 0 && ms.coda) out.push('      <direction placement="above"><direction-type><coda/></direction-type><sound coda="coda"/></direction>');
      let first = true;
      part.staves.forEach((st, s) => {
        const sm = st.measures[m];
        const accs = accidentalMap(sm, a.fifths);
        const dirs = posDirs[s][m].sort((x, y) => x.t - y.t || (x.harmony ? -1 : 1) - (y.harmony ? -1 : 1));
        let di = 0;
        const flushDirs = (until, curPos) => {
          while (di < dirs.length && dirs[di].t < until) {
            const off = dirs[di].t - curPos;
            out.push('      ' + dirs[di].xml(off > 0 ? `<offset>${dur(off)}</offset>` : ''));
            di++;
          }
        };
        sm.voices.forEach((voice, v) => {
          if (!voice) return;
          if (!first) out.push(`      <backup><duration>${dur(a.len)}</duration></backup>`);
          first = false;
          const beams = beamStates(voice, a.time);
          let tupOpen = null;
          positions(voice).forEach((x, idx) => {
            const ev = x.ev;
            if (v === 0) flushDirs(x.end, x.start);
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
            // アーティキュレーション・スラーなど（和音では最初の音だけに書く）
            const marks = noteMarks[ev.id];
            const artN = artXml(ev.art) + (marks ? marks.stop.join('') + marks.start.join('') : '');
            // 歌詞
            let lyrT = '';
            (ev.lyr || []).forEach((ly, verse) => {
              if (!ly || !ly.t) return;
              const key = `${s}:${v}:${verse}`;
              const prev = !!lyrPrev[key];
              const syl = ly.h ? (prev ? 'middle' : 'begin') : (prev ? 'end' : 'single');
              lyrPrev[key] = !!ly.h;
              lyrT += `<lyric number="${verse + 1}"><syllabic>${syl}</syllabic><text>${esc(ly.t)}</text></lyric>`;
            });
            // 装飾音符（長さなし、本音符の前）
            for (const gr of ev.grace || []) gr.notes.forEach((n, k) => {
              out.push(`      <note><grace${gr.slash ? ' slash="yes"' : ''}/>${k > 0 ? '<chord/>' : ''}<pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ''}<octave>${n.octave}</octave></pitch><voice>${vn}</voice><type>${gr.type}</type>${staffT}</note>`);
            });
            if (ev.rest) {
              const notations = tupN + artN;
              out.push(`      <note><rest${ev.mr ? ' measure="yes"' : ''}/><duration>${d}</duration><voice>${vn}</voice>${typeT}${tm}${staffT}${notations ? `<notations>${notations}</notations>` : ''}</note>`);
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
              const notations = tied + (k === 0 ? tupN + artN : '');
              out.push(`      <note>${k > 0 ? '<chord/>' : ''}<pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ''}<octave>${n.octave}</octave></pitch>` +
                `<duration>${d}</duration>${ties}<voice>${vn}</voice>${typeT}${acc}${tm}${staffT}${beamT}${notations ? `<notations>${notations}</notations>` : ''}${k === 0 ? lyrT : ''}</note>`);
            });
          });
          if (v === 0) flushDirs(Infinity, a.len);
        });
      });
      // 小節の終わりの指示（Fine・To Coda・D.C./D.S.）
      if (pi === 0) {
        if (ms.fine) out.push('      <direction placement="above"><direction-type><words font-style="italic" font-weight="bold">Fine</words></direction-type><sound fine="yes"/></direction>');
        if (ms.toCoda) out.push('      <direction placement="above"><direction-type><words font-style="italic" font-weight="bold">To Coda</words></direction-type><sound tocoda="coda"/></direction>');
        if (ms.jump && JUMPS[ms.jump]) out.push(`      <direction placement="above"><direction-type><words font-style="italic" font-weight="bold">${JUMPS[ms.jump].text}</words></direction-type><sound ${JUMPS[ms.jump].to === 'segno' ? 'dalsegno="segno"' : 'dacapo="yes"'}/></direction>`);
      }
      // 右の小節線
      const style = ms.repeatEnd || ms.barline === 'final' ? 'light-heavy' : ms.barline === 'double' ? 'light-light' : null;
      const es = endingStop[m];
      if (style || es || ms.repeatEnd) {
        const nums = es ? (es.nums || [1]) : null;
        out.push(`      <barline location="right">${style ? `<bar-style>${style}</bar-style>` : ''}${nums ? `<ending number="${nums.join(', ')}" type="${ms.repeatEnd ? 'stop' : 'discontinue'}"/>` : ''}${ms.repeatEnd ? `<repeat direction="backward"${ms.repeatEnd.times > 2 ? ` times="${ms.repeatEnd.times}"` : ''}/>` : ''}</barline>`);
      }
      out.push('    </measure>');
    }
    out.push('  </part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}

function artXml(art) {
  if (!art || !art.length) return '';
  const groups = { articulations: [], ornaments: [], technical: [] };
  let ferm = '';
  for (const k of art) {
    const x = ART_XML[k];
    if (!x) continue;
    if (!x[0]) ferm = '<fermata type="upright"/>';
    else groups[x[0]].push(`<${x[1]}/>`);
  }
  return Object.entries(groups).map(([g, a]) => (a.length ? `<${g}>${a.join('')}</${g}>` : '')).join('') + ferm;
}

function harmonyXml(text, off, staffT) {
  const c = parseChord(text);
  if (!c) return `<direction placement="above"><direction-type><words>${esc(text)}</words></direction-type>${off}${staffT}</direction>`;
  const alt = (n, a) => (a ? `<${n}-alter>${a}</${n}-alter>` : '');
  return `<harmony><root><root-step>${c.root}</root-step>${alt('root', c.alter)}</root><kind text="${esc(c.quality)}">${kindOf(c.quality)}</kind>` +
    `${c.bass ? `<bass><bass-step>${c.bass}</bass-step>${alt('bass', c.bassAlter)}</bass>` : ''}${off}${staffT}</harmony>`;
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

const DYN_IMPORT = { pppp: 'ppp', ppp: 'ppp', pp: 'pp', p: 'p', mp: 'mp', mf: 'mf', f: 'f', ff: 'ff', fff: 'fff', ffff: 'fff', fp: 'fp', sf: 'sf', sfz: 'sfz', sfp: 'sfp', rfz: 'rfz', rf: 'rfz', fz: 'sfz', sffz: 'sfz', sfpp: 'sfp' };
const JUMP_WORDS = /^(D\.?\s*C\.?|D\.?\s*S\.?|Da Capo|Dal Segno|Fine|To Coda)/i;

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
  gm.forEach((m) => { delete m.time; delete m.key; delete m.tempo; delete m.barline; });
  let endingOpen = null;

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
    const openSpans = {};   // 'slur:番号' などで開いている線
    const spansRaw = [];    // { k, s, v, a: {m,t}, b: {m,t} | {m,pos} }
    const pendingGrace = {}; // 's:v' → 本音符を待っている装飾音
    // 小節の長さは後で計算するので、まず生のイベントを集める
    const raw = []; // raw[m] = { bucket: { 's:v': [{start, ev}] }, maxPos, dirs: [[...]] }
    const toTicks = (d) => Math.round((d * TPQ) / divisions);
    const readPitch = (el) => {
      let pitch = null;
      const pt = kid(el, 'pitch');
      if (pt) pitch = { step: txt(pt, 'step', 'C'), alter: Math.round(num(pt, 'alter', 0)), octave: num(pt, 'octave', 4) };
      const up = kid(el, 'unpitched');
      if (up) pitch = { step: txt(up, 'display-step', 'B'), alter: 0, octave: num(up, 'display-octave', 4) };
      if (pitch) {
        pitch = transposeInterval(pitch, trans.dia, trans.chrom); // 記譜音 → 実音
        if (inst.oct) pitch = transposeInterval(pitch, -Math.round(inst.oct / 12) * 7, -inst.oct); // オクターブ移調楽器は記譜で持つ
      }
      return pitch;
    };
    kids(xp, 'measure').forEach((xm, m) => {
      const bucket = {};
      const dirs = Array.from({ length: nStaves }, () => []);
      let pos = 0, maxPos = 0;
      let lastEv = null;
      let tupletId = {}; // 's:v' → 現在の連符 id
      const mAttr = gm[m];
      if (m === 0 && xm.attrs.implicit === 'yes') mAttr._implicit = true;
      for (const k in pendingClef) { part.staves[+k].measures[m] = { voices: [], clef: pendingClef[k] }; delete pendingClef[k]; }
      const staffOf = (el) => Math.max(0, Math.min(nStaves, parseInt(txt(el, 'staff'), 10) || 1) - 1);
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
          pos -= toTicks(num(el, 'duration', 0));
          if (pos < 0) pos = 0;
        } else if (el.name === 'forward') {
          pos += toTicks(num(el, 'duration', 0));
          maxPos = Math.max(maxPos, pos);
        } else if (el.name === 'direction') {
          const at = pos + toTicks(num(el, 'offset', 0));
          const s = staffOf(el);
          const snd = kid(el, 'sound');
          // テンポ
          if (pi === 0 || !gm[m].tempo) {
            let bpm = snd && snd.attrs.tempo ? parseFloat(snd.attrs.tempo) : null;
            let text = '';
            for (const dt of kids(el, 'direction-type')) {
              const met = kid(dt, 'metronome');
              if (met && !bpm) { const pm = num(met, 'per-minute', 0); const bu = txt(met, 'beat-unit'); const dotted = !!kid(met, 'beat-unit-dot'); if (pm) bpm = pm * (TYPES.includes(bu) ? dottedTicks(bu, dotted ? 1 : 0) / TPQ : 1); }
              const w = kid(dt, 'words');
              if (w && /^[A-Za-z][A-Za-z .]{2,24}$/.test(w.text.trim()) && /(adagio|andante|allegr|moderato|presto|largo|lento|vivace|grave|tempo|rit|accel)/i.test(w.text) && bpm) text = w.text.trim();
            }
            if (bpm && !gm[m].tempo) { gm[m].tempo = { bpm: Math.round(bpm), ...(text ? { text } : {}) }; continue; }
          }
          // 反復の指示
          if (snd) {
            if (snd.attrs.segno) gm[m].segno = true;
            if (snd.attrs.coda) gm[m].coda = true;
            if (snd.attrs.fine) gm[m].fine = true;
            if (snd.attrs.tocoda) gm[m].toCoda = true;
          }
          const words = kids(el, 'direction-type').map(dt => kid(dt, 'words')?.text?.trim()).filter(Boolean).join(' ');
          if (snd && (snd.attrs.dacapo === 'yes' || snd.attrs.dalsegno)) {
            const base = snd.attrs.dalsegno ? 'ds' : 'dc';
            gm[m].jump = base + (/fine/i.test(words) ? 'Fine' : /coda/i.test(words) ? 'Coda' : '');
          }
          for (const dt of kids(el, 'direction-type')) {
            for (const c of dt.children) {
              if (c.name === 'segno') gm[m].segno = true;
              else if (c.name === 'coda') gm[m].coda = true;
              else if (c.name === 'dynamics') {
                for (const dd of c.children) { const v = DYN_IMPORT[dd.name]; if (v) dirs[s].push({ t: at, k: 'dyn', v }); }
              } else if (c.name === 'words') {
                const w = c.text.trim();
                if (!w || JUMP_WORDS.test(w)) {
                  if (!snd && /^fine$/i.test(w)) gm[m].fine = true;
                  else if (!snd && /^to coda/i.test(w)) gm[m].toCoda = true;
                  else if (!snd && /^(D\.?\s*C\.?|Da Capo)/i.test(w)) gm[m].jump = 'dc' + (/fine/i.test(w) ? 'Fine' : /coda/i.test(w) ? 'Coda' : '');
                  else if (!snd && /^(D\.?\s*S\.?|Dal Segno)/i.test(w)) gm[m].jump = 'ds' + (/fine/i.test(w) ? 'Fine' : /coda/i.test(w) ? 'Coda' : '');
                  continue;
                }
                const pl = el.attrs.placement === 'below' ? 'below' : 'above';
                dirs[s].push({ t: at, k: 'text', text: w, pos: pl, ...(c.attrs['font-style'] === 'italic' ? { it: true } : { it: false }) });
              } else if (c.name === 'wedge') {
                const ty = c.attrs.type, no = c.attrs.number || '1';
                if (ty === 'crescendo' || ty === 'diminuendo') openSpans['w' + no] = { k: ty === 'crescendo' ? 'cresc' : 'dim', s, v: 0, a: { m, t: at } };
                else if (ty === 'stop' && openSpans['w' + no]) { spansRaw.push({ ...openSpans['w' + no], b: { m, pos: at } }); delete openSpans['w' + no]; }
              } else if (c.name === 'octave-shift') {
                const ty = c.attrs.type, no = c.attrs.number || '1', size = parseInt(c.attrs.size, 10) || 8;
                if (ty === 'down' || ty === 'up') openSpans['o' + no] = { k: ty === 'up' ? '8vb' : size >= 15 ? '15ma' : '8va', s, v: 0, a: { m, t: at } };
                else if (ty === 'stop' && openSpans['o' + no]) { spansRaw.push({ ...openSpans['o' + no], b: { m, pos: at } }); delete openSpans['o' + no]; }
              } else if (c.name === 'pedal') {
                const ty = c.attrs.type;
                if ((ty === 'stop' || ty === 'change') && openSpans.ped) { spansRaw.push({ ...openSpans.ped, b: { m, pos: at } }); delete openSpans.ped; }
                if (ty === 'start' || ty === 'change') openSpans.ped = { k: 'ped', s, v: 0, a: { m, t: at } };
              }
            }
          }
        } else if (el.name === 'harmony') {
          const at = pos + toTicks(num(el, 'offset', 0));
          const r0 = kid(el, 'root');
          if (!r0) continue;
          const accs = (a) => (a > 0 ? '#'.repeat(a) : 'b'.repeat(-a));
          const kd = kid(el, 'kind');
          const q = kd ? (kd.attrs.text != null ? kd.attrs.text : qualityOf(kd.text.trim())) : '';
          const bs = kid(el, 'bass');
          const text = txt(r0, 'root-step') + accs(Math.round(num(r0, 'root-alter', 0))) + q + (bs ? '/' + txt(bs, 'bass-step') + accs(Math.round(num(bs, 'bass-alter', 0))) : '');
          dirs[staffOf(el)].push({ t: at, k: 'chord', text });
        } else if (el.name === 'barline') {
          const rep = kid(el, 'repeat');
          if (pi === 0) {
            const st = txt(el, 'bar-style');
            if (rep?.attrs.direction === 'forward') gm[m].repeatStart = true;
            if (rep?.attrs.direction === 'backward') gm[m].repeatEnd = { times: parseInt(rep.attrs.times, 10) || 2 };
            else if (st === 'light-heavy') gm[m].barline = 'final';
            else if (st === 'light-light') gm[m].barline = 'double';
            const en = kid(el, 'ending');
            if (en && en.attrs.type === 'start') endingOpen = { m, nums: (en.attrs.number || '1').split(/[,\s]+/).map(Number).filter(Boolean) };
            if (en && (en.attrs.type === 'stop' || en.attrs.type === 'discontinue') && endingOpen) {
              gm[endingOpen.m].ending = { nums: endingOpen.nums.length ? endingOpen.nums : [1], len: m - endingOpen.m + 1 };
              endingOpen = null;
            }
          }
        } else if (el.name === 'note') {
          const s = Math.min(nStaves, parseInt(txt(el, 'staff'), 10) || 1) - 1;
          const vid = txt(el, 'voice') || '1';
          const vm = voiceMap[s];
          if (!(vid in vm)) vm[vid] = Math.min(3, Object.keys(vm).length);
          const v = vm[vid];
          const key = s + ':' + v;
          const isChord = !!kid(el, 'chord');
          // 装飾音符：次の本音符にくっつける
          const gr = kid(el, 'grace');
          if (gr) {
            const pitch = readPitch(el);
            if (!pitch) continue;
            const list = pendingGrace[key] || (pendingGrace[key] = []);
            if (isChord && list.length) list[list.length - 1].notes.push(pitch);
            else list.push({ type: TYPES.includes(txt(el, 'type')) ? txt(el, 'type') : 'eighth', slash: gr.attrs.slash === 'yes', notes: [pitch] });
            continue;
          }
          const type = txt(el, 'type');
          const dots = kids(el, 'dot').length;
          const tmod = kid(el, 'time-modification');
          const xdur = num(el, 'duration', 0);
          const rest = kid(el, 'rest');
          let ticks;
          if (TYPES.includes(type)) ticks = dottedTicks(type, dots) * (tmod ? num(tmod, 'normal-notes', 1) / num(tmod, 'actual-notes', 1) : 1);
          else ticks = toTicks(xdur);
          ticks = Math.round(ticks);
          const pitch = readPitch(el);
          const ntn = kids(el, 'notations');
          const tie = kids(el, 'tie').some(t => t.attrs.type === 'start') || ntn.some(n => kids(n, 'tied').some(t => t.attrs.type === 'start'));
          const target = isChord && lastEv ? lastEv.ev : null;
          let ev = target;
          const start = isChord && lastEv ? lastEv.start : pos;
          if (isChord && lastEv && pitch) {
            lastEv.ev.rest = false;
            if (!lastEv.ev.notes.some(q => q.step === pitch.step && q.octave === pitch.octave && q.alter === pitch.alter)) lastEv.ev.notes.push({ ...pitch, tie });
          } else if (!isChord || !lastEv) {
            ev = { id: newId(), rest: !pitch, type: TYPES.includes(type) ? type : 'quarter', dots, notes: pitch ? [{ ...pitch, tie }] : [] };
            if (rest && (rest.attrs.measure === 'yes' || !type)) ev._mr = true;
            if (!TYPES.includes(type) && !ev._mr) {
              // type がない音符：長さから音価を推測
              for (const ty of TYPES) for (let d2 = 0; d2 <= 2; d2++) if (dottedTicks(ty, d2) === ticks) { ev.type = ty; ev.dots = d2; }
            }
            if (tmod) {
              const actual = num(tmod, 'actual-notes', 3), normal = num(tmod, 'normal-notes', 2);
              const tups = ntn.flatMap(n => kids(n, 'tuplet'));
              if (tups.some(t => t.attrs.type === 'start') || !tupletId[key] || tupletId[key].ratio !== actual + '/' + normal || tupletId[key].left <= 0) {
                tupletId[key] = { id: newId(), ratio: actual + '/' + normal, left: Math.round(dottedTicks(ev.type, 0) * normal) };
              }
              ev.tuplet = { id: tupletId[key].id, actual, normal };
              tupletId[key].left -= ticks;
              if (tups.some(t => t.attrs.type === 'stop')) tupletId[key].left = 0;
            }
            if (pendingGrace[key]) { ev.grace = pendingGrace[key]; delete pendingGrace[key]; }
            (bucket[key] = bucket[key] || []).push({ start, ev, ticks });
            lastEv = { ev, start };
            pos += ticks;
            maxPos = Math.max(maxPos, pos);
          }
          if (!ev) continue;
          // アーティキュレーション・装飾記号・スラー・トリル線
          for (const n of ntn) for (const c of n.children) {
            if (c.name === 'fermata') addArt(ev, 'ferm');
            else if (c.name === 'articulations' || c.name === 'ornaments' || c.name === 'technical') {
              const wavy = kids(c, 'wavy-line');
              for (const a of c.children) {
                if (a.name === 'trill-mark' && wavy.some(w => w.attrs.type === 'start')) continue;
                if (XML_ART[a.name]) addArt(ev, XML_ART[a.name]);
              }
              for (const w of wavy) {
                const no = 't' + (w.attrs.number || '1');
                if (w.attrs.type === 'start') openSpans[no] = { k: 'trill', s, v, a: { m, t: start } };
                else if (w.attrs.type === 'stop' && openSpans[no]) { spansRaw.push({ ...openSpans[no], b: { m, t: start } }); delete openSpans[no]; }
              }
            } else if (c.name === 'slur') {
              const no = 's' + (c.attrs.number || '1');
              if (c.attrs.type === 'start' && !openSpans[no]) openSpans[no] = { k: 'slur', s, v, a: { m, t: start } };
              else if (c.attrs.type === 'stop' && openSpans[no]) { spansRaw.push({ ...openSpans[no], b: { m, t: start } }); delete openSpans[no]; }
            }
          }
          // 歌詞
          for (const ly of kids(el, 'lyric')) {
            const t = kids(ly, 'text').map(x => x.text).join('').trim();
            if (!t) continue;
            const verse = Math.max(0, Math.min(7, (parseInt(ly.attrs.number, 10) || 1) - 1));
            const syl = txt(ly, 'syllabic');
            const lyr = ev.lyr || (ev.lyr = []);
            while (lyr.length < verse) lyr.push(null);
            lyr[verse] = syl === 'begin' || syl === 'middle' ? { t, h: true } : { t };
          }
        }
      }
      raw[m] = { bucket, maxPos, dirs };
    });
    part._raw = raw;
    part._spans = spansRaw;
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
            if (ev._mr) {
              delete ev._mr;
              if (x.start === 0) { const keep = ev.art; ev = measureRest(len); if (keep) ev.art = keep; d = len; } else ev.type = 'whole';
            }
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
        const dl = raw?.dirs?.[s];
        if (dl && dl.length) sm.dirs = dl.filter(d => d.t <= len).map(d => ({ ...d, t: Math.min(d.t, len) }));
      }
    });
    // 線の記号：終わりの位置を「最後に含まれる音符の始まり」にそろえて、始まりの小節に置く
    for (const sp of part._spans) {
      const st = part.staves[sp.s];
      if (!st) continue;
      let b = sp.b;
      if (b.pos != null) b = lastOnsetBefore(st, sp.v, b.m, b.pos, A) || { m: sp.a.m, t: sp.a.t };
      if (b.m < sp.a.m || (b.m === sp.a.m && b.t < sp.a.t)) continue;
      const sm = st.measures[sp.a.m];
      const t = Math.min(sp.a.t, A[sp.a.m].len - 1);
      (sm.spans || (sm.spans = [])).push({ k: sp.k, v: sp.v, t: onsetCovering(sm, sp.v, t), dm: b.m - sp.a.m, t2: b.t });
    }
    delete part._raw; delete part._spans;
  });
  fillMeasures(score);
  return score;
}

function addArt(ev, k) { const a = ev.art || (ev.art = []); if (!a.includes(k)) a.push(k); }
// 位置 t を含む音符の始まり（線の始まりを音符にそろえる）
function onsetCovering(sm, v, t) {
  const pos = positions(sm.voices[v] || sm.voices[0]);
  const x = pos.find(y => y.start <= t && t < y.end) || pos[pos.length - 1];
  return x ? x.start : 0;
}
// 位置 pos より前に始まる最後の音符（pos が小節の頭なら前の小節の最後）
function lastOnsetBefore(st, v, m, pos, A) {
  for (let mm = m; mm >= 0 && mm >= m - 1; mm--) {
    const sm = st.measures[mm];
    const lim = mm === m ? pos : A[mm].len + 1;
    const xs = positions(sm.voices[v] || sm.voices[0]).filter(x => x.start < lim && !x.ev.rest);
    if (xs.length) return { m: mm, t: xs[xs.length - 1].start };
  }
  return null;
}

export { CLEFS, ARTICS };
