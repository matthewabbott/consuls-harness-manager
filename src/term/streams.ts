// Raw output for expanded panes. A RESET frame (`cols u16, rows u16, bytes`) rebuilds the
// terminal from scratch (full history); RAW frames follow. Frames that arrive before the
// terminal attaches are buffered.

export interface StreamSink {
  reset(cols: number, rows: number, bytes: Uint8Array): void;
  raw(bytes: Uint8Array): void;
}

type Pending = { kind: "reset"; cols: number; rows: number; bytes: Uint8Array } | { kind: "raw"; bytes: Uint8Array };

const sinks = new Map<number, StreamSink>();
const pending = new Map<number, Pending[]>();

function deliver(sink: StreamSink, p: Pending) {
  if (p.kind === "reset") sink.reset(p.cols, p.rows, p.bytes);
  else sink.raw(p.bytes);
}

function push(key: number, p: Pending) {
  const sink = sinks.get(key);
  if (sink) return deliver(sink, p);
  const list = pending.get(key) ?? [];
  if (p.kind === "reset") list.length = 0; // a reset supersedes everything before it
  list.push({ ...p, bytes: p.bytes.slice() });
  pending.set(key, list.slice(-2000));
}

export function streamReset(key: number, payload: Uint8Array) {
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  push(key, { kind: "reset", cols: v.getUint16(0, true), rows: v.getUint16(2, true), bytes: payload.subarray(4) });
}

export function streamRaw(key: number, payload: Uint8Array) {
  push(key, { kind: "raw", bytes: payload });
}

export function attachStream(key: number, sink: StreamSink): () => void {
  sinks.set(key, sink);
  const queued = pending.get(key);
  pending.delete(key);
  queued?.forEach((p) => deliver(sink, p));
  return () => {
    if (sinks.get(key) === sink) sinks.delete(key);
  };
}
