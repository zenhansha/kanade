// 画面下の入力パレット（Finale の Simple Entry パレットと、記号のツールをまとめたもの）
// 「音符」と「記号」の2ページ。左端のタブで切り替える（iPad で幅に収まるように）
import { SMUFL } from '../smufl.js';
import { DUR_GLYPH } from '../app.js';
const G = SMUFL.glyphs;

const DURS = [
  ['whole', '7', '全'], ['half', '6', '2分'], ['quarter', '5', '4分'], ['eighth', '4', '8分'],
  ['16th', '3', '16分'], ['32nd', '2', '32分'], ['64th', '1', '64分'],
];
const ICON = {
  select: '<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10 19z"/></svg>',
  input: '<svg viewBox="0 0 24 24"><path d="M16 3l5 5L9 20H4v-5z"/><path d="M13 6l5 5"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M20 6H9l-6 6 6 6h11z"/><path d="m16 10-4 4m0-4 4 4"/></svg>',
  piano: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M8 5v14M13 5v14M18 5v14"/><path d="M6.5 5v8M10.5 5v8M16 5v8" stroke-width="3"/></svg>',
  tie: '<svg viewBox="0 0 24 24"><path d="M3 10c4 6 14 6 18 0" /></svg>',
  slur: '<svg viewBox="0 0 24 24"><path d="M3 16C7 6 17 6 21 16" /></svg>',
  cresc: '<svg viewBox="0 0 24 24"><path d="M21 7 3 12l18 5" /></svg>',
  dim: '<svg viewBox="0 0 24 24"><path d="M3 7l18 5-18 5" /></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" class="fill"/><circle cx="12" cy="12" r="1.6" class="fill"/><circle cx="19" cy="12" r="1.6" class="fill"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M5 4v16M8 4v16" /><circle cx="12" cy="9.5" r="1.3" class="fill"/><circle cx="12" cy="14.5" r="1.3" class="fill"/><path d="M15 4h5v4" /></svg>',
};
const gl = (name, style = '') => `<span class="sm"${style ? ` style="${style}"` : ''}>${G[name].c}</span>`;

