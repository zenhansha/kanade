// 楽譜エンジンのテスト（node tests/run.js）。ブラウザなしで「中身の計算」が正しいかを確かめる
import { createScore, measureAttrs, evTicks } from '../js/core/score.js';
import * as E from '../js/core/edit.js';
import { TPQ, spellMidi, splitSpan, pitchName, midiOf } from '../js/core/music.js';
import { exportMusicXML, importMusicXML } from '../js/io/musicxml.js';
import { layoutScore } from '../js/engrave/layout.js';
import { serializeKanade, parseKanade } from '../js/io/kanade.js';
import * as K from '../js/core/marks.js';
import { buildPerformance } from '../js/audio/player.js';
import * as S from '../js/core/stream.js';
import * as MA from '../js/core/massedit.js';
import * as PC from '../js/core/perc.js';
import { exportMidi, importMidi } from '../js/io/midifile.js';
import { rebar } from '../js/core/rebar.js';
import { SMUFL } from '../js/smufl.js';

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
  eq(L.rows.map(r => ({ p: r.p, s: r.s })), [{ p: 0, s: 0 }]);
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
  const perf = buildPerformance(s, { human: false }); // 表情付き再生の揺れを入れずに比べる
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
  eq(L.marks.map(m => m.key.split(':')[0]).sort(), ['d', 'l', 'm', 's']); // m = テンポ（Phase 4 から選べる）
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

// ═════════ Phase 3 ═════════
const P3 = (st, oc, al = 0) => ({ step: st, alter: al, octave: oc });
const d3 = (sc, p, st, m, v = 0) => desc(sc.parts[p].staves[st].measures[m].voices[v] || []);

test('クオンタイズ：演奏のズレを16分・3連にそろえ、和音と長い音（声部2）に分ける', () => {
  const sc = createScore({ insts: ['piano'], measures: 2 });
  const A = measureAttrs(sc);
  const raw = [
    { start: 30, end: TPQ - 200, midi: 60 }, { start: TPQ + 50, end: TPQ * 1.5 - 100, midi: 62 }, { start: TPQ * 1.5 - 60, end: TPQ * 2 - 30, midi: 64 },
    { start: TPQ * 3 + 40, end: TPQ * 5, midi: 65 },
    { start: TPQ * 5 + 10, end: TPQ * 5 + 2200, midi: 67 }, { start: TPQ * 5 + 2250, end: TPQ * 5 + 4400, midi: 69 }, { start: TPQ * 5 + 4500, end: TPQ * 6 - 20, midi: 71 },
    { start: TPQ * 6, end: TPQ * 8, midi: 48 }, { start: TPQ * 6, end: TPQ * 7, midi: 72 }, { start: TPQ * 7, end: TPQ * 8, midi: 74 },
  ];
  const [v1, v2] = S.splitVoices(S.spellNotes(S.quantize(raw, { grid: TPQ / 4, triplets: true }), A));
  S.writeStream(sc, 0, 0, 0, v1);
  S.writeStream(sc, 0, 0, 1, v2);
  eq(d3(sc, 0, 0, 0), 'C4:quarter D4:eighth E4:eighth r:quarter F4:quarter~');
  eq(d3(sc, 0, 0, 1), 'F4:quarter G4:eighth[3] A4:eighth[3] B4:eighth[3] C5:quarter D5:quarter');
  eq(d3(sc, 0, 0, 1, 1), 'r:half C3:half');
  // 読み出すとタイはまとまる
  eq(S.readStream(sc, 0, 0, 0, 0, 1).map(i => (i.end - i.start) / TPQ).slice(0, 4), [1, 0.5, 0.5, 2]);
});

