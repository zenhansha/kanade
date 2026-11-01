// 楽譜エンジンのテスト（node tests/run.js）。ブラウザなしで「中身の計算」が正しいかを確かめる
import { createScore, measureAttrs, evTicks } from '../js/core/score.js';
import * as E from '../js/core/edit.js';
import { TPQ, spellMidi, splitSpan, pitchName, midiOf } from '../js/core/music.js';
import { exportMusicXML, importMusicXML } from '../js/io/musicxml.js';
import { layoutScore } from '../js/engrave/layout.js';
import { serializeKanade, parseKanade } from '../js/io/kanade.js';
import * as K from '../js/core/marks.js';
import { buildPerformance } from '../js/audio/player.js';

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
  eq(desc(cl[1].voices[0]), 'D5:quarter.~ D5:eighth C5:quarter');
  eq(cl[1].voices[0][0].grace, [{ type: 'eighth', slash: true, notes: [{ step: 'E', alter: 0, octave: 5 }] }]); // 記譜 F♯5 → 実音 E5
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

// ───────── Phase 2 ─────────
function phase2Score() {
  const s = createScore({ insts: ['voice', 'piano'], measures: 8 });
  let loc = { p: 0, s: 0, m: 0, v: 0, t: 0 };
  const ids = [];
  for (const p of [C4, D4, E4, F4, G4, A4, G4, F4]) { const r = E.enterNote(s, loc, { type: 'quarter', pitches: [p] }); loc = r.next; ids.push(r.ids[0]); }
  return { s, ids };
}
const F4 = { step: 'F', alter: 0, octave: 4 }, G4 = { step: 'G', alter: 0, octave: 4 }, A4 = { step: 'A', alter: 0, octave: 4 };

test('アーティキュレーション：付け外し・音価を変えても残る・休符にはフェルマータだけ', () => {
  const { s, ids } = phase2Score();
  eq(K.toggleArtic(s, [ids[0], ids[1]], 'stacc'), true);
  eq(K.toggleArtic(s, [ids[0], ids[1]], 'stacc'), false);
  K.toggleArtic(s, [ids[0]], 'acc'); K.toggleArtic(s, [ids[0]], 'marc');
  eq(E.findEvent(s, ids[0]).ev.art, ['marc']); // アクセントとマルカートは同時に付けない
  K.setLyric(s, ids[0], 0, 'ラ');
  const r = E.setDuration(s, ids[0], 'half', 0);
  const ev = E.findEvent(s, r.ids[0]).ev;
  eq([ev.art, ev.lyr], [['marc'], [{ t: 'ラ' }]]);
  K.toggleArtic(s, [r.ids[0]], 'ferm');
  E.toRest(s, r.ids[0]);
  eq(E.findEvent(s, r.ids[0]).ev.art, ['ferm']);
});

test('線（スラーなど）は小節の挿入・削除・コピーでずれない', () => {
  const { s } = phase2Score();
  K.addSpan(s, 0, 0, 0, { m: 0, t: TPQ }, { m: 1, t: TPQ * 2 }, 'slur');
  K.addDir(s, 0, 0, 1, { t: 0, k: 'dyn', v: 'f' });
  E.appendMeasures(s, 2, 1); // 1小節目の後ろに2小節
  let sp = s.parts[0].staves[0].measures[0].spans[0];
  eq([sp.dm, sp.t2], [3, TPQ * 2]);
  eq(s.parts[0].staves[0].measures[3].dirs[0].v, 'f');
  E.deleteMeasures(s, 1, 2);
  sp = s.parts[0].staves[0].measures[0].spans[0];
  eq(sp.dm, 1);
  const clip = E.copyRange(s, { m1: 0, m2: 1, staves: [[0, 0]] });
  E.pasteRange(s, clip, { m: 4, staves: [[0, 0]] });
  eq(s.parts[0].staves[0].measures[4].spans[0], { k: 'slur', v: 0, t: TPQ, dm: 1, t2: TPQ * 2 });
  // 終わりを1音ずつ動かす
  K.nudgeSpan(s, 0, 0, 0, 0, 'end', 1);
  eq(s.parts[0].staves[0].measures[0].spans[0].t2, TPQ * 3);
});

