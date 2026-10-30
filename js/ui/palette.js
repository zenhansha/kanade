// 画面下の入力パレット（Finale の Simple Entry パレットに相当）
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
};

export class Palette {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    const b = (act, inner, title, key = '', cls = '') => `<button class="pb ${cls}" data-act="${act}" title="${title}">${inner}${key ? `<span class="key">${key}</span>` : ''}</button>`;
    el.innerHTML = `
      <div class="mode-switch">
        <button data-act="mode:select" class="sel" title="選択モード（Esc）">${ICON.select}選択</button>
        <button data-act="mode:input" class="inp" title="入力モード（N）">${ICON.input}入力</button>
      </div>
      <div class="pg">${DURS.map(([t, k, ja]) => b('dur:' + t, `<span class="sm drop">${G[DUR_GLYPH[t]].c}</span>`, ja + '音符（' + k + '）', k)).join('')}</div>
      <div class="pg">
        ${b('dot', `<span class="sm" style="transform:translateY(4px)">${G.metNoteQuarterUp.c}${G.metAugmentationDot.c}</span>`, '付点（.）', '.')}
        ${b('rest', `<span class="sm">${G.restQuarter.c}</span>`, '休符（0）／選択中を休符に', '0')}
        ${b('tie', ICON.tie + '<span class="cap">タイ</span>', 'タイ（T）', 'T')}
      </div>
      <div class="pg">
        ${b('acc:-1', `<span class="sm lift" style="transform:translateY(-2px)">${G.accidentalFlat.c}</span>`, 'フラット（−）', '−')}
        ${b('acc:0', `<span class="sm" style="transform:translateY(2px)">${G.accidentalNatural.c}</span>`, 'ナチュラル', '')}
        ${b('acc:1', `<span class="sm" style="transform:translateY(2px)">${G.accidentalSharp.c}</span>`, 'シャープ（＋）', '+')}
      </div>
      <div class="pg">
        ${b('tuplet:3', '<span class="tx">3</span><span class="cap">連符</span>', '3連符（Ctrl+3）', '')}
        ${b('chord', '<span class="tx">和</span><span class="cap">和音</span>', '和音モード：タップ/入力で直前の音に重ねる（Shift でも可）', '⇧')}
      </div>
      <div class="pg voices" title="声部（Finale のレイヤー）。Alt+1〜4">
        ${[0, 1, 2, 3].map(v => `<button class="pb" data-act="voice:${v}" data-v="${v}" title="声部${v + 1}（Alt+${v + 1}）"><span class="tx">${v + 1}</span><span class="cap">声部</span></button>`).join('')}
      </div>
      <div class="pg">
        ${b('del', ICON.del + '<span class="cap">削除</span>', '削除（Delete / Backspace）')}
        ${b('piano', ICON.piano + '<span class="cap">鍵盤</span>', '画面鍵盤の表示／非表示')}
      </div>`;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      this.app.synth.ensure();
      this.run(btn.dataset.act);
    });
  }

  run(act) {
    const a = this.app;
    const [k, v] = act.split(':');
    switch (k) {
      case 'mode': a.setMode(v); break;
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
    }
  }

  update() {
    const st = this.app.state;
    this.el.querySelectorAll('[data-act]').forEach(btn => {
      const [k, v] = btn.dataset.act.split(':');
      let on = false;
      if (k === 'mode') on = st.mode === v;
      else if (k === 'dur') on = st.dur.type === v;
      else if (k === 'dot') on = !!st.dur.dots;
      else if (k === 'rest') on = st.mode === 'input' && st.rest;
      else if (k === 'chord') on = st.chord;
      else if (k === 'voice') on = st.voice === +v;
      else if (k === 'piano') on = !this.app.piano.el.hidden;
      btn.classList.toggle('on', on);
      btn.classList.toggle('input', on && st.mode === 'input' && (k === 'dur' || k === 'dot' || k === 'rest'));
    });
  }
}