export class Palette {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.page = 'notes';
    try { if (localStorage.getItem('kanade.palPage') === 'marks') this.page = 'marks'; } catch (e) { /* 使えない環境 */ }
    const b = (act, inner, title, key = '', cls = '') => `<button class="pb ${cls}" data-act="${act}" title="${title}">${inner}${key ? `<span class="key">${key}</span>` : ''}</button>`;
    el.innerHTML = `
      <div class="mode-switch">
        <button data-act="mode:select" class="sel" title="選択モード（Esc）">${ICON.select}選択</button>
        <button data-act="mode:input" class="inp" title="入力モード（N）">${ICON.input}入力</button>
      </div>
      <div class="pal-tabs" role="tablist">
        <button data-act="page:notes" title="音符のパレット">音符</button>
        <button data-act="page:marks" title="記号のパレット（アーティキュレーション・強弱・スラー・歌詞など）">記号</button>
      </div>
      <div class="pg pn">${DURS.map(([t, k, ja]) => b('dur:' + t, `<span class="sm drop">${G[DUR_GLYPH[t]].c}</span>`, ja + '音符（' + k + '）', k)).join('')}</div>
      <div class="pg pn">
        ${b('dot', `<span class="sm" style="transform:translateY(4px)">${G.metNoteQuarterUp.c}${G.metAugmentationDot.c}</span>`, '付点（.）', '.')}
        ${b('rest', `<span class="sm">${G.restQuarter.c}</span>`, '休符（0）／選択中を休符に', '0')}
        ${b('tie', ICON.tie + '<span class="cap">タイ</span>', 'タイ（T）', 'T')}
      </div>
      <div class="pg pn">
        ${b('acc:-1', `<span class="sm lift" style="transform:translateY(-2px)">${G.accidentalFlat.c}</span>`, 'フラット（−）', '−')}
        ${b('acc:0', `<span class="sm" style="transform:translateY(2px)">${G.accidentalNatural.c}</span>`, 'ナチュラル', '')}
        ${b('acc:1', `<span class="sm" style="transform:translateY(2px)">${G.accidentalSharp.c}</span>`, 'シャープ（＋）', '+')}
      </div>
      <div class="pg pn">
        ${b('tuplet:3', '<span class="tx">3</span><span class="cap">連符</span>', '3連符（Ctrl+3）', '')}
        ${b('chord', '<span class="tx">和</span><span class="cap">和音</span>', '和音モード：タップ/入力で直前の音に重ねる（Shift でも可）', '⇧')}
      </div>
      <div class="pg pn voices" title="声部（Finale のレイヤー）。Alt+1〜4">
        ${[0, 1, 2, 3].map(v => `<button class="pb" data-act="voice:${v}" data-v="${v}" title="声部${v + 1}（Alt+${v + 1}）"><span class="tx">${v + 1}</span><span class="cap">声部</span></button>`).join('')}
      </div>
      <div class="pg pn">
        ${b('del', ICON.del + '<span class="cap">削除</span>', '削除（Delete / Backspace）')}
        ${b('piano', ICON.piano + '<span class="cap">鍵盤</span>', '画面鍵盤の表示／非表示')}
      </div>

      <div class="pg pm">
        ${b('art:stacc', gl('articStaccatoAbove', 'transform:translateY(10px)'), 'スタッカート（Shift+S）', '⇧S')}
        ${b('art:ten', gl('articTenutoAbove', 'transform:translateY(12px)'), 'テヌート（Shift+N）', '⇧N')}
        ${b('art:acc', gl('articAccentAbove', 'transform:translateY(10px)'), 'アクセント（Shift+V）', '⇧V')}
        ${b('art:marc', gl('articMarcatoAbove', 'transform:translateY(10px)'), 'マルカート（Shift+O）', '⇧O')}
        ${b('art:ferm', gl('fermataAbove', 'transform:translateY(10px)'), 'フェルマータ（Shift+U）', '⇧U')}
        ${b('menu:art', ICON.more + '<span class="cap">ほか</span>', 'そのほかのアーティキュレーション・装飾記号')}
      </div>
      <div class="pg pm">
        ${['p', 'mp', 'mf', 'f'].map(v => b('dyn:' + v, gl({ p: 'dynamicPiano', mp: 'dynamicMP', mf: 'dynamicMF', f: 'dynamicForte' }[v], 'transform:translateY(8px)'), `強弱記号 ${v}`)).join('')}
        ${b('menu:expr', ICON.more + '<span class="cap">表情</span>', 'そのほかの強弱記号・文字の表情記号（X）', 'X')}
      </div>
      <div class="pg pm">
        ${b('span:slur', ICON.slur + '<span class="cap">スラー</span>', 'スラー（S）', 'S')}
        ${b('span:cresc', ICON.cresc + '<span class="cap">cresc.</span>', 'クレッシェンド（<）', '<')}
        ${b('span:dim', ICON.dim + '<span class="cap">dim.</span>', 'デクレッシェンド（>）', '>')}
        ${b('menu:lines', `<span class="tx" style="font-style:italic">8<sup style="font-size:9px">va</sup></span><span class="cap">ほか</span>`, '8va・ペダル・トリルの波線')}
      </div>
      <div class="pg pm">
        ${b('lyrics', '<span class="tx">あ</span><span class="cap">歌詞</span>', '歌詞を入力（L）：スペースで次の音符へ、- でハイフン', 'L')}
        ${b('chordsym', '<span class="tx">C<sup style="font-size:9px">7</sup></span><span class="cap">コード</span>', 'コードネームを入力（K）', 'K')}
        ${b('grace', `<span class="sm" style="transform:translateY(4px)">${G.graceNoteAcciaccaturaStemUp.c}</span>`, '装飾音符モード（;）：入れた音が次の音符の前の装飾音になる', ';')}
        ${b('repeat', ICON.repeat + '<span class="cap">反復</span>', '反復記号・1番2番カッコ・D.S./Coda（小節に付ける）')}
      </div>
      <div class="pg pm">
        ${b('del', ICON.del + '<span class="cap">削除</span>', '選んだ記号・音符を削除（Delete）')}
      </div>`;
    el.dataset.page = this.page;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      this.app.synth.ensure();
      this.run(btn.dataset.act, btn);
    });
  }

  setPage(p) {
    this.page = p;
    this.el.dataset.page = p;
    try { localStorage.setItem('kanade.palPage', p); } catch (e) { /* 使えない環境 */ }
    this.update();
  }

  run(act, btn) {
    const a = this.app;
    const [k, v] = act.split(':');
    switch (k) {
      case 'mode': a.setMode(v); break;
      case 'page': this.setPage(v); break;
      case 'dur': a.setDuration(v); break;
      case 'dot': a.toggleDot(); break;
      case 'rest': a.toggleRestMode(); break;
      case 'tie': a.tie(); break;
      case 'acc': a.setAccidental(+v); break;
      case 'tuplet': a.makeTuplet(+v); break;
      case 'chord': a.toggleChord(); break;
      case 'voice': a.setVoice(+v); break;
      case 'del': a.deleteSel(); break;
      case 'piano': a.piano.toggle(); break;
      case 'art': a.toggleArtic(v); break;
      case 'dyn': a.addDynamic(v); break;
      case 'span': a.addSpan(v); break;
      case 'lyrics': a.startLyrics(); break;
      case 'chordsym': a.startChords(); break;
      case 'grace': a.toggleGrace(); break;
      case 'repeat': a.dialogs.repeats(); break;
      case 'menu': a.dialogs.marksMenu(v, btn); break;
    }
  }

  update() {
    const st = this.app.state;
    this.el.querySelectorAll('[data-act]').forEach(btn => {
      const [k, v] = btn.dataset.act.split(':');
      let on = false;
      if (k === 'mode') on = st.mode === v;
      else if (k === 'page') on = this.page === v;
      else if (k === 'dur') on = st.dur.type === v;
      else if (k === 'dot') on = !!st.dur.dots;
      else if (k === 'rest') on = st.mode === 'input' && st.rest;
      else if (k === 'chord') on = st.chord;
      else if (k === 'voice') on = st.voice === +v;
      else if (k === 'piano') on = !this.app.piano.el.hidden;
      else if (k === 'grace') on = !!st.grace;
      else if (k === 'span') on = st.openSpan?.k === v;
      else if (k === 'art') on = this.app.selHasArtic(v);
      btn.classList.toggle('on', on);
      btn.classList.toggle('input', on && st.mode === 'input' && (k === 'dur' || k === 'dot' || k === 'rest' || k === 'grace' || k === 'span'));
    });
  }
}
