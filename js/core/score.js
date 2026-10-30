// 楽譜データの形（モデル）と、楽器・テンプレートの定義
//
// Score（楽譜全体）
//   meta      … タイトル・作曲者など
//   measures  … 全パート共通の小節情報（拍子・調・テンポ・小節線）。変化がある小節だけ値を持つ
//   parts     … パート（楽器）。ピアノのように譜表が2段あるパートもある
//     staves  … 譜表。staves[i].measures[m] がその小節の中身
//       voices… 声部（Finale でいうレイヤー）1〜4。各声部はイベント（音符/休符）の並び
//
// イベント { id, rest, type, dots, notes:[{step,alter,octave,tie}], tuplet:{id,actual,normal} }
//   声部1 は常に小節をぴったり埋める（空きは休符）。声部2〜4 は使うときだけ作る。
import { measureTicks, evTicks as baseEvTicks, CLEFS } from './music.js';

let idSeq = 0;
export function newId() { return 'e' + Date.now().toString(36).slice(-4) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 5); }

export function evTicks(ev) { return ev.mr ? ev.mrTicks : baseEvTicks(ev); }

export function measureRest(len) { return { id: newId(), rest: true, type: 'whole', dots: 0, notes: [], mr: true, mrTicks: len }; }

// ───────── 楽器 ─────────
// clefs: 譜表ごとの音部記号 / program: GM 音色番号 / sf: 高音質音源の名前 / oct: 記譜より何半音ずれて鳴るか
// trans: 移調楽器の情報（Phase 2 の移調表示で使う。今は保存と MusicXML 書き出しのみ）
export const INSTRUMENTS = [
  { id: 'piano', ja: 'ピアノ', abbr: 'Pno.', fam: '鍵盤', clefs: ['treble', 'bass'], program: 0, sf: 'acoustic_grand_piano' },
  { id: 'epiano', ja: 'エレクトリック・ピアノ', abbr: 'E.Pno.', fam: '鍵盤', clefs: ['treble', 'bass'], program: 4, sf: 'electric_piano_1' },
  { id: 'organ', ja: 'オルガン', abbr: 'Org.', fam: '鍵盤', clefs: ['treble', 'bass'], program: 19, sf: 'church_organ' },
  { id: 'harpsichord', ja: 'チェンバロ', abbr: 'Hpd.', fam: '鍵盤', clefs: ['treble', 'bass'], program: 6, sf: 'harpsichord' },
  { id: 'violin', ja: 'ヴァイオリン', abbr: 'Vn.', fam: '弦楽器', clefs: ['treble'], program: 40, sf: 'violin' },
  { id: 'viola', ja: 'ヴィオラ', abbr: 'Va.', fam: '弦楽器', clefs: ['alto'], program: 41, sf: 'viola' },
  { id: 'cello', ja: 'チェロ', abbr: 'Vc.', fam: '弦楽器', clefs: ['bass'], program: 42, sf: 'cello' },
  { id: 'contrabass', ja: 'コントラバス', abbr: 'Cb.', fam: '弦楽器', clefs: ['bass'], program: 43, sf: 'contrabass', oct: -12, trans: { diatonic: -7, chromatic: -12 } },
  { id: 'harp', ja: 'ハープ', abbr: 'Hp.', fam: '弦楽器', clefs: ['treble', 'bass'], program: 46, sf: 'orchestral_harp' },
  { id: 'guitar', ja: 'ギター', abbr: 'Gtr.', fam: '弦楽器', clefs: ['treble8vb'], program: 24, sf: 'acoustic_guitar_nylon' },
  { id: 'bassguitar', ja: 'エレキベース', abbr: 'Bass', fam: '弦楽器', clefs: ['bass8vb'], program: 33, sf: 'electric_bass_finger' },
  { id: 'piccolo', ja: 'ピッコロ', abbr: 'Picc.', fam: '木管', clefs: ['treble'], program: 72, sf: 'piccolo', oct: 12, trans: { diatonic: 7, chromatic: 12 } },
  { id: 'flute', ja: 'フルート', abbr: 'Fl.', fam: '木管', clefs: ['treble'], program: 73, sf: 'flute' },
  { id: 'oboe', ja: 'オーボエ', abbr: 'Ob.', fam: '木管', clefs: ['treble'], program: 68, sf: 'oboe' },
  { id: 'clarinet', ja: 'クラリネット（B♭）', abbr: 'Cl.', fam: '木管', clefs: ['treble'], program: 71, sf: 'clarinet', trans: { diatonic: -1, chromatic: -2 } },
  { id: 'bassclarinet', ja: 'バス・クラリネット', abbr: 'B.Cl.', fam: '木管', clefs: ['treble'], program: 71, sf: 'clarinet', trans: { diatonic: -8, chromatic: -14 } },
  { id: 'bassoon', ja: 'ファゴット', abbr: 'Bsn.', fam: '木管', clefs: ['bass'], program: 70, sf: 'bassoon' },
  { id: 'recorder', ja: 'リコーダー', abbr: 'Rec.', fam: '木管', clefs: ['treble'], program: 74, sf: 'recorder', oct: 12, trans: { diatonic: 7, chromatic: 12 } },
  { id: 'sopsax', ja: 'ソプラノ・サックス', abbr: 'S.Sax.', fam: '木管', clefs: ['treble'], program: 64, sf: 'soprano_sax', trans: { diatonic: -1, chromatic: -2 } },
  { id: 'altosax', ja: 'アルト・サックス', abbr: 'A.Sax.', fam: '木管', clefs: ['treble'], program: 65, sf: 'alto_sax', trans: { diatonic: -5, chromatic: -9 } },
  { id: 'tenorsax', ja: 'テナー・サックス', abbr: 'T.Sax.', fam: '木管', clefs: ['treble'], program: 66, sf: 'tenor_sax', trans: { diatonic: -8, chromatic: -14 } },
  { id: 'barisax', ja: 'バリトン・サックス', abbr: 'B.Sax.', fam: '木管', clefs: ['treble'], program: 67, sf: 'baritone_sax', trans: { diatonic: -12, chromatic: -21 } },
  { id: 'trumpet', ja: 'トランペット（B♭）', abbr: 'Tp.', fam: '金管', clefs: ['treble'], program: 56, sf: 'trumpet', trans: { diatonic: -1, chromatic: -2 } },
  { id: 'horn', ja: 'ホルン（F）', abbr: 'Hn.', fam: '金管', clefs: ['treble'], program: 60, sf: 'french_horn', trans: { diatonic: -4, chromatic: -7 } },
  { id: 'trombone', ja: 'トロンボーン', abbr: 'Tbn.', fam: '金管', clefs: ['bass'], program: 57, sf: 'trombone' },
  { id: 'euphonium', ja: 'ユーフォニアム', abbr: 'Euph.', fam: '金管', clefs: ['bass'], program: 58, sf: 'tuba' },
  { id: 'tuba', ja: 'テューバ', abbr: 'Tba.', fam: '金管', clefs: ['bass'], program: 58, sf: 'tuba' },
  { id: 'soprano', ja: 'ソプラノ', abbr: 'S.', fam: '声楽', clefs: ['treble'], program: 52, sf: 'choir_aahs' },
  { id: 'alto', ja: 'アルト', abbr: 'A.', fam: '声楽', clefs: ['treble'], program: 52, sf: 'choir_aahs' },
  { id: 'tenor', ja: 'テノール', abbr: 'T.', fam: '声楽', clefs: ['treble8vb'], program: 52, sf: 'choir_aahs' },
  { id: 'bass', ja: 'バス', abbr: 'B.', fam: '声楽', clefs: ['bass'], program: 52, sf: 'choir_aahs' },
  { id: 'voice', ja: '独唱', abbr: 'Vo.', fam: '声楽', clefs: ['treble'], program: 53, sf: 'voice_oohs' },
  { id: 'timpani', ja: 'ティンパニ', abbr: 'Timp.', fam: '打楽器', clefs: ['bass'], program: 47, sf: 'timpani' },
  { id: 'marimba', ja: 'マリンバ', abbr: 'Mar.', fam: '打楽器', clefs: ['treble', 'bass'], program: 12, sf: 'marimba' },
  { id: 'xylophone', ja: 'シロフォン', abbr: 'Xyl.', fam: '打楽器', clefs: ['treble'], program: 13, sf: 'xylophone', oct: 12, trans: { diatonic: 7, chromatic: 12 } },
  { id: 'vibraphone', ja: 'ヴィブラフォン', abbr: 'Vib.', fam: '打楽器', clefs: ['treble'], program: 11, sf: 'vibraphone' },
  { id: 'glockenspiel', ja: 'グロッケンシュピール', abbr: 'Glk.', fam: '打楽器', clefs: ['treble'], program: 9, sf: 'glockenspiel', oct: 24, trans: { diatonic: 14, chromatic: 24 } },
];
export const INST = Object.fromEntries(INSTRUMENTS.map(i => [i.id, i]));

