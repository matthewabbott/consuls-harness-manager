# Handover: next round of work

Written 2026-09-28, at `master` 6e611dc (all of v2 merged; nothing pushed). Read `CLAUDE.md` first:
it holds the rules (never touch the user's real tmux sessions when testing, ask before
committing) and every gotcha found so far. `README.md` describes the app.

## Where things stand

The v2 plan is done: labels, tmux sizing, text zoom, resizable panels, plain shells (no tmux),
This PC local shells, bell pings, Files explorer, editor with git gutter, terminal links, sound
settings. Since then:
- tmux found outside the login PATH (e.g. `~/.homebrew/bin` on the Mac).
- Script exit statuses come from a stdout marker (Tailscale SSH on macOS always exits 0).
- tmux crash fixed: seeding uses `:pause`/`:continue`, never `:off`/`:on` (tmux ≤ 3.6 bug).

**Machines**
| Host | OS / tmux | Notes |
|------|-----------|-------|
| This PC (`@local`) | Windows 11 | pwsh 7, Windows PowerShell, Git Bash (`D:/Program Files/Git`), cmd; `claude`, `codex`, `omp` installed; VS Code at `D:\Users\Matthew Abbott\AppData\Local\Programs\Microsoft VS Code` with Remote-SSH |
| spark-d683 | Linux (DGX), tmux 3.4 | Tailscale SSH, user `consulear`; serves a model with only a few GB of RAM free — keep tests light |
| spark2 | Linux (DGX), tmux 3.4 | same setup |
| mbas-macbook-pro | macOS, tmux 3.7c in `~/.homebrew/bin` | Tailscale SSH, user `matthewabbott` |

**Build, run, test**

- Develop against the mock backend in a browser: `npm run dev`.
- Desktop dev mode: `npm run tauri dev` (needs port 1420 free).
- Standalone app: `npm run tauri build -- --no-bundle`, which produces `target\release\consuls.exe`.
  - It locks the exe while running, so stop the tray app first.
- Checks:
  ```
  npx tsc --noEmit
  npx vitest run
  cargo clippy --workspace --all-targets
  cargo test --workspace
  ```
- End to end:
  - `cargo run -p chm-core --example selftest -- spark-d683 consulear` (private tmux socket).
  - `cargo run -p chm-core --example localtest`.
  - Real-UI scripts in `scripts/e2e/` (see CLAUDE.md "Testing").
  - `crashhunt` stress-tests tmux.

## In scope next

Roughly in order. Each is small-to-medium and self-contained.

**Progress (branch `v3`):**
- Done:
  - V3-1 sidebars.
  - V3-2 places & default folders:
    - The explorer's chip row (`★ default` · home · drives, or `/`).
    - A nav row: back/forward, the drive crumb as a dropdown, and a ☆ after the path that sets the
      default.
    - Double-click browses into a folder.
    - The new-pane dialog shares the chips, the nav row and the default.
  - V3-3/4: Show in File Explorer and Open in VS Code (local, and Remote-SSH).
    - The remote path is only verified up to the launch. The Mac was offline, so a real Remote-SSH
      connection is still to check.
  - V3-5 recording mode:
    - Masks in UI text, tiles, the expanded terminal and the editor.
    - Optional machine aliases.
    - Toasts go generic.
  - Default folders and recording mode moved into `config.json` (`AppConfig.ui`). The release app's
    WebView2 localStorage turned out to lose data.
  - V3-6: plain shells report their folder via shell integration, and OSC 52 copies reach the
    clipboard. Verified on spark-d683 (bash), the Mac (zsh), and here in pwsh, powershell,
    Git Bash and cmd.
  - V3-7: global hooks on This PC. The installer's file access is behind `ConfigFiles` (SFTP or
    `std::fs`); the bell button sits on the This PC row. The user installs it themselves.
  - V3-8: tmux on This PC through Cygwin (tmux 3.7b, installed by the user; WSL avoided on
    purpose).
    - The `Link` seam (SSH or a local shell) and the control client under script(1).
    - Path mapping, the job object, and `hub/local_tmux.rs`.
    - Verified by `localtmux`, a real-app E2E, a crash test (the server survives, the client
      dies) and the SSH selftest.
- After v3 was merged (on `master`):
  - Renaming panes: `@chm_name`, shown only in Consuls. The user chose not to rename tmux
    windows or sessions (they'd rather do that with tmux's own keys).
  - Image paste into the composer or the terminal, saved on the pane's machine.
  - The UI's layout, zoom and composer drafts/history moved from localStorage to the core's
    `ui-state.json`.
  - tmux ≤ 3.6 crashed (whole server) when a session closed under our control client: the
    all-panes subscription's timer reads a NULL session. Subscriptions are per pane now; the
    selftest reproduces the crash (it froze our client with SIGSTOP and killed its session).
  - tmux prefix keys (Ctrl+B …) in the expanded view, handled by the app with tmux's stock
    meanings, aimed at the pane on screen.
  - Wrapped URLs (Claude Code's sign-in link) copy and Ctrl+click whole.
- Future (from the user, 2026-09-28):
  - The Mac app watching its own tmux (a native `LocalSh`). Likely next.
  - This PC reachable over SSH by another Consuls, "tmux-able like any other". Windows' SSH
    server lands in cmd/PowerShell, so `exec`'s `$SHELL -lc` wrapper would need a Cygwin-aware
    variant.

### 1. Sidebars (done in V3-1)
- Right sidebar (the filmstrip beside an expanded pane, `ExpandedPane.tsx`): its collapse toggle
  lives in the pane header today; move it to the filmstrip's own top-left corner (and show a
  slim re-open affordance when collapsed).