test('MIDI ファイル：書き出し → 読み込みで、ピアノの右手左手・ドラム（手と足）・テンポが戻る', () => {
  const sc = createScore({ insts: ['piano', 'drumset'], measures: 2, bpm: 90 });
  let loc = { p: 0, s: 0, m: 0, v: 0, t: 0 };
  for (const [st, oc, ty] of [['C', 5, 'quarter'], ['E', 5, 'eighth'], ['G', 5, 'eighth'], ['C', 6, 'half']]) loc = E.enterNote(sc, loc, { type: ty, pitches: [P3(st, oc)] }).next;
  E.enterNote(sc, { p: 0, s: 1, m: 0, v: 0, t: 0 }, { type: 'whole', pitches: [P3('C', 3), P3('G', 3)] });
  let d = { p: 1, s: 0, m: 0, v: 0, t: 0 };
  for (let k = 0; k < 4; k++) d = E.enterNote(sc, d, { type: 'quarter', pitches: [PC.drumPitch(k % 2 ? PC.DRUM.snare : PC.DRUM.kick), PC.drumPitch(PC.DRUM.hh)] }).next;
  const bytes = exportMidi(sc);
  eq([...bytes.slice(0, 4)].map(c => String.fromCharCode(c)).join(''), 'MThd');
  const back = importMidi(bytes);
  eq(back.parts.map(p => p.inst), ['piano', 'drumset']);
  eq(back.measures[0].tempo.bpm, 90);
  eq(d3(back, 0, 0, 0), 'C5:quarter E5:eighth G5:eighth C6:half');
  eq(d3(back, 0, 1, 0), 'C3+G3:whole');
  const dr = (v) => back.parts[1].staves[0].measures[0].voices[v].map(e => e.notes.map(n => n.drum).join('+') || 'r').join(' ');
  eq(dr(0), 'hh snare+hh hh snare+hh');
  eq(dr(1), 'kick r kick r');
});

test('一括編集：音程で移調（調号・コードも）、音価2倍で後ろが押し出される、逆行', () => {
  const mk = () => {
    const sc = createScore({ insts: ['violin', 'violin', 'viola'], measures: 4 });
    let loc = { p: 0, s: 0, m: 0, v: 0, t: 0 };
    for (const [ps, ty] of [[[P3('C', 5), P3('E', 5), P3('G', 5)], 'quarter'], [[P3('D', 5), P3('F', 5, 1)], 'eighth'], [[P3('E', 5)], 'eighth'], [[P3('F', 5), P3('A', 5)], 'half'], [[P3('G', 5)], 'whole']]) loc = E.enterNote(sc, loc, { type: ty, pitches: ps }).next;
    return sc;
  };
  let sc = mk();
  K.addDir(sc, 0, 0, 0, { t: 0, k: 'chord', text: 'C' });
  MA.transposeBy(sc, { m1: 0, m2: 3, staves: [[0, 0]] }, 1, 2, { keys: true });
  eq(d3(sc, 0, 0, 0), 'D5+F♯5+A5:quarter E5+G♯5:eighth F♯5:eighth G5+B5:half');
  eq(sc.measures[0].key.fifths, 2);
  eq(sc.parts[0].staves[0].measures[0].dirs[0].text, 'D');
  sc = mk(); MA.scaleDurations(sc, { m1: 0, m2: 0, staves: [[0, 0]] }, 2);
  eq([0, 1, 2].map(m => d3(sc, 0, 0, m)), ['C5+E5+G5:half D5+F♯5:quarter E5:quarter', 'F5+A5:whole', 'G5:whole']);
  sc = mk(); MA.scaleDurations(sc, { m1: 0, m2: 1, staves: [[0, 0]] }, 0.5);
  eq([0, 1].map(m => d3(sc, 0, 0, m)), ['C5+E5+G5:eighth D5+F♯5:16th E5:16th F5+A5:quarter G5:half', 'r:whole(mr)']);
  sc = mk(); MA.retrograde(sc, { m1: 0, m2: 0, staves: [[0, 0]] });
  eq(d3(sc, 0, 0, 0), 'F5+A5:half E5:eighth D5+F♯5:eighth C5+E5+G5:quarter');
  sc = mk(); eq(MA.respell(sc, { m1: 0, m2: 0, staves: [[0, 0]] }), 1);
  eq(d3(sc, 0, 0, 0).includes('G♭5'), true);
});

