// A file opened on the phone: text with highlighting (read only, at a line when a tapped path
// named one), an image, or what it is, with a way to download it.

import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { Download, Loader2, TextWrap, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { editorTheme, highlight } from "../editor/theme";
import { backend } from "../ipc/backend";
import type { FileContent } from "../ipc/bindings/FileContent";
import { baseName } from "../lib/paths";
import { fmtSize } from "../lib/sizes";
import { download } from "./files";
import TransfersPanel from "./TransfersPanel";

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|heic|avif)$/i;
const IMAGE_TYPES: Record<string, string> = { svg: "image/svg+xml", jpg: "image/jpeg", ico: "image/x-icon" };

const phoneTheme = EditorView.theme({ "&": { fontSize: "12.5px" }, ".cm-content": { padding: "6px 0" } }, { dark: true });

function CodeView({ text, name, line, wrap }: { text: string; name: string; line?: number; wrap: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          syntaxHighlighting(highlight, { fallback: true }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          wrap ? EditorView.lineWrapping : [],
          line ? [highlightActiveLine(), highlightActiveLineGutter()] : [],
          language.of([]),
          editorTheme,
          phoneTheme,
        ],
      }),
    });
    const lang = LanguageDescription.matchFilename(languages, name);
    if (lang) void lang.load().then((support) => view.dispatch({ effects: language.reconfigure(support) }));
    if (line) {
      const at = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    }
    return () => view.destroy();
  }, [text, name, line, wrap]);
  return <div ref={host} className="selectable h-full" />;
}

export default function FileViewer({ host, path, size, line, onClose }: { host: string; path: string; size?: number; line?: number; onClose(): void }) {
  const name = baseName(path);
  const image = IMAGE.test(name);
  const [content, setContent] = useState<FileContent | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(true);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      const b = await backend();
      try {
        if (image) {
          const bytes = await b.readBytes(host, path);
          if (cancelled) return;
          const ext = name.split(".").pop()!.toLowerCase();
          url = URL.createObjectURL(new Blob([bytes], { type: IMAGE_TYPES[ext] ?? `image/${ext}` }));
          setImageUrl(url);
        } else {
          const c = await b.readFile(host, path);
          if (!cancelled) setContent(c);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [host, path, image, name]);

  const known = size ?? (content ? Number(content.stamp.size) : undefined);
  const loading = !error && !content && !imageUrl;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-900">
      <header className="safe-top flex shrink-0 items-center gap-1 border-b border-ink-700/80 px-1.5 pb-2">
        <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-ember-400 active:bg-ink-700">
          <X className="h-6 w-6" />
        </button>
        <div className="ml-1 min-w-0 flex-1">
          <div className="personal truncate text-[16px] font-semibold text-mist-100">{name}</div>
          {known !== undefined && <div className="text-[12px] text-mist-500">{fmtSize(known)}</div>}
        </div>
        {content?.kind === "text" && (
          <button
            onClick={() => setWrap(!wrap)}
            aria-pressed={wrap}
            aria-label="Wrap long lines"
            className={`rounded-full p-2 active:bg-ink-700 ${wrap ? "text-sky-300" : "text-mist-400"}`}
          >
            <TextWrap className="h-5 w-5" />
          </button>
        )}
        <button onClick={() => void download(host, path, known ?? 0)} aria-label="Download" className="rounded-full p-2 text-mist-300 active:bg-ink-700">
          <Download className="h-5 w-5" />
        </button>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <p className="flex items-center gap-2 p-4 text-[14px] text-mist-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Opening…
          </p>
        )}
        {error && <p className="p-4 text-[14px] text-rose-400">{error}</p>}
        {imageUrl && (
          <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(#1a1f2b_0_25%,#141822_0_50%)] bg-[length:20px_20px] p-2">
            <img src={imageUrl} alt={name} className="max-w-full object-contain" />
          </div>
        )}
        {content?.kind === "text" && <CodeView text={content.text} name={name} line={line} wrap={wrap} />}
        {content?.kind === "binary" && <Notice>Not a text file. Download it to open it in another app.</Notice>}
        {content?.kind === "tooLarge" && <Notice>Too large to show here ({fmtSize(Number(content.stamp.size))}). Download it to open it in another app.</Notice>}
      </main>
      <TransfersPanel />
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-center text-[14px] text-mist-400">{children}</p>;
}
