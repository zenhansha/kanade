// Bravura.json + glyphnames.json から、アプリで使うグリフだけ抜き出して js/smufl.js を作る
// 使い方: node tools/build_smufl.mjs <Bravura.json> <glyphnames.json>
import fs from 'node:fs';
const [meta, names] = process.argv.slice(2).map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
const want = `noteheadDoubleWhole noteheadWhole noteheadHalf noteheadBlack noteheadXBlack noteheadXHalf noteheadXWhole
restDoubleWhole restWhole restHalf restQuarter rest8th rest16th rest32nd rest64th rest128th
flag8thUp flag8thDown flag16thUp flag16thDown flag32ndUp flag32ndDown flag64thUp flag64thDown flag128thUp flag128thDown
gClef fClef cClef gClef8vb gClef8va fClef8vb unpitchedPercussionClef1 6stringTabClef
timeSig0 timeSig1 timeSig2 timeSig3 timeSig4 timeSig5 timeSig6 timeSig7 timeSig8 timeSig9 timeSigCommon timeSigCutCommon
accidentalFlat accidentalNatural accidentalSharp accidentalDoubleSharp accidentalDoubleFlat accidentalParensLeft accidentalParensRight
augmentationDot brace bracketTop bracketBottom
articAccentAbove articAccentBelow articStaccatoAbove articStaccatoBelow articTenutoAbove articTenutoBelow
articMarcatoAbove articMarcatoBelow articStaccatissimoAbove articStaccatissimoBelow fermataAbove fermataBelow
dynamicPiano dynamicMezzo dynamicForte dynamicRinforzando dynamicSforzando dynamicZ dynamicNiente
dynamicPPP dynamicPP dynamicMP dynamicMF dynamicFF dynamicFFF dynamicSforzato dynamicFortePiano
tuplet0 tuplet1 tuplet2 tuplet3 tuplet4 tuplet5 tuplet6 tuplet7 tuplet8 tuplet9 tupletColon
metNoteWhole metNoteHalfUp metNoteQuarterUp metNote8thUp metNote16thUp metNote32ndUp metNote64thUp metNoteDoubleWhole metAugmentationDot
repeatDot segno coda keyboardPedalPed keyboardPedalUp
graceNoteAcciaccaturaStemUp graceNoteAcciaccaturaStemDown`.split(/\s+/);
const out = { defaults: meta.engravingDefaults, glyphs: {} };
for (const n of want) {
  if (!names[n]) { console.error('missing', n); continue; }
  const cp = parseInt(names[n].codepoint.slice(2), 16);
  const g = { c: String.fromCodePoint(cp) };
  const bb = meta.glyphBBoxes[n];
  if (bb) { g.ne = bb.bBoxNE; g.sw = bb.bBoxSW; }
  const an = meta.glyphsWithAnchors[n];
  if (an) g.a = an;
  out.glyphs[n] = g;
}
const js = `// 自動生成: tools/build_smufl.mjs（Bravura / SMuFL のメタデータ。単位はすべて譜線間隔 = 1）\nexport const SMUFL = ${JSON.stringify(out)};\n`;
fs.writeFileSync(new URL('../js/smufl.js', import.meta.url), js);
console.log('glyphs:', Object.keys(out.glyphs).length, 'bytes:', js.length);
