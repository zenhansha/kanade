// 元に戻す / やり直し
// 操作の直前に楽譜全体を JSON 文字列で丸ごと保存する「スナップショット方式」。
// 楽譜データは数百KB程度なので、200回ぶん持っても iPad で問題ない。
export class History {
  constructor(limit = 200) { this.limit = limit; this.undoStack = []; this.redoStack = []; }
  // state = { score, caret } を受け取り、文字列にして積む
  push(state, label = '') {
    this.undoStack.push({ json: JSON.stringify(state), label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo(current) {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ json: JSON.stringify(current), label: e.label });
    return { ...JSON.parse(e.json), label: e.label };
  }
  redo(current) {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ json: JSON.stringify(current), label: e.label });
    return { ...JSON.parse(e.json), label: e.label };
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
