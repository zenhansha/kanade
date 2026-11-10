// 鼻歌入力と「演奏についてくる」の画面（マイク・MIDI キーボードで聞いているあいだの動き）
//
//   ・鼻歌入力（リズムも）：メトロノームに合わせて歌うと、リアルタイム入力と同じように楽譜になる
//   ・鼻歌入力（高さだけ）：1音ずつ歌うと、今の音価で1つずつ入る（リズムを気にしなくていい）
//   ・ついてくる：弾いている場所を追いかけて、次に弾く音を青くし、ページの終わりで自動でめくる
//   ・練習モード：次の音を正しく弾くまで進まない。間違えた音を数えて、最後に苦手な小節を教える
// 画面の下に小さな帯（ライブ表示）を出し、今の高さ・位置・止めるボタンを見せる。Esc でも止まる。
import { MicInput, HumSegmenter, yin, rms, decimate, humPitches, tuningOffset, legato, Chroma, Agc } from '../audio/listen.js';
import { buildGroups, Follower, OnsetPicker } from '../audio/follow.js';
import { buildPerformance } from '../audio/player.js';
import { spellMidi, STEP_JA, TPQ } from '../core/music.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// MIDI 番号 → 「ソ4」「ファ♯3」
export function jaName(midi, fifths = 0) {
  const p = spellMidi(Math.round(midi), fifths);
  return STEP_JA[p.step] + (p.alter > 0 ? '♯'.repeat(p.alter) : '♭'.repeat(-p.alter)) + p.octave;
}
// 譜表の音部記号 → humPitches の「書きやすい高さ」の名前
function clefRangeName(key = 'treble') {
  if (key.startsWith('bass')) return 'bass';
  if (key === 'treble8vb') return 'treble8vb';
  if (key === 'alto' || key === 'tenor') return key;
  return 'treble';
}

export class Live {
  constructor(app) {
    this.app = app;
    this.hum = null;
    this.follow = null;
    this.pill = document.createElement('div');
    this.pill.className = 'live-pill';
    this.pill.hidden = true;
    this.pill.innerHTML = '<span class="lp-ico"></span><span class="lp-main"></span><span class="lp-meter"><i></i></span><button class="lp-stop" type="button">■ 止める</button>';
    document.body.appendChild(this.pill);
    this.pill.querySelector('.lp-stop').addEventListener('click', () => this.stop());
  }
  get active() { return !!(this.hum || this.follow); }
  stop() { if (this.hum) return this.humStop(); if (this.follow) return this.followStop(); }

