// 記号の一覧（Phase 4）：リボンの「記号」タブのギャラリー・記号パレット（横のパネル）・検索で共通に使う
//
// 1つの記号 = { id, ja（名前）, kw（検索のことば）, icon（見た目）, run(app)（付ける） }
//   icon は { g: SMuFL グリフ名 } / { t: 文字, cls } / { svg: '<path…>' }（24×24 の線画）
// 付ける対象は、選んでいる音符・小節（入力モードなら直前に入れた音符・カーソルの小節）
import { SMUFL } from '../smufl.js';
import { ARTICS, DYNAMICS, DYN_ORDER, SPANS, TEXT_PRESETS, JUMPS, NOTEHEADS, TREMS, FINGERS, BARLINES } from '../core/marks.js';
import { CLEFS, keyNameJa } from '../core/music.js';

const G = SMUFL.glyphs;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// グリフを、外枠ぴったりの viewBox の SVG にする（どの記号もタイルの真ん中に、同じくらいの大きさで出る）
export function glyphSvg(name, cls = '') {
  const g = G[name];
  if (!g) return '';
  const ne = g.ne || [1, 1], sw = g.sw || [0, 0];
  const pad = 0.25;
  const w = Math.max(0.5, ne[0] - sw[0]), h = Math.max(0.5, ne[1] - sw[1]);
  return `<svg class="gsvg ${cls}" viewBox="${sw[0] - pad} ${-ne[1] - pad} ${w + pad * 2} ${h + pad * 2}" aria-hidden="true"><text x="0" y="0">${g.c}</text></svg>`;
}
// 線画アイコン（24×24）
const line = (d, extra = '') => `<svg class="lsvg" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" ${extra}/></svg>`;
export function iconHtml(icon) {
  if (!icon) return '';
  if (icon.g) return glyphSvg(icon.g, icon.cls || '');
  if (icon.svg) return icon.svg;
  if (icon.t != null) return `<span class="ticon ${icon.cls || ''}">${esc(icon.t)}</span>`;
  return '';
}

// 英語の名前でも探せるように（MuseScore / Finale の英語版に慣れている人向け）
const EN = { stacc: 'staccato', staccss: 'staccatissimo', wedge: 'wedge staccatissimo', ten: 'tenuto', portato: 'portato louré', acc: 'accent', accStacc: 'accent staccato', tenAcc: 'accent tenuto', marc: 'marcato', marcStacc: 'marcato staccato', stress: 'stress', unstress: 'unstress', soft: 'soft accent', ferm: 'fermata', fermS: 'short fermata', fermL: 'long fermata', fermVS: 'very short fermata', fermVL: 'very long fermata', breath: 'breath mark', breathT: 'breath tick', caesura: 'caesura', caesuraS: 'short caesura', tr: 'trill', mord: 'mordent', prall: 'prall upper mordent', turn: 'turn', invTurn: 'inverted turn', turnSlash: 'turn slash', haydn: 'haydn turn', trembl: 'tremblement', down: 'down bow', up: 'up bow', harm: 'harmonic', open: 'open string', stopped: 'stopped closed', snap: 'snap bartok pizzicato', lhpizz: 'left hand pizzicato', thumb: 'thumb position', scoop: 'scoop', plop: 'plop', doit: 'doit', fall: 'fall falloff' };
const art = (k) => ({ id: 'art:' + k, ja: ARTICS[k].ja, kw: k + ' ' + (EN[k] || ''), icon: { g: ARTICS[k].ab ? ARTICS[k].g + 'Above' : ARTICS[k].g }, run: (a) => a.toggleArtic(k), key: ARTICS[k].key });
const span = (k, icon) => ({ id: 'span:' + k, ja: SPANS[k].ja, kw: k, icon, run: (a) => a.addSpan(k), key: SPANS[k].key });
const txt = (t, cls = '') => ({ t, cls });

