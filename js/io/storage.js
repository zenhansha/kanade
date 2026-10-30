// 端末内保存（IndexedDB）。iPad の Safari/ホーム画面アプリでも、データは端末の中だけに残る
const DB = 'kanade', STORE = 'docs', VER = 1;
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((ok, ng) => {
    const rq = indexedDB.open(DB, VER);
    rq.onupgradeneeded = () => { const d = rq.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }); };
    rq.onsuccess = () => ok(rq.result);
    rq.onerror = () => ng(rq.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then(d => new Promise((ok, ng) => {
    const t = d.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    const r = fn(st);
    t.oncomplete = () => ok(r && 'result' in r ? r.result : r);
    t.onerror = () => ng(t.error);
  }));
}
export const storage = {
  async list() {
    const all = await tx('readonly', st => st.getAll());
    return (all || []).map(d => ({ id: d.id, title: d.title, updated: d.updated })).sort((a, b) => b.updated - a.updated);
  },
  get: (id) => tx('readonly', st => st.get(id)),
  put: (doc) => tx('readwrite', st => st.put(doc)),
  remove: (id) => tx('readwrite', st => st.delete(id)),
  newId: () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
};

// ファイルを書き出す：iPad では共有シート（「"ファイル"に保存」など）、PC ではダウンロード
export async function saveFile(name, blob) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return true;
}
