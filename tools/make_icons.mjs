// アプリアイコンを作る（node tools/make_icons.mjs）。外部ライブラリなしで PNG を書き出す
// デザイン：藍色の正方形に、白い連桁つき8分音符（♫）
import fs from 'node:fs';
import zlib from 'node:zlib';

const shapes = {
  heads: [{ cx: 34, cy: 70, rx: 11.5, ry: 8.2 }, { cx: 66, cy: 62, rx: 11.5, ry: 8.2 }],
  stems: [[42.2, 30, 45.6, 69], [74.2, 22, 77.6, 61]],
  beam: [[42.2, 29], [77.6, 20], [77.6, 30], [42.2, 39]],
};
const ROT = (-22 * Math.PI) / 180;

function inside(x, y) {
  for (const h of shapes.heads) {
    const dx = x - h.cx, dy = y - h.cy;
    const u = dx * Math.cos(ROT) + dy * Math.sin(ROT), v = -dx * Math.sin(ROT) + dy * Math.cos(ROT);
    if ((u * u) / (h.rx * h.rx) + (v * v) / (h.ry * h.ry) <= 1) return true;
  }
  for (const [x0, y0, x1, y1] of shapes.stems) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  // 凸四角形の内側判定
  const P = shapes.beam;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = P[i], [bx, by] = P[(i + 1) % 4];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) { if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false; }
  }
  return true;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    // 背景：上から下へ藍色のグラデーション
    const t = j / size;
    const bg = [Math.round(36 + 22 * t), Math.round(52 + 26 * t), Math.round(140 + 60 * t)];
    let cov = 0;
    for (let a = 0; a < ss; a++) for (let b = 0; b < ss; b++) {
      const x = ((i + (a + 0.5) / ss) / size) * 100, y = ((j + (b + 0.5) / ss) / size) * 100;
      // 少し縮めて中央に（マスクで切られても大丈夫なように）
      if (inside(50 + (x - 50) / 0.82, 50 + (y - 50) / 0.82 - 1)) cov++;
    }
    const k = cov / (ss * ss);
    const o = (j * size + i) * 4;
    px[o] = Math.round(bg[0] * (1 - k) + 255 * k);
    px[o + 1] = Math.round(bg[1] * (1 - k) + 250 * k);
    px[o + 2] = Math.round(bg[2] * (1 - k) + 240 * k);
    px[o + 3] = 255;
  }
  return png(size, size, px);
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const dir = new URL('../icons/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(new URL('icon-192.png', dir), render(192));
fs.writeFileSync(new URL('icon-512.png', dir), render(512));
fs.writeFileSync(new URL('apple-touch-icon.png', dir), render(180));
const s = 0.82, tf = `translate(${50 - 50 * s} ${50 - 50 * s + s}) scale(${s})`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#24348c"/><stop offset="1" stop-color="#3a4ec8"/></linearGradient></defs>` +
  `<rect width="100" height="100" rx="22" fill="url(#g)"/><g fill="#fffaf0" transform="${tf}">` +
  shapes.heads.map(h => `<ellipse cx="${h.cx}" cy="${h.cy}" rx="${h.rx}" ry="${h.ry}" transform="rotate(-22 ${h.cx} ${h.cy})"/>`).join('') +
  shapes.stems.map(([x0, y0, x1, y1]) => `<rect x="${x0}" y="${y0}" width="${(x1 - x0).toFixed(1)}" height="${y1 - y0}"/>`).join('') +
  `<polygon points="${shapes.beam.map(p => p.join(',')).join(' ')}"/></g></svg>`;
fs.writeFileSync(new URL('icon.svg', dir), svg);
console.log('icons written');