// 分類（パレットの見出しの順番）
export const CATEGORIES = [
  { id: 'acc', ja: '臨時記号', icon: { g: 'accidentalSharp' } },
  { id: 'artic', ja: 'アーティキュレーション', short: 'アーティキュ​レーション', icon: { g: 'articAccentAbove' } },
  { id: 'dyn', ja: '強弱記号', icon: { g: 'dynamicMF' } },
  { id: 'lines', ja: '線（スラー・松葉・8va など）', short: '線', icon: { svg: line('M3 16C7 6 17 6 21 16') } },
  { id: 'orn', ja: '装飾記号・装飾音符', short: '装飾', icon: { g: 'ornamentTrill' } },
  { id: 'breath', ja: 'フェルマータ・ブレス・間', short: 'ブレス', icon: { g: 'fermataAbove' } },
  { id: 'text', ja: 'テキスト（文字・歌詞・コード）', short: 'テキスト', icon: { t: 'Aa', cls: 'serif' } },
  { id: 'tempo', ja: 'テンポ', icon: { g: 'metNoteQuarterUp' } },
  { id: 'repeat', ja: '反復記号・移動（D.S. / Coda）', short: '反復', icon: { g: 'segno' } },
  { id: 'arp', ja: 'アルペジオ・グリッサンド', short: 'アルペジオ', icon: { svg: line('M12 3c3 1.5-3 3 0 4.5s-3 3 0 4.5-3 3 0 4.5-3 3 0 4.5') } },
  { id: 'trem', ja: 'トレモロ', icon: { g: 'tremolo3' } },
  { id: 'head', ja: '符頭・音符の形', short: '符頭', icon: { g: 'noteheadXBlack' } },
  { id: 'fing', ja: '運指・弦番号', short: '運指', icon: { g: 'fingering3' } },
  { id: 'tech', ja: '弦・管の奏法', short: '奏法', icon: { g: 'stringsDownBow' } },
  { id: 'clef', ja: '音部記号', icon: { g: 'gClef' } },
  { id: 'key', ja: '調号', icon: { g: 'accidentalSharp' } },
  { id: 'time', ja: '拍子', icon: { g: 'timeSigCommon' } },
  { id: 'bar', ja: '小節線', icon: { svg: line('M8 3v18M14 3v18M17 3v18', 'stroke-width="2.2"') } },
  { id: 'beam', ja: '符尾と連桁', short: '連桁', icon: { svg: line('M6 18V6M18 15V4M6 6l12-2', 'stroke-width="2"') } },
  { id: 'layout', ja: '改段・改ページ・小節の幅', short: '区切り', icon: { svg: line('M4 7h16M4 12h10M4 17h16M17 9l3 3-3 3') } },
];

// ───────── 記号の一覧 ─────────
export const SYMBOLS = [];
const add = (cat, items) => items.forEach(it => SYMBOLS.push({ cat, ...it }));