export const TEMPLATES = [
  { id: 'piano', ja: 'ピアノ', insts: ['piano'] },
  { id: 'lead', ja: 'メロディ譜（1段）', insts: ['voice'] },
  { id: 'voicepiano', ja: '歌＋ピアノ伴奏', insts: ['voice', 'piano'] },
  { id: 'satb', ja: '混声四部合唱＋ピアノ', insts: ['soprano', 'alto', 'tenor', 'bass', 'piano'] },
  { id: 'quartet', ja: '弦楽四重奏', insts: ['violin', 'violin', 'viola', 'cello'] },
  { id: 'woodwind5', ja: '木管五重奏', insts: ['flute', 'oboe', 'clarinet', 'horn', 'bassoon'] },
  { id: 'band', ja: 'バンド（Gt/Ba/Pno）', insts: ['voice', 'guitar', 'bassguitar', 'piano'] },
];

// ───────── 楽譜を作る ─────────
export function createPart(instId, nameSuffix = '') {
  const inst = INST[instId] || INST.piano;
  return {
    id: newId(),
    inst: inst.id,
    name: inst.ja + nameSuffix,
    abbr: inst.abbr + nameSuffix,
    program: inst.program,
    staves: inst.clefs.map(c => ({ clef: c, measures: [] })),
  };
}

