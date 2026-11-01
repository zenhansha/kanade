// アプリ本体：状態（楽譜・カーソル・選択・入力設定）を持ち、操作を楽譜に反映して再描画する
import { createScore, measureAttrs, INST, clefInfo, staffList } from './core/score.js';
import * as E from './core/edit.js';
import * as K from './core/marks.js';
import { History } from './core/history.js';
import { TYPE_TICKS, dottedTicks, spellMidi, midiOf, diatonic, fromDiatonic, keyAlter, pitchName, STEP_JA, TPQ, TYPE_JA } from './core/music.js';
import { layoutScore } from './engrave/layout.js';
import { ScoreView } from './ui/view.js';
import { Palette } from './ui/palette.js';
import { Piano } from './ui/piano.js';
import { Dialogs } from './ui/dialogs.js';
import { bindKeys } from './ui/keys.js';
import { Synth } from './audio/synth.js';
import { Player } from './audio/player.js';
import { MidiInput } from './midi.js';
import { storage, saveFile, canPickFiles, pickOpenFile, writeHandle, ensurePermission } from './io/storage.js';
import { serializeKanade, parseKanade, KANADE_EXT, KANADE_MIME } from './io/kanade.js';
import { exportMusicXML, importMusicXML } from './io/musicxml.js';
import { readMxl } from './io/mxl.js';
import { SMUFL } from './smufl.js';

const G = SMUFL.glyphs;
export const DUR_GLYPH = { breve: 'metNoteDoubleWhole', whole: 'metNoteWhole', half: 'metNoteHalfUp', quarter: 'metNoteQuarterUp', eighth: 'metNote8thUp', '16th': 'metNote16thUp', '32nd': 'metNote32ndUp', '64th': 'metNote64thUp' };
const HEAD_OF = { breve: 'noteheadDoubleWhole', whole: 'noteheadWhole', half: 'noteheadHalf' };

export class App {
  constructor() {
    this.state = {
      mode: 'select', caret: { p: 0, s: 0, m: 0, v: 0, t: 0 }, sel: null,
      dur: { type: 'quarter', dots: 0 }, rest: false, chord: false, voice: 0,
      lastId: null, lastPitch: { step: 'C', alter: 0, octave: 5 }, colorVoices: true,
      grace: false, openSpan: null, verse: 0,
    };
    // 表示の設定：part = パート譜で表示するパート（null ならスコア）、transposed = 移調楽器を記譜音で表示
    let tr = false;
    try { tr = localStorage.getItem('kanade.transposed') === '1'; } catch (e) { /* 使えない環境 */ }
    this.viewOpts = { part: null, transposed: tr, multiRest: true };
    this.textEd = null; // 歌詞・コードネームの入力中
    this.history = new History();
    this.synth = new Synth();
    this.player = new Player(this.synth);
    this.docId = null;
    // PC で .kanade ファイルとして保存・オープンしたとき、そのファイル（上書き保存先）
    this.fileHandle = null; this.fileName = null; this.fileDirty = false;
    this.clip = null;
    const cv = document.createElement('canvas').getContext('2d');
    this.measureText = (s, size) => { cv.font = `${size * 20}px "Times New Roman","Hiragino Mincho ProN","Yu Mincho",serif`; return cv.measureText(String(s)).width / 20; };
  }

  async init() {
    this.view = new ScoreView(this, document.getElementById('scroller'), document.getElementById('pages'));
    this.palette = new Palette(this, document.getElementById('palette'));
    this.piano = new Piano(this, document.getElementById('piano'));
    this.dialogs = new Dialogs(this);
    bindKeys(this);
    this.bindTopbar();
    this.bindPointer();
    this.midi = new MidiInput({
      onNoteOn: (n, vel, chord) => this.midiNoteOn(n, vel, chord),
      onStatus: (st) => this.midiStatus(st),
    });
    if (this.midi.supported) this.midi.connect();
    else this.midiStatus({ ok: false, reason: 'unsupported', silent: true });
    this.player.onTick = (pos) => {
      const r = this.view.showPlayLine(pos.m, pos.t);
      if (r && this.followPlay) this.view.ensureVisible(r.page, r.x, r.y + 6, 120);
    };
    this.player.onStop = () => { this.view.hideOverlay('play'); this.updateUI(); };
    document.body.classList.toggle('color-voices', this.state.colorVoices);

    // 最後に開いていた楽譜を読み込む（なければ新規）
    let opened = false;
    try {
      const last = localStorage.getItem('kanade.last');
      if (last) { const doc = await storage.get(last); if (doc) { this.openDoc(doc); opened = true; } }
    } catch (e) { console.warn(e); }
    if (!opened) {
      this.newDoc(createScore({ insts: ['piano'], title: '無題', measures: 16 }));
      setTimeout(() => this.dialogs.newScore(true), 300);
    }
    await document.fonts.load('20px Bravura').catch(() => {});
    this.view.resetZoom();
    this.relayout();
    this.updateViewButton();
    window.addEventListener('resize', () => { this.view.onResize(); this.afterZoom(); });
    this.bindDesktop();
  }

