// Phase 2 の記号：アーティキュレーション・強弱/発想記号・スラーなどの線（Finale の Smart Shape）・
// 歌詞・コードネーム・装飾音符・反復記号、それと移調楽器の記譜表示・パート譜で使う計算
//
// ■ どこに持つか（全部 .kanade にそのまま保存される）
//   ev.art   … 音符に付く記号の名前の配列        例: ['stacc', 'acc']
//   ev.lyr   … 歌詞。番号（1番・2番…）ごと      例: [{ t: 'さ', h: true }]  h = 次の音節へハイフンでつなぐ
//   ev.grace … その音符の前に付く装飾音符        例: [{ type: 'eighth', slash: true, notes: [pitch] }]
//   sm.dirs  … 譜表の小節の中の位置 t に付く文字・記号
//              { t, k: 'dyn', v: 'mf' } / { t, k: 'text', text, pos: 'above'|'below', it: true } / { t, k: 'chord', text: 'Cm7' }
//   sm.spans … その小節の t から始まる線     { k: 'slur'|'cresc'|'dim'|'8va'|'8vb'|'15ma'|'ped'|'trill', v, t, dm, t2 }
//              終わりは「dm 小節あとの t2 から始まる音符」。相対で持つので、小節の挿入やコピーをしてもずれない
//   score.measures[m] … repeatStart / repeatEnd（回数）/ ending { nums, len } / segno / coda / fine / toCoda / jump
import { measureAttrs, INST, evTicks } from './score.js';
import { positions, findEvent, nextEvent, getVoice, staffMeasure, expandMeasureRest } from './edit.js';
import { transposeInterval, fifthsForSemis, spellMidi, midiOf, diatonic, fromDiatonic, keyAlter } from './music.js';

