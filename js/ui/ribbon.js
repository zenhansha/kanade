// リボン（Phase 4）：Word と同じように、上のタブ（ホーム・記号・小節・レイアウト・再生・表示・ツール）を切り替えると、
// その下に「よく使う操作のまとまり（グループ）」が並ぶ。今までの下のパレットと上のメニューをここにまとめた。
//   ・記号タブのボタンは「ギャラリー」（タイルの一覧）を開く。全部の記号は横の「記号パレット」（F9）でも
//   ・右上の検索（Ctrl+K）で、操作や記号を名前で探して実行できる（Word の「検索」/ やりたいことを入力）
import { SMUFL } from '../smufl.js';
import { DUR_GLYPH } from '../app.js';
import { CATEGORIES, SYMBOLS, tilesHtml, symbolById, searchSymbols, iconHtml, glyphSvg } from './symbols.js';
import { INST } from '../core/score.js';
import { ROOMS } from '../audio/room.js';

const G = SMUFL.glyphs;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sv = (d, extra = '') => `<svg viewBox="0 0 24 24" class="lsvg"><path d="${d}" ${extra}/></svg>`;
const I = {
  select: sv('M5 3l14 8-6 1.5L10 19z'), input: sv('M16 3l5 5L9 20H4v-5zM13 6l5 5'),
  cut: sv('M6 4l12 14M18 4 6 18M6 18a2.5 2.5 0 1 0 0 .1M18 18a2.5 2.5 0 1 0 0 .1'), copy: sv('M8 8h11v12H8zM5 16V4h11'),
  paste: sv('M9 4h6v3H9zM7 5H5v16h14V5h-2M9 12h6M9 16h4'), del: sv('M20 6H9l-6 6 6 6h11zM16 10l-4 4m0-4 4 4'),
  repeat: sv('M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5'), piano: sv('M3 5h18v14H3zM8 5v14M13 5v14M18 5v14'),
  tie: sv('M3 10c4 6 14 6 18 0'), slur: sv('M3 16C7 6 17 6 21 16'), cresc: sv('M21 7 3 12l18 5'), dim: sv('M3 7l18 5-18 5'),
  addM: sv('M3 6h14M3 12h14M3 18h9M18 14v8M14 18h8'), insM: sv('M7 4v16M17 4v16M12 9v6M9 12h6'), delM: sv('M7 4v16M17 4v16M9 12h6'),
  page: sv('M6 3h9l4 4v14H6zM15 3v4h4'), staff: sv('M3 7h18M3 10h18M3 13h18M3 16h18M3 19h18'),
  sysB: sv('M4 7h16M4 12h10M17 9l3 3-3 3M4 17h16'), pageB: sv('M6 3h9l4 4v14H6zM9 13h7M9 17h5'),
  prev: sv('M15 6l-6 6 6 6'), next: sv('M9 6l6 6-6 6'), lock: sv('M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4'), space: sv('M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4'),
  info: sv('M12 3a9 9 0 1 0 .1 0M12 11v6M12 7.5v.5'), inst: sv('M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0'),
  layout: sv('M4 4h16v16H4zM4 10h16M10 10v10'), num: sv('M4 9h16M4 15h16M10 3 8 21M16 3l-2 18'),
  play: sv('M7 4v16l13-8z', 'fill="currentColor" stroke="none"'), rewind: sv('M6 5v14M18 5l-9 7 9 7z'), loop: sv('M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3'),
  metro: sv('M8 21h8l-2-17h-4zM12 14l6-9'), mixer: sv('M6 4v16M12 4v16M18 4v16M4 8h4M10 14h4M16 10h4'), human: sv('M12 5a2 2 0 1 0 .1 0M7 21l2-8-3-3 6-1 6 1-3 3 2 8'),
  swing: sv('M4 16c3-8 5-8 8 0s5 8 8 0'), chords: sv('M5 18V6l14-2v12M5 9l14-2'), midiOut: sv('M4 6h16v12H4zM8 10v4M12 10v4M16 10v4'), wav: sv('M3 12h2l2-6 3 12 3-14 3 12 2-4h3'),
  reverb: sv('M4 12h2M8 8v8M12 5v14M16 8v8M20 11v2'), full: sv('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'),
  rec: '<svg viewBox="0 0 24 24" class="lsvg"><circle cx="12" cy="12" r="6.5" class="fill recdot"/></svg>',
  vert: sv('M7 3h10v8H7zM7 13h10v8H7z'), horiz: sv('M2 6h9v12H2zM13 6h9v12h-9z'), spread: sv('M3 5h8v14H3zM13 5h8v14h-8zM11 5h2v14h-2z'), scroll: sv('M2 9h20v6H2zM6 12h.01M10 12h.01M14 12h.01M18 12h.01'),
  zoomIn: sv('M11 4a7 7 0 1 0 .1 0M21 21l-5-5M8 11h6M11 8v6'), zoomOut: sv('M11 4a7 7 0 1 0 .1 0M21 21l-5-5M8 11h6'), fitW: sv('M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4'), fitP: sv('M6 3h12v18H6z'),
  color: sv('M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1 .9-1.4 1.8-1.4H17a4 4 0 0 0 4-4c0-5-4-11-9-11zM7.5 11h.01M10 7h.01M15 7.5h.01'),
  range: sv('M4 20 20 4M4 4h6M4 4v6M20 20h-6M20 20v-6'), panel: sv('M3 4h18v16H3zM15 4v16'), theme: sv('M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z'),
  view: sv('M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 9.2a2.8 2.8 0 1 0 .1 0'), trans: sv('M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3'),
  transpose: sv('M5 9l4-4 4 4M9 5v14M19 15l-4 4-4-4M15 19V5'), x2: sv('M4 12h6M14 6l6 12M20 6l-6 12'), half: sv('M4 12h16M12 4v4M12 16v4'), retro: sv('M20 12H4M8 8l-4 4 4 4'),
  enh: '<span class="ticon bold">♯⇄♭</span>', erase: sv('M7 21h12M5 15l9-9 5 5-9 9H7z'), explode: sv('M12 3v7M12 21v-7M5 8l5 4-5 4M19 8l-5 4 5 4'), implode: sv('M12 3v7M12 21v-7M9 6l3 3 3-3M9 18l3-3 3 3'),
  swap: sv('M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3'), interval: sv('M12 4a3 2 0 1 0 .1 0M12 16a3 2 0 1 0 .1 0M18 4v14'), slashes: '<span class="ticon bold">////</span>',
  xml: '<span class="ticon small bold">XML</span>', mid: '<span class="ticon small bold">MID</span>', png: '<span class="ticon small bold">PNG</span>', svgI: '<span class="ticon small bold">SVG</span>', print: sv('M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z'),
  check: sv('M4 12l5 5L20 6'), goto: sv('M4 12h12M12 6l6 6-6 6M20 4v16'), wide: sv('M4 12h16M7 8l-4 4 4 4M17 8l4 4-4 4'), narrow: sv('M3 12h6M15 12h6M6 8l4 4-4 4M18 8l-4 4 4 4'),
  pal: sv('M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1 .9-1.4 1.8-1.4H17a4 4 0 0 0 4-4c0-5-4-11-9-11z'), more: sv('M5 12h.01M12 12h.01M19 12h.01', 'stroke-width="3" stroke-linecap="round"'),
  collapse: sv('M6 15l6-6 6 6'), expand: sv('M6 9l6 6 6-6'),
  mic: sv('M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7'),
  follow: sv('M3 5c3-1 6-1 9 1v14c-3-2-6-2-9-1zM21 5c-3-1-6-1-9 1v14c3-2 6-2 9-1zM15 9l2 2 3-4'),
  practice: sv('M12 3a9 9 0 1 0 .1 0M12 7.5a4.5 4.5 0 1 0 .1 0M12 11.5v1'),
  ramp: sv('M4 19l5-6 4 3 7-9M15 7h5v5'),
  accomp: sv('M4 19V7l8-2v12M4 11l8-2M16 9v8a2 2 0 1 0 2 2V11h3'),
  guess: sv('M5 18V6l11-2v12M5 9l11-2M18 13a2.5 2.5 0 1 1 3 2.4V17M21 20.5v.01'),
};
const g = (name) => glyphSvg(name, 'rbg');
const DURS = [['64th', '1', '64分'], ['32nd', '2', '32分'], ['16th', '3', '16分'], ['eighth', '4', '8分'], ['quarter', '5', '4分'], ['half', '6', '2分'], ['whole', '7', '全']];