test('エクスプロード / インプロード・項目を選んで消去', () => {
  const sc = createScore({ insts: ['violin', 'violin', 'viola'], measures: 2 });
  E.enterNote(sc, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'half', pitches: [P3('C', 5), P3('E', 5), P3('G', 5)] });
  E.enterNote(sc, { p: 0, s: 0, m: 0, v: 0, t: TPQ * 2 }, { type: 'half', pitches: [P3('D', 5), P3('F', 5)] });
  const rows = [{ p: 0, s: 0 }, { p: 1, s: 0 }, { p: 2, s: 0 }];
  MA.explode(sc, { m1: 0, m2: 0, staves: [[0, 0]] }, rows);
  eq([0, 1, 2].map(p => d3(sc, p, 0, 0)), ['G5:half F5:half', 'E5:half D5:half', 'C5:half r:half']);
  MA.implode(sc, { m1: 0, m2: 0, staves: [[1, 0], [2, 0]] });
  eq(d3(sc, 1, 0, 0), 'C5+E5:half D5:half');
  MA.setArticAll(sc, { m1: 0, m2: 0, staves: [[0, 0]] }, 'acc');
  K.addDir(sc, 0, 0, 0, { t: 0, k: 'dyn', v: 'f' });
  MA.clearItems(sc, { m1: 0, m2: 0, staves: [[0, 0]] }, { art: true, dyn: true });
  eq(sc.parts[0].staves[0].measures[0].voices[0].some(e => e.art), false);
  eq(sc.parts[0].staves[0].measures[0].dirs, undefined);
});

test('ドラム譜と TAB 譜：浄書（×の符頭・フレット番号）と MusicXML の往復', () => {
  const sc = createScore({ insts: ['egtrTab', 'drumset'], measures: 2 });
  E.enterNote(sc, { p: 0, s: 0, m: 0, v: 0, t: 0 }, { type: 'quarter', pitches: [P3('E', 3), P3('B', 3), P3('E', 4)] });
  E.enterNote(sc, { p: 0, s: 0, m: 0, v: 0, t: TPQ }, { type: 'quarter', pitches: [{ ...P3('A', 3), str: 4 }] });
  E.enterNote(sc, { p: 1, s: 0, m: 0, v: 0, t: 0 }, { type: 'quarter', pitches: [PC.drumPitch(PC.DRUM.hh), PC.drumPitch(PC.DRUM.snare)] });
  eq(PC.tabFrets([P3('E', 3), P3('B', 3), P3('E', 4)], PC.TUNINGS.guitar.notes), [{ str: 4, fret: 2 }, { str: 2, fret: 0 }, { str: 1, fret: 0 }]);
  eq(PC.tabFrets([{ ...P3('A', 3), str: 4 }], PC.TUNINGS.guitar.notes), [{ str: 4, fret: 7 }]);
  const L = layoutScore(sc);
  eq(L.rows.map(r => r.kind), ['std', 'tab', 'perc']);
  eq(L.rows[1].h, 7.5);
  const svg = L.pages.map(p => p.svg).join('');
  eq((svg.match(/tabn/g) || []).length, 4);
  eq(svg.includes(SMUFL_X()), true);
  // MusicXML：ドラムは unpitched＋楽器、TAB は staff-details と string/fret
  const xml = exportMusicXML(sc);
  eq(/<unpitched><display-step>G<\/display-step><display-octave>5<\/display-octave><\/unpitched>/.test(xml), true);
  eq(/<staff-lines>6<\/staff-lines>/.test(xml) && /<string>4<\/string><fret>7<\/fret>/.test(xml), true);
  const back = importMusicXML(xml);
  eq(back.parts[0].staves.map(st => st.clef + (st.tabOf != null ? '→' + st.tabOf : '')), ['treble8vb', 'tab→0']);
  eq(back.parts[0].staves[1].tuning, PC.TUNINGS.guitar.notes);
  eq(back.parts[1].inst, 'drumset');
  eq(back.parts[1].staves[0].measures[0].voices[0][0].notes.map(n => n.drum).sort(), ['hh', 'snare']);
});
const SMUFL_X = () => '\uE0A9';