export function createScore(opt = {}) {
  const time = opt.time || { beats: 4, beatType: 4 };
  const score = {
    app: 'kanade', version: 1,
    meta: { title: opt.title ?? '無題', subtitle: opt.subtitle || '', composer: opt.composer || '', lyricist: opt.lyricist || '', arranger: '', copyright: '' },
    settings: { staffMm: 7, page: { w: 210, h: 297 }, margin: { t: 14, b: 14, l: 16, r: 14 } },
    measures: [],
    parts: [],
  };
  // 同じ楽器が複数あるときは「1」「2」と番号をつける
  const ids = opt.insts || ['piano'];
  const count = {};
  ids.forEach(id => (count[id] = (count[id] || 0) + 1));
  const seen = {};
  for (const id of ids) {
    seen[id] = (seen[id] || 0) + 1;
    score.parts.push(createPart(id, count[id] > 1 ? ' ' + seen[id] : ''));
  }
  const n = Math.max(1, opt.measures || 16);
  for (let i = 0; i < n; i++) {
    const m = {};
    if (i === 0) { m.time = { ...time }; m.key = { fifths: opt.fifths || 0 }; m.tempo = { bpm: opt.bpm || 100 }; }
    score.measures.push(m);
  }
  if (opt.pickup) score.measures[0].pickup = opt.pickup; // 弱起（アウフタクト）の長さ（ティック）
  score.measures[n - 1].barline = 'final';
  fillMeasures(score);
  return score;
}

// 全ての譜表の小節数を score.measures にそろえ、空の小節は全休符で埋める
export function fillMeasures(score) {
  const attrs = measureAttrs(score);
  for (const part of score.parts) for (const st of part.staves) {
    st.measures.length = score.measures.length;
    for (let i = 0; i < score.measures.length; i++) {
      if (!st.measures[i]) st.measures[i] = { voices: [[measureRest(attrs[i].len)]] };
      const v0 = st.measures[i].voices[0];
      if (!v0 || v0.length === 0) st.measures[i].voices[0] = [measureRest(attrs[i].len)];
    }
  }
}

// 各小節の「その時点で有効な」拍子・調・テンポなどを計算する
export function measureAttrs(score) {
  const out = [];
  let time = { beats: 4, beatType: 4 }, key = { fifths: 0 }, bpm = 100, start = 0;
  score.measures.forEach((m, i) => {
    const timeChanged = !!m.time, keyChanged = !!m.key;
    const prevKey = key.fifths;
    if (m.time) time = m.time;
    if (m.key) key = m.key;
    if (m.tempo) bpm = m.tempo.bpm;
    const full = measureTicks(time);
    const len = m.pickup ? Math.min(m.pickup, full) : full;
    out.push({ index: i, time, fifths: key.fifths, prevFifths: prevKey, bpm, len, full, start, timeChanged: timeChanged || i === 0, keyChanged: keyChanged || i === 0, tempo: m.tempo || null, m });
    start += len;
  });
  return out;
}

// その譜表・小節で有効な音部記号
export function clefAt(staff, mi) {
  for (let i = mi; i >= 0; i--) if (staff.measures[i] && staff.measures[i].clef) return staff.measures[i].clef;
  return staff.clef;
}
export function clefInfo(key) { return CLEFS[key] || CLEFS.treble; }

// 楽譜の全譜表を平らな一覧に（レイアウトや入力で使う）
export function staffList(score) {
  const list = [];
  score.parts.forEach((part, p) => part.staves.forEach((st, s) => list.push({ p, s, part, staff: st })));
  return list;
}

export function cloneScore(score) { return JSON.parse(JSON.stringify(score)); }
