// 楽譜ビュー：ページの表示・ズーム・タップ位置の判定・カーソルなどの重ね表示
import { SMUFL } from '../smufl.js';
import { tickToX } from '../engrave/layout.js';
import { clefInfo } from '../core/score.js';
import { fromDiatonic, keyAlter } from '../core/music.js';

const G = SMUFL.glyphs;
const MM_PX = 96 / 25.4;
const PAGE_GAP = 28; // ページどうしの間隔（css の #pages の gap と同じ）

export class ScoreView {
  constructor(app, scroller, pagesEl) {
    this.app = app;
    this.scroller = scroller;
    this.pagesEl = pagesEl;
    this.zoom = 1;
    this.fit = true; // 「画面に合わせる」状態か（ズームを手で変えたら false）
    this.L = null;
    this.wraps = [];
    this.ov = {};
    this.setupGestures();
  }

  get spPx() { return (this.app.score.settings.staffMm / 4) * MM_PX * this.zoom; }

  // 画面に合わせた倍率。基本はページの幅に合わせるが、PC の横長の大きな画面では
  // 1ページだけだと大きすぎるので、100% 以上を保てる範囲でページを横に並べる（見開き表示）
  fitZoom() {
    const s = this.app.score.settings;
    const pagePx = s.page.w * MM_PX;
    const avail = this.scroller.clientWidth - 72; // 左右の余白＋縦スクロールバーぶん
    let z = avail / pagePx;
    for (let n = 2; n <= 4; n++) {
      const zn = (avail - PAGE_GAP * (n - 1)) / (n * pagePx);
      if (zn < 1) break;
      z = zn;
    }
    return Math.max(0.4, Math.min(3, z));
  }
  // 「画面に合わせる」に戻す
  resetZoom() { this.fit = true; this.zoom = this.fitZoom(); }
  // ウィンドウの大きさが変わったとき（PC ではよくある）。合わせた状態なら倍率も合わせ直す
  onResize() {
    if (!this.L) return;
    if (!this.fit) return this.rescale();
    const sc = this.scroller;
    const frac = sc.scrollHeight > 0 ? sc.scrollTop / sc.scrollHeight : 0;
    this.zoom = this.fitZoom();
    this.rescale();
    sc.scrollTop = frac * sc.scrollHeight;
  }

  render(L) {
    this.L = L;
    const spPx = this.spPx;
    this.pagesEl.style.setProperty('--pw', L.pageW * spPx + 'px');
    while (this.wraps.length > L.pages.length) this.wraps.pop().remove();
    L.pages.forEach((pg, i) => {
      let w = this.wraps[i];
      if (!w) {
        w = document.createElement('div');
        w.className = 'pagewrap';
        w.dataset.page = i;
        this.pagesEl.appendChild(w);
        this.wraps[i] = w;
      }
      w.style.width = pg.w * spPx + 'px';
      w.style.height = pg.h * spPx + 'px';
      w.innerHTML = `<svg class="page" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pg.w} ${pg.h}" data-page="${i}">${pg.svg}</svg>`;
    });
    this.ov = {};
    this.hoverId = null;
  }

  rescale() {
    if (!this.L) return;
    const spPx = this.spPx;
    this.pagesEl.style.setProperty('--pw', this.L.pageW * spPx + 'px');
    this.L.pages.forEach((pg, i) => {
      const w = this.wraps[i];
      w.style.width = pg.w * spPx + 'px';
      w.style.height = pg.h * spPx + 'px';
    });
  }

  // 画面座標 → ページと sp 座標
  locate(clientX, clientY) {
    for (let i = 0; i < this.wraps.length; i++) {
      const r = this.wraps[i].getBoundingClientRect();
      if (clientX >= r.left - 20 && clientX <= r.right + 20 && clientY >= r.top - 20 && clientY <= r.bottom + 20) {
        const s = this.L.pages[i].w / r.width;
        return { page: i, x: (clientX - r.left) * s, y: (clientY - r.top) * s };
      }
    }
    return null;
  }

  // sp 座標 → 段・譜表・小節・音の高さ
  hit(pt) {
    const L = this.L;
    if (!L || !pt) return null;
    let best = null;
    L.systems.forEach((sy, k) => {
      if (!sy || sy.page !== pt.page) return;
      sy.staffYs.forEach((sy0, r) => {
        const d = Math.abs(pt.y - (sy0 + 2));
        if (!best || d < best.d) best = { d, k, r, staffY: sy0 };
      });
    });
    if (!best || best.d > 14) return null;
    const sy = L.systems[best.k];
    let m = sy.ms[0];
    for (const mi of sy.ms) if (pt.x >= L.measures[mi].x0) m = mi;
    if (pt.x > L.measures[sy.ms[sy.ms.length - 1]].x1) m = sy.ms[sy.ms.length - 1];
    const row = L.rows[best.r];
    const clef = clefInfo(L.clefs[m][best.r]);
    const pos = Math.round((best.staffY + 2 - pt.y) * 2);
    const dn = clef.mid + pos;
    const fifths = L.attrs[m].fifths;
    const p0 = fromDiatonic(dn);
    const pitch = { ...p0, alter: keyAlter(fifths, p0.step) };
    return { ...best, m, p: row.p, s: row.s, pos, pitch, x: pt.x, y: pt.y, page: pt.page };
  }