// ───────── 一覧（パレット・メニュー・浄書・再生・MusicXML で共通に使う） ─────────
// g = SMuFL のグリフ名。ab = 「Above / Below」の2つの形がある（付けずに書いて、上下で付け足す）
// side: 'note' = 符頭の側（譜表の中にも置く）、'above' = 譜表の外（声部2なら下）、'after' = 音符の右上（ブレス）、
//       'before' = 符頭の左（スクープ）、'right' = 符頭の右（フォール）
// cat = パレットの分類、len = 再生の長さの倍率、vel = 強さの足し算、pause = フェルマータの止まる長さ（音符の長さの何倍）
export const ARTICS = {
  stacc: { ja: 'スタッカート', g: 'articStaccato', ab: true, side: 'note', key: 'Shift+S', cat: 'artic', len: 0.5 },
  staccss: { ja: 'スタッカーティッシモ', g: 'articStaccatissimo', ab: true, side: 'note', cat: 'artic', len: 0.3 },
  wedge: { ja: 'スタッカーティッシモ（くさび）', g: 'articStaccatissimoWedge', ab: true, side: 'note', cat: 'artic', len: 0.3, vel: 0.05 },
  ten: { ja: 'テヌート', g: 'articTenuto', ab: true, side: 'note', key: 'Shift+N', cat: 'artic', len: 1 },
  portato: { ja: 'ポルタート（テヌート＋スタッカート）', g: 'articTenutoStaccato', ab: true, side: 'note', cat: 'artic', len: 0.75 },
  acc: { ja: 'アクセント', g: 'articAccent', ab: true, side: 'note', key: 'Shift+V', cat: 'artic', vel: 0.14 },
  accStacc: { ja: 'アクセント＋スタッカート', g: 'articAccentStaccato', ab: true, side: 'note', cat: 'artic', len: 0.5, vel: 0.14 },
  tenAcc: { ja: 'アクセント＋テヌート', g: 'articTenutoAccent', ab: true, side: 'note', cat: 'artic', len: 1, vel: 0.14 },
  marc: { ja: 'マルカート', g: 'articMarcato', ab: true, side: 'above', key: 'Shift+O', cat: 'artic', len: 0.75, vel: 0.2 },
  marcStacc: { ja: 'マルカート＋スタッカート', g: 'articMarcatoStaccato', ab: true, side: 'above', cat: 'artic', len: 0.5, vel: 0.2 },
  stress: { ja: 'ストレス（強調）', g: 'articStress', ab: true, side: 'note', cat: 'artic', vel: 0.08 },
  unstress: { ja: 'アンストレス（弱く）', g: 'articUnstress', ab: true, side: 'note', cat: 'artic', vel: -0.1 },
  soft: { ja: 'ソフトアクセント', g: 'articSoftAccent', ab: true, side: 'note', cat: 'artic', vel: 0.06 },
  ferm: { ja: 'フェルマータ', g: 'fermata', ab: true, side: 'above', key: 'Shift+U', cat: 'breath', pause: 1 },
  fermS: { ja: '短いフェルマータ', g: 'fermataShort', ab: true, side: 'above', cat: 'breath', pause: 0.5 },
  fermL: { ja: '長いフェルマータ', g: 'fermataLong', ab: true, side: 'above', cat: 'breath', pause: 1.6 },
  fermVS: { ja: 'とても短いフェルマータ', g: 'fermataVeryShort', ab: true, side: 'above', cat: 'breath', pause: 0.3 },
  fermVL: { ja: 'とても長いフェルマータ', g: 'fermataVeryLong', ab: true, side: 'above', cat: 'breath', pause: 2.2 },
  breath: { ja: 'ブレス', g: 'breathMarkComma', side: 'after', single: true, cat: 'breath', len: 0.85, gap: 0.08 },
  breathT: { ja: 'ブレス（チェック）', g: 'breathMarkTick', side: 'after', single: true, cat: 'breath', len: 0.85, gap: 0.08 },
  caesura: { ja: 'カエスーラ（間）', g: 'caesura', side: 'after', single: true, cat: 'breath', len: 0.9, gap: 0.4 },
  caesuraS: { ja: '短いカエスーラ', g: 'caesuraShort', side: 'after', single: true, cat: 'breath', len: 0.9, gap: 0.2 },
  tr: { ja: 'トリル', g: 'ornamentTrill', side: 'above', single: true, cat: 'orn' },
  mord: { ja: 'モルデント（下）', g: 'ornamentMordent', side: 'above', single: true, cat: 'orn' },
  prall: { ja: 'プラルトリラー（上）', g: 'ornamentShortTrill', side: 'above', single: true, cat: 'orn' },
  turn: { ja: 'ターン', g: 'ornamentTurn', side: 'above', single: true, cat: 'orn' },
  invTurn: { ja: '逆ターン', g: 'ornamentTurnInverted', side: 'above', single: true, cat: 'orn' },
  turnSlash: { ja: 'ターン（斜線つき）', g: 'ornamentTurnSlash', side: 'above', single: true, cat: 'orn' },
  haydn: { ja: 'ハイドン・ターン', g: 'ornamentHaydn', side: 'above', single: true, cat: 'orn' },
  trembl: { ja: 'トランブルマン', g: 'ornamentTremblement', side: 'above', single: true, cat: 'orn' },
  down: { ja: 'ダウンボウ', g: 'stringsDownBow', side: 'above', single: true, cat: 'tech' },
  up: { ja: 'アップボウ', g: 'stringsUpBow', side: 'above', single: true, cat: 'tech' },
  harm: { ja: 'ハーモニクス（○）', g: 'stringsHarmonic', side: 'above', single: true, cat: 'tech' },
  open: { ja: '開放（o）', g: 'brassMuteOpen', side: 'above', single: true, cat: 'tech' },
  stopped: { ja: 'ストップ（＋）', g: 'brassMuteClosed', side: 'above', single: true, cat: 'tech' },
  snap: { ja: 'バルトーク・ピチカート', g: 'pluckedSnapPizzicato', ab: true, side: 'above', single: true, cat: 'tech' },
  lhpizz: { ja: '左手ピチカート', g: 'pluckedLeftHandPizzicato', side: 'above', single: true, cat: 'tech' },
  thumb: { ja: '親指（チェロ）', g: 'stringsThumbPosition', side: 'above', single: true, cat: 'tech' },
  scoop: { ja: 'スクープ（しゃくり）', g: 'brassScoop', side: 'before', single: true, cat: 'jazz' },
  plop: { ja: 'プロップ', g: 'brassPlop', side: 'before', single: true, cat: 'jazz' },
  doit: { ja: 'ドゥイット', g: 'brassDoitMedium', side: 'right', single: true, cat: 'jazz' },
  fall: { ja: 'フォール', g: 'brassFallLipMedium', side: 'right', single: true, cat: 'jazz' },
};
// アーティキュレーションの見た目のグリフ（上に置くか下に置くかで形が変わるもの）
export const articGlyph = (key, below) => { const a = ARTICS[key]; return a.ab ? a.g + (below ? 'Below' : 'Above') : a.g; };
// 同時に付けない組み合わせ（どれか1つ）
export const ARTIC_EXCL = [
  ['stacc', 'staccss', 'wedge', 'portato', 'accStacc', 'marcStacc'],
  ['acc', 'marc', 'accStacc', 'tenAcc', 'marcStacc', 'stress', 'soft'],
  ['ten', 'portato', 'tenAcc'],
  ['ferm', 'fermS', 'fermL', 'fermVS', 'fermVL'],
  ['breath', 'breathT', 'caesura', 'caesuraS'],
  ['up', 'down'],
  ['tr', 'mord', 'prall', 'turn', 'invTurn', 'turnSlash', 'haydn', 'trembl'],
];
export const isFermata = (k) => k === 'ferm' || k === 'fermS' || k === 'fermL' || k === 'fermVS' || k === 'fermVL';

