// ホーム画面（Phase 4）：Word と同じように、起動するとまずここ。新規（テンプレート）・最近の楽譜・開く。
// 楽譜を開いているときに「ファイル」タブを押すと同じ画面が開き（Word の「バックステージ」）、
// 情報・保存・名前を付けて保存・書き出し・印刷・閉じる も選べる。
import { TEMPLATES, createScore, INST } from '../core/score.js';
import { layoutScore } from '../engrave/layout.js';
import { storage, canPickFiles } from '../io/storage.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sv = (d) => `<svg viewBox="0 0 24 24" class="lsvg"><path d="${d}"/></svg>`;
const NAV_I = {
  back: sv('M15 5l-7 7 7 7'), home: sv('M3 11l9-7 9 7v9h-6v-6H9v6H3z'), new: sv('M6 3h9l4 4v14H6zM15 3v4h4M12 11v6M9 14h6'),
  open: sv('M3 7h6l2 2h10v10H3zM3 7V5h6'), info: sv('M12 3a9 9 0 1 0 .1 0M12 11v6M12 7.5v.5'), save: sv('M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7'),
  saveAs: sv('M5 3h11l3 3v8M8 3v6h8V3M5 3v18h7M16 16l2 2 4-4'), exp: sv('M12 3v12M7 8l5-5 5 5M4 15v6h16v-6'), print: sv('M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z'),
  close: sv('M6 6l12 12M18 6 6 18'), opt: sv('M12 8a4 4 0 1 0 .1 0M4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4'),
  help: sv('M12 3a9 9 0 1 0 .1 0M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17v.5'), pin: sv('M9 4h6l-1 6 3 3H7l3-3zM12 13v8'), more: sv('M5 12h.01M12 12h.01M19 12h.01'),
  search: sv('M11 4a7 7 0 1 0 .1 0M21 21l-5-5'), grid: sv('M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'), list: sv('M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'),
};
const greet = () => { const h = new Date().getHours(); return h < 5 ? 'こんばんは' : h < 11 ? 'おはようございます' : h < 18 ? 'こんにちは' : 'こんばんは'; };
const ago = (t) => {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'たった今';
  if (d < 3600) return Math.floor(d / 60) + '分前';
  if (d < 86400) return Math.floor(d / 3600) + '時間前';
  if (d < 86400 * 7) return Math.floor(d / 86400) + '日前';
  return new Date(t).toLocaleDateString('ja-JP');
};