// ───────── タブとグループ ─────────
// 1つのボタン：{ id, ja, icon, size: 'big' | 'mid'（標準）| 'sm'（絵だけ）, run, on, dis, menu, gallery, key }
export function buildTabs(app) {
  const a = app, st = () => a.state;
  const tools = () => a.tools, dlg = () => a.dialogs;
  const hasSel = () => !!(a.state.sel || a.state.mode === 'input');
  const sym = (id) => { const s = symbolById(id); return { id: 'sym:' + id, ja: s.ja.replace(/（.*?）$/, ''), title: s.ja, icon: iconHtml(s.icon), size: 'sm', run: () => s.run(a), key: s.key }; };
  const cat = (c) => ({ id: 'gal:' + c.id, ja: c.short || c.ja, title: c.ja, icon: iconHtml(c.icon), size: 'big', gallery: c.id, drop: true });
  const pb = () => a.score.settings.playback || (a.score.settings.playback = {});
  return [
    { id: 'home', ja: 'ホーム', groups: [
      { ja: 'モード', items: [{ id: 'modeSwitch', special: 'mode' }] },
      { ja: '音価', items: DURS.map(([t, k, ja]) => ({ id: 'dur:' + t, ja, title: `${ja}音符（${k}）`, icon: g(DUR_GLYPH[t]), size: 'sm', key: k, run: () => a.setDuration(t), on: () => st().dur.type === t, inputOn: true })) },
      { ja: '', items: [
        { id: 'dot', ja: '付点', title: '付点（.）', icon: `<span class="dotg">${g('metNoteQuarterUp')}${g('metAugmentationDot')}</span>`, size: 'sm', key: '.', run: () => a.toggleDot(), on: () => !!st().dur.dots, inputOn: true },
        { id: 'rest', ja: '休符', title: '休符（0）／選択中を休符に', icon: g('restQuarter'), size: 'sm', key: '0', run: () => a.toggleRestMode(), on: () => st().mode === 'input' && st().rest, inputOn: true },
        { id: 'tie', ja: 'タイ', title: 'タイ（T）', icon: I.tie, size: 'sm', key: 'T', run: () => a.tie() },
        { id: 'del', ja: '削除', title: '削除（Delete）：音符を休符に・入力モードでは1つ前を消す', icon: I.del, size: 'sm', run: () => a.deleteSel() },
      ] },
      { ja: '臨時記号', items: [[-1, 'accidentalFlat', 'フラット（−）'], [0, 'accidentalNatural', 'ナチュラル'], [1, 'accidentalSharp', 'シャープ（＋）']].map(([v, gl, ja]) => ({ id: 'acc:' + v, ja, title: ja, icon: g(gl), size: 'sm', run: () => a.setAccidental(v) })).concat([{ id: 'accMore', ja: 'その他', title: 'ダブルシャープ・ダブルフラット・注意の臨時記号', icon: g('accidentalDoubleSharp'), size: 'sm', drop: true, gallery: 'acc' }]) },
      { ja: '連符・和音', items: [
        { id: 'tuplet', ja: '連符', title: '連符（Ctrl+3 など）', icon: '<span class="ticon bold">3</span>', size: 'sm', drop: true, menu: () => [2, 3, 4, 5, 6, 7, 9].map(n => ({ label: `${n}連符`, kbd: n <= 7 ? 'Ctrl+' + n : '', run: () => a.makeTuplet(n) })) },
        { id: 'chord', ja: '和音', title: '和音モード：入れた音を直前の音に重ねる（Shift+音名でも）', icon: '<span class="ticon bold">和</span>', size: 'sm', run: () => a.toggleChord(), on: () => st().chord },
        { id: 'grace', ja: '装飾音符', title: '装飾音符モード（;）', icon: g('graceNoteAcciaccaturaStemUp'), size: 'sm', key: ';', run: () => a.toggleGrace(), on: () => !!st().grace, inputOn: true },
      ] },
      { ja: '声部', items: [{ id: 'voices', special: 'voices' }] },
      { ja: '声で入力', items: [
        { id: 'humH', ja: '鼻歌入力', title: '歌うと楽譜になる（マイク）', icon: I.mic, size: 'big', run: () => tools().humDialog(), on: () => !!a.live?.hum },
      ] },
      { ja: 'よく使う記号', items: [sym('art:stacc'), sym('art:acc'), sym('span:slur'), sym('span:cresc'), sym('span:dim'),
        { id: 'dynq', ja: '強弱', title: '強弱記号', icon: g('dynamicMF'), size: 'sm', drop: true, gallery: 'dyn' }] },
      { ja: '編集', items: [
        { id: 'cut', ja: '切り取り', title: '切り取り（Ctrl+X）', icon: I.cut, size: 'sm', run: () => a.copy(true) },
        { id: 'copy', ja: 'コピー', title: 'コピー（Ctrl+C）', icon: I.copy, size: 'sm', run: () => a.copy(false) },
        { id: 'paste', ja: '貼り付け', title: '貼り付け（Ctrl+V）', icon: I.paste, size: 'sm', run: () => a.paste(), dis: () => !a.clip },
        { id: 'piano', ja: '鍵盤', title: '画面鍵盤の表示／非表示', icon: I.piano, size: 'sm', run: () => a.piano.toggle(), on: () => !a.piano.el.hidden },
      ] },
    ] },
    { id: 'marks', ja: '記号', groups: [
      { ja: '音符に付ける', items: ['artic', 'orn', 'breath', 'tech', 'arp', 'trem', 'head', 'fing'].map(id => cat(CATEGORIES.find(c => c.id === id))) },
      { ja: '強弱・線・文字', items: ['dyn', 'lines', 'text', 'tempo'].map(id => cat(CATEGORIES.find(c => c.id === id))) },
      { ja: '歌詞・コード', items: [sym('text:lyrics'), sym('text:chord'), sym('text:fret'), sym('text:reh')] },
      { ja: '小節に付ける', items: ['repeat', 'bar', 'clef', 'key', 'time', 'beam', 'layout'].map(id => cat(CATEGORIES.find(c => c.id === id))) },
      { ja: 'パレット', items: [{ id: 'palette', ja: '記号パレット', title: 'すべての記号の一覧と検索（F9）', icon: I.pal, size: 'big', run: () => a.ribbon.togglePanel(), on: () => a.ribbon.panelOpen }] },
    ] },
    { id: 'measure', ja: '小節', groups: [
      { ja: '小節', items: [
        { id: 'addM', ja: '末尾に追加', title: '末尾に小節を追加（Ctrl+B）', icon: I.addM, size: 'big', run: () => dlg().appendMeasures() },
        { id: 'insM', ja: '前に挿入', title: '選んだ小節の前に1小節挿入', icon: I.insM, size: 'mid', run: () => a.edit('小節の挿入', () => a.E.appendMeasures(a.score, 1, a.targetMeasure())) },
        { id: 'delM', ja: '削除', title: '選んだ小節を全パートから削除', icon: I.delM, size: 'mid', run: () => dlg().deleteMeasures() },
      ] },
      { ja: '拍子・調・音部記号', items: [
        { id: 'timeD', ja: '拍子', title: '拍子の変更（音符は新しい小節線で組み直す）', icon: g('timeSigCommon'), size: 'big', drop: true, gallery: 'time' },
        { id: 'keyD', ja: '調号', title: '調号の変更', icon: g('accidentalSharp'), size: 'big', drop: true, gallery: 'key' },
        { id: 'clefD', ja: '音部記号', title: '音部記号の変更', icon: g('gClef'), size: 'big', drop: true, gallery: 'clef' },
        { id: 'tempoD', ja: 'テンポ', title: 'テンポの変更', icon: g('metNoteQuarterUp'), size: 'mid', run: () => dlg().tempo() },
        { id: 'pickup', ja: '弱起', title: '弱起（アウフタクト）', icon: '<span class="ticon small bold">♪|</span>', size: 'mid', run: () => dlg().pickup() },
      ] },
      { ja: '反復・小節線', items: [
        { id: 'repD', ja: '反復記号', title: '反復記号・カッコ・D.S. / Coda', icon: g('segno'), size: 'big', drop: true, gallery: 'repeat' },
        { id: 'barD', ja: '小節線', title: '小節線の種類', icon: iconHtml(CATEGORIES.find(c => c.id === 'bar').icon), size: 'big', drop: true, gallery: 'bar' },
        sym('rep:mrep'),
      ] },
      { ja: '幅・移動', items: [
        { id: 'wide', ja: '広げる', title: '小節の幅を広げる（}）', icon: I.wide, size: 'mid', run: () => a.stretchMeasures(1.12) },
        { id: 'narrow', ja: '狭める', title: '小節の幅を狭める（{）', icon: I.narrow, size: 'mid', run: () => a.stretchMeasures(1 / 1.12) },
        { id: 'goto', ja: '小節へ移動', title: '第◯小節へ移動（Ctrl+G）', icon: I.goto, size: 'mid', run: () => a.gotoMeasure() },
        { id: 'reh', ja: '練習番号', title: '練習番号（A, B, C …）', icon: '<span class="ticon boxed">A</span>', size: 'mid', run: () => a.toggleRehearsal() },
      ] },
    ] },
    { id: 'layout', ja: 'レイアウト', groups: [
      { ja: 'ページ', items: [
        { id: 'pageSetup', ja: 'ページ設定', title: '用紙・譜表の大きさ', icon: I.page, size: 'big', run: () => dlg().pageSetup() },
        { id: 'pageLayout', ja: '段とページ', title: '段の間隔・1段の小節数・余白', icon: I.layout, size: 'big', run: () => tools().pageLayout() },
        { id: 'staffMm', ja: '譜表の大きさ', title: '五線の高さ', icon: I.staff, size: 'mid', drop: true, menu: () => [5, 5.5, 6, 6.5, 7, 7.5, 8, 9].map(mm => ({ label: `${a.score.settings.staffMm === mm ? '✓ ' : ''}${mm} mm${mm === 7 ? '（標準）' : mm < 7 ? '（小さめ）' : '（大きめ）'}`, run: () => { a.edit('譜表の大きさ', () => { a.score.settings.staffMm = mm; }); a.view.resetZoom(); a.relayout(); } })) },
        { id: 'spacing', ja: '音符の間隔', title: '音符の横の間隔', icon: I.wide, size: 'mid', drop: true, menu: () => [[0.85, '狭い'], [1, '標準'], [1.15, '広い'], [1.3, 'とても広い']].map(([v, l]) => ({ label: `${(a.score.settings.spacing || 1) === v ? '✓ ' : ''}${l}`, run: () => a.edit('音符の間隔', () => { if (v === 1) delete a.score.settings.spacing; else a.score.settings.spacing = v; }) })) },
      ] },
      { ja: '段の区切り', items: [
        { id: 'sysB', ja: '改段', title: 'この小節の後で改段', icon: I.sysB, size: 'mid', run: () => symbolById('lay:sys').run(a) },
        { id: 'pageB', ja: '改ページ', title: 'この小節の後で改ページ', icon: I.pageB, size: 'mid', run: () => symbolById('lay:page').run(a) },
        { id: 'prevS', ja: '前の段へ', title: 'この段の最初の小節を前の段へ', icon: I.prev, size: 'mid', run: () => tools().moveSystem(a.targetMeasure(), -1) },
        { id: 'nextS', ja: '次の段へ', title: 'この段の最後の小節を次の段へ', icon: I.next, size: 'mid', run: () => tools().moveSystem(a.targetMeasure(), 1) },
        { id: 'lockS', ja: '1段にまとめる', title: '選んだ小節を1段にまとめる', icon: I.lock, size: 'mid', run: () => { const s = a.state.sel; if (s?.kind === 'range' && s.m2 > s.m1) tools().lockSystem(s.m1, s.m2); else a.toast('1段にまとめる小節を範囲選択してください'); } },
      ] },
      { ja: '表示する文字', items: [
        { id: 'mnum', ja: '小節番号', title: '小節番号の出し方', icon: I.num, size: 'mid', drop: true, menu: () => [['system', '段の頭だけ'], ['every', '毎小節'], ['n5', '5小節ごと'], ['n10', '10小節ごと'], ['none', '出さない']].map(([v, l]) => ({ label: `${(a.score.settings.measureNumbers || 'system') === v ? '✓ ' : ''}${l}`, run: () => a.edit('小節番号', () => { if (v === 'system') delete a.score.settings.measureNumbers; else a.score.settings.measureNumbers = v; }) })) },
        { id: 'iname', ja: '楽器名', title: '楽器名の出し方', icon: I.inst, size: 'mid', drop: true, menu: () => [['abbr', '最初はフルネーム、2段目から略称'], ['full', 'いつもフルネーム'], ['first', '最初の段だけ'], ['none', '出さない']].map(([v, l]) => ({ label: `${(a.score.settings.instNames || 'abbr') === v ? '✓ ' : ''}${l}`, run: () => a.edit('楽器名', () => { if (v === 'abbr') delete a.score.settings.instNames; else a.score.settings.instNames = v; }) })) },
        { id: 'pnum', ja: 'ページ番号', title: 'ページ番号の出し方', icon: I.page, size: 'mid', drop: true, menu: () => [['alt', '上の外側（左右交互）'], ['center', '下の真ん中'], ['none', '出さない']].map(([v, l]) => ({ label: `${(a.score.settings.pageNumbers || 'alt') === v ? '✓ ' : ''}${l}`, run: () => a.edit('ページ番号', () => { if (v === 'alt') delete a.score.settings.pageNumbers; else a.score.settings.pageNumbers = v; }) })) },
      ] },
      { ja: 'スコア', items: [
        { id: 'info', ja: 'スコア情報', title: 'タイトル・作曲者・著作権', icon: I.info, size: 'big', run: () => dlg().scoreInfo() },
        { id: 'insts', ja: '楽器', title: '楽器の追加・削除・並べ替え', icon: I.inst, size: 'big', run: () => dlg().instruments() },
      ] },
    ] },
    { id: 'play', ja: '再生', groups: [
      { ja: '再生', items: [
        { id: 'playB', ja: '再生／停止', title: '再生／停止（スペース）', icon: I.play, size: 'big', run: () => a.togglePlay(), on: () => a.player.playing },
        { id: 'rewindB', ja: '先頭へ', title: '先頭から', icon: I.rewind, size: 'mid', run: () => a.rewind() },
        { id: 'loop', ja: 'ループ', title: '選んだ小節の範囲をくり返し再生', icon: I.loop, size: 'mid', run: () => a.toggleLoop(), on: () => !!a.loop },
        { id: 'speed', special: 'speed' },
      ] },
      { ja: 'メトロノーム', items: [
        { id: 'click', ja: 'メトロノーム', title: '再生中にクリックを鳴らす', icon: I.metro, size: 'big', run: () => { a.edit('メトロノーム', () => { pb().click = !pb().click; }); a.toast(pb().click ? 'メトロノーム：オン' : 'メトロノーム：オフ'); }, on: () => !!a.score.settings.playback?.click },
        { id: 'tapT', ja: 'タップテンポ', title: '拍に合わせてたたいてテンポを決める', icon: g('metNoteQuarterUp'), size: 'mid', run: () => dlg().tempo() },
        { id: 'countIn', ja: 'カウントイン', title: '再生前のカウント', icon: '<span class="ticon bold">1·2</span>', size: 'mid', drop: true, menu: () => [0, 1, 2].map(n => ({ label: `${(a.score.settings.playback?.countIn ?? 1) === n ? '✓ ' : ''}${n ? n + '小節' : 'なし'}`, run: () => a.edit('カウントイン', () => { pb().countIn = n; }) })) },
      ] },
      { ja: '表情', items: [
        { id: 'human', ja: '表情付き再生', title: 'rit. ・ accel. ・拍の強弱・人間らしい揺れ', icon: I.human, size: 'big', run: () => { a.edit('表情付き再生', () => { pb().human = pb().human === false; }); }, on: () => a.score.settings.playback?.human !== false },
        { id: 'swing', ja: 'スウィング', title: '8分音符を跳ねる', icon: I.swing, size: 'mid', drop: true, menu: () => [[0, 'なし'], [0.5, '軽く'], [1, 'しっかり（3連）']].map(([v, l]) => ({ label: `${(a.score.settings.playback?.swing || 0) === v ? '✓ ' : ''}${l}`, run: () => a.edit('スウィング', () => { pb().swing = v; }) })) },
        { id: 'chordsP', ja: 'コードを鳴らす', title: 'コードネームをピアノで鳴らす', icon: I.chords, size: 'mid', run: () => a.edit('コードを鳴らす', () => { pb().chords = !pb().chords; }), on: () => !!a.score.settings.playback?.chords },
      ] },
      { ja: '音', items: [
        { id: 'mixer', ja: 'ミキサー', title: '音量・左右・ミュート・ソロ', icon: I.mixer, size: 'big', run: () => tools().mixer() },
        { id: 'hq', ja: '高音質音源', title: 'ネットにつながっていれば高音質のサンプルで鳴らす', icon: I.wav, size: 'mid', run: () => { a.synth.useSamples = !a.synth.useSamples; a.toast(a.synth.useSamples ? '高音質音源：オン' : '内蔵シンセで再生します'); a.updateUI(); }, on: () => a.synth.useSamples },
        { id: 'reverb', ja: '響き', title: '部屋の響き（ホール・部屋・なし）', icon: I.reverb, size: 'mid', drop: true, menu: () => Object.entries(ROOMS).map(([k, r]) => ({ label: `${a.synth.reverb === k ? '✓ ' : ''}${r.ja}`, run: () => a.setReverb(k) })) },
        { id: 'midiOut', ja: '外部 MIDI', title: '外部の MIDI 音源で鳴らす', icon: I.midiOut, size: 'mid', run: () => tools().midiOut() },
        { id: 'pbSet', ja: '詳しい設定', title: '再生の設定', icon: I.more, size: 'mid', run: () => tools().playback() },
      ] },
      { ja: '練習', items: [
        { id: 'follow', ja: 'ついてくる', title: '弾いている場所を追いかけて、自動でページをめくる（MIDI キーボード・マイク）', icon: I.follow, size: 'big', run: () => (a.live?.follow ? a.live.followStop() : tools().followDialog(false)), on: () => !!a.live?.follow && !a.live.follow.o.strict },
        { id: 'practice', ja: '練習モード', title: '正しく弾くまで進まない。間違えた音を数えて、苦手な小節を教える（MIDI キーボード）', icon: I.practice, size: 'mid', run: () => (a.live?.follow ? a.live.followStop() : tools().followDialog(true)), on: () => !!a.live?.follow?.o.strict },
        { id: 'rampLoop', ja: 'だんだん速く', title: 'ループ再生のたびに 5% ずつ速くする（100% まで）', icon: I.ramp, size: 'mid', run: () => { a.rampLoop = !a.rampLoop; a.toast(a.rampLoop ? 'だんだん速く：オン（ループ再生のたびに 5% ずつ速くなります）' : 'だんだん速く：オフ', 2500); a.updateUI(); }, on: () => a.rampLoop },
      ] },
      { ja: '録音', items: [
        { id: 'hum', ja: '鼻歌入力', title: '歌うと楽譜になる（マイク）', icon: I.mic, size: 'big', run: () => tools().humDialog(), on: () => !!a.live?.hum },
        { id: 'hs', ja: 'リアルタイム入力', title: 'メトロノームに合わせて弾くと楽譜になる（HyperScribe）', icon: I.rec, size: 'big', run: () => (tools().rec.active ? tools().stopRec() : tools().hyperscribe()), on: () => tools().rec.active },
      ] },
    ] },
    { id: 'view', ja: '表示', groups: [
      { ja: '表示する楽譜', items: [
        { id: 'partV', ja: 'スコア／パート', title: '表示するパート', icon: I.view, size: 'big', drop: true, menu: () => [{ label: (a.viewOpts.part == null ? '✓ ' : '') + 'スコア（全パート）', run: () => a.setView({ part: null }) }, ...a.score.parts.map((p, i) => ({ label: (a.viewOpts.part === i ? '✓ ' : '') + 'パート譜：' + esc(p.name), run: () => a.setView({ part: i }) })), '-', { label: (a.viewOpts.multiRest ? '✓ ' : '') + 'パート譜で続く休みを1つにまとめる', run: () => a.setView({ multiRest: !a.viewOpts.multiRest }) }] },
        { id: 'concert', ja: '記譜音で表示', title: '移調楽器（B♭クラリネットなど）を奏者が読む高さで', icon: I.trans, size: 'mid', run: () => { a.setView({ transposed: !a.viewOpts.transposed }); a.toast(a.viewOpts.transposed ? '記譜音で表示しています' : '実音（コンサートピッチ）で表示しています'); }, on: () => a.viewOpts.transposed },
      ] },
      { ja: 'ページの並べ方', items: [
        { id: 'arr:vertical', ja: '縦に並べる', title: 'ページを縦に並べる（Word と同じ）', icon: I.vert, size: 'mid', run: () => a.setArrange('vertical'), on: () => a.viewOpts.arrange === 'vertical' },
        { id: 'arr:horizontal', ja: '横に並べる', title: 'ページを横に並べる', icon: I.horiz, size: 'mid', run: () => a.setArrange('horizontal'), on: () => a.viewOpts.arrange === 'horizontal' },
        { id: 'arr:spread', ja: '見開き', title: '2ページずつ並べる', icon: I.spread, size: 'mid', run: () => a.setArrange('spread'), on: () => a.viewOpts.arrange === 'spread' },
        { id: 'arr:scroll', ja: '1段スクロール', title: '全部の小節を1つの長い段に（Finale のスクロール表示）', icon: I.scroll, size: 'mid', run: () => a.setArrange('scroll'), on: () => a.viewOpts.arrange === 'scroll' },
      ] },
      { ja: 'ズーム', items: [
        { id: 'zoomIn', ja: '拡大', title: '拡大（Ctrl++）', icon: I.zoomIn, size: 'sm', run: () => a.view.setZoom(a.view.zoom * 1.15) },
        { id: 'zoomOut', ja: '縮小', title: '縮小（Ctrl+−）', icon: I.zoomOut, size: 'sm', run: () => a.view.setZoom(a.view.zoom / 1.15) },
        { id: 'fit', ja: '画面に合わせる', title: '画面に合わせる（Ctrl+0）', icon: I.fitW, size: 'mid', run: () => a.zoomToFit() },
        { id: 'fullS', ja: '全画面', title: '全画面で表示（もう一度押すと戻る）', icon: I.full, size: 'mid', run: () => a.toggleFullscreen(), on: () => a.isFullscreen },
        { id: 'z100', ja: '100%', title: '実際の大きさ', icon: '<span class="ticon small bold">100</span>', size: 'sm', run: () => a.view.setZoom(1) },
      ] },
      { ja: '表示するもの', items: [
        { id: 'vcolor', ja: '声部の色分け', title: '声部ごとに色を変えて表示', icon: I.color, size: 'mid', run: () => { a.state.colorVoices = !a.state.colorVoices; document.body.classList.toggle('color-voices', a.state.colorVoices); try { localStorage.setItem('kanade.colorVoices', a.state.colorVoices ? '1' : '0'); } catch (e) { /* 使えない環境 */ } a.updateUI(); }, on: () => a.state.colorVoices },
        { id: 'rangeChk', ja: '音域チェック', title: '楽器の音域から外れた音を赤く', icon: I.range, size: 'mid', run: () => { a.viewOpts.rangeCheck = !a.viewOpts.rangeCheck; a.relayout(); }, on: () => a.viewOpts.rangeCheck },
        { id: 'pianoV', ja: '画面鍵盤', title: '画面鍵盤の表示／非表示', icon: I.piano, size: 'mid', run: () => a.piano.toggle(), on: () => !a.piano.el.hidden },
        { id: 'panelV', ja: '記号パレット', title: '記号パレット（F9）', icon: I.panel, size: 'mid', run: () => a.ribbon.togglePanel(), on: () => a.ribbon.panelOpen },
        { id: 'themeV', ja: 'テーマ', title: '明るい / 暗い', icon: I.theme, size: 'mid', drop: true, menu: () => [['auto', '端末の設定に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']].map(([v, l]) => ({ label: `${(a.theme || 'auto') === v ? '✓ ' : ''}${l}`, run: () => a.setTheme(v) })) },
      ] },
    ] },
    { id: 'tools', ja: 'ツール', groups: [
      { ja: '一括編集', items: [
        { id: 'transpose', ja: '移調', title: '音程を指定して移調（調号・コードネームも）', icon: I.transpose, size: 'big', run: () => tools().transpose() },
        { id: 'x2', ja: '音価を2倍', title: '音価を2倍に（拡大）', icon: '<span class="ticon bold">×2</span>', size: 'mid', run: () => tools().massItems()[1].run() },
        { id: 'x05', ja: '音価を半分', title: '音価を半分に（縮小）', icon: '<span class="ticon bold">½</span>', size: 'mid', run: () => tools().massItems()[2].run() },
        { id: 'retro', ja: '逆行', title: '後ろから並べ直す', icon: I.retro, size: 'mid', run: () => tools().massItems()[3].run() },
        { id: 'artAll', ja: '記号をまとめて', title: 'アーティキュレーションをまとめて付ける / 外す', icon: g('articAccentAbove'), size: 'mid', run: () => tools().articAll() },
        { id: 'clearI', ja: '項目を消去', title: '項目を選んで消去', icon: I.erase, size: 'mid', run: () => tools().clearItems() },
        { id: 'enh', ja: '異名同音', title: '異名同音を書き換え（♯ ⇔ ♭）', icon: I.enh, size: 'mid', run: () => tools().massItems()[6].run() },
      ] },
      { ja: '声部と譜表', items: [
        { id: 'explode', ja: 'エクスプロード', title: '和音を下の譜表へ分ける', icon: I.explode, size: 'mid', run: () => tools().massItems().find(x => /エクスプロード/.test(x.label))?.run() },
        { id: 'implode', ja: 'インプロード', title: '複数の譜表を1段の和音にまとめる', icon: I.implode, size: 'mid', run: () => tools().massItems().find(x => /インプロード/.test(x.label))?.run() },
        { id: 'interval', ja: '音程を重ねる', title: '音程を重ねる（上に3度・5度 …）', icon: I.interval, size: 'mid', drop: true, menu: () => [...[2, 3, 4, 5, 6, 7, 8].map(n => ({ label: `上に ${n === 8 ? 'オクターブ' : n + '度'}`, run: () => a.addInterval(n, 1) })), '-', ...[2, 3, 4, 5, 6, 8].map(n => ({ label: `下に ${n === 8 ? 'オクターブ' : n + '度'}`, run: () => a.addInterval(n, -1) }))] },
        { id: 'repeatSel', ja: 'くり返し', title: 'くり返し（R）：選んだ範囲をすぐ後ろにもう一度', icon: I.repeat, size: 'mid', run: () => a.repeatSelection() },
        { id: 'swapV', ja: '声部の入れ替え', title: '声部1 と 声部2 を入れ替える', icon: I.swap, size: 'mid', run: () => a.swapVoices() },
        { id: 'slashes', ja: 'スラッシュ', title: 'スラッシュで埋める（コード譜のリズム譜）', icon: I.slashes, size: 'mid', run: () => a.fillSlashes() },
      ] },
      { ja: '作曲', items: [
        { id: 'accomp', ja: '伴奏をつける', title: 'コードネームからピアノの伴奏を書く（アルペジオ・バラード・ワルツ …）', icon: I.accomp, size: 'big', run: () => tools().accompany() },
        { id: 'guessCh', ja: 'コードを推定', title: 'メロディーから合うコードネームを推定して書き込む', icon: I.guess, size: 'mid', run: () => tools().guessChords() },
      ] },
      { ja: '書き出し', items: [
        { id: 'expXml', ja: 'MusicXML', title: 'MusicXML に書き出す（Ctrl+E）', icon: I.xml, size: 'mid', run: () => a.exportXML() },
        { id: 'expMid', ja: 'MIDI', title: 'MIDI ファイルに書き出す', icon: I.mid, size: 'mid', run: () => tools().exportMidi() },
        { id: 'expWav', ja: 'オーディオ', title: 'WAV に書き出す', icon: I.wav, size: 'mid', run: () => tools().exportWav() },
        { id: 'expPng', ja: '画像（PNG）', title: 'ページを PNG 画像に', icon: I.png, size: 'mid', run: () => a.exportImage('png') },
        { id: 'expSvg', ja: 'SVG', title: 'ページを SVG に', icon: I.svgI, size: 'mid', run: () => a.exportImage('svg') },
        { id: 'print', ja: '印刷 / PDF', title: '印刷 / PDF に保存（Ctrl+P）', icon: I.print, size: 'mid', run: () => a.print() },
      ] },
      { ja: 'チェック', items: [
        { id: 'rangeChk2', ja: '音域チェック', title: '楽器の音域から外れた音を赤く', icon: I.range, size: 'mid', run: () => { a.viewOpts.rangeCheck = !a.viewOpts.rangeCheck; a.relayout(); }, on: () => a.viewOpts.rangeCheck },
      ] },
    ] },
  ];
}