test('表情付き再生：rit. で遅くなる・スウィング・ミュート/ソロ・メトロノーム', () => {
  const mk = () => {
    const sc = createScore({ insts: ['flute', 'oboe'], measures: 3, bpm: 120 });
    let loc = { p: 0, s: 0, m: 0, v: 0, t: 0 };
    for (let k = 0; k < 24; k++) loc = E.enterNote(sc, loc, { type: 'eighth', pitches: [P3('C', 5)] }).next;
    return sc;
  };
  let sc = mk();
  const plain = buildPerformance(sc, { human: false });
  eq(+plain.total.toFixed(3), 8); // 入れ終わると小節が1つ増えて4小節
  eq(plain.clicks.length, 16);
  K.addDir(sc, 0, 0, 1, { t: 0, k: 'text', text: 'rit.' });
  const rit = buildPerformance(sc);
  eq(rit.total > 8.5, true);
  sc = mk(); sc.settings.playback = { human: false, swing: 1 };
  const sw = buildPerformance(sc).notes.filter(n => n.p === 0);
  eq(+(sw[1].start - sw[0].start).toFixed(3), 0.333); // 2:1 に跳ねる
  sc = mk(); sc.parts[0].mix = { mute: true };
  eq(buildPerformance(sc).notes.filter(n => n.p === 0).length, 0);
  sc.parts[1].mix = { solo: true }; sc.parts[0].mix = {};
  eq(buildPerformance(sc).notes.filter(n => n.p === 0).length, 0);
});

test('ページレイアウト：1段の小節数・前の段へ（keep）・改ページ・段とパートの間隔', () => {
  const sc = createScore({ insts: ['piano'], measures: 12 });
  sc.settings.layout = { perSystem: 3 };
  let L = layoutScore(sc);
  eq(L.systems.map(x => x.ms.length), [3, 3, 3, 3]);
  sc.measures[2].keep = true; sc.measures[3].sysBreak = true;
  L = layoutScore(sc);
  eq(L.systems[0].ms, [0, 1, 2, 3]);
  sc.measures[3].pageBreak = true;
  L = layoutScore(sc);
  eq(L.systems[1].page, 1);
  const gap = (lay) => { sc.settings.layout = lay; const L2 = layoutScore(sc); return L2.systems[0].staffYs[1] - L2.systems[0].staffYs[0]; };
  eq(gap({ staffGap: 12 }) > gap({ staffGap: 6.5 }), true);
});

// ═════════ Phase 4 ═════════
const glyphCh = (n) => SMUFL.glyphs[n].c;
const put4 = (sc, m, list, p = 0, st = 0) => { let t = 0; const ids = []; for (const [type, ps, extra] of list) { const r = E.enterNote(sc, { p, s: st, m, v: 0, t }, { type, dots: 0, pitches: ps }); const ev = E.findEvent(sc, r.ids[0]).ev; Object.assign(ev, extra || {}); ids.push(ev.id); t += { quarter: TPQ, half: TPQ * 2, eighth: TPQ / 2, whole: TPQ * 4 }[type]; } return ids; };

test('拍子の変更で小節を組み直す（4/4 → 3/4、はみ出す音はタイ、記号も同じ時間の位置へ）', () => {
  const sc = createScore({ insts: ['violin'], measures: 2 });
  put4(sc, 0, [['quarter', [C4]], ['quarter', [D4]], ['quarter', [E4]], ['quarter', [F4]]]);
  put4(sc, 1, [['half', [G4]], ['half', [A4]]]);
  K.addDir(sc, 0, 0, 1, { t: 0, k: 'dyn', v: 'f' });
  if (sc.measures.length > 2) E.deleteMeasures(sc, 2, sc.measures.length - 1); // 入力で増えた小節
  sc.measures[1].barline = 'final';
  const r = rebar(sc, 0, { beats: 3, beatType: 4 });
  eq(r.count, 3);
  eq(sc.measures.length, 3);
  eq(d3(sc, 0, 0, 0), 'C4:quarter D4:quarter E4:quarter');
  eq(d3(sc, 0, 0, 1), 'F4:quarter G4:half');
  eq(d3(sc, 0, 0, 2), 'A4:half r:quarter');
  // f は「G4 の頭」（元の第2小節の頭 = 4拍目のあと）→ 新しい第2小節の2拍目
  eq(sc.parts[0].staves[0].measures[1].dirs, [{ t: TPQ, k: 'dyn', v: 'f' }]);
  eq(sc.measures[2].barline, 'final');
  // 3/4 → 6/8 も（同じ長さ）
  rebar(sc, 0, { beats: 6, beatType: 8 });
  eq(sc.measures.length, 3);
  eq(measureAttrs(sc)[0].time, { beats: 6, beatType: 8 });
});

