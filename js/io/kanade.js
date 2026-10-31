// KANADE 独自の保存形式（.kanade）。中身は楽譜データをそのまま JSON にしたもの。
// MusicXML はソフト間の受け渡し用で、改段やページ設定など KANADE だけの情報までは残らない。
// .kanade なら何も失わずに保存・再読み込みできる（PC で「ファイルに保存」するときの形式）。
export const KANADE_EXT = '.kanade';
export const KANADE_MIME = 'application/x-kanade+json';
const VERSION = 1;

export function serializeKanade(score) {
  return JSON.stringify({ format: 'kanade', version: VERSION, score });
}

export function parseKanade(text) {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('KANADE のファイルではないようです'); }
  if (!d || d.format !== 'kanade' || !d.score) throw new Error('KANADE のファイルではないようです');
  if (d.version > VERSION) throw new Error('新しい版の KANADE で作られたファイルです。アプリを更新してください');
  const sc = d.score;
  if (!Array.isArray(sc.parts) || !Array.isArray(sc.measures) || !sc.parts.length) throw new Error('楽譜データが壊れています');
  return sc;
}
