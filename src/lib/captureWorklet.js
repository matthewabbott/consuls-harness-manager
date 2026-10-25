// The microphone's samples, in blocks, to the page (src/lib/recorder.ts). Plain JS: it's loaded
// as is by the audio worklet, from the app's own origin (the page's CSP allows only that).
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.block[this.n++] = ch[i];
        if (this.n === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("consuls-capture", Capture);