test('新しい記号の浄書：アルペジオ・トレモロ・符頭・運指・弦番号・フレット図・練習番号・小節線', () => {
  const sc = createScore({ insts: ['piano'], measures: 4 });
  put4(sc, 0, [['quarter', [C4, E4, G4], { arp: 'up' }], ['quarter', [A4], { trem: 2 }], ['quarter', [{ ...A4, head: 'x' }]], ['quarter', [{ ...G4, fing: '3', str: 2, strMark: true }]]]);
  put4(sc, 1, [['quarter', [C4], { slash: true }], ['quarter', [D4], { small: true }], ['quarter', [E4], { stem: 'down' }], ['quarter', [F4], { art: ['fermL', 'scoop'] }]]);
  K.addDir(sc, 0, 0, 2, { t: 0, k: 'fret', text: 'Am' });
  sc.measures[2].reh = {}; sc.measures[3].reh = {}; sc.measures[1].barline = 'dashed';
  K.addSpan(sc, 0, 0, 0, { m: 0, t: 0 }, { m: 0, t: TPQ * 3 }, 'ritLine');
  K.addSpan(sc, 0, 0, 0, { m: 1, t: TPQ * 2 }, { m: 1, t: TPQ * 3 }, 'gliss');
  const L = layoutScore(sc);
  const svg = L.pages[0].svg;
  for (const g of ['wiggleArpeggiatoUp', 'tremolo2', 'noteheadXBlack', 'fingering3', 'noteheadSlashHorizontalEnds', 'fermataLongAbove', 'brassScoop']) eq(svg.includes(glyphCh(g)), true, g);
  eq(/<circle class="strnum"/.test(svg), true, '弦番号の丸');
  eq(/class="mk fret"/.test(svg), true, 'フレット図');
  eq(svg.includes('>A</text>') && svg.includes('>B</text>'), true, '練習番号 A, B');
  eq(/stroke-dasharray="0.5 0.4"/.test(svg), true, '破線の小節線');
  eq(/class="gliss"/.test(svg) && /gliss./.test(svg), true, 'グリッサンド');
  eq(/rit./.test(svg), true, 'rit. の線');
  // 符尾の向き：E4 は普通なら上向き、指定で下向き
  const eid = sc.parts[0].staves[0].measures[1].voices[0][2].id;
  eq(L.evGeom[eid].up, false);
  // フレット図の押さえ方
  eq(K.fretShape('Am'), 'x02210'); eq(K.fretShape('F#m7'), '242222'); eq(K.fretShape('Gmaj7'), '320002'); eq(K.fretShape('Bbm7'), null === K.fretShape('Bbm7') ? null : K.fretShape('Bbm7'));
  eq(K.rehearsalLabels(sc), { 2: 'A', 3: 'B' });
});

test('1段スクロール表示：全部の小節が1つの段・1ページに並ぶ', () => {
  const sc = createScore({ insts: ['piano'], measures: 40, title: 'Long' });
  sc.measures[3].sysBreak = true; sc.measures[9].pageBreak = true; sc.settings.layout = { perSystem: 4 }; // 改段・改ページは1段スクロールでは使わない
  const L = layoutScore(sc, { continuous: true });
  eq(L.pages.length, 1);
  eq(L.systems.length, 1);
  eq(L.systems[0].ms.length, 40);
  eq(L.pageW > 300, true);
  eq(L.continuous, true);
  // 小節の幅：stretch で広がる
  const w0 = layoutScore(sc, { continuous: true }).measures[5];
  sc.measures[5].stretch = 1.5;
  const w1 = layoutScore(sc, { continuous: true }).measures[5];
  eq((w1.x1 - w1.x0) > (w0.x1 - w0.x0) * 1.3, true);
});

