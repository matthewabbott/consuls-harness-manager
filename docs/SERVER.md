# The Consuls server

`consuls-server` (`crates/chm-daemon`) is Consuls without a window, on one of your machines
(here `spark-d683`). It does two things for your phone:

- **It serves the phone app**, a Home Screen web app, at `https://spark-d683.<tailnet>.ts.net`.
  A web page can't open SSH connections, so the server runs Consuls' core and reaches your
  machines for it, over Tailscale SSH like the desktop apps. The app drives it over a WebSocket:
  your agents and shells, their live terminals, typing, keys, sizing.
- **It pushes notifications** when an agent you track is still waiting for you after a while.

## It's transient

Nothing restarts it.
- It runs in a private tmux server (`tmux -L consuls-server`) until it's stopped, the machine
  reboots, or a week passes without the app being used (its lease; every use renews it).
- Its `tailscale serve` is its own child, so the tailnet address goes with it, even after a
  `kill -9`.
- What lasts between runs is its install folder, `~/.local/share/consuls-server/`, so it can be
  started again from anywhere. From the phone, SSH in (Termius works; save it as a snippet):

  ```sh
  ~/.local/share/consuls-server/consuls-server start
  ```

  While it's down, the Home Screen app opens a cached page that says so and shows that command.
- `consuls-server uninstall` removes everything it keeps there. It then lists what it leaves:
  the files the desktop apps put on that machine too (hook scripts in `~/.local/share/consuls`,
  hook events in `~/.local/state/consuls`, pasted images in `~/.cache/consuls/pastes`, and the
  `@chm_*` options on tmux panes).

## From the Mac

`scripts/server.sh` builds for the machine (never build on the Sparks: they're short of
memory) and works over SSH:

```sh
brew install zig && cargo install --locked cargo-zigbuild   # once
rustup target add aarch64-unknown-linux-gnu                  # once
scripts/server.sh install      # build and upload (and the config, if it has none yet)
scripts/server.sh start
scripts/server.sh restart      # a new build
scripts/server.sh status
scripts/server.sh log          # the current run's log
scripts/server.sh pull         # save its configuration here
scripts/server.sh stop
scripts/server.sh uninstall
```

Each takes a machine after the verb (default `spark-d683`). `SERVER_USER` is the SSH user
(default `consulear`); `SERVER_TARGET` is the Rust target and glibc version (default
`aarch64-unknown-linux-gnu.2.39`).

On the machine itself, the binary takes `start`, `stop`, `status`, `log` and `uninstall`.

## Its files

| Where | What |
|---|---|
| `~/.local/share/consuls-server/consuls-server` | The binary. |
| `…/config.json` (0600) | The push identity (`vapid.privateKey`) and settings. Written by `install` when missing. |
| `…/subscriptions.json` (0600) | The phones to push to, kept up to date. |
| `…/core/` | The core's own data: the machines it watches (added from the app), their host keys, the app's UI state. |
| `…/server.log` | The current run's log. |
| `/tmp/consuls-<uid>/` | Its sockets while it runs (`ctl.sock` for the commands, `web.sock` for the API). Removed when it stops. |
| `~/.config/consuls-server/<host>.json` on the Mac | A copy of the configuration, refreshed by `pull`, `stop` and `uninstall`. |

**Never lose `vapid.privateKey`.** Every phone's subscription is bound to it; a new key means
enabling notifications again on every phone.

| `config.json` field | What |
|---|---|
| `vapid` | `privateKey` (P-256, base64url) and `subject` (default: the web app's address). |
| `selfName` | This machine's name in pushes; default its tailnet name. |
| `delays` | `needsInputSecs` (60), `finishedSecs` (180). |
| `web` | `ownerLogins` (default the machine's owner), `publicOrigin`, `allowOrigins`, `tailscaleServe` (true), `httpsPort` (443), `listen` (a TCP address for development; default the unix socket). |
| `leaseDays` | Days unused before it stops by itself (7). |
| `hosts`, `subscriptions` | Seeds, imported once when the core's config or `subscriptions.json` is missing. |

## The phone

1. Keep the Tailscale app connected (its On-Demand rules can do that for `*.ts.net`).
2. Open `https://spark-d683.<tailnet>.ts.net` in Safari, then Share → **Add to Home Screen**.
3. Open Consuls from the Home Screen. In Settings → Notifications, tap **Enable notifications**,
   then **Send test**.
4. Flip Notify on the agents you want to hear from.

- This needs iOS 16.4 or later. Pushes only work from the Home Screen app, not a Safari tab.
- **One device at a time:** opening the app elsewhere takes over, and the first device offers
  **Use here**.
- Removing the app from the Home Screen ends its subscription, so enable notifications again
  after adding it back.

## Security

- **Only your Tailscale login gets in.** `tailscale serve` adds `Tailscale-User-Login` to
  requests from your devices, and the server checks it against `ownerLogins`.
- **The API listens on a unix socket in a 0700 folder.** Only you and `tailscale serve` (root)
  can reach it, so no other user on the machine can pretend to be you.
- **The WebSocket and every change must come from the web app's own origin.** A page on another
  site, open on your phone, can't use your Tailscale identity to drive your shells.
- **A strict content security policy:** only the app's own scripts run, and they talk only to
  this server.
- **Any device logged into your tailnet account can use the app, and that means typing into
  your sessions.** Keep that account to your own devices.

## Tailscale setup

- **HTTPS:** in the admin console's **DNS** page, turn on **MagicDNS** and **HTTPS
  Certificates**.
- **Operator:** on the server machine, once: `sudo tailscale set --operator=consulear`.
- **SSH policy:** the server reaches the other machines with Tailscale SSH.
  - Tailscale's default SSH rule is in **check** mode, which asks you to approve in a browser
    every 12 hours. The server pushes the approval link once per machine, then not again until
    you've opened the app.
  - Better: set the rule's action to `"accept"` for `autogroup:member` → `autogroup:self` in
    Access controls.
- **Public logs:** the certificate puts the machine's `ts.net` name in public
  certificate-transparency logs.

## Moving it to another machine

A Raspberry Pi, a VPS, or anything with Tailscale and tmux:
1. Copy `~/.config/consuls-server/spark-d683.json` to `<new>.json`. It keeps the push key.
2. Run `SERVER_TARGET=… scripts/server.sh install <new>` (an x86_64 machine needs e.g.
   `x86_64-unknown-linux-gnu.2.36`), then `scripts/server.sh start <new>`.
3. The web app's address changes with the machine, so add it to the Home Screen again from the
   new address and enable notifications there.
4. `scripts/server.sh uninstall spark-d683`.

## Troubleshooting

- **The app says it can't reach the server:**
  - Is Tailscale on, on the phone?
  - Then `scripts/server.sh status`, or `start` it.
- **No push at all:**
  - Is the agent tracked, and is the phone subscribed (Settings → Notifications)?
  - Does the agent report through hooks? Agents Consuls starts do. Hand-started ones only do
    with the global hook integration (the bell button on a machine in the desktop app).
- **The test push fails:** check the machine can reach the push service:
  `curl -sI https://web.push.apple.com`.
- **A phone stopped getting pushes:** its subscription expired, and the server forgets the ones
  the push service says are gone. Enable notifications again in the app.
- **It's gone:** the machine rebooted, a week passed unused, or (Linux) it went above 400 MB of
  memory and stopped rather than squeeze the machine. `scripts/server.sh log` shows the last
  run's log. Then start it again.
