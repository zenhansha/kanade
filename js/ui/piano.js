// 画面鍵盤：MIDI キーボードがなくても、指で鍵盤を押して音を入力できる
import { spellMidi } from '../core/music.js';

export class Piano {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.base = 48; // 一番左の C（MIDI 番号）
    this.octaves = 3;
    el.innerHTML = `
      <div class="pk-side"><button data-oct="1" title="1オクターブ上">▲</button><div class="oct"></div><button data-oct="-1" title="1オクターブ下">▼</button></div>
      <div class="pk-keys"></div>
      <div class="pk-side"><button data-chord="1" title="押しながら弾くと和音">和音</button><button data-close="1" title="閉じる">✕</button></div>`;
    this.keysEl = el.querySelector('.pk-keys');
    el.querySelectorAll('[data-oct]').forEach(b => (b.onclick = () => { this.base = Math.max(12, Math.min(96, this.base + 12 * +b.dataset.oct)); this.build(); }));
    el.querySelector('[data-close]').onclick = () => this.toggle(false);
    const chordBtn = el.querySelector('[data-chord]');
    chordBtn.onclick = () => this.app.toggleChord();
    this.chordBtn = chordBtn;
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
      if (rec?.active) { this.app.recSound(midi); rec.noteOn(midi, 90); }
      else if (st.mode === 'input') {
        const fifths = this.app.L.attrs[st.caret.m]?.fifths || 0;
        this.app.enterPitch(spellMidi(midi, fifths), { chord });
      } else {
        const part = this.app.score.parts[0];
        this.app.synth.play({ midi, program: part.program, dur: 0.6 });
      }
      const up = () => { if (rec?.active) rec.noteOff(midi); this.down.delete(midi); k.classList.remove('down'); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    this.build();
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
  }
}