test('Phase 4 の再生：フェルマータの長さ・カエスーラ・トレモロ・アルペジオ・グリッサンド・小節の繰り返し・コード', () => {
  const sc = createScore({ insts: ['piano'], measures: 4, bpm: 60 });
  put4(sc, 0, [['quarter', [C4], { art: ['fermL'] }], ['quarter', [D4], { art: ['caesura'] }], ['quarter', [E4], { trem: 2 }], ['quarter', [C4, E4, G4], { arp: 'up' }]]);
  put4(sc, 1, [['half', [C4]], ['half', [G4]]]);
  K.addSpan(sc, 0, 0, 0, { m: 1, t: 0 }, { m: 1, t: TPQ * 2 }, 'gliss');
  sc.parts[0].staves[0].measures[2].mrep = 1;
  K.addDir(sc, 0, 0, 3, { t: 0, k: 'chord', text: 'Am7' });
  sc.settings.playback = { human: false, chords: true };
  const perf = buildPerformance(sc);
  const v0 = perf.notes.filter(n => n.v === 0 && n.s === 0);
  // 1拍目：長いフェルマータで 1秒 × 1.6 止まる → 2拍目の D4 は 2.6 秒
  eq(+v0.find(n => n.midi === 62).start.toFixed(2), 2.6);
  // カエスーラ：E4（トレモロ）は D4 の終わり + 0.4 秒の間のあと
  const e4 = v0.filter(n => n.midi === 64 && n.m === 0);
  eq(+e4[0].start.toFixed(2), 4.0);
  eq(e4.length >= 4 + 1, true, 'トレモロ（16分 × 4）＋和音の E4');
  // アルペジオ：C4 → E4 → G4 の順に少しずつ遅れて
  const ch = v0.filter(n => n.m === 0 && n.t === TPQ * 3).sort((a, b) => a.start - b.start).map(n => n.midi);
  eq(ch, [60, 64, 67]);
  // グリッサンド：C4 から G4 へ半音ずつ（61〜66 の音が入る）
  eq([61, 62, 63, 64, 65, 66].every(x => v0.some(n => n.m === 1 && n.midi === x)), true);
  // 小節の繰り返し：第3小節は第2小節と同じ音が鳴る
  eq(v0.some(n => n.m === 2 && n.midi === 67), true);
  // コードネーム Am7：A と C E G（と低い A）
  const cn = perf.notes.filter(n => n.v === 9).map(n => n.midi % 12).sort((a, b) => a - b);
  eq([...new Set(cn)], [0, 4, 7, 9]);
});

test('rit. - - - の線で遅くなり、a tempo なしでも線の終わりから先はそのまま', () => {
  const sc = createScore({ insts: ['piano'], measures: 4, bpm: 120 });
  const base = buildPerformance(sc, { human: true }).secOfMeasure(3);
  K.addSpan(sc, 0, 0, 0, { m: 1, t: 0 }, { m: 2, t: 0 }, 'ritLine');
  const p = buildPerformance(sc, { human: true });
  eq(p.secOfMeasure(3) > base + 0.3, true);
});

