// アプリ本体：状態（楽譜・カーソル・選択・入力設定）を持ち、操作を楽譜に反映して再描画する
import { createScore, measureAttrs, INST, clefInfo, staffList } from './core/score.js';
import * as E from './core/edit.js';
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
import { storage, saveFile } from './io/storage.js';
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
    };
    this.history = new History();
    this.synth = new Synth();
    this.player = new Player(this.synth);
    this.docId = null;
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
    this.view.zoom = this.view.fitZoom();
    this.relayout();
    window.addEventListener('resize', () => { this.view.rescale(); this.afterZoom(); });
  }

  // ───────── ドキュメント ─────────
  newDoc(score) {
    this.score = score;
    this.docId = storage.newId();
    this.history.clear();
    this.state.sel = null; this.state.caret = { p: 0, s: 0, m: 0, v: 0, t: 0 }; this.state.lastId = null; this.state.voice = 0;
    this.setLastPitchForStaff();
    this.save();
  }
  openDoc(doc) {
    this.score = doc.score;
    this.docId = doc.id;
    this.history.clear();
    this.state.sel = null; this.state.caret = { p: 0, s: 0, m: 0, v: 0, t: 0 }; this.state.lastId = null; this.state.voice = 0;
    this.setLastPitchForStaff();
    try { localStorage.setItem('kanade.last', doc.id); } catch (e) { /* プライベートモード */ }
  }
  async save() {
    if (!this.score) return;
    clearTimeout(this.saveTimer);
    const doc = { id: this.docId, title: this.score.meta.title || '無題', updated: Date.now(), score: this.score };
    try {
      await storage.put(doc);
      localStorage.setItem('kanade.last', this.docId);
    } catch (e) { console.warn('保存失敗', e); }
  }
  scheduleSave() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 700); }

  // ───────── 描画 ─────────
  relayout() {
    const t0 = performance.now();
    this.L = layoutScore(this.score, { measureText: this.measureText });
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
    if (st.sel?.kind === 'event') ids.push(st.sel.id);
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
    document.getElementById('docTitle').textContent = this.score.meta.title || '無題';
    document.title = (this.score.meta.title || '無題') + ' — KANADE';
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
      parts.push(`${TYPE_JA[st.dur.type]}${st.dur.dots ? '（付点）' : ''}${st.rest ? '・休符' : ''}${st.chord ? '・和音' : ''}`);
    } else if (st.sel?.kind === 'event') {
      const f = E.findEvent(this.score, st.sel.id);
      if (f) {
        const desc = f.ev.rest ? '休符' : f.ev.notes.map(n => `${pitchName(n)}（${STEP_JA[n.step]}）`).join(' + ');
        parts.push(`選択：${part?.name || ''} 第${f.m + 1}小節 · ${desc} · ${TYPE_JA[f.ev.type]}${f.ev.dots ? '（付点）' : ''}`);
      }
    } else if (st.sel?.kind === 'range') {
      parts.push(`範囲選択：第${st.sel.m1 + 1}〜${st.sel.m2 + 1}小節`);
    } else parts.push('選択モード');
    document.getElementById('status').textContent = parts.join('　');
    document.getElementById('hint').textContent = st.mode === 'input'
      ? '五線をタップ／A〜G キー／MIDI鍵盤で入力 · Esc で選択モード'
      : '音符をタップで選択 · 上下ドラッグで音高 · 小節の空きをタップで小節選択 · N で入力';
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
      if (st.lastId && E.findEvent(this.score, st.lastId)) st.sel = { kind: 'event', id: st.lastId, noteIndex: null };
    }
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
  pitchForLetter(step) {
    const lp = this.state.lastPitch;
    const ld = diatonic(lp);
    let best = null;
    for (let o = lp.octave - 1; o <= lp.octave + 1; o++) {
      const d = Math.abs(diatonic({ step, octave: o }) - ld);
      if (!best || d < best.d) best = { d, o };
    }
    const A = this.L.attrs;
    const m = this.state.mode === 'input' ? this.state.caret.m : (this.selLoc()?.m ?? 0);
    return { step, alter: keyAlter(A[m]?.fifths || 0, step), octave: best.o };
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

  // ───────── カーソル・選択の移動 ─────────
  moveCaret(dir) {
    const st = this.state;
    if (st.mode === 'input') {
      st.caret = dir > 0 ? E.caretNext(this.score, st.caret) : E.caretPrev(this.score, st.caret);
      this.revealCaret(); this.updateUI();
      return;
    }
    if (st.sel?.kind === 'event') {
      const f = E.findEvent(this.score, st.sel.id);
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
    const name = (this.score.meta.title || 'score').replace(/[\\/:*?"<>|]/g, '_') + '.musicxml';
    await saveFile(name, new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }));
  }
  async importFile(file) {
    try {
      let xml;
      if (/\.mxl$/i.test(file.name)) xml = await readMxl(await file.arrayBuffer());
      else xml = await file.text();
      const score = importMusicXML(xml);
      if (!score.meta.title || score.meta.title === '無題') score.meta.title = file.name.replace(/\.(musicxml|xml|mxl)$/i, '');
      this.newDoc(score);
      this.view.zoom = this.view.fitZoom();
      this.relayout();
      this.view.scroller.scrollTo({ top: 0 });
      this.toast(`「${score.meta.title}」を読み込みました（${score.parts.length}パート・${score.measures.length}小節）`, 2600);
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
    $('zoomLabel').onclick = () => this.view.setZoom(this.view.fitZoom());
    $('btnFile').onclick = (e) => this.dialogs.fileMenu(e.currentTarget);
    $('btnMeasure').onclick = (e) => this.dialogs.measureMenu(e.currentTarget);
    $('btnScore').onclick = (e) => this.dialogs.scoreMenu(e.currentTarget);
    $('btnTempo').onclick = () => this.dialogs.tempo();
    $('docTitle').onclick = () => this.dialogs.scoreInfo();
    $('btnHelp').onclick = () => this.dialogs.help();
    $('btnMidi').onclick = () => this.dialogs.midi();
    document.querySelector('#btnTempo .note-glyph').textContent = G.metNoteQuarterUp.c;
    $('fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) this.importFile(f); e.target.value = ''; };
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
        }
      }
      if (drag.lockScroll || e.pointerType === 'mouse') { try { pagesEl.setPointerCapture(e.pointerId); } catch (err) { /* 未対応 */ } }
    });

    pagesEl.addEventListener('pointermove', (e) => {
      const st = this.state;
      if (!drag || drag.id !== e.pointerId) {
        // マウスのホバーでゴースト音符
        if (e.pointerType === 'mouse' && st.mode === 'input') this.updateGhost(this.view.hit(this.view.locate(e.clientX, e.clientY)));
        return;
      }
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 8) drag.moved = true;
      const h = this.view.hit(this.view.locate(e.clientX, e.clientY));
      if (st.mode === 'input' && (drag.type !== 'touch' || !drag.moved)) this.updateGhost(h);
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
      if (cancel || (d.moved && d.type === 'touch')) { if (e.pointerType !== 'mouse') this.view.hideOverlay('ghost'); return; }
      const h = this.view.hit(this.view.locate(e.clientX, e.clientY)) || d.h;
      if (e.pointerType !== 'mouse') this.view.hideOverlay('ghost');
      if (!h) { if (st.mode === 'select') { st.sel = null; this.refreshOverlays(); this.updateUI(); } return; }
      if (st.mode === 'input') this.tapInput(h, e);
      else this.tapSelect(h, e);
    };
    pagesEl.addEventListener('pointerup', (e) => finish(e, false));
    pagesEl.addEventListener('pointercancel', (e) => finish(e, true));
    pagesEl.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.view.hideOverlay('ghost'); });
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
    // 和音モード or Shift：そのタイミングにある音符へ足す
    if ((st.chord || e.shiftKey) && !st.rest) {
      const at = E.eventAt(this.score, loc);
      if (at && !at.ev.rest) {
        st.lastId = at.ev.id;
        this.edit('和音に追加', () => E.addToChord(this.score, at.ev.id, h.pitch));
        st.lastPitch = h.pitch; this.audition([h.pitch]);
        return;
      }
    }
    st.caret = loc;
    if (st.rest) this.enterRest({ at: loc });
    else this.enterPitch(h.pitch, { at: loc, chord: false });
  }
  tapSelect(h, e) {
    const st = this.state;
    const near = this.view.nearestEvent(h);
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