  // ───────── ドキュメント ─────────
  // opts.id = 既存の楽譜として開き直すとき、opts.handle = PC のファイル（.kanade）
  newDoc(score, opts = {}) {
    this.score = score;
    this.docId = opts.id || storage.newId();
    this.fileHandle = opts.handle || null; this.fileName = opts.handle ? opts.handle.name : null; this.fileDirty = false;
    this.history.clear();
    this.resetDocState();
    this.save();
  }
  resetDocState() {
    const st = this.state;
    st.sel = null; st.caret = { p: 0, s: 0, m: 0, v: 0, t: 0 }; st.lastId = null; st.voice = 0; st.grace = false; st.openSpan = null;
    this.viewOpts.part = null;
    if (this.textEd) this.closeEditor();
    this.setLastPitchForStaff();
    if (this.view) this.updateViewButton();
  }
  openDoc(doc) {
    this.score = doc.score;
    this.docId = doc.id;
    this.fileHandle = doc.handle || null; this.fileName = doc.fileName || null; this.fileDirty = !!doc.fileDirty;
    this.history.clear();
    this.resetDocState();
    try { localStorage.setItem('kanade.last', doc.id); } catch (e) { /* プライベートモード */ }
  }
  async save() {
    if (!this.score) return;
    clearTimeout(this.saveTimer);
    const doc = { id: this.docId, title: this.score.meta.title || '無題', updated: Date.now(), score: this.score, handle: this.fileHandle, fileName: this.fileName, fileDirty: this.fileDirty };
    try {
      await storage.put(doc);
      localStorage.setItem('kanade.last', this.docId);
    } catch (e) { console.warn('保存失敗', e); }
  }
  scheduleSave() {
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 700);
    // 端末内には自動保存されるが、PC のファイルにはまだ書いていない印（タイトルの ●）
    if (this.fileHandle && !this.fileDirty) { this.fileDirty = true; this.updateTitle(); }
  }

  // ───────── PC のファイル ─────────
  fileBaseName() {
    const base = this.fileName ? this.fileName.replace(/\.kanade$/i, '') : (this.score.meta.title || 'score');
    return base.replace(/[\\/:*?"<>|]/g, '_');
  }
  // Ctrl+S：PC では .kanade ファイルに上書き保存（初回は保存先を選ぶ）。iPad では端末内に保存。
  // saveAs = 名前を付けて保存（iPad では .kanade ファイルを書き出して「ファイル」アプリなどへ）
  async saveToFile(saveAs = false) {
    if (!canPickFiles && !saveAs) { await this.save(); return this.toast('この端末に保存しました'); }
    const blob = new Blob([serializeKanade(this.score)], { type: KANADE_MIME });
    try {
      let h = saveAs ? null : this.fileHandle;
      if (h && !(await ensurePermission(h))) h = null;
      if (h) await writeHandle(h, blob);
      else {
        h = await saveFile(this.fileBaseName() + KANADE_EXT, blob, 'kanade');
        if (!h) return;
      }
      if (typeof h === 'object') { this.fileHandle = h; this.fileName = h.name; this.fileDirty = false; }
      await this.save();
      this.updateTitle();
      this.toast(typeof h === 'object' ? `「${h.name}」に保存しました` : '.kanade ファイルを書き出しました');
    } catch (e) {
      console.error(e);
      this.toast('保存できませんでした：' + e.message, 3500);
    }
  }
  // 「開く」ボタン：PC はファイル選択ダイアログ、iPad は「ファイル」アプリから選ぶ
  async openFileDialog() {
    if (!canPickFiles) return document.getElementById('fileInput').click();
    try {
      const h = await pickOpenFile();
      if (h) await this.openFile(await h.getFile(), h);
    } catch (e) { console.error(e); this.toast('開けませんでした：' + e.message, 3500); }
  }

  // ───────── 描画 ─────────
  relayout() {
    const t0 = performance.now();
    const vo = this.viewOpts;
    if (vo.part != null && !this.score.parts[vo.part]) vo.part = null;
    this.L = layoutScore(this.score, { measureText: this.measureText, parts: vo.part != null ? [vo.part] : null, transposed: vo.transposed, multiRest: vo.multiRest });
    this.view.render(this.L);
    this.layoutMs = performance.now() - t0;
    this.refreshOverlays();
    this.updateUI();
  }
  afterZoom() { this.refreshOverlays(); this.updateUI(); }

  refreshOverlays() {
    const st = this.state;
    if (st.mode === 'input') {
      const g = st.rest ? G[{ breve: 'restDoubleWhole', whole: 'restWhole', half: 'restHalf', quarter: 'restQuarter', eighth: 'rest8th', '16th': 'rest16th', '32nd': 'rest32nd', '64th': 'rest64th' }[st.dur.type]].c : G[DUR_GLYPH[st.dur.type]].c;
      this.view.showCaret(st.caret, g + (st.dur.dots ? G.metAugmentationDot.c : ''));
    } else this.view.hideOverlay('caret');
    const ids = [];
    if (st.sel?.kind === 'event') ids.push(...(st.sel.to ? this.eventSpanIds(st.sel.id, st.sel.to) : [st.sel.id]));
    if (st.sel?.kind === 'mark') ids.push(st.sel.key);
    if (st.sel?.kind === 'range') {
      this.view.showRange(st.sel);
      ids.push(...E.rangeEventIds(this.score, this.rangeStaves(st.sel)));
    } else this.view.showRange(null);
    this.view.highlight(ids);
  }

  rangeStaves(sel) {
    const rows = this.L.rows;
    const staves = [];
    for (let r = sel.r1; r <= sel.r2; r++) staves.push([rows[r].p, rows[r].s]);
    return { m1: sel.m1, m2: sel.m2, staves };
  }

  updateUI() {
    const st = this.state;
    this.palette.update();
    document.getElementById('btnUndo').disabled = !this.history.canUndo;
    document.getElementById('btnRedo').disabled = !this.history.canRedo;
    document.body.classList.toggle('mode-input', st.mode === 'input');
    if (st.mode === 'input') { this.view.pagesEl.style.cursor = ''; this.view.hover(null); }
    this.updateTitle();
    document.getElementById('zoomLabel').textContent = Math.round(this.view.zoom * 100) + '%';
    const A = this.L ? this.L.attrs : measureAttrs(this.score);
    const m = this.focusMeasure();
    document.getElementById('tempoLabel').textContent = '= ' + (A[m] ? A[m].bpm : 100);
    document.getElementById('btnPlay').classList.toggle('on', this.player.playing);
    // ステータス
    const parts = [];
    const part = this.score.parts[st.mode === 'input' ? st.caret.p : (this.selLoc()?.p ?? 0)];
    if (st.mode === 'input') {
      const c = st.caret;
      const beat = A[c.m] ? 1 + c.t / ((TPQ * 4) / A[c.m].time.beatType) : 1;
      parts.push(`入力モード · ${part?.name || ''} · 第${c.m + 1}小節 ${+beat.toFixed(2)}拍目 · 声部${st.voice + 1}`);
      parts.push(`${TYPE_JA[st.dur.type]}${st.dur.dots ? '（付点）' : ''}${st.rest ? '・休符' : ''}${st.chord ? '・和音' : ''}${st.grace ? '・装飾音符' : ''}${st.openSpan ? '・' + K.SPANS[st.openSpan.k].ja.replace(/（.*/, '') + 'を入力中' : ''}`);
    } else if (st.sel?.kind === 'event' && st.sel.to) {
      parts.push(`選択：音符 ${this.eventSpanIds(st.sel.id, st.sel.to).length} 個（Shift+←→ で広げる）· S でスラー、< > で松葉`);
    } else if (st.sel?.kind === 'event') {
      const f = E.findEvent(this.score, st.sel.id);
      if (f) {
        const desc = f.ev.rest ? '休符' : f.ev.notes.map(n => `${pitchName(n)}（${STEP_JA[n.step]}）`).join(' + ');
        parts.push(`選択：${part?.name || ''} 第${f.m + 1}小節 · ${desc} · ${TYPE_JA[f.ev.type]}${f.ev.dots ? '（付点）' : ''}`);
      }
    } else if (st.sel?.kind === 'mark') {
      const isSpan = st.sel.ref.type === 'span';
      parts.push(`選択：${this.markName(st.sel.ref)}${isSpan ? ' · ←→ で終わり、Shift+←→ で始まりを動かす' : ' · ダブルクリック（Enter）で編集'} · Delete で削除`);
    } else if (st.sel?.kind === 'range') {
      parts.push(`範囲選択：第${st.sel.m1 + 1}〜${st.sel.m2 + 1}小節`);
    } else parts.push('選択モード');
    document.getElementById('status').textContent = parts.join('　');
    const mouse = matchMedia('(pointer: fine)').matches;
    document.getElementById('hint').textContent = st.mode === 'input'
      ? `五線を${mouse ? 'クリック' : 'タップ'}／A〜G キー／MIDI鍵盤で入力 · Esc で選択モード`
      : mouse ? '音符をクリックで選択 · ドラッグで範囲選択 · 右クリックでメニュー · ダブルクリックで入力'
        : '音符をタップで選択 · 上下ドラッグで音高 · 小節の空きをタップで小節選択 · N で入力';
  }
  updateTitle() {
    const t = this.score.meta.title || '無題';
    const mark = this.fileDirty ? '● ' : '';
    const el = document.getElementById('docTitle');
    el.textContent = mark + t;
    el.title = this.fileName ? `ファイル：${this.fileName}${this.fileDirty ? '（未保存の変更あり · Ctrl+S で保存）' : ''}` : 'クリックでスコア情報を編集';
    document.title = mark + t + ' — KANADE';
  }

  focusMeasure() {
    const st = this.state;
    if (st.mode === 'input') return st.caret.m;
    if (st.sel?.kind === 'range') return st.sel.m1;
    if (st.sel?.kind === 'event') return this.selLoc()?.m ?? 0;
    return 0;
  }
  selLoc() {
    const s = this.state.sel;
    if (!s) return null;
    if (s.kind === 'event') { const f = E.findEvent(this.score, s.id); return f ? { p: f.p, s: f.s, m: f.m, v: f.v, t: f.t } : null; }
    if (s.kind === 'range') { const row = this.L.rows[s.r1]; return { p: row.p, s: row.s, m: s.m1, v: 0, t: 0 }; }
    if (s.kind === 'mark') {
      const r = s.ref;
      if (r.type === 'lyr') { const f = E.findEvent(this.score, r.id); return f ? { p: f.p, s: f.s, m: f.m, v: f.v, t: f.t } : null; }
      if (r.type === 'meas') return { p: this.L.rows[0].p, s: this.L.rows[0].s, m: r.m, v: 0, t: 0 };
      const sm = this.score.parts[r.p]?.staves[r.s]?.measures[r.m];
      const t = r.type === 'dir' ? sm?.dirs?.[r.idx]?.t : sm?.spans?.[r.idx]?.t;
      return { p: r.p, s: r.s, m: r.m, v: 0, t: t || 0 };
    }
    return null;
  }

  // ───────── 編集の共通処理 ─────────
  edit(label, fn) {
    const before = JSON.stringify({ score: this.score, caret: this.state.caret, sel: this.state.sel });
    let r;
    try { r = fn(); } catch (e) { console.error(e); this.toast('エラー：' + e.message); this.score = JSON.parse(before).score; this.relayout(); return; }
    if (r === false) return r;
    this.history.undoStack.push({ json: before, label });
    if (this.history.undoStack.length > this.history.limit) this.history.undoStack.shift();
    this.history.redoStack.length = 0;
    this.relayout();
    this.scheduleSave();
    return r;
  }
  undo() {
    const r = this.history.undo({ score: this.score, caret: this.state.caret, sel: this.state.sel });
    if (!r) return;
    this.score = r.score; this.state.caret = r.caret; this.state.sel = r.sel;
    this.relayout(); this.scheduleSave(); this.toast('元に戻す' + (r.label ? '：' + r.label : ''));
  }
  redo() {
    const r = this.history.redo({ score: this.score, caret: this.state.caret, sel: this.state.sel });
    if (!r) return;
    this.score = r.score; this.state.caret = r.caret; this.state.sel = r.sel;
    this.relayout(); this.scheduleSave(); this.toast('やり直し' + (r.label ? '：' + r.label : ''));
  }

  toast(msg, ms = 1600) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ───────── モード・入力設定 ─────────
  setMode(mode) {
    const st = this.state;
    if (mode === st.mode) return;
    if (mode === 'input') {
      const loc = this.selLoc();
      if (loc) st.caret = { ...loc, v: st.voice };
      st.caret.v = st.voice;
      st.sel = null;
      this.setLastPitchForStaff();
    } else {
      this.closeOpenSpan();
      st.grace = false;
      if (st.lastId && E.findEvent(this.score, st.lastId)) st.sel = { kind: 'event', id: st.lastId, noteIndex: null };
    }
    if (this.textEd) this.closeEditor();
    st.mode = mode;
    this.refreshOverlays(); this.updateUI();
    if (mode === 'input') this.revealCaret();
  }
  revealCaret() {
    const r = this.view.showCaret(this.state.caret, null);
    if (r) this.view.ensureVisible(r.page, r.x, r.y + 2);
    this.refreshOverlays();
  }

  setDuration(type) {
    const st = this.state;
    st.dur.type = type;
    if (st.mode === 'select' && st.sel?.kind === 'event') {
      const id = st.sel.id;
      this.edit('音価の変更', () => { const r = E.setDuration(this.score, id, type, st.dur.dots); if (!r) return false; st.sel = { kind: 'event', id: r.ids[0], noteIndex: null }; });
    }
    this.refreshOverlays(); this.updateUI();
  }
  toggleDot() {
    const st = this.state;
    if (st.mode === 'select' && st.sel?.kind === 'event') {
      const f = E.findEvent(this.score, st.sel.id);
      if (f && !f.ev.mr) {
        const dots = f.ev.dots ? 0 : 1;
        this.edit('付点', () => { const r = E.setDuration(this.score, f.ev.id, f.ev.type, dots); if (!r) return false; st.sel = { kind: 'event', id: r.ids[0], noteIndex: null }; });
        st.dur = { type: f.ev.type, dots };
      }
    } else st.dur.dots = st.dur.dots ? 0 : 1;
    this.refreshOverlays(); this.updateUI();
  }
  toggleRestMode() {
    const st = this.state;
    if (st.mode === 'select') return this.deleteSel();
    st.rest = !st.rest;
    this.refreshOverlays(); this.updateUI();
  }
  toggleChord() { this.state.chord = !this.state.chord; this.updateUI(); }
  setVoice(v) {
    const st = this.state;
    st.voice = v;
    st.caret = { ...st.caret, v };
    // 声部2〜4 でカーソルが音符の途中に来たときは、その小節の頭からにする
    const voice = E.getVoice(this.score, st.caret.p, st.caret.s, st.caret.m, v);
    if (voice && !E.positions(voice).some(x => x.start === st.caret.t)) st.caret.t = 0;
    this.refreshOverlays(); this.updateUI();
    this.toast(`声部 ${v + 1}（レイヤー${v + 1}）`);
  }

  // ───────── 音の入力 ─────────
  // 音名キー：画面に見えている譜（記譜音表示なら記譜音）で一番近い高さを選び、楽譜に入れる実音にして返す
  pitchForLetter(step) {
    const loc = this.state.mode === 'input' ? this.state.caret : (this.selLoc() || this.state.caret);
    const tr = this.transFor(loc.p);
    const lp = tr ? K.toWritten(this.state.lastPitch, tr) : this.state.lastPitch;
    const ld = diatonic(lp);
    let best = null;
    for (let o = lp.octave - 1; o <= lp.octave + 1; o++) {
      const d = Math.abs(diatonic({ step, octave: o }) - ld);
      if (!best || d < best.d) best = { d, o };
    }
    const fifths = this.displayFifths(loc.p, loc.s, loc.m);
    return this.concertOf({ step, alter: keyAlter(fifths, step), octave: best.o }, loc.p);
  }
  // 記譜音表示のときの移調（表示していない・移調楽器でなければ null）
  transFor(p) { return this.viewOpts.transposed ? K.partTrans(this.score.parts[p] || {}) : null; }
  concertOf(pitch, p) { const tr = this.transFor(p); return tr ? K.toConcert(pitch, tr) : pitch; }
  displayFifths(p, s, m) {
    const r = this.L.rows.findIndex(x => x.p === p && x.s === s);
    return r >= 0 && this.L.fifthsAt ? this.L.fifthsAt(r, m) : (this.L.attrs[m]?.fifths || 0);
  }

  setLastPitchForStaff() {
    const c = this.state.caret;
    const st = this.score?.parts[c.p]?.staves[c.s];
    if (!st) return;
    // 第3線より少し下を基準にする（ト音記号で C を押すと真ん中のド C4 になる）
    const ci = clefInfo(st.clef);
    this.state.lastPitch = fromDiatonic(ci.mid - 3);
  }

  audition(pitches, dur = 0.45) {
    const part = this.score.parts[this.state.mode === 'input' ? this.state.caret.p : (this.selLoc()?.p ?? 0)] || this.score.parts[0];
    const inst = INST[part.inst] || {};
    this.synth.loadSamples(inst.sf);
    for (const p of pitches) this.synth.play({ midi: midiOf(p) + (inst.oct || 0), program: part.program, sf: inst.sf, dur, vel: 0.7 });
  }

  // pitch を入力する（キー・MIDI・画面鍵盤・タップ共通）
  enterPitch(pitch, opts = {}) {
    const st = this.state;
    if (st.mode !== 'input') this.setMode('input');
    const chord = opts.chord || st.chord;
    // 装飾音符モード：カーソルの音符の前に付ける（カーソルは進まない）
    if (st.grace && !st.rest) {
      const loc = opts.at || st.caret;
      const type = ['eighth', '16th', '32nd'].includes(st.dur.type) ? st.dur.type : 'eighth';
      this.edit('装飾音符', () => { if (!K.addGrace(this.score, loc, pitch, { type, slash: type === 'eighth', chord })) return false; });
      st.lastPitch = pitch; this.audition([pitch], 0.2);
      this.refreshOverlays(); this.revealCaret();
      return;
    }
    if (chord && st.lastId && E.findEvent(this.score, st.lastId)) {
      const id = st.lastId;
      this.edit('和音に追加', () => E.addToChord(this.score, id, pitch));
    } else {
      const loc = opts.at || st.caret;
      let r;
      this.edit('音符の入力', () => {
        r = E.enterNote(this.score, loc, { type: st.dur.type, dots: st.dur.dots, pitches: st.rest ? null : [pitch] });
        st.caret = r.next;
        st.lastId = r.ids[0];
        this.extendOpenSpan();
      });
    }
    if (!st.rest) { st.lastPitch = pitch; this.audition([pitch]); }
    this.refreshOverlays();
    this.revealCaret();
  }
  enterRest(opts = {}) {
    const st = this.state;
    if (st.mode !== 'input') this.setMode('input');
    const loc = opts.at || st.caret;
    this.edit('休符の入力', () => {
      const r = E.enterNote(this.score, loc, { type: st.dur.type, dots: st.dur.dots, pitches: null });
      st.caret = r.next; st.lastId = r.ids[0];
    });
    this.revealCaret();
  }

  // タイ：入力モードでは「直前の音と同じ高さの音を今の音価で足してタイでつなぐ」
  tie() {
    const st = this.state;
    if (st.mode === 'input') {
      const f = st.lastId && E.findEvent(this.score, st.lastId);
      if (!f || f.ev.rest) return this.toast('タイをつける音符がありません');
      const pitches = f.ev.notes.map(n => ({ step: n.step, alter: n.alter, octave: n.octave }));
      this.edit('タイ', () => {
        const ff = E.findEvent(this.score, st.lastId);
        ff.ev.notes.forEach(n => (n.tie = true));
        const r = E.enterNote(this.score, st.caret, { type: st.dur.type, dots: st.dur.dots, pitches });
        st.caret = r.next; st.lastId = r.ids[r.ids.length - 1];
      });
      this.revealCaret();
    } else if (st.sel?.kind === 'event') {
      const id = st.sel.id;
      this.edit('タイ', () => E.toggleTie(this.score, id));
    }
  }

  // 操作の対象になる音符（選択モード：選択中 / 入力モード：直前に入れた音）
  targetId() {
    const st = this.state;
    if (st.mode === 'select' && st.sel?.kind === 'event') return st.sel.id;
    if (st.mode === 'input' && st.lastId && E.findEvent(this.score, st.lastId)) return st.lastId;
    return null;
  }
  fifthsAt(id) { const f = E.findEvent(this.score, id); return f ? this.L.attrs[f.m].fifths : 0; }

  setAccidental(alter) {
    const st = this.state;
    if (st.sel?.kind === 'range' && st.mode === 'select') return;
    const id = this.targetId();
    if (!id) return this.toast('先に音符を選ぶか入力してください');
    const ni = st.mode === 'select' ? st.sel.noteIndex ?? null : null;
    this.edit('臨時記号', () => E.setAlter(this.score, id, alter, ni));
    const f = E.findEvent(this.score, id);
    if (f && !f.ev.rest) { const ps = ni == null ? f.ev.notes : [f.ev.notes.find((n, i) => i === ni) || f.ev.notes[0]]; this.audition(ps); st.lastPitch = ps[ps.length - 1]; }
  }

  // + / - キー：半音上げ下げ（Finale と同じ）
  setAccidentalRelative(d) { this.shiftPitch('semi', d); }

  shiftPitch(kind, amount) {
    const st = this.state;
    if (st.mode === 'select' && st.sel?.kind === 'range') {
      const semis = kind === 'octave' ? 12 * amount : amount;
      const rg = this.rangeStaves(st.sel);
      this.edit('移調', () => E.transposeRange(this.score, rg, semis, this.L.attrs[st.sel.m1].fifths));
      return;
    }
    const id = this.targetId();
    if (!id) return;
    const ni = st.mode === 'select' ? st.sel.noteIndex ?? null : null;
    this.edit('音高の変更', () => {
      if (kind === 'semi') E.shiftSemis(this.score, id, amount, this.fifthsAt(id), ni);
      else if (kind === 'octave') E.shiftDiatonic(this.score, id, 7 * amount, ni);
      else E.shiftDiatonic(this.score, id, amount, ni);
    });
    const f = E.findEvent(this.score, id);
    if (f && !f.ev.rest) { this.audition(f.ev.notes); st.lastPitch = f.ev.notes[f.ev.notes.length - 1]; }
  }

  deleteSel() {
    const st = this.state;
    if (st.mode === 'input' && st.grace) {
      // 装飾音符モードの Backspace：カーソルの音符の装飾音を1つ消す
      const at = E.eventAt(this.score, st.caret) || E.eventCovering(this.score, st.caret);
      if (at?.ev.grace) this.edit('装飾音符の削除', () => K.removeLastGrace(this.score, at.ev.id));
      return;
    }
    if (st.sel?.kind === 'mark' && st.mode === 'select') return this.deleteMark();
    if (st.mode === 'input') {
      // 入力モードの Backspace：1つ前の音符を消してカーソルを戻す
      const prev = E.caretPrev(this.score, st.caret);
      const at = E.eventAt(this.score, prev);
      if (at) this.edit('削除', () => { E.toRest(this.score, at.ev.id); st.caret = prev; });
      this.refreshOverlays(); this.revealCaret();
      return;
    }
    if (st.sel?.kind === 'range') {
      const rg = this.rangeStaves(st.sel);
      this.edit('小節を空にする', () => E.clearRange(this.score, rg));
    } else if (st.sel?.kind === 'event') {
      const id = st.sel.id;
      const f = E.findEvent(this.score, id);
      if (!f) return;
      if (f.ev.notes.length > 1 && st.sel.noteIndex != null) this.edit('和音から削除', () => E.removeNote(this.score, id, st.sel.noteIndex));
      else this.edit('休符にする', () => { E.toRest(this.score, id); });
      if (!E.findEvent(this.score, id)) st.sel = null;
      this.refreshOverlays(); this.updateUI();
    }
  }

  makeTuplet(n) {
    const st = this.state;
    let loc = st.mode === 'input' ? st.caret : this.selLoc();
    if (!loc) return this.toast('連符を入れる場所を選んでください');
    if (st.mode === 'select' && st.sel?.kind === 'event') {
      const f = E.findEvent(this.score, st.sel.id);
      // 選択した音符の長さを n 等分する（4分音符を選んで3連 → 8分3連）
      const base = { whole: 'half', half: 'quarter', quarter: 'eighth', eighth: '16th', '16th': '32nd', '32nd': '64th' }[f.ev.type] || 'eighth';
      const normal = { 2: 3, 3: 2, 4: 3, 5: 4, 6: 4, 7: 4 }[n];
      const type = TYPE_TICKS[base] * normal === E.positions([f.ev])[0].end ? base : st.dur.type;
      let id;
      this.edit(n + '連符', () => { id = E.makeTuplet(this.score, loc, n, type); if (!id) return false; });
      if (!id) return this.toast('小節に入りきりません');
      st.mode = 'input'; st.caret = { ...loc }; st.sel = null; st.dur.type = type;
    } else {
      let id;
      this.edit(n + '連符', () => { id = E.makeTuplet(this.score, loc, n, st.dur.type); if (!id) return false; });
      if (!id) return this.toast('小節に入りきりません');
    }
    this.refreshOverlays(); this.updateUI();
    this.toast(`${n}連符：続けて音を入力してください`);
  }

  // ───────── Phase 2：記号（アーティキュレーション・強弱・線・歌詞・コードネーム・装飾音） ─────────
  // 選んでいる音符（範囲なら全部）の id。入力モードでは直前に入れた音符
  selIds() {
    const st = this.state, s = st.sel;
    if (st.mode === 'input') return st.lastId && E.findEvent(this.score, st.lastId) ? [st.lastId] : [];
    if (!s) return [];
    if (s.kind === 'event') return s.to ? this.eventSpanIds(s.id, s.to) : [s.id];
    if (s.kind === 'range') return E.rangeEventIds(this.score, this.rangeStaves(s));
    return [];
  }
  // 同じ声部の a から b までの音符（順番が逆でもよい）
  eventSpanIds(a, b) {
    let fa = E.findEvent(this.score, a), fb = E.findEvent(this.score, b);
    if (!fa || !fb) return fa ? [a] : [];
    const key = (f) => f.m * 1e7 + f.t;
    if (key(fb) < key(fa)) [fa, fb] = [fb, fa];
    const ids = [];
    let cur = fa, guard = 0;
    while (cur && guard++ < 5000 && key(cur) <= key(fb)) { ids.push(cur.ev.id); if (cur.ev.id === fb.ev.id) break; cur = E.nextEvent(this.score, cur); }
    return ids;
  }
  // Shift+←→：音符の選択を1つずつ広げる・縮める
  extendSel(dir) {
    const st = this.state;
    if (st.sel?.kind !== 'event') return;
    const f = E.findEvent(this.score, st.sel.to || st.sel.id);
    const nx = f && (dir > 0 ? E.nextEvent(this.score, f) : E.prevEvent(this.score, f));
    if (!nx) return;
    st.sel = { ...st.sel, to: nx.ev.id === st.sel.id ? undefined : nx.ev.id };
    if (!st.sel.to) delete st.sel.to;
    this.refreshOverlays(); this.updateUI();
    const g = this.L.evGeom[nx.ev.id];
    if (g) this.view.ensureVisible(g.page, g.x, g.oy + 2);
  }
  selHasArtic(key) {
    const st = this.state;
    if (st.sel?.kind === 'range') return false;
    const ids = this.selIds();
    return ids.length > 0 && ids.length < 200 && ids.every(id => E.findEvent(this.score, id)?.ev.art?.includes(key));
  }
  toggleArtic(key) {
    const ids = this.selIds();
    if (!ids.length) return this.toast('先に音符を選ぶか入力してください');
    let on = null;
    this.edit(K.ARTICS[key].ja, () => { on = K.toggleArtic(this.score, ids, key); if (on === null) return false; });
    if (on === null) return this.toast('休符には付けられません');
    this.toast(`${K.ARTICS[key].ja}を${on ? '付けました' : '外しました'}`);
  }
  // 強弱・文字を付ける位置（選んだ音符・範囲の先頭・入力モードなら直前の音）
  markAnchor() {
    const st = this.state;
    const at = (f) => f && { p: f.p, s: f.s, m: f.m, t: f.t, v: f.v };
    if (st.mode === 'input') return at(st.lastId && E.findEvent(this.score, st.lastId)) || { ...st.caret };
    if (st.sel?.kind === 'event') return at(E.findEvent(this.score, this.selIds()[0]));
    if (st.sel?.kind === 'range') { const row = this.L.rows[st.sel.r1]; return { p: row.p, s: row.s, m: st.sel.m1, t: 0, v: 0 }; }
    return null;
  }
  addDynamic(v) {
    const a = this.markAnchor();
    if (!a) return this.toast('強弱記号を付ける音符を選んでください');
    this.edit('強弱記号', () => K.addDir(this.score, a.p, a.s, a.m, { t: a.t, k: 'dyn', v }));
    this.toast(`${v} を付けました`);
  }
  addTextDir(text, pos = 'above', it = true) {
    const a = this.markAnchor();
    if (!a) return this.toast('文字を付ける音符を選んでください');
    if (!text) return;
    this.edit('文字の表情記号', () => K.addDir(this.score, a.p, a.s, a.m, { t: a.t, k: 'text', text, pos, it }));
  }

  // 線（スラー・松葉・8va・ペダル・トリル）。選んだ音符の範囲に付ける。入力モードでは「入れながら伸ばす」
  addSpan(k) {
    const st = this.state;
    const name = K.SPANS[k].ja;
    if (st.mode === 'input') return this.toggleOpenSpan(k);
    const s = st.sel;
    if (!s || s.kind === 'mark') return this.toast(`${name}を付ける音符を選んでください（Shift+クリックで範囲）`);
    const pairs = [];
    if (s.kind === 'event') {
      const ids = s.to ? this.eventSpanIds(s.id, s.to) : [s.id];
      const fa = E.findEvent(this.score, ids[0]);
      let fb = E.findEvent(this.score, ids[ids.length - 1]);
      if (ids.length === 1) { // 1つだけなら次の音符まで
        let nx = E.nextEvent(this.score, fa);
        while (nx && nx.ev.rest) nx = E.nextEvent(this.score, nx);
        if (nx) fb = nx;
      }
      pairs.push({ p: fa.p, s: fa.s, v: fa.v, a: { m: fa.m, t: fa.t }, b: { m: fb.m, t: fb.t } });
    } else if (s.kind === 'range') {
      for (let r = s.r1; r <= s.r2; r++) {
        const row = this.L.rows[r];
        const on = K.voiceOnsets(this.score, row.p, row.s, 0).filter(o => o.m >= s.m1 && o.m <= s.m2);
        if (on.length) pairs.push({ p: row.p, s: row.s, v: 0, a: on[0], b: on[on.length - 1] });
      }
      if (!pairs.length) return this.toast('範囲に音符がありません');
    }
    let made = null;
    this.edit(name, () => { for (const x of pairs) { const idx = K.addSpan(this.score, x.p, x.s, x.v, x.a, x.b, k); made = { p: x.p, s: x.s, m: Math.min(x.a.m, x.b.m), idx }; } });
    if (made && pairs.length === 1) this.selectMark(`s:${made.p}:${made.s}:${made.m}:${made.idx}`);
    this.toast(`${name}：←→ で終わり、Shift+←→ で始まりを動かせます`, 2600);
  }
  toggleOpenSpan(k) {
    const st = this.state;
    const name = K.SPANS[k].ja;
    if (st.openSpan) { const was = st.openSpan.k; this.closeOpenSpan(); if (was === k) { this.toast(name.replace(/（.*/, '') + 'を終わりました'); return this.updateUI(); } }
    const f = st.lastId && E.findEvent(this.score, st.lastId);
    const a = f ? { m: f.m, t: f.t } : { m: st.caret.m, t: st.caret.t };
    const p = f ? f.p : st.caret.p, s = f ? f.s : st.caret.s, v = f ? f.v : st.caret.v;
    let idx;
    this.edit(name, () => { idx = K.addSpan(this.score, p, s, v, a, a, k); });
    st.openSpan = { k, p, s, m: a.m, idx };
    this.toast(`${name.replace(/（.*/, '')}：続けて音を入れると伸びます。もう一度押すと終わり`, 2800);
    this.updateUI();
  }
  extendOpenSpan() {
    const st = this.state, o = st.openSpan;
    if (!o) return;
    const sp = this.score.parts[o.p]?.staves[o.s]?.measures[o.m]?.spans?.[o.idx];
    const f = st.lastId && E.findEvent(this.score, st.lastId);
    if (!sp || !f || f.p !== o.p || f.s !== o.s) return;
    if (f.m < o.m || (f.m === o.m && f.t < sp.t)) return;
    sp.dm = f.m - o.m; sp.t2 = f.t;
  }
  closeOpenSpan() {
    const st = this.state, o = st.openSpan;
    st.openSpan = null;
    if (!o) return;
    const sp = this.score.parts[o.p]?.staves[o.s]?.measures[o.m]?.spans?.[o.idx];
    // 1つの音符だけのスラーは意味がないので消す
    if (sp && sp.k === 'slur' && sp.dm === 0 && sp.t2 === sp.t) { K.removeSpan(this.score, o.p, o.s, o.m, o.idx); this.relayout(); this.scheduleSave(); }
  }

  toggleGrace() {
    const st = this.state;
    if (!st.grace && st.mode !== 'input') this.setMode('input');
    st.grace = !st.grace;
    this.toast(st.grace ? '装飾音符：入れた音はカーソルの音符の前に付きます（もう一度 ; で戻る）' : '装飾音符モードを終わりました', 2800);
    this.refreshOverlays(); this.updateUI();
  }

  // ── 記号の選択・削除・編集 ──
  selectMark(key) {
    const mk = this.L.marks.find(m => m.key === key);
    if (!mk) return;
    this.state.sel = { kind: 'mark', key, ref: mk.ref };
    this.view.hover(null);
    this.refreshOverlays(); this.updateUI();
  }
  markName(ref) {
    if (ref.type === 'lyr') { const f = E.findEvent(this.score, ref.id); return `歌詞「${f?.ev.lyr?.[ref.verse]?.t || ''}」（${ref.verse + 1}番）`; }
    if (ref.type === 'meas') return { ending: 'カッコ（1番・2番）', segno: 'セーニョ', coda: 'コーダ', fine: 'Fine', toCoda: 'To Coda', jump: K.JUMPS[this.score.measures[ref.m]?.jump]?.text || 'D.C./D.S.' }[ref.what] + `（第${ref.m + 1}小節）`;
    const sm = this.score.parts[ref.p]?.staves[ref.s]?.measures[ref.m];
    if (ref.type === 'span') { const sp = sm?.spans?.[ref.idx]; return sp ? K.SPANS[sp.k].ja.replace(/（.*/, '') + `（第${ref.m + 1}〜${ref.m + sp.dm + 1}小節）` : '線'; }
    const d = sm?.dirs?.[ref.idx];
    if (!d) return '記号';
    return d.k === 'dyn' ? `強弱記号 ${d.v}` : d.k === 'chord' ? `コードネーム ${d.text}` : `文字「${d.text}」`;
  }
  deleteMark() {
    const st = this.state;
    const r = st.sel?.ref;
    if (!r) return;
    const name = this.markName(r);
    this.edit('記号の削除', () => {
      if (r.type === 'dir') return K.removeDir(this.score, r.p, r.s, r.m, r.idx) || false;
      if (r.type === 'span') return K.removeSpan(this.score, r.p, r.s, r.m, r.idx) || false;
      if (r.type === 'lyr') return K.setLyric(this.score, r.id, r.verse, '');
      if (r.type === 'meas') { delete this.score.measures[r.m][r.what]; return true; }
      return false;
    });
    st.sel = null;
    this.refreshOverlays(); this.updateUI();
    this.toast(name + 'を削除しました');
  }
  editMark() {
    const st = this.state;
    const r = st.sel?.ref;
    if (!r) return;
    if (r.type === 'lyr') return this.startLyrics(r.id, r.verse);
    if (r.type === 'meas') return this.dialogs.repeats(r.m);
    if (r.type === 'span') return this.toast('線は ←→ / Shift+←→ で長さを変えられます');
    const d = this.score.parts[r.p]?.staves[r.s]?.measures[r.m]?.dirs?.[r.idx];
    if (!d) return;
    if (d.k === 'chord') {
      const at = E.eventAt(this.score, { p: r.p, s: r.s, m: r.m, v: 0, t: d.t }) || E.eventCovering(this.score, { p: r.p, s: r.s, m: r.m, v: 0, t: d.t });
      return at && this.startChords(at.ev.id);
    }
    if (d.k === 'dyn') return this.dialogs.marksMenu('expr', null);
    this.dialogs.textExpr(d, (nd) => this.edit('文字の表情記号', () => { Object.assign(d, nd); }));
  }
  nudgeMark(dir, which) {
    const st = this.state;
    const r = st.sel?.ref;
    if (!r || r.type !== 'span') return;
    let res = null;
    this.edit('線の長さ', () => { res = K.nudgeSpan(this.score, r.p, r.s, r.m, r.idx, which, dir); if (!res) return false; });
    if (res) this.selectMark(`s:${r.p}:${r.s}:${res.m}:${res.idx}`);
  }

  // ── 歌詞・コードネームの入力（楽譜の上に入力欄を出す） ──
  startLyrics(id = null, verse = null) {
    const st = this.state;
    if (verse != null) st.verse = verse;
    const target = id || this.firstSelectedNote();
    if (!target) return this.toast('歌詞を付ける最初の音符を選んでください');
    if (st.mode === 'input') { st.mode = 'select'; this.closeOpenSpan(); st.grace = false; }
    this.textEd = { kind: 'lyr', id: target };
    this.openEditor();
    this.toast('スペースで次の音符、- でハイフン、Enter で終わり（Ctrl+↓ で2番へ）', 3200);
  }
  startChords(id = null) {
    const st = this.state;
    const target = id || this.firstSelectedNote(true);
    if (!target) return this.toast('コードネームを付ける音符を選んでください');
    if (st.mode === 'input') { st.mode = 'select'; this.closeOpenSpan(); st.grace = false; }
    this.textEd = { kind: 'chord', id: target };
    this.openEditor();
    this.toast('例：C  Am7  F#m7b5  Bbmaj7/D · スペースで次の音符、Enter で終わり', 3200);
  }
  firstSelectedNote(allowRest = false) {
    const st = this.state;
    if (st.mode === 'input') return st.lastId && E.findEvent(this.score, st.lastId) ? st.lastId : null;
    if (st.sel?.kind === 'mark' && st.sel.ref.type === 'lyr') return st.sel.ref.id;
    const ids = this.selIds();
    return ids.find(i => { const f = E.findEvent(this.score, i); return f && (allowRest || !f.ev.rest); }) || null;
  }
  openEditor() {
    const te = this.textEd;
    const f = te && E.findEvent(this.score, te.id);
    const g = f && this.L.evGeom[te.id];
    if (!g) return this.closeEditor();
    const st = this.state;
    st.sel = { kind: 'event', id: te.id, noteIndex: null };
    this.refreshOverlays(); this.updateUI();
    this.view.ensureVisible(g.page, g.x, g.oy + 4);
    let value, label, y, x, align;
    if (te.kind === 'lyr') {
      const ly = f.ev.lyr?.[st.verse];
      value = ly ? ly.t + (ly.h ? '-' : '') : '';
      // その段にもう歌詞があれば同じ行に、なければ譜表の下に
      const mk = this.L.marks.find(m => m.ref.type === 'lyr' && m.k === g.k && m.r === g.r && m.ref.verse === st.verse);
      y = mk ? mk.oy + mk.y1 - 0.6 : g.oy + Math.max(g.bot, 4) + 2.8 + st.verse * 2.8;
      x = g.x + (g.xr - g.x) / 2; align = 'center';
      label = `歌詞 ${st.verse + 1}番`;
    } else {
      const sm = this.score.parts[f.p].staves[f.s].measures[f.m];
      const d = (sm.dirs || []).find(q => q.k === 'chord' && q.t === f.t);
      value = d ? d.text : '';
      y = g.oy + Math.min(g.top, -0.5) - 1.6; x = g.x; align = 'left';
      label = 'コード';
    }
    const inp = this.view.showEditor({ page: g.page, x, y, value, label, align, onKey: (e, el) => this.editorKey(e, el), onInput: (e, el) => this.editorInput(e, el) });
    this.view.editorBlur = (el) => { if (this.textEd) { this.commitEditor(el.value, false); this.closeEditor(); } };
    return inp;
  }
  editorKey(e, inp) {
    if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換中はそのまま
    const te = this.textEd;
    if (!te) return;
    const k = e.key;
    e.stopPropagation();
    if (k === ' ' || (k === 'Tab' && !e.shiftKey) || k === '_') { e.preventDefault(); this.commitEditor(inp.value, false); return this.editorMove(1); }
    if (k === '-' && te.kind === 'lyr') { e.preventDefault(); this.commitEditor(inp.value, true); return this.editorMove(1); }
    if (k === 'Tab' && e.shiftKey) { e.preventDefault(); this.commitEditor(inp.value, false); return this.editorMove(-1); }
    if (k === 'Backspace' && inp.value === '') { e.preventDefault(); return this.editorMove(-1); }
    if (k === 'Enter') { e.preventDefault(); this.commitEditor(inp.value, false); return this.closeEditor(); }
    if (k === 'Escape') { e.preventDefault(); return this.closeEditor(); }
    if (te.kind === 'lyr' && (k === 'ArrowDown' || k === 'ArrowUp') && (e.ctrlKey || e.metaKey || e.altKey)) {
      e.preventDefault();
      this.commitEditor(inp.value, false);
      this.state.verse = Math.max(0, Math.min(7, this.state.verse + (k === 'ArrowDown' ? 1 : -1)));
      this.openEditor();
      this.toast(`歌詞 ${this.state.verse + 1}番`);
    }
  }
  // 日本語入力で確定したあとの全角スペースも「次の音符へ」
  editorInput(e, inp) {
    if (e.isComposing || !inp.value.includes('　')) return;
    const v = inp.value.replace(/　/g, '');
    this.commitEditor(v, false);
    this.editorMove(1);
  }
  commitEditor(raw, hyphen) {
    const te = this.textEd;
    if (!te) return;
    const f = E.findEvent(this.score, te.id);
    if (!f) return;
    let text = String(raw || '').trim();
    if (te.kind === 'lyr') {
      if (text.endsWith('-')) { hyphen = true; text = text.replace(/-+$/, ''); }
      const cur = f.ev.lyr?.[this.state.verse];
      if ((cur?.t || '') === text && (!text || !!cur?.h === !!hyphen)) return;
      this.edit('歌詞', () => K.setLyric(this.score, te.id, this.state.verse, text, hyphen));
    } else {
      const sm = this.score.parts[f.p].staves[f.s].measures[f.m];
      const idx = (sm.dirs || []).findIndex(d => d.k === 'chord' && d.t === f.t);
      if ((idx >= 0 ? sm.dirs[idx].text : '') === text) return;
      this.edit('コードネーム', () => {
        if (idx >= 0) K.removeDir(this.score, f.p, f.s, f.m, idx);
        if (text) K.addDir(this.score, f.p, f.s, f.m, { t: f.t, k: 'chord', text });
      });
    }
  }
  editorMove(dir) {
    const te = this.textEd;
    if (!te) return;
    let nx;
    if (te.kind === 'lyr') nx = K.nextLyricTarget(this.score, te.id, dir);
    else { const f = E.findEvent(this.score, te.id); const c = f && (dir > 0 ? E.nextEvent(this.score, f) : E.prevEvent(this.score, f)); nx = c?.ev.id; }
    if (!nx) { this.closeEditor(); return this.toast(dir > 0 ? '最後の音符まで入れました' : 'いちばん最初の音符です'); }
    te.id = nx;
    this.openEditor();
  }
  closeEditor() {
    if (!this.textEd && !this.view.editorEl) return;
    this.textEd = null;
    this.view.editorBlur = null;
    this.view.hideEditor();
    this.refreshOverlays(); this.updateUI();
  }

  // ── 表示（スコア / パート譜・記譜音） ──
  setView(opts) {
    Object.assign(this.viewOpts, opts);
    try { localStorage.setItem('kanade.transposed', this.viewOpts.transposed ? '1' : '0'); } catch (e) { /* 使えない環境 */ }
    const st = this.state;
    if (this.textEd) this.closeEditor();
    st.sel = null;
    const vp = this.viewOpts.part;
    if (vp != null && st.caret.p !== vp) { st.caret = { p: vp, s: 0, m: st.caret.m, v: st.voice, t: 0 }; this.setLastPitchForStaff(); }
    this.relayout();
    this.updateViewButton();
    this.view.scroller.scrollTo({ top: 0 });
  }
  updateViewButton() {
    const vo = this.viewOpts;
    const el = document.getElementById('viewLabel');
    if (!el) return;
    el.textContent = vo.part != null ? (this.score.parts[vo.part]?.abbr || 'パート') : 'スコア';
    document.getElementById('btnView').classList.toggle('on', vo.part != null || vo.transposed);
    document.getElementById('btnView').title = (vo.part != null ? `パート譜：${this.score.parts[vo.part]?.name}` : 'スコア（全パート）') + (vo.transposed ? '・記譜音で表示中' : '・実音で表示中');
  }

  // ───────── カーソル・選択の移動 ─────────
  moveCaret(dir) {
    const st = this.state;
    if (st.mode === 'input') {
      st.caret = dir > 0 ? E.caretNext(this.score, st.caret) : E.caretPrev(this.score, st.caret);
      this.revealCaret(); this.updateUI();
      return;
    }
    if (st.sel?.kind === 'mark') return this.nudgeMark(dir, 'end');
    if (st.sel?.kind === 'event') {
      const f = E.findEvent(this.score, st.sel.to || st.sel.id);
      const nx = dir > 0 ? E.nextEvent(this.score, f) : E.prevEvent(this.score, f);
      if (nx) { st.sel = { kind: 'event', id: nx.ev.id, noteIndex: null }; this.afterSelect(nx.ev); }
    } else if (st.sel?.kind === 'range') {
      const m = Math.max(0, Math.min(this.score.measures.length - 1, (dir > 0 ? st.sel.m2 : st.sel.m1) + dir));
      st.sel = { ...st.sel, m1: m, m2: m };
      this.refreshOverlays(); this.updateUI();
    }
  }
  moveStaff(dir) {
    const st = this.state;
    const rows = this.L.rows;
    if (st.mode === 'input') {
      const r = rows.findIndex(x => x.p === st.caret.p && x.s === st.caret.s);
      const nr = Math.max(0, Math.min(rows.length - 1, r + dir));
      st.caret = { ...st.caret, p: rows[nr].p, s: rows[nr].s };
      const voice = E.getVoice(this.score, st.caret.p, st.caret.s, st.caret.m, st.caret.v);
      if (!voice || !E.positions(voice).some(x => x.start === st.caret.t)) {
        const cov = voice && E.positions(voice).find(x => x.start <= st.caret.t && st.caret.t < x.end);
        st.caret.t = cov ? cov.start : 0;
      }
      this.setLastPitchForStaff();
      this.revealCaret(); this.updateUI();
    }
  }
  afterSelect(ev) {
    this.refreshOverlays(); this.updateUI();
    if (ev && !ev.rest) this.audition(ev.notes, 0.35);
    const g = ev && this.L.evGeom[ev.id];
    if (g) this.view.ensureVisible(g.page, g.x, g.oy + 2);
  }
  selectAll() {
    this.state.mode = 'select';
    this.state.sel = { kind: 'range', m1: 0, m2: this.score.measures.length - 1, r1: 0, r2: this.L.rows.length - 1 };
    this.refreshOverlays(); this.updateUI();
  }
  escape() {
    const st = this.state;
    if (st.mode === 'input') this.setMode('select');
    else { st.sel = null; this.refreshOverlays(); this.updateUI(); }
  }

  // ───────── コピー＆ペースト ─────────
  copy(cut = false) {
    const st = this.state;
    let rg;
    if (st.sel?.kind === 'range') rg = this.rangeStaves(st.sel);
    else if (st.sel?.kind === 'event') { const f = E.findEvent(this.score, st.sel.id); rg = { m1: f.m, m2: f.m, staves: [[f.p, f.s]] }; }
    if (!rg) return this.toast('コピーする小節を選んでください');
    this.clip = E.copyRange(this.score, rg);
    if (cut) this.edit('切り取り', () => E.clearRange(this.score, rg));
    this.toast(`${rg.m2 - rg.m1 + 1}小節を${cut ? '切り取り' : 'コピー'}しました`);
  }
  paste() {
    const st = this.state;
    if (!this.clip) return this.toast('クリップボードが空です');
    const loc = st.mode === 'input' ? st.caret : this.selLoc();
    if (!loc) return this.toast('貼り付け先の小節を選んでください');
    const rows = this.L.rows;
    const r0 = rows.findIndex(x => x.p === loc.p && x.s === loc.s);
    const staves = this.clip.rows.map((_, k) => rows[r0 + k]).filter(Boolean).map(x => [x.p, x.s]);
    this.edit('貼り付け', () => E.pasteRange(this.score, this.clip, { m: loc.m, staves }));
    st.mode = 'select';
    st.sel = { kind: 'range', m1: loc.m, m2: loc.m + this.clip.count - 1, r1: r0, r2: r0 + staves.length - 1 };
    this.refreshOverlays(); this.updateUI();
  }

  // ───────── 再生 ─────────
  async togglePlay() {
    if (this.player.playing) { this.player.stop(); this.updateUI(); return; }
    this.synth.ensure();
    const from = this.playFrom ?? this.focusMeasure();
    this.playFrom = null;
    this.followPlay = true;
    document.getElementById('btnPlay').classList.add('on');
    await this.player.start(this.score, from);
    this.updateUI();
  }
  rewind() {
    if (this.player.playing) this.player.stop();
    this.playFrom = 0;
    this.view.scroller.scrollTo({ top: 0, behavior: 'smooth' });
    this.toast('先頭から再生します');
  }

  // ───────── MIDI ─────────
  midiNoteOn(note, vel, chordHeld) {
    const btn = document.getElementById('btnMidi');
    btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 120);
    const st = this.state;
    if (st.mode !== 'input') {
      // 選択モードでは音を鳴らすだけ（試し弾き）
      const part = this.score.parts[0];
      this.synth.play({ midi: note, program: part.program, sf: (INST[part.inst] || {}).sf, dur: 0.6, vel: vel / 127 });
      return;
    }
    const fifths = this.L.attrs[st.caret.m]?.fifths || 0;
    const pitch = spellMidi(note, fifths);
    this.enterPitch(pitch, { chord: chordHeld });
  }
  midiStatus(s) {
    const btn = document.getElementById('btnMidi');
    btn.classList.toggle('on', !!(s.ok && s.devices && s.devices.length));
    this.midiInfo = s;
    if (s.ok && s.devices?.length && !this.midiAnnounced) { this.midiAnnounced = true; this.toast('MIDI 接続：' + s.devices.join('、')); }
  }

  // ───────── ファイル ─────────
  async exportXML() {
    const xml = exportMusicXML(this.score);
    const name = this.fileBaseName() + '.musicxml';
    try {
      const r = await saveFile(name, new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), 'musicxml');
      if (r && typeof r === 'object') this.toast(`「${r.name}」に書き出しました`);
    } catch (e) { console.error(e); this.toast('書き出せませんでした：' + e.message, 3500); }
  }
  // ファイルを開く：.kanade はそのまま、MusicXML / .mxl は変換して読み込む。
  // handle = PC で選んだファイル（.kanade ならそこへ上書き保存できるように覚えておく）
  async openFile(file, handle = null) {
    try {
      const isKanade = /\.kanade$/i.test(file.name);
      let score;
      if (isKanade) score = parseKanade(await file.text());
      else {
        const xml = /\.mxl$/i.test(file.name) ? await readMxl(await file.arrayBuffer()) : await file.text();
        score = importMusicXML(xml);
        if (!score.meta.title || score.meta.title === '無題') score.meta.title = file.name.replace(/\.(musicxml|xml|mxl)$/i, '');
      }
      await this.save(); // 今の楽譜を確実に保存してから切り替える
      if (this.player.playing) this.player.stop();
      if (isKanade && handle) {
        // 前に開いたことのあるファイルなら、一覧に同じものを増やさず同じ楽譜として開き直す
        const known = await storage.findByHandle(handle);
        this.newDoc(score, { id: known?.id, handle });
      } else this.newDoc(score);
      this.view.resetZoom();
      this.relayout();
      this.view.scroller.scrollTo({ top: 0 });
      this.toast(`「${score.meta.title || file.name}」を開きました（${score.parts.length}パート・${score.measures.length}小節）`, 2600);
    } catch (e) {
      console.error(e);
      this.toast('読み込めませんでした：' + e.message, 3500);
    }
  }
  print() {
    this.state.sel = null;
    this.refreshOverlays();
    setTimeout(() => window.print(), 50);
  }

  // ───────── 画面のボタン ─────────
  bindTopbar() {
    const $ = (id) => document.getElementById(id);
    $('btnUndo').onclick = () => this.undo();
    $('btnRedo').onclick = () => this.redo();
    $('btnPlay').onclick = () => this.togglePlay();
    $('btnRewind').onclick = () => this.rewind();
    $('btnZoomIn').onclick = () => this.view.setZoom(this.view.zoom * 1.15);
    $('btnZoomOut').onclick = () => this.view.setZoom(this.view.zoom / 1.15);
    $('zoomLabel').onclick = () => this.zoomToFit();
    $('btnFile').onclick = (e) => this.dialogs.fileMenu(e.currentTarget);
    $('btnMeasure').onclick = (e) => this.dialogs.measureMenu(e.currentTarget);
    $('btnScore').onclick = (e) => this.dialogs.scoreMenu(e.currentTarget);
    $('btnView').onclick = (e) => this.dialogs.viewMenu(e.currentTarget);
    $('btnTempo').onclick = () => this.dialogs.tempo();
    $('docTitle').onclick = () => this.dialogs.scoreInfo();
    $('btnHelp').onclick = () => this.dialogs.help();
    $('btnMidi').onclick = () => this.dialogs.midi();
    document.querySelector('#btnTempo .note-glyph').textContent = G.metNoteQuarterUp.c;
    $('fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) this.openFile(f); e.target.value = ''; };
  }
  zoomToFit() { this.view.setZoom(this.view.fitZoom()); this.view.fit = true; }

  // ───────── PC 向け：ドラッグ＆ドロップ・ファイルの関連付け・インストール ─────────
  bindDesktop() {
    const appEl = document.getElementById('app');
    // ファイルをウィンドウにドラッグ＆ドロップで開く
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; appEl.classList.add('dropping'); });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; appEl.classList.remove('dropping'); } });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; appEl.classList.remove('dropping');
      const item = [...e.dataTransfer.items].find(i => i.kind === 'file');
      if (!item) return;
      // どちらも await より前に取り出す（ドロップの処理が終わると読めなくなる）
      const hp = item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
      const file = item.getAsFile();
      const h = hp ? await hp.catch(() => null) : null;
      this.openFile(file, h && h.kind === 'file' ? h : null);
    });
    // インストールしたアプリで .kanade / .musicxml をダブルクリックしたとき（manifest の file_handlers）
    if ('launchQueue' in window) {
      window.launchQueue.setConsumer(async (p) => { const h = p.files && p.files[0]; if (h) this.openFile(await h.getFile(), h); });
    }
    // Chrome / Edge の「アプリとしてインストール」をファイルメニューから出せるように取っておく
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); this.installPrompt = e; });
    window.addEventListener('appinstalled', () => { this.installPrompt = null; this.toast('インストールしました。スタートメニューから起動できます', 3500); });
    // ウィンドウやタブを閉じる・隠すときにすぐ保存（自動保存の 0.7 秒待ちを待たない）
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.save(); });
    // 右クリックでブラウザのメニューを出さない（楽譜の上では KANADE のメニューを出す）
    appEl.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea, select')) e.preventDefault(); });
  }
  get isInstalled() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  async install() {
    if (!this.installPrompt) return this.dialogs.installHelp();
    this.installPrompt.prompt();
    await this.installPrompt.userChoice.catch(() => null);
    this.installPrompt = null;
  }

  // ───────── タップ・ペン・マウス ─────────
  bindPointer() {
    const pagesEl = document.getElementById('pages');
    let drag = null;
    // Apple Pencil で書くときはスクロールさせない（指はスクロール、ペンは入力）
    pagesEl.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      if ((t && t.touchType === 'stylus') || (drag && drag.lockScroll)) e.preventDefault();
    }, { passive: false });
    pagesEl.addEventListener('touchmove', (e) => { if (drag && drag.lockScroll) e.preventDefault(); }, { passive: false });

    pagesEl.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      this.synth.ensure();
      const pt = this.view.locate(e.clientX, e.clientY);
      const h = this.view.hit(pt);
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, type: e.pointerType, h, moved: false, lockScroll: e.pointerType === 'pen' };
      const st = this.state;
      if (st.mode === 'input' && h) {
        this.updateGhost(h);
      } else if (st.mode === 'select' && h) {
        // 選択中の音符の上で押したら、上下ドラッグで音高を変える
        const near = this.view.nearestEvent(h, 1.6);
        if (near && st.sel?.kind === 'event' && near.id === st.sel.id && !near.g.rest) {
          drag.pitchDrag = { id: near.id, startPos: h.pos, applied: 0, noteIndex: st.sel.noteIndex };
          drag.lockScroll = true;
        } else if (e.pointerType !== 'touch') {
          // マウス・ペンでなぞると小節の範囲選択（指はスクロールなので対象外）
          drag.range = { m: h.m, r: h.r };
        }
      }
      if (drag.lockScroll || e.pointerType === 'mouse') { try { pagesEl.setPointerCapture(e.pointerId); } catch (err) { /* 未対応 */ } }
    });

    pagesEl.addEventListener('pointermove', (e) => {
      const st = this.state;
      if (!drag || drag.id !== e.pointerId) {
        // マウスを乗せただけのとき：入力モードはゴースト音符、選択モードは音符をうっすら色付け
        if (e.pointerType !== 'mouse') return;
        const pt = this.view.locate(e.clientX, e.clientY);
        const h = this.view.hit(pt);
        if (st.mode === 'input') { this.view.hover(null); pagesEl.style.cursor = ''; this.updateGhost(h); }
        else this.hoverAt(h, pt);
        return;
      }
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 8) drag.moved = true;
      const h = this.view.hit(this.view.locate(e.clientX, e.clientY));
      if (st.mode === 'input' && (drag.type !== 'touch' || !drag.moved)) this.updateGhost(h);
      if (drag.range && drag.moved && h) {
        const a = drag.range;
        const s = st.sel;
        const m1 = Math.min(a.m, h.m), m2 = Math.max(a.m, h.m), r1 = Math.min(a.r, h.r), r2 = Math.max(a.r, h.r);
        drag.rangeDone = true;
        if (!(s?.kind === 'range' && s.m1 === m1 && s.m2 === m2 && s.r1 === r1 && s.r2 === r2)) {
          st.sel = { kind: 'range', m1, m2, r1, r2, a: a.m, ra: a.r };
          this.view.hover(null);
          this.refreshOverlays(); this.updateUI();
        }
      }
      if (drag.pitchDrag && h) {
        const pd = drag.pitchDrag;
        const want = h.pos - pd.startPos;
        if (want !== pd.applied) {
          if (pd.applied === 0) this.history.push({ score: this.score, caret: st.caret, sel: st.sel }, '音高ドラッグ');
          E.shiftDiatonic(this.score, pd.id, want - pd.applied, pd.noteIndex);
          pd.applied = want;
          this.relayout();
          const f = E.findEvent(this.score, pd.id);
          if (f && !f.ev.rest) this.audition(pd.noteIndex != null ? [f.ev.notes[Math.min(pd.noteIndex, f.ev.notes.length - 1)]] : f.ev.notes, 0.25);
        }
      }
    });

    const finish = (e, cancel) => {
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag; drag = null;
      const st = this.state;
      if (d.pitchDrag) { if (d.pitchDrag.applied) this.scheduleSave(); return; }
      if (d.rangeDone) { this.lastRangeTap = 0; return; }
      if (cancel || (d.moved && d.type === 'touch')) { if (e.pointerType !== 'mouse') this.view.hideOverlay('ghost'); return; }
      const pt = this.view.locate(e.clientX, e.clientY);
      const h = this.view.hit(pt) || d.h;
      if (e.pointerType !== 'mouse') this.view.hideOverlay('ghost');
      if (st.mode === 'select') return this.tapSelect(h, e, pt);
      if (h) this.tapInput(h, e);
    };
    pagesEl.addEventListener('pointerup', (e) => finish(e, false));
    pagesEl.addEventListener('pointercancel', (e) => finish(e, true));
    pagesEl.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { this.view.hideOverlay('ghost'); this.view.hover(null); } });
    // ダブルクリック（ダブルタップ）：選んだ所から入力を始める
    // 記号の上ならその記号を編集（歌詞・コードネーム・文字）
    pagesEl.addEventListener('dblclick', () => {
      const st = this.state;
      if (st.mode !== 'select' || !st.sel) return;
      if (st.sel.kind === 'mark') this.editMark(); else this.setMode('input');
    });
    // 右クリック：その場で使えるメニュー
    pagesEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const pt = this.view.locate(e.clientX, e.clientY);
      const h = this.view.hit(pt);
      const mk = this.view.hitMark(pt);
      const near = h && this.view.nearestEvent(h);
      if (mk && !(near && near.d < 0.6)) return this.markMenu(mk, e);
      if (h) this.contextMenu(h, e);
    });
  }

  // 選択モードでマウスを乗せた音符・記号を色付けし、カーソルの形で「何ができるか」を見せる
  hoverAt(h, pt) {
    const near = h && this.view.nearestEvent(h);
    const sel = this.state.sel;
    const onSel = near && sel?.kind === 'event' && sel.id === near.id;
    const mk = (!near || near.d > 0.6) && pt ? this.view.hitMark(pt) : null;
    if (mk) {
      this.view.hover(sel?.kind === 'mark' && sel.key === mk.key ? null : mk.key);
      this.view.pagesEl.style.cursor = 'pointer';
      return;
    }
    this.view.hover(near && !onSel ? near.id : null);
    this.view.pagesEl.style.cursor = !near ? '' : onSel && !near.g.rest ? 'ns-resize' : 'pointer';
  }

  // 記号を右クリックしたとき
  markMenu(mk, e) {
    const st = this.state;
    if (st.mode === 'input') this.setMode('select');
    this.selectMark(mk.key);
    const isSpan = mk.ref.type === 'span';
    const items = [{ head: this.markName(mk.ref) }];
    if (isSpan) items.push(
      { label: '終わりを1つ右へ', kbd: '→', run: () => this.nudgeMark(1, 'end') },
      { label: '終わりを1つ左へ', kbd: '←', run: () => this.nudgeMark(-1, 'end') },
      { label: '始まりを1つ右へ', kbd: 'Shift+→', run: () => this.nudgeMark(1, 'start') },
      { label: '始まりを1つ左へ', kbd: 'Shift+←', run: () => this.nudgeMark(-1, 'start') }, '-');
    else items.push({ label: '編集…', kbd: 'Enter', run: () => this.editMark() });
    items.push({ label: '削除', kbd: 'Delete', run: () => this.deleteMark() });
    this.dialogs.menu({ x: e.clientX, y: e.clientY }, items);
  }

  // 右クリックメニュー（Finale の右クリックと同じ感覚で、よく使う操作をその場で）
  contextMenu(h, e) {
    const st = this.state;
    if (st.mode === 'input') this.setMode('select');
    const near = this.view.nearestEvent(h);
    // 右クリックした所が今の選択に入っていなければ、そこを選び直す
    const inRange = st.sel?.kind === 'range' && h.m >= st.sel.m1 && h.m <= st.sel.m2 && h.r >= st.sel.r1 && h.r <= st.sel.r2;
    const onSel = near && st.sel?.kind === 'event' && (st.sel.id === near.id || (st.sel.to && this.eventSpanIds(st.sel.id, st.sel.to).includes(near.id)));
    if (!inRange && !onSel) {
      if (near) { st.sel = { kind: 'event', id: near.id, noteIndex: near.noteIndex ?? null }; st.voice = near.g.v; }
      else st.sel = { kind: 'range', m1: h.m, m2: h.m, r1: h.r, r2: h.r, a: h.m, ra: h.r };
      this.view.hover(null);
      this.refreshOverlays(); this.updateUI();
    }
    const sel = st.sel;
    const f = sel.kind === 'event' && E.findEvent(this.score, sel.id);
    const isNote = f && !f.ev.rest;
    const from = this.selLoc().m;
    const items = [
      { label: 'ここから入力', kbd: 'Enter', run: () => this.setMode('input') },
      { label: 'ここから再生', run: () => { if (this.player.playing) this.player.stop(); this.playFrom = from; this.togglePlay(); } },
      '-',
      { label: '切り取り', kbd: 'Ctrl+X', run: () => this.copy(true) },
      { label: 'コピー', kbd: 'Ctrl+C', run: () => this.copy(false) },
      ...(this.clip ? [{ label: '貼り付け', kbd: 'Ctrl+V', run: () => this.paste() }] : []),
      { label: sel.kind === 'range' ? '中身を消す' : isNote ? '休符にする' : '削除', kbd: 'Delete', run: () => this.deleteSel() },
    ];
    if (isNote || sel.kind === 'range') items.push('-',
      { label: '半音上げる', kbd: '↑', run: () => this.shiftPitch('semi', 1) },
      { label: '半音下げる', kbd: '↓', run: () => this.shiftPitch('semi', -1) },
      { label: '1オクターブ上げる', kbd: 'Ctrl+↑', run: () => this.shiftPitch('octave', 1) },
      { label: '1オクターブ下げる', kbd: 'Ctrl+↓', run: () => this.shiftPitch('octave', -1) });
    if (isNote) items.push({ label: 'タイ', kbd: 'T', run: () => this.tie() });
    if (f && !sel.to) items.push({ label: '3連符にする', kbd: 'Ctrl+3', run: () => this.makeTuplet(3) });
    const pt = { x: e.clientX, y: e.clientY };
    // 記号（Phase 2）
    items.push('-');
    if (isNote || sel.kind === 'range') items.push(
      { label: 'アーティキュレーション…', kbd: '▸', run: () => this.dialogs.marksMenu('art', pt) },
      { label: '強弱・表情記号…', kbd: 'X', run: () => this.dialogs.marksMenu('expr', pt) },
      { label: sel.to || sel.kind === 'range' ? 'スラー（選んだ範囲）' : 'スラー（次の音符まで）', kbd: 'S', run: () => this.addSpan('slur') },
      { label: 'クレッシェンド ／ デクレッシェンド…', kbd: '< >', run: () => this.dialogs.marksMenu('lines', pt) },
      { label: '歌詞を入力', kbd: 'L', run: () => this.startLyrics() });
    if (f) items.push({ label: 'コードネームを入力', kbd: 'K', run: () => this.startChords() });
    if (f && !sel.to) items.push({ label: '装飾音符を付ける', kbd: ';', run: () => { this.setMode('input'); if (!this.state.grace) this.toggleGrace(); } });
    if (f?.ev.grace) items.push({ label: '装飾音符を消す', run: () => this.edit('装飾音符の削除', () => { delete E.findEvent(this.score, f.ev.id).ev.grace; }) });
    if (f?.ev.art) items.push({ label: 'アーティキュレーションを全部外す', run: () => this.edit('アーティキュレーション', () => K.clearArtics(this.score, this.selIds())) });
    items.push({ label: '反復記号・カッコ…', run: () => this.dialogs.repeats() });
    items.push('-', { label: `第${from + 1}小節の設定（拍子・調・音部記号…）`, kbd: '▸', run: () => this.dialogs.measureMenu(pt) });
    this.dialogs.menu(pt, items);
  }

  // 入力モードのタップ位置 → どのタイミング・どの高さに入れるか
  resolveInputTarget(h) {
    const st = this.state;
    const voice = E.getVoice(this.score, h.p, h.s, h.m, st.voice);
    const starts = voice ? E.positions(voice).map(x => x.start) : [0];
    // 連符の中は連符の音符位置だけに吸着
    const t = this.view.snapTick(h, TYPE_TICKS[st.dur.type] * (st.dur.dots ? 1.5 : 1) > (this.L.attrs[h.m].len) ? 0 : TYPE_TICKS[st.dur.type], starts);
    const cov = voice && E.positions(voice).find(x => x.start <= t && t < x.end);
    const tt = cov && cov.ev.tuplet ? cov.start : t;
    return { ...h, t: tt };
  }
  updateGhost(h) {
    if (!h || this.state.mode !== 'input') return this.view.hideOverlay('ghost');
    const tg = this.resolveInputTarget(h);
    const head = this.state.rest ? 'restQuarter' : HEAD_OF[this.state.dur.type] || 'noteheadBlack';
    const p = h.pitch;
    this.view.showGhost(tg, head, this.state.rest ? '休' : `${STEP_JA[p.step]}${p.alter > 0 ? '♯' : p.alter < 0 ? '♭' : ''}${p.octave}`);
  }
  tapInput(h, e) {
    const st = this.state;
    const tg = this.resolveInputTarget(h);
    const loc = { p: h.p, s: h.s, m: h.m, v: st.voice, t: tg.t };
    const pitch = this.concertOf(h.pitch, h.p); // 記譜音で表示中なら実音にして入れる
    // 和音モード or Shift：そのタイミングにある音符へ足す（装飾音符モードなら装飾音の和音）
    if ((st.chord || e.shiftKey) && !st.rest && !st.grace) {
      const at = E.eventAt(this.score, loc);
      if (at && !at.ev.rest) {
        st.lastId = at.ev.id;
        this.edit('和音に追加', () => E.addToChord(this.score, at.ev.id, pitch));
        st.lastPitch = pitch; this.audition([pitch]);
        return;
      }
    }
    st.caret = loc;
    if (st.rest) this.enterRest({ at: loc });
    else this.enterPitch(pitch, { at: loc, chord: st.grace && e.shiftKey });
  }
  tapSelect(h, e, pt) {
    const st = this.state;
    if (this.textEd) this.closeEditor();
    const near = h && this.view.nearestEvent(h);
    // 記号（強弱・スラー・歌詞・コードネームなど）：音符のすぐ近くでなければ記号を選ぶ
    const mk = pt && this.view.hitMark(pt);
    if (mk && !(near && near.d < 0.6 && mk.ref.type !== 'lyr')) return this.selectMark(mk.key);
    if (!h) { st.sel = null; this.refreshOverlays(); this.updateUI(); return; }
    // Shift+クリックで同じ声部の音符を範囲選択（スラー・松葉・まとめてアーティキュレーション）
    if (near && e.shiftKey && st.sel?.kind === 'event') {
      const a = E.findEvent(this.score, st.sel.id), b = E.findEvent(this.score, near.id);
      if (a && b && a.p === b.p && a.s === b.s && a.v === b.v) {
        st.sel = { kind: 'event', id: st.sel.id, noteIndex: null, ...(near.id !== st.sel.id ? { to: near.id } : {}) };
        this.refreshOverlays(); this.updateUI();
        return;
      }
    }
    if (near && !e.shiftKey) {
      st.sel = { kind: 'event', id: near.id, noteIndex: near.noteIndex ?? null };
      st.voice = near.g.v;
      const f = E.findEvent(this.score, near.id);
      if (f) st.dur = { type: f.ev.mr ? st.dur.type : f.ev.type, dots: f.ev.mr ? 0 : f.ev.dots };
      this.refreshOverlays(); this.updateUI();
      if (f && !f.ev.rest) this.audition(near.noteIndex != null ? [f.ev.notes[near.noteIndex]] : f.ev.notes, 0.35);
      return;
    }
    // 小節の選択（Shift で範囲を広げる）
    if (e.shiftKey && st.sel?.kind === 'range') {
      st.sel = { kind: 'range', m1: Math.min(st.sel.a, h.m), m2: Math.max(st.sel.a, h.m), r1: Math.min(st.sel.ra, h.r), r2: Math.max(st.sel.ra, h.r), a: st.sel.a, ra: st.sel.ra };
    } else if (st.sel?.kind === 'range' && st.sel.m1 === st.sel.m2 && st.sel.r1 === st.sel.r2 && !(st.sel.m1 === h.m && st.sel.r1 === h.r) && this.lastRangeTap && Date.now() - this.lastRangeTap < 4000) {
      // 2回目のタップは範囲の終点（タッチでも範囲選択できるように）
      st.sel = { kind: 'range', m1: Math.min(st.sel.m1, h.m), m2: Math.max(st.sel.m1, h.m), r1: Math.min(st.sel.r1, h.r), r2: Math.max(st.sel.r1, h.r), a: st.sel.m1, ra: st.sel.r1 };
    } else {
      st.sel = { kind: 'range', m1: h.m, m2: h.m, r1: h.r, r2: h.r, a: h.m, ra: h.r };
    }
    this.lastRangeTap = Date.now();
    this.refreshOverlays(); this.updateUI();
  }

  staffRows() { return staffList(this.score); }
  // 小節の挿入位置など（選択 or カーソルの小節）
  targetMeasure() { return this.focusMeasure(); }
  durTicks() { return dottedTicks(this.state.dur.type, this.state.dur.dots); }
  pitchLabel(p) { return pitchName(p); }
}
export { TPQ };
