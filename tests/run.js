// 楽譜エンジンのテスト（node tests/run.js）。ブラウザなしで「中身の計算」が正しいかを確かめる
import { createScore, measureAttrs, evTicks } from '../js/core/score.js';
import * as E from '../js/core/edit.js';
import { TPQ, spellMidi, splitSpan, pitchName, midiOf } from '../js/core/music.js';
import { exportMusicXML, importMusicXML } from '../js/io/musicxml.js';
import { layoutScore } from '../js/engrave/layout.js';
import { serializeKanade, parseKanade } from '../js/io/kanade.js';

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const eq = (a, b, msg = '') => {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}\n  期待: ${jb}\n  実際: ${ja}`);
};
const desc = (voice) => voice.map(e => (e.rest ? 'r' : e.notes.map(pitchName).join('+')) + ':' + e.type + '.'.repeat(e.dots) + (e.tuplet ? `[${e.tuplet.actual}]` : '') + (e.notes.some(n => n.tie) ? '~' : '') + (e.mr ? '(mr)' : '')).join(' ');
const voiceSum = (voice) => voice.reduce((a, e) => a + evTicks(e), 0);
const C4 = { step: 'C', alter: 0, octave: 4 }, D4 = { step: 'D', alter: 0, octave: 4 }, E4 = { step: 'E', alter: 0, octave: 4 };

test('新規スコアは全休符で埋まっている', () => {
  const s = createScore({ insts: ['piano'], measures: 4 });
  eq(s.parts[0].staves.length, 2);
  eq(desc(s.parts[0].staves[1].measures[3].voices[0]), 'r:whole(mr)');
});

test('4分音符を入れると残りは休符で埋まる', () => {
  const s = createScore({ measures: 2 });
  const r = E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'quarter', dots: 0, pitches: [C4] });
  eq(desc(s.parts[0].staves[0].measures[0].voices[0]), 'C4:quarter r:quarter r:half');
  eq(r.next, { p: 0, s: 0, m: 0, v: 0, t: TPQ });
});

test('続けて入力・2拍目の途中から', () => {
  const s = createScore({ measures: 2 });
  let loc = { p: 0, s: 0, m: 0, v: 0, t: 0 };
  loc = E.enterNote(s, loc, { type: 'quarter', pitches: [C4] }).next;
  loc = E.enterNote(s, loc, { type: 'eighth', pitches: [D4] }).next;
  eq(desc(s.parts[0].staves[0].measures[0].voices[0]), 'C4:quarter D4:eighth r:eighth r:half');
  loc = E.enterNote(s, loc, { type: 'half', dots: 0, pitches: [E4] }).next;
  // 2.5拍目から2分音符 → 4拍目の途中まで、残りは8分休符
  eq(desc(s.parts[0].staves[0].measures[0].voices[0]), 'C4:quarter D4:eighth E4:half r:eighth');
});

test('小節線をまたぐとタイで分割される', () => {
  const s = createScore({ measures: 2 });
  E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: TPQ * 3 }, { type: 'half', pitches: [C4] });
  eq(desc(s.parts[0].staves[0].measures[0].voices[0]), 'r:half r:quarter C4:quarter~');
  eq(desc(s.parts[0].staves[0].measures[1].voices[0]), 'C4:quarter r:quarter r:half');
});

test('最後の小節の先まで入力すると小節が増える', () => {
  const s = createScore({ measures: 1 });
  const r = E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'whole', pitches: [C4] });
  eq(s.measures.length, 2);
  eq(r.next.m, 1);
  eq(s.measures[1].barline, 'final');
  eq(s.measures[0].barline, undefined);
});

test('長い音符で後ろの音符を上書き', () => {
  const s = createScore({ measures: 1 });
  let loc = { p: 0, s: 0, m: 0, v: 0, t: 0 };
  for (let i = 0; i < 4; i++) loc = E.enterNote(s, loc, { type: 'quarter', pitches: [C4] }).next;
  E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: TPQ / 2 }, { type: 'quarter', pitches: [E4] });
  const v = s.parts[0].staves[0].measures[0].voices[0];
  eq(desc(v), 'C4:eighth E4:quarter r:eighth C4:quarter C4:quarter');
  eq(voiceSum(v), TPQ * 4);
});

test('3連符を作って中身を差し替え', () => {
  const s = createScore({ measures: 1 });
  const id = E.makeTuplet(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, 3, 'eighth');
  let v = s.parts[0].staves[0].measures[0].voices[0];
  eq(desc(v), 'r:eighth[3] r:eighth[3] r:eighth[3] r:quarter r:half');
  eq(voiceSum(v), TPQ * 4);
  let loc = { p: 0, s: 0, m: 0, v: 0, t: 0 };
  loc = E.enterNote(s, loc, { type: 'quarter', pitches: [C4] }).next; // 連符内は長さ無視で差し替え
  loc = E.enterNote(s, loc, { type: 'quarter', pitches: [D4] }).next;
  v = s.parts[0].staves[0].measures[0].voices[0];
  eq(desc(v), 'C4:eighth[3] D4:eighth[3] r:eighth[3] r:quarter r:half');
  eq(loc.t, Math.round(TPQ * 2 / 3));
  void id;
});

test('連符の一部に普通の音符を重ねると連符ごと置き換わる', () => {
  const s = createScore({ measures: 1 });
  E.makeTuplet(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, 3, 'eighth');
  E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'eighth', pitches: [C4] });
  // カーソル位置は連符の頭なので差し替え扱い。途中から普通の8分音符を書く場合：
  const s2 = createScore({ measures: 1 });
  E.makeTuplet(s2, { p: 0, s: 0, m: 0, v: 0, t: TPQ }, 3, 'eighth');
  E.enterNote(s2, { p: 0, s: 0, m: 0, v: 0, t: TPQ / 2 }, { type: 'quarter', pitches: [C4] });
  const v = s2.parts[0].staves[0].measures[0].voices[0];
  eq(voiceSum(v), TPQ * 4);
  eq(v.some(e => e.tuplet), false);
});

test('和音を足す・タイの続きにも足される', () => {
  const s = createScore({ measures: 2 });
  const r = E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: TPQ * 3 }, { type: 'half', pitches: [C4] });
  E.addToChord(s, r.ids[0], E4);
  eq(desc(s.parts[0].staves[0].measures[0].voices[0]).split(' ').pop(), 'C4+E4:quarter~');
  eq(desc(s.parts[0].staves[0].measures[1].voices[0]).split(' ')[0], 'C4+E4:quarter');
});

test('休符にすると全部休符なら全休符に戻る', () => {
  const s = createScore({ measures: 1 });
  const r = E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'quarter', pitches: [C4] });
  E.toRest(s, r.ids[0]);
  eq(desc(s.parts[0].staves[0].measures[0].voices[0]), 'r:whole(mr)');
});

test('声部2に入力 → 声部2を消すと消える', () => {
  const s = createScore({ measures: 1 });
  const r = E.enterNote(s, { p: 0, s: 0, m: 0, v: 1, t: 0 }, { type: 'half', pitches: [C4] });
  eq(desc(s.parts[0].staves[0].measures[0].voices[1]), 'C4:half r:half');
  E.toRest(s, r.ids[0]);
  eq(s.parts[0].staves[0].measures[0].voices.length, 1);
});

test('音価を変える（付点）', () => {
  const s = createScore({ measures: 1 });
  let loc = { p: 0, s: 0, m: 0, v: 0, t: 0 };
  const r = E.enterNote(s, loc, { type: 'quarter', pitches: [C4] });
  E.enterNote(s, r.next, { type: 'eighth', pitches: [D4] });
  E.setDuration(s, r.ids[0], 'quarter', 1);
  eq(desc(s.parts[0].staves[0].measures[0].voices[0]), 'C4:quarter. r:eighth r:half');
});

test('拍子変更で小節の中身が合わせられる', () => {
  const s = createScore({ measures: 2 });
  let loc = { p: 0, s: 0, m: 0, v: 0, t: 0 };
  for (let i = 0; i < 4; i++) loc = E.enterNote(s, loc, { type: 'quarter', pitches: [C4] }).next;
  E.setTime(s, 0, { beats: 3, beatType: 4 });
  eq(desc(s.parts[0].staves[0].measures[0].voices[0]), 'C4:quarter C4:quarter C4:quarter');
  E.setTime(s, 0, { beats: 6, beatType: 8 });
  eq(voiceSum(s.parts[0].staves[0].measures[0].voices[0]), TPQ * 3);
  eq(measureAttrs(s)[1].len, TPQ * 3);
});

test('6/8 の休符は付点で分けられる', () => {
  const r = splitSpan(TPQ / 2 * 3, TPQ * 3, { beats: 6, beatType: 8 });
  eq(r.map(x => x.type + '.'.repeat(x.dots)), ['quarter.']);
});

test('弱起小節', () => {
  const s = createScore({ measures: 3, pickup: TPQ });
  eq(measureAttrs(s)[0].len, TPQ);
  E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'eighth', pitches: [C4] });
  eq(desc(s.parts[0].staves[0].measures[0].voices[0]), 'C4:eighth r:eighth');
});

test('MIDI番号の綴り（調に合わせる）', () => {
  eq(pitchName(spellMidi(70, -1)), 'B♭4');
  eq(pitchName(spellMidi(66, 2)), 'F♯4');
  eq(pitchName(spellMidi(61, 0)), 'C♯4');
  eq(pitchName(spellMidi(63, 0)), 'E♭4');
  eq(pitchName(spellMidi(71, -7)), 'C♭5');
  eq(midiOf({ step: 'C', alter: -1, octave: 5 }), 71);
});

test('小節の削除と挿入', () => {
  const s = createScore({ measures: 4, bpm: 90 });
  E.appendMeasures(s, 2, 1);
  eq(s.measures.length, 6);
  eq(s.parts[0].staves[0].measures.length, 6);
  E.deleteMeasures(s, 0, 1);
  eq(s.measures.length, 4);
  eq(s.measures[0].tempo.bpm, 90);
  eq(s.measures[3].barline, 'final');
});

test('コピー＆ペースト', () => {
  const s = createScore({ measures: 4 });
  E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'half', pitches: [C4] });
  const clip = E.copyRange(s, { m1: 0, m2: 0, staves: [[0, 0]] });
  E.pasteRange(s, clip, { m: 2, staves: [[0, 0]] });
  eq(desc(s.parts[0].staves[0].measures[2].voices[0]), 'C4:half r:half');
  eq(s.parts[0].staves[0].measures[2].voices[0][0].id !== s.parts[0].staves[0].measures[0].voices[0][0].id, true);
});

// ── MusicXML の往復（書き出して読み直すと同じ楽譜に戻るか） ──
function sampleScore() {
  const s = createScore({ insts: ['flute', 'piano'], measures: 4, title: 'Round & Trip', composer: 'テスト', fifths: -1, bpm: 88, time: { beats: 3, beatType: 4 } });
  let loc = { p: 1, s: 0, m: 0, v: 0, t: 0 };
  loc = E.enterNote(s, loc, { type: 'quarter', dots: 1, pitches: [{ step: 'B', alter: -1, octave: 4 }] }).next;
  loc = E.enterNote(s, loc, { type: 'eighth', pitches: [{ step: 'F', alter: 1, octave: 5 }] }).next;
  const r = E.enterNote(s, loc, { type: 'half', pitches: [C4] });
  E.addToChord(s, r.ids[0], E4);
  E.makeTuplet(s, { p: 0, s: 0, m: 1, v: 0, t: 0 }, 3, 'eighth');
  let tl = { p: 0, s: 0, m: 1, v: 0, t: 0 };
  for (const p of [C4, D4, E4]) tl = E.enterNote(s, tl, { type: 'eighth', pitches: [p] }).next;
  E.enterNote(s, { p: 1, s: 0, m: 2, v: 1, t: 0 }, { type: 'half', pitches: [{ step: 'G', alter: 0, octave: 3 }] });
  E.enterNote(s, { p: 1, s: 1, m: 0, v: 0, t: 0 }, { type: 'half', dots: 1, pitches: [{ step: 'C', alter: 0, octave: 3 }] });
  E.setClef(s, 1, 1, 2, 'treble');
  return s;
}
const allDesc = (s) => s.parts.map(p => p.staves.map(st => st.measures.map(sm => sm.voices.map(v => (v ? desc(v) : '-')).join(' | ')).join(' / ')).join(' // ')).join(' ### ');

test('MusicXML 書き出し → 読み込みで同じ内容', () => {
  const s = sampleScore();
  const xml = exportMusicXML(s);
  const back = importMusicXML(xml);
  eq(back.meta.title, 'Round & Trip');
  eq(back.meta.composer, 'テスト');
  eq(back.parts.map(p => p.inst), ['flute', 'piano']);
  eq(back.parts[1].staves.length, 2);
  eq(back.measures[0].key.fifths, -1);
  eq(back.measures[0].time, { beats: 3, beatType: 4 });
  eq(back.measures[0].tempo.bpm, 88);
  eq(back.parts[1].staves[1].measures[2].clef, 'treble');
  eq(allDesc(back), allDesc(s));
});

test('弱起つきの MusicXML 往復', () => {
  const s = createScore({ measures: 3, pickup: TPQ });
  E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'quarter', pitches: [C4] });
  const back = importMusicXML(exportMusicXML(s));
  eq(back.measures[0].pickup, TPQ);
  eq(allDesc(back), allDesc(s));
});

test('レイアウトがすべての音符の位置を返す', () => {
  const s = sampleScore();
  const L = layoutScore(s);
  let n = 0;
  s.parts.forEach(p => p.staves.forEach(st => st.measures.forEach(sm => sm.voices.forEach(v => v && v.forEach(ev => { n++; if (!L.evGeom[ev.id]) throw new Error('位置がない: ' + ev.id); })))));
  eq(n > 10, true);
  eq(L.pages.length, 1);
});

test('Finale 風の MusicXML を読み込む（弱起・移調楽器・声部・連符・装飾音）', async () => {
  const fs = await import('node:fs');
  const xml = fs.readFileSync(new URL('./fixtures/finale_like.musicxml', import.meta.url), 'utf8');
  const s = importMusicXML(xml);
  eq(s.meta.title, 'Test Sonatine');
  eq(s.meta.composer, 'K. Tester');
  eq(s.parts.map(p => p.inst), ['clarinet', 'piano']);
  eq(s.measures.length, 3);
  eq(s.measures[0].pickup, TPQ);
  eq(s.measures[0].key.fifths, -1); // B♭管のト長調（記譜）= 実音ヘ長調
  eq(s.measures[0].tempo, { bpm: 132, text: 'Allegro' });
  eq(s.measures[2].barline, 'final');
  const cl = s.parts[0].staves[0].measures;
  eq(desc(cl[0].voices[0]), 'D5:quarter');           // 記譜 E5 → 実音 D5
  eq(desc(cl[1].voices[0]), 'D5:quarter.~ D5:eighth C5:quarter'); // 装飾音は今は読み飛ばし
  const pr = s.parts[1].staves;
  eq(desc(pr[0].measures[1].voices[0]), 'C5:eighth[3] D5:eighth[3] E5:eighth[3] F5:half');
  eq(desc(pr[0].measures[1].voices[1]), 'A4:half B♭4:quarter');
  eq(desc(pr[1].measures[1].voices[0]), 'F3+C4:half.');
  eq(pr[1].measures[2].clef, 'treble');
  const L = layoutScore(s);
  eq(L.pages.length, 1);
});

test('.mxl（圧縮 MusicXML）を開ける', async () => {
  const zlib = await import('node:zlib');
  const { readMxl } = await import('../js/io/mxl.js');
  const xml = Buffer.from(exportMusicXML(createScore({ title: 'MXL' })));
  const cont = Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>');
  const zip = makeZip([['META-INF/container.xml', cont], ['score.xml', xml]], zlib);
  const back = importMusicXML(await readMxl(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length)));
  eq(back.meta.title, 'MXL');
});
test('.kanade 保存 → 読み込みで何も失われない（改段・ページ設定・連符も）', () => {
  const s = createScore({ insts: ['piano', 'flute'], measures: 6, title: 'カナデ', composer: 'テスト' });
  E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'quarter', dots: 1, pitches: [C4, E4] });
  E.makeTuplet(s, { p: 1, s: 0, m: 1, v: 0, t: 0 }, 3, 'eighth');
  s.measures[2].sysBreak = true;
  s.settings.staffMm = 6.2;
  const back = parseKanade(serializeKanade(s));
  eq(back, s);
});

test('.kanade でないファイルや新しすぎる版は分かりやすく断る', () => {
  const msg = (t) => { try { parseKanade(t); return 'ok'; } catch (e) { return e.message; } };
  eq(msg('<score-partwise/>'), 'KANADE のファイルではないようです');
  eq(msg('{"format":"other"}'), 'KANADE のファイルではないようです');
  eq(msg('{"format":"kanade","version":1,"score":{"parts":[],"measures":[]}}'), '楽譜データが壊れています');
  eq(/新しい版/.test(msg('{"format":"kanade","version":99,"score":{}}')), true);
});

function makeZip(files, zlib) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data] of files) {
    const comp = zlib.deflateRawSync(data);
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("  ✔", name); }
  catch (e) { fail++; console.log('  ✘', name, '\n   ', e.message); }
}
console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
