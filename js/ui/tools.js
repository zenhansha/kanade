// Phase 3 の画面：ツールメニュー（リアルタイム入力・一括編集・再生の設定・ミキサー・書き出し）とページレイアウト
import * as M from '../core/massedit.js';
import { ARTICS } from '../core/marks.js';
import { DRUMS, TUNINGS } from '../core/perc.js';
import { INST } from '../core/score.js';
import { TPQ, pitchName } from '../core/music.js';
import { Recorder } from '../audio/recorder.js';
import { playbackSettings, renderWav } from '../audio/player.js';
import { Synth } from '../audio/synth.js';
import { exportMidi } from '../io/midifile.js';
import { saveFile } from '../io/storage.js';
import { STYLES, addAccompaniment, estimateChords, findRoles, collectChords } from '../core/accomp.js';
import { addDir } from '../core/marks.js';
import { MicInput } from '../audio/listen.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const INTERVALS = [
  ['短2度', 1, 1], ['長2度', 1, 2], ['短3度', 2, 3], ['長3度', 2, 4], ['完全4度', 3, 5], ['増4度', 3, 6], ['完全5度', 4, 7],
  ['短6度', 5, 8], ['長6度', 5, 9], ['短7度', 6, 10], ['長7度', 6, 11], ['オクターブ', 7, 12],
];

export class Tools {
  constructor(app) {
    this.app = app;
    this.rec = new Recorder(app);
    this.dlg = app.dialogs;
  }

  // ───────── 範囲 ─────────
  // 一括編集の対象：小節の範囲選択。なければ選んでいる音符の小節。それもなければ全体
  range(needSel = false) {
    const a = this.app, sel = a.state.sel;
    if (sel?.kind === 'range') return a.rangeStaves(sel);
    const loc = a.selLoc();
    if (loc && sel?.kind === 'event') return { m1: loc.m, m2: loc.m, staves: [[loc.p, loc.s]] };
    if (needSel) return null;
    return { m1: 0, m2: a.score.measures.length - 1, staves: a.L.rows.map(r => [r.p, r.s]) };
  }
  rangeLabel(rg) {
    const n = rg.staves.length;
    return `第${rg.m1 + 1}〜${rg.m2 + 1}小節・${n}段`;
  }
  mass(label, fn, needSel = false) {
    const rg = this.range(needSel);
    if (!rg) return this.app.toast('先に小節を選んでください（ドラッグ / 小節の空きをタップ）');
    let r;
    this.app.edit(label, () => { r = fn(rg); if (r === false) return false; });
    if (r === false) this.app.toast('この範囲ではできません');
    else this.app.toast(`${label}：${this.rangeLabel(rg)}`);
    return r;
  }

  massItems() {
    return [
      { label: '移調…', run: () => this.transpose() },
      { label: '音価を2倍に（拡大）', run: () => this.mass('音価を2倍', rg => M.scaleDurations(this.app.score, rg, 2)) },
      { label: '音価を半分に（縮小）', run: () => this.mass('音価を半分', rg => M.scaleDurations(this.app.score, rg, 0.5)) },
      { label: '逆行（後ろから並べ直す）', run: () => this.mass('逆行', rg => M.retrograde(this.app.score, rg)) },
      { label: 'アーティキュレーションをまとめて付ける…', run: () => this.articAll() },
      { label: '項目を選んで消去…', run: () => this.clearItems() },
      { label: '異名同音を書き換え（♯ ⇔ ♭）', run: () => this.mass('異名同音の書き換え', rg => M.respell(this.app.score, rg)) },
      { label: 'エクスプロード（和音を下の譜表へ分ける）', run: () => this.mass('エクスプロード', rg => (M.explode(this.app.score, rg, this.app.L.rows) ? true : false), true) },
      { label: 'インプロード（選んだ譜表を1段の和音に）', run: () => this.mass('インプロード', rg => M.implode(this.app.score, rg), true) },
    ];
  }