// ───────── 音符そのものの見た目（Phase 4） ─────────
// 符頭の形（n.head）。drum の符頭と同じ組み立て：black = 4分以下、half = 2分、whole = 全音符
export const NOTEHEADS = {
  x: { ja: '× 符頭', black: 'noteheadXBlack', half: 'noteheadXHalf', whole: 'noteheadXWhole', xml: 'x' },
  circlex: { ja: '⊗ 符頭', black: 'noteheadCircleX', half: 'noteheadCircleX', whole: 'noteheadCircleX', xml: 'circle-x' },
  diamond: { ja: 'ひし形（ハーモニクス）', black: 'noteheadDiamondBlack', half: 'noteheadDiamondWhite', whole: 'noteheadDiamondWhole', xml: 'diamond' },
  slash: { ja: 'スラッシュ', black: 'noteheadSlashHorizontalEnds', half: 'noteheadSlashWhiteHalf', whole: 'noteheadSlashWhiteWhole', xml: 'slash' },
  triangle: { ja: '三角', black: 'noteheadTriangleUpBlack', half: 'noteheadTriangleUpHalf', whole: 'noteheadTriangleUpWhole', xml: 'triangle' },
  square: { ja: '四角', black: 'noteheadSquareBlack', half: 'noteheadSquareWhite', whole: 'noteheadSquareWhite', xml: 'square' },
  plus: { ja: '＋ 符頭', black: 'noteheadPlusBlack', half: 'noteheadPlusHalf', whole: 'noteheadPlusWhole', xml: 'cross' },
};
// アルペジオ（ev.arp）
export const ARPS = {
  normal: { ja: 'アルペジオ' }, up: { ja: 'アルペジオ（下から上）' }, down: { ja: 'アルペジオ（上から下）' }, bracket: { ja: 'アルペジオしない（カッコ）' },
};
// トレモロ（ev.trem：符尾に付ける斜線の本数。'z' はバズロール）
export const TREMS = { 1: { ja: 'トレモロ（1本）', g: 'tremolo1' }, 2: { ja: 'トレモロ（2本）', g: 'tremolo2' }, 3: { ja: 'トレモロ（3本）', g: 'tremolo3' }, z: { ja: 'バズロール（z）', g: 'buzzRoll' } };
// 運指（n.fing）。数字と、ギターの右手 p i m a
export const FINGERS = { 0: 'fingering0', 1: 'fingering1', 2: 'fingering2', 3: 'fingering3', 4: 'fingering4', 5: 'fingering5', p: 'fingeringPLower', i: 'fingeringILower', m: 'fingeringMLower', a: 'fingeringALower', t: 'fingeringTLower' };
// 小節線の種類（score.measures[m].barline）
export const BARLINES = {
  double: { ja: '複縦線', xml: 'light-light' }, final: { ja: '終止線', xml: 'light-heavy' }, dashed: { ja: '点線（破線）', xml: 'dashed' },
  dotted: { ja: '点線', xml: 'dotted' }, heavy: { ja: '太線', xml: 'heavy' }, heavyHeavy: { ja: '太い複縦線', xml: 'heavy-heavy' },
  tick: { ja: '短い線（上だけ）', xml: 'tick' }, short: { ja: '短い線（真ん中）', xml: 'short' }, none: { ja: '小節線なし', xml: 'none' },
};
// ギターのコードの押さえ方（フレット図）。6弦 → 1弦の順、x = 弾かない、0 = 開放
export const FRET_LIB = {
  C: 'x32010', D: 'xx0232', E: '022100', F: '133211', G: '320003', A: 'x02220', B: 'x24442',
  Cm: 'x35543', Dm: 'xx0231', Em: '022000', Fm: '133111', Gm: '355333', Am: 'x02210', Bm: 'x24432',
  C7: 'x32310', D7: 'xx0212', E7: '020100', F7: '131211', G7: '320001', A7: 'x02020', B7: 'x21202',
  Cm7: 'x35343', Dm7: 'xx0211', Em7: '020000', Fm7: '131111', Gm7: '353333', Am7: 'x02010', Bm7: 'x24232',
  Cmaj7: 'x32000', Dmaj7: 'xx0222', Emaj7: '021100', Fmaj7: 'xx3210', Gmaj7: '320002', Amaj7: 'x02120', Bmaj7: 'x24342',
  Csus4: 'x33011', Dsus4: 'xx0233', Esus4: '022200', Gsus4: '330013', Asus4: 'x02230', Cadd9: 'x32030', Dsus2: 'xx0230', Asus2: 'x02200',
  'C#m': 'x46654', 'F#m': '244222', 'G#m': '466444', 'D#m': 'x68876', 'F#': '244322', 'C#': 'x46664', 'G#': '466544',
  Bb: 'x13331', Eb: 'x68886', Ab: '466544', Db: 'x46664', Gb: '244322', Bbm: 'x13321', Ebm: 'x68876',
  'F#m7': '242222', 'C#m7': 'x46454', Bb7: 'x13131', Eb7: 'x68686', Ab7: '464544', Bbmaj7: 'x13231', Ebmaj7: 'x68786', Abmaj7: '465544',
  Cdim: 'x3424x', Ddim: 'xx0101', Bdim: 'x2343x', Caug: 'x32110', Gaug: '321003', Bm7b5: 'x2323x', 'F#m7b5': '2x221x', Em7b5: '0x020x',
};
export function fretShape(name) {
  const c = parseChord(name);
  if (!c) return null;
  const root = c.root + (c.alter > 0 ? '#' : c.alter < 0 ? 'b' : '');
  const q = c.quality.replace(/^(M7|Δ7?|ma7)/, 'maj7').replace(/^(min|mi|-)/, 'm');
  const minor = q.startsWith('m') && !q.startsWith('maj');
  // そのままの形 → 「m7 / 7 / m」のような近い形 → 根音だけ、の順に探す
  const cands = [q, minor && q.includes('7') ? 'm7' : null, !minor && q.includes('7') && !q.startsWith('maj') ? '7' : null, minor ? 'm' : ''];
  for (const x of cands) if (x != null && FRET_LIB[root + x]) return FRET_LIB[root + x];
  return null;
}

