// .mxl（圧縮 MusicXML = ZIP）を開く。ブラウザ標準の DecompressionStream で解凍するので外部ライブラリ不要
export async function readMxl(buf) {
  const files = unzipIndex(new DataView(buf));
  // META-INF/container.xml に本体のファイル名が書いてある
  let main = null;
  const cont = files.find(f => f.name === 'META-INF/container.xml');
  if (cont) {
    const xml = new TextDecoder().decode(await extract(buf, cont));
    const m = /full-path\s*=\s*"([^"]+)"/.exec(xml);
    if (m) main = files.find(f => f.name === m[1]);
  }
  if (!main) main = files.find(f => /\.(xml|musicxml)$/i.test(f.name) && !f.name.startsWith('META-INF'));
  if (!main) throw new Error('MXL の中に楽譜が見つかりません');
  return new TextDecoder().decode(await extract(buf, main));
}

function unzipIndex(dv) {
  // 末尾の「中央ディレクトリ終端」を探す
  let eocd = -1;
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP 形式ではありません');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + p + 46, nlen));
    out.push({ name, method, csize, local });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function extract(buf, f) {
  const dv = new DataView(buf);
  const nlen = dv.getUint16(f.local + 26, true), xlen = dv.getUint16(f.local + 28, true);
  const start = f.local + 30 + nlen + xlen;
  const data = new Uint8Array(buf, start, f.csize);
  if (f.method === 0) return data;
  if (f.method !== 8) throw new Error('未対応の圧縮形式');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