  // 近くの音符/休符を探す
  nearestEvent(h, maxDist = 2.6) {
    const L = this.L;
    let best = null;
    for (const id in L.evGeom) {
      const g = L.evGeom[id];
      if (g.k !== h.k || g.r !== h.r) continue;
      const cx = Math.max(g.x, Math.min(h.x, g.xr));
      const top = g.oy + g.top, bot = g.oy + g.bot;
      const cy = Math.max(top, Math.min(h.y, bot));
      const d = Math.hypot(h.x - cx, (h.y - cy) * 0.7);
      if (d <= maxDist && (!best || d < best.d || (d === best.d && g.v === this.app.state.voice))) best = { d, id, g };
    }
    if (best && !best.g.rest && best.g.notes.length > 1) {
      // 和音なら一番近い音
      let ni = 0, nd = Infinity;
      best.g.notes.forEach((n, i) => { const d = Math.abs(best.g.oy + n.y - h.y); if (d < nd) { nd = d; ni = i; } });
      best.noteIndex = best.g.notes[ni].k;
    } else if (best && !best.g.rest) best.noteIndex = best.g.notes[0].k;
    return best;
  }

  // 小節内のどのタイミングに入れるか（オンセット・音価の格子から一番近いもの）
  snapTick(h, stepTicks, voiceStarts) {
    const mg = this.L.measures[h.m];
    const cands = new Set([0]);
    mg.ons.forEach(o => cands.add(o.t));
    voiceStarts.forEach(t => cands.add(t));
    if (stepTicks) for (let t = 0; t < mg.len; t += stepTicks) cands.add(t);
    let best = 0, bd = Infinity;
    for (const t of cands) {
      if (t >= mg.len) continue;
      const d = Math.abs(tickToX(mg, t) - h.x);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // ── 重ね表示 ──
  overlay(name, page, cls) {
    let el = this.ov[name];
    const wrap = this.wraps[page];
    if (!wrap) return null;
    if (!el || el.parentNode !== wrap) {
      if (el) el.remove();
      el = document.createElement('div');
      el.className = 'ov ' + cls;
      wrap.appendChild(el);
      this.ov[name] = el;
    }
    el.hidden = false;
    return el;
  }
  hideOverlay(name) { if (this.ov[name]) this.ov[name].hidden = true; }

  showCaret(loc, durGlyph) {
    const L = this.L;
    if (!L || !loc || !L.measures[loc.m]) return this.hideOverlay('caret');
    const mg = L.measures[loc.m];
    const sy = L.systems[mg.sys];
    const r = L.rows.findIndex(x => x.p === loc.p && x.s === loc.s);
    if (r < 0) return this.hideOverlay('caret');
    const x = tickToX(mg, loc.t);
    const sp = this.spPx;
    const el = this.overlay('caret', sy.page, 'caret');
    el.style.left = (x - 0.3) * sp + 'px';
    el.style.top = (sy.staffYs[r] - 1.2) * sp + 'px';
    el.style.height = 6.4 * sp + 'px';
    el.innerHTML = durGlyph ? `<span class="lbl">${durGlyph}</span>` : '';
    return { page: sy.page, x, y: sy.staffYs[r] };
  }

  showGhost(h, headGlyph, label) {
    if (!h) return this.hideOverlay('ghost');
    const L = this.L;
    const mg = L.measures[h.m];
    const x = tickToX(mg, h.t);
    const sp = this.spPx;
    const el = this.overlay('ghost', h.page, 'ghost');
    const y = h.staffY + 2 - h.pos / 2;
    el.style.left = x * sp + 'px';
    el.style.top = y * sp + 'px';
    el.style.fontSize = 4 * sp + 'px';
    // 加線もゴーストで見せる
    let ledg = '';
    const lines = [];
    for (let Lp = 6; Lp <= h.pos; Lp += 2) lines.push(Lp);
    for (let Lp = -6; Lp >= h.pos; Lp -= 2) lines.push(Lp);
    for (const Lp of lines) ledg += `<div style="position:absolute;left:${-0.4 * sp}px;top:${((h.pos - Lp) / 2) * sp - 0.08 * sp}px;width:${2 * sp}px;height:${Math.max(1, 0.16 * sp)}px;background:currentColor"></div>`;
    el.innerHTML = `${ledg}<span class="gl">${G[headGlyph].c}</span><span class="pn" style="top:${-4.2 * sp}px;left:${-0.2 * sp}px">${label}</span>`;
  }

  showRange(range) {
    const L = this.L;
    if (!range || !L) { for (const k in this.ov) if (k.startsWith('rng')) this.ov[k].hidden = true; return; }
    const sp = this.spPx;
    let n = 0;
    // 段ごとに長方形を描く
    const bySys = new Map();
    for (let m = range.m1; m <= range.m2; m++) {
      const mg = L.measures[m];
      if (!mg) continue;
      const b = bySys.get(mg.sys) || { x0: Infinity, x1: -Infinity };
      b.x0 = Math.min(b.x0, mg.x0); b.x1 = Math.max(b.x1, mg.x1);
      bySys.set(mg.sys, b);
    }
    for (const [k, b] of bySys) {
      const sy = L.systems[k];
      const y0 = sy.staffYs[range.r1] - 1, y1 = sy.staffYs[range.r2] + 5;
      const el = this.overlay('rng' + n++, sy.page, 'rangesel');
      el.style.left = b.x0 * sp + 'px'; el.style.top = y0 * sp + 'px';
      el.style.width = (b.x1 - b.x0) * sp + 'px'; el.style.height = (y1 - y0) * sp + 'px';
    }
    for (const k in this.ov) if (k.startsWith('rng') && +k.slice(3) >= n) this.ov[k].hidden = true;
  }

  showPlayLine(m, t) {
    const L = this.L;
    if (!L || m == null || !L.measures[m]) return this.hideOverlay('play');
    const mg = L.measures[m];
    const sy = L.systems[mg.sys];
    const x = tickToX(mg, t);
    const sp = this.spPx;
    const el = this.overlay('play', sy.page, 'playline');
    el.style.left = x * sp + 'px';
    el.style.top = (sy.staffYs[0] - 2) * sp + 'px';
    el.style.height = (sy.staffYs[sy.staffYs.length - 1] - sy.staffYs[0] + 8) * sp + 'px';
    return { page: sy.page, x, y: sy.staffYs[0] };
  }

  // マウスを乗せた音符をうっすら色付け（PC 用。クリックで選べることが分かるように）
  hover(id) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.highlight(id ? [id] : [], 'hov');
  }

  highlight(ids, cls = 'sel') {
    this.pagesEl.querySelectorAll('.' + cls).forEach(e => e.classList.remove(cls));
    for (const id of ids) this.pagesEl.querySelectorAll(`[data-id="${id}"]`).forEach(e => e.classList.add(cls));
  }

  // 位置（sp）が画面内に入るようにスクロール
  ensureVisible(page, x, y, margin = 80) {
    const w = this.wraps[page];
    if (!w) return;
    const sp = this.spPx;
    const sc = this.scroller;
    const wr = w.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    const px = wr.left - sr.left + sc.scrollLeft + x * sp;
    const py = wr.top - sr.top + sc.scrollTop + y * sp;
    if (py < sc.scrollTop + margin) sc.scrollTo({ top: py - margin * 1.5, behavior: 'smooth' });
    else if (py > sc.scrollTop + sc.clientHeight - margin * 2) sc.scrollTo({ top: py - sc.clientHeight / 2, behavior: 'smooth' });
    if (px < sc.scrollLeft + margin || px > sc.scrollLeft + sc.clientWidth - margin) sc.scrollTo({ left: Math.max(0, px - sc.clientWidth / 2) });
  }

  // ── ピンチズーム（iPad Safari の gesture イベント / PC の Ctrl+ホイール） ──
  setupGestures() {
    let startZoom = 1, anchor = null;
    const sc = this.scroller;
    sc.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      startZoom = this.zoom;
      const r = sc.getBoundingClientRect();
      anchor = { cx: e.clientX - r.left, cy: e.clientY - r.top, sl: sc.scrollLeft, st: sc.scrollTop };
    });
    sc.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const s = Math.max(0.4, Math.min(3, startZoom * e.scale)) / startZoom;
      this.pagesEl.style.transform = `scale(${s})`;
      this.pagesEl.style.transformOrigin = `${anchor.cx + anchor.sl}px ${anchor.cy + anchor.st}px`;
    });
    sc.addEventListener('gestureend', (e) => {
      e.preventDefault();
      this.pagesEl.style.transform = '';
      this.setZoom(startZoom * e.scale, anchor);
    });
    sc.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = sc.getBoundingClientRect();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0025), { cx: e.clientX - r.left, cy: e.clientY - r.top, sl: sc.scrollLeft, st: sc.scrollTop });
    }, { passive: false });
  }

  setZoom(z, anchor = null) {
    const old = this.zoom;
    this.fit = false;
    this.zoom = Math.max(0.4, Math.min(3, z));
    const sc = this.scroller;
    const a = anchor || { cx: sc.clientWidth / 2, cy: sc.clientHeight / 2, sl: sc.scrollLeft, st: sc.scrollTop };
    this.rescale();
    this.app.afterZoom();
    const k = this.zoom / old;
    sc.scrollLeft = (a.sl + a.cx) * k - a.cx;
    sc.scrollTop = (a.st + a.cy) * k - a.cy;
  }
}