  transpose() {
    const rg = this.range();
    this.dlg.open({
      title: '移調', narrow: true,
      body: `<p style="margin:0 0 10px;color:var(--muted)">${this.rangeLabel(rg)}</p>
        <div class="row"><label class="field"><span>方向</span><select id="tpD"><option value="1">上へ</option><option value="-1">下へ</option></select></label>
        <label class="field"><span>音程</span><select id="tpI">${INTERVALS.map((x, i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${x[0]}</option>`).join('')}</select></label></div>
        <div class="row"><label class="field"><span>さらにオクターブ</span><select id="tpO"><option value="0">なし</option><option value="1">＋1オクターブ</option><option value="2">＋2オクターブ</option></select></label></div>
        <label class="ck"><input type="checkbox" id="tpK"><span>調号も変える（範囲が曲全体や区切りのよいところのとき）</span></label>
        <label class="ck"><input type="checkbox" id="tpC" checked><span>コードネームも移調する</span></label>`,
      buttons: [{ label: 'キャンセル' }, { label: '移調', cls: 'primary', onClick: (bd) => {
        const q = (s) => bd.querySelector(s);
        const dir = +q('#tpD').value, iv = INTERVALS[+q('#tpI').value], oc = +q('#tpO').value;
        const dia = dir * (iv[1] + 7 * oc), chrom = dir * (iv[2] + 12 * oc);
        this.mass('移調', r => M.transposeBy(this.app.score, r, dia, chrom, { keys: q('#tpK').checked, chords: q('#tpC').checked }));
      } }],
    });
  }

  articAll() {
    const keys = Object.keys(ARTICS);
    this.dlg.open({
      title: 'アーティキュレーションをまとめて付ける', narrow: true,
      body: `<p style="margin:0 0 10px;color:var(--muted)">${this.rangeLabel(this.range())} の音符すべてに</p>
        <div class="chips" id="aaK">${keys.map(k => `<button class="chip" data-k="${k}">${ARTICS[k].ja}</button>`).join('')}</div>
        <div class="row" style="margin-top:12px"><label class="ck"><input type="radio" name="aaM" value="on" checked><span>付ける</span></label><label class="ck"><input type="radio" name="aaM" value="off"><span>外す</span></label></div>`,
      onOpen: (bd) => bd.querySelector('#aaK').addEventListener('click', (e) => {
        const b = e.target.closest('[data-k]'); if (!b) return;
        const on = bd.querySelector('input[name="aaM"]:checked').value === 'on';
        this.dlg.close();
        this.mass(on ? ARTICS[b.dataset.k].ja + 'を付ける' : ARTICS[b.dataset.k].ja + 'を外す', rg => M.setArticAll(this.app.score, rg, b.dataset.k, on));
      }),
      buttons: [{ label: '閉じる' }],
    });
  }

  clearItems() {
    const items = [['notes', '音符（休符にする）'], ['art', 'アーティキュレーション'], ['dyn', '強弱記号'], ['text', '文字の表情記号'], ['chords', 'コードネーム'], ['lyrics', '歌詞'], ['slurs', 'スラー'], ['hairs', '松葉（cresc. / dim.）'], ['lines', '8va・ペダル・トリルの線'], ['grace', '装飾音符']];
    this.dlg.open({
      title: '項目を選んで消去', narrow: true,
      body: `<p style="margin:0 0 10px;color:var(--muted)">${this.rangeLabel(this.range())}</p>${items.map(([k, l]) => `<label class="ck"><input type="checkbox" data-k="${k}"${k === 'notes' ? '' : ''}><span>${l}</span></label>`).join('')}`,
      buttons: [{ label: 'キャンセル' }, { label: '消去', cls: 'primary', onClick: (bd) => {
        const what = {};
        bd.querySelectorAll('[data-k]').forEach(c => { if (c.checked) what[c.dataset.k] = true; });
        if (!Object.keys(what).length) return;
        this.mass('項目を消去', rg => M.clearItems(this.app.score, rg, what));
      } }],
    });
  }

  // ───────── リアルタイム入力（HyperScribe） ─────────
  hyperscribe() {
    const a = this.app;
    const loc = a.state.mode === 'input' ? a.state.caret : (a.selLoc() || { p: 0, s: 0, m: 0 });
    const part = a.score.parts[loc.p];
    const two = part.staves.filter(st => st.tabOf == null).length > 1;
    const pb = playbackSettings(a.score);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('kanade.hs') || '{}'); } catch (e) { /* なし */ }
    const o = { grid: 4, triplets: false, countIn: 1, playOthers: true, tempo: 100, split: 60, ...saved };
    const midiOk = a.midiInfo?.ok && a.midiInfo.devices?.length;
    this.dlg.open({
      title: '● リアルタイム入力（HyperScribe）', narrow: true,
      body: `<p style="margin:0 0 10px">${esc(part.name)}・第${loc.m + 1}小節から。メトロノームに合わせて弾き、<b>■（スペース / Esc）</b>で止めると楽譜になります。</p>
        ${midiOk ? '' : `<p style="margin:0 0 10px;color:var(--muted);font-size:13px">MIDI キーボードがつながっていません。画面鍵盤（パレットの「鍵盤」）でも録音できます。</p>`}
        <div class="row"><label class="field"><span>細かさ（クオンタイズ）</span><select id="hsG"><option value="2"${o.grid === 2 ? ' selected' : ''}>8分音符</option><option value="4"${o.grid === 4 ? ' selected' : ''}>16分音符</option><option value="8"${o.grid === 8 ? ' selected' : ''}>32分音符</option></select></label>
        <label class="field"><span>カウントイン</span><select id="hsC">${[0, 1, 2].map(n => `<option value="${n}"${o.countIn === n ? ' selected' : ''}>${n ? n + '小節' : 'なし'}</option>`).join('')}</select></label></div>
        <div class="row"><label class="field"><span>テンポ（練習用にゆっくり）</span><select id="hsT">${[50, 60, 75, 85, 100].map(n => `<option value="${n}"${o.tempo === n ? ' selected' : ''}>${n}%</option>`).join('')}</select></label>
        ${two ? `<label class="field"><span>右手・左手の分割点</span><select id="hsS">${[48, 53, 55, 57, 59, 60, 62, 64, 65].map(n => `<option value="${n}"${o.split === n ? ' selected' : ''}>${pitchName({ step: 'CCDDEFFGGAAB'[n % 12], alter: [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0][n % 12], octave: Math.floor(n / 12) - 1 })} から上が右手</option>`).join('')}</select></label>` : ''}</div>
        <label class="ck"><input type="checkbox" id="hsTr"${o.triplets ? ' checked' : ''}><span>3連符も使う（3連のリズムを弾くとき）</span></label>
        <label class="ck"><input type="checkbox" id="hsP"${o.playOthers ? ' checked' : ''}><span>ほかのパートを鳴らしながら録音する</span></label>
        <p style="color:var(--muted);font-size:13px;margin:8px 0 0">テンポは楽譜のテンポ（${a.L.attrs[loc.m].bpm}）× この倍率。同時に押さえた音は和音、長く伸ばした音は声部2になります。録音した範囲の今の音符は置き換わります（元に戻すで戻せます）。${pb.human ? '' : ''}</p>`,
      buttons: [{ label: 'キャンセル' }, { label: '● 録音開始', cls: 'primary', onClick: (bd) => {
        const q = (s) => bd.querySelector(s);
        const v = { grid: +q('#hsG').value, triplets: q('#hsTr').checked, countIn: +q('#hsC').value, playOthers: q('#hsP').checked, tempo: +q('#hsT').value, split: q('#hsS') ? +q('#hsS').value : 60 };
        try { localStorage.setItem('kanade.hs', JSON.stringify(v)); } catch (e) { /* なし */ }
        this.startRec({ p: loc.p, s: two ? -1 : loc.s, m: loc.m, grid: TPQ / v.grid, triplets: v.triplets, countIn: v.countIn, playOthers: v.playOthers, tempoScale: v.tempo / 100, split: v.split });
      } }],
    });
  }
  async startRec(o) {
    const a = this.app;
    if (a.player.playing) a.player.stop();
    if (a.state.mode === 'input') a.setMode('select');
    a.synth.ensure();
    document.body.classList.add('recording');
    a.toast(o.countIn ? 'カウントのあとから録音します' : '録音中…', 2000);
    await this.rec.start(o);
    a.updateUI();
  }
  stopRec() {
    const a = this.app;
    if (a.live?.hum) return a.live.humStop(); // 鼻歌：マイクを止めて、残りの音を足してから書き込む
    document.body.classList.remove('recording');
    const n = this.rec.stop();
    a.updateUI();
    a.toast(n ? `${n} 音を書き込みました（クオンタイズ済み）` : '音が録音されませんでした', 2600);
  }

  // ───────── 鼻歌入力 ─────────
  humDialog() {
    const a = this.app;
    if (a.live.hum) return a.live.humStop();
    if (!MicInput.supported) return a.toast('このブラウザはマイクに対応していません', 3000);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('kanade.hum') || '{}'); } catch (e) { /* なし */ }
    const o = { mode: 'pitch', snap: true, octave: 'auto', grid: 4, triplets: false, countIn: 1, tempo: 85, playOthers: false, ...saved };
    const loc = a.state.mode === 'input' ? a.state.caret : (a.selLoc() || { p: 0, s: 0, m: a.focusMeasure() });
    const part = a.score.parts[loc.p];
    const sel = (id, list, v) => `<select id="${id}">${list.map(([x, l]) => `<option value="${x}"${String(v) === String(x) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    this.dlg.open({
      title: '🎤 鼻歌入力', narrow: true,
      body: `<p style="margin:0 0 10px">${esc(part?.name || '')}・第${loc.m + 1}小節から。マイクに向かって「ふーん」「らー」と歌うと、楽譜になります。</p>
        <div class="chips" id="huM" style="margin-bottom:6px"><button class="chip${o.mode === 'pitch' ? ' on' : ''}" data-m="pitch">高さだけ（1音ずつ）</button><button class="chip${o.mode === 'rhythm' ? ' on' : ''}" data-m="rhythm">リズムも（メトロノームに合わせて）</button></div>
        <p id="huD" style="color:var(--muted);font-size:13px;margin:0 0 10px"></p>
        <div class="row"><label class="field"><span>オクターブ</span>${sel('huO', [['auto', '自動（譜表に合わせる）'], [0, 'そのまま'], [12, '1オクターブ上'], [-12, '1オクターブ下']], o.octave)}</label></div>
        <label class="ck"><input type="checkbox" id="huS"${o.snap ? ' checked' : ''}><span>調の音にそろえる（少し外れても、調に合う音にする）</span></label>
        <div id="huR">
          <div class="row"><label class="field"><span>細かさ</span>${sel('huG', [[2, '8分音符'], [4, '16分音符']], o.grid)}</label>
          <label class="field"><span>カウントイン</span>${sel('huC', [[0, 'なし'], [1, '1小節'], [2, '2小節']], o.countIn)}</label></div>
          <div class="row"><label class="field"><span>テンポ</span>${sel('huT', [50, 60, 75, 85, 100].map(n => [n, n + '%']), o.tempo)}</label></div>
          <label class="ck"><input type="checkbox" id="huP"${o.playOthers ? ' checked' : ''}><span>ほかのパートを鳴らしながら（イヤホンのとき）</span></label>
        </div>
        <p style="color:var(--muted);font-size:13px;margin:8px 0 0">声は端末の中で処理するだけで、どこにも送りません。初めてのときはマイクの許可をたずねられます。■ か Esc で終わります。</p>`,
      onOpen: (bd) => {
        const q = (s) => bd.querySelector(s);
        const show = () => {
          const m = q('#huM .on').dataset.m;
          q('#huR').hidden = m !== 'rhythm';
          q('#huD').textContent = m === 'rhythm'
            ? 'メトロノームに合わせて歌います。長さも聞き取って、16分音符などのマス目にそろえます。スピーカーの音をマイクが拾わないよう、イヤホンがおすすめです。'
            : '1音ずつ歌って、声を止めると入ります。長さは今えらんでいる音価（数字キーで変えられます）。リズムを気にせず、ゆっくり歌えます。';
        };
        q('#huM').addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (!b) return; bd.querySelectorAll('#huM .chip').forEach(c => c.classList.toggle('on', c === b)); show(); });
        show();
      },
      buttons: [{ label: 'キャンセル' }, { label: '🎤 はじめる', cls: 'primary', onClick: (bd) => {
        const q = (s) => bd.querySelector(s);
        const oc = q('#huO').value;
        const v = { mode: q('#huM .on').dataset.m, snap: q('#huS').checked, octave: oc === 'auto' ? 'auto' : +oc, grid: +q('#huG').value, triplets: false, countIn: +q('#huC').value, tempo: +q('#huT').value, playOthers: q('#huP').checked };
        try { localStorage.setItem('kanade.hum', JSON.stringify(v)); } catch (e) { /* なし */ }
        a.live.humStart(v);
      } }],
    });
  }

  // ───────── 演奏についてくる・練習モード ─────────
  followDialog(strict = false) {
    const a = this.app;
    if (a.live.follow) return a.live.followStop();
    const midiOk = !!(a.midiInfo?.ok && a.midiInfo.devices?.length);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('kanade.follow') || '{}'); } catch (e) { /* なし */ }
    const parts = a.score.parts.map((p, i) => [i, p.name]).filter(([i]) => !a.score.parts[i].staves.some(st => st.clef === 'percussion'));
    const kb = a.score.parts.findIndex(p => INST[p.inst]?.fam === '鍵盤');
    const o = { source: 'midi', p: kb >= 0 ? kb : parts[0]?.[0] ?? 0, from: 'here', ...saved };
    if (midiOk || strict) o.source = 'midi';
    if (o.p != null && !a.score.parts[o.p]) o.p = 0;
    const focus = a.focusMeasure();
    this.dlg.open({
      title: strict ? '🎯 練習モード' : '📖 演奏についてくる（譜めくり）', narrow: true,
      body: `<p style="margin:0 0 10px">${strict
        ? '次に弾く音が青くなります。<b>正しく弾くまで先に進みません</b>。間違えた音を数えて、最後に苦手な小節を教えます。'
        : '弾いている場所を追いかけて、次に弾く音を青くし、ページの終わりで<b>自動でページをめくります</b>。弾きまちがえても、とばしても、ついてきます。'}</p>
        <div class="row"><label class="field"><span>聞き取り</span><select id="foS"><option value="midi"${o.source === 'midi' ? ' selected' : ''}>MIDI キーボード・画面鍵盤${midiOk ? '（つながっています）' : ''}</option>${strict ? '' : `<option value="mic"${o.source === 'mic' ? ' selected' : ''}>マイク（ピアノ・歌・楽器の音）</option>`}</select></label>
        <label class="field"><span>パート</span><select id="foP"><option value="all"${o.p == null ? ' selected' : ''}>全部のパート</option>${parts.map(([i, n]) => `<option value="${i}"${o.p === i ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div>
        <div class="row"><label class="field"><span>はじめる場所</span><select id="foF"><option value="here">第${focus + 1}小節から（選んでいる場所）</option><option value="top"${o.from === 'top' ? ' selected' : ''}>曲の頭から</option></select></label></div>
        <p style="color:var(--muted);font-size:13px;margin:8px 0 0">${strict ? '' : 'マイクは音の成分で照らし合わせるので、MIDI より大まかです（静かな部屋がおすすめ）。音は端末の中で処理するだけで、どこにも送りません。'}テンポは自由です（止まっても待ちます）。■ か Esc で終わります。</p>`,
      buttons: [{ label: 'キャンセル' }, { label: strict ? '🎯 はじめる' : '📖 はじめる', cls: 'primary', onClick: (bd) => {
        const q = (s) => bd.querySelector(s);
        const v = { source: q('#foS').value, p: q('#foP').value === 'all' ? null : +q('#foP').value, from: q('#foF').value };
        try { localStorage.setItem('kanade.follow', JSON.stringify(v)); } catch (e) { /* なし */ }
        a.live.followStart({ source: v.source, p: v.p, strict, from: v.from === 'top' ? 0 : focus });
      } }],
    });
  }

  // ───────── 伴奏の自動生成・コードの推定 ─────────
  accRange() {
    const a = this.app, s = a.state.sel;
    return s?.kind === 'range' ? { m1: s.m1, m2: s.m2 } : { m1: 0, m2: a.score.measures.length - 1 };
  }
  accompany() {
    const a = this.app;
    const { m1, m2 } = this.accRange();
    const roles = findRoles(a.score, m1, m2);
    const nChords = collectChords(a.score).filter(c => c.m >= m1 && c.m <= m2).length;
    const tgt = roles.target;
    const where = tgt ? `${esc(a.score.parts[tgt.p].name)}の${tgt.rh == null ? '左手（下の段）' : '両手'}` : '新しく足すピアノのパート（両手）';
    let style = 'arp';
    try { style = localStorage.getItem('kanade.accStyle') || 'arp'; } catch (e) { /* なし */ }
    if (!STYLES.some(s => s.id === style)) style = 'arp';
    let previewing = false;
    const stopPreview = () => { if (previewing) { previewing = false; a.player.stop(); } };
    const opts = (bd) => ({ m1, m2, style: bd.querySelector('#acS .on').dataset.s, estimate: bd.querySelector('#acE').checked });
    this.dlg.open({
      title: '🎹 伴奏をつける', narrow: true,
      body: `<p style="margin:0 0 10px">第${m1 + 1}〜${m2 + 1}小節のコードネームから、伴奏の音符を書きます。<br>書く場所：<b>${where}</b>（今ある音符は置き換わります。元に戻すで戻せます）</p>
        <div class="chips" id="acS">${STYLES.map(s => `<button class="chip${s.id === style ? ' on' : ''}" data-s="${s.id}" title="${esc(s.desc)}">${esc(s.ja)}</button>`).join('')}</div>
        <p id="acD" style="color:var(--muted);font-size:13px;margin:6px 0 10px"></p>
        <label class="ck"><input type="checkbox" id="acE"${nChords ? '' : ' checked'}><span>コードネームがない小節は、メロディー（${esc(a.score.parts[roles.melody.p]?.name || '')}）から推定して書き込む</span></label>
        <p style="color:var(--muted);font-size:13px;margin:6px 0 0">この範囲のコードネーム：${nChords ? nChords + '個' : 'まだありません'}。「試聴」で書き込む前に聞けます。</p>`,
      onOpen: (bd) => {
        const show = () => { const s = STYLES.find(x => x.id === bd.querySelector('#acS .on').dataset.s); bd.querySelector('#acD').textContent = s.desc; };
        bd.querySelector('#acS').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; bd.querySelectorAll('#acS .chip').forEach(c => c.classList.toggle('on', c === b)); show(); stopPreview(); });
        show();
      },
      onClose: stopPreview,
      buttons: [{ label: 'キャンセル' }, { label: '▶ 試聴', onClick: (bd) => {
        if (previewing) { stopPreview(); return false; }
        const copy = JSON.parse(JSON.stringify(a.score));
        const r = addAccompaniment(copy, opts(bd));
        if (!r.ok) { a.toast('コードネームがありません。「推定して書き込む」をオンにするか、コードネームを入れてください', 3500); return false; }
        a.synth.ensure();
        previewing = true;
        a.player.start(copy, m1, { tempoScale: a.speed || 1 });
        return false;
      } }, { label: '書き込む', cls: 'primary', onClick: (bd) => {
        const o = opts(bd);
        try { localStorage.setItem('kanade.accStyle', o.style); } catch (e) { /* なし */ }
        stopPreview();
        let r;
        a.edit('伴奏をつける', () => { r = addAccompaniment(a.score, o); if (!r.ok) return false; });
        if (!r?.ok) { a.toast('コードネームがありません。「推定して書き込む」をオンにするか、コードネームを入れてください', 3500); return false; }
        const st = STYLES.find(s => s.id === o.style);
        a.toast(`伴奏（${st.ja}）を${r.measures}小節に書きました${r.added.length ? `。コードも推定しました：${r.added.slice(0, 6).map(c => c.text).join(' ')}${r.added.length > 6 ? ' …' : ''}` : ''}`, 4000);
      } }],
    });
  }
  // コードネームだけ推定して書き込む（伴奏は書かない）
  guessChords() {
    const a = this.app;
    const { m1, m2 } = this.accRange();
    const roles = findRoles(a.score, m1, m2);
    const have = new Set(collectChords(a.score).map(c => c.m));
    const added = [];
    let minor = false;
    a.edit('コードを推定', () => {
      const r = estimateChords(a.score, { ...roles.melody, m1, m2 });
      minor = r.minor;
      let prev = null;
      for (const c of r.chords) {
        if (have.has(c.m)) { prev = null; continue; }
        if (c.text !== prev) { addDir(a.score, roles.melody.p, roles.melody.s, c.m, { t: 0, k: 'chord', text: c.text }); added.push(c.text); }
        prev = c.text;
      }
      if (!added.length) return false;
    });
    a.toast(added.length ? `${minor ? '短調' : '長調'}として推定しました：${added.slice(0, 8).join(' ')}${added.length > 8 ? ' …' : ''}` : 'コードネームのない小節がありません', 3500);
  }

