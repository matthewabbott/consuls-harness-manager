// A link tapped in the terminal: open it (a tap here is the gesture iOS wants before it opens
// anything) or copy it.

import { Copy, ExternalLink } from "lucide-react";

import { backend, inWebApp } from "../ipc/backend";
import type { TappedLink } from "../term/linkAt";
import { useApp } from "../store/app";
import { Sheet, SheetAction } from "./Sheet";

function open(url: string) {
  if (inWebApp) {
    // Right here, within the tap: iOS drops a window opened later.
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  } else {
    void backend().then((b) => b.openExternal(url));
  }
}

export default function LinkSheet({ link, onClose }: { link: TappedLink; onClose(): void }) {
  const text = link.kind === "url" ? link.url : `${link.path}${link.line ? `:${link.line}${link.col ? `:${link.col}` : ""}` : ""}`;
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(
      () => useApp.getState().notify("info", "Copied."),
      (e) => useApp.getState().notify("warning", `Couldn't copy: ${e}`),
    );
    onClose();
  };
  const https = link.kind === "url" && /^https:\/\//i.test(link.url);
  return (
    <Sheet onClose={onClose}>
      <div className="selectable px-3 pt-1 pb-2 font-mono text-[13px] break-all text-mist-300">{text}</div>
      {https && (
        <SheetAction
          onClick={() => {
            open(link.url);
            onClose();
          }}
        >
          <ExternalLink className="h-5 w-5 text-mist-400" /> Open
        </SheetAction>
      )}
      <SheetAction onClick={() => copy(link.kind === "url" ? link.url : link.path)}>
        <Copy className="h-5 w-5 text-mist-400" /> {link.kind === "url" ? "Copy link" : "Copy path"}
      </SheetAction>
      {link.kind === "url" && !https && <p className="px-3 pb-2 text-[12.5px] text-mist-500">Only https links open from here.</p>}
    </Sheet>
  );
}