export class Home {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('home');
    this.page = 'home';
    this.thumbs = new Map(); // `${id}:${updated}` → SVG（ページ1の上の部分）
    this.tmplThumbs = new Map();
    this.q = '';
    try { this.listMode = localStorage.getItem('kanade.homeList') || 'grid'; } catch (e) { this.listMode = 'grid'; }
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => {
      if (e.target.id === 'hmSearch') { this.q = e.target.value; this.renderDocs(); }
      // 情報：タイトルなどはその場で楽譜に反映（元に戻すでも戻せる）
      const k = e.target.dataset?.meta;
      if (k) {
        const a = this.app, v = e.target.value;
        clearTimeout(this.metaT);
        this.metaT = setTimeout(() => { a.edit('スコア情報', () => { a.score.meta[k] = v.trim(); }); a.updateTitle(); }, 350);
      }
    });
    this.el.addEventListener('change', (e) => {
      const o = e.target.dataset?.opt;
      if (!o) return;
      const a = this.app, on = e.target.checked;
      if (o === 'startLast') { try { localStorage.setItem('kanade.startLast', on ? '1' : '0'); } catch (err) { /* 使えない環境 */ } }
      if (o === 'colorVoices') { a.state.colorVoices = on; document.body.classList.toggle('color-voices', on); try { localStorage.setItem('kanade.colorVoices', on ? '1' : '0'); } catch (err) { /* 使えない環境 */ } }
      if (o === 'samples') a.synth.useSamples = on;
    });
    this.el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' && this.canBack) this.hide(); });
    this.el.addEventListener('contextmenu', (e) => { const d = e.target.closest('[data-doc]'); if (d) { e.preventDefault(); this.docMenu(d.dataset.doc, { x: e.clientX, y: e.clientY }); } });
  }
  get visible() { return !this.el.hidden; }
  // mode = 'home'（起動時のホーム）| 'backstage'（楽譜を開いたままのファイル画面）| 'open' | 'new' | 'info' | 'export' | 'options'
  async show(mode = 'home') {
    const a = this.app;
    if (a.player.playing) a.player.stop();
    if (a.live?.active) a.live.stop();
    if (a.tools?.rec.active) a.tools.stopRec();
    a.dialogs.close();
    // launch = 起動したとき（Word と同じく、まだ何も開いていない扱い。最近の楽譜から選ぶ）
    this.canBack = mode !== 'launch' && !!a.score && !a.transient;
    this.page = mode === 'backstage' ? (this.canBack ? 'info' : 'home') : mode === 'launch' ? 'home' : mode;
    this.el.hidden = false;
    document.body.classList.add('home-open');
    await a.save();
    this.docs = await storage.list();
    this.render();
  }
  hide() {
    if (!this.canBack) return;
    this.el.hidden = true;
    document.body.classList.remove('home-open');
    this.app.view.onResize();
    this.app.relayout();
  }

  render() {
    const a = this.app, cb = this.canBack;
    const nav = (id, ja, icon, extra = '') => `<button class="hn${this.page === id ? ' on' : ''}" data-nav="${id}" ${extra}>${NAV_I[icon]}<span>${ja}</span></button>`;
    this.el.innerHTML = `<div class="hm">
      <aside class="hm-nav">
        ${cb ? `<button class="hn back" data-act="back" title="楽譜に戻る（Esc）">${NAV_I.back}<span>楽譜に戻る</span></button>` : `<div class="hm-logo"><img src="icons/icon.svg" alt=""><b>KANADE</b><small>奏</small></div>`}
        ${nav('home', 'ホーム', 'home')}${nav('new', '新規', 'new')}${nav('open', '開く', 'open')}
        ${cb ? `<hr>${nav('info', '情報', 'info')}<button class="hn" data-act="save">${NAV_I.save}<span>保存</span></button><button class="hn" data-act="saveAs">${NAV_I.saveAs}<span>${canPickFiles ? '名前を付けて保存' : 'ファイルに書き出す'}</span></button>${nav('export', '書き出し', 'exp')}<button class="hn" data-act="print">${NAV_I.print}<span>印刷 / PDF</span></button><button class="hn" data-act="close">${NAV_I.close}<span>閉じる</span></button>` : ''}
        <div class="hm-sp"></div>
        ${nav('options', 'オプション', 'opt')}<button class="hn" data-act="help">${NAV_I.help}<span>使い方</span></button>
      </aside>
      <main class="hm-main" id="hmMain">${this.pageHtml()}</main>
    </div>`;
    this.fillThumbs();
    void a;
  }

  pageHtml() {
    switch (this.page) {
      case 'new': return `<h1>新規</h1><p class="hm-lead">テンプレートを選ぶと、楽器・拍子・調を決める画面が開きます。</p>${this.tmplHtml(TEMPLATES.length)}`;
      case 'open': return `<h1>開く</h1>
        <div class="hm-open"><button class="hbtn primary" data-act="pick">${NAV_I.open}<span>${canPickFiles ? 'PC のファイルを開く…' : '「ファイル」から開く…'}</span></button>
        <p>.kanade・MusicXML（.musicxml / .xml / .mxl・Finale から）・MIDI（.mid）。${canPickFiles ? 'ウィンドウにファイルをドラッグ＆ドロップしても開けます。' : ''}</p></div>
        ${this.docsHtml('この端末の楽譜（自動保存）')}`;
      case 'info': return this.infoHtml();
      case 'export': return this.exportHtml();
      case 'options': return this.optionsHtml();
      default: return `<h1>${greet()}</h1>
        <div class="hm-row-h"><h2>新規</h2><button class="lnk" data-nav="new">その他のテンプレート →</button></div>
        ${this.tmplHtml(6)}
        ${this.docsHtml('最近使った楽譜')}`;
    }
  }
  tmplHtml(n) {
    const list = [{ id: 'blank', ja: '白紙（ピアノ）', insts: ['piano'] }, ...TEMPLATES.filter(t => t.id !== 'piano')].slice(0, n + 1);
    return `<div class="hm-tmpl">${list.map(t => `<button class="tcard" data-tmpl="${t.id}"><div class="tc-th" data-tth="${t.id}"></div><span>${esc(t.ja)}</span><small>${esc(t.insts.map(i => INST[i]?.ja).join('・'))}</small></button>`).join('')}
      <button class="tcard wizard" data-act="wizard"><div class="tc-th plus">＋</div><span>楽器を選んで作る…</span><small>Alt+N</small></button></div>`;
  }
  docsHtml(title) {
    return `<div class="hm-row-h"><h2>${title}</h2>
      <div class="hm-tools"><label class="hm-search">${NAV_I.search}<input id="hmSearch" type="search" placeholder="楽譜を検索" value="${esc(this.q)}"></label>
      <button class="tb icon${this.listMode === 'grid' ? ' on' : ''}" data-act="grid" title="カードで表示">${NAV_I.grid}</button><button class="tb icon${this.listMode === 'list' ? ' on' : ''}" data-act="list" title="一覧で表示">${NAV_I.list}</button></div></div>
      <div id="hmDocs">${this.docsInner()}</div>`;
  }
  docsInner() {
    const q = this.q.trim().toLowerCase();
    let docs = (this.docs || []).filter(d => !q || (d.title || '').toLowerCase().includes(q) || (d.fileName || '').toLowerCase().includes(q));
    docs = [...docs.filter(d => d.pinned), ...docs.filter(d => !d.pinned)];
    if (!docs.length) return `<p class="hm-empty">${q ? '見つかりません' : 'まだ楽譜がありません。上のテンプレートから作ってみましょう。'}</p>`;
    const cur = this.canBack ? this.app.docId : null;
    if (this.listMode === 'list') {
      return `<div class="hm-list"><div class="hl-h"><span>名前</span><span>更新</span><span>パート</span><span></span></div>${docs.map(d => `<div class="hl-r${d.id === cur ? ' cur' : ''}" data-doc="${d.id}"><span class="hl-n">${d.pinned ? `<i class="pin">${NAV_I.pin}</i>` : ''}<b>${esc(d.title || '無題')}</b>${d.fileName ? `<small>${esc(d.fileName)}</small>` : ''}</span><span>${ago(d.updated)}</span><span>${esc(d.summary || '')}</span><button class="tb icon" data-more="${d.id}" title="その他">${NAV_I.more}</button></div>`).join('')}</div>`;
    }
    return `<div class="hm-grid">${docs.map(d => `<div class="dcard${d.id === cur ? ' cur' : ''}" data-doc="${d.id}"><div class="dc-th" data-th="${d.id}" data-up="${d.updated}"></div><div class="dc-b"><b>${d.pinned ? `<i class="pin">${NAV_I.pin}</i>` : ''}${esc(d.title || '無題')}</b><small>${ago(d.updated)}${d.summary ? ' · ' + esc(d.summary) : ''}</small></div><button class="tb icon dc-more" data-more="${d.id}" title="その他">${NAV_I.more}</button></div>`).join('')}</div>`;
  }
  renderDocs() { const el = this.el.querySelector('#hmDocs'); if (el) { el.innerHTML = this.docsInner(); this.fillThumbs(); } }

  infoHtml() {
    const a = this.app, sc = a.score, m = sc.meta;
    let notes = 0;
    for (const p of sc.parts) for (const st of p.staves) for (const sm of st.measures) for (const v of sm.voices) for (const ev of v || []) if (!ev.rest) notes++;
    return `<h1>情報</h1><div class="hm-info">
      <div class="hi-form">
        <label class="field"><span>タイトル</span><input data-meta="title" value="${esc(m.title)}"></label>
        <label class="field"><span>サブタイトル</span><input data-meta="subtitle" value="${esc(m.subtitle)}"></label>
        <div class="row"><label class="field"><span>作曲者</span><input data-meta="composer" value="${esc(m.composer)}"></label><label class="field"><span>作詞者</span><input data-meta="lyricist" value="${esc(m.lyricist)}"></label></div>
        <div class="row"><label class="field"><span>編曲者</span><input data-meta="arranger" value="${esc(m.arranger)}"></label><label class="field"><span>著作権（1ページ目の下）</span><input data-meta="copyright" value="${esc(m.copyright)}"></label></div>
        <p class="hm-lead">入力するとすぐ楽譜に反映されます。</p>
      </div>
      <div class="hi-side">
        <div class="hi-th" data-th="${a.docId}" data-up="now"></div>
        <dl><dt>パート</dt><dd>${sc.parts.length}（${esc(sc.parts.map(p => p.name).join('、'))}）</dd><dt>小節</dt><dd>${sc.measures.length}</dd><dt>音符</dt><dd>${notes}</dd><dt>ページ</dt><dd>${a.L?.pages.length || 1}</dd>
        <dt>保存先</dt><dd>${a.fileName ? esc(a.fileName) + (a.fileDirty ? '（未保存の変更あり）' : '') : 'この端末（自動保存）'}</dd></dl>
      </div></div>`;
  }
  exportHtml() {
    const item = (act, ja, desc) => `<button class="ex" data-act="${act}"><b>${ja}</b><small>${desc}</small></button>`;
    return `<h1>書き出し</h1><div class="hm-ex">
      ${item('exKanade', '.kanade ファイル', 'KANADE の情報を全部そのまま。iPad ⇄ PC の受け渡しにも')}
      ${item('exXml', 'MusicXML', 'Finale・MuseScore・Dorico などほかの楽譜ソフトへ')}
      ${item('exMidi', 'MIDI ファイル（.mid）', 'DAW（Cubase・Logic・GarageBand など）へ。反復・強弱・表情込み')}
      ${item('exWav', 'オーディオ（.wav）', '演奏をまるごと音声ファイルに')}
      ${item('exPdf', 'PDF / 印刷', '印刷の画面で「PDF に保存」を選びます')}
      ${item('exPng', '画像（PNG）', 'ページごとの画像。SNS やメッセージに')}
      ${item('exSvg', 'SVG', '拡大してもきれいな図。資料づくりに')}
    </div>`;
  }
  optionsHtml() {
    const a = this.app;
    const ck = (id, on, label, sub = '') => `<label class="ck opt"><input type="checkbox" data-opt="${id}"${on ? ' checked' : ''}><span>${label}${sub ? `<small>${sub}</small>` : ''}</span></label>`;
    let startLast = false;
    try { startLast = localStorage.getItem('kanade.startLast') === '1'; } catch (e) { /* 使えない環境 */ }
    return `<h1>オプション</h1><div class="hm-opt">
      ${ck('startLast', startLast, '起動したら前回の楽譜をすぐ開く', 'オフのときは、このホーム画面から始まります（Word と同じ）')}
      ${ck('colorVoices', a.state.colorVoices, '声部を色分けして表示')}
      ${ck('samples', a.synth.useSamples, '高音質音源を使う（ネット接続時）')}
      <div class="field"><span>テーマ</span><div class="chips">${[['auto', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']].map(([v, l]) => `<button class="chip${(a.theme || 'auto') === v ? ' on' : ''}" data-theme="${v}">${l}</button>`).join('')}</div></div>
      <div class="field"><span>ページの並べ方</span><div class="chips">${[['vertical', '縦に並べる'], ['horizontal', '横に並べる'], ['spread', '見開き'], ['scroll', '1段スクロール']].map(([v, l]) => `<button class="chip${a.viewOpts.arrange === v ? ' on' : ''}" data-arr="${v}">${l}</button>`).join('')}</div></div>
      ${a.isInstalled ? '' : '<button class="hbtn" data-act="install">アプリとしてインストール…</button>'}
      <p class="hm-lead">楽譜はこの端末の中に自動で保存されます（ネットには送りません）。</p>
      <p class="hm-lead">ピアノの音：Salamander Grand Piano（作者 Alexander Holm、CC BY 3.0）を短くして使っています。</p>
    </div>`;
  }

  // ───────── サムネイル（ページ1の上のほう） ─────────
  async fillThumbs() {
    const els = [...this.el.querySelectorAll('[data-th], [data-tth]')];
    for (const el of els) {
      await new Promise(r => setTimeout(r, 0));
      if (!el.isConnected) continue;
      if (el.dataset.tth) { el.innerHTML = this.tmplThumb(el.dataset.tth); continue; }
      const id = el.dataset.th, key = id + ':' + el.dataset.up;
      let svg = this.thumbs.get(key);
      if (!svg) {
        let score;
        if (id === this.app.docId && this.app.score) score = this.app.score;
        else { const d = await storage.get(id).catch(() => null); score = d?.score; }
        if (!score) continue;
        svg = this.thumbSvg(score);
        if (el.dataset.up !== 'now') this.thumbs.set(key, svg);
      }
      el.innerHTML = svg;
    }
  }
  thumbSvg(score) {
    try {
      const L = layoutScore(score, { measureText: this.app.measureText });
      const pg = L.pages[0];
      const h = pg.w * 0.62;
      return `<svg class="page thumb" viewBox="0 0 ${pg.w} ${h}" preserveAspectRatio="xMidYMin slice">${pg.svg}</svg>`;
    } catch (e) { console.warn(e); return ''; }
  }
  // テンプレート：最初の段だけを大きく見せる
  tmplThumb(id) {
    if (this.tmplThumbs.has(id)) return this.tmplThumbs.get(id);
    const t = id === 'blank' ? { insts: ['piano'] } : TEMPLATES.find(x => x.id === id);
    const sc = createScore({ insts: t.insts, title: '', measures: 12 });
    let svg = '';
    try {
      const L = layoutScore(sc, { measureText: this.app.measureText });
      const sy = L.systems[0], pg = L.pages[0];
      const x0 = 2, y0 = sy.top - 5, w = pg.w - 4, h = Math.max(w * 150 / 210, sy.bottom - sy.top + 10);
      svg = `<svg class="page thumb" viewBox="${x0} ${y0 - (h - (sy.bottom - sy.top + 10)) / 2} ${w} ${h}" preserveAspectRatio="xMidYMid meet">${pg.svg}</svg>`;
    } catch (e) { console.warn(e); }
    this.tmplThumbs.set(id, svg);
    return svg;
  }

  // ───────── 操作 ─────────
  async onClick(e) {
    const a = this.app;
    const nv = e.target.closest('[data-nav]');
    if (nv) { this.page = nv.dataset.nav; return this.render(); }
    const more = e.target.closest('[data-more]');
    if (more) { e.stopPropagation(); return this.docMenu(more.dataset.more, more); }
    const tm = e.target.closest('[data-tmpl]');
    if (tm) return this.newFrom(tm.dataset.tmpl);
    const dc = e.target.closest('[data-doc]');
    if (dc) return this.openDoc(dc.dataset.doc);
    const th = e.target.closest('[data-theme]');
    if (th) { a.setTheme(th.dataset.theme); return this.render(); }
    const ar = e.target.closest('[data-arr]');
    if (ar) { a.setArrange(ar.dataset.arr); return this.render(); }
    const act = e.target.closest('[data-act]')?.dataset.act;
    switch (act) {
      case 'back': return this.hide();
      case 'wizard': return a.dialogs.newScore();
      case 'pick': return a.openFileDialog();
      case 'save': await a.saveToFile(); return this.render();
      case 'saveAs': await a.saveToFile(true); return this.render();
      case 'print': this.hide(); return a.print();
      case 'close': this.canBack = false; this.page = 'home'; this.docs = await storage.list(); return this.render();
      case 'help': return a.dialogs.help();
      case 'install': return a.install();
      case 'grid': case 'list': this.listMode = act; try { localStorage.setItem('kanade.homeList', act); } catch (err) { /* 使えない環境 */ } return this.render();
      case 'exKanade': return a.saveToFile(true);
      case 'exXml': return a.exportXML();
      case 'exMidi': return a.tools.exportMidi();
      case 'exWav': return a.tools.exportWav();
      case 'exPdf': this.hide(); return a.print();
      case 'exPng': return a.exportImage('png');
      case 'exSvg': return a.exportImage('svg');
    }
  }
  bindInfoInputs() { /* 下の change で処理 */ }
  async newFrom(tid) {
    const t = tid === 'blank' ? { id: 'piano', insts: ['piano'] } : TEMPLATES.find(x => x.id === tid);
    this.app.dialogs.newScore(false, t.id);
  }
  async openDoc(id) {
    const a = this.app;
    if (this.canBack && id === a.docId) return this.hide();
    await a.save();
    const doc = await storage.get(id);
    if (!doc) return a.toast('開けませんでした');
    a.openDoc(doc);
    this.canBack = true;
    this.hide();
    a.view.resetZoom(); a.relayout(); a.view.scroller.scrollTo({ top: 0, left: 0 });
  }
  docMenu(id, anchor) {
    const a = this.app;
    const d = (this.docs || []).find(x => x.id === id);
    if (!d) return;
    a.dialogs.menu(anchor, [
      { head: esc(d.title || '無題') },
      { label: '開く', run: () => this.openDoc(id) },
      { label: '名前の変更…', run: () => a.dialogs.ask('名前の変更', '楽譜のタイトル', d.title || '', async (v) => { if (!v) return; await this.patchDoc(id, (doc) => { doc.title = v; doc.score.meta.title = v; }); if (id === a.docId) { a.score.meta.title = v; a.updateTitle(); } }) },
      { label: '複製を作る', run: async () => { const doc = await storage.get(id); if (!doc) return; const sc = JSON.parse(JSON.stringify(doc.score)); sc.meta.title = (sc.meta.title || '無題') + ' のコピー'; await storage.put({ id: storage.newId(), title: sc.meta.title, updated: Date.now(), score: sc }); this.docs = await storage.list(); this.render(); a.toast('複製しました'); } },
      { label: d.pinned ? 'ピン留めを外す' : 'ピン留め（いちばん上に）', run: () => this.patchDoc(id, (doc) => { doc.pinned = !doc.pinned; }, true) },
      '-',
      { label: '削除…', run: async () => {
        if (this.canBack && id === a.docId) return a.toast('開いている楽譜は削除できません（「閉じる」してから）');
        if (!confirm(`「${d.title || '無題'}」を削除しますか？（元に戻せません）`)) return;
        await storage.remove(id); this.docs = await storage.list(); this.render();
      } },
    ]);
  }
  async patchDoc(id, fn, keepTime = false) {
    const doc = await storage.get(id);
    if (!doc) return;
    fn(doc);
    if (!keepTime) doc.updated = Date.now();
    await storage.put(doc);
    this.docs = await storage.list();
    this.render();
  }
}
