import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { AlertTriangle, ArrowLeft, FileText, FolderSearch, ImageIcon, Loader2, RotateCcw, Save, SquareCode, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import { hostLabel, isLocal } from "../lib/hosts";
import { canOpenInVsCode, openInVsCode, REVEAL_LABEL, revealPath, useVsCode } from "../lib/openers";
import { parentPath } from "../lib/paths";
import { buffers, useEditor } from "../store/editor";
import { useRedact } from "../store/recording";
import { statusOf, useFiles } from "../store/files";
import FileEditor, { type FileEditorHandle } from "./FileEditor";
import Modal, { Button } from "./Modal";

/** An open file, full size: editor (or image / notice), with save and conflict handling. */
export default function FileView({ id }: { id: string }) {
  const file = useEditor((s) => s.files[id]);
  const editor = useEditor.getState;
  const editorRef = useRef<FileEditorHandle>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [language, setLanguage] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [closing, setClosing] = useState(false);
  const badges = useFiles((s) => s.badges);
  const gitRoot = useFiles((s) => s.git?.root ?? null);
  const vscode = useVsCode();
  const r = useRedact();

  // Watch for outside changes while it's open.
  useEffect(() => {
    const t = window.setInterval(() => void editor().poll([id]), 3000);
    return () => window.clearInterval(t);
  }, [id, editor]);

  if (!file) return null;
  const back = () => editor().setActive(null);
  const close = () => {
    if (file.dirty) setClosing(true);
    else {
      editor().close(id);
    }
  };
  const status = statusOf(badges, file.path, gitRoot);

  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 pb-4">
      <header className="flex h-12 shrink-0 items-center gap-3">
        <button onClick={back} title="Back to grid (Ctrl+Shift+G)" className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-700 hover:text-mist-100">
          <ArrowLeft className="h-4 w-4" />
        </button>
        {file.kind === "image" ? <ImageIcon className="h-5 w-5 text-sky-400/80" /> : <FileText className="h-5 w-5 text-sky-400/80" />}
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14.5px] font-semibold text-mist-100">
            <span className="truncate">{r(file.name)}</span>
            {file.dirty && <span title="Unsaved changes" className="h-2 w-2 shrink-0 rounded-full bg-ember-400" />}
          </div>
          <div className="truncate font-mono text-[11px] text-mist-500" title={r(file.path)}>
            {r(`${hostLabel(file.host)} · ${parentPath(file.path)}`)}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {isLocal(file.host) && (
            <button
              onClick={() => revealPath(file.host, file.path)}
              title={REVEAL_LABEL}
              className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-700 hover:text-mist-100"
            >
              <FolderSearch className="h-3.5 w-3.5" />
            </button>
          )}
          {canOpenInVsCode(vscode, file.host) && (
            <button
              onClick={() => openInVsCode(file.host, file.path, file.kind === "text" ? cursor.line : undefined, file.kind === "text" ? cursor.col : undefined)}
              title={`Open in VS Code${file.kind === "text" ? ` at line ${cursor.line}` : ""}${file.dirty ? " (save first: it opens the file on disk)" : ""}`}
              className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-700 hover:text-mist-100"
            >
              <SquareCode className="h-3.5 w-3.5" />
            </button>
          )}
          {file.kind === "text" && (
            <button
              onClick={() => void editor().save(id)}
              disabled={!file.dirty || file.saving}
              title="Save (Ctrl+S)"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-ink-700 hover:text-mist-100 disabled:opacity-40"
            >
              {file.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
            </button>
          )}
          <button
            onClick={() => void editor().reload(id)}
            disabled={file.dirty}
            title={file.dirty ? "Save or close first (reloading would discard your changes)" : "Reload from disk"}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-ink-700 hover:text-mist-100 disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reload
          </button>
          <button onClick={close} title="Close file" className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-ink-700 hover:text-mist-100">
            <X className="h-3.5 w-3.5" /> Close
          </button>
        </div>
      </header>

      {file.conflict !== undefined && (
        <div className="mb-2 flex items-center gap-3 rounded-lg bg-ember-400/10 px-3 py-2 text-[12px] text-ember-200 ring-1 ring-ember-400/35">
          <AlertTriangle className="h-4 w-4 shrink-0 text-ember-400" />
          <span className="min-w-0 flex-1">
            {file.conflict === null ? (
              <>The file was deleted on disk. Saving will create it again.</>
            ) : (
              <>
                The file changed on disk{file.restored ? " since this unsaved copy was made" : " while you were editing"}. Saving now would overwrite
                those changes.
              </>
            )}
          </span>
          {file.conflict !== null && (
            <BannerButton onClick={() => setComparing(true)}>Compare</BannerButton>
          )}
          <BannerButton onClick={() => void editor().save(id, { force: true })}>{file.conflict === null ? "Save" : "Overwrite"}</BannerButton>
          {file.conflict !== null && <BannerButton onClick={() => void editor().reload(id)}>Reload (discard mine)</BannerButton>}
        </div>
      )}
      {file.error && file.kind === "text" && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200 ring-1 ring-rose-500/30">
          <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" /> Couldn't save: {file.error}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl bg-[#0e1119] ring-1 ring-ink-700">
        {file.kind === "loading" && <Centered>Loading…</Centered>}
        {file.kind === "error" && (
          <Centered>
            <span className="text-rose-300">{file.error}</span>
            <button onClick={() => void editor().reload(id)} className="mt-3 text-sky-400 hover:underline">
              Try again
            </button>
          </Centered>
        )}
        {file.kind === "binary" && <Centered>This is a binary file ({fmtSize(file.size ?? 0)}); it can't be edited here.</Centered>}
        {file.kind === "tooLarge" && <Centered>This file is {fmtSize(file.size ?? 0)}: too large to edit here (the limit is 5 MB).</Centered>}
        {file.kind === "image" && <ImageView host={file.host} path={file.path} />}
        {file.kind === "text" && (
          <FileEditor ref={editorRef} key={`${id}:${file.gen}`} id={id} onCursor={(line, col) => setCursor({ line, col })} onLanguage={setLanguage} />
        )}
      </div>

      {file.kind === "text" && (
        <footer className="mt-2 flex shrink-0 items-center gap-4 px-1 font-mono text-[11px] text-mist-500">
          <span>
            Ln {cursor.line}, Col {cursor.col}
          </span>
          <span>{language ?? "Plain text"}</span>
          <button
            onClick={() => editor().setEol(id, file.eol === "crlf" ? "lf" : "crlf")}
            title="Line endings used when saving (click to switch)"
            className="rounded px-1 hover:bg-ink-700 hover:text-mist-200"
          >
            {file.eol === "crlf" ? "CRLF" : "LF"}
          </button>
          <span title={file.bom ? "Saved with a byte-order mark" : undefined}>UTF-8{file.bom ? " with BOM" : ""}</span>
          {status && <span className="capitalize">git: {status}</span>}
          <span className="ml-auto">{file.saving ? "Saving…" : file.dirty ? "Unsaved" : "Saved"}</span>
        </footer>
      )}

      {comparing && file.conflict && <CompareDialog id={id} onClose={() => setComparing(false)} />}
      {closing && (
        <Modal
          title={`Close “${file.name}”?`}
          onClose={() => setClosing(false)}
          width={420}
          footer={
            <>
              <Button onClick={() => setClosing(false)}>Cancel</Button>
              <Button
                kind="danger"
                onClick={() => {
                  setClosing(false);
                  editor().close(id);
                }}
              >
                Discard changes
              </Button>
              <Button
                kind="primary"
                onClick={async () => {
                  if (await editor().save(id)) {
                    setClosing(false);
                    editor().close(id);
                  } else setClosing(false);
                }}
              >
                Save & close
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-mist-300">It has unsaved changes.</p>
        </Modal>
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center p-6 text-center text-[13px] text-mist-400">{children}</div>;
}

function BannerButton({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="shrink-0 rounded-md bg-ember-400/15 px-2.5 py-1 font-medium ring-1 ring-ember-400/40 hover:bg-ember-400/25">
      {children}
    </button>
  );
}

function ImageView({ host, path }: { host: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let revoke: string | null = null;
    backend()
      .then((b) => b.readBytes(host, path))
      .then((bytes) => {
        const type = path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "";
        revoke = URL.createObjectURL(new Blob([bytes], type ? { type } : undefined));
        setUrl(revoke);
      })
      .catch((e) => setError(String(e)));
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [host, path]);
  if (error) return <Centered>{error}</Centered>;
  if (!url) return <Centered>Loading…</Centered>;
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(#151925_0%_25%,#0e1119_0%_50%)] bg-[length:20px_20px] p-4">
      <img src={url} alt={path} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

/** Side-by-side: the file on disk vs. your unsaved version. */
function CompareDialog({ id, onClose }: { id: string; onClose(): void }) {
  const file = useEditor((s) => s.files[id]);
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let view: MergeView | null = null;
    const mine = buffers.get(id)?.state?.doc.toString() ?? "";
    backend()
      .then((b) => b.readFile(file.host, file.path))
      .then((c) => {
        if (c.kind !== "text" || !hostRef.current) return setError("The file on disk isn't text any more.");
        const ro = [EditorView.editable.of(false), EditorState.readOnly.of(true), EditorView.theme({ "&": { fontSize: "12px" } }, { dark: true })];
        view = new MergeView({
          a: { doc: c.text.replace(/\r\n?/g, "\n"), extensions: ro },
          b: { doc: mine, extensions: ro },
          parent: hostRef.current,
          collapseUnchanged: { margin: 3, minSize: 6 },
        });
      })
      .catch((e) => setError(String(e)));
    return () => view?.destroy();
  }, [id, file.host, file.path]);
  return (
    <Modal
      title={`${file.name}: on disk (left) vs. yours (right)`}
      onClose={onClose}
      width={1000}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            onClick={() => {
              onClose();
              void useEditor.getState().reload(id);
            }}
          >
            Take the disk version
          </Button>
          <Button
            kind="primary"
            onClick={() => {
              onClose();
              void useEditor.getState().save(id, { force: true });
            }}
          >
            Keep mine (overwrite)
          </Button>
        </>
      }
    >
      {error ? <p className="text-[13px] text-rose-300">{error}</p> : <div ref={hostRef} className="max-h-[60vh] overflow-auto rounded-lg bg-[#0e1119] font-mono ring-1 ring-ink-700" />}
    </Modal>
  );
}
