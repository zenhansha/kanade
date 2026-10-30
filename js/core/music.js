// 音楽の基本単位：音価（ティック）と音高（ピッチ）
//
// ■ ティック
//   音の長さは整数の「ティック」で扱う。4分音符 = 6720 ティック。
//   6720 = 2^6 × 3 × 5 × 7 なので、3連符・5連符・7連符も、128分音符まで割り切れる。
//   小数（0.333…）を使うと誤差が積み重なって小節がピッタリ埋まらなくなるので、整数にしている。
//
// ■ ピッチ
//   「C#4」と「D♭4」は鳴る音は同じでも楽譜上は別物。なので MIDI 番号ではなく
//   { step: 'C'..'B', alter: -2..2, octave } の「綴り」で持つ（MusicXML と同じ考え方）。

export const TPQ = 6720;                     // 4分音符のティック数
export const TYPES = ['breve', 'whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th', '128th'];
export const TYPE_TICKS = {
  breve: TPQ * 8, whole: TPQ * 4, half: TPQ * 2, quarter: TPQ,
  eighth: TPQ / 2, '16th': TPQ / 4, '32nd': TPQ / 8, '64th': TPQ / 16, '128th': TPQ / 32,
};
// 旗・連桁の本数（8分=1, 16分=2 …）
export const TYPE_FLAGS = { breve: 0, whole: 0, half: 0, quarter: 0, eighth: 1, '16th': 2, '32nd': 3, '64th': 4, '128th': 5 };
export const TYPE_JA = { breve: '倍全音符', whole: '全音符', half: '2分音符', quarter: '4分音符', eighth: '8分音符', '16th': '16分音符', '32nd': '32分音符', '64th': '64分音符', '128th': '128分音符' };

// 付点込みの長さ（付点1つで1.5倍、2つで1.75倍）
export function dottedTicks(type, dots = 0) {
  const base = TYPE_TICKS[type];
  let t = base, add = base;
  for (let i = 0; i < dots; i++) { add /= 2; t += add; }
  return t;
}

// イベント（音符/休符）の実際の長さ。連符なら normal/actual 倍（3連符なら 2/3）
export function evTicks(ev) {
  const t = dottedTicks(ev.type, ev.dots);
  return ev.tuplet ? (t * ev.tuplet.normal) / ev.tuplet.actual : t;
}

// ティック数 → { type, dots }（ちょうど表せる場合のみ）
export function ticksToType(ticks, allowDots = 2) {
  for (const type of TYPES) {
    for (let d = 0; d <= allowDots; d++) if (dottedTicks(type, d) === ticks) return { type, dots: d };
  }
  return null;
}

// 拍子 → 1小節のティック数
export function measureTicks(time) {
  return (TPQ * 4 * time.beats) / time.beatType;
}

// 複合拍子（6/8, 9/8, 12/8 …）か
export function isCompound(time) {
  return time.beatType >= 8 && time.beats % 3 === 0 && time.beats > 3;
}

// 拍の単位（連桁のまとまり・休符の分け方に使う）
export function beatTicks(time) {
  const unit = (TPQ * 4) / time.beatType;
  if (isCompound(time)) return unit * 3;
  if (time.beatType >= 8 && time.beats <= 3) return unit * time.beats; // 3/8 などは1小節で1拍
  return unit;
}

// 空いている区間 [from, to) を、拍の頭にそろった音価で埋める（休符やタイで分割するとき用）
//   例：4/4 の 1拍目途中〜小節末 → 8分 + 4分 + 2分 のように「読みやすい」分け方にする
export function splitSpan(from, to, time, offset = 0) {
  const out = [];
  const allowDots = isCompound(time) ? 1 : 0;
  const cands = [];
  for (const type of TYPES) for (let d = 0; d <= allowDots; d++) cands.push({ type, dots: d, t: dottedTicks(type, d) });
  cands.sort((a, b) => b.t - a.t);
  let x = from;
  let guard = 0;
  while (x < to && guard++ < 256) {
    const rel = x + offset;
    let pick = null;
    for (const c of cands) {
      if (x + c.t > to) continue;
      // 位置がその音価の倍数（=拍の頭）にそろっているものだけ使う
      if (rel % c.t !== 0 && c.t > TYPE_TICKS['128th']) continue;
      pick = c; break;
    }
    if (!pick) { // 端数（連符の残りなど）：入る最大のもの
      pick = cands.find(c => x + c.t <= to) || cands[cands.length - 1];
    }
    out.push({ type: pick.type, dots: pick.dots, start: x, ticks: pick.t });
    x += pick.t;
  }
  return out;
}

// ───────── ピッチ ─────────
export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const STEP_JA = { C: 'ド', D: 'レ', E: 'ミ', F: 'ファ', G: 'ソ', A: 'ラ', B: 'シ' };

export function midiOf(p) { return 12 * (p.octave + 1) + STEP_SEMI[p.step] + (p.alter || 0); }
// 全音階番号（C0 = 0, D0 = 1 … C4 = 28）。五線上の上下位置の計算に使う
export function diatonic(p) { return p.octave * 7 + STEPS.indexOf(p.step); }
export function fromDiatonic(dn, alter = 0) {
  const octave = Math.floor(dn / 7);
  return { step: STEPS[((dn % 7) + 7) % 7], alter, octave };
}

