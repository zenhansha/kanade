// アプリ本体：状態（楽譜・カーソル・選択・入力設定）を持ち、操作を楽譜に反映して再描画する
import { createScore, measureAttrs, INST, clefInfo, staffList, clefAt, measureRest, newId } from './core/score.js';
import { rebar } from './core/rebar.js';
import * as E from './core/edit.js';
import * as K from './core/marks.js';
import { History } from './core/history.js';
import { TYPE_TICKS, dottedTicks, spellMidi, midiOf, diatonic, fromDiatonic, keyAlter, pitchName, STEP_JA, TPQ, TYPE_JA, CLEFS, keyNameJa, beatTicks, ticksToType } from './core/music.js';
import { layoutScore } from './engrave/layout.js';
import { ScoreView } from './ui/view.js';
import { Ribbon } from './ui/ribbon.js';
import { Home } from './ui/home.js';
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
import * as P from './core/perc.js';
import { Tools } from './ui/tools.js';
import { Live } from './ui/live.js';
import { importMidi } from './io/midifile.js';

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
    let tr = false, arrange = 'vertical', theme = 'auto';
    try {
      tr = localStorage.getItem('kanade.transposed') === '1';
      arrange = localStorage.getItem('kanade.arrange') || 'vertical';
      theme = localStorage.getItem('kanade.theme') || 'auto';
      if (localStorage.getItem('kanade.colorVoices') === '0') this.state.colorVoices = false;
    } catch (e) { /* 使えない環境 */ }
    // arrange = ページの並べ方：vertical（縦・Word と同じ）/ horizontal（横）/ spread（見開き）/ scroll（1段スクロール）
    this.viewOpts = { part: null, transposed: tr, multiRest: true, rangeCheck: false, arrange };
    this.theme = theme;
    this.speed = 1;      // 再生の速さ（リボンの「再生」タブ）
    this.rampLoop = false; // ループのたびに少しずつ速くする（練習用）
    this.loop = null;    // ループ再生の範囲 { m1, m2 }
    this.transient = false; // まだ何も書いていない仮の楽譜（ホーム画面の後ろ）。編集すると保存されるようになる
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
    this.applyTheme();
    this.view = new ScoreView(this, document.getElementById('scroller'), document.getElementById('pages'));
    document.getElementById('pages').dataset.arrange = this.viewOpts.arrange;
    this.home = new Home(this);
    this.piano = new Piano(this, document.getElementById('piano'));
    this.dialogs = new Dialogs(this);
    this.tools = new Tools(this);
    this.live = new Live(this);
    this.ribbon = new Ribbon(this);
    bindKeys(this);
    this.bindTopbar();
    this.bindPointer();
    this.midi = new MidiInput({
      onNoteOn: (n, vel, chord, stamp) => this.midiNoteOn(n, vel, chord, stamp),
      onNoteOff: (n, stamp) => this.midiNoteOff(n, stamp),
      onStatus: (st) => this.midiStatus(st),
      onPedal: (down) => this.synth.setSustain(down),
    });
    try { this.synth.reverb = localStorage.getItem('kanade.reverb') || 'hall'; } catch (e) { /* 使えない環境 */ }
    this.player.onLoading = () => this.toast('ピアノの音を読み込んでいます…', 2500);
    if (this.midi.supported) this.midi.connect();
    else this.midiStatus({ ok: false, reason: 'unsupported', silent: true });
    this.player.onTick = (pos) => {
      const r = this.view.showPlayLine(pos.m, pos.t);
      if (r && this.followPlay) this.view.ensureVisible(r.page, r.x, r.y + 6, 120);
    };
    this.player.onStop = () => { this.view.hideOverlay('play'); this.updateUI(); };
    document.body.classList.toggle('color-voices', this.state.colorVoices);

    // 起動：Word と同じく、まずホーム画面（オプションで「前回の楽譜をすぐ開く」も選べる）。
    // 後ろには前回の楽譜を開いておく（なければ何も保存しない仮の楽譜）
    let opened = false, startLast = false;
    try {
      startLast = localStorage.getItem('kanade.startLast') === '1';
      const last = localStorage.getItem('kanade.last');
      if (last) { const doc = await storage.get(last); if (doc) { this.openDoc(doc); opened = true; } }
    } catch (e) { console.warn(e); }
    if (!opened) this.newDoc(createScore({ insts: ['piano'], title: '無題', measures: 16 }), { transient: true });
    const launched = 'launchQueue' in window && new URLSearchParams(location.search).has('file');
    if (!(startLast && opened) && !launched) this.home.show('launch');
    await document.fonts.load('20px Bravura').catch(() => {});
    this.view.resetZoom();
    this.relayout();
    this.updateViewButton();
    window.addEventListener('resize', () => { this.view.onResize(); this.afterZoom(); });
    this.bindDesktop();
    const warm = () => { this.synth.ensure(); (this.score?.parts || []).forEach(p => this.synth.loadSamples((INST[p.inst] || {}).sf)); };
    window.addEventListener('pointerdown', warm, { once: true, capture: true });
    window.addEventListener('keydown', warm, { once: true, capture: true });
  }

  // ───────── ドキュメント ─────────
  // opts.id = 既存の楽譜として開き直すとき、opts.handle = PC のファイル（.kanade）
  newDoc(score, opts = {}) {
    this.score = score;
    this.docId = opts.id || storage.newId();
    this.fileHandle = opts.handle || null; this.fileName = opts.handle ? opts.handle.name : null; this.fileDirty = false;
    this.transient = !!opts.transient;
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
    this.transient = false;
    this.score = doc.score;
    this.docId = doc.id;
    this.fileHandle = doc.handle || null; this.fileName = doc.fileName || null; this.fileDirty = !!doc.fileDirty;
    this.history.clear();
    this.resetDocState();
    try { localStorage.setItem('kanade.last', doc.id); } catch (e) { /* プライベートモード */ }
  }
  async save() {
    if (!this.score || this.transient) return;
    clearTimeout(this.saveTimer);
    const old = await storage.get(this.docId).catch(() => null);
    const doc = { id: this.docId, title: this.score.meta.title || '無題', updated: Date.now(), score: this.score, handle: this.fileHandle, fileName: this.fileName, fileDirty: this.fileDirty, pinned: !!old?.pinned, summary: `${this.score.parts.length}パート・${this.score.measures.length}小節` };
    try {
      await storage.put(doc);
      localStorage.setItem('kanade.last', this.docId);
      this.savedAt = Date.now();
      this.updateSaveState();
    } catch (e) { console.warn('保存失敗', e); }
  }
  // 上のバーの「保存しました」（Word の自動保存の表示）
  updateSaveState() {
    const el = document.getElementById('saveState');
    if (!el) return;
    if (this.transient) { el.textContent = ''; return; }
    el.textContent = this.fileName && this.fileDirty ? '● 未保存' : this.saveTimer && this.pendingSave ? '保存中…' : '保存済み';
    el.classList.toggle('dirty', !!(this.fileName && this.fileDirty));
    el.title = this.fileName ? `ファイル：${this.fileName}${this.fileDirty ? '（Ctrl+S でファイルに保存）' : ''}` : 'この端末に自動で保存しています';
  }
  scheduleSave() {
    this.transient = false;
    this.pendingSave = true;
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { this.pendingSave = false; this.save(); }, 700);
    this.updateSaveState();
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
    this.L = layoutScore(this.score, { measureText: this.measureText, parts: vo.part != null ? [vo.part] : null, transposed: vo.transposed, multiRest: vo.multiRest, rangeCheck: vo.rangeCheck, continuous: vo.arrange === 'scroll' });
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
    this.ribbon?.update();
    document.querySelectorAll('#statusbar [data-arr]').forEach(b => b.classList.toggle('on', b.dataset.arr === this.viewOpts.arrange));
    document.getElementById('btnUndo').disabled = !this.history.canUndo;
    document.getElementById('btnRedo').disabled = !this.history.canRedo;
    document.body.classList.toggle('mode-input', st.mode === 'input');
    this.piano?.update();
    if (st.mode === 'input') { this.view.pagesEl.style.cursor = ''; this.view.hover(null); }
    this.updateTitle();
    document.getElementById('zoomLabel').textContent = Math.round(this.view.zoom * 100) + '%';
    const A = this.L ? this.L.attrs : measureAttrs(this.score);
    const m = this.focusMeasure();
    const tpm = (() => { for (let i = m; i >= 0; i--) if (this.score.measures[i]?.tempo) return this.score.measures[i].tempo; return null; })();
    document.getElementById('tempoLabel').textContent = '= ' + (tpm ? tpm.bpm : A[m] ? A[m].bpm : 100) + (this.speed !== 1 ? ` (${Math.round(this.speed * 100)}%)` : '');
    document.getElementById('btnPlay').classList.toggle('on', this.player.playing);
    // ステータス
    const parts = [];
    const part = this.score.parts[st.mode === 'input' ? st.caret.p : (this.selLoc()?.p ?? 0)];
    if (this.tools?.rec.active) {
      parts.push(`● 録音中 · ${this.score.parts[this.tools.rec.o.p]?.name || ''} · 第${this.tools.rec.where() + 1}小節`, 'スペース / Esc / ■ で止めて楽譜にする');
    } else if (st.mode === 'input') {
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
      ? `五線を${mouse ? 'クリック' : 'タップ'}／A〜G キー／MIDI鍵盤で入力 · ${mouse ? 'Esc で選択モード' : '2本指で移動・拡大 · 2本指タップで元に戻す'}`
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
    if (this.tools.rec.active) return;
    const r = this.history.undo({ score: this.score, caret: this.state.caret, sel: this.state.sel });
    if (!r) return;
    this.score = r.score; this.state.caret = r.caret; this.state.sel = r.sel;
    this.relayout(); this.scheduleSave(); this.toast('元に戻す' + (r.label ? '：' + r.label : ''));
  }
  redo() {
    if (this.tools.rec.active) return;
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
    this.refreshHover();
    if (mode === 'input') this.revealCaret();
  }
  // マウスが楽譜の上にあるとき、今のモードの表示（入力＝ゴースト音符 / 選択＝うっすら色付け）に今すぐそろえる
  refreshHover() {
    this.view.hideOverlay('ghost'); this.view.hover(null);
    this.view.pagesEl.style.cursor = '';
    if (!this.mouseAt) return;
    const pt = this.view.locate(this.mouseAt.x, this.mouseAt.y), h = this.view.hit(pt);
    if (this.state.mode === 'input') this.updateGhost(h); else this.hoverAt(h, pt);
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

  audition(pitches, dur = 0.45, partIndex = null) {
    const part = this.score.parts[partIndex ?? (this.state.mode === 'input' ? this.state.caret.p : (this.selLoc()?.p ?? 0))] || this.score.parts[0];
    const inst = INST[part.inst] || {};
    this.synth.loadSamples(inst.sf);
    for (const p of pitches) {
      if (p.drum) { this.synth.play({ drum: p.drum, dur, vel: 0.7 }); continue; }
      this.synth.play({ midi: midiOf(p) + (inst.oct || 0), program: part.program, sf: inst.sf, dur, vel: 0.7 });
    }
  }

  // pitch を入力する（キー・MIDI・画面鍵盤・タップ共通）
  // ドラム譜では、その位置のドラムにする（MIDI からなら GM の番号で）
  fitPitch(pitch, loc) {
    const stf = this.score.parts[loc.p]?.staves[loc.s];
    if (stf?.clef === 'percussion' && !pitch.drum) return P.drumPitch(P.drumAt(pitch));
    return pitch;
  }
  setDrum(id, d) {
    const f = E.findEvent(this.score, id);
    if (!f || f.ev.rest) return;
    const ni = this.state.sel?.noteIndex;
    f.ev.notes = f.ev.notes.map((n, i) => (ni == null || ni === i ? { ...P.drumPitch(d), tie: n.tie } : n));
  }
  setString(id, str) {
    const f = E.findEvent(this.score, id);
    if (!f || f.ev.rest) return;
    const ni = this.state.sel?.noteIndex;
    f.ev.notes.forEach((n, i) => { if (ni == null || ni === i) { if (str) n.str = str; else delete n.str; } });
  }
  enterPitch(pitch, opts = {}) {
    const st = this.state;
    if (st.mode !== 'input') this.setMode('input');
    pitch = this.fitPitch(pitch, opts.at || st.caret);
    const chord = opts.chord || st.chord;
    // 音は楽譜の書き直し（重い）より先に鳴らす：押した瞬間に聞こえるように
    if (!st.rest && !opts.quiet) this.audition([pitch], st.grace ? 0.2 : 0.45);
    // 装飾音符モード：カーソルの音符の前に付ける（カーソルは進まない）
    if (st.grace && !st.rest) {
      const loc = opts.at || st.caret;
      const type = ['eighth', '16th', '32nd'].includes(st.dur.type) ? st.dur.type : 'eighth';
      this.edit('装飾音符', () => { if (!K.addGrace(this.score, loc, pitch, { type, slash: type === 'eighth', chord })) return false; });
      st.lastPitch = pitch;
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
    if (!st.rest) st.lastPitch = pitch;
    this.refreshOverlays();
    // タップで入れたときは、見ている場所を動かさない（次にタップする場所がずれないように）
    if (!opts.at) this.revealCaret();
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
      const f0 = E.findEvent(this.score, id);
      if (f0 && this.score.parts[f0.p].staves[f0.s].clef === 'percussion') {
        // ドラム譜：上下でとなりの位置のドラムへ
        const order = [...new Set(P.DRUMS.map(d => diatonic(d)))].sort((x, y) => x - y);
        f0.ev.notes = f0.ev.notes.map((n, i) => {
          if (ni != null && ni !== i) return n;
          const k = order.indexOf(diatonic(n)) + Math.sign(amount) * (kind === 'octave' ? 3 : 1);
          const pos = order[Math.max(0, Math.min(order.length - 1, k))];
          return { ...P.drumPitch(P.drumAt(fromDiatonic(pos))), tie: n.tie };
        });
        return;
      }
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
  addSpan(k, text = null) {
    const st = this.state;
    const name = K.SPANS[k].ja;
    if (K.SPANS[k].custom && text == null) return this.dialogs.ask('文字＋線', '線の頭に書く文字（例：poco rit. / 8va bassa / sim.）', '', (v) => v != null && this.addSpan(k, v));
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
    this.edit(name, () => { for (const x of pairs) { const idx = K.addSpan(this.score, x.p, x.s, x.v, x.a, x.b, k); if (text) this.score.parts[x.p].staves[x.s].measures[Math.min(x.a.m, x.b.m)].spans[idx].text = text; made = { p: x.p, s: x.s, m: Math.min(x.a.m, x.b.m), idx }; } });
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
    if (ref.type === 'meas') return { ending: 'カッコ（1番・2番）', segno: 'セーニョ', coda: 'コーダ', fine: 'Fine', toCoda: 'To Coda', jump: K.JUMPS[this.score.measures[ref.m]?.jump]?.text || 'D.C./D.S.', reh: '練習番号', tempo: 'テンポ' }[ref.what] + `（第${ref.m + 1}小節）`;
    if (ref.type === 'stext') return `システムテキスト「${this.score.measures[ref.m]?.stext?.[ref.idx]?.text || ''}」`;
    const sm = this.score.parts[ref.p]?.staves[ref.s]?.measures[ref.m];
    if (ref.type === 'span') { const sp = sm?.spans?.[ref.idx]; return sp ? K.SPANS[sp.k].ja.replace(/（.*/, '') + `（第${ref.m + 1}〜${ref.m + sp.dm + 1}小節）` : '線'; }
    const d = sm?.dirs?.[ref.idx];
    if (!d) return '記号';
    return d.k === 'dyn' ? `強弱記号 ${d.v}` : d.k === 'chord' ? `コードネーム ${d.text}` : d.k === 'fret' ? `フレット図 ${d.text}` : `文字「${d.text}」`;
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
      if (r.type === 'meas') { if (r.what === 'tempo' && r.m === 0) return false; delete this.score.measures[r.m][r.what]; return true; }
      if (r.type === 'stext') { const ms = this.score.measures[r.m]; ms.stext.splice(r.idx, 1); if (!ms.stext.length) delete ms.stext; return true; }
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
    if (r.type === 'meas' && r.what === 'tempo') { this.state.sel = { kind: 'range', m1: r.m, m2: r.m, r1: 0, r2: 0, a: r.m, ra: 0 }; return this.dialogs.tempo(); }
    if (r.type === 'meas' && r.what === 'reh') { const ms = this.score.measures[r.m]; return this.dialogs.ask('練習番号', '空にすると自動（A, B, C …）', ms.reh?.text || '', (v) => this.edit('練習番号', () => { ms.reh = v ? { text: v } : {}; })); }
    if (r.type === 'meas') return this.dialogs.repeats(r.m);
    if (r.type === 'stext') { const d = this.score.measures[r.m].stext[r.idx]; return this.dialogs.ask('システムテキスト', '', d.text, (v) => v && this.edit('システムテキスト', () => { d.text = v; })); }
    if (r.type === 'span') return this.toast('線は ←→ / Shift+←→ で長さを変えられます');
    const d = this.score.parts[r.p]?.staves[r.s]?.measures[r.m]?.dirs?.[r.idx];
    if (!d) return;
    if (d.k === 'chord') {
      const at = E.eventAt(this.score, { p: r.p, s: r.s, m: r.m, v: 0, t: d.t }) || E.eventCovering(this.score, { p: r.p, s: r.s, m: r.m, v: 0, t: d.t });
      return at && this.startChords(at.ev.id);
    }
    if (d.k === 'dyn') return this.dialogs.marksMenu('expr', null);
    if (d.k === 'fret') return this.dialogs.ask('フレット図のコード', 'C / Am / G7 など', d.text, (v) => v && this.edit('フレット図', () => { d.text = v; }));
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
      value = ly ? ly.t + (ly.h ? '-' : '') + (ly.ext ? '_' : '') : '';
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
    if (k === '_' && te.kind === 'lyr') { e.preventDefault(); this.commitEditor(inp.value, false, true); return this.editorMove(1); }
    if (k === ' ' || (k === 'Tab' && !e.shiftKey)) { e.preventDefault(); this.commitEditor(inp.value, false); return this.editorMove(1); }
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
  commitEditor(raw, hyphen, ext = false) {
    const te = this.textEd;
    if (!te) return;
    const f = E.findEvent(this.score, te.id);
    if (!f) return;
    let text = String(raw || '').trim();
    if (te.kind === 'lyr') {
      if (text.endsWith('-')) { hyphen = true; text = text.replace(/-+$/, ''); }
      if (text.endsWith('_')) { ext = true; text = text.replace(/_+$/, ''); }
      const cur = f.ev.lyr?.[this.state.verse];
      if ((cur?.t || '') === text && (!text || (!!cur?.h === !!hyphen && !!cur?.ext === !!ext))) return;
      this.edit('歌詞', () => { K.setLyric(this.score, te.id, this.state.verse, text, hyphen); const ly = E.findEvent(this.score, te.id)?.ev.lyr?.[this.state.verse]; if (ly && ext) ly.ext = true; });
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
    const rl = document.querySelector('#rbPanel [data-cmd="partV"] .rl');
    if (rl) rl.firstChild.textContent = vo.part != null ? (this.score.parts[vo.part]?.abbr || 'パート') : 'スコア／パート';
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
      let nr = r + dir;
      while (rows[nr]?.kind === 'tab') nr += dir;
      nr = Math.max(0, Math.min(rows.length - 1, nr));
      if (rows[nr].kind === 'tab') return;
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
    if (this.live?.active) return this.live.stop();
    if (this.tools.rec.active) return this.tools.stopRec();
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
    if (this.live?.active) return this.live.stop();
    if (this.tools.rec.active) return this.tools.stopRec();
    if (this.player.playing) { this.player.stop(); this.updateUI(); return; }
    this.synth.ensure();
    const from = this.loop ? this.loop.m1 : this.playFrom ?? this.focusMeasure();
    this.playFrom = null;
    this.followPlay = true;
    document.getElementById('btnPlay').classList.add('on');
    const pb = this.score.settings.playback || {};
    const onLoop = this.loop && this.rampLoop ? () => {
      // くり返すたびに 5% ずつ速く（100% まで）
      this.setSpeed(Math.min(this.rampTo || 1, Math.round((this.speed + 0.05) * 100) / 100));
      this.toast(`速さ ${Math.round(this.speed * 100)}%`, 1000);
      return this.speed;
    } : null;
    await this.player.start(this.score, from, { click: !!pb.click, countIn: pb.click ? pb.countIn || 0 : 0, loop: this.loop || null, tempoScale: this.speed || 1, onLoop });
    this.updateUI();
  }
  setSpeed(v) {
    this.speed = v;
    const s = document.getElementById('rbSpeed'), l = document.getElementById('rbSpeedL');
    if (s) s.value = Math.round(v * 100);
    if (l) l.textContent = Math.round(v * 100) + '%';
    this.updateUI();
  }
  // 苦手な小節を、ゆっくり（70%）からくり返し聞く。くり返すたびに少しずつ速くなる
  listenSlowly(m1, m2 = m1) {
    if (this.player.playing) this.player.stop(true);
    this.loop = { m1, m2 };
    this.rampLoop = true;
    this.setSpeed(0.7);
    this.toast(`第${m1 + 1}${m2 > m1 ? '〜' + (m2 + 1) : ''}小節を 70% からくり返します（スペースで止める）`, 3000);
    this.togglePlay();
  }
  rewind() {
    if (this.player.playing) this.player.stop();
    this.playFrom = 0;
    this.view.scroller.scrollTo({ top: 0, behavior: 'smooth' });
    this.toast('先頭から再生します');
  }

  // ───────── MIDI ─────────
  midiNoteOn(note, vel, chordHeld, stamp) {
    const btn = document.getElementById('btnMidi');
    btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 120);
    const st = this.state;
    const heard = this.liveOn(note, vel); // 何より先に鳴らす
    if (this.live?.follow) { this.live.followNote(note, stamp); return; }
    if (this.tools.rec.active) { if (!this.tools.rec.o?.hum) this.tools.rec.noteOn(note, vel, stamp); return; }
    const cst = this.score.parts[st.caret.p]?.staves[st.caret.s];
    if (st.mode === 'input' && cst?.clef === 'percussion') return this.enterPitch(P.drumPitch(P.drumForGm(note)), { chord: chordHeld });
    if (st.mode !== 'input') return; // 選択モードでは音を鳴らすだけ（試し弾き）
    const fifths = this.L.attrs[st.caret.m]?.fifths || 0;
    const pitch = spellMidi(note, fifths);
    this.enterPitch(pitch, { chord: chordHeld, quiet: heard });
  }
  midiNoteOff(note, stamp) { this.synth.noteOff(note); if (this.tools.rec.active) this.tools.rec.noteOff(note, stamp); }
  // 鍵盤（MIDI キーボード・画面鍵盤）を押した音を、押しているあいだ鳴らす。戻り値 true = 鳴らした（入力のときに二重に鳴らさない）
  liveOn(note, vel = 90) {
    const rec = this.tools.rec;
    const part = this.score.parts[rec.active ? rec.o.p : this.state.mode === 'input' ? this.state.caret.p : 0] || this.score.parts[0];
    const inst = INST[part.inst] || {};
    if (part.staves.some(x => x.clef === 'percussion')) {
      if (rec.active) this.synth.play({ drum: P.drumForGm(note).id, vel: vel / 127 });
      return rec.active;
    }
    this.synth.loadSamples(inst.sf);
    this.synth.noteOn(note, { midi: note + (inst.oct || 0), program: part.program, sf: inst.sf, dur: 0.6, vel: vel / 127 });
    return true;
  }
  setReverb(name) {
    this.synth.setReverb(name);
    try { localStorage.setItem('kanade.reverb', name); } catch (e) { /* 使えない環境 */ }
    this.updateUI();
  }
  // ───────── 全画面 ─────────
  get isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  toggleFullscreen() {
    const d = document, el = d.documentElement;
    if (this.isFullscreen) return (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return this.toast('このブラウザは全画面に対応していません。ホーム画面に追加すると全画面で使えます', 3500);
    Promise.resolve(req.call(el)).catch(() => this.toast('全画面にできませんでした', 2500));
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
      else if (/\.midi?$/i.test(file.name)) score = importMidi(await file.arrayBuffer(), { title: file.name.replace(/\.midi?$/i, '') });
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
      if (this.home.visible) { this.home.canBack = true; this.home.hide(); }
      this.view.resetZoom();
      this.relayout();
      this.view.scroller.scrollTo({ top: 0, left: 0 });
      this.toast(`「${score.meta.title || file.name}」を開きました（${score.parts.length}パート・${score.measures.length}小節）`, 2600);
    } catch (e) {
      console.error(e);
      this.toast('読み込めませんでした：' + e.message, 3500);
    }
  }
  print() {
    this.state.sel = null;
    this.refreshOverlays();
    // 1段スクロール表示のときは、ページの形に直して印刷する
    const arr = this.viewOpts.arrange;
    if (arr === 'scroll') { this.viewOpts.arrange = 'vertical'; this.relayout(); }
    setTimeout(() => {
      window.print();
      if (arr === 'scroll') { this.viewOpts.arrange = arr; this.relayout(); }
    }, 80);
  }
  // ページを画像（PNG / SVG）に書き出す。PNG は 1ページずつ（複数ページなら番号つき）
  async exportImage(kind = 'png') {
    const L = layoutScore(this.score, { measureText: this.measureText, parts: this.viewOpts.part != null ? [this.viewOpts.part] : null, transposed: this.viewOpts.transposed });
    const css = `.paper{fill:#fff}text{stroke:none}.g{font-family:Bravura;font-size:4px}.gs{font-size:3px}.gg{font-size:2.48px}.cue{font-size:2.88px}.t{font-family:"Times New Roman","Hiragino Mincho ProN","Yu Mincho",serif}.title{font-weight:600}.mnum,.tempo-t{font-style:italic}.tempo-t{font-weight:600}polygon.beam,path.tie,path.slur{stroke:none}.hair,.ending,.tline,.fretgrid,.arpb,.strnum{fill:none}.tabn .tabbg{fill:#fff}`;
    const base = this.fileBaseName();
    let fontData = '';
    try { const buf = await (await fetch('fonts/Bravura.woff2')).arrayBuffer(); let bin = ''; const u8 = new Uint8Array(buf); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000)); fontData = `@font-face{font-family:Bravura;src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2")}`; } catch (e) { console.warn(e); }
    const svgOf = (pg, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${pg.w} ${pg.h}" fill="#111" stroke="#111"><style>${fontData}${css}</style>${pg.svg}</svg>`;
    const mmW = this.score.settings.page.w;
    try {
      for (let i = 0; i < L.pages.length; i++) {
        const pg = L.pages[i];
        const name = base + (L.pages.length > 1 ? `-${i + 1}` : '');
        if (kind === 'svg') {
          const svg = svgOf(pg, mmW + 'mm', (mmW * pg.h / pg.w) + 'mm');
          await saveFile(name + '.svg', new Blob([svg], { type: 'image/svg+xml' }), 'svg');
          continue;
        }
        // 300 dpi 相当の PNG
        const W = Math.round(mmW / 25.4 * 300), H = Math.round(W * pg.h / pg.w);
        const url = URL.createObjectURL(new Blob([svgOf(pg, W, H)], { type: 'image/svg+xml' }));
        const img = new Image();
        await new Promise((ok, ng) => { img.onload = ok; img.onerror = ng; img.src = url; });
        await new Promise(r => setTimeout(r, 60)); // フォントを読み込む時間
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H); cx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
        const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
        await saveFile(name + '.png', blob, 'png');
      }
      this.toast(`${L.pages.length}ページを ${kind.toUpperCase()} に書き出しました`);
    } catch (e) { console.error(e); this.toast('書き出せませんでした：' + e.message, 3500); }
  }
  // ページの並べ方
  setArrange(mode) {
    this.viewOpts.arrange = mode;
    try { localStorage.setItem('kanade.arrange', mode); } catch (e) { /* 使えない環境 */ }
    document.getElementById('pages').dataset.arrange = mode;
    this.relayout();
    this.view.resetZoom(); this.view.rescale(); this.afterZoom();
    this.view.scroller.scrollTo({ top: 0, left: 0 });
    this.toast({ vertical: 'ページを縦に並べています', horizontal: 'ページを横に並べています', spread: '見開き（2ページずつ）', scroll: '1段スクロール：横にスクロールして見ます' }[mode]);
  }
  setTheme(v) {
    this.theme = v;
    try { localStorage.setItem('kanade.theme', v); } catch (e) { /* 使えない環境 */ }
    this.applyTheme();
  }
  applyTheme() { if (this.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = this.theme; }
  insertMeasureBefore() { const m = this.targetMeasure(); this.edit('小節の挿入', () => E.appendMeasures(this.score, 1, m)); this.toast(`第${m + 1}小節の前に1小節挿入しました`); }

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
    $('btnHome').onclick = () => this.home.show('home');
    $('btnSearch').onclick = () => this.ribbon.openSearch();
    document.querySelectorAll('#statusbar [data-arr]').forEach(b => { b.onclick = () => this.setArrange(b.dataset.arr); });
    $('btnRec').onclick = () => (this.tools.rec.active ? this.tools.stopRec() : this.tools.hyperscribe());
    $('btnTempo').onclick = () => this.dialogs.tempo();
    $('docTitle').onclick = () => this.dialogs.scoreInfo();
    $('btnHelp').onclick = () => this.dialogs.help();
    $('btnMidi').onclick = () => this.dialogs.midi();
    $('btnFull').onclick = () => this.toggleFullscreen();
    if (navigator.standalone) $('btnFull').hidden = true; // ホーム画面に追加したアプリは、最初から全画面
    const onFull = () => { $('btnFull').classList.toggle('on', this.isFullscreen); this.view.onResize(); this.afterZoom(); this.ribbon?.update(); };
    document.addEventListener('fullscreenchange', onFull);
    document.addEventListener('webkitfullscreenchange', onFull);
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
      window.launchQueue.setConsumer(async (p) => { const h = p.files && p.files[0]; if (h) { await this.openFile(await h.getFile(), h); } });
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

    // iPad の入力モード：1本指＝入力、2本指＝移動とピンチ拡大、2本指タップ＝元に戻す（CSS で touch-action: none にしてある）
    const sc = this.view.scroller;
    const touches = new Map();
    let twoFinger = false; // 2本指の操作中。指が全部離れるまで入力しない
    let firstT = 0, together = false; // 2本がほぼ同時に触れたか（2本指タップは、交互にたたいたときには働かせない）
    const isText = (el) => el && el.closest && el.closest('input, textarea, [contenteditable]');
    sc.addEventListener('touchstart', (e) => { if (this.state.mode === 'input' && !isText(e.target)) e.preventDefault(); }, { passive: false });
    sc.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || this.state.mode !== 'input') return;
      // 最初の指なら、取り残された指の記録を消す（楽譜を描き直すと、指を離した知らせが届かないことがある）
      if (e.isPrimary) { touches.clear(); twoFinger = false; this.view.pan = null; firstT = e.timeStamp; }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        together = e.timeStamp - firstT < 150;
        if (drag) { clearTimeout(drag.soundT); clearTimeout(this.lpT); drag = null; }
        this.view.hideOverlay('ghost');
        twoFinger = true;
        this.view.panStart([...touches.values()]);
      }
      if (twoFinger) e.stopPropagation();
    }, true);
    sc.addEventListener('pointermove', (e) => {
      const t = touches.get(e.pointerId);
      if (!t) return;
      t.x = e.clientX; t.y = e.clientY;
      if (!twoFinger) return;
      e.stopPropagation();
      if (touches.size >= 2) this.view.panMove([...touches.values()]);
    }, true);
    const lift = (e) => {
      if (!touches.delete(e.pointerId) || !twoFinger) return;
      e.stopPropagation();
      if (touches.size < 2 && this.view.pan) { const r = this.view.panEnd(); if (r?.tap && together) this.undo(); }
      if (!touches.size) twoFinger = false;
    };
    window.addEventListener('pointerup', lift, true);
    window.addEventListener('pointercancel', lift, true);
    // iPad Safari：素早く2回タップしても、画面全体が拡大されないように
    let lastEnd = 0;
    document.addEventListener('touchend', (e) => {
      const quick = e.timeStamp - lastEnd < 350;
      lastEnd = e.timeStamp;
      if (quick && e.cancelable && !e.target.closest('input, select, textarea, [contenteditable], button, a, label, #pages')) e.preventDefault();
    }, { passive: false });
    document.addEventListener('gesturestart', (e) => e.preventDefault());

    pagesEl.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      this.synth.ensure();
      const pt = this.view.locate(e.clientX, e.clientY);
      const h = this.view.hit(pt);
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, type: e.pointerType, h, moved: false, lockScroll: e.pointerType === 'pen' };
      const st = this.state;
      this.view.ghostLift = e.pointerType === 'touch'; // 指で隠れないように、音名を高い位置に出す
      if (st.mode === 'input' && h) {
        this.updateGhost(h);
        // 押した瞬間に鳴らす（音符が入るのは離したとき）。指は2本指の操作かもしれないので、ほんの少しだけ待つ
        const d1 = drag;
        const hear = () => {
          if (drag !== d1 || st.rest) return;
          const fp = this.fitPitch(this.concertOf(h.pitch, h.p), h);
          d1.heard = fp.drum ? fp.drum : midiOf(fp);
          this.audition([fp], 0.45, h.p);
        };
        if (e.pointerType === 'touch') d1.soundT = setTimeout(hear, 30); else hear();
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
      // iPad：長押しで右クリックと同じメニュー（選択モードのとき。指でもペンでも）
      clearTimeout(this.lpT);
      if (e.pointerType !== 'mouse' && st.mode === 'select' && h) {
        const d0 = drag, cx = e.clientX, cy = e.clientY;
        this.lpT = setTimeout(() => {
          if (drag !== d0 || d0.moved) return;
          d0.longPressed = true;
          const mk = this.view.hitMark(pt);
          const near = this.view.nearestEvent(h);
          if (mk && !(near && near.d < 0.6)) this.markMenu(mk, { clientX: cx, clientY: cy });
          else this.contextMenu(h, { clientX: cx, clientY: cy });
        }, 550);
      }
    });

    pagesEl.addEventListener('pointermove', (e) => {
      const st = this.state;
      if (e.pointerType === 'mouse') this.mouseAt = { x: e.clientX, y: e.clientY };
      if (!drag || drag.id !== e.pointerId) {
        // マウスを乗せただけのとき：入力モードはゴースト音符、選択モードは音符をうっすら色付け
        if (e.pointerType !== 'mouse') return;
        const pt = this.view.locate(e.clientX, e.clientY);
        const h = this.view.hit(pt);
        if (st.mode === 'input') { this.view.hover(null); pagesEl.style.cursor = ''; this.updateGhost(h); }
        else this.hoverAt(h, pt);
        return;
      }
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 8) { drag.moved = true; clearTimeout(this.lpT); }
      const h = this.view.hit(this.view.locate(e.clientX, e.clientY));
      // 入力モード：指は少し動いても押した高さのまま（ぶれ防止）。はっきり動かしたら高さが変わり、その音を聞かせる
      if (st.mode === 'input' && (drag.type !== 'touch' || drag.moved)) {
        this.updateGhost(h);
        if (h && !st.rest && drag.heard != null) {
          const fp = this.fitPitch(this.concertOf(h.pitch, h.p), h), key = fp.drum ? fp.drum : midiOf(fp);
          if (key !== drag.heard) { drag.heard = key; this.audition([fp], 0.25, h.p); }
        }
      }
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
      clearTimeout(this.lpT);
      if (d.longPressed) return;
      const st = this.state;
      if (d.pitchDrag) { if (d.pitchDrag.applied) this.scheduleSave(); return; }
      if (d.rangeDone) { this.lastRangeTap = 0; return; }
      clearTimeout(d.soundT);
      if (cancel || (d.moved && d.type === 'touch' && st.mode !== 'input')) { if (e.pointerType !== 'mouse') this.view.hideOverlay('ghost'); return; }
      const pt = this.view.locate(e.clientX, e.clientY);
      // 指：動かしていなければ押した高さのまま。五線の外へすべらせて離すと取り消し
      const h = d.type === 'touch' && st.mode === 'input' ? (d.moved ? this.view.hit(pt) : d.h) : this.view.hit(pt) || d.h;
      if (e.pointerType !== 'mouse') this.view.hideOverlay('ghost');
      if (st.mode === 'select') return this.tapSelect(h, e, pt);
      if (h) this.tapInput(h, e, d.heard);
    };
    pagesEl.addEventListener('pointerup', (e) => finish(e, false));
    pagesEl.addEventListener('pointercancel', (e) => finish(e, true));
    pagesEl.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { this.mouseAt = null; this.view.hideOverlay('ghost'); this.view.hover(null); } });
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
      { label: 'アーティキュレーション…', kbd: '▸', run: () => this.ribbon.openGallery('artic', pt) },
      { label: '装飾記号・トリル…', kbd: '▸', run: () => this.ribbon.openGallery('orn', pt) },
      { label: '強弱・表情記号…', kbd: 'X', run: () => this.dialogs.marksMenu('expr', pt) },
      { label: sel.to || sel.kind === 'range' ? 'スラー（選んだ範囲）' : 'スラー（次の音符まで）', kbd: 'S', run: () => this.addSpan('slur') },
      { label: 'クレッシェンド ／ デクレッシェンド…', kbd: '< >', run: () => this.dialogs.marksMenu('lines', pt) },
      { label: '歌詞を入力', kbd: 'L', run: () => this.startLyrics() });
    if (f) items.push({ label: 'コードネームを入力', kbd: 'K', run: () => this.startChords() });
    if (f && !sel.to) items.push({ label: '装飾音符を付ける', kbd: ';', run: () => { this.setMode('input'); if (!this.state.grace) this.toggleGrace(); } });
    if (f?.ev.grace) items.push({ label: '装飾音符を消す', run: () => this.edit('装飾音符の削除', () => { delete E.findEvent(this.score, f.ev.id).ev.grace; }) });
    if (f?.ev.art) items.push({ label: 'アーティキュレーションを全部外す', run: () => this.edit('アーティキュレーション', () => K.clearArtics(this.score, this.selIds())) });
    items.push({ label: '反復記号・カッコ…', run: () => this.dialogs.repeats() });
    // Phase 4
    if (isNote) items.push({ label: '符尾の向きを反転', kbd: 'Shift+X', run: () => this.flipStem() }, { label: '音程を重ねる…', kbd: '▸', run: () => this.dialogs.menu(pt, [{ head: '音程を重ねる' }, ...[3, 4, 5, 6, 8].map(n => ({ label: `上に ${n === 8 ? 'オクターブ' : n + '度'}`, run: () => this.addInterval(n, 1) })), ...[3, 6, 8].map(n => ({ label: `下に ${n === 8 ? 'オクターブ' : n + '度'}`, run: () => this.addInterval(n, -1) }))]) });
    if (f || sel.kind === 'range') items.push({ label: 'くり返し（すぐ後ろにもう一度）', kbd: 'R', run: () => this.repeatSelection() });
    items.push({ label: '記号パレットを開く', kbd: 'F9', run: () => this.ribbon.togglePanel(true) });
    // Phase 3：ドラム・TAB・一括編集
    const fst = f && this.score.parts[f.p].staves[f.s];
    if (isNote && fst?.clef === 'percussion') items.push({ label: 'ドラムの種類…', kbd: '▸', run: () => this.tools.drumMenu(pt) });
    if (isNote && this.score.parts[f.p].staves.some(x => x.tabOf != null)) items.push({ label: '弦の指定・チューニング（TAB）…', kbd: '▸', run: () => this.tools.stringMenu(pt, this.score.parts[f.p]) });
    if (sel.kind === 'range' || f) items.push({ label: '一括編集…', kbd: '▸', run: () => this.dialogs.menu(pt, [{ head: '一括編集' }, ...this.tools.massItems()]) });
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
  tapInput(h, e, heard = null) {
    const st = this.state;
    const tg = this.resolveInputTarget(h);
    const loc = { p: h.p, s: h.s, m: h.m, v: st.voice, t: tg.t };
    let pitch = this.concertOf(h.pitch, h.p); // 記譜音で表示中なら実音にして入れる
    if (h.tabStr) pitch = { ...pitch, str: h.tabStr }; // TAB をタップ：その弦の開放弦
    const fp = this.fitPitch(pitch, h);
    const quiet = heard != null && heard === (fp.drum ? fp.drum : midiOf(fp)); // 押したときに同じ高さを鳴らし済み
    // 和音モード or Shift：そのタイミングにある音符へ足す（装飾音符モードなら装飾音の和音）
    if ((st.chord || e.shiftKey) && !st.rest && !st.grace) {
      const at = E.eventAt(this.score, loc);
      if (at && !at.ev.rest) {
        st.lastId = at.ev.id;
        if (!quiet) this.audition([pitch], 0.45, h.p);
        this.edit('和音に追加', () => E.addToChord(this.score, at.ev.id, pitch));
        st.lastPitch = pitch;
        return;
      }
    }
    st.caret = loc;
    if (st.rest) this.enterRest({ at: loc });
    else this.enterPitch(pitch, { at: loc, chord: st.grace && e.shiftKey, quiet });
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

  // ───────── Phase 4：記号パレットから付けるもの・MuseScore / Finale の便利な編集 ─────────
  // 和音の中の1音だけを選んでいるとき、その音の番号（それ以外は null = 全部の音）
  selNoteIndex() { const s = this.state.sel; return this.state.mode === 'select' && s?.kind === 'event' && !s.to ? s.noteIndex ?? null : null; }
  // 音符そのものの設定（アルペジオ・トレモロ・小さい音符・符尾・連桁・スラッシュ）。同じものをもう一度で外す
  setEvProp(prop, value, label) {
    const ids = this.selIds();
    if (!ids.length) return this.toast('先に音符を選ぶか入力してください');
    let on = null;
    this.edit(label, () => { on = K.setEventProp(this.score, ids, prop, value); if (on === null) return false; });
    if (on === null) return this.toast('休符には付けられません');
    this.toast(on ? label : label + '：外しました');
  }
  // 1つ1つの音の設定（符頭の形・運指・括弧）
  setNoteProp(prop, value, label) {
    const ids = this.selIds();
    if (!ids.length) return this.toast('先に音符を選ぶか入力してください');
    let on = null;
    this.edit(label, () => { on = K.setNoteProp(this.score, ids, prop, value, this.selNoteIndex()); if (on === null) return false; });
    if (on === null) return this.toast('休符には付けられません');
    this.toast(on ? label : label + '：元に戻しました');
  }
  // 弦番号 ①〜⑥（TAB の弦の指定と同じ値。五線にも丸数字で出す）
  setStringNum(n) {
    const ids = this.selIds();
    if (!ids.length) return this.toast('先に音符を選ぶか入力してください');
    const ni = this.selNoteIndex();
    this.edit('弦番号', () => {
      let any = false;
      for (const id of ids) {
        const ev = E.findEvent(this.score, id)?.ev;
        if (!ev || ev.rest) continue;
        ev.notes.forEach((x, i) => {
          if (ni != null && ni !== i) return;
          any = true;
          if (x.strMark && x.str === n) { delete x.strMark; delete x.str; } else { x.str = n; x.strMark = true; }
        });
      }
      if (!any) return false;
    });
  }
  // 小節線・反復の線を付ける小節（範囲なら最後の小節）
  barTarget() { const s = this.state.sel; return s?.kind === 'range' ? s.m2 : this.focusMeasure(); }
  setBarline(type) {
    const s = this.state.sel;
    const m = this.barTarget();
    const m1 = s?.kind === 'range' ? s.m1 : m;
    this.edit('小節線', () => {
      const ms = this.score.measures;
      if (type === 'repeatStart') { if (ms[m1].repeatStart) delete ms[m1].repeatStart; else ms[m1].repeatStart = true; return; }
      if (type === 'repeatEnd') { if (ms[m].repeatEnd) delete ms[m].repeatEnd; else ms[m].repeatEnd = { times: 2 }; return; }
      if (type === 'repeatBoth') { ms[m1].repeatStart = true; ms[m].repeatEnd = { times: 2 }; return; }
      if (!type || type === 'normal' || ms[m].barline === type) delete ms[m].barline; else ms[m].barline = type;
    });
    this.toast(type === 'normal' ? '普通の小節線にしました' : (K.BARLINES[type]?.ja || { repeatStart: '反復の始まり', repeatEnd: '反復の終わり', repeatBoth: '反復（|: 〜 :|）' }[type] || '小節線') + `（第${m + 1}小節）`);
  }
  // 音部記号・調号・拍子を、選んでいる小節（入力モードならカーソルの小節）から変える
  insertClef(clef) {
    const loc = this.state.mode === 'input' ? this.state.caret : this.selLoc();
    if (!loc) return this.toast('音部記号を変える譜表の小節を選んでください');
    const s = this.state.sel;
    const rows = s?.kind === 'range' ? this.L.rows.slice(s.r1, s.r2 + 1).filter(r => r.kind !== 'tab') : [{ p: loc.p, s: loc.s }];
    this.edit('音部記号', () => { for (const r of rows) E.setClef(this.score, r.p, r.s, loc.m, clef); });
    this.setLastPitchForStaff();
    this.toast(`${CLEFS[clef]?.ja || '音部記号'}（第${loc.m + 1}小節から）`);
  }
  insertKey(fifths) {
    const m = this.targetMeasure();
    this.edit('調号の変更', () => E.setKey(this.score, m, fifths));
    this.toast(`調号：${keyNameJa(fifths)}（第${m + 1}小節から）`);
  }
  // 拍子の変更：音符は新しい小節線で組み直す（rebar = false なら今までどおり切り捨て）
  insertTime(time, rebarNotes = true) {
    const m = this.targetMeasure();
    let r = null;
    this.edit('拍子の変更', () => { if (rebarNotes) r = rebar(this.score, m, time); else E.setTime(this.score, m, time); });
    this.state.sel = null;
    this.state.caret = { ...this.state.caret, m: Math.min(this.state.caret.m, this.score.measures.length - 1), t: 0 };
    this.refreshOverlays(); this.updateUI();
    this.toast(`拍子：${time.symbol === 'common' ? 'C' : time.symbol === 'cut' ? '¢' : time.beats + '/' + time.beatType}（第${m + 1}小節から${r ? `・${r.count}小節に組み直しました` : ''}）`, 2600);
  }
  // 練習番号（自動で A, B, C …）。同じ小節でもう一度押すと外す
  toggleRehearsal(text = null) {
    const m = this.targetMeasure();
    this.edit('練習番号', () => { const ms = this.score.measures[m]; if (ms.reh && !text) delete ms.reh; else ms.reh = text ? { text } : {}; });
    this.toast(this.score.measures[m].reh ? `練習番号を付けました（第${m + 1}小節）` : '練習番号を外しました');
  }
  // システムテキスト（全パートに出る文字。パート譜にも出る）
  addSystemText(text) {
    const a = this.markAnchor();
    if (!a) return this.toast('文字を付ける小節か音符を選んでください');
    if (!text) return;
    this.edit('システムテキスト', () => { const ms = this.score.measures[a.m]; (ms.stext || (ms.stext = [])).push({ t: a.t, text }); });
  }
  // ギターのフレット図（その位置のコードネームか、入力したコード）
  addFret(name) {
    const a = this.markAnchor();
    if (!a) return this.toast('フレット図を付ける音符を選んでください');
    const sm = this.score.parts[a.p].staves[a.s].measures[a.m];
    const chord = name || (sm.dirs || []).find(d => d.k === 'chord' && d.t === a.t)?.text;
    if (!chord) return this.dialogs.ask('フレット図のコード', 'C / Am / G7 / F#m など', '', (v) => v && this.addFret(v));
    if (!K.fretShape(chord)) this.toast(`「${chord}」の押さえ方は登録がないので、名前だけ表示します`, 2600);
    this.edit('フレット図', () => K.addDir(this.score, a.p, a.s, a.m, { t: a.t, k: 'fret', text: chord }));
  }
  // テンポ記号（Allegro など）。bpm は拍の単位（unit）あたり
  setTempoMark(text, bpm, unit = 'quarter') {
    const m = this.targetMeasure();
    this.edit('テンポ', () => { this.score.measures[m].tempo = { bpm, ...(text ? { text } : {}), ...(unit !== 'quarter' ? { unit } : {}) }; });
    this.toast(`テンポ：${text ? text + ' ' : ''}${bpm}（第${m + 1}小節から）`);
  }
  // 小節の繰り返し記号（直前の小節をもう一度）
  toggleMeasureRepeat() {
    const rg = this.rangeOrMeasure();
    if (!rg) return this.toast('小節を選んでください');
    const A = measureAttrs(this.score);
    let on = null;
    this.edit('小節の繰り返し', () => {
      for (const [p, s] of rg.staves) for (let m = Math.max(1, rg.m1); m <= rg.m2; m++) {
        const sm = this.score.parts[p].staves[s].measures[m];
        if (on === null) on = !sm.mrep;
        if (on) { sm.mrep = 1; sm.voices = [[measureRest(A[m].len)]]; } else delete sm.mrep;
      }
      if (on === null) return false;
    });
    if (on === null) this.toast('1小節目には付けられません');
  }
  // スラッシュで埋める（コード譜のリズム譜。拍ごとに斜線。音は鳴らない）
  fillSlashes() {
    const rg = this.rangeOrMeasure();
    if (!rg) return this.toast('小節を選んでください');
    this.edit('スラッシュで埋める', () => {
      const A = measureAttrs(this.score);
      for (const [p, s] of rg.staves) for (let m = rg.m1; m <= rg.m2; m++) {
        const a = A[m], bt = beatTicks(a.time);
        const tt = ticksToType(bt, 1) || { type: 'quarter', dots: 0 };
        const st = this.score.parts[p].staves[s];
        const pitch = fromDiatonic(clefInfo(clefAt(st, m)).mid);
        const evs = [];
        for (let t = 0; t + bt <= a.len; t += bt) evs.push({ id: newId(), rest: false, type: tt.type, dots: tt.dots, notes: [{ ...pitch }], slash: true });
        if (evs.length) st.measures[m].voices = [evs];
      }
    });
  }
  // くり返し（MuseScore の R）：選んだ範囲をすぐ後ろにもう一度。足りなければ小節を足す
  repeatSelection() {
    const st = this.state, s = st.sel;
    if (s?.kind === 'range') {
      const rg = this.rangeStaves(s);
      const clip = E.copyRange(this.score, rg);
      const n = rg.m2 - rg.m1 + 1;
      this.edit('くり返し', () => E.pasteRange(this.score, clip, { m: rg.m2 + 1, staves: rg.staves }));
      st.sel = { ...s, m1: s.m1 + n, m2: s.m2 + n, a: s.m1 + n };
      this.refreshOverlays(); this.updateUI();
      const g = this.L.measures[st.sel.m1];
      if (g) this.view.ensureVisible(this.L.systems[g.sys].page, g.x0, this.L.systems[g.sys].staffYs[0]);
      return;
    }
    if (s?.kind === 'event') {
      const f = E.findEvent(this.score, s.to || s.id);
      if (!f) return;
      const nx = E.caretNext(this.score, { p: f.p, s: f.s, m: f.m, v: f.v, t: f.t });
      let r;
      this.edit('くり返し', () => { r = E.enterNote(this.score, nx, { type: f.ev.type, dots: f.ev.dots, pitches: f.ev.rest ? null : f.ev.notes.map(n => ({ step: n.step, alter: n.alter, octave: n.octave })) }); });
      if (r) { st.sel = { kind: 'event', id: r.ids[0], noteIndex: null }; this.afterSelect(E.findEvent(this.score, r.ids[0])?.ev); }
      return;
    }
    this.toast('くり返す音符か小節を選んでください');
  }
  // 声部1 と 声部2 を入れ替える
  swapVoices() {
    const rg = this.rangeOrMeasure();
    if (!rg) return this.toast('小節を選んでください');
    this.edit('声部の入れ替え', () => {
      const A = measureAttrs(this.score);
      for (const [p, s] of rg.staves) for (let m = rg.m1; m <= rg.m2; m++) {
        const sm = this.score.parts[p].staves[s].measures[m];
        const v0 = sm.voices[0], v1 = sm.voices[1];
        sm.voices[0] = v1 && v1.length ? v1 : [measureRest(A[m].len)];
        if (v0 && v0.some(e => !e.rest)) sm.voices[1] = v0; else sm.voices.length = 1;
      }
    });
  }
  // 音程を重ねる（MuseScore の Alt+数字）：選んだ音の上（dir=-1 で下）に n 度の音を足す
  addInterval(n, dir = 1) {
    const ids = this.selIds();
    if (!ids.length) return this.toast('先に音符を選ぶか入力してください');
    let last = null;
    this.edit(`${n}度を重ねる`, () => {
      let any = false;
      for (const id of ids) {
        const f = E.findEvent(this.score, id);
        if (!f || f.ev.rest) continue;
        const base = dir > 0 ? f.ev.notes[f.ev.notes.length - 1] : f.ev.notes[0];
        const q = fromDiatonic(diatonic(base) + dir * (n - 1));
        q.alter = keyAlter(this.L.attrs[f.m].fifths, q.step);
        E.addToChord(this.score, id, q);
        last = q; any = true;
      }
      if (!any) return false;
    });
    if (last) this.audition([last]);
  }
  // 符尾の向きを反転（MuseScore の X）。auto = 自動に戻す
  flipStem(auto = false) {
    const ids = this.selIds();
    if (!ids.length) return this.toast('先に音符を選んでください');
    this.edit('符尾の向き', () => {
      for (const id of ids) {
        const ev = E.findEvent(this.score, id)?.ev;
        if (!ev || ev.rest) continue;
        if (auto) { delete ev.stem; continue; }
        const g = this.L.evGeom[id];
        ev.stem = g && g.up ? 'down' : 'up';
      }
    });
  }
  // 小節の幅を広げる / 狭める（MuseScore の { }）
  stretchMeasures(factor) {
    const rg = this.rangeOrMeasure();
    if (!rg) return this.toast('小節を選んでください');
    this.edit('小節の幅', () => {
      for (let m = rg.m1; m <= rg.m2; m++) {
        const ms = this.score.measures[m];
        if (!factor) { delete ms.stretch; continue; }
        const v = Math.max(0.4, Math.min(4, (ms.stretch || 1) * factor));
        if (Math.abs(v - 1) < 0.04) delete ms.stretch; else ms.stretch = +v.toFixed(3);
      }
    });
  }
  // 選んでいる小節の範囲（選んでいなければ、選んだ音符・カーソルのある小節1つ）
  rangeOrMeasure() {
    const s = this.state.sel;
    if (s?.kind === 'range') return this.rangeStaves(s);
    const loc = this.state.mode === 'input' ? this.state.caret : this.selLoc();
    return loc ? { m1: loc.m, m2: loc.m, staves: [[loc.p, loc.s]] } : null;
  }
  // 第◯小節へ移動（Ctrl+G）。練習番号（A, B …）でも
  gotoMeasure(v) {
    if (v == null) return this.dialogs.ask('小節へ移動', '小節番号（例：25）か練習番号（例：B）', '', (x) => x && this.gotoMeasure(x));
    const reh = K.rehearsalLabels(this.score);
    let m = Object.keys(reh).find(k => reh[k].toUpperCase() === String(v).trim().toUpperCase());
    m = m != null ? +m : (parseInt(v, 10) || 0) - 1;
    if (!(m >= 0 && m < this.score.measures.length)) return this.toast('その小節はありません');
    this.state.mode = 'select';
    this.state.sel = { kind: 'range', m1: m, m2: m, r1: 0, r2: 0, a: m, ra: 0 };
    this.refreshOverlays(); this.updateUI();
    const g = this.L.measures[m], sy = this.L.systems[g.sys];
    this.view.ensureVisible(sy.page, g.x0, sy.staffYs[0], 160);
    this.toast(`第${m + 1}小節`);
  }
  // ループ再生（選んだ小節の範囲をくり返し再生）
  toggleLoop() {
    const s = this.state.sel;
    if (this.loop) { this.loop = null; this.toast('ループ再生：オフ'); }
    else {
      const m1 = s?.kind === 'range' ? s.m1 : this.focusMeasure(), m2 = s?.kind === 'range' ? s.m2 : m1;
      this.loop = { m1, m2 };
      this.toast(`ループ再生：第${m1 + 1}〜${m2 + 1}小節`);
    }
    if (this.player.playing) { this.player.stop(true); this.togglePlay(); }
    this.updateUI();
  }

  staffRows() { return staffList(this.score); }
  get E() { return E; }
  // 小節の挿入位置など（選択 or カーソルの小節）
  targetMeasure() { return this.focusMeasure(); }
  durTicks() { return dottedTicks(this.state.dur.type, this.state.dur.dots); }
  pitchLabel(p) { return pitchName(p); }
}
export { TPQ };
