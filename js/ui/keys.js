// キーボードショートカット（iPad の Magic Keyboard / Smart Keyboard、PC 共通）
// 音価の数字は Finale の Speedy Entry と同じ：5=4分、4=8分、6=2分、7=全 …
const DUR_KEYS = { 1: '64th', 2: '32nd', 3: '16th', 4: 'eighth', 5: 'quarter', 6: 'half', 7: 'whole' };

export function bindKeys(app) {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('#modalRoot .backdrop')) { if (e.key === 'Escape') app.dialogs.close(); return; }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const code = e.code;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };

    if (mod) {
      const lk = k.toLowerCase();
      if (lk === 'z' && !e.shiftKey) { handled(); return app.undo(); }
      if ((lk === 'z' && e.shiftKey) || lk === 'y') { handled(); return app.redo(); }
      if (lk === 'c') { handled(); return app.copy(false); }
      if (lk === 'x') { handled(); return app.copy(true); }
      if (lk === 'v') { handled(); return app.paste(); }
      if (lk === 'a') { handled(); return app.selectAll(); }
      if (lk === 's') { handled(); app.save(); return app.toast('保存しました'); }
      if (lk === 'o') { handled(); return app.dialogs.openList(); }
      if (lk === 'n') { handled(); return app.dialogs.newScore(); }
      if (lk === 'p') { handled(); return app.print(); }
      if (lk === 'e') { handled(); return app.exportXML(); }
      if (lk === 'b') { handled(); return app.dialogs.appendMeasures(); }
      if (['2', '3', '4', '5', '6', '7'].includes(k)) { handled(); return app.makeTuplet(+k); }
      if (k === 'ArrowUp') { handled(); return app.shiftPitch('octave', 1); }
      if (k === 'ArrowDown') { handled(); return app.shiftPitch('octave', -1); }
      if (k === 'ArrowRight' || k === 'ArrowLeft') { handled(); return app.moveCaret(k === 'ArrowRight' ? 1 : -1); }
      if (k === '=' || k === '+' || k === ';') { handled(); return app.view.setZoom(app.view.zoom * 1.15); }
      if (k === '-') { handled(); return app.view.setZoom(app.view.zoom / 1.15); }
      if (k === '0') { handled(); return app.view.setZoom(app.view.fitZoom()); }
      return;
    }
    if (e.altKey && /^Digit[1-4]$/.test(code)) { handled(); return app.setVoice(+code.slice(5) - 1); }
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { handled(); return app.shiftPitch('step', k === 'ArrowUp' ? 1 : -1); }

    // 音名 A〜G（Shift で和音）
    if (/^Key[A-G]$/.test(code) && !e.altKey) {
      handled();
      const step = code.slice(3);
      const pitch = app.pitchForLetter(step);
      return app.enterPitch(pitch, { chord: e.shiftKey });
    }
    if (/^Digit[1-7]$/.test(code) && !e.shiftKey) { handled(); return app.setDuration(DUR_KEYS[code.slice(5)]); }
    if (/^Numpad[1-7]$/.test(code)) { handled(); return app.setDuration(DUR_KEYS[code.slice(6)]); }
    switch (k) {
      case 'n': case 'N': handled(); return app.setMode(app.state.mode === 'input' ? 'select' : 'input');
      case 'Escape': handled(); return app.escape();
      case '.': handled(); return app.toggleDot();
      case '0': handled(); return app.state.mode === 'input' ? app.enterRest() : app.deleteSel();
      case 'r': case 'R': handled(); return app.enterRest();
      case 't': case 'T': handled(); return app.tie();
      case '+': handled(); return app.setAccidentalRelative(1);
      case '-': handled(); return app.setAccidentalRelative(-1);
      case 'ArrowUp': handled(); return app.state.mode === 'select' && !app.state.sel ? app.moveStaff(-1) : (e.shiftKey ? app.moveStaff(-1) : app.shiftPitch('semi', 1));
      case 'ArrowDown': handled(); return app.state.mode === 'select' && !app.state.sel ? app.moveStaff(1) : (e.shiftKey ? app.moveStaff(1) : app.shiftPitch('semi', -1));
      case 'ArrowRight': handled(); return app.moveCaret(1);
      case 'ArrowLeft': handled(); return app.moveCaret(-1);
      case 'Backspace': case 'Delete': handled(); return app.deleteSel();
      case ' ': handled(); return app.togglePlay();
      case 'Enter': handled(); return app.setMode('input');
      case '?': handled(); return app.dialogs.help();
    }
  });
}