export class Ribbon {
  constructor(app) {
    this.app = app;
    app.ribbon = this; // 作っている途中でもボタンの状態（パレットが開いているか）を見られるように
    this.tabs = buildTabs(app);
    this.cmds = {};
    this.tab = 'home';
    try { const t = localStorage.getItem('kanade.tab'); if (t && this.tabs.some(x => x.id === t)) this.tab = t; } catch (e) { /* 使えない環境 */ }
    this.panelOpen = false;
    try { this.panelOpen = localStorage.getItem('kanade.panel') === '1'; } catch (e) { /* 使えない環境 */ }
    try { this.recent = JSON.parse(localStorage.getItem('kanade.recentSym') || '[]'); } catch (e) { this.recent = []; }
    this.tabsEl = document.getElementById('rbTabs');
    this.panelEl = document.getElementById('rbPanel');
    this.sideEl = document.getElementById('sidePanel');
    for (const t of this.tabs) for (const gr of t.groups) for (const it of gr.items) this.cmds[it.id] = { ...it, tab: t.ja, group: gr.ja };
    this.renderTabs();
    this.renderPanel();
    this.renderSide();
    this.panelEl.addEventListener('click', (e) => this.onClick(e));
    // マウスのホイールでリボンを横にスクロール
    this.panelEl.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.panelEl.scrollWidth > this.panelEl.clientWidth) { this.panelEl.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    this.panelEl.addEventListener('input', (e) => { if (e.target.id === 'rbSpeed') { this.app.speed = +e.target.value / 100; this.panelEl.querySelector('#rbSpeedL').textContent = e.target.value + '%'; } });
    this.panelEl.addEventListener('change', (e) => { if (e.target.id === 'rbSpeed' && this.app.player.playing) { this.app.player.stop(true); this.app.togglePlay(); } });
    document.getElementById('rbCollapse').onclick = () => this.setCollapsed(!document.body.classList.contains('rb-collapsed'));
    try { if (localStorage.getItem('kanade.rbCollapsed') === '1') document.body.classList.add('rb-collapsed'); } catch (e) { /* 使えない環境 */ }
    this.updateCollapseIcon();
    document.body.classList.toggle('panel-open', this.panelOpen);
  }

