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
        input.onmidimessage = (e) => this.handle(e.data);
        this.devices.push(input.name);
      }
      this.onStatus({ ok: true, devices: this.devices });
    };
    this.access.onstatechange = bind;
    bind();
    return true;
  }

  handle(data) {
    const [st, d1, d2] = data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) {
      const chord = this.held.size > 0; // ほかの鍵盤を押したまま → 和音として追加
      this.held.add(d1);
      this.onNoteOn(d1, d2, chord);
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      this.held.delete(d1);
      if (this.onNoteOff) this.onNoteOff(d1);
    }
  }
}
