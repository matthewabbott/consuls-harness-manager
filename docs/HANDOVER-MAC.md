# Handover: Consuls on the Mac

Written 2026-09-28 on the Windows PC, at `master` 1d19d3b. You're the agent on the MacBook
(`mbas-macbook-pro`, repo at `~/Programming/consuls-harness-manager`). Read `CLAUDE.md` first:
it holds the rules and every gotcha found so far. `README.md` describes the app, and
`docs/HANDOVER.md` the round that just finished.

## The goal

The user wants the app running on the Mac, watching the Mac's own tmux sessions the same way
the Windows app watches remote machines. On Windows, "This PC" (host `@local`) already has
plain shells and tmux panes (tmux through Cygwin). On the Mac, `@local` has plain shells, but
not tmux yet.

Until now the Mac has only been a *remote* machine: the Windows app reaches it over Tailscale
SSH (user `matthewabbott`, tmux 3.7c in `~/.homebrew/bin`, zsh). That keeps working and runs at
the same time as your Mac app (see "Two apps, one tmux" below).

## Rules that matter most here

- **Never type into, resize or kill the user's real tmux sessions when testing.** The Mac has
  real ones: agents run in them. Use a private server: `CHM_TMUX_SOCKET=<name>` for the whole
  core, `tmux -L chm-test-…` in tests. Attaching read-only is fine.
- Don't install the global hook integration yourself (it edits the user's
  Claude/Codex/omp configs); tests use a scratch home.
- **Ask before committing.** Work on a branch, `mac`, off `master`, since the Windows side may
  keep committing to `master`. The repo syncs through GitHub (`origin`); don't push unless the
  user asks.
- The DGX Sparks (`spark-d683`, `spark2`) have almost no free memory: keep tests there light
  (the selftest is fine), and never open VS Code Remote-SSH against them.
- `chm-core` stays Tauri-free (a future iOS app / push daemon reuses it).

## Build and run on macOS