  renderTabs() {
    this.tabsEl.innerHTML = `<button class="rt file" data-tab="file" title="ファイル（ホーム・新規・開く・保存・書き出し）">ファイル</button>` +
      this.tabs.map(t => `<button class="rt" data-tab="${t.id}" role="tab">${t.ja}</button>`).join('');
    this.tabsEl.onclick = (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      if (b.dataset.tab === 'file') return this.app.home.show('backstage');
      if (document.body.classList.contains('rb-collapsed')) this.setCollapsed(false);
      this.setTab(b.dataset.tab);
    };
    this.tabsEl.ondblclick = (e) => { if (e.target.closest('[data-tab]:not(.file)')) this.setCollapsed(!document.body.classList.contains('rb-collapsed')); };
    this.markTab();
  }
  markTab() { this.tabsEl.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === this.tab)); }
  setTab(id) {
    this.tab = id;
    try { localStorage.setItem('kanade.tab', id); } catch (e) { /* 使えない環境 */ }
    this.markTab();
    this.renderPanel();
  }
  setCollapsed(c) {
    document.body.classList.toggle('rb-collapsed', c);
    try { localStorage.setItem('kanade.rbCollapsed', c ? '1' : '0'); } catch (e) { /* 使えない環境 */ }
    this.updateCollapseIcon();
    this.app.view.onResize();
  }
  updateCollapseIcon() {
    const c = document.body.classList.contains('rb-collapsed');
    const b = document.getElementById('rbCollapse');
    b.innerHTML = c ? I.expand : I.collapse;
    b.title = c ? 'リボンを表示' : 'リボンをたたむ（楽譜を広く）';
  }

  btnHtml(it) {
    if (it.special === 'mode') return `<div class="mode-switch"><button data-cmd="mode:select" class="sel" title="選択モード（Esc）">${I.select}<span>選択</span></button><button data-cmd="mode:input" class="inp" title="入力モード（N）">${I.input}<span>入力</span></button></div>`;
    if (it.special === 'voices') return `<div class="voices">${[0, 1, 2, 3].map(v => `<button class="rb sm" data-cmd="voice:${v}" data-v="${v}" title="声部${v + 1}（Alt+${v + 1}）"><span class="ticon bold">${v + 1}</span></button>`).join('')}</div>`;
    if (it.special === 'speed') return `<label class="speed" title="再生の速さ"><span>速さ</span><input type="range" id="rbSpeed" min="40" max="150" step="5" value="${Math.round((this.app.speed || 1) * 100)}"><b id="rbSpeedL">${Math.round((this.app.speed || 1) * 100)}%</b></label>`;
    const cls = `rb ${it.size || 'mid'}${it.drop ? ' drop' : ''}`;
    return `<button class="${cls}" data-cmd="${esc(it.id)}" title="${esc(it.title || it.ja)}${it.key ? `（${esc(it.key)}）` : ''}"><span class="ri">${it.icon || ''}</span>${it.size === 'sm' ? '' : `<span class="rl">${esc(it.ja)}${it.drop ? '<i class="caret"></i>' : ''}</span>`}${it.key && it.size === 'sm' ? `<span class="key">${esc(it.key.replace('Shift+', '⇧'))}</span>` : ''}</button>`;
  }
  renderPanel() {
    const t = this.tabs.find(x => x.id === this.tab) || this.tabs[0];
    this.panelEl.innerHTML = t.groups.map(gr => `<div class="rg"><div class="rg-items">${gr.items.map(it => this.btnHtml(it)).join('')}</div>${gr.ja ? `<div class="rg-l">${esc(gr.ja)}</div>` : ''}</div>`).join('');
    this.panelEl.dataset.tab = t.id;
    this.update();
  }

  onClick(e) {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    const a = this.app;
    a.synth.ensure();
    const id = b.dataset.cmd;
    const [k, v] = id.split(':');
    if (k === 'mode') return a.setMode(v);
    if (k === 'voice') return a.setVoice(+v);
    const it = this.cmds[id];
    if (!it) return;
    this.run(it, b);
  }
  run(it, anchor) {
    const a = this.app;
    if (it.gallery) return this.openGallery(it.gallery, anchor);
    if (it.menu) return a.dialogs.menu(anchor, it.menu());
    if (it.run) { it.run(a, anchor); this.update(); }
  }

  // ───────── ギャラリー（記号タブのボタンから開く、タイルの一覧） ─────────
  openGallery(catId, anchor) {
    const a = this.app;
    const c = CATEGORIES.find(x => x.id === catId);
    const items = SYMBOLS.filter(x => x.cat === catId);
    a.dialogs.closeMenu();
    const m = document.createElement('div');
    m.className = 'menu gallery';
    m.innerHTML = `<div class="gal-h">${esc(c.ja)}<span>${a.state.sel || a.state.mode === 'input' ? '選んでいるところに付きます' : '先に音符か小節を選んでください'}</span></div><div class="tiles">${tilesHtml(items)}</div>
      <div class="gal-f"><button class="lnk" data-act="panel">記号パレットで開く（F9）</button></div>`;
    document.body.appendChild(m);
    a.dialogs.placeMenu(m, anchor);
    m.onclick = (e) => {
      if (e.target.closest('[data-act="panel"]')) { a.dialogs.closeMenu(); return this.togglePanel(true, catId); }
      const t = e.target.closest('[data-sym]');
      if (!t) return;
      a.dialogs.closeMenu();
      this.applySymbol(t.dataset.sym);
    };
    a.dialogs.trackMenu(m);
  }
  applySymbol(id) {
    const s = symbolById(id);
    if (!s) return;
    this.app.synth.ensure();
    s.run(this.app);
    this.recent = [id, ...this.recent.filter(x => x !== id)].slice(0, 12);
    try { localStorage.setItem('kanade.recentSym', JSON.stringify(this.recent)); } catch (e) { /* 使えない環境 */ }
    if (this.panelOpen) this.renderRecent();
    this.update();
  }

  // ───────── 記号パレット（右のパネル） ─────────
  renderSide() {
    const el = this.sideEl;
    el.innerHTML = `<div class="sp-h"><b>記号パレット</b><button class="tb icon" id="spClose" title="閉じる（F9）">✕</button></div>
      <div class="sp-s"><input id="spSearch" type="search" placeholder="記号を検索（例：フェルマータ、trill、8va）" autocomplete="off"></div>
      <div class="sp-body" id="spBody"></div>`;
    el.querySelector('#spClose').onclick = () => this.togglePanel(false);
    const inp = el.querySelector('#spSearch');
    inp.addEventListener('input', () => this.renderSideBody(inp.value));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { inp.value = ''; this.renderSideBody(''); inp.blur(); } if (e.key === 'Enter') { const t = el.querySelector('#spBody [data-sym]'); if (t) this.applySymbol(t.dataset.sym); } e.stopPropagation(); });
    el.querySelector('#spBody').addEventListener('click', (e) => {
      const h = e.target.closest('[data-cat]');
      if (h) { h.parentElement.classList.toggle('open'); return; }
      const t = e.target.closest('[data-sym]');
      if (t) this.applySymbol(t.dataset.sym);
    });
    this.renderSideBody('');
  }
  renderSideBody(q, openCat = null) {
    const body = this.sideEl.querySelector('#spBody');
    if (q.trim()) {
      const hits = searchSymbols(q);
      body.innerHTML = hits.length ? `<div class="sp-sec open"><div class="tiles">${tilesHtml(hits)}</div></div>` : '<p class="sp-none">見つかりません。ほかのことばで探してみてください。</p>';
      return;
    }
    body.innerHTML = `<div class="sp-sec open" id="spRecent"></div>` + CATEGORIES.map(c => `<div class="sp-sec${openCat === c.id ? ' open' : ''}" data-sec="${c.id}"><button class="sp-cat" data-cat="${c.id}"><span class="ci">${iconHtml(c.icon)}</span>${esc(c.ja)}<i class="caret"></i></button><div class="tiles">${tilesHtml(SYMBOLS.filter(x => x.cat === c.id))}</div></div>`).join('');
    this.renderRecent();
    if (openCat) body.querySelector(`[data-sec="${openCat}"]`)?.scrollIntoView({ block: 'start' });
  }
  renderRecent() {
    const el = this.sideEl.querySelector('#spRecent');
    if (!el) return;
    const items = this.recent.map(symbolById).filter(Boolean);
    el.innerHTML = items.length ? `<div class="sp-sub">最近使った記号</div><div class="tiles">${tilesHtml(items)}</div>` : '';
  }
  togglePanel(open = !this.panelOpen, cat = null) {
    this.panelOpen = open;
    document.body.classList.toggle('panel-open', open);
    try { localStorage.setItem('kanade.panel', open ? '1' : '0'); } catch (e) { /* 使えない環境 */ }
    if (open) this.renderSideBody(this.sideEl.querySelector('#spSearch').value || '', cat);
    this.app.view.onResize();
    this.update();
  }

  // ───────── 検索（Ctrl+K）：操作と記号を名前で探す ─────────
  openSearch() {
    const a = this.app;
    a.dialogs.closeMenu();
    const m = document.createElement('div');
    m.className = 'menu cmdk';
    m.innerHTML = `<input id="ckIn" type="search" placeholder="やりたいことや記号の名前（例：移調、フェルマータ、改ページ、MIDI）" autocomplete="off"><div class="ck-list" id="ckList"></div>`;
    document.body.appendChild(m);
    const anchor = document.getElementById('btnSearch');
    a.dialogs.placeMenu(m, anchor, true);
    const inp = m.querySelector('#ckIn'), list = m.querySelector('#ckList');
    let hits = [], cur = 0;
    const cmdList = Object.values(this.cmds).filter(c => !c.special && c.ja);
    const extra = [
      { ja: '新しい楽譜', tab: 'ファイル', run: () => a.dialogs.newScore(), kw: 'new' }, { ja: '開く', tab: 'ファイル', run: () => a.home.show('open'), kw: 'open' },
      { ja: '保存', tab: 'ファイル', run: () => a.saveToFile(), kw: 'save' }, { ja: 'ホーム画面', tab: 'ファイル', run: () => a.home.show('home'), kw: 'home' },
      { ja: '使い方・ショートカット', tab: 'ヘルプ', run: () => a.dialogs.help(), kw: 'help' },
    ];
    // 名前がそのまま始まる > 名前に含む > 説明・分類に含む、の順に並べる（同じなら実行するボタンを記号より先に）
    const score = (name, more, q) => { const n = name.toLowerCase(); return n === q ? 4 : n.startsWith(q) ? 3 : n.includes(q) ? 2 : more.toLowerCase().includes(q) ? 1 : 0; };
    const render = () => {
      const q = inp.value.trim().toLowerCase();
      let all;
      if (q) {
        all = [
          ...extra.map(c => ({ kind: 'cmd', c, sc: score(c.ja, c.kw, q) + 0.2 })),
          ...cmdList.map(c => ({ kind: 'cmd', c, sc: score(c.ja, (c.title || '') + ' ' + c.tab + ' ' + c.group, q) - (c.gallery ? 0.5 : 0) + 0.1 })),
          ...SYMBOLS.map(s => ({ kind: 'sym', s, sc: score(s.ja, (s.kw || '') + ' ' + (CATEGORIES.find(c => c.id === s.cat)?.ja || ''), q) })),
        ].filter(h => h.sc > 0.5).sort((x, y) => y.sc - x.sc);
      } else all = this.recent.map(symbolById).filter(Boolean).map(s => ({ kind: 'sym', s }));
      hits = all.slice(0, 40);
      cur = Math.min(cur, Math.max(0, hits.length - 1));
      list.innerHTML = hits.length ? hits.map((h, i) => h.kind === 'cmd'
        ? `<button data-i="${i}" class="${i === cur ? 'cur' : ''}"><span class="ck-i">${h.c.icon || ''}</span><span class="ck-t">${esc(h.c.ja)}<small>${esc(h.c.tab)}${h.c.group ? ' › ' + esc(h.c.group) : ''}</small></span>${h.c.key ? `<kbd>${esc(h.c.key)}</kbd>` : ''}</button>`
        : `<button data-i="${i}" class="${i === cur ? 'cur' : ''}"><span class="ck-i">${iconHtml(h.s.icon)}</span><span class="ck-t">${esc(h.s.ja)}<small>記号 › ${esc(CATEGORIES.find(c => c.id === h.s.cat)?.ja || '')}</small></span>${h.s.key ? `<kbd>${esc(h.s.key)}</kbd>` : ''}</button>`).join('')
        : `<p class="sp-none">${q ? '見つかりません' : '入力すると、操作と記号の両方から探します'}</p>`;
    };
    const runHit = (h) => {
      a.dialogs.closeMenu();
      if (!h) return;
      if (h.kind === 'sym') return this.applySymbol(h.s.id);
      if (h.c.id && this.cmds[h.c.id]) {
        const tabOf = this.tabs.find(t => t.groups.some(gr => gr.items.some(x => x.id === h.c.id)));
        if (tabOf && (h.c.gallery || h.c.menu)) { this.setTab(tabOf.id); const b = this.panelEl.querySelector(`[data-cmd="${h.c.id}"]`); return this.run(h.c, b || anchor); }
        return this.run(h.c, anchor);
      }
      h.c.run();
    };
    inp.addEventListener('input', () => { cur = 0; render(); });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(hits.length - 1, cur + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); runHit(hits[cur]); }
      else if (e.key === 'Escape') { e.preventDefault(); a.dialogs.closeMenu(); }
    });
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) runHit(hits[+b.dataset.i]); });
    a.dialogs.trackMenu(m);
    render();
    setTimeout(() => inp.focus(), 20);
  }

  // ───────── ボタンの状態（オン・使えない） ─────────
  update() {
    const a = this.app, st = a.state;
    if (!a.score) return; // 起動の途中（楽譜を開く前）。開いたあとにもう一度呼ばれる
    this.panelEl.querySelectorAll('[data-cmd]').forEach(btn => {
      const id = btn.dataset.cmd;
      const [k, v] = id.split(':');
      let on = false, inputOn = false;
      if (k === 'mode') on = st.mode === v;
      else if (k === 'voice') on = st.voice === +v;
      else {
        const it = this.cmds[id];
        if (!it) return;
        on = it.on ? !!it.on() : false;
        inputOn = on && it.inputOn && st.mode === 'input';
        btn.disabled = it.dis ? !!it.dis() : false;
        if (id.startsWith('sym:art:')) on = a.selHasArtic(id.slice(8));
        if (id === 'sym:span:slur' || id === 'sym:span:cresc' || id === 'sym:span:dim') on = st.openSpan?.k === id.slice(9);
      }
      btn.classList.toggle('on', on);
      btn.classList.toggle('input', inputOn);
    });
    void INST;
  }
}
