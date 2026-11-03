// ダイアログとメニュー（新規作成ウィザード・ファイル・小節・スコア設定・ヘルプ）
import { INSTRUMENTS, INST, TEMPLATES, createScore, createPart, fillMeasures, measureAttrs } from '../core/score.js';
import * as E from '../core/edit.js';
import { keyNameJa, CLEFS, TPQ, TYPE_TICKS } from '../core/music.js';
import { ARTICS, DYNAMICS, DYN_ORDER, TEXT_PRESETS, SPANS, JUMPS, articGlyph } from '../core/marks.js';
import { SMUFL } from '../smufl.js';
const G = SMUFL.glyphs;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TIMES = [[4, 4], [3, 4], [2, 4], [2, 2], [6, 8], [9, 8], [12, 8], [3, 8], [5, 4], [7, 8]];

export class Dialogs {
  constructor(app) { this.app = app; this.root = document.getElementById('modalRoot'); }

  // ── 汎用 ──
  open({ title, body, buttons = [], narrow = false, onOpen }) {
    this.close();
    const bd = document.createElement('div');
    bd.className = 'backdrop';
    bd.innerHTML = `<div class="dialog${narrow ? ' narrow' : ''}" role="dialog"><header>${title}</header><div class="body">${body}</div>${buttons.length ? '<footer></footer>' : ''}</div>`;
    const ft = bd.querySelector('footer');
    buttons.forEach(b => {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.onclick = () => { const r = b.onClick ? b.onClick(bd) : null; if (r !== false) this.close(); };
      ft.appendChild(el);
    });
    bd.addEventListener('pointerdown', (e) => { if (e.target === bd) this.close(); });
    this.root.appendChild(bd);
    if (onOpen) onOpen(bd);
    return bd;
  }
  close() { this.root.innerHTML = ''; this.closeMenu(); }
  menu(anchor, items) {
    this.closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : it.head ? `<div class="mh">${it.head}</div>` : `<button data-i="${i}"${it.dis ? ' disabled' : ''}>${it.label}${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</button>`).join('');
    document.body.appendChild(m);
    this.placeMenu(m, anchor);
    m.onclick = (e) => { const b = e.target.closest('[data-i]'); if (!b) return; this.closeMenu(); items[+b.dataset.i].run(); };
    this.trackMenu(m);
  }
  // anchor はボタン（その下に開く）か {x, y}（右クリックした位置に開く）。下に入らなければ上に開く
  placeMenu(m, anchor, alignRight = false) {
    if (!anchor) { const tb = document.getElementById('topbar').getBoundingClientRect(); anchor = { x: Math.max(8, window.innerWidth / 2 - 160), y: tb.bottom + 4 }; }
    const isEl = !!anchor.getBoundingClientRect;
    const r = isEl ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const gap = isEl ? 6 : 2;
    const mw = m.offsetWidth, mh = m.offsetHeight;
    const x = alignRight ? r.right - mw : r.left;
    m.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, x)) + 'px';
    const below = window.innerHeight - r.bottom - gap - 8, above = r.top - gap - 8;
    if (mh > below && above > below) {
      m.style.top = Math.max(8, r.top - gap - mh) + 'px';
      m.style.maxHeight = above + 'px';
    } else {
      m.style.top = r.bottom + gap + 'px';
      m.style.maxHeight = below + 'px';
    }
    m.style.overflow = 'auto';
  }
  // メニューの外を押したら閉じる
  trackMenu(m) {
    setTimeout(() => { this.outside = (e) => { if (!m.contains(e.target)) this.closeMenu(); }; window.addEventListener('pointerdown', this.outside, true); });
    this.menuEl = m;
  }
  // 1行の文字を入れてもらう（prompt の代わり。iPad でも見やすく、Enter で決定）
  ask(title, hint, value, cb) {
    this.open({
      title: esc(title), narrow: true,
      body: `<label class="field"><span>${esc(hint || '')}</span><input id="askIn" value="${esc(value || '')}" enterkeyhint="done" autocomplete="off"></label>`,
      onOpen: (bd) => {
        const inp = bd.querySelector('#askIn');
        setTimeout(() => { inp.focus(); inp.select(); }, 40);
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); const v = inp.value.trim(); this.close(); cb(v); } if (e.key === 'Escape') this.close(); });
      },
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => { const v = bd.querySelector('#askIn').value.trim(); setTimeout(() => cb(v)); } }],
    });
  }
  closeMenu() {
    if (this.menuEl) { this.menuEl.remove(); this.menuEl = null; }
    if (this.outside) { window.removeEventListener('pointerdown', this.outside, true); this.outside = null; }
  }

  // ── 新規作成ウィザード（Finale のセットアップウィザードに相当） ──
  newScore(first = false, tmplId = null) {
    let tmpl = tmplId || 'piano';
    let insts = [...(TEMPLATES.find(t => t.id === tmpl)?.insts || ['piano'])];
    let time = [4, 4];
    let fifths = 0;
    const famOrder = [...new Set(INSTRUMENTS.map(i => i.fam))];
    const body = `
      ${first ? '<p style="margin:0 0 12px;color:var(--muted)">ようこそ！まずは楽譜の形を決めましょう。あとから「スコア」メニューでいつでも変更できます。</p>' : ''}
      <div class="row">
        <label class="field"><span>タイトル</span><input id="nsTitle" value="無題" enterkeyhint="next"></label>
        <label class="field"><span>作曲者</span><input id="nsComposer" placeholder="（任意）"></label>
      </div>
      <div class="field"><span>テンプレート</span><div class="chips" id="nsTmpl">${TEMPLATES.map(t => `<button class="chip${t.id === tmpl ? ' on' : ''}" data-t="${t.id}">${t.ja}</button>`).join('')}</div></div>
      <div class="field"><span>楽器（左から追加・右で並べ替え）</span>
        <div class="inst-wrap">
          <div class="inst-list" id="nsAll">${famOrder.map(f => `<div class="fam">${f}</div>${INSTRUMENTS.filter(i => i.fam === f).map(i => `<div class="it" data-add="${i.id}"><span>${i.ja}</span><button title="追加">＋</button></div>`).join('')}`).join('')}</div>
          <div class="inst-list" id="nsSel"></div>
        </div>
      </div>
      <div class="field"><span>拍子</span><div class="chips" id="nsTime">${TIMES.map(([b, t]) => `<button class="chip${b === 4 && t === 4 ? ' on' : ''}" data-b="${b}" data-tt="${t}">${b}/${t}</button>`).join('')}</div></div>
      <div class="row">
        <label class="field"><span>調号</span><select id="nsKey">${Array.from({ length: 15 }, (_, i) => i - 7).map(f => `<option value="${f}"${f === 0 ? ' selected' : ''}>${keyNameJa(f)}（${f > 0 ? '♯' + f : f < 0 ? '♭' + -f : '調号なし'}）</option>`).join('')}</select></label>
        <label class="field"><span>テンポ（4分音符 = ）</span><input id="nsBpm" type="number" inputmode="numeric" value="100" min="20" max="400"></label>
      </div>
      <div class="row">
        <label class="field"><span>小節数</span><input id="nsMeasures" type="number" inputmode="numeric" value="32" min="1" max="999"></label>
        <label class="field"><span>弱起（アウフタクト）</span><select id="nsPickup"><option value="0">なし</option><option value="${TPQ / 2}">8分音符1つ</option><option value="${TPQ}">4分音符1つ</option><option value="${TPQ * 2}">4分音符2つ</option><option value="${TPQ * 3}">4分音符3つ</option></select></label>
      </div>`;
    const bd = this.open({
      title: '新しい楽譜', body,
      buttons: [
        ...(first ? [] : [{ label: 'キャンセル' }]),
        { label: '作成', cls: 'primary', onClick: (bd) => {
          if (!insts.length) { this.app.toast('楽器を1つ以上選んでください'); return false; }
          const score = createScore({
            title: bd.querySelector('#nsTitle').value.trim() || '無題',
            composer: bd.querySelector('#nsComposer').value.trim(),
            insts, time: { beats: time[0], beatType: time[1] }, fifths: +bd.querySelector('#nsKey').value,
            bpm: +bd.querySelector('#nsBpm').value || 100,
            measures: Math.max(1, Math.min(999, +bd.querySelector('#nsMeasures').value || 32)),
            pickup: +bd.querySelector('#nsPickup').value || 0,
          });
          if (!first) this.app.save();
          this.app.newDoc(score);
          if (this.app.home?.visible) { this.app.home.canBack = true; this.app.home.hide(); }
          this.app.view.resetZoom();
          this.app.state.mode = 'input';
          this.app.relayout();
          this.app.view.scroller.scrollTo({ top: 0, left: 0 });
          this.app.toast('入力モードです：五線をタップするか、A〜G キー / MIDI 鍵盤で入力できます', 3200);
        } },
      ],
    });
    const renderSel = () => {
      bd.querySelector('#nsSel').innerHTML = insts.length ? insts.map((id, i) => `<div class="it"><span>${INST[id].ja}</span><span><button data-up="${i}" title="上へ">↑</button><button data-dn="${i}" title="下へ">↓</button><button data-rm="${i}" title="削除">✕</button></span></div>`).join('') : '<div class="fam">楽器が選ばれていません</div>';
    };
    renderSel();
    bd.querySelector('#nsAll').onclick = (e) => { const it = e.target.closest('[data-add]'); if (it) { insts.push(it.dataset.add); renderSel(); tmplOff(); } };
    bd.querySelector('#nsSel').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.rm) insts.splice(+b.dataset.rm, 1);
      if (b.dataset.up && +b.dataset.up > 0) { const i = +b.dataset.up; [insts[i - 1], insts[i]] = [insts[i], insts[i - 1]]; }
      if (b.dataset.dn && +b.dataset.dn < insts.length - 1) { const i = +b.dataset.dn; [insts[i + 1], insts[i]] = [insts[i], insts[i + 1]]; }
      renderSel(); tmplOff();
    };
    const tmplOff = () => bd.querySelectorAll('#nsTmpl .chip').forEach(c => c.classList.remove('on'));
    bd.querySelector('#nsTmpl').onclick = (e) => {
      const c = e.target.closest('[data-t]'); if (!c) return;
      tmpl = c.dataset.t; insts = [...TEMPLATES.find(t => t.id === tmpl).insts];
      tmplOff(); c.classList.add('on'); renderSel();
    };
    bd.querySelector('#nsTime').onclick = (e) => {
      const c = e.target.closest('[data-b]'); if (!c) return;
      time = [+c.dataset.b, +c.dataset.tt];
      bd.querySelectorAll('#nsTime .chip').forEach(x => x.classList.toggle('on', x === c));
    };
    void fifths;
  }

  // ── スコア情報 ──
  scoreInfo() {
    const m = this.app.score.meta;
    this.open({
      title: 'スコア情報', narrow: true,
      body: `
        <label class="field"><span>タイトル</span><input id="siTitle" value="${esc(m.title)}"></label>
        <label class="field"><span>サブタイトル</span><input id="siSub" value="${esc(m.subtitle)}"></label>
        <div class="row"><label class="field"><span>作曲者</span><input id="siComp" value="${esc(m.composer)}"></label>
        <label class="field"><span>作詞者</span><input id="siLyr" value="${esc(m.lyricist)}"></label></div>
        <div class="row"><label class="field"><span>編曲者</span><input id="siArr" value="${esc(m.arranger)}"></label>
        <label class="field"><span>著作権（1ページ目の下）</span><input id="siCopy" value="${esc(m.copyright)}"></label></div>`,
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
        const v = (id) => bd.querySelector(id).value.trim();
        this.app.edit('スコア情報', () => { Object.assign(this.app.score.meta, { title: v('#siTitle'), subtitle: v('#siSub'), composer: v('#siComp'), lyricist: v('#siLyr'), arranger: v('#siArr'), copyright: v('#siCopy') }); });
      } }],
    });
  }

  // ── 小節メニュー ──
  measureMenu(anchor) {
    const a = this.app;
    const m = a.targetMeasure();
    this.menu(anchor, [
      { head: `第${m + 1}小節から` },
      { label: '拍子を変更…', run: () => this.timeSig() },
      { label: '調号を変更…', run: () => this.keySig() },
      { label: '音部記号を変更…', run: () => this.clef() },
      { label: 'テンポを変更…', run: () => this.tempo() },
      '-',
      { label: '前に小節を挿入', run: () => a.edit('小節の挿入', () => E.appendMeasures(a.score, 1, m)) },
      { label: '末尾に小節を追加…', kbd: 'Ctrl+B', run: () => this.appendMeasures() },
      { label: '選択した小節を削除', run: () => this.deleteMeasures() },
      '-',
      { label: '弱起（アウフタクト）の設定…', run: () => this.pickup() },
      { label: '反復記号・カッコ・D.S. / Coda…', run: () => this.repeats(m) },
      { label: (a.score.measures[m].sysBreak ? '✓ ' : '') + 'この小節の後で改段', run: () => a.edit('改段', () => { a.score.measures[m].sysBreak = !a.score.measures[m].sysBreak; delete a.score.measures[m].keep; }) },
      { label: (a.score.measures[m].pageBreak ? '✓ ' : '') + 'この小節の後で改ページ', run: () => a.edit('改ページ', () => { const x = a.score.measures[m]; x.pageBreak = !x.pageBreak; if (x.pageBreak) { x.sysBreak = true; delete x.keep; } else delete x.pageBreak; }) },
      { label: 'この段の最初の小節を前の段へ', run: () => a.tools.moveSystem(m, -1) },
      { label: 'この段の最後の小節を次の段へ', run: () => a.tools.moveSystem(m, 1) },
      ...(a.state.sel?.kind === 'range' && a.state.sel.m2 > a.state.sel.m1 ? [{ label: `第${a.state.sel.m1 + 1}〜${a.state.sel.m2 + 1}小節を1段にまとめる`, run: () => a.tools.lockSystem(a.state.sel.m1, a.state.sel.m2) }] : []),
      { label: 'この段の上を広げる / 狭める…', run: () => { const x = a.score.measures[a.L.systems[a.L.measures[m].sys].ms[0]]; const v = prompt('この段の上に足す間隔（譜線間隔。0 で元に戻す。マイナスで狭める）', x.sysSpace || 0); if (v != null && Number.isFinite(+v)) a.edit('段の間隔', () => { if (+v) x.sysSpace = +v; else delete x.sysSpace; }); } },
      { label: '小節線：' + ({ final: '終止線', double: '複縦線' }[a.score.measures[m].barline] || '通常') + ' → 切り替え', run: () => a.edit('小節線', () => { const ms = a.score.measures[m]; ms.barline = !ms.barline ? 'double' : ms.barline === 'double' ? 'final' : undefined; if (!ms.barline) delete ms.barline; }) },
    ]);
  }

  timeSig() {
    const a = this.app;
    const m = a.targetMeasure();
    const cur = a.L.attrs[m].time;
    this.open({
      title: `拍子の変更（第${m + 1}小節から）`, narrow: true,
      body: `<div class="chips" id="tsCh">${TIMES.map(([b, t]) => `<button class="chip${b === cur.beats && t === cur.beatType ? ' on' : ''}" data-b="${b}" data-tt="${t}">${b}/${t}</button>`).join('')}<button class="chip" data-sym="common">C（4/4）</button><button class="chip" data-sym="cut">¢（2/2）</button></div>
        <div class="row" style="margin-top:12px"><label class="field"><span>拍の数</span><input id="tsB" type="number" inputmode="numeric" value="${cur.beats}" min="1" max="32"></label>
        <label class="field"><span>拍の単位</span><select id="tsT">${[1, 2, 4, 8, 16, 32].map(x => `<option${x === cur.beatType ? ' selected' : ''}>${x}</option>`).join('')}</select></label></div>
        <label class="ck" style="margin-top:8px"><input type="checkbox" id="tsRebar" checked><span>音符を新しい小節線で組み直す（Finale の「小節の再構成」。はみ出す音はタイで次の小節へ）</span></label>`,
      onOpen: (bd) => {
        bd.querySelector('#tsCh').onclick = (e) => {
          const c = e.target.closest('.chip'); if (!c) return;
          bd.querySelectorAll('#tsCh .chip').forEach(x => x.classList.toggle('on', x === c));
          if (c.dataset.sym) { bd.querySelector('#tsB').value = c.dataset.sym === 'common' ? 4 : 2; bd.querySelector('#tsT').value = c.dataset.sym === 'common' ? 4 : 2; bd.dataset.sym = c.dataset.sym; }
          else { bd.querySelector('#tsB').value = c.dataset.b; bd.querySelector('#tsT').value = c.dataset.tt; delete bd.dataset.sym; }
        };
      },
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
        const time = { beats: Math.max(1, +bd.querySelector('#tsB').value || 4), beatType: +bd.querySelector('#tsT').value };
        if (bd.dataset.sym) time.symbol = bd.dataset.sym;
        a.insertTime(time, bd.querySelector('#tsRebar').checked);
      } }],
    });
  }

  keySig() {
    const a = this.app;
    const m = a.targetMeasure();
    const cur = a.L.attrs[m].fifths;
    this.open({
      title: `調号の変更（第${m + 1}小節から）`, narrow: true,
      body: `<div class="chips" id="ksCh">${Array.from({ length: 15 }, (_, i) => i - 7).map(f => `<button class="chip${f === cur ? ' on' : ''}" data-f="${f}" style="min-width:100%;text-align:left">${f > 0 ? '♯' + f : f < 0 ? '♭' + -f : '±0'}　${keyNameJa(f)}</button>`).join('')}</div>
        <label class="field" style="margin-top:12px;flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="ksTr" style="width:22px;height:22px"><span style="font-size:14px;color:var(--text)">音符も一緒に移調する（Finale の「音符を移調」）</span></label>`,
      onOpen: (bd) => { bd.querySelector('#ksCh').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; bd.querySelectorAll('#ksCh .chip').forEach(x => x.classList.toggle('on', x === c)); }; },
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
        const on = bd.querySelector('#ksCh .chip.on');
        if (!on) return;
        const f = +on.dataset.f;
        const tr = bd.querySelector('#ksTr').checked;
        a.edit('調号の変更', () => {
          const A = measureAttrs(a.score);
          if (tr && f !== cur) {
            // 5度圏の差から半音数を求め、近い方向へ移調
            let semis = (((f - cur) * 7) % 12 + 12) % 12;
            if (semis > 6) semis -= 12;
            let end = a.score.measures.length - 1;
            for (let i = m + 1; i < a.score.measures.length; i++) if (a.score.measures[i].key) { end = i - 1; break; }
            const staves = a.staffRows().map(r => [r.p, r.s]);
            E.transposeRange(a.score, { m1: m, m2: end, staves }, semis, f);
          }
          E.setKey(a.score, m, f);
          void A;
        });
      } }],
    });
  }

  clef() {
    const a = this.app;
    const loc = a.state.mode === 'input' ? a.state.caret : a.selLoc();
    if (!loc) return a.toast('音部記号を変える譜表の小節を選んでください');
    const m = loc.m;
    this.open({
      title: `音部記号（${a.score.parts[loc.p].name}・第${m + 1}小節から）`, narrow: true,
      body: `<div class="chips" id="clCh">${Object.entries(CLEFS).map(([k, c]) => `<button class="chip" data-c="${k}">${c.ja}</button>`).join('')}</div>`,
      onOpen: (bd) => { bd.querySelector('#clCh').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; a.edit('音部記号', () => E.setClef(a.score, loc.p, loc.s, m, c.dataset.c)); this.close(); }; },
      buttons: [{ label: 'キャンセル' }],
    });
  }

  tempo() {
    const a = this.app;
    const m = a.targetMeasure();
    const cur = a.L.attrs[m].bpm;
    const ms = a.score.measures[m];
    this.open({
      title: `テンポ（第${m + 1}小節から）`, narrow: true,
      body: `<div class="row"><label class="field"><span>拍の単位</span><select id="tpU">${[['quarter', '♩ 4分音符'], ['half', '𝅗𝅥 2分音符'], ['eighth', '♪ 8分音符'], ['quarterDot', '♩. 付点4分（6/8 など）'], ['halfDot', '𝅗𝅥. 付点2分'], ['eighthDot', '♪. 付点8分']].map(([v, l]) => `<option value="${v}"${(ms.tempo?.unit || 'quarter') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>＝（1分間にいくつ）</span><input id="tpB" type="number" inputmode="numeric" value="${ms.tempo?.bpm ?? cur}" min="20" max="400"></label></div>
        <div class="row">
        <label class="field"><span>表示する文字（任意）</span><input id="tpT" value="${esc(ms.tempo?.text || '')}" placeholder="Allegro など"></label></div>
        <label class="ck" style="margin:0 0 10px"><input type="checkbox" id="tpH"${ms.tempo?.hideBpm ? ' checked' : ''}><span>文字だけ表示する（数字は出さない・再生には使う）</span></label>
        <div class="chips">${[['Largo', 50], ['Adagio', 66], ['Andante', 80], ['Moderato', 100], ['Allegretto', 112], ['Allegro', 132], ['Presto', 168]].map(([n, b]) => `<button class="chip" data-n="${n}" data-b="${b}">${n} ${b}</button>`).join('')}</div>`,
      onOpen: (bd) => { bd.querySelector('.chips').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; bd.querySelector('#tpB').value = c.dataset.b; bd.querySelector('#tpT').value = c.dataset.n; }; },
      buttons: [
        ...(m > 0 && ms.tempo ? [{ label: 'この変更を削除', cls: 'danger', onClick: () => a.edit('テンポ削除', () => { delete a.score.measures[m].tempo; }) }] : []),
        { label: 'キャンセル' },
        { label: 'OK', cls: 'primary', onClick: (bd) => {
          const bpm = Math.max(20, Math.min(400, +bd.querySelector('#tpB').value || 100));
          const text = bd.querySelector('#tpT').value.trim();
          const unit = bd.querySelector('#tpU').value, hide = bd.querySelector('#tpH').checked;
          a.edit('テンポ', () => { a.score.measures[m].tempo = { bpm, ...(text ? { text } : {}), ...(unit !== 'quarter' ? { unit } : {}), ...(hide && text ? { hideBpm: true } : {}) }; });
        } },
      ],
    });
  }

  appendMeasures() {
    const a = this.app;
    this.open({
      title: '小節を追加', narrow: true,
      body: `<label class="field"><span>末尾に追加する小節数</span><input id="amN" type="number" inputmode="numeric" value="4" min="1" max="500"></label>`,
      buttons: [{ label: 'キャンセル' }, { label: '追加', cls: 'primary', onClick: (bd) => {
        const n = Math.max(1, Math.min(500, +bd.querySelector('#amN').value || 1));
        a.edit('小節の追加', () => E.appendMeasures(a.score, n));
        a.toast(`${n}小節追加しました`);
      } }],
    });
  }

  deleteMeasures() {
    const a = this.app;
    const sel = a.state.sel;
    const m1 = sel?.kind === 'range' ? sel.m1 : a.targetMeasure();
    const m2 = sel?.kind === 'range' ? sel.m2 : m1;
    if (!confirm(`第${m1 + 1}〜${m2 + 1}小節を、全パートから削除しますか？`)) return;
    const ok = a.edit('小節の削除', () => { if (!E.deleteMeasures(a.score, m1, m2)) return false; });
    if (ok === false) return a.toast('全部の小節は削除できません');
    a.state.sel = null;
    a.state.caret = { ...a.state.caret, m: Math.min(a.state.caret.m, a.score.measures.length - 1), t: 0 };
    a.refreshOverlays(); a.updateUI();
  }

  pickup() {
    const a = this.app;
    const cur = a.score.measures[0].pickup || 0;
    const opts = [[0, 'なし'], [TPQ / 2, '8分音符1つ'], [TPQ, '4分音符1つ'], [TPQ * 3 / 2, '付点4分音符'], [TPQ * 2, '4分音符2つ'], [TPQ * 3, '4分音符3つ']];
    this.open({
      title: '弱起（アウフタクト）', narrow: true,
      body: `<div class="chips" id="puCh">${opts.map(([t, l]) => `<button class="chip${t === cur ? ' on' : ''}" data-t="${t}">${l}</button>`).join('')}</div>`,
      onOpen: (bd) => { bd.querySelector('#puCh').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; a.edit('弱起', () => E.setPickup(a.score, +c.dataset.t)); this.close(); }; },
      buttons: [{ label: '閉じる' }],
    });
  }

  // ── 記号のメニュー（パレットの「ほか」「表情」・右クリック・X キー） ──
  marksMenu(kind, anchor) {
    const a = this.app;
    const mg = (g) => `<span class="mg">${G[g].c}</span>`;
    let items;
    if (kind === 'art') {
      items = [{ head: 'アーティキュレーション・装飾記号（選んだ音符に付ける／外す）' }, ...Object.entries(ARTICS).map(([k, x]) => ({
        label: `${mg(articGlyph(k, false))}${x.ja}`, kbd: x.key || '', run: () => a.toggleArtic(k),
      }))];
    } else if (kind === 'expr') {
      items = [{ head: '強弱記号' }, ...DYN_ORDER.map(v => ({ label: `${mg(DYNAMICS[v].g)}<span class="ml">${v}</span>`, run: () => a.addDynamic(v) })),
        '-', { head: '文字の表情記号' }, ...TEXT_PRESETS.map(p => ({ label: `<span class="mt${p.it ? ' it' : ''}">${esc(p.text)}</span><small>${p.pos === 'below' ? '下' : '上'}</small>`, run: () => a.addTextDir(p.text, p.pos, p.it) })),
        '-', { label: '文字を入力して付ける…', run: () => this.textExpr(null, (d) => a.addTextDir(d.text, d.pos, d.it)) }];
    } else {
      items = [{ head: '線の記号（選んだ音符から音符まで）' }, ...Object.entries(SPANS).map(([k, x]) => ({ label: x.ja, kbd: x.key || '', run: () => a.addSpan(k) }))];
    }
    this.menu(anchor, items);
    if (this.menuEl) this.menuEl.classList.add('marks-menu');
  }

  // 文字の表情記号（dolce・rit. など）を入力・編集
  textExpr(d, onOk) {
    const cur = d || { text: '', pos: 'above', it: true };
    this.open({
      title: d ? '文字の表情記号を編集' : '文字の表情記号', narrow: true,
      body: `<label class="field"><span>文字</span><input id="teT" value="${esc(cur.text)}" placeholder="dolce / rit. / pizz. など"></label>
        <div class="field"><span>置く場所</span><div class="chips" id="teP"><button class="chip${cur.pos !== 'below' ? ' on' : ''}" data-p="above">譜表の上</button><button class="chip${cur.pos === 'below' ? ' on' : ''}" data-p="below">譜表の下（強弱記号の高さ）</button></div></div>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="teI" style="width:22px;height:22px"${cur.it !== false ? ' checked' : ''}><span style="font-size:14px;color:var(--text)">斜体（イタリック）</span></label>`,
      onOpen: (bd) => {
        bd.querySelector('#teP').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; bd.querySelectorAll('#teP .chip').forEach(x => x.classList.toggle('on', x === c)); };
        setTimeout(() => bd.querySelector('#teT').focus(), 50);
      },
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
        const text = bd.querySelector('#teT').value.trim();
        if (!text) return false;
        onOk({ text, pos: bd.querySelector('#teP .chip.on')?.dataset.p || 'above', it: bd.querySelector('#teI').checked });
      } }],
    });
  }

  // 反復記号・カッコ・セーニョ/コーダ・D.C./D.S.（Finale の反復記号ツール）
  repeats(mi = null) {
    const a = this.app;
    const sel = a.state.sel;
    const m = mi ?? a.targetMeasure();
    const ms = a.score.measures[m];
    const range = sel?.kind === 'range' && sel.m2 > sel.m1 && mi == null ? sel : null;
    const e = ms.ending || null;
    const chk = (id, on, label) => `<label class="ck"><input type="checkbox" id="${id}"${on ? ' checked' : ''}><span>${label}</span></label>`;
    this.open({
      title: `反復記号（第${m + 1}小節）`, narrow: true,
      body: `${range ? `<button class="btn primary" id="rpRange" style="width:100%;margin-bottom:12px">第${range.m1 + 1}〜${range.m2 + 1}小節をくり返す（|: 〜 :|）</button>` : ''}
        <div class="rp">
          ${chk('rpS', ms.repeatStart, '反復の始まり <b>|:</b>（この小節の頭）')}
          <div class="rp-row">${chk('rpE', ms.repeatEnd, '反復の終わり <b>:|</b>（この小節の終わり）')}
            <select id="rpT">${[2, 3, 4, 5].map(n => `<option value="${n}"${(ms.repeatEnd?.times || 2) === n ? ' selected' : ''}>${n}回演奏</option>`).join('')}</select></div>
          <div class="rp-row"><span>カッコ</span><select id="rpN"><option value="">なし</option>${['1', '2', '3', '1,2', '4'].map(n => `<option value="${n}"${e && (e.nums || []).join(',') === n ? ' selected' : ''}>${n.replace(',', '., ')}. 番カッコ</option>`).join('')}</select>
            <span>長さ</span><input id="rpL" type="number" min="1" max="32" value="${e?.len || 1}" style="width:64px"><span>小節</span></div>
          <hr>
          ${chk('rpSeg', ms.segno, 'セーニョ 𝄋（この小節の頭。D.S. で戻る所）')}
          ${chk('rpCoda', ms.coda, 'コーダ 𝄌（この小節からコーダ）')}
          ${chk('rpTo', ms.toCoda, 'To Coda（この小節の終わりからコーダへ飛ぶ）')}
          ${chk('rpFine', ms.fine, 'Fine（D.C./D.S. のあと、この小節で終わる）')}
          <div class="rp-row"><span>この小節の終わりで</span><select id="rpJ"><option value="">（飛ばない）</option>${Object.entries(JUMPS).map(([k, j]) => `<option value="${k}"${ms.jump === k ? ' selected' : ''}>${j.ja}</option>`).join('')}</select></div>
        </div>
        <p style="color:var(--muted);font-size:13px;margin:8px 0 0">再生もこの順番どおりに進みます。</p>`,
      onOpen: (bd) => {
        const rb = bd.querySelector('#rpRange');
        if (rb) rb.onclick = () => {
          a.edit('反復', () => { a.score.measures[range.m1].repeatStart = true; a.score.measures[range.m2].repeatEnd = { times: 2 }; });
          this.close();
          a.toast(`第${range.m1 + 1}〜${range.m2 + 1}小節に反復記号を付けました`);
        };
      },
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
        const q = (id) => bd.querySelector(id);
        a.edit('反復記号', () => {
          const x = a.score.measures[m];
          const set = (k, v) => { if (v) x[k] = v; else delete x[k]; };
          set('repeatStart', q('#rpS').checked);
          set('repeatEnd', q('#rpE').checked ? { times: +q('#rpT').value } : null);
          const nums = q('#rpN').value;
          set('ending', nums ? { nums: nums.split(',').map(Number), len: Math.max(1, Math.min(32, +q('#rpL').value || 1)) } : null);
          set('segno', q('#rpSeg').checked); set('coda', q('#rpCoda').checked);
          set('toCoda', q('#rpTo').checked); set('fine', q('#rpFine').checked);
          set('jump', q('#rpJ').value || null);
        });
      } }],
    });
  }

  instruments() {
    const a = this.app;
    const sc = a.score;
    let parts = sc.parts.map(p => ({ ref: p, id: p.inst, name: p.name }));
    const famOrder = [...new Set(INSTRUMENTS.map(i => i.fam))];
    const bd = this.open({
      title: '楽器の設定',
      body: `<div class="inst-wrap">
          <div class="inst-list" id="ipAll">${famOrder.map(f => `<div class="fam">${f}</div>${INSTRUMENTS.filter(i => i.fam === f).map(i => `<div class="it" data-add="${i.id}"><span>${i.ja}</span><button>＋</button></div>`).join('')}`).join('')}</div>
          <div class="inst-list" id="ipSel"></div></div>
        <p style="color:var(--muted);font-size:13px">名前はタップして変更できます。削除したパートの音符は消えます（元に戻すで戻せます）。</p>`,
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: () => {
        if (!parts.length) { a.toast('楽器を1つ以上残してください'); return false; }
        a.edit('楽器の設定', () => {
          sc.parts = parts.map(x => { const p = x.ref || createPart(x.id); p.name = x.name; return p; });
          fillMeasures(sc);
        });
        a.state.sel = null; a.state.caret = { p: 0, s: 0, m: 0, v: 0, t: 0 };
        a.view.resetZoom(); a.relayout();
      } }],
    });
    const render = () => {
      bd.querySelector('#ipSel').innerHTML = parts.map((x, i) => `<div class="it"><span data-nm="${i}" style="flex:1;cursor:text">${esc(x.name)}</span><span><button data-up="${i}">↑</button><button data-dn="${i}">↓</button><button data-rm="${i}">✕</button></span></div>`).join('');
    };
    render();
    bd.querySelector('#ipAll').onclick = (e) => { const it = e.target.closest('[data-add]'); if (it) { parts.push({ ref: null, id: it.dataset.add, name: INST[it.dataset.add].ja }); render(); } };
    bd.querySelector('#ipSel').onclick = (e) => {
      const nm = e.target.closest('[data-nm]');
      if (nm) { const i = +nm.dataset.nm; const v = prompt('パート名', parts[i].name); if (v != null && v.trim()) { parts[i].name = v.trim(); render(); } return; }
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.rm) parts.splice(+b.dataset.rm, 1);
      if (b.dataset.up && +b.dataset.up > 0) { const i = +b.dataset.up; [parts[i - 1], parts[i]] = [parts[i], parts[i - 1]]; }
      if (b.dataset.dn && +b.dataset.dn < parts.length - 1) { const i = +b.dataset.dn; [parts[i + 1], parts[i]] = [parts[i], parts[i + 1]]; }
      render();
    };
  }

  pageSetup() {
    const a = this.app;
    const s = a.score.settings;
    this.open({
      title: '譜表サイズ・ページ設定', narrow: true,
      body: `<label class="field"><span>五線の高さ（mm）：標準 7.0、小さめ 6.0、大きめ 8.0</span><input id="psH" type="number" step="0.1" min="4" max="12" value="${s.staffMm}"></label>
        <label class="field"><span>用紙</span><select id="psP">${[['210x297', 'A4 縦'], ['297x210', 'A4 横'], ['257x364', 'B4 縦'], ['364x257', 'B4 横'], ['182x257', 'B5 縦'], ['297x420', 'A3 縦'], ['216x279', 'レター'], ['229x305', '9×12 インチ（楽譜用）'], ['148x210', 'A5 縦']].map(([v, l]) => `<option value="${v}"${s.page.w + 'x' + s.page.h === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="row">${['t', 'b', 'l', 'r'].map(k => `<label class="field"><span>余白 ${{ t: '上', b: '下', l: '左', r: '右' }[k]}（mm）</span><input id="psM${k}" type="number" min="3" max="40" value="${s.margin[k]}"></label>`).join('')}</div>`,
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
        const h = Math.max(4, Math.min(12, +bd.querySelector('#psH').value || 7));
        const [w, hh] = bd.querySelector('#psP').value.split('x').map(Number);
        const mg = Object.fromEntries(['t', 'b', 'l', 'r'].map(k => [k, Math.max(3, Math.min(40, +bd.querySelector('#psM' + k).value || s.margin[k]))]));
        a.edit('ページ設定', () => { s.staffMm = h; s.page = { w, h: hh }; s.margin = mg; });
        a.view.resetZoom(); a.relayout();
      } }],
    });
  }

  // ── MIDI ──
  midi() {
    const a = this.app;
    const st = a.midiInfo || {};
    let body;
    if (!a.midi.supported) {
      body = `<p>このブラウザは <b>Web MIDI</b> に対応していません。</p>
        <p><b>iPad の場合：</b>Safari は Web MIDI 非対応です。App Store の <b>「Web MIDI Browser」</b>など、Web MIDI に対応したブラウザアプリでこのページを開くと、USB / Bluetooth の MIDI キーボードが使えます。</p>
        <p><b>PC の場合：</b>Chrome か Edge で開いてください。</p>
        <p>MIDI キーボードがなくても、下のパレットの「鍵盤」ボタンで画面鍵盤が使えます。</p>`;
    } else if (st.ok) {
      body = `<p>接続中のデバイス：<b>${st.devices.length ? st.devices.map(esc).join('、') : '（なし。キーボードをつなぐと自動で認識します）'}</b></p>
        <h3>MIDI キーボードでの入力（ステップ入力）</h3>
        <p>① 入力モード（N キー or パレットの「入力」）にする<br>② 音価を選ぶ（数字キー 5=4分, 4=8分 … or パレット）<br>③ 鍵盤を弾くと、その高さの音が入ってカーソルが進む</p>
        <p>和音は<b>鍵盤を押さえたまま次の鍵盤を弾く</b>と重なります。Finale の Speedy Entry と同じく「左手で音価、右手で鍵盤」で入力できます。</p>`;
    } else body = `<p>MIDI の利用が許可されませんでした。ブラウザの設定で MIDI を許可して、再読み込みしてください。</p>`;
    this.open({ title: 'MIDI キーボード', body, narrow: true, buttons: [...(a.midi.supported && !st.ok ? [{ label: '再接続', onClick: () => { a.midi.connect(); } }] : []), { label: '閉じる', cls: 'primary' }] });
  }

  // ── アプリとしてインストール（ブラウザがインストール画面を出せないときの案内） ──
  installHelp() {
    this.open({
      title: 'アプリとしてインストール', narrow: true,
      body: `<div class="help">
        <p>インストールすると、ブラウザの枠なしの専用ウィンドウで開き、スタートメニューやタスクバーから起動できます。ネットがなくても動きます。</p>
        <h3>PC（Edge・Chrome）</h3>
        <p>アドレスバーの右端にある <b>インストール</b> のアイコン（□に↓、または「アプリを利用できます」）を押します。<br>
        見当たらないときは、ブラウザの「…」メニュー →「アプリ」→「このサイトをアプリとしてインストール」。</p>
        <p>インストールしたアプリでは、<b>.kanade / .musicxml / .mxl</b> を右クリック →「プログラムから開く」で KANADE を選べます。</p>
        <h3>iPad（Safari）</h3>
        <p>共有ボタン（□↑）→「ホーム画面に追加」。</p>
        <p style="font-size:13px;color:var(--muted)">※ Firefox はアプリのインストールに対応していません（普通に使うのは問題ありません）。</p>
      </div>`,
      buttons: [{ label: '閉じる', cls: 'primary' }],
    });
  }

  // ── ヘルプ ──
  help() {
    const k = (s) => s.split(' ').map(x => `<kbd>${x}</kbd>`).join(' ');
    this.open({
      title: 'KANADE の使い方',
      body: `<div class="help">
        <p><b>2つのモード</b>があります。<b>入力モード</b>（ピンクのカーソル）で音を入れ、<b>選択モード</b>（青）で直します。N キーかパレット左端で切り替えます。</p>
        <h3>音を入れる（入力モード）</h3>
        <p>・<b>タップ／Apple Pencil</b>：五線の上をタップすると、その高さ・その位置に、選んでいる音価で入ります。Pencil や マウスなら押したまま動かすとゴースト音符で確認できます。指でなぞるとスクロールです。<br>
        ・<b>キーボード</b>：数字で音価 → A〜G で音名。前の音に一番近いオクターブに入ります。<br>
        ・<b>MIDI キーボード／画面鍵盤</b>：弾いた音がそのまま入ります。押さえたまま弾くと和音。</p>
        <h3>直す（選択モード）</h3>
        <p>・音符をタップで選択 → 上下ドラッグ（ペン/マウス）や ↑↓ キーで音高、パレットの音価で長さ、♯♭で臨時記号、削除で休符に。<br>
        ・小節の空いている所をタップで小節を選択。続けて別の小節をタップすると範囲選択（Shift+クリックでも可）。コピー・貼り付け・移調（↑↓）・削除ができます。</p>
        <h3>記号を付ける（パレットの「記号」タブ）</h3>
        <p>・<b>アーティキュレーション</b>（スタッカートなど）・<b>強弱記号</b>：音符を選んでボタンを押すと付きます。もう一度押すと外れます。入力モードでは直前に入れた音符に付きます。<br>
        ・<b>スラー・松葉（cresc. / dim.）・8va・ペダル</b>：最初の音符を選び、<b>Shift+クリック</b>で最後の音符まで選んでから押します（1つだけ選ぶと次の音符まで）。入力モードで押すと、そのあと入れた音符まで伸びていき、もう一度押すと終わります。<br>
        ・付けた記号はクリックで選べます。<b>←→</b> で線の終わり、<b>Shift+←→</b> で始まりを動かし、<b>Delete</b> で削除、<b>ダブルクリック</b>で編集。<br>
        ・<b>歌詞</b>（L）：音符を選んで L。入力欄に打って<b>スペース</b>で次の音符へ、<b>-</b> でハイフン、<b>Enter</b> で終わり。日本語入力のままでも使えます（確定後のスペースで次へ）。Ctrl+↓ で2番の歌詞。<br>
        ・<b>コードネーム</b>（K）：C、Am7、F#m7b5、Bbmaj7/D のように打つと ♯♭ に直して表示します。<br>
        ・<b>装飾音符</b>（;）：装飾音符モードで入れた音は、カーソルの音符の前に小さく付きます。もう一度 ; で普通の入力へ。<br>
        ・<b>反復記号</b>：小節を選んで「反復」ボタン（または小節メニュー）。|: :|・1番2番カッコ・セーニョ・コーダ・Fine・D.C./D.S. を付けると、再生もその順番になります。</p>
        <h3>表示（上のバーの「表示」）</h3>
        <p>・<b>パート譜</b>：パートを1つ選ぶとそのパートだけの楽譜になり、続く休みの小節は1つにまとまります（リンクパート：スコアと同じデータなので、どちらで直しても両方に反映されます）。<br>
        ・<b>記譜音で表示</b>：B♭クラリネットやアルトサックスなどを、奏者が読む高さ（調号も）で表示します。画面のタップや音名キーは見えている高さで入り、MIDI キーボードと画面鍵盤は鳴る高さ（実音）で入ります。</p>
        <h3>Phase 3 の機能（上のバーの「ツール」と ●）</h3>
        <p>・<b>リアルタイム入力（HyperScribe）</b>：● ボタン。メトロノーム（とほかのパートの伴奏）に合わせて MIDI キーボードや画面鍵盤を弾き、スペースか ■ で止めると、16分・3連などにそろえて楽譜になります。ピアノは分割点で右手・左手に分かれます。<br>
        ・<b>MIDI ファイル</b>：.mid を開くと楽譜に変換（10ch はドラム譜）。「ツール → MIDI に書き出す」で反復・強弱込みの演奏を DAW へ。<b>WAV</b> にも書き出せます。<br>
        ・<b>一括編集</b>：小節を範囲選択して「ツール」か右クリック → 移調（音程指定・調号も）、音価を2倍/半分、逆行、アーティキュレーションをまとめて付ける、項目を選んで消去、異名同音、<b>エクスプロード</b>（和音を下の譜表へ分ける）、<b>インプロード</b>（複数の譜表を1段の和音に）。<br>
        ・<b>ドラム譜</b>：楽器「ドラムセット」。五線の位置でドラムが決まり（ハイハットは ×）、MIDI キーボードは GM ドラムの鍵盤で入ります。右クリック →「ドラムの種類」で変更。<br>
        ・<b>TAB 譜</b>：楽器「ギター（五線＋TAB）」など。五線に入れた音の弦とフレットを自動で表示します。TAB の弦をタップすると開放弦の音が入り、↑↓ でフレットが変わります。右クリック →「弦の指定」。<br>
        ・<b>表情付き再生</b>：rit.・accel.・a tempo などの文字、スウィング、拍の強弱、人間らしい揺れ（「ツール → 再生の設定」）。ミキサー（音量・左右・ミュート・ソロ）、メトロノーム、外部 MIDI 音源での再生も。<br>
        ・<b>ページレイアウト</b>：「スコア → ページレイアウト」で段の間隔・1段の小節数・余白。小節メニューで「前の段へ / 次の段へ / 改ページ / 1段にまとめる」。<br>
        ・<b>音域チェック</b>：「ツール → 音域チェック」で、楽器の音域から外れた音を赤く表示します。</p>
        <h3>Phase 4：Word のような画面・記号パレット</h3>
        <p>・<b>ホーム画面</b>：起動すると最近の楽譜とテンプレートが並びます。左上の家のボタン、または「ファイル」タブでいつでも戻れます（「ファイル」では保存・書き出し・印刷も）。<br>
        ・<b>リボン</b>：上のタブ（ホーム・記号・小節・レイアウト・再生・表示・ツール）を切り替えると、その下に操作が並びます。タブをダブルクリック（Ctrl+F1）でたたむと楽譜を広く使えます。<br>
        ・<b>記号</b>：「記号」タブのボタンで一覧（ギャラリー）が開きます。全部の記号は右の<b>記号パレット</b>（F9）で、名前で検索もできます。アーティキュレーション・装飾記号・フェルマータ・ブレス・強弱・線（8va・ペダル・rit. - - -・グリッサンド・ヴィブラート …）・テキスト・テンポ・反復・アルペジオ・トレモロ・符頭・運指・弦番号・音部記号・調号・拍子・小節線・連桁など。<br>
        ・<b>検索</b>（Ctrl+K）：「移調」「フェルマータ」「改ページ」のように、やりたいことや記号の名前で探して実行できます。<br>
        ・<b>ページの並べ方</b>：下のバーの右か「表示」タブで、縦（Word と同じ）・横・見開き・1段スクロール。<br>
        ・<b>MuseScore と同じ便利な操作</b>：R でくり返し、Shift+X で符尾の反転、{ } で小節の幅、Ctrl+G で小節へ移動、音程を重ねる（ツール）、声部の入れ替え、スラッシュで埋める、ループ再生と再生の速さ（再生タブ）、コードネームを鳴らす。<br>
        ・<b>拍子の変更</b>：音符を新しい小節線で組み直します（Finale の「小節の再構成」）。はみ出す音はタイで次の小節へ。<br>
        ・<b>書き出し</b>：MusicXML・MIDI・WAV に加えて、PNG・SVG の画像も。</p>
        <h3>PC（マウス）で使うとき</h3>
        <p>・<b>ドラッグ</b>で小節の範囲選択、<b>右クリック</b>でその場のメニュー（コピー・移調・拍子や調の変更など）、<b>ダブルクリック</b>でそこから入力。<br>
        ・<b>Ctrl+ホイール</b>で拡大縮小、<b>Ctrl+0</b> で画面に合わせる（大きな画面ではページを横に並べます）。<br>
        ・<b>Ctrl+S</b> で .kanade ファイルに保存（2回目からは同じファイルに上書き）。ファイルはウィンドウにドラッグ＆ドロップでも開けます。</p>
        <h3>キーボードショートカット（Finale との対応）</h3>
        <table>
          <tr><th>操作</th><th>KANADE</th><th>Finale では</th></tr>
          <tr><td>音価（64分〜全音符）</td><td>${k('1')}〜${k('7')}（5=4分, 4=8分, 6=2分, 7=全）</td><td>Speedy Entry と同じ</td></tr>
          <tr><td>音名で入力</td><td>${k('A')}〜${k('G')}</td><td>Simple Entry の音名入力</td></tr>
          <tr><td>和音に追加</td><td>${k('Shift')}+${k('A')}〜${k('G')}</td><td>Simple Entry の Shift+音名</td></tr>
          <tr><td>休符</td><td>${k('0')} / ${k('R')}</td><td>Speedy：Backspace で休符化</td></tr>
          <tr><td>付点</td><td>${k('.')}</td><td>${k('.')}</td></tr>
          <tr><td>タイ</td><td>${k('T')}</td><td>Speedy：${k('=')}</td></tr>
          <tr><td>半音上げ／下げ</td><td>${k('↑')} ${k('↓')} / ${k('+')} ${k('-')}</td><td>${k('+')} ${k('-')}</td></tr>
          <tr><td>オクターブ上下</td><td>${k('Ctrl')}+${k('↑')}${k('↓')}</td><td>—</td></tr>
          <tr><td>全音階で上下</td><td>${k('Alt')}+${k('↑')}${k('↓')}</td><td>Simple の矢印</td></tr>
          <tr><td>3連符など</td><td>${k('Ctrl')}+${k('3')}（5,6,7 も可）</td><td>Speedy：${k('Ctrl')}+${k('3')}</td></tr>
          <tr><td>スタッカート／テヌート／アクセント／マルカート／フェルマータ</td><td>${k('Shift')}+${k('S')} ${k('N')} ${k('V')} ${k('O')} ${k('U')}</td><td>アーティキュレーションツール</td></tr>
          <tr><td>スラー／クレッシェンド／デクレッシェンド</td><td>${k('S')} / ${k('<')} / ${k('>')}</td><td>スマートシェイプ</td></tr>
          <tr><td>強弱・表情記号のメニュー</td><td>${k('X')}</td><td>発想記号ツール</td></tr>
          <tr><td>歌詞／コードネーム</td><td>${k('L')} / ${k('K')}</td><td>歌詞ツール／コードツール</td></tr>
          <tr><td>装飾音符モード</td><td>${k(';')}</td><td>Speedy：${k(';')}</td></tr>
          <tr><td>選択を広げる（音符）</td><td>${k('Shift')}+${k('←')}${k('→')} / Shift+クリック</td><td>—</td></tr>
          <tr><td>声部（レイヤー）1〜4</td><td>${k('Alt')}+${k('1')}〜${k('4')}</td><td>レイヤー 1〜4</td></tr>
          <tr><td>カーソル移動</td><td>${k('←')} ${k('→')} / 譜表 ${k('Shift')}+${k('↑')}${k('↓')}</td><td>同じ</td></tr>
          <tr><td>入力 ⇄ 選択</td><td>${k('N')} / ${k('Esc')}</td><td>ツールの切り替え</td></tr>
          <tr><td>再生／停止</td><td>${k('Space')}</td><td>${k('Space')}</td></tr>
          <tr><td>元に戻す・やり直し</td><td>${k('Ctrl')}+${k('Z')} / ${k('Ctrl')}+${k('Y')}</td><td>同じ</td></tr>
          <tr><td>コピー・切り取り・貼り付け</td><td>${k('Ctrl')}+${k('C')} ${k('X')} ${k('V')}</td><td>同じ</td></tr>
          <tr><td>小節を追加</td><td>${k('Ctrl')}+${k('B')}</td><td>小節ツール</td></tr>
          <tr><td>MusicXML 書き出し／印刷</td><td>${k('Ctrl')}+${k('E')} / ${k('Ctrl')}+${k('P')}</td><td>—</td></tr>
          <tr><td>保存／名前を付けて保存</td><td>${k('Ctrl')}+${k('S')} / ${k('Ctrl')}+${k('Shift')}+${k('S')}</td><td>同じ</td></tr>
          <tr><td>開く／新規作成</td><td>${k('Ctrl')}+${k('O')} / ${k('Alt')}+${k('N')}</td><td>${k('Ctrl')}+${k('O')} / ${k('Ctrl')}+${k('N')}</td></tr>
          <tr><td>拡大／縮小／画面に合わせる</td><td>${k('Ctrl')}+${k('+')} ${k('-')} / ${k('Ctrl')}+${k('0')}</td><td>—</td></tr>
          <tr><td>この使い方</td><td>${k('F1')} / ${k('?')}</td><td>—</td></tr>
          <tr><td>検索（操作・記号）</td><td>${k('Ctrl')}+${k('K')}</td><td>—</td></tr>
          <tr><td>記号パレット</td><td>${k('F9')}</td><td>MuseScore と同じ</td></tr>
          <tr><td>小節へ移動</td><td>${k('Ctrl')}+${k('G')}</td><td>—</td></tr>
          <tr><td>くり返し（選択モード）</td><td>${k('R')}</td><td>MuseScore と同じ</td></tr>
          <tr><td>符尾の向きを反転</td><td>${k('Shift')}+${k('X')}</td><td>MuseScore の X</td></tr>
          <tr><td>小節の幅を狭める／広げる</td><td>${k('{')} ${k('}')}</td><td>MuseScore と同じ</td></tr>
          <tr><td>歌詞の伸ばし線（メリスマ）</td><td>${k('_')}</td><td>MuseScore と同じ</td></tr>
          <tr><td>リボンをたたむ</td><td>${k('Ctrl')}+${k('F1')}</td><td>Word と同じ</td></tr>
        </table>
        <p style="font-size:13px;color:var(--muted)">※ iPad では Ctrl の代わりに ⌘（Command）でも動きます。新規作成が Alt+N なのは、ブラウザでは Ctrl+N が「新しいウィンドウ」に取られてしまうためです。</p>
        <h3>Finale からの引っ越し</h3>
        <p>Finale で「ファイル → 書き出し → MusicXML」で保存し、KANADE の「ファイル → MusicXML を読み込む」で開きます（.musicxml / .xml / .mxl に対応）。</p>
        <h3>保存</h3>
        <p>楽譜は自動でこの端末に保存されます（ホーム画面の「最近使った楽譜」。右上に「保存済み」と出ます）。<br>
        PC では「ファイル → 保存」（Ctrl+S）で <b>.kanade ファイル</b>として好きな場所に保存できます。.kanade は KANADE の情報を全部そのまま残す形式で、iPad ⇄ PC の受け渡しにも使えます。ほかのソフトに渡すときは MusicXML に書き出してください。</p>
      </div>`,
      buttons: [{ label: '閉じる', cls: 'primary' }],
    });
  }
}
export { TYPE_TICKS };
