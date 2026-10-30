// 小さな XML パーサ（MusicXML 用）。ブラウザでも Node（テスト）でも同じコードで動くように自前で持つ
// 結果は { name, attrs, children: [...], text } の木
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});

export function parseXML(src) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) { const txt = src.slice(i, lt); if (txt.trim()) stack[stack.length - 1].text += decode(txt); }
    if (src.startsWith('<!--', lt)) { i = src.indexOf('-->', lt) + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); stack[stack.length - 1].text += src.slice(lt + 9, e); i = e + 3; continue; }
    if (src[lt + 1] === '?' ) { i = src.indexOf('?>', lt) + 2; continue; }
    if (src[lt + 1] === '!') {
      // DOCTYPE（中に [ ... ] がある場合も）
      let j = lt + 2, depth = 0;
      while (j < n) { const c = src[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; j++; }
      i = j + 1; continue;
    }
    if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      stack.pop();
      i = gt + 1; continue;
    }
    // 開始タグ
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const name = src.slice(lt + 1, j);
    const attrs = {};
    const re = /\s*([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/y;
    re.lastIndex = j;
    let m;
    while ((m = re.exec(src))) { attrs[m[1]] = decode(m[3] ?? m[4]); j = re.lastIndex; }
    while (j < n && src[j] !== '>' ) j++;
    const selfClose = src[j - 1] === '/';
    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  return root.children.find(c => c.name && c.name[0] !== '#') || null;
}

// 便利関数
export const kid = (node, name) => node && node.children.find(c => c.name === name) || null;
export const kids = (node, name) => node ? node.children.filter(c => c.name === name) : [];
export const txt = (node, name, def = '') => { const k = name ? kid(node, name) : node; return k ? k.text.trim() : def; };
export const num = (node, name, def = 0) => { const t = txt(node, name, ''); const v = parseFloat(t); return Number.isFinite(v) ? v : def; };
