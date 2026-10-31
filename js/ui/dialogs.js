// ダイアログとメニュー（新規作成ウィザード・ファイル・小節・スコア設定・ヘルプ）
import { INSTRUMENTS, INST, TEMPLATES, createScore, createPart, fillMeasures, measureAttrs } from '../core/score.js';
import * as E from '../core/edit.js';
import { keyNameJa, CLEFS, TPQ, TYPE_TICKS } from '../core/music.js';
import { storage, canPickFiles } from '../io/storage.js';

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
    m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : it.head ? `<div class="mh">${it.head}</div>` : `<button data-i="${i}">${it.label}${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</button>`).join('');
    document.body.appendChild(m);
    // anchor はボタン（その下に開く）か {x, y}（右クリックした位置に開く）。下に入らなければ上に開く
    const isEl = !!anchor.getBoundingClientRect;
    const r = isEl ? anchor.getBoundingClientRect() : { left: anchor.x, top: anchor.y, bottom: anchor.y };
    const gap = isEl ? 6 : 2;
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left)) + 'px';
    const below = window.innerHeight - r.bottom - gap - 8, above = r.top - gap - 8;
    if (mh > below && above > below) {
      m.style.top = Math.max(8, r.top - gap - mh) + 'px';
      m.style.maxHeight = above + 'px';
    } else {
      m.style.top = r.bottom + gap + 'px';
      m.style.maxHeight = below + 'px';
    }
    m.style.overflow = 'auto';
    m.onclick = (e) => { const b = e.target.closest('[data-i]'); if (!b) return; this.closeMenu(); items[+b.dataset.i].run(); };
    setTimeout(() => { this.outside = (e) => { if (!m.contains(e.target)) this.closeMenu(); }; window.addEventListener('pointerdown', this.outside, true); });
    this.menuEl = m;
  }
  closeMenu() {
    if (this.menuEl) { this.menuEl.remove(); this.menuEl = null; }
    if (this.outside) { window.removeEventListener('pointerdown', this.outside, true); this.outside = null; }
  }

  // ── ファイルメニュー ──
  fileMenu(anchor) {
    const a = this.app;
    this.menu(anchor, [
      { label: '新規作成…', kbd: 'Alt+N', run: () => this.newScore() },
      { label: '開く…', kbd: 'Ctrl+O', run: () => this.openList() },
      ...(canPickFiles ? [
        { label: '保存' + (a.fileName ? `（${esc(a.fileName)}）` : '…'), kbd: 'Ctrl+S', run: () => a.saveToFile() },
        { label: '名前を付けて保存…', kbd: 'Ctrl+Shift+S', run: () => a.saveToFile(true) },
      ] : [
        { label: '.kanade ファイルに書き出す（PC へ渡す）', kbd: 'Ctrl+Shift+S', run: () => a.saveToFile(true) },
      ]),
      { label: '複製を作る', run: () => this.duplicate() },
      '-',
      { label: 'MusicXML を読み込む…（Finale から）', run: () => a.openFileDialog() },
      { label: 'MusicXML に書き出す', kbd: 'Ctrl+E', run: () => a.exportXML() },
      { label: '印刷 / PDF に保存', kbd: 'Ctrl+P', run: () => a.print() },
      '-',
      ...(a.isInstalled ? [] : [{ label: 'アプリとしてインストール…', run: () => a.install() }]),
      { label: (a.state.colorVoices ? '✓ ' : '') + '声部を色分けして表示', run: () => { a.state.colorVoices = !a.state.colorVoices; document.body.classList.toggle('color-voices', a.state.colorVoices); } },
      { label: (a.synth.useSamples ? '✓ ' : '') + '高音質音源を使う（ネット接続時）', run: () => { a.synth.useSamples = !a.synth.useSamples; a.toast(a.synth.useSamples ? '高音質音源：オン' : '内蔵シンセで再生します'); } },
      { label: '使い方・ショートカット', kbd: '?', run: () => this.help() },
    ]);
  }

  async openList() {
    const docs = await storage.list();
    const top = `<div class="openfile"><button class="btn primary" id="olFile">${canPickFiles ? 'PC のファイルを開く…' : '「ファイル」から開く…'}</button>
      <span>.kanade・MusicXML（.musicxml / .xml / .mxl）${canPickFiles ? '。ウィンドウにドラッグ＆ドロップでも開けます' : ''}</span></div>
      <div class="mh2">最近の楽譜（この端末に自動保存）</div>`;
    const body = top + (docs.length ? `<div class="doclist">${docs.map(d => `<div class="doc" data-id="${d.id}"><span class="nm">${esc(d.title)}${d.fileName ? `<small>${esc(d.fileName)}</small>` : ''}</span><span class="dt">${new Date(d.updated).toLocaleString('ja-JP')}</span><button data-del="${d.id}" title="削除">削除</button></div>`).join('')}</div>` : '<p>まだ保存された楽譜はありません。</p>');
    this.open({
      title: '開く', body,
      buttons: [{ label: '閉じる' }],
      onOpen: (bd) => {
        bd.querySelector('#olFile').onclick = () => { this.close(); this.app.openFileDialog(); };
        bd.querySelectorAll('.doc').forEach(el => el.addEventListener('click', async (e) => {
          const del = e.target.closest('[data-del]');
          if (del) {
            e.stopPropagation();
            if (del.dataset.del === this.app.docId) return this.app.toast('開いている楽譜は削除できません');
            if (!confirm('この楽譜を削除しますか？（元に戻せません）')) return;
            await storage.remove(del.dataset.del);
            el.remove();
            return;
          }
          await this.app.save();
          const doc = await storage.get(el.dataset.id);
          if (doc) { this.app.openDoc(doc); this.app.view.resetZoom(); this.app.relayout(); this.app.view.scroller.scrollTo({ top: 0 }); }
          this.close();
        }));
      },
    });
  }

  async duplicate() {
    const a = this.app;
    await a.save();
    const sc = JSON.parse(JSON.stringify(a.score));
    sc.meta.title = (sc.meta.title || '無題') + ' のコピー';
    a.newDoc(sc);
    a.relayout();
    a.toast('複製しました');
  }

  // ── 新規作成ウィザード（Finale のセットアップウィザードに相当） ──
  newScore(first = false) {
    let insts = ['piano'];
    let tmpl = 'piano';
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
          this.app.view.resetZoom();
          this.app.state.mode = 'input';
          this.app.relayout();
          this.app.view.scroller.scrollTo({ top: 0 });
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
        <label class="field"><span>編曲者</span><input id="siArr" value="${esc(m.arranger)}"></label>`,
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
        const v = (id) => bd.querySelector(id).value.trim();
        this.app.edit('スコア情報', () => { Object.assign(this.app.score.meta, { title: v('#siTitle'), subtitle: v('#siSub'), composer: v('#siComp'), lyricist: v('#siLyr'), arranger: v('#siArr') }); });
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
      { label: (a.score.measures[m].sysBreak ? '✓ ' : '') + 'この小節の後で改段', run: () => a.edit('改段', () => { a.score.measures[m].sysBreak = !a.score.measures[m].sysBreak; }) },
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
        <p style="color:var(--muted);font-size:13px;margin:4px 0 0">※ 今の版では、小節からはみ出す音符は切り捨て、足りない分は休符で埋めます（Finale の「小節の再構成」は今後対応）。</p>`,
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
        a.edit('拍子の変更', () => E.setTime(a.score, m, time));
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
      body: `<div class="row"><label class="field"><span>4分音符 = </span><input id="tpB" type="number" inputmode="numeric" value="${cur}" min="20" max="400"></label>
        <label class="field"><span>表示する文字（任意）</span><input id="tpT" value="${esc(ms.tempo?.text || '')}" placeholder="Allegro など"></label></div>
        <div class="chips">${[['Largo', 50], ['Adagio', 66], ['Andante', 80], ['Moderato', 100], ['Allegretto', 112], ['Allegro', 132], ['Presto', 168]].map(([n, b]) => `<button class="chip" data-n="${n}" data-b="${b}">${n} ${b}</button>`).join('')}</div>`,
      onOpen: (bd) => { bd.querySelector('.chips').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; bd.querySelector('#tpB').value = c.dataset.b; bd.querySelector('#tpT').value = c.dataset.n; }; },
      buttons: [
        ...(m > 0 && ms.tempo ? [{ label: 'この変更を削除', cls: 'danger', onClick: () => a.edit('テンポ削除', () => { delete a.score.measures[m].tempo; }) }] : []),
        { label: 'キャンセル' },
        { label: 'OK', cls: 'primary', onClick: (bd) => {
          const bpm = Math.max(20, Math.min(400, +bd.querySelector('#tpB').value || 100));
          const text = bd.querySelector('#tpT').value.trim();
          a.edit('テンポ', () => { a.score.measures[m].tempo = { bpm, ...(text ? { text } : {}) }; });
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

  // ── スコアメニュー（楽器の追加・削除など） ──
  scoreMenu(anchor) {
    this.menu(anchor, [
      { label: 'スコア情報（タイトル・作曲者）…', run: () => this.scoreInfo() },
      { label: '楽器の追加・削除・並べ替え…', run: () => this.instruments() },
      { label: '譜表サイズ・ページ設定…', run: () => this.pageSetup() },
    ]);
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
        <label class="field"><span>用紙</span><select id="psP"><option value="210x297"${s.page.w === 210 ? ' selected' : ''}>A4 縦</option><option value="297x210"${s.page.w === 297 ? ' selected' : ''}>A4 横</option><option value="257x364"${s.page.w === 257 ? ' selected' : ''}>B4 縦</option><option value="216x279"${s.page.w === 216 ? ' selected' : ''}>レター</option></select></label>`,
      buttons: [{ label: 'キャンセル' }, { label: 'OK', cls: 'primary', onClick: (bd) => {
        const h = Math.max(4, Math.min(12, +bd.querySelector('#psH').value || 7));
        const [w, hh] = bd.querySelector('#psP').value.split('x').map(Number);
        a.edit('ページ設定', () => { s.staffMm = h; s.page = { w, h: hh }; });
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
        </table>
        <p style="font-size:13px;color:var(--muted)">※ iPad では Ctrl の代わりに ⌘（Command）でも動きます。新規作成が Alt+N なのは、ブラウザでは Ctrl+N が「新しいウィンドウ」に取られてしまうためです。</p>
        <h3>Finale からの引っ越し</h3>
        <p>Finale で「ファイル → 書き出し → MusicXML」で保存し、KANADE の「ファイル → MusicXML を読み込む」で開きます（.musicxml / .xml / .mxl に対応）。</p>
        <h3>保存</h3>
        <p>楽譜は自動でこの端末に保存されます（ファイル → 開く の「最近の楽譜」）。<br>
        PC では「ファイル → 保存」（Ctrl+S）で <b>.kanade ファイル</b>として好きな場所に保存できます。.kanade は KANADE の情報を全部そのまま残す形式で、iPad ⇄ PC の受け渡しにも使えます。ほかのソフトに渡すときは MusicXML に書き出してください。</p>
      </div>`,
      buttons: [{ label: '閉じる', cls: 'primary' }],
    });
  }
}
export { TYPE_TICKS };