  // ───────── 再生の設定・ミキサー ─────────
  playback() {
    const a = this.app;
    const pb = playbackSettings(a.score);
    this.dlg.open({
      title: '再生の設定', narrow: true,
      body: `<label class="ck"><input type="checkbox" id="pbH"${pb.human ? ' checked' : ''}><span><b>表情付き再生</b>（Human Playback：rit. / accel. / a tempo、拍の頭を少し強く、人間らしい小さな揺れ）</span></label>
        <label class="field" style="margin-top:10px"><span>スウィング（8分音符を跳ねる）</span><select id="pbS">${[[0, 'なし（ストレート）'], [0.5, '軽く'], [0.75, 'ふつう'], [1, '3連（2:1）']].map(([v, l]) => `<option value="${v}"${pb.swing === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="ck"><input type="checkbox" id="pbC"${pb.click ? ' checked' : ''}><span>再生中にメトロノームを鳴らす</span></label>
        <label class="field" style="margin-top:10px"><span>再生前のカウントイン</span><select id="pbI">${[0, 1, 2].map(n => `<option value="${n}"${(pb.countIn ?? 0) === n && pb.click ? ' selected' : ''}>${n ? n + '小節' : 'なし'}</option>`).join('')}</select></label>
        <p style="color:var(--muted);font-size:13px;margin:4px 0 0">rit.・rall.・accel.・meno mosso・più mosso・a tempo・Tempo I は、文字の表情記号として付けると再生に反映されます。</p>`,
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
        const q = (s) => bd.querySelector(s);
        a.edit('再生の設定', () => { a.score.settings.playback = { human: q('#pbH').checked, swing: +q('#pbS').value, click: q('#pbC').checked, countIn: +q('#pbI').value }; });
      } }],
    });
  }
  mixer() {
    const a = this.app;
    const parts = a.score.parts;
    const row = (p, i) => {
      const mx = p.mix || {};
      return `<div class="mx-row" data-i="${i}"><span class="mx-n">${esc(p.name)}</span>
        <label title="音量">🔊<input type="range" min="0" max="1" step="0.05" value="${mx.vol ?? 0.8}" data-k="vol"></label>
        <label title="左右">L<input type="range" min="-1" max="1" step="0.1" value="${mx.pan ?? 0}" data-k="pan">R</label>
        <button class="chip${mx.mute ? ' on' : ''}" data-k="mute">ミュート</button><button class="chip${mx.solo ? ' on' : ''}" data-k="solo">ソロ</button></div>`;
    };
    const before = JSON.stringify(parts.map(p => p.mix || null));
    this.dlg.open({
      title: 'ミキサー',
      body: `<div class="mixer">${parts.map(row).join('')}</div><p style="color:var(--muted);font-size:13px;margin:8px 0 0">再生しながら動かせます。MIDI・WAV の書き出しにも反映されます。</p>`,
      onOpen: (bd) => {
        const set = (i, k, v) => {
          const p = parts[i]; p.mix = { vol: 0.8, pan: 0, ...(p.mix || {}), [k]: v };
          a.synth.setChannel(i, p.mix.vol, p.mix.pan);
        };
        bd.querySelector('.mixer').addEventListener('input', (e) => { const r = e.target.closest('.mx-row'); if (r && e.target.dataset.k) set(+r.dataset.i, e.target.dataset.k, +e.target.value); });
        bd.querySelector('.mixer').addEventListener('click', (e) => {
          const b = e.target.closest('button[data-k]'); if (!b) return;
          const i = +b.closest('.mx-row').dataset.i, k = b.dataset.k;
          set(i, k, !parts[i].mix?.[k]);
          b.classList.toggle('on', !!parts[i].mix[k]);
          if (a.player.playing) a.toast('ミュート・ソロは次の再生から反映されます');
        });
      },
      buttons: [{ label: '閉じる', cls: 'primary', onClick: () => {
        const after = JSON.stringify(parts.map(p => p.mix || null));
        if (after !== before) {
          // 動かした結果を1回の「元に戻す」にまとめる
          const now = parts.map(p => p.mix);
          parts.forEach((p, i) => { const b = JSON.parse(before)[i]; if (b) p.mix = b; else delete p.mix; });
          a.edit('ミキサー', () => parts.forEach((p, i) => { if (now[i]) p.mix = now[i]; }));
        }
      } }],
    });
  }
  midiOut() {
    const a = this.app;
    const outs = a.midi.outputs?.map(o => o.name) || [];
    if (!a.midi.supported || !outs.length) {
      return this.dlg.open({ title: '外部 MIDI 音源', narrow: true, body: `<p>${a.midi.supported ? 'MIDI の出力先が見つかりません。電子ピアノや音源、DAW（loopMIDI などの仮想ポート）をつないでから開き直してください。' : 'このブラウザは Web MIDI に対応していません（PC の Chrome / Edge で使えます）。'}</p>`, buttons: [{ label: '閉じる', cls: 'primary' }] });
    }
    const cur = a.midi.out?.name || '';
    this.dlg.menu(null, [
      { head: '再生の音を送る先' },
      { label: (!cur ? '✓ ' : '') + 'KANADE の内蔵音源', run: () => { a.midi.setOutput(null); a.player.midiOut = null; a.toast('内蔵音源で鳴らします'); } },
      ...outs.map(n => ({ label: (n === cur ? '✓ ' : '') + esc(n), run: () => { a.midi.setOutput(n); a.player.midiOut = a.midi; a.toast(`「${n}」で鳴らします`); } })),
    ]);
  }

  // ───────── 書き出し ─────────
  async exportMidi() {
    const a = this.app;
    try {
      const bytes = exportMidi(a.score);
      const r = await saveFile(a.fileBaseName() + '.mid', new Blob([bytes], { type: 'audio/midi' }), 'midi');
      if (r && typeof r === 'object') a.toast(`「${r.name}」に書き出しました`);
    } catch (e) { console.error(e); a.toast('書き出せませんでした：' + e.message, 3500); }
  }
  async exportWav() {
    const a = this.app;
    if (typeof OfflineAudioContext === 'undefined') return a.toast('このブラウザはオーディオの書き出しに対応していません');
    a.toast('オーディオを作っています…（曲の長さによって数秒〜数十秒）', 60000);
    try {
      a.synth.ensure();
      const blob = await renderWav(a.score, a.synth, Synth);
      const r = await saveFile(a.fileBaseName() + '.wav', blob, 'wav');
      a.toast(r && typeof r === 'object' ? `「${r.name}」に書き出しました` : 'WAV を書き出しました', 2600);
    } catch (e) { console.error(e); a.toast('書き出せませんでした：' + e.message, 3500); }
  }

  // ───────── ドラム・TAB の音符メニュー ─────────
  drumMenu(pt) {
    const a = this.app;
    const ids = a.selIds();
    a.dialogs.menu(pt, [{ head: 'ドラムの種類' }, ...DRUMS.map(d => ({ label: d.ja, run: () => a.edit('ドラムの種類', () => ids.forEach(id => a.setDrum(id, d))) }))]);
  }
  stringMenu(pt, part) {
    const a = this.app;
    const tab = part.staves.find(st => st.tabOf != null);
    const n = (tab?.tuning || TUNINGS.guitar.notes).length;
    const ids = a.selIds();
    a.dialogs.menu(pt, [{ head: '弦の指定（TAB）' },
      { label: '自動（いちばん低いフレット）', run: () => a.edit('弦の指定', () => ids.forEach(id => a.setString(id, null))) },
      ...[...Array(n)].map((_, i) => ({ label: `${i + 1}弦`, run: () => a.edit('弦の指定', () => ids.forEach(id => a.setString(id, i + 1))) })),
      { head: 'チューニング' },
      ...Object.entries(TUNINGS).filter(([, t]) => t.notes.length === n || (n >= 5) === (t.notes.length >= 5)).map(([k, t]) => ({ label: t.ja, run: () => a.edit('チューニング', () => { tab.tuning = t.notes.slice(); }) })),
    ]);
  }

  // ───────── ページレイアウト ─────────
  pageLayout() {
    const a = this.app;
    const st = a.score.settings;
    const LY = { sysGap: 7, staffGap: 6.5, partGap: 7.5, perSystem: 0, spread: true, ...(st.layout || {}) };
    const mg = st.margin;
    const num = (id, label, v, step = 0.5, min = 0, max = 40) => `<label class="field"><span>${label}</span><input id="${id}" type="number" step="${step}" min="${min}" max="${max}" value="${v}"></label>`;
    this.dlg.open({
      title: 'ページレイアウト', narrow: true,
      body: `<div class="row">${num('plSys', '段と段の間隔（譜線間隔）', LY.sysGap)}${num('plPart', 'パートの間隔', LY.partGap)}</div>
        <div class="row">${num('plStaff', '同じパートの譜表の間隔', LY.staffGap)}${num('plPer', '1段の小節数（0 = 自動）', LY.perSystem, 1, 0, 16)}</div>
        <div class="row">${num('plT', '余白 上（mm）', mg.t, 1)}${num('plB', '下', mg.b, 1)}${num('plL', '左', mg.l, 1)}${num('plR', '右', mg.r, 1)}</div>
        <label class="ck"><input type="checkbox" id="plSp"${LY.spread !== false ? ' checked' : ''}><span>段をページの下まで均等に広げる</span></label>
        <p style="color:var(--muted);font-size:13px;margin:8px 0 0">段ごとの調整は、小節メニューの「前の段へ移す / 次の段へ移す / ここで改ページ」で。</p>`,
      buttons: [{ label: 'レイアウトの指定をすべて解除', onClick: () => { a.edit('レイアウトの解除', () => { delete st.layout; a.score.measures.forEach(m => { delete m.keep; delete m.pageBreak; delete m.sysSpace; delete m.sysBreak; }); }); } },
        { label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
          const q = (s) => +bd.querySelector(s).value;
          a.edit('ページレイアウト', () => {
            st.layout = { sysGap: q('#plSys'), partGap: q('#plPart'), staffGap: q('#plStaff'), perSystem: Math.round(q('#plPer')), spread: bd.querySelector('#plSp').checked };
            st.margin = { t: q('#plT'), b: q('#plB'), l: q('#plL'), r: q('#plR') };
          });
        } }],
    });
  }
  // 前の段へ（その段の最初の小節を前の段の終わりへ）/ 次の段へ（その段の最後の小節を次の段の頭へ）
  moveSystem(m, dir) {
    const a = this.app, L = a.L;
    const sy = L.systems[L.measures[m].sys];
    if (!sy) return;
    const ms = a.score.measures;
    if (dir < 0) {
      const first = sy.ms[0];
      if (first === 0) return a.toast('最初の段です');
      a.edit('前の段へ移す', () => { delete ms[first - 1].sysBreak; ms[first - 1].keep = true; ms[first].sysBreak = true; });
    } else {
      if (sy.ms.length < 2) return a.toast('1小節だけの段です');
      const last = sy.ms[sy.ms.length - 1];
      a.edit('次の段へ移す', () => { delete ms[last - 1].keep; ms[last - 1].sysBreak = true; });
    }
  }
  // 選んだ小節を1段にまとめる
  lockSystem(m1, m2) {
    const ms = this.app.score.measures;
    this.app.edit('1段にまとめる', () => {
      if (m1 > 0) { delete ms[m1 - 1].keep; ms[m1 - 1].sysBreak = true; }
      for (let m = m1; m < m2; m++) { ms[m].keep = true; delete ms[m].sysBreak; }
      ms[m2].sysBreak = true;
    });
  }
}

export { INST };
