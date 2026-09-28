# Consuls

A desktop dashboard for the coding agents you run in tmux across your Tailscale tailnet —
Claude Code, Codex, omp (oh-my-pi) and plain shells, on every machine at once.

- **Live grid** of every tmux pane on every connected machine, each a small live view of the terminal.
- **Expanded view** with a full terminal (type straight into it), Ctrl+F search through the
  scrollback, and *smart copy* that undoes the CLI's line wrapping and gutters. Ctrl+click opens
  links: https URLs in the browser (other schemes are copied), and file references like
  `src/App.tsx:42` in the editor at that line, on the pane's machine and relative to its folder.
- **Composer**: a mouse-friendly prompt box — click to place the cursor, select, cut/paste,
  undo/redo, Shift+Enter for new lines, ↑ for prompt history, drafts kept per pane.
- **Attention**: when an agent finishes its turn or needs permission, you get a ping (and a
  toast if Consuls isn't focused); its tile glows until you look, then shows "Waiting on you".
  Ctrl+Shift+Space jumps to the next waiting pane.
- **Labels**: tag panes (right-click a tile, or drag it onto a label in the sidebar), then
  group the grid by label, project, status or machine and sort by attention, name or recency.
  Labels are stored on the tmux pane (`@chm_labels`), so every device sees the same tags.
- **Plain shells**: pick *No tmux* in the new-pane dialog for a shell on its own connection —
  handy for `tmux attach` / `Ctrl+b d` hopping or a quick look around. They have a red border,
  are lost if the connection drops (the pane then shows why, stays readable, and is never
  revived), and keep their own scrollback. They report their folder as you `cd` (bash, zsh,
  PowerShell, cmd; the Files explorer follows along), and programs in them can copy to your
  clipboard (OSC 52, e.g. vim's or tmux's copy) while Consuls is focused.
- **Bells**: a pane can ping when its program rings the terminal bell (e.g. an IRC highlight) —
  on by default for irssi and weechat, off for shells (they beep on failed tab completion), and
  toggled per pane with the ringing-bell button or the tile's right-click menu. irssi rings for
  the levels in `beep_msg_level` (e.g. `/set beep_msg_level MSGS HILIGHT DCCMSGS`; add
  `/set beep_when_window_active ON` to hear it for the window you're in); weechat's built-in
  `beep` trigger rings on highlights and private messages.
- **This PC**: the machine Harness Manager runs on is always listed first. Start PowerShell,
  Git Bash, cmd (or WSL) there, optionally with Claude Code / Codex / omp launched in it, with the
  same tiles, notifications and composer as remote panes. Local shells end when the app quits
  (it asks first); closing the window keeps them running in the tray.
- **Files**: a VS Code–style explorer in the left sidebar, following the open pane's folder (or
  pinned anywhere on any machine). One-click places (your default folder for that machine, home,
  each drive on This PC or `/`), back / forward (also Alt+←/→ and the mouse's side buttons), the
  drive crumb as a menu of drives and places, a ☆ after the path that makes the folder the default
  (the new-pane dialog, which has the same navigation, starts there too), and double-click a folder
  to browse from it. **Show in File Explorer** / Reveal in Finder for This PC, and **Open in VS
  Code** for files (at the cursor's line) and folders — other machines open through VS Code's
  Remote-SSH, reusing your `~/.ssh/config` alias for the machine if you have one. These appear in
  the explorer's and tiles' right-click menus, the file header and the pane header, and only when
  VS Code (and, for other machines, Remote-SSH) is installed. Lazy tree, git status badges rolled up to folders, new file /
  folder, rename, delete (with an item count first), copy path, and "new pane here". Files open
  as tiles next to the pane they came from: a CodeMirror editor (syntax highlighting, search,
  undo/redo, Ctrl+S) that keeps the file's line endings and BOM, notices when an agent changes
  the file underneath you (reloads if you have no edits; otherwise offers Compare / Overwrite /
  Reload), and keeps unsaved edits across restarts. A VS Code–style gutter marks lines added,
  changed or deleted since the last commit. Images get a preview.
- **Recording mode** (the camera button in the left rail, or Settings): for screenshots and videos.
  Your tailnet e-mail, tailnet names and IPs, user names, home folder names and the PC's name are
  masked everywhere — the app's own text, the tiles, the expanded terminal, open files — and
  notifications stop naming panes. Optionally machine names too ("machine 1", …). Masks keep the
  text's length, so nothing shifts. Terminal text is matched as it streams; a name an app draws
  in pieces (different colours per letter, cursor jumps) can slip through.
- **Lifecycle**: start a new agent in any directory (remote folder browser), hide a pane
  without stopping it, or quit an agent gracefully and close its tmux pane.
- **Resilient**: one SSH connection per machine, keepalives, automatic reconnect with backoff,
  resume-from-sleep detection, Tailscale login / SSH-check URLs surfaced as one-click buttons.
  tmux stays the source of truth, so closing Consuls never touches your sessions.

## How it works

```
Tauri app (Windows/macOS)
  React UI ── binary frames + JSON events ── src-tauri (thin shell: IPC, toasts, sound, tray)
                                                   │
                                        crates/chm-core (pure Rust, no Tauri)
                                          ├─ tailscale status  → machines, host-key pinning
                                          ├─ russh: one SSH connection per host
                                          │    ├─ tmux -C (control mode), one client per session group
                                          │    ├─ SFTP (folder browser, hook assets)
                                          │    └─ tail of ~/.local/state/consuls/events.jsonl
                                          ├─ alacritty_terminal per pane → tile snapshots
                                          └─ attention state machine → alerts
remote host: tmux ≥ 3.2, and (uploaded on demand) ~/.local/share/consuls/{chm-hook.sh, …}
```

- **Attaching never resizes your other tmux clients** (`ignore-size`). A window is only resized when
  you expand a pane: the first expand fits the tmux window to the view, and after that your chosen
  size is remembered per pane (size menu: Auto-fit · Keep size · Maximize · Don't resize · Let
  tmux decide). Split windows default to *Don't resize*, since resizing redraws the neighbours —
  and Claude Code redraws its whole transcript on every width change. Pinned windows show a lock.
- **Turn detection** comes from the harnesses' own hooks. Agents started from Consuls get them
  injected at launch (`claude --settings`, `codex -c notify=…`, `omp --hook`). For agents you
  start by hand, the bell icon on a machine installs the same hooks globally (opt-in,
  reversible, backed up) — on This PC too, where they cover agents you type into Consuls' own
  shells. Without hooks, Consuls falls back to guessing from output activity.
- **Plain shells** run on an SSH `pty` channel. Consuls keeps their terminal state itself (10k
  lines of scrollback) and answers terminal queries (cursor position, device attributes,
  colours) even while the pane isn't open, so programs behave the same either way. Hooks inside
  them find their pane through `CHM_PANE`.
- **Seeding** a pane (on attach, expand, or when tmux pauses a slow client) turns the pane's
  output off, captures it, reads its modes and turns output back on — atomically, so the
  local terminal matches tmux exactly (see `crates/chm-core/tests/live.rs`).

## Requirements

- Windows 11 (macOS should work but is untested), Tailscale installed.
- Remote machines: tmux ≥ 3.2 and either Tailscale SSH (no keys needed) or regular sshd with a
  key in your ssh-agent / `~/.ssh`.
- To build: Node 22+, Rust (pinned in `rust-toolchain.toml`), MSVC Build Tools + WebView2 on Windows.

## Develop

```bash
npm install
npm run tauri dev          # the app
npm run dev                # UI only, in a browser, with mock data (src/ipc/mock.ts)
npm test                   # vitest (frames, keymap, smart copy)
cargo test -p chm-core     # parser, quoting, seeding, attention, installer, …
```

Live tests against a real host always use a **private tmux socket**, never your sessions:

```bash
CHM_E2E_HOST=spark2 cargo test -p chm-core --test live -- --ignored
cargo run -p chm-core --example selftest -- spark2 <user>             # full pipeline
cargo run -p chm-core --example selftest -- spark-d683 <user> claude /path/to/trusted/dir
```

Build an installer: `npm run tauri build` (NSIS; the installed app also gets proper toast identity).

## Keyboard

| Where | Keys |
|---|---|
| Anywhere | **Ctrl+Shift+Space** next waiting pane · **Ctrl+Shift+G** back to grid |
| Terminal | keys go straight to the pane · **Ctrl+F** search · **Ctrl+C** smart copy (with a selection) · **Ctrl+Shift+C** copy as shown · **Ctrl+V** paste · **Ctrl+Enter** jump to composer |
| Composer | **Enter** send · **Shift+Enter** new line · **↑/↓** prompt history · **Esc** (empty) interrupts the agent |

## Not yet

Next up (small):
- Rename panes from the app (tile menu / pane header); for tmux panes this renames the tmux
  window too (`rename-window`), so other clients see the new name.
- Local tmux on This PC (macOS/Linux, or WSL/MSYS2 on Windows).

Bigger: the iPhone app and push notifications, a transcript-backed conversation view, image
paste, sub-agent panes, per-harness expandable regions.