// 強弱記号：glyph と再生の強さ（0〜1）
export const DYNAMICS = {
  ppp: { g: 'dynamicPPP', vel: 0.22 }, pp: { g: 'dynamicPP', vel: 0.32 }, p: { g: 'dynamicPiano', vel: 0.44 },
  mp: { g: 'dynamicMP', vel: 0.55 }, mf: { g: 'dynamicMF', vel: 0.66 }, f: { g: 'dynamicForte', vel: 0.78 },
  ff: { g: 'dynamicFF', vel: 0.9 }, fff: { g: 'dynamicFFF', vel: 1 },
  fp: { g: 'dynamicFortePiano', vel: 0.44, accent: 0.78 }, sf: { g: 'dynamicSforzando', accent: 0.9 },
  sfz: { g: 'dynamicSforzato', accent: 0.95 }, sfp: { g: 'dynamicSforzandoPiano', vel: 0.44, accent: 0.9 },
  rfz: { g: 'dynamicRinforzando2', accent: 0.88 },
  pppp: { g: 'dynamicPPPP', vel: 0.15 }, ffff: { g: 'dynamicFFFF', vel: 1 }, fz: { g: 'dynamicForzando', accent: 0.9 },
  sffz: { g: 'dynamicSforzatoFF', accent: 1 }, sfpp: { g: 'dynamicSforzandoPianissimo', vel: 0.32, accent: 0.9 },
  sfzp: { g: 'dynamicSforzatoPiano', vel: 0.44, accent: 0.95 }, rf: { g: 'dynamicRinforzando1', accent: 0.86 }, n: { g: 'dynamicNiente', vel: 0.1 },
};
export const DYN_ORDER = ['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'fp', 'sf', 'sfz', 'sffz', 'sfp', 'sfpp', 'sfzp', 'fz', 'rf', 'rfz', 'n'];

// よく使う文字の表情記号（Finale の「発想記号」セレクタに相当）
export const TEXT_PRESETS = [
  { text: 'cresc.', pos: 'below', it: true }, { text: 'dim.', pos: 'below', it: true }, { text: 'poco a poco', pos: 'below', it: true },
  { text: 'dolce', pos: 'above', it: true }, { text: 'espress.', pos: 'above', it: true }, { text: 'cantabile', pos: 'above', it: true },
  { text: 'legato', pos: 'above', it: true }, { text: 'rit.', pos: 'above', it: true }, { text: 'rall.', pos: 'above', it: true },
  { text: 'accel.', pos: 'above', it: true }, { text: 'a tempo', pos: 'above', it: false }, { text: 'Tempo I', pos: 'above', it: false },
  { text: 'pizz.', pos: 'above', it: false }, { text: 'arco', pos: 'above', it: false }, { text: 'con sord.', pos: 'above', it: false },
  { text: 'senza sord.', pos: 'above', it: false }, { text: 'solo', pos: 'above', it: false }, { text: 'tutti', pos: 'above', it: false },
];

// 線の記号（Smart Shape）。shift = 再生で何半音ずらすか
export const SPANS = {
  slur: { ja: 'スラー', key: 'S' },
  cresc: { ja: 'クレッシェンド（松葉）', key: '<' },
  dim: { ja: 'デクレッシェンド（松葉）', key: '>' },
  '8va': { ja: '8va（1オクターブ上で演奏）', shift: 12, g: 'ottavaAlta' },
  '8vb': { ja: '8vb（1オクターブ下で演奏）', shift: -12, g: 'ottavaBassaVb' },
  '15ma': { ja: '15ma（2オクターブ上で演奏）', shift: 24, g: 'quindicesimaAlta' },
  ped: { ja: 'ペダル（Ped. 〜 *）' },
  trill: { ja: 'トリル（波線つき）' },
  // Phase 4
  '15mb': { ja: '15mb（2オクターブ下で演奏）', shift: -24, g: 'quindicesimaBassaMb' },
  pedL: { ja: 'ペダル（線で示す）' },
  crescLine: { ja: 'cresc. - - -（文字のクレッシェンド）', text: 'cresc.', dyn: 'cresc' },
  dimLine: { ja: 'dim. - - -（文字のディミヌエンド）', text: 'dim.', dyn: 'dim' },
  ritLine: { ja: 'rit. - - -（だんだん遅く）', text: 'rit.', above: true, tempo: 0.72 },
  accelLine: { ja: 'accel. - - -（だんだん速く）', text: 'accel.', above: true, tempo: 1.25 },
  vib: { ja: 'ヴィブラート（波線）', above: true },
  gliss: { ja: 'グリッサンド（次の音まで）', pair: true },
  letRing: { ja: 'let ring（響かせる）', text: 'let ring', above: true, hook: true },
  palmMute: { ja: 'P.M.（パームミュート）', text: 'P.M.', above: true, hook: true },
  bracket: { ja: 'カッコ線（上）', text: '', above: true, hook: true, solid: true },
  textLine: { ja: '文字＋線（自由に入力）', text: '', above: true, hook: true, custom: true },
};

// 反復の「飛ぶ」指示
export const JUMPS = {
  dc: { text: 'D.C.', ja: 'D.C.（ダ・カーポ：最初へ）', to: 'start' },
  dcFine: { text: 'D.C. al Fine', ja: 'D.C. al Fine（最初へ戻って Fine で終わる）', to: 'start', until: 'fine' },
  dcCoda: { text: 'D.C. al Coda', ja: 'D.C. al Coda（最初へ戻って To Coda からコーダへ）', to: 'start', until: 'coda' },
  ds: { text: 'D.S.', ja: 'D.S.（ダル・セーニョ：𝄋 へ）', to: 'segno' },
  dsFine: { text: 'D.S. al Fine', ja: 'D.S. al Fine（𝄋 へ戻って Fine で終わる）', to: 'segno', until: 'fine' },
  dsCoda: { text: 'D.S. al Coda', ja: 'D.S. al Coda（𝄋 へ戻って To Coda からコーダへ）', to: 'segno', until: 'coda' },
};

// ───────── アーティキュレーション ─────────
// ids の音符すべてに付ける（全部に付いていたら外す）。休符にはフェルマータだけ付けられる
export function toggleArtic(score, ids, key) {
  // 休符にはフェルマータ・ブレス・カエスーラだけ付けられる
  const restOk = isFermata(key) || ARTICS[key]?.side === 'after';
  const evs = ids.map(id => findEvent(score, id)?.ev).filter(ev => ev && (!ev.rest || restOk));
  if (!evs.length) return null;
  const on = !evs.every(ev => ev.art && ev.art.includes(key));
  for (const ev of evs) {
    const a = (ev.art || []).filter(k => k !== key);
    if (on) {
      // 同時に付けない組み合わせ（スタッカートとスタッカーティッシモ、アクセントとマルカート …）は入れ替える
      const ex = new Set(ARTIC_EXCL.filter(g => g.includes(key)).flat());
      a.splice(0, a.length, ...a.filter(k => !ex.has(k)));
      a.push(key);
    }
    if (a.length) ev.art = a; else delete ev.art;
  }
  return on;
}

// 音符そのものの設定（Phase 4）：アルペジオ・トレモロ・小さい音符・符尾の向き・連桁・スラッシュ
//   ids の音符すべてに prop = value を付ける。同じ値が全部に付いていたら外す（トグル）
export function setEventProp(score, ids, prop, value) {
  const evs = ids.map(id => findEvent(score, id)?.ev).filter(ev => ev && !ev.mr && (prop === 'small' || prop === 'beam' || !ev.rest));
  if (!evs.length) return null;
  const on = !evs.every(ev => ev[prop] === value);
  for (const ev of evs) { if (on && value != null) ev[prop] = value; else delete ev[prop]; }
  return on;
}
// 1つ1つの音（和音の中の音）の設定：符頭の形・運指・括弧。noteIndex を指定するとその音だけ
export function setNoteProp(score, ids, prop, value, noteIndex = null) {
  const notes = [];
  for (const id of ids) {
    const ev = findEvent(score, id)?.ev;
    if (!ev || ev.rest) continue;
    ev.notes.forEach((n, i) => { if (noteIndex == null || noteIndex === i) notes.push(n); });
  }
  if (!notes.length) return null;
  const on = !notes.every(n => n[prop] === value);
  for (const n of notes) { if (on && value != null && value !== '') n[prop] = value; else delete n[prop]; }
  return on;
}
export function clearArtics(score, ids) {
  for (const id of ids) { const f = findEvent(score, id); if (f) delete f.ev.art; }
}

// ───────── 文字・強弱・コードネーム（sm.dirs） ─────────
export function addDir(score, p, s, m, dir) {
  const sm = staffMeasure(score, p, s, m);
  if (!sm) return -1;
  const list = sm.dirs || (sm.dirs = []);
  // 同じ位置の強弱記号・コードネームは置き換える
  if (dir.k === 'dyn' || dir.k === 'chord') {
    const i = list.findIndex(d => d.k === dir.k && d.t === dir.t);
    if (i >= 0) list.splice(i, 1);
  }
  list.push(dir);
  list.sort((a, b) => a.t - b.t);
  return list.indexOf(dir);
}
export function removeDir(score, p, s, m, idx) {
  const sm = staffMeasure(score, p, s, m);
  if (!sm?.dirs?.[idx]) return false;
  sm.dirs.splice(idx, 1);
  if (!sm.dirs.length) delete sm.dirs;
  return true;
}

// ───────── 線（sm.spans） ─────────
export function addSpan(score, p, s, v, a, b, k) {
  if (b.m < a.m || (b.m === a.m && b.t < a.t)) [a, b] = [b, a];
  const sm = staffMeasure(score, p, s, a.m);
  if (!sm) return -1;
  const sp = { k, v, t: a.t, dm: b.m - a.m, t2: b.t };
  (sm.spans || (sm.spans = [])).push(sp);
  return sm.spans.length - 1;
}
export function removeSpan(score, p, s, m, idx) {
  const sm = staffMeasure(score, p, s, m);
  if (!sm?.spans?.[idx]) return false;
  sm.spans.splice(idx, 1);
  if (!sm.spans.length) delete sm.spans;
  return true;
}
export const spanEnd = (m, sp) => ({ m: m + sp.dm, t: sp.t2 });

// 線の端を前後の音符へ動かす（which = 'end' | 'start'、dir = +1 / -1）。範囲がなくなる動きはしない
export function nudgeSpan(score, p, s, m, idx, which, dir) {
  const sm = staffMeasure(score, p, s, m);
  const sp = sm?.spans?.[idx];
  if (!sp) return null;
  const onsets = voiceOnsets(score, p, s, sp.v);
  const key = (x) => x.m * 1e7 + x.t;
  const a = { m, t: sp.t }, b = spanEnd(m, sp);
  const cur = which === 'end' ? b : a;
  let i = onsets.findIndex(o => key(o) === key(cur));
  if (i < 0) i = onsets.findIndex(o => key(o) > key(cur)) - (dir > 0 ? 1 : 0);
  const j = i + dir;
  if (j < 0 || j >= onsets.length) return null;
  const nx = onsets[j];
  if (which === 'end') {
    if (key(nx) < key(a)) return null;
    sp.dm = nx.m - m; sp.t2 = nx.t;
    return { m, idx };
  }
  if (key(nx) > key(b)) return null;
  // 始まりが別の小節へ移るときは、その小節の spans に引っ越す
  sm.spans.splice(idx, 1);
  if (!sm.spans.length) delete sm.spans;
  const ns = staffMeasure(score, p, s, nx.m);
  const moved = { ...sp, t: nx.t, dm: b.m - nx.m, t2: b.t };
  (ns.spans || (ns.spans = [])).push(moved);
  return { m: nx.m, idx: ns.spans.length - 1 };
}

// その声部の音符（休符以外）の始まりを、楽譜の頭から順に
export function voiceOnsets(score, p, s, v) {
  const out = [];
  const st = score.parts[p]?.staves[s];
  if (!st) return out;
  st.measures.forEach((sm, m) => {
    const voice = sm.voices[v] || (v > 0 ? null : sm.voices[0]);
    for (const x of positions(voice)) if (!x.ev.rest) out.push({ m, t: x.start, id: x.ev.id });
  });
  return out;
}

// 小節の挿入・削除で、小節をまたぐ線の長さ（dm）を合わせる
export function shiftSpansForInsert(score, at, count) {
  for (const part of score.parts) for (const st of part.staves) st.measures.forEach((sm, m) => {
    if (m >= at || !sm?.spans) return;
    for (const sp of sm.spans) if (m + sp.dm >= at) sp.dm += count;
  });
}
export function shiftSpansForDelete(score, from, to) {
  const n = to - from + 1;
  for (const part of score.parts) for (const st of part.staves) st.measures.forEach((sm, m) => {
    if (m >= from || !sm?.spans) return;
    sm.spans = sm.spans.filter(sp => {
      const e = m + sp.dm;
      if (e > to) { sp.dm -= n; return true; }
      if (e >= from) { sp.dm = from - 1 - m; sp.t2 = lastOnsetIn(st.measures[from - 1], sp.v) ?? sp.t; return sp.dm >= 0; }
      return true;
    });
    if (!sm.spans.length) delete sm.spans;
  });
}
function lastOnsetIn(sm, v) {
  const pos = positions(sm?.voices[v] || sm?.voices[0]).filter(x => !x.ev.rest);
  return pos.length ? pos[pos.length - 1].start : null;
}

// ───────── 歌詞 ─────────
export function setLyric(score, id, verse, text, hyphen = false) {
  const f = findEvent(score, id);
  if (!f) return false;
  const ev = f.ev;
  const lyr = ev.lyr ? [...ev.lyr] : [];
  const t = String(text || '').trim();
  if (t) lyr[verse] = hyphen ? { t, h: true } : { t };
  else lyr[verse] = null;
  while (lyr.length && !lyr[lyr.length - 1]) lyr.pop();
  if (lyr.length) ev.lyr = lyr.map(x => x || null); else delete ev.lyr;
  return true;
}
// 歌詞を入れる次の音符（休符と、タイの続きの音は飛ばす）
export function nextLyricTarget(score, id, dir = 1) {
  let f = findEvent(score, id);
  let guard = 0;
  while (f && guard++ < 5000) {
    f = dir > 0 ? nextEvent(score, f) : prevEventSameVoice(score, f);
    if (!f) return null;
    if (f.ev.rest) continue;
    const pv = prevEventSameVoice(score, f);
    const tiedIn = pv && !pv.ev.rest && pv.ev.notes.length && pv.ev.notes.every(n => n.tie);
    if (tiedIn) continue;
    return f.ev.id;
  }
  return null;
}
function prevEventSameVoice(score, f) {
  const voice = getVoice(score, f.p, f.s, f.m, f.v);
  if (voice && f.i > 0) return { ...f, ev: voice[f.i - 1], i: f.i - 1, t: f.t - evTicks(voice[f.i - 1]) };
  if (f.m === 0) return null;
  const pv = getVoice(score, f.p, f.s, f.m - 1, f.v);
  if (!pv || !pv.length) return null;
  const pos = positions(pv);
  const last = pos[pos.length - 1];
  return { ...f, m: f.m - 1, ev: last.ev, i: last.i, t: last.start };
}

// ───────── コードネーム ─────────
// 文字（C, F#m7, Bbmaj7/D …）を 根音・付け足し・ベース に分ける
export function parseChord(text) {
  const m = /^\s*([A-Ga-g])([#♯b♭]{0,2})(.*?)(?:\/([A-Ga-g])([#♯b♭]{0,2}))?\s*$/.exec(text || '');
  if (!m) return null;
  const alt = (s) => [...(s || '')].reduce((a, c) => a + (c === '#' || c === '♯' ? 1 : -1), 0);
  return { root: m[1].toUpperCase(), alter: alt(m[2]), quality: m[3] || '', bass: m[4] ? m[4].toUpperCase() : null, bassAlter: alt(m[5]) };
}
// コードネームを移調（半音数・調号は綴りを決めるため）
export function transposeChord(text, semis, fifths = 0) {
  const c = parseChord(text);
  if (!c || !semis) return text;
  const sp = (step, alter) => { const q = spellMidi(midiOf({ step, alter, octave: 4 }) + semis, fifths); return q.step + (q.alter > 0 ? '#'.repeat(q.alter) : 'b'.repeat(-q.alter)); };
  return sp(c.root, c.alter) + c.quality + (c.bass ? '/' + sp(c.bass, c.bassAlter) : '');
}

// ───────── 装飾音符 ─────────
// loc の位置の音符（なければそこを覆う音符）の前に装飾音を足す。chord = 直前の装飾音に重ねる
export function addGrace(score, loc, pitch, opts = {}) {
  expandMeasureRest(score, loc.p, loc.s, loc.m, loc.v);
  const voice = getVoice(score, loc.p, loc.s, loc.m, loc.v, true);
  const x = positions(voice).find(y => y.start === loc.t) || positions(voice).find(y => y.start <= loc.t && loc.t < y.end);
  if (!x) return null;
  const ev = x.ev;
  const list = ev.grace || (ev.grace = []);
  const pt = { step: pitch.step, alter: pitch.alter || 0, octave: pitch.octave };
  if (opts.chord && list.length) {
    const g = list[list.length - 1];
    if (!g.notes.some(n => n.step === pt.step && n.octave === pt.octave && n.alter === pt.alter)) g.notes.push(pt);
    g.notes.sort((a, b) => diatonic(a) - diatonic(b));
  } else list.push({ type: opts.type || 'eighth', slash: opts.slash ?? true, notes: [pt] });
  return ev.id;
}
export function removeLastGrace(score, id) {
  const f = findEvent(score, id);
  if (!f?.ev.grace?.length) return false;
  f.ev.grace.pop();
  if (!f.ev.grace.length) delete f.ev.grace;
  return true;
}

// ───────── 反復の演奏順 ─────────
// 反復記号・カッコ・D.C./D.S./Coda/Fine をたどって、実際に演奏する小節の順番を返す
export function playOrder(score) {
  const ms = score.measures;
  const n = ms.length;
  const order = [];
  const segno = ms.findIndex(m => m.segno);
  const coda = ms.findIndex(m => m.coda);
  let i = 0, guard = 0;
  let repStart = 0, pass = 1;
  const count = {};      // 後ろ向き反復の小節 → 何回くり返したか
  let jumped = null;     // D.C. / D.S. のあと：{ until }。以降は反復しない
  // そのカッコの次にも続きのカッコがあるか（D.C. 後は最後のカッコだけ演奏する）
  const hasNextEnding = (k) => { const e = ms[k].ending; return !!(e && ms[k + (e.len || 1)]?.ending); };
  while (i < n && guard++ < 20000) {
    const m = ms[i];
    if (m.repeatStart && !jumped && repStart !== i) { repStart = i; pass = 1; }
    if (m.ending) {
      const len = Math.max(1, m.ending.len || 1);
      const take = jumped ? !hasNextEnding(i) : (m.ending.nums || [1]).includes(pass);
      if (!take) { i += len; continue; }
    }
    order.push(i);
    if (m.repeatEnd && !jumped) {
      const times = m.repeatEnd.times || 2;
      const c = count[i] || 1;
      if (c < times) { count[i] = c + 1; pass++; i = repStart; continue; }
      count[i] = 1;
      repStart = i + 1; pass = 1;
    }
    if (jumped && jumped.until === 'fine' && m.fine) break;
    if (jumped && jumped.until === 'coda' && m.toCoda && coda >= 0) { i = coda; continue; }
    if (m.jump && JUMPS[m.jump] && !jumped) {
      const J = JUMPS[m.jump];
      jumped = { until: J.until || null };
      i = J.to === 'segno' && segno >= 0 ? segno : 0;
      pass = 1;
      continue;
    }
    i++;
  }
  return order;
}

// ───────── 移調楽器の記譜表示 ─────────
// 楽譜データは実音で持っている（オクターブだけずれる楽器は記譜で持つ）。記譜音で見せるときの差
export function partTrans(part) {
  const inst = INST[part.inst];
  return inst && inst.trans && !inst.oct ? inst.trans : null;
}
// 記譜の調号 = 実音の調号 + 差。7個を超えたら異名同音の調に（嬰ト長調 → 変イ長調）
export function writtenFifths(fifths, trans) {
  if (!trans) return fifths;
  let w = fifths + fifthsForSemis(-trans.chromatic);
  if (w > 7) w -= 12;
  if (w < -7) w += 12;
  return w;
}
export function toWritten(p, trans, wFifths) {
  if (!trans) return p;
  const q = transposeInterval(p, -trans.diatonic, -trans.chromatic);
  // 調号を異名同音に回したときは綴りも合わせる
  if (wFifths != null && Math.abs(q.alter) >= 1 && keyAlter(wFifths, q.step) !== q.alter) {
    const r = spellMidi(midiOf(q), wFifths);
    if (Math.abs(r.alter) <= Math.abs(q.alter)) return r;
  }
  return q;
}
export function toConcert(p, trans) {
  if (!trans) return p;
  return transposeInterval(p, trans.diatonic, trans.chromatic);
}

// 記譜音で表示するための楽譜のコピー（音符の高さと装飾音・コードネームを記譜に直す）。調号は浄書側で直す
export function writtenScore(score) {
  const A = measureAttrs(score);
  const need = score.parts.some(p => partTrans(p));
  if (!need) return score;
  const out = { ...score, parts: score.parts.map(part => {
    const tr = partTrans(part);
    if (!tr) return part;
    const cp = JSON.parse(JSON.stringify(part));
    cp.staves.forEach(st => st.measures.forEach((sm, m) => {
      const wf = writtenFifths(A[m].fifths, tr);
      const conv = (n) => ({ ...toWritten(n, tr, wf), ...(n.tie ? { tie: true } : {}), ...(n.acc ? { acc: n.acc } : {}) });
      sm.voices.forEach(v => v && v.forEach(ev => {
        if (!ev.rest) ev.notes = ev.notes.map(conv).sort((a, b) => diatonic(a) - diatonic(b));
        if (ev.grace) ev.grace.forEach(g => (g.notes = g.notes.map(conv)));
      }));
      if (sm.dirs) sm.dirs.forEach(d => { if (d.k === 'chord') d.text = transposeChord(d.text, -tr.chromatic, wf); });
    }));
    cp._trans = tr;
    return cp;
  }) };
  return out;
}

// 小節に「何か」があるか（パート譜で休みの小節をまとめるときの判定）
export function measureHasMarks(score, m) {
  const ms = score.measures[m];
  return !!(ms.repeatStart || ms.repeatEnd || ms.ending || ms.segno || ms.coda || ms.fine || ms.toCoda || ms.jump || ms.sysBreak || ms.reh || ms.stext);
}

// 練習番号：自動（A, B, C … Z, AA …）なら、楽譜の頭から数えた順番で文字を決める
export function rehearsalLabels(score) {
  const out = {};
  let n = 0;
  score.measures.forEach((ms, m) => {
    if (!ms.reh) return;
    if (ms.reh.text) { out[m] = ms.reh.text; return; }
    if (ms.reh.num) { out[m] = String(m + 1); return; }
    let k = n++, s = '';
    do { s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26) - 1; } while (k >= 0);
    out[m] = s;
  });
  return out;
}

export { fromDiatonic };