// 調号（fifths: -7..7）で、その音名に付く変化記号
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
export function keyAlter(fifths, step) {
  if (fifths > 0) return SHARP_ORDER.indexOf(step) < fifths ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.indexOf(step) < -fifths ? -1 : 0;
  return 0;
}
export function keyOrder(fifths) { return fifths >= 0 ? SHARP_ORDER.slice(0, fifths) : FLAT_ORDER.slice(0, -fifths); }

// MIDI 番号 → 綴り（調に合わせて ♯系/♭系を選ぶ）
const SHARP_NAMES = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLAT_NAMES = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
const C_NAMES = [['C', 0], ['C', 1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['B', -1], ['B', 0]];
export function spellMidi(midi, fifths = 0) {
  const pc = ((midi % 12) + 12) % 12;
  // まず調号どおりの音名で書けるか試す（例：ヘ長調の B♭、ニ長調の F#）
  for (const step of STEPS) {
    const alter = keyAlter(fifths, step);
    if ((STEP_SEMI[step] + alter + 12) % 12 === pc) return fixOctave(step, alter, midi);
  }
  const table = fifths > 0 ? SHARP_NAMES : fifths < 0 ? FLAT_NAMES : C_NAMES;
  const [step, alter] = table[pc];
  return fixOctave(step, alter, midi);
}
function fixOctave(step, alter, midi) {
  // B# や C♭ はオクターブ番号がずれるので、midi から逆算して合わせる
  const base = STEP_SEMI[step] + alter;
  const octave = Math.round((midi - base) / 12) - 1;
  return { step, alter, octave };
}

// 半音上げ下げ（綴りは「上げるなら♯、下げるなら♭」寄りに）
export function transposeSemis(p, semis, fifths = 0) {
  const m = midiOf(p) + semis;
  if (semis === 0) return { ...p };
  // 同じ音名のまま変化記号を変えられるならそうする（G → G# など）
  const na = (p.alter || 0) + semis;
  if (Math.abs(semis) === 1 && Math.abs(na) <= 1) return { step: p.step, alter: na, octave: p.octave };
  return spellMidi(m, semis > 0 ? Math.max(fifths, 1) : Math.min(fifths, -1));
}

export function pitchName(p) {
  const acc = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' }[p.alter || 0];
  return `${p.step}${acc}${p.octave}`;
}

// 調の名前（日本語）
const MAJOR_JA = { '-7': '変ハ長調', '-6': '変ト長調', '-5': '変ニ長調', '-4': '変イ長調', '-3': '変ホ長調', '-2': '変ロ長調', '-1': 'ヘ長調', 0: 'ハ長調', 1: 'ト長調', 2: 'ニ長調', 3: 'イ長調', 4: 'ホ長調', 5: 'ロ長調', 6: '嬰ヘ長調', 7: '嬰ハ長調' };
const MINOR_JA = { '-7': '変イ短調', '-6': '変ホ短調', '-5': '変ロ短調', '-4': 'ヘ短調', '-3': 'ハ短調', '-2': 'ト短調', '-1': 'ニ短調', 0: 'イ短調', 1: 'ホ短調', 2: 'ロ短調', 3: '嬰ヘ短調', 4: '嬰ハ短調', 5: '嬰ト短調', 6: '嬰ニ短調', 7: '嬰イ短調' };
export function keyNameJa(fifths) { return `${MAJOR_JA[fifths]} / ${MINOR_JA[fifths]}`; }

// 音部記号ごとの「第3線（真ん中の線）」の全音階番号
export const CLEFS = {
  treble: { sign: 'G', line: 2, oct: 0, mid: 34, glyph: 'gClef', glyphPos: -2, ja: 'ト音記号' },
  treble8vb: { sign: 'G', line: 2, oct: -1, mid: 27, glyph: 'gClef8vb', glyphPos: -2, ja: 'ト音記号（8vb）' },
  treble8va: { sign: 'G', line: 2, oct: 1, mid: 41, glyph: 'gClef8va', glyphPos: -2, ja: 'ト音記号（8va）' },
  bass: { sign: 'F', line: 4, oct: 0, mid: 22, glyph: 'fClef', glyphPos: 2, ja: 'ヘ音記号' },
  bass8vb: { sign: 'F', line: 4, oct: -1, mid: 15, glyph: 'fClef8vb', glyphPos: 2, ja: 'ヘ音記号（8vb）' },
  alto: { sign: 'C', line: 3, oct: 0, mid: 28, glyph: 'cClef', glyphPos: 0, ja: 'ハ音記号（アルト）' },
  tenor: { sign: 'C', line: 4, oct: 0, mid: 26, glyph: 'cClef', glyphPos: 2, ja: 'ハ音記号（テノール）' },
  percussion: { sign: 'percussion', line: 3, oct: 0, mid: 34, glyph: 'unpitchedPercussionClef1', glyphPos: 0, ja: '打楽器記号' },
};
export function clefKeyFromXml(sign, line, oct = 0) {
  for (const [k, c] of Object.entries(CLEFS)) if (c.sign === sign && (c.line === line || sign === 'percussion') && c.oct === oct) return k;
  if (sign === 'G') return 'treble';
  if (sign === 'F') return 'bass';
  if (sign === 'C') return line === 4 ? 'tenor' : 'alto';
  return 'treble';
}
