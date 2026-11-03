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
    return (all || []).map(d => ({ id: d.id, title: d.title, updated: d.updated, pinned: !!d.pinned, fileName: d.fileName || null, summary: d.summary || (d.score ? `${d.score.parts.length}パート・${d.score.measures.length}小節` : '') })).sort((a, b) => b.updated - a.updated);
  },
  get: (id) => tx('readonly', st => st.get(id)),
  put: (doc) => tx('readwrite', st => st.put(doc)),
  remove: (id) => tx('readwrite', st => st.delete(id)),
  // 同じファイル（PC のファイルハンドル）をもう開いたことがあれば、その楽譜を返す
  async findByHandle(handle) {
    if (!handle || !handle.isSameEntry) return null;
    const all = await tx('readonly', st => st.getAll());
    for (const d of all || []) {
      if (d.handle && await d.handle.isSameEntry(handle).catch(() => false)) return d;
    }
    return null;
  },
  newId: () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
};

// ── PC（Chrome / Edge）のファイル操作 ──
// File System Access API があれば、本物の「開く」「名前を付けて保存」ダイアログが使え、
// 選んだファイルにあとから上書き保存もできる（ファイルの「ハンドル」を覚えておく）。
// iPad の Safari や Firefox にはないので、そのときは共有シート / ダウンロードで代用する。
export const canPickFiles = typeof window !== 'undefined' && 'showSaveFilePicker' in window;
const PICK_TYPES = {
  kanade: { description: 'KANADE 楽譜', accept: { 'application/x-kanade+json': ['.kanade'] } },
  musicxml: { description: 'MusicXML', accept: { 'application/vnd.recordare.musicxml+xml': ['.musicxml'] } },
  midi: { description: 'MIDI ファイル', accept: { 'audio/midi': ['.mid', '.midi'] } },
  wav: { description: 'WAV オーディオ', accept: { 'audio/wav': ['.wav'] } },
  png: { description: 'PNG 画像', accept: { 'image/png': ['.png'] } },
  svg: { description: 'SVG 画像', accept: { 'image/svg+xml': ['.svg'] } },
  open: { description: '楽譜（KANADE / MusicXML / MIDI）', accept: { 'application/x-kanade+json': ['.kanade'], 'application/vnd.recordare.musicxml+xml': ['.musicxml', '.xml'], 'application/vnd.recordare.musicxml': ['.mxl'], 'audio/midi': ['.mid', '.midi'] } },
};

// 保存先を選んでもらう（キャンセルなら null）
export async function pickSaveFile(name, kind) {
  try {
    return await window.showSaveFilePicker({ id: 'kanade', suggestedName: name, startIn: 'documents', types: [PICK_TYPES[kind]] });
  } catch (e) { if (e.name === 'AbortError') return null; throw e; }
}
// 開くファイルを選んでもらう（キャンセルなら null）
export async function pickOpenFile() {
  try {
    const [h] = await window.showOpenFilePicker({ id: 'kanade', startIn: 'documents', types: [PICK_TYPES.open], excludeAcceptAllOption: false });
    return h;
  } catch (e) { if (e.name === 'AbortError') return null; throw e; }
}
export async function writeHandle(handle, blob) {
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}
// 前に開いたファイルへ書き込む許可（ブラウザを開き直すと聞き直しになる）
export async function ensurePermission(handle) {
  const opt = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opt)) === 'granted') return true;
    return (await handle.requestPermission(opt)) === 'granted';
  } catch (e) { return false; }
}

// ファイルを書き出す：PC は保存ダイアログ、iPad は共有シート（「"ファイル"に保存」など）、それ以外はダウンロード
// kind = 'kanade' | 'musicxml' | 'midi' | 'wav'。保存ダイアログを使ったときはそのハンドルを返す
export async function saveFile(name, blob, kind = 'musicxml') {
  if (canPickFiles) {
    const h = await pickSaveFile(name, kind);
    if (!h) return false;
    await writeHandle(h, blob);
    return h;
  }
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
