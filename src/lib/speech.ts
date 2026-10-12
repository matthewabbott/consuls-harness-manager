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