  showPill(icon, text, cls = '') {
    this.pill.hidden = false;
    this.pill.className = 'live-pill ' + cls;
    this.pill.querySelector('.lp-ico').textContent = icon;
    this.pill.querySelector('.lp-main').innerHTML = text;
  }
  setLevel(v) { this.pill.querySelector('.lp-meter i').style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%'; }
  flash(cls) {
    this.pill.classList.remove('ok-flash', 'ng-flash');
    void this.pill.offsetWidth; // アニメーションをやり直す
    this.pill.classList.add(cls);
  }
  hidePill() { this.pill.hidden = true; }
  micError(e) {
    console.warn(e);
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    this.app.toast(denied ? 'マイクを使えませんでした。ブラウザの設定でこのサイトのマイクを許可してください' : 'マイクを開けませんでした：' + (e?.message || e), 4000);
  }

  // ───────── 鼻歌入力 ─────────
  // o: { mode: 'rhythm' | 'pitch', snap, octave, grid, triplets, countIn, tempo, playOthers }
  async humStart(o) {
    const a = this.app;
    if (!MicInput.supported) return a.toast('このブラウザはマイクに対応していません', 3000);
    if (this.active) this.stop();
    const ctx = a.synth.ensure();
    const st = a.state;
    const loc = st.mode === 'input' ? { ...st.caret } : (a.selLoc() || { p: 0, s: 0, m: a.focusMeasure(), v: 0, t: 0 });
    const staff = a.score.parts[loc.p]?.staves[loc.s];
    if (!staff || staff.clef === 'percussion' || staff.tabOf != null) return a.toast('鼻歌は五線の譜表に入れられます（ドラム・TAB 以外）', 3000);
    const h = { o, loc, clef: clefRangeName(staff.clef), seg: new HumSegmenter({ minLen: o.mode === 'pitch' ? 120 : 80 }), hist: [], shift: null, last: null };
    this.hum = h;
    this.showPill('🎤', 'マイクを準備しています…', 'hum');
    try {
      h.mic = new MicInput(ctx);
      const k = Math.max(1, Math.round(ctx.sampleRate / 12000)), srD = ctx.sampleRate / k;
      let dbuf = null;
      await h.mic.start((buf, stamp) => {
        dbuf = decimate(buf, k, dbuf);
        const r = yin(dbuf, srD);
        const level = rms(buf);
        for (const n of h.seg.feed({ time: stamp, f: r.f, clarity: r.clarity, rms: level })) this.humNote(n);
        this.setLevel(Math.sqrt(level) * 3);
        this.humShowNow();
      }, { size: 2048, lowpass: 3000, hop: 10, echo: true });
    } catch (e) { this.hum = null; this.hidePill(); return this.micError(e); }
    if (this.hum !== h) { h.mic.stop(); return; } // 準備のあいだに止められた
    const fifthsAt = () => a.L.attrs[Math.min(a.L.attrs.length - 1, (o.mode === 'rhythm' ? loc.m : st.caret.m))]?.fifths || 0;
    h.fifthsAt = fifthsAt;
    if (o.mode === 'rhythm') {
      // リアルタイム入力のしくみで録音（高さは止めたときに全部の音からまとめて決める：歌い手のずれを直すため）
      const map = (notes) => legato(humPitches(notes, { fifths: fifthsAt(), snap: o.snap, octave: o.octave, clef: h.clef }), 0.12);
      await a.tools.startRec({ p: loc.p, s: loc.s, m: loc.m, grid: TPQ / o.grid, triplets: o.triplets, countIn: o.countIn, playOthers: o.playOthers, tempoScale: o.tempo / 100, split: 60, mapNotes: map, hum: true });
    } else if (st.mode !== 'input') { a.setMode('input'); }
    this.humShowNow();
  }
  humNote(n) {
    const h = this.hum, a = this.app;
    if (!h) return;
    if (h.o.mode === 'rhythm') {
      const rec = a.tools.rec;
      if (!rec.active) return;
      rec.addHum(n.a, n.b, n.f);
      // 帯に出す音名を、書かれる高さ（自動のオクターブ）に合わせる
      const opt = { fifths: h.fifthsAt(), snap: h.o.snap, clef: h.clef };
      const w = humPitches(rec.notes, { ...opt, octave: h.o.octave }), raw = humPitches(rec.notes, { ...opt, octave: 0 });
      h.shift = w[w.length - 1].midi - raw[raw.length - 1].midi;
      return;
    }
    // 高さだけ：1音ずつ入れる。ずれ（全体に高い・低い）は最近の音から、オクターブは最初の音で決める
    h.hist.push(n);
    if (h.hist.length > 8) h.hist.shift();
    const offset = tuningOffset(h.hist), fifths = h.fifthsAt();
    const opt = { fifths, snap: h.o.snap, clef: h.clef, offset };
    if (h.shift == null) h.shift = h.o.octave === 'auto' || h.o.octave == null ? humPitches([n], { ...opt, octave: 'auto' })[0].midi - humPitches([n], { ...opt, octave: 0 })[0].midi : +h.o.octave;
    const midi = humPitches([n], { ...opt, octave: h.shift })[0].midi;
    h.last = midi;
    a.enterPitch(spellMidi(midi, fifths), { quiet: true }); // スピーカーの音をマイクが拾わないよう、鳴らさない
  }
  humShowNow() {
    const h = this.hum;
    if (!h) return;
    const now = h.seg.now;
    const fifths = h.fifthsAt ? h.fifthsAt() : 0;
    const mode = h.o.mode === 'rhythm' ? 'リズムも' : '高さだけ';
    const cur = now != null ? `<b>${esc(jaName(now + (h.shift || 0), fifths))}</b>` : '<span class="muted">歌ってください</span>';
    const last = h.o.mode === 'pitch' && h.last != null ? ` <span class="muted">入れた：${esc(jaName(h.last, fifths))}</span>` : '';
    const rec = h.o.mode === 'rhythm' && this.app.tools.rec.active ? ` <span class="muted">第${this.app.tools.rec.where() + 1}小節</span>` : '';
    this.showPill('🎤', `鼻歌（${mode}）　${cur}${last}${rec}`, 'hum' + (now != null ? ' voiced' : ''));
  }
  humStop() {
    const h = this.hum, a = this.app;
    if (!h) return;
    this.hum = null;
    for (const n of h.seg.flush()) { this.hum = h; this.humNote(n); this.hum = null; }
    h.mic?.stop();
    this.hidePill();
    if (h.o.mode === 'rhythm' && a.tools.rec.active) a.tools.stopRec();
    else if (h.o.mode === 'pitch') a.toast('鼻歌入力を終わりました', 1500);
  }

  // ───────── 演奏についてくる ─────────
  // o: { source: 'midi' | 'mic', p（null = 全パート）, strict（練習モード）, from, to（小節） }
  async followStart(o) {
    const a = this.app;
    if (this.active) this.stop();
    if (a.player.playing) a.player.stop();
    if (a.state.mode === 'input') a.setMode('select');
    const perf = buildPerformance(a.score, { human: false });
    let groups = buildGroups(perf, o.p);
    const s0 = perf.secOfMeasure(o.from || 0) - 1e-6;
    const s1 = o.to != null ? perf.secOfMeasure(o.to + 1) - 1e-6 : Infinity;
    groups = groups.filter(g => g.sec >= s0 && g.sec < s1);
    if (!groups.length) return a.toast('ついていく音符がありません（その範囲・パートに音符を入れてください）', 3000);
    groups.forEach((g, k) => { g.k = k; });
    const f = { o, groups, fo: new Follower(groups, { strict: !!o.strict }), perf };
    f.fo.start(0);
    this.follow = f;
    a.synth.ensure();
    this.followShow(true);
    if (o.source === 'mic') {
      if (!MicInput.supported) { this.follow = null; this.hidePill(); return a.toast('このブラウザはマイクに対応していません', 3000); }
      const ctx = a.synth.ensure();
      try {
        f.mic = new MicInput(ctx);
        const chroma = new Chroma(ctx.sampleRate, 4096), picker = new OnsetPicker(), agc = new Agc({ hop: 0.02 });
        await f.mic.start((buf, stamp) => {
          const fr = chroma.frame(agc.apply(buf)); // 音量をそろえてから
          this.setLevel(Math.sqrt(rms(buf)) * 3);
          for (const on of picker.push(fr, stamp)) this.followResult(f.fo.hear(on.chroma, on.stamp));
        }, { size: 4096, hop: 20, echo: false });
      } catch (e) { this.follow = null; this.followClear(); return this.micError(e); }
      if (this.follow !== f) f.mic.stop();
    } else if (!(a.midiInfo?.ok && a.midiInfo.devices?.length)) {
      a.toast('MIDI キーボードがつながっていません。画面鍵盤でも弾けます', 3000);
    }
  }
  // MIDI キーボード・画面鍵盤から
  followNote(midi, stamp = performance.now()) {
    const f = this.follow;
    if (!f) return;
    this.followResult(f.fo.noteOn(midi, stamp), midi);
  }
  followResult(r, midi = null) {
    const f = this.follow;
    if (!f) return;
    if (r.kind === 'wrong' && f.o.strict) {
      this.flash('ng-flash');
      const want = f.fo.next ? f.fo.next.midis.map(x => jaName(x, this.fifthsAt(f.fo.next.m))).join('・') : '';
      f.lastWrong = midi != null ? `✗ ${jaName(midi, this.fifthsAt(f.fo.next?.m || 0))}（次は ${want}）` : '✗';
    } else if (r.kind === 'ok' && r.moved) { f.lastWrong = null; if (f.o.strict) this.flash('ok-flash'); }
    if (r.moved || r.kind === 'wrong') this.followShow(r.moved);
    if (f.fo.done) this.followFinish();
  }
  fifthsAt(m) { return this.app.L.attrs[Math.min(this.app.L.attrs.length - 1, m || 0)]?.fifths || 0; }
  // 次に弾く音を青く、そこに線を出し、ページをめくる
  followShow(moved) {
    const f = this.follow, a = this.app;
    if (!f) return;
    const nx = f.fo.next || f.groups[f.groups.length - 1];
    if (moved) {
      a.view.highlight(nx ? nx.ids : [], 'next');
      if (nx) { a.view.showFollowLine(nx.m, nx.t); a.view.followTo(nx.m, nx.t); }
    }
    const rep = f.fo.report();
    const where = nx ? `第${nx.m + 1}小節` : '終わり';
    const src = f.o.source === 'mic' ? '🎙' : '🎹';
    if (f.o.strict) {
      const msg = f.lastWrong ? `<span class="ng">${esc(f.lastWrong)}</span>` : `<span class="muted">青い音を弾いてください</span>`;
      this.showPill(src, `練習モード　<b>${where}</b>　✓${rep.ok} ✗${rep.wrong}　${msg}`, 'follow strict');
    } else this.showPill(src, `ついてくる　<b>${where}</b>　<span class="muted">${f.o.source === 'mic' ? 'マイクで聞いています' : '弾いた場所を追いかけます'}</span>`, 'follow' + (f.o.source === 'mic' ? ' mic' : ''));
  }
  followClear() {
    const a = this.app;
    a.view.highlight([], 'next');
    a.view.hideOverlay('follow');
    this.hidePill();
  }
  followFinish() {
    const f = this.follow;
    if (!f) return;
    this.followStop(true);
  }
  followStop(finished = false) {
    const f = this.follow, a = this.app;
    if (!f) return;
    this.follow = null;
    f.mic?.stop();
    this.followClear();
    if (f.o.strict) this.practiceReport(f, finished);
    else a.toast(finished ? '最後までついていきました' : 'ついてくるのを止めました', 1800);
  }
  // 練習の結果：正解率と、間違いの多かった小節（そこだけゆっくり聞く・もう一度弾く）
  practiceReport(f, finished) {
    const a = this.app, r = f.fo.report();
    const pct = Math.round(r.rate * 100);
    const lastM = f.groups[Math.max(0, r.reached)]?.m ?? f.o.from ?? 0;
    const worst = r.worst.length ? r.worst.map(w => `<div class="pr-row"><span>第${w.m + 1}小節（${w.n}回）</span><button class="btn" data-listen="${w.m}">ゆっくり聞く</button><button class="btn" data-again="${w.m}">もう一度弾く</button></div>`).join('') : '<p>間違えた小節はありません 🎉</p>';
    const bd = a.dialogs.open({
      title: finished ? '練習の結果：最後まで弾けました' : '練習の結果', narrow: true,
      body: `<div class="pr-big">${pct}<small>%</small></div>
        <p style="text-align:center;margin:0 0 12px">正しく弾けた音 ${r.ok} ／ 間違えた音 ${r.wrong}${finished ? '' : `　（第${lastM + 1}小節まで）`}</p>
        <h3 style="margin:8px 0 6px;font-size:14px">間違いの多かった小節</h3>${worst}
        <p style="color:var(--muted);font-size:13px;margin:10px 0 0">「ゆっくり聞く」は 70% の速さから、くり返すたびに少しずつ速くなります。</p>`,
      buttons: [{ label: '閉じる' }, { label: 'はじめからもう一度', cls: 'primary', onClick: () => { setTimeout(() => this.followStart({ ...f.o }), 0); } }],
    });
    bd.addEventListener('click', (e) => {
      const L = e.target.closest('[data-listen]'), G = e.target.closest('[data-again]');
      if (L) { const m = +L.dataset.listen; a.dialogs.close(); a.listenSlowly(m, m); }
      if (G) { const m = +G.dataset.again; a.dialogs.close(); this.followStart({ ...f.o, from: m, to: m }); }
    });
  }
}
