// キーボードショートカット（iPad の Magic Keyboard / Smart Keyboard、PC 共通）
// 音価の数字は Finale の Speedy Entry と同じ：5=4分、4=8分、6=2分、7=全 …
const DUR_KEYS = { 1: '64th', 2: '32nd', 3: '16th', 4: 'eighth', 5: 'quarter', 6: 'half', 7: 'whole' };

export function bindKeys(app) {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('#modalRoot .backdrop')) { if (e.key === 'Escape') app.dialogs.close(); return; }
    // ホーム画面を開いているあいだは、楽譜の操作はしない（Esc で楽譜に戻る・Alt+N / Ctrl+O だけ）
    if (app.home?.visible) {
      if (e.key === 'Escape') { e.preventDefault(); return app.home.hide(); }
      if ((e.altKey && e.code === 'KeyN') || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n')) { e.preventDefault(); return app.dialogs.newScore(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); return app.openFileDialog(); }
      return;
    }
    if (app.dialogs.menuEl && e.key === 'Escape') { e.preventDefault(); return app.dialogs.closeMenu(); }
    if (app.tools?.rec.active && e.key !== ' ' && e.key !== 'Escape') return;
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
      // PC は .kanade ファイルへ保存（iPad は端末内）。Shift 付きは「名前を付けて保存」
      if (lk === 's') { handled(); return app.saveToFile(e.shiftKey); }
      if (lk === 'o') { handled(); return app.home.show('open'); }
      // Phase 4：検索（Word の Alt+Q / MuseScore の Ctrl+F に近い）と、小節へ移動
      if (lk === 'k') { handled(); return app.ribbon.openSearch(); }
      if (lk === 'g' || lk === 'f') { handled(); return app.gotoMeasure(); }
      if (k === 'F1') { handled(); return app.ribbon.setCollapsed(!document.body.classList.contains('rb-collapsed')); }
      // ブラウザのタブでは Ctrl+N は「新しいウィンドウ」に取られるので Alt+N も用意（下）
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
      if (k === '0') { handled(); return app.zoomToFit(); }
      return;
    }
    if (e.altKey && code === 'KeyN') { handled(); return app.dialogs.newScore(); }
    if (k === 'F1') { handled(); return app.dialogs.help(); }
    if (k === 'F9') { handled(); return app.ribbon.togglePanel(); }
    // MuseScore と同じ：{ } で小節の幅、Shift+X で符尾の向き
    if (k === '{' || k === '}') { handled(); return app.stretchMeasures(k === '}' ? 1.12 : 1 / 1.12); }
    if (e.shiftKey && !e.altKey && code === 'KeyX') { handled(); return app.flipStem(); }
    if (e.altKey && /^Digit[1-4]$/.test(code)) { handled(); return app.setVoice(+code.slice(5) - 1); }
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { handled(); return app.shiftPitch('step', k === 'ArrowUp' ? 1 : -1); }

    // ── 記号（Phase 2）。アーティキュレーションは Shift+文字（MuseScore と同じ）、線は S・<・> ──
    if (e.shiftKey && !e.altKey) {
      const art = { KeyS: 'stacc', KeyN: 'ten', KeyV: 'acc', KeyO: 'marc', KeyU: 'ferm' }[code];
      if (art) { handled(); return app.toggleArtic(art); }
    }
    if (!e.altKey && !e.shiftKey) {
      if (code === 'KeyS') { handled(); return app.addSpan('slur'); }
      if (code === 'KeyL') { handled(); return app.startLyrics(); }
      if (code === 'KeyK') { handled(); return app.startChords(); }
      if (code === 'KeyX') { handled(); return app.dialogs.marksMenu('expr', null); }
    }
    if (k === '<') { handled(); return app.addSpan('cresc'); }
    if (k === '>') { handled(); return app.addSpan('dim'); }
    if (k === ';') { handled(); return app.toggleGrace(); }
    const sel = app.state.sel;
    if (app.state.mode === 'select' && sel?.kind === 'mark') {
      if (k === 'ArrowRight' || k === 'ArrowLeft') { handled(); return app.nudgeMark(k === 'ArrowRight' ? 1 : -1, e.shiftKey ? 'start' : 'end'); }
      if (k === 'Enter') { handled(); return app.editMark(); }
    }
    if (app.state.mode === 'select' && sel?.kind === 'event' && e.shiftKey && (k === 'ArrowRight' || k === 'ArrowLeft')) { handled(); return app.extendSel(k === 'ArrowRight' ? 1 : -1); }

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
      // R：入力モードでは休符、選択モードでは「くり返し」（MuseScore と同じ）
      case 'r': case 'R': handled(); return app.state.mode === 'select' && app.state.sel ? app.repeatSelection() : app.enterRest();
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