- Left sidebar (`LeftSidebar.tsx` + `ActivityBar.tsx`): collapsing already keeps the icon rail
  and clicking an icon re-opens its panel, but the only ways to collapse are clicking the
  active icon, the app icon, or Ctrl+Shift+B — add an explicit collapse button at the panel's
  top, mirroring the right one. Consider keeping the rail visible when an expanded pane is
  maximized (today the whole left sidebar hides).

### 2. Reveal in File Explorer / Finder (This PC only)
- `tauri-plugin-opener` 2 is already a dependency and has `reveal_item_in_dir`; expose it via a
  validated Rust command in `src-tauri/src/commands.rs` (the webview deliberately has no opener
  permission — see `capabilities/`). Convert forward-slash paths to native.
- Entry points: Files panel context menu (`FilesPanel.tsx`) when the root host is `@local`,
  the file view header (`FileView.tsx`), and "Reveal folder" for a local pane's cwd.
- Label per platform: "Show in File Explorer" (Windows) / "Reveal in Finder" (macOS).

### 3. Open in VS Code (local and remote)
- Detect the `code` CLI once at startup (PATH, then the usual install dirs); expose
  `{ installed, remoteSsh }` (`code --list-extensions` contains `ms-vscode-remote.remote-ssh`).
  Only show the actions when installed; the remote one only with Remote-SSH.
- Local: `code -g <path>[:line[:col]]` (files) / `code <folder>`.
- Remote: `code --folder-uri vscode-remote://ssh-remote+<user>@<host>/<path>` for folders and
  `--file-uri` for files (MagicDNS host names resolve; the user is in the host config).
- Spawn from the Rust shell with no console window; keep chm-core Tauri-free (put it in
  `src-tauri`, or a small `chm-core::vscode` helper with no Tauri types).
- Entry points: Files panel context menu, file view header, pane header (open the pane's cwd).

### 4. Recording mode (hide personal details)
- A toggle (top bar or Settings, persisted in `store/ui.ts`) that masks, everywhere in the UI
  chrome: the account email (sidebar footer), tailnet IPs (100.64.0.0/10 and others shown in
  dialogs/banners), MagicDNS names (`*.ts.net`), `user@host` strings, usernames and home paths
  (`/home/<user>`, `C:/Users/<name>`), the PC's machine name, git remote URLs if shown.
- Implement one `redact(text)` helper fed by patterns derived from live data (config users,
  host facts, tailnet status) plus generic email/IP patterns; use it in components rather than
  CSS blur so screenshots are clean.
- Terminal content is harder: tiles (`term/tilePainter.ts`) can redact run text with same-length
  masks; for the expanded xterm, pass RAW/RESET bytes through a streaming redactor before
  `term.write` (same-length replacement, carry a small tail across chunk boundaries). Decide
  whether v1 covers terminals or only chrome, and show a clear "Recording mode" indicator.

### 5. Smaller gaps
- **Plain shell cwd tracking**: direct panes keep their start folder. Parse OSC 7
  (`file://host/path`), OSC 9;9 (pwsh/Windows Terminal) and OSC 633;P;Cwd in `hub/direct.rs`
  before feeding alacritty (which ignores them) and publish `current_path`.
- **OSC 52 clipboard writes** from programs in direct panes (`Event::ClipboardStore` in
  `hub/direct.rs` is ignored): forward to the UI and write the clipboard only while the app is
  focused (never answer clipboard reads).
- **Hand-started agents on This PC**: the global hook install (`integration/install.rs`) only
  works over SSH; add a local variant (same file edits under the local home, `sh.exe` paths as
  in `local::ensure_assets`).
- **Image paste into the composer** (original v1 wish): upload the pasted image to the host
  (SFTP to a temp dir under `~/.local/state/consuls/`, or local fs) and insert its path —
  Claude Code and Codex both accept image paths in prompts.

### 6. tmux on This PC (medium, lower priority)
The local host only runs direct shells. For macOS/Linux (and WSL/MSYS2 on Windows) the tmux
manager needs a transport seam: today `TmuxManager`, `ControlClient::attach` and `exec::run`
take an `SshConnection`. Abstract exec + a bidirectional stream (local `tokio::process` with
piped stdio) and reuse everything else. Only verifiable with the app running on a machine that
has tmux (the Mac).

## Out of scope for this round
The iPhone app and push notifications (chm-core is kept Tauri-free for this), a
transcript-backed conversation view, sub-agent panes, per-harness expandable regions.