test('反復記号の演奏順（|: :| ・1番2番カッコ・D.S. al Coda）', () => {
  const s = createScore({ measures: 8 });
  const M = s.measures;
  M[1].repeatStart = true; M[2].ending = { nums: [1], len: 1 }; M[2].repeatEnd = { times: 2 }; M[3].ending = { nums: [2], len: 1 };
  M[4].segno = true; M[5].toCoda = true; M[6].jump = 'dsCoda'; M[7].coda = true;
  eq(K.playOrder(s), [0, 1, 2, 1, 3, 4, 5, 6, 4, 5, 7]);
  const s2 = createScore({ measures: 4 });
  s2.measures[0].repeatStart = true; s2.measures[1].repeatEnd = { times: 3 }; s2.measures[2].fine = true; s2.measures[3].jump = 'dcFine';
  eq(K.playOrder(s2), [0, 1, 0, 1, 0, 1, 2, 3, 0, 1, 2]);
});

test('Phase 2 の記号が MusicXML の書き出し → 読み込みで残る', () => {
  const { s, ids } = phase2Score();
  K.toggleArtic(s, [ids[0]], 'stacc'); K.toggleArtic(s, [ids[1]], 'ten'); K.toggleArtic(s, [ids[2]], 'ferm'); K.toggleArtic(s, [ids[3]], 'tr');
  K.setLyric(s, ids[0], 0, 'Hal', true); K.setLyric(s, ids[1], 0, 'le'); K.setLyric(s, ids[1], 1, 'two');
  K.addDir(s, 0, 0, 0, { t: 0, k: 'dyn', v: 'mp' });
  K.addDir(s, 0, 0, 0, { t: TPQ, k: 'chord', text: 'Bbm7/Db' });
  K.addDir(s, 0, 0, 1, { t: 0, k: 'text', text: 'dolce', pos: 'above', it: true });
  K.addSpan(s, 0, 0, 0, { m: 0, t: 0 }, { m: 0, t: TPQ * 2 }, 'slur');
  K.addSpan(s, 0, 0, 0, { m: 1, t: 0 }, { m: 1, t: TPQ * 3 }, 'cresc');
  K.addSpan(s, 0, 0, 0, { m: 0, t: TPQ * 3 }, { m: 1, t: TPQ }, '8va');
  K.addSpan(s, 1, 1, 0, { m: 0, t: 0 }, { m: 1, t: 0 }, 'ped');
  K.addGrace(s, { p: 0, s: 0, m: 1, v: 0, t: TPQ }, { step: 'B', alter: -1, octave: 4 }, { type: 'eighth', slash: true });
  s.measures[2].repeatStart = true; s.measures[3].repeatEnd = { times: 2 }; s.measures[3].ending = { nums: [1], len: 1 }; s.measures[4].ending = { nums: [2], len: 1 };
  s.measures[5].segno = true; s.measures[6].fine = true; s.measures[7].jump = 'dsFine';
  const back = importMusicXML(exportMusicXML(s));
  const v0 = (m) => back.parts[0].staves[0].measures[m].voices[0];
  eq(v0(0).map(e => e.art || null), [['stacc'], ['ten'], ['ferm'], ['tr']]);
  eq([v0(0)[0].lyr, v0(0)[1].lyr], [[{ t: 'Hal', h: true }], [{ t: 'le' }, { t: 'two' }]]);
  eq(back.parts[0].staves[0].measures[0].dirs, [{ t: 0, k: 'dyn', v: 'mp' }, { t: TPQ, k: 'chord', text: 'Bbm7/Db' }]);
  eq(back.parts[0].staves[0].measures[1].dirs, [{ t: 0, k: 'text', text: 'dolce', pos: 'above', it: true }]);
  const spans = (p, st, m) => back.parts[p].staves[st].measures[m].spans || [];
  eq(spans(0, 0, 0).map(x => [x.k, x.t, x.dm, x.t2]).sort(), [['8va', TPQ * 3, 1, TPQ], ['slur', 0, 0, TPQ * 2]]);
  eq(spans(0, 0, 1).map(x => [x.k, x.t, x.dm, x.t2]), [['cresc', 0, 0, TPQ * 3]]);
  eq(spans(1, 1, 0).map(x => x.k), ['ped']);
  eq(v0(1)[1].grace, [{ type: 'eighth', slash: true, notes: [{ step: 'B', alter: -1, octave: 4 }] }]);
  const M = back.measures;
  eq([M[2].repeatStart, M[3].repeatEnd, M[3].ending, M[4].ending, M[5].segno, M[6].fine, M[7].jump], [true, { times: 2 }, { nums: [1], len: 1 }, { nums: [2], len: 1 }, true, true, 'dsFine']);
  eq(K.playOrder(back), K.playOrder(s));
});

