// MIDI キーボード入力（Web MIDI API）
// ・PC の Chrome / Edge はそのまま使える
// ・iPad の Safari は Web MIDI 非対応。App Store の「Web MIDI Browser」などの
//   Web MIDI 対応ブラウザでこのアプリを開くと使える
export class MidiInput {
  constructor({ onNoteOn, onNoteOff, onStatus }) {
    this.onNoteOn = onNoteOn; this.onNoteOff = onNoteOff; this.onStatus = onStatus;
    this.access = null;
    this.held = new Set();
    this.devices = [];
    this.outputs = [];
    this.out = null; // 再生を外部の MIDI 音源（DAW・電子ピアノ）へ送るときの出力
  }
  get supported() { return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess; }

  async connect() {
    if (!this.supported) { this.onStatus({ ok: false, reason: 'unsupported' }); return false; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.onStatus({ ok: false, reason: 'denied', error: e });
      return false;
    }
    const bind = () => {
      this.devices = [];
      for (const input of this.access.inputs.values()) {
        input.onmidimessage = (e) => this.handle(e.data, e.timeStamp);
        this.devices.push(input.name);
      }
      this.outputs = [...this.access.outputs.values()];
      if (this.out && !this.outputs.includes(this.out)) this.out = null;
      this.onStatus({ ok: true, devices: this.devices, outputs: this.outputs.map(o => o.name) });
    };
    this.access.onstatechange = bind;
    bind();
    return true;
  }

  // stamp = 鍵盤を押した時刻（performance.now() と同じ時計）。リアルタイム入力のタイミング合わせに使う
  handle(data, stamp = performance.now()) {
    const [st, d1, d2] = data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) {
      const chord = this.held.size > 0; // ほかの鍵盤を押したまま → 和音として追加
      this.held.add(d1);
      this.onNoteOn(d1, d2, chord, stamp);
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      this.held.delete(d1);
      if (this.onNoteOff) this.onNoteOff(d1, stamp);
    }
  }

  // 外部 MIDI 音源へ送る（name = 出力の名前、null で内蔵音源に戻す）
  setOutput(name) { this.out = this.outputs.find(o => o.name === name) || null; }
  send(bytes, when) { if (this.out) try { this.out.send(bytes, when); } catch (e) { /* 外れた */ } }
  allOff() { if (this.out) for (let c = 0; c < 16; c++) this.send([0xb0 | c, 123, 0]); }
}