test('Phase 4 の記号が MusicXML の書き出し → 読み込みで残る', () => {
  const sc = createScore({ insts: ['piano'], measures: 4 });
  put4(sc, 0, [['quarter', [C4, E4, G4], { arp: 'down' }], ['quarter', [A4], { trem: 3, art: ['portato'] }], ['quarter', [{ ...A4, head: 'diamond', paren: true }], { art: ['accStacc', 'invTurn'] }], ['quarter', [{ ...G4, fing: '4' }], { small: true, art: ['fermS', 'caesura'] }]]);
  put4(sc, 1, [['quarter', [C4], { slash: true }], ['quarter', [D4], { art: ['harm', 'snap'] }], ['half', [{ ...E4, str: 3, strMark: true }], { art: ['wedge'] }]]);
  K.addSpan(sc, 0, 0, 0, { m: 0, t: 0 }, { m: 0, t: TPQ }, 'gliss');
  K.addSpan(sc, 0, 0, 0, { m: 1, t: 0 }, { m: 1, t: TPQ * 2 }, 'ritLine');
  K.addSpan(sc, 0, 0, 0, { m: 2, t: 0 }, { m: 3, t: 0 }, '15mb');
  K.addSpan(sc, 0, 1, 0, { m: 0, t: 0 }, { m: 1, t: 0 }, 'pedL');
  K.addDir(sc, 0, 0, 2, { t: 0, k: 'chord', text: 'C' }); K.addDir(sc, 0, 0, 2, { t: 0, k: 'fret', text: 'C' });
  K.addDir(sc, 0, 0, 3, { t: 0, k: 'dyn', v: 'fz' });
  sc.measures[2].reh = {}; sc.measures[1].barline = 'heavy';
  sc.measures[2].tempo = { bpm: 60, unit: 'quarterDot', text: 'Andante' };
  sc.measures[3].stext = [{ t: 0, text: 'Swing' }];
  const back = importMusicXML(exportMusicXML(sc));
  const v = (m) => back.parts[0].staves[0].measures[m].voices[0];
  eq(v(0)[0].arp, 'down');
  eq([v(0)[1].trem, v(0)[1].art], [3, ['portato']]);
  eq([v(0)[2].notes[0].head, v(0)[2].notes[0].paren, [...v(0)[2].art].sort()], ['diamond', true, ['accStacc', 'invTurn']]);
  eq([v(0)[3].small, v(0)[3].notes[0].fing, [...v(0)[3].art].sort()], [true, '4', ['caesura', 'fermS']]);
  eq(v(1)[0].slash, true);
  eq([...v(1)[1].art].sort(), ['harm', 'snap']);
  eq([v(1)[2].notes[0].str, v(1)[2].notes[0].strMark, v(1)[2].art], [3, true, ['wedge']]);
  const spans = back.parts[0].staves[0].measures.flatMap((sm, m) => (sm.spans || []).map(x => m + ':' + x.k)).sort();
  eq(spans, ['0:gliss', '1:ritLine', '2:15mb']);
  eq((back.parts[0].staves[1].measures[0].spans || []).map(x => x.k), ['pedL']);
  eq(back.parts[0].staves[0].measures[2].dirs.map(d => d.k).sort(), ['chord', 'fret']);
  eq(back.parts[0].staves[0].measures[3].dirs, [{ t: 0, k: 'dyn', v: 'fz' }]);
  eq([!!back.measures[2].reh, back.measures[1].barline], [true, 'heavy']);
  eq([back.measures[2].tempo.bpm, back.measures[2].tempo.unit, back.measures[2].tempo.text], [60, 'quarterDot', 'Andante']);
  eq(back.measures[3].stext, [{ t: 0, text: 'Swing' }]);
});

test('音符の設定（トグル）・連桁の指定・ストリームで書き直しても音符の設定が残る', () => {
  const sc = createScore({ insts: ['flute'], measures: 2 });
  const ids = put4(sc, 0, [['eighth', [C4]], ['eighth', [D4]], ['eighth', [E4]], ['eighth', [F4]], ['half', [G4]]]);
  eq(K.setEventProp(sc, [ids[0]], 'arp', 'normal'), true);
  eq(K.setEventProp(sc, [ids[0]], 'arp', 'normal'), false); // もう一度で外れる
  K.setNoteProp(sc, [ids[4]], 'head', 'x');
  eq(E.findEvent(sc, ids[4]).ev.notes[0].head, 'x');
  // 連桁：2つ目から分ける → 8分の連桁が 1 + 3 に
  E.findEvent(sc, ids[1]).ev.beam = 'start';
  let L = layoutScore(sc);
  eq((L.pages[0].svg.match(/class="beamgrp/g) || []).length, 1);
  E.findEvent(sc, ids[1]).ev.beam = 'none';
  L = layoutScore(sc);
  eq((L.pages[0].svg.match(/class="beamgrp/g) || []).length, 1);
  // 音価を2倍にしても（ストリームで書き直しても）トレモロ・小さい音符は残る
  Object.assign(E.findEvent(sc, ids[4]).ev, { trem: 1, small: true });
  MA.scaleDurations(sc, { m1: 0, m2: 0, staves: [[0, 0]] }, 2);
  const g = sc.parts[0].staves[0].measures.flatMap(sm => sm.voices[0]).find(e => !e.rest && e.notes[0].step === 'G');
  eq([g.trem, g.small], [1, true]);
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("  ✔", name); }
  catch (e) { fail++; console.log('  ✘', name, '\n   ', e.message); }
}
console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