test('移調楽器を記譜音で表示（B♭クラリネットは長2度上・♯2つ）', () => {
  const s = createScore({ insts: ['clarinet', 'flute'], measures: 2, fifths: -2 }); // 実音 変ロ長調
  E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'quarter', pitches: [{ step: 'B', alter: -1, octave: 4 }] });
  const L = layoutScore(s, { transposed: true });
  eq([L.fifthsAt(0, 0), L.fifthsAt(1, 0)], [0, -2]); // クラリネットはハ長調、フルートはそのまま
  const w = K.writtenScore(s);
  eq(pitchName(w.parts[0].staves[0].measures[0].voices[0][0].notes[0]), 'C5');
  eq(pitchName(K.toConcert({ step: 'C', alter: 0, octave: 5 }, K.partTrans(s.parts[0]))), 'B♭4');
  eq(s.parts[0].staves[0].measures[0].voices[0][0].notes[0].step, 'B'); // 元の楽譜は変わらない
});

test('パート譜：1パートだけを表示し、続く休みの小節を1つにまとめる', () => {
  const s = createScore({ insts: ['flute', 'piano'], measures: 12 });
  E.enterNote(s, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'whole', pitches: [C4] });
  E.enterNote(s, { p: 0, s: 0, m: 9, v: 0, t: 0 }, { type: 'whole', pitches: [C4] });
  const L = layoutScore(s, { parts: [0] });
  eq(L.rows, [{ p: 0, s: 0 }]);
  const g = L.measures[3].grp;
  eq([g.first, g.last, g.count], [1, 8, 8]);
  eq(L.measures[11].grp ? [L.measures[10].grp.first, L.measures[11].grp.last] : null, [10, 11]);
  const L2 = layoutScore(s, { parts: [0], multiRest: false });
  eq(L2.measures.some(m => m.grp), false);
});

test('再生：強弱・スタッカート・8va・装飾音・反復が音に反映される', () => {
  const { s, ids } = phase2Score();
  K.addDir(s, 0, 0, 0, { t: 0, k: 'dyn', v: 'pp' });
  K.addDir(s, 0, 0, 1, { t: 0, k: 'dyn', v: 'ff' });
  K.toggleArtic(s, [ids[1]], 'stacc');
  K.addSpan(s, 0, 0, 0, { m: 0, t: TPQ * 2 }, { m: 0, t: TPQ * 2 }, '8va');
  K.addGrace(s, { p: 0, s: 0, m: 0, v: 0, t: TPQ * 3 }, D4, {});
  s.measures[0].repeatEnd = { times: 2 };
  const perf = buildPerformance(s);
  const voice = perf.notes.filter(n => n.p === 0);
  const first = voice.filter(n => n.id === ids[0]);
  eq(first.length, 2); // 反復で2回
  eq(+first[0].vel.toFixed(2), 0.32);
  const st = voice.find(n => n.id === ids[1]), nor = voice.find(n => n.id === ids[0]);
  eq(st.end - st.start < (nor.end - nor.start) * 0.6, true);
  eq(voice.find(n => n.id === ids[2]).midi, 64 + 12); // E4 → 8va で E5
  const gr = voice.filter(n => n.id === ids[3]);
  eq(gr[0].midi === 62 && gr[0].start < gr[1].start, true); // 装飾音 D4 が先
  eq(+voice.find(n => n.id === ids[4]).vel.toFixed(2), 0.9);
});

test('浄書：記号の位置が返り、強弱・歌詞・反復を描いてもページに収まる', () => {
  const { s, ids } = phase2Score();
  K.setLyric(s, ids[0], 0, 'さ');
  K.addDir(s, 0, 0, 0, { t: 0, k: 'dyn', v: 'f' });
  K.addSpan(s, 0, 0, 0, { m: 0, t: 0 }, { m: 1, t: 0 }, 'slur');
  s.measures[2].repeatStart = true; s.measures[3].repeatEnd = { times: 2 };
  const L = layoutScore(s);
  eq(L.marks.map(m => m.key.split(':')[0]).sort(), ['d', 'l', 's']);
  eq(L.pages.length, 1);
  eq(/<path class="slur"/.test(L.pages[0].svg), true);
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