add('acc', [
  ...[[-2, 'accidentalDoubleFlat', 'ダブルフラット'], [-1, 'accidentalFlat', 'フラット'], [0, 'accidentalNatural', 'ナチュラル'], [1, 'accidentalSharp', 'シャープ'], [2, 'accidentalDoubleSharp', 'ダブルシャープ']].map(([v, gl, ja]) => ({ id: 'acc:' + v, ja, kw: 'accidental ' + gl, icon: { g: gl }, run: (a) => a.setAccidental(v) })),
  { id: 'acc:show', ja: '臨時記号を必ず表示（注意の臨時記号）', kw: 'courtesy cautionary accidental', icon: { g: 'accidentalParensLeft', svg: null }, run: (a) => a.setNoteProp('acc', true, '注意の臨時記号') },
]);
add('artic', Object.keys(ARTICS).filter(k => ARTICS[k].cat === 'artic').map(art));
add('dyn', [
  ...DYN_ORDER.map(v => ({ id: 'dyn:' + v, ja: '強弱記号 ' + v, kw: v + ' dynamics', icon: { g: DYNAMICS[v].g }, run: (a) => a.addDynamic(v) })),
  span('cresc', { svg: line('M21 7 3 12l18 5') }), span('dim', { svg: line('M3 7l18 5-18 5') }),
  span('crescLine', txt('cresc.', 'it serif')), span('dimLine', txt('dim.', 'it serif')),
]);
add('lines', [
  span('slur', { svg: line('M3 16C7 6 17 6 21 16') }),
  span('8va', { g: 'ottavaAlta' }), span('8vb', { g: 'ottavaBassaVb' }), span('15ma', { g: 'quindicesimaAlta' }), span('15mb', { g: 'quindicesimaBassaMb' }),
  span('ped', { g: 'keyboardPedalPed' }), span('pedL', { svg: line('M3 8v8h18V8') }),
  span('trill', { g: 'ornamentTrill' }), span('vib', { svg: line('M2 12c2-4 3 4 5 0s3 4 5 0 3 4 5 0 3 4 5 0') }),
  span('ritLine', txt('rit.', 'it serif')), span('accelLine', txt('accel.', 'it serif')),
  span('letRing', txt('let ring', 'small')), span('palmMute', txt('P.M.', 'small')),
  span('bracket', { svg: line('M3 16V8h18v8') }), span('textLine', txt('Abc- -', 'small')),
]);
add('orn', [
  ...Object.keys(ARTICS).filter(k => ARTICS[k].cat === 'orn').map(art),
  { id: 'grace', ja: '装飾音符（前打音・短前打音）', kw: 'grace acciaccatura appoggiatura', icon: { g: 'graceNoteAcciaccaturaStemUp' }, run: (a) => a.toggleGrace(), key: ';' },
]);
add('breath', Object.keys(ARTICS).filter(k => ARTICS[k].cat === 'breath').map(art));
add('tech', [...Object.keys(ARTICS).filter(k => ARTICS[k].cat === 'tech' || ARTICS[k].cat === 'jazz').map(art)]);
add('text', [
  { id: 'text:staff', ja: '譜表テキスト（その譜表だけ）…', kw: 'staff text 文字', icon: txt('Abc', 'serif'), run: (a) => a.dialogs.textExpr(null, (d) => a.addTextDir(d.text, d.pos, d.it)) },
  { id: 'text:system', ja: 'システムテキスト（全パート）…', kw: 'system text', icon: txt('Abc', 'serif bold'), run: (a) => a.dialogs.ask('システムテキスト', '全パートに出す文字（例：Swing / Coda / 2nd time only）', '', (v) => v && a.addSystemText(v)) },
  { id: 'text:reh', ja: '練習番号（A, B, C …）', kw: 'rehearsal mark', icon: txt('A', 'boxed'), run: (a) => a.toggleRehearsal() },
  { id: 'text:lyrics', ja: '歌詞を入力', kw: 'lyrics 歌詞', icon: txt('あ'), run: (a) => a.startLyrics(), key: 'L' },
  { id: 'text:chord', ja: 'コードネームを入力', kw: 'chord symbol', icon: txt('C7', 'serif'), run: (a) => a.startChords(), key: 'K' },
  { id: 'text:fret', ja: 'ギターのフレット図', kw: 'fretboard diagram ダイアグラム', icon: { svg: line('M6 4v16M10 4v16M14 4v16M18 4v16M6 8h12M6 12h12M6 16h12') }, run: (a) => a.addFret() },
  ...TEXT_PRESETS.map(p => ({ id: 'text:' + p.text, ja: p.text, kw: 'expression ' + p.text, icon: txt(p.text, (p.it ? 'it ' : '') + 'serif small'), run: (a) => a.addTextDir(p.text, p.pos, p.it) })),
]);
const TEMPOS = [['Grave', 40], ['Largo', 50], ['Lento', 56], ['Adagio', 66], ['Andante', 80], ['Andantino', 92], ['Moderato', 100], ['Allegretto', 112], ['Allegro', 132], ['Vivace', 152], ['Presto', 168]];
add('tempo', [
  { id: 'tempo:q', ja: '♩ = テンポ…（数字を指定）', kw: 'metronome bpm', icon: { g: 'metNoteQuarterUp' }, run: (a) => a.dialogs.tempo() },
  ...TEMPOS.map(([n, b]) => ({ id: 'tempo:' + n, ja: `${n}（♩=${b}）`, kw: 'tempo ' + n, icon: txt(n, 'serif bold small'), run: (a) => a.setTempoMark(n, b) })),
  { id: 'tempo:qd', ja: '付点4分 = 60（6/8 など）', kw: 'dotted quarter', icon: txt('♩.=60', 'small'), run: (a) => a.setTempoMark('', 60, 'quarterDot') },
  { id: 'tempo:h', ja: '2分 = 60（2/2 など）', kw: 'half', icon: txt('𝅗𝅥=60', 'small'), run: (a) => a.setTempoMark('', 60, 'half') },
  ...['rit.', 'rall.', 'accel.', 'a tempo', 'Tempo I', 'meno mosso', 'più mosso'].map(t => ({ id: 'tempo:' + t, ja: t + '（再生に反映）', kw: 'tempo ' + t, icon: txt(t, 'it serif small'), run: (a) => a.addTextDir(t, 'above', !/^(a tempo|Tempo I)$/.test(t)) })),
]);
const meas = (id, ja, icon, fn, kw = '') => ({ id: 'rep:' + id, ja, kw, icon, run: fn });
add('repeat', [
  meas('both', '反復（選んだ小節を |: 〜 :|）', { svg: line('M5 4v16M8 4v16M19 4v16M16 4v16M11 10h.01M11 14h.01M13 10h.01M13 14h.01', 'stroke-width="2"') }, (a) => a.setBarline('repeatBoth'), 'repeat'),
  meas('start', '反復の始まり |:', { svg: line('M6 4v16M9 4v16M13 10h.01M13 14h.01', 'stroke-width="2.4"') }, (a) => a.setBarline('repeatStart'), 'repeat start'),
  meas('end', '反復の終わり :|', { svg: line('M18 4v16M15 4v16M11 10h.01M11 14h.01', 'stroke-width="2.4"') }, (a) => a.setBarline('repeatEnd'), 'repeat end'),
  meas('e1', '1番カッコ', txt('1.'), (a) => setEnding(a, 1), 'volta ending'),
  meas('e2', '2番カッコ', txt('2.'), (a) => setEnding(a, 2), 'volta ending'),
  meas('e3', '3番カッコ', txt('3.'), (a) => setEnding(a, 3), 'volta ending'),
  meas('segno', 'セーニョ 𝄋', { g: 'segno' }, (a) => toggleMeas(a, 'segno', 'first')),
  meas('coda', 'コーダ 𝄌', { g: 'coda' }, (a) => toggleMeas(a, 'coda', 'first')),
  meas('toCoda', 'To Coda', txt('To 𝄌', 'it bold small'), (a) => toggleMeas(a, 'toCoda', 'last')),
  meas('fine', 'Fine', txt('Fine', 'it bold small'), (a) => toggleMeas(a, 'fine', 'last')),
  ...Object.entries(JUMPS).map(([k, j]) => meas('j:' + k, j.ja, txt(j.text, 'it bold small'), (a) => a.edit(j.text, () => { const ms = a.score.measures[a.barTarget()]; if (ms.jump === k) delete ms.jump; else ms.jump = k; }), 'jump ' + j.text)),
  meas('mrep', '小節の繰り返し（直前の小節をもう一度）', { g: 'repeat1Bar' }, (a) => a.toggleMeasureRepeat(), 'measure repeat %'),
  meas('dialog', '反復記号の詳しい設定…', txt('…'), (a) => a.dialogs.repeats()),
]);
// カッコ（1番・2番）：選んだ小節の範囲の長さで
function setEnding(a, n) {
  const s = a.state.sel;
  const m = s?.kind === 'range' ? s.m1 : a.targetMeasure(), len = s?.kind === 'range' ? s.m2 - s.m1 + 1 : 1;
  a.edit('カッコ', () => { const ms = a.score.measures[m]; if (ms.ending && ms.ending.nums[0] === n && ms.ending.len === len) delete ms.ending; else ms.ending = { nums: [n], len }; });
}
function toggleMeas(a, key, which) {
  const s = a.state.sel;
  const m = which === 'first' ? (s?.kind === 'range' ? s.m1 : a.targetMeasure()) : a.barTarget();
  a.edit(key, () => { const ms = a.score.measures[m]; if (ms[key]) delete ms[key]; else ms[key] = true; });
}
add('arp', [
  { id: 'arp:normal', ja: 'アルペジオ', kw: 'arpeggio', icon: { svg: line('M12 3c3 1.5-3 3 0 4.5s-3 3 0 4.5-3 3 0 4.5-3 3 0 4.5') }, run: (a) => a.setEvProp('arp', 'normal', 'アルペジオ') },
  { id: 'arp:up', ja: 'アルペジオ（下から上へ）', kw: 'arpeggio up', icon: { svg: line('M12 21c3-1.5-3-3 0-4.5s-3-3 0-4.5-3-3 0-4.5M9 7l3-4 3 4') }, run: (a) => a.setEvProp('arp', 'up', 'アルペジオ（上向き）') },
  { id: 'arp:down', ja: 'アルペジオ（上から下へ）', kw: 'arpeggio down', icon: { svg: line('M12 3c3 1.5-3 3 0 4.5s-3 3 0 4.5-3 3 0 4.5M9 17l3 4 3-4') }, run: (a) => a.setEvProp('arp', 'down', 'アルペジオ（下向き）') },
  { id: 'arp:bracket', ja: 'アルペジオしない（カッコ）', kw: 'non arpeggio bracket', icon: { svg: line('M15 4H9v16h6') }, run: (a) => a.setEvProp('arp', 'bracket', 'アルペジオしない') },
  span('gliss', { svg: line('M4 18 20 6') }),
]);
add('trem', Object.entries(TREMS).map(([k, t]) => ({ id: 'trem:' + k, ja: t.ja, kw: 'tremolo', icon: { g: t.g }, run: (a) => a.setEvProp('trem', k === 'z' ? 'z' : +k, t.ja) })));
add('head', [
  { id: 'head:normal', ja: '普通の符頭に戻す', kw: 'normal notehead', icon: { g: 'noteheadBlack' }, run: (a) => a.setNoteProp('head', null, '符頭') },
  ...Object.entries(NOTEHEADS).map(([k, h]) => ({ id: 'head:' + k, ja: h.ja, kw: 'notehead ' + k, icon: { g: h.black }, run: (a) => a.setNoteProp('head', k, h.ja) })),
  { id: 'head:paren', ja: '括弧つきの符頭（ゴーストノート）', kw: 'parentheses ghost', icon: txt('( ● )', 'small'), run: (a) => a.setNoteProp('paren', true, '括弧つきの符頭') },
  { id: 'head:small', ja: '小さい音符（キュー）', kw: 'small cue', icon: { g: 'noteheadBlack', cls: 'tiny' }, run: (a) => a.setEvProp('small', true, '小さい音符') },
  { id: 'head:slash', ja: 'リズム譜のスラッシュ（音は鳴らない）', kw: 'slash rhythm', icon: { g: 'noteheadSlashHorizontalEnds' }, run: (a) => a.setEvProp('slash', true, 'スラッシュ') },
  { id: 'head:fill', ja: 'スラッシュで埋める（選んだ小節）', kw: 'fill with slashes', icon: txt('////', 'bold'), run: (a) => a.fillSlashes() },
]);
add('fing', [
  ...['1', '2', '3', '4', '5', '0'].map(n => ({ id: 'fing:' + n, ja: `運指 ${n}`, kw: 'fingering ' + n, icon: { g: FINGERS[n] }, run: (a) => a.setNoteProp('fing', n, `運指 ${n}`) })),
  ...['p', 'i', 'm', 'a'].map(n => ({ id: 'fing:' + n, ja: `右手 ${n}（ギター）`, kw: 'fingering guitar ' + n, icon: { g: FINGERS[n] }, run: (a) => a.setNoteProp('fing', n, `右手 ${n}`) })),
  ...[1, 2, 3, 4, 5, 6].map(n => ({ id: 'str:' + n, ja: `弦番号 ${'①②③④⑤⑥'[n - 1]}`, kw: 'string number ' + n, icon: txt('①②③④⑤⑥'[n - 1]), run: (a) => a.setStringNum(n) })),
]);
add('clef', Object.entries(CLEFS).filter(([k]) => k !== 'tab').map(([k, c]) => ({ id: 'clef:' + k, ja: c.ja, kw: 'clef ' + k, icon: { g: c.glyph }, run: (a) => a.insertClef(k) })));
add('key', Array.from({ length: 15 }, (_, i) => i - 7).map(f => ({
  id: 'key:' + f, ja: keyNameJa(f), kw: 'key signature ' + f, run: (a) => a.insertKey(f),
  icon: { t: f > 0 ? '♯' + f : f < 0 ? '♭' + -f : '0', cls: 'bold' },
})));
add('time', [
  ...[[2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [2, 2], [3, 2], [3, 8], [6, 8], [9, 8], [12, 8], [5, 8], [7, 8]].map(([b, t]) => ({ id: `time:${b}/${t}`, ja: `${b}/${t} 拍子`, kw: 'time signature', icon: { svg: `<span class="tsig"><b>${b}</b><b>${t}</b></span>` }, run: (a) => a.insertTime({ beats: b, beatType: t }) })),
  { id: 'time:C', ja: 'C（4/4）', kw: 'common time', icon: { g: 'timeSigCommon' }, run: (a) => a.insertTime({ beats: 4, beatType: 4, symbol: 'common' }) },
  { id: 'time:cut', ja: '¢（2/2・アラブレーヴェ）', kw: 'cut time alla breve', icon: { g: 'timeSigCutCommon' }, run: (a) => a.insertTime({ beats: 2, beatType: 2, symbol: 'cut' }) },
  { id: 'time:other', ja: 'そのほかの拍子…', kw: 'time other', icon: txt('?/?'), run: (a) => a.dialogs.timeSig() },
]);
const BAR_ICON = {
  double: line('M10 3v18M14 3v18', 'stroke-width="1.6"'), final: line('M9 3v18', 'stroke-width="1.6"') .replace('</svg>', '<path d="M15 3v18" stroke-width="4"/></svg>'),
  dashed: line('M12 3v18', 'stroke-width="1.8" stroke-dasharray="3 2.4"'), dotted: line('M12 3v18', 'stroke-width="2.2" stroke-dasharray="0.1 3.4" stroke-linecap="round"'),
  heavy: line('M12 3v18', 'stroke-width="4"'), heavyHeavy: line('M9 3v18M15 3v18', 'stroke-width="3.4"'),
  tick: line('M12 2v6M4 8h16M4 12h16M4 16h16', 'stroke-width="1.6"'), short: line('M12 8v8M4 6h16M4 18h16', 'stroke-width="1.6"'), none: line('M4 6h16M4 12h16M4 18h16', 'stroke-width="1.2" opacity=".5"'),
};
add('bar', [
  { id: 'bar:normal', ja: '普通の小節線', kw: 'barline', icon: { svg: line('M12 3v18', 'stroke-width="1.6"') }, run: (a) => a.setBarline('normal') },
  ...Object.entries(BARLINES).map(([k, b]) => ({ id: 'bar:' + k, ja: b.ja, kw: 'barline ' + k, icon: { svg: BAR_ICON[k] }, run: (a) => a.setBarline(k) })),
  { id: 'bar:rs', ja: '反復の始まり |:', kw: 'repeat', icon: { svg: line('M6 4v16M9 4v16M13 10h.01M13 14h.01', 'stroke-width="2.4"') }, run: (a) => a.setBarline('repeatStart') },
  { id: 'bar:re', ja: '反復の終わり :|', kw: 'repeat', icon: { svg: line('M18 4v16M15 4v16M11 10h.01M11 14h.01', 'stroke-width="2.4"') }, run: (a) => a.setBarline('repeatEnd') },
]);
add('beam', [
  { id: 'stem:up', ja: '符尾を上向きに', kw: 'stem up', icon: { svg: line('M14 3v14M14 17a3 2 0 1 1-6 0 3 2 0 1 1 6 0') }, run: (a) => a.setEvProp('stem', 'up', '符尾を上向き') },
  { id: 'stem:down', ja: '符尾を下向きに', kw: 'stem down', icon: { svg: line('M10 21V7M16 7a3 2 0 1 1-6 0 3 2 0 1 1 6 0') }, run: (a) => a.setEvProp('stem', 'down', '符尾を下向き') },
  { id: 'stem:flip', ja: '符尾の向きを反転', kw: 'flip stem', icon: { svg: line('M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4') }, run: (a) => a.flipStem(), key: 'Shift+X' },
  { id: 'stem:auto', ja: '符尾の向きを自動に戻す', kw: 'stem auto', icon: txt('auto', 'small'), run: (a) => a.flipStem(true) },
  { id: 'beam:start', ja: 'ここから連桁を分ける', kw: 'beam start break', icon: { svg: line('M5 18V6M11 18V6M15 18V6M21 18V6M5 6h6M15 6h6', 'stroke-width="1.8"') }, run: (a) => a.setEvProp('beam', 'start', '連桁を分ける') },
  { id: 'beam:join', ja: '前の音符と連桁でつなぐ', kw: 'beam join', icon: { svg: line('M5 18V6M11 18V6M15 18V6M21 18V6M5 6h16', 'stroke-width="1.8"') }, run: (a) => a.setEvProp('beam', 'join', '連桁をつなぐ') },
  { id: 'beam:none', ja: '連桁にしない（旗）', kw: 'no beam flag', icon: { g: 'flag8thUp' }, run: (a) => a.setEvProp('beam', 'none', '連桁にしない') },
]);
add('layout', [
  { id: 'lay:sys', ja: 'この小節の後で改段', kw: 'system break', icon: { svg: line('M4 7h16M4 12h10M17 9l3 3-3 3M4 17h16') }, run: (a) => a.edit('改段', () => { const ms = a.score.measures[a.barTarget()]; ms.sysBreak = !ms.sysBreak; if (!ms.sysBreak) delete ms.sysBreak; delete ms.keep; }) },
  { id: 'lay:page', ja: 'この小節の後で改ページ', kw: 'page break', icon: { svg: line('M6 3h9l4 4v14H6zM9 13h7M9 17h5') }, run: (a) => a.edit('改ページ', () => { const x = a.score.measures[a.barTarget()]; x.pageBreak = !x.pageBreak; if (x.pageBreak) { x.sysBreak = true; delete x.keep; } else delete x.pageBreak; }) },
  { id: 'lay:prev', ja: 'この段の最初の小節を前の段へ', kw: 'move measure previous system', icon: { svg: line('M15 6l-6 6 6 6') }, run: (a) => a.tools.moveSystem(a.targetMeasure(), -1) },
  { id: 'lay:next', ja: 'この段の最後の小節を次の段へ', kw: 'move measure next system', icon: { svg: line('M9 6l6 6-6 6') }, run: (a) => a.tools.moveSystem(a.targetMeasure(), 1) },
  { id: 'lay:wide', ja: '小節の幅を広げる', kw: 'stretch wider', icon: { svg: line('M4 12h16M7 8l-4 4 4 4M17 8l4 4-4 4') }, run: (a) => a.stretchMeasures(1.12), key: '}' },
  { id: 'lay:narrow', ja: '小節の幅を狭める', kw: 'stretch narrow', icon: { svg: line('M3 12h6M15 12h6M6 8l4 4-4 4M18 8l-4 4 4 4') }, run: (a) => a.stretchMeasures(1 / 1.12), key: '{' },
  { id: 'lay:reset', ja: '小節の幅を元に戻す', kw: 'stretch reset', icon: txt('1:1', 'small'), run: (a) => a.stretchMeasures(0) },
]);

// 検索：名前・検索のことば・分類名で
export function searchSymbols(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const catJa = Object.fromEntries(CATEGORIES.map(c => [c.id, c.ja]));
  return SYMBOLS.filter(x => (x.ja + ' ' + (x.kw || '') + ' ' + catJa[x.cat]).toLowerCase().includes(s));
}

// タイルの一覧（ギャラリー・パレット）
export function tilesHtml(items) {
  return items.map(it => `<button class="tile" data-sym="${esc(it.id)}" title="${esc(it.ja)}${it.key ? `（${esc(it.key)}）` : ''}"><span class="ti">${iconHtml(it.icon)}</span><span class="tl">${esc(it.ja.replace(/（.*?）$/, '').replace(/…$/, ''))}</span></button>`).join('');
}
export const symbolById = (id) => SYMBOLS.find(x => x.id === id);
