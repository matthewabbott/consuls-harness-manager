// The browser's speech recognition (Apple's recognizer in Safari, Google's in Chrome).

/** What's used of the Web Speech API's recognizer (lib.dom has its events, not the class). */
export interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type RecognitionClass = new () => Recognition;

/** The recognizer's class, unprefixed or Safari's `webkit` one; null where there's none. */
export function recognizerClass(): { Rec: RecognitionClass; name: string } | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  if (w.SpeechRecognition) return { Rec: w.SpeechRecognition, name: "SpeechRecognition" };
  if (w.webkitSpeechRecognition) return { Rec: w.webkitSpeechRecognition, name: "webkitSpeechRecognition" };
  return null;
}

export const speechSupported = () => recognizerClass() !== null;

interface Result {
  readonly isFinal: boolean;
  readonly [alt: number]: { readonly transcript: string };
}

/**
 * `text` as it goes on after `before`: the recognizer capitalizes the start of every utterance,
 * which is wrong mid-sentence (after a pause, or dictating after typed words). "I" stays.
 */
export function continuing(before: string, text: string): string {
  const last = before.replace(/[ \t]+$/, "").slice(-1);
  if (!last || /[.?!\n]/.test(last) || /^\s*I\b/.test(text)) return text;
  return text.replace(/^(\s*)(\p{Lu})(?!\p{Lu})/u, (_, sp: string, c: string) => sp + c.toLowerCase());
}

/** Two stretches of speech as one text: a space between them, no capital mid-sentence. */
export const join = (a: string, b: string) => {
  b = continuing(a, b);
  return !a || !b || /\s$/.test(a) || /^\s/.test(b) ? a + b : `${a} ${b}`;
};

/**
 * The results so far as one text: the final segments, then the interim tail. Rebuilt from every
 * result each time (never appended to), so a repeated or revised result can't double words.
 * Segments are joined with a space where neither side has one (Safari's don't).
 */
export function transcript(results: ArrayLike<Result>): { final: string; interim: string } {
  let final = "";
  let interim = "";
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const t = r[0]?.transcript ?? "";
    if (r.isFinal) final = join(final, t);
    else interim = join(interim, t);
  }
  return { final, interim };
}

// A sentence ends here: the next word gets a capital.
const END = "\u0000";

/** Spoken punctuation, as the keyboard's dictation takes it (the recognizer leaves it as words). */
const SPOKEN: [RegExp, string][] = [
  [/\s*\bnew paragraph\b\s*/gi, `\n\n${END}`],
  [/\s*\bnew line\b\s*/gi, `\n${END}`],
  [/\s*\b(?:period|full stop)\b/gi, `.${END}`],
  [/\s*\bquestion mark\b/gi, `?${END}`],
  [/\s*\bexclamation (?:point|mark)\b/gi, `!${END}`],
  [/\s*\bcomma\b/gi, ","],
  [/\s*\bsemicolon\b/gi, ";"],
  [/\s*\bcolon\b/gi, ":"],
];

export function spoken(text: string): string {
  for (const [re, to] of SPOKEN) text = text.replace(re, to);
  return text.replace(new RegExp(`${END}(\\s*)(\\p{Ll})`, "gu"), (_, sp: string, c: string) => sp + c.toUpperCase()).replaceAll(END, "");
}

/**
 * Where Safari carried on after a pause without a space ("…thereHow are…"): it appends the next
 * utterance to what it had. A spot where the text so far grew by a word with a capital, right
 * against its last letter, is taken for one; it gets a space (and no capital mid-sentence) for as
 * long as the text before it stays the same.
 */
export class Resumes {
  private prev = "";
  private at: string[] = [];

  /** Every transcript (`transcript`'s final and interim, joined), in order. */
  note(raw: string) {
    const p = this.prev;
    if (p && raw.length > p.length && raw.startsWith(p) && /\S$/.test(p) && /^\p{Lu}/u.test(raw.slice(p.length))) this.at.push(p);
    this.prev = raw;
  }

  apply(text: string): string {
    for (const before of [...this.at].sort((a, b) => b.length - a.length)) {
      if (text.length > before.length && text.startsWith(before)) text = join(before, text.slice(before.length));
    }
    return text;
  }
}

/** What's been heard, punctuated, and how much of it is final (the rest may still change). */
export function heard(results: ArrayLike<Result>, resumes?: Resumes): { text: string; finalLength: number } {
  const { final, interim } = transcript(results);
  const fix = (t: string) => resumes?.apply(t) ?? t;
  const text = spoken(fix(join(final, interim)));
  const done = spoken(fix(final));
  let n = 0;
  while (n < done.length && done[n] === text[n]) n++;
  return { text, finalLength: n };
}

export interface Dictation {
  /** Stops recording; the last words still arrive, then `onEnd`. */
  stop(): void;
  /** Stops at once: nothing more arrives, `onStopped` and `onEnd` included. */
  abort(): void;
}

/** What a dictation reports, on the server or in Safari. */
export interface DictationEvents {
  /** The whole text heard so far, and how much of it is final (the rest may still change). */
  onText(text: string, finalLength: number): void;
  /** Recording has stopped (by `stop`, or by itself); `onEnd` follows once the last words are in. */
  onStopped(): void;
  onEnd(): void;
  onError(message: string): void;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Dictation isn't allowed: check the microphone in Settings → Apps → Safari, and Speech Recognition under Privacy & Security.",
  "service-not-allowed": "Speech recognition isn't available here (turning on Dictation in Settings → General → Keyboard may help).",
  network: "Dictation needs a network connection.",
  "audio-capture": "No microphone was available (is another app using it?).",
  "language-not-supported": `Speech recognition doesn't support ${navigator.language}.`,
};

/**
 * Listens with the browser's recognizer until stopped (or it gives up), reporting the whole text
 * heard so far on every change. Throws if the recognizer can't start; null where there's none.
 */
export function dictate(o: DictationEvents): Dictation | null {
  const found = recognizerClass();
  if (!found) return null;
  const r = new found.Rec();
  r.lang = navigator.language;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  let over = false;
  const resumes = new Resumes();
  r.onresult = (e) => {
    if (over) return;
    const { final, interim } = transcript(e.results);
    resumes.note(join(final, interim));
    const { text, finalLength } = heard(e.results, resumes);
    o.onText(text, finalLength);
  };
  r.onerror = (e) => {
    if (!over && e.error !== "no-speech" && e.error !== "aborted") o.onError(ERRORS[e.error] ?? `Dictation stopped: ${e.error}.`);
  };
  r.onend = () => {
    if (over) return;
    over = true;
    o.onStopped();
    o.onEnd();
  };
  r.start();
  return {
    stop: () => r.stop(),
    abort: () => {
      over = true;
      r.abort();
    },
  };
}
