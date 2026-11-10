// 画面鍵盤：MIDI キーボードがなくても、指で鍵盤を押して音を入力できる
// 上の帯に音価などを置いて、リボンまで手を伸ばさなくても入力を続けられるようにしてある
import { spellMidi } from '../core/music.js';
import { glyphSvg } from './symbols.js';
import { DUR_GLYPH } from '../app.js';

const BAR_DURS = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];
const ICON = (d) => `<svg viewBox="0 0 24 24" class="pk-ico"><path d="${d}"/></svg>`;

export class Piano {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.base = 48; // 一番左の C（MIDI 番号）
    this.octaves = 3;
    el.innerHTML = `
      <div class="pk-bar">
        ${BAR_DURS.map(t => `<button data-do="dur:${t}" title="音価">${glyphSvg(DUR_GLYPH[t], 'rbg')}</button>`).join('')}
        <button data-do="dot" title="付点"><span class="dotg">${glyphSvg('metNoteQuarterUp', 'rbg')}${glyphSvg('metAugmentationDot', 'rbg')}</span></button>
        <button data-do="rest" title="休符">${glyphSvg('restQuarter', 'rbg')}</button>
        <button data-do="tie" title="タイ">${ICON('M4 10c4 6 12 6 16 0')}</button>
        <span class="pk-gap"></span>
        <button data-do="left" title="前へ">${ICON('m14 6-6 6 6 6')}</button>
        <button data-do="right" title="次へ">${ICON('m10 6 6 6-6 6')}</button>
        <button data-do="del" title="1つ前を消す">${ICON('M9 6h11v12H9l-5-6zM12 10l4 4M16 10l-4 4')}</button>
        <button data-do="undo" title="元に戻す">${ICON('M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3')}</button>
      </div>
      <div class="pk-main">
        <div class="pk-side"><button data-oct="1" title="1オクターブ上">▲</button><div class="oct"></div><button data-oct="-1" title="1オクターブ下">▼</button></div>
        <div class="pk-keys"></div>
        <div class="pk-side"><button data-chord="1" title="押しながら弾くと和音">和音</button><button data-close="1" title="閉じる">✕</button></div>
      </div>`;
    this.keysEl = el.querySelector('.pk-keys');
    el.querySelectorAll('[data-oct]').forEach(b => (b.onclick = () => { this.base = Math.max(12, Math.min(96, this.base + 12 * +b.dataset.oct)); this.build(); }));
    el.querySelector('[data-close]').onclick = () => this.toggle(false);
    const chordBtn = el.querySelector('[data-chord]');
    chordBtn.onclick = () => this.app.toggleChord();
    this.chordBtn = chordBtn;
    // 帯のボタンは押した瞬間に効かせる
    el.querySelector('.pk-bar').addEventListener('pointerdown', (e) => {
      const b = e.target.closest('[data-do]');
      if (!b) return;
      e.preventDefault();
      this.run(b.dataset.do);
    });
    // iPad Safari：鍵盤を素早くたたいても拡大・スクロールしないように（押した音は pointerdown で受ける）
    for (const type of ['touchstart', 'touchend']) this.keysEl.addEventListener(type, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    this.down = new Set();
    this.keysEl.addEventListener('pointerdown', (e) => {
      const k = e.target.closest('[data-midi]');
      if (!k) return;
      e.preventDefault();
      this.app.synth.ensure();
      const midi = +k.dataset.midi;
      const chord = this.down.size > 0; // ほかの鍵を押さえたまま → 和音
      this.down.add(midi);
      k.classList.add('down');
      const st = this.app.state;
      const rec = this.app.tools?.rec;
      const heard = this.app.liveOn(midi, 90); // 何より先に鳴らす
      if (this.app.live?.follow) this.app.live.followNote(midi, e.timeStamp);
      else if (rec?.active) { if (!rec.o?.hum) rec.noteOn(midi, 90, e.timeStamp); }
      else if (st.mode === 'input') {
        const fifths = this.app.L.attrs[st.caret.m]?.fifths || 0;
        this.app.enterPitch(spellMidi(midi, fifths), { chord, quiet: heard });
      }
      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return; // 押さえているほかの指は関係ない
        this.app.synth.noteOff(midi);
        if (rec?.active) rec.noteOff(midi, ev.timeStamp);
        this.down.delete(midi);
        k.classList.remove('down');
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    this.build();
  }

  run(what) {
    const a = this.app;
    if (what.startsWith('dur:')) return a.setDuration(what.slice(4));
    if (what === 'dot') return a.toggleDot();
    if (what === 'rest') return a.toggleRestMode();
    if (what === 'tie') return a.tie();
    if (what === 'left') return a.moveCaret(-1);
    if (what === 'right') return a.moveCaret(1);
    if (what === 'del') return a.deleteSel();
    if (what === 'undo') return a.undo();
  }

  // 帯の表示を今の状態にそろえる
  update() {
    if (this.el.hidden) return;
    const st = this.app.state, inp = st.mode === 'input';
    this.el.querySelectorAll('[data-do^="dur:"]').forEach(b => b.classList.toggle('on', st.dur.type === b.dataset.do.slice(4)));
    this.el.querySelector('[data-do="dot"]').classList.toggle('on', !!st.dur.dots);
    this.el.querySelector('[data-do="rest"]').classList.toggle('on', inp && !!st.rest);
    this.chordBtn.classList.toggle('on', !!st.chord);
  }

  build() {
    const whites = [0, 2, 4, 5, 7, 9, 11];
    const n = this.octaves * 7 + 1;
    const w = 100 / n;
    let html = '';
    let wi = 0;
    for (let midi = this.base; midi <= this.base + this.octaves * 12; midi++) {
      const pc = midi % 12;
      if (whites.includes(pc)) {
        html += `<div class="pk-w" data-midi="${midi}" style="left:${wi * w}%;width:${w}%">${pc === 0 ? 'C' + (Math.floor(midi / 12) - 1) : ''}</div>`;
        wi++;
      } else {
        html += `<div class="pk-b" data-midi="${midi}" style="left:${wi * w - w * 0.3}%;width:${w * 0.6}%"></div>`;
      }
    }
    this.keysEl.innerHTML = html;
    this.el.querySelector('.oct').textContent = `C${Math.floor(this.base / 12) - 1}〜`;
  }

  toggle(force) {
    this.el.hidden = force === undefined ? !this.el.hidden : !force;
    this.app.updateUI();
    this.app.view.onResize();
  }
}