- Needs the Xcode Command Line Tools, Rust (rustup, stable), and Node 20+. Then `npm install`.
- UI against mock data, in a browser: `npm run dev` (http://localhost:1420).
- Desktop app: `npm run tauri dev`. A standalone build: `npm run tauri build -- --no-bundle`
  (`target/release/consuls`), or without `--no-bundle` for a `.app`.
- Checks: `npx tsc --noEmit`, `npx vitest run`, `cargo clippy --workspace --all-targets`,
  `cargo test --workspace`.
- The app keeps its data in `~/Library/Application Support/dev.consuls.harness-manager/`
  (`config.json`, `known_hosts.json`, `ui-state.json`; debug builds use `ui-state-dev.json`).
  It starts with no machines: the user adds `spark-d683` etc. in the app.
- None of this has been built on macOS yet, so expect some fixes first. Most platform code is
  behind `cfg(windows)` with a unix branch, but the unix branches have never run in the app.

## What to build

### 1. tmux on This PC, natively (the main task)

The seam exists; macOS just isn't plugged into it.

- `crates/chm-core/src/link.rs`: `Link::Local(LocalSh)` runs scripts and control clients
  through a local POSIX shell. On unix it already runs `sh -c <command>` directly (no base64
  wrapper, which is Windows-only).
- `crates/chm-core/src/hub/local_tmux.rs` drives `@local`'s tmux with the same `TmuxManager` as
  remote hosts. Today `find()` returns `Cygwin::find()` on Windows and `None` elsewhere, and
  `run()` is Cygwin-specific:
  - it reads the mount table into a `PathMap`;
  - it sets `CHERE_INVOKING=1`;
  - it uses `cygwin.shell()`, a `LocalSh` whose `control_needs_pty: true` wraps control clients
    in `script(1)`.
- For the Mac, make that a choice between Cygwin and a native tmux:
  - `LocalSh { sh: "/bin/sh", env: [CHM_STATE_DIR], control_needs_pty: false }`, with no path
    map and no `CHERE_INVOKING`.
  - Pane env is `CHM_STATE_DIR` only, so hooks in our panes write to the events file this app
    tails (`local::tail_events`, `~/.local/state/consuls/events.jsonl` by default).
- **Finding tmux:** a login shell (`$SHELL -lc`, see `ssh/exec.rs::login_shell`) doesn't read
  `~/.zshrc`, and that's where the Homebrew in `~/.homebrew` is added to PATH. So resolve an
  absolute path and put it in `TmuxServer { bin: Some(..) }` (its `prefix()` then uses it).
  - Try `~/.homebrew/bin/tmux`, `/opt/homebrew/bin/tmux` and `/usr/local/bin/tmux`, then `which`.
  - Last resort: ask an interactive shell, as the remote facts script does
    (`HostFacts::tmux_path`).
- `local::facts()` fills `tmux_version` from Cygwin only. Make it report the native tmux's
  version and `tmux_path` too: the new-pane dialog offers tmux on This PC only when
  `tmuxVersion` is set, and `Grid` shows it.
- `local::ensure_assets()` writes the hook assets with `"tmux"` as the tmux command
  (`assets::files(&assets, "tmux")`). On the Mac pass the absolute path, or the hook's
  `set-option @chm_state` won't find tmux.
- Control clients are children of the app. On Windows a job object kills them with the app.
  On unix, check that a control client exits when the app quits or crashes (its stdin closes;
  tmux should exit on EOF). Nothing must be left attached.
- Tests:
  - `crates/chm-core/examples/localtmux.rs` is Cygwin-only today (it bails out without Cygwin).
    Make it work with the native tmux, on a private socket and a scratch state dir, as it does now.
  - `scripts/e2e/local-tmux.mjs` drives the real UI over WebView2's DevTools protocol, which
    doesn't exist on macOS (WKWebView). See "Testing on the Mac".

### 2. Check what already claims to work on unix

It's all written, but none of it has run on a Mac:
- **Plain shells on This PC:** the login shell, zsh, bash, fish (`local::shell_defs`, unix
  branch). zsh gets folder reporting through `ZDOTDIR` shell integration (`local::integrate`,
  `remote-assets/shell/zsh/`), and OSC 52 copies reach the clipboard.
  `cargo run -p chm-core --example localtest` exercises every local shell. Its commands are
  POSIX except for the PowerShell ones.
- **Hooks:** agents in local shells report through the events file (`local::tail_events`).
- **Files explorer:** on POSIX machines the places row is ★ default · `~` · `/`. Check Reveal in
  Finder (`reveal_path`) and Open in VS Code (`src-tauri/src/vscode.rs` has a macOS detection
  branch).
- **Tailscale:** `tailscale.rs` looks for `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- **Sounds:** rodio.

### 3. macOS notifications

`src-tauri/src/alerts.rs`: `show_toast` is Windows-only (WinRT). On macOS it's a no-op, so there's
only the chime. Add Notification Center notifications in the Tauri shell, not chm-core.
Clicking one should bring the window up and emit `focus-pane` with the pane's key, like the
Windows toast. Recording mode must keep them generic (`alerts::anonymous`). An unbundled dev
binary may not be allowed to post notifications; check the `.app` build too.

### 4. macOS app behaviour

- Closing the window hides it (the app keeps watching from the tray / menu bar). Clicking the
  Dock icon should show it again (`RunEvent::Reopen`), which isn't handled yet.
- Quitting while local shells run asks first. The tray's Quit does (`tray::request_quit`), but
  make sure Cmd+Q / the app menu's Quit goes through the same path (`RunEvent::ExitRequested`).
- The tray icon may need a template image on macOS.

## Two apps, one tmux

The Windows app keeps watching the Mac over SSH while your app watches it locally. Both attach
control clients to the same sessions:
- **Hook events:** both tail the Mac's `~/.local/state/consuls/events.jsonl`, so both get
  notified. That's fine.
- **Assets:** both write `~/.local/share/consuls/` (hook scripts, versioned by content hash). Apps
  built from different commits rewrite each other's copy on every connect. Keep both builds on
  the same commit.
- **Sizing:** expanding a pane can pin its window size (`@chm_sized`, `window-size manual`). Two
  apps with the same pane expanded would fight over it. Worth noticing, not necessarily fixing.
- **Crashes:** tmux ≤ 3.6 crashed when a session closed under a control client with an
  all-panes subscription. That's fixed (per-pane subscriptions, 9e6d9d3), and 3.7c has the
  upstream fix anyway.

## Testing on the Mac

- **Core logic:** the examples.
  - `localtest` (plain shells), and `localtmux` (once it's native).
  - `selftest -- spark-d683 consulear` for the remote paths. It uses a private tmux socket and
    covers sizing, labels, names, pasted images, prefix-key operations, the tmux crash, direct
    shells, reconnect and hooks.
- **The real UI:** the CDP scripts in `scripts/e2e/` only work with WebView2 (Windows).
  - On the Mac, check UI logic against the mock backend in a browser (`npm run dev`).
  - Use Safari's Web Inspector on `tauri dev` for debugging.
  - Ask the user to try the real app for what only it can show (notifications, Dock/tray,
    real agents).
- Keep tests on private tmux sockets and scratch dirs; clean up any server you start.

## Where things are

- `crates/chm-core/`: all remote/local logic.
  - `hub/` holds the host actors, `tmux_mgr.rs`, `local_tmux.rs` and `direct.rs` (plain shells).
  - Also `link.rs`, `local.rs`, `cygwin.rs`, `tmux/`, `ssh/`, `fs/` and `integration/`.
- `src-tauri/`: the thin shell (commands, alerts, tray, VS Code).
- `src/`: React UI. `ipc/bindings/` is generated by `cargo test -p chm-core`.
- `remote-assets/`: hook and shell-integration files written to `~/.local/share/consuls/`.

## When you're done

Update `CLAUDE.md`: its "tmux on This PC" section says macOS is "not yet". Also update README
"Not yet" and `docs/HANDOVER.md`. Then ask the user before committing on `mac`.
