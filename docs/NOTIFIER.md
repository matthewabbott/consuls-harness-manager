# The notifier

`consuls-notifier` (`crates/chm-daemon`) is Consuls without a window, run for a while on one of
your machines (here `spark-d683`). It watches the agents in that machine's tmux, and on the
machines it's given, and pushes to your phone when an agent you **track** is still waiting for
you after a while. On spark-d683 it also serves the phone's web app.

It's **transient**: nothing is installed on the machine, and nothing restarts it.
- It runs in a private tmux server (`tmux -L consuls-notifier`), apart from yours.
- Its configuration, push key included, arrives over a control socket and stays in memory.
- Its only files are its run folder, `/tmp/consuls-<uid>/` (binary and control socket).
- It removes that folder and ends when told to (`stop`), at reboot, or when nobody has checked
  in for 7 days (its lease). Its `tailscale serve` is a foreground child, so the tailnet address
  goes with it, even after `kill -9`.

Behaviour:
- **Tracking** is per agent and off by default. Flip it with the phone icon on a tile in the
  desktop app, or the Notify switch in the phone's list. It's stored on the tmux pane
  (`@chm_notify`), so every device agrees.
- **When it pushes:**
  - Needs input (a permission prompt, a question): after 1 minute. Finished its turn: after 3.
  - Only if it's still waiting then. Replying, closing the pane, untracking it, or looking at it
    in a desktop app (which writes `@chm_seen` on the pane) cancels the push.
- **Tapping the notification** opens the app at that agent.
- **Coverage:** its own machine (as `@local`), plus the `hosts` in its configuration. The
  Windows PC isn't covered: it has no SSH server Consuls can use.

## Running it

Everything runs from the Mac, which builds for the machine (never build on the Sparks: they're
short of memory) and keeps the configuration:

```sh
brew install zig && cargo install --locked cargo-zigbuild   # once
rustup target add aarch64-unknown-linux-gnu                  # once
scripts/notifier.sh start      # build, upload, start, configure; then its status
scripts/notifier.sh status
scripts/notifier.sh renew      # check in: 7 more days from now
scripts/notifier.sh log        # its recent output
scripts/notifier.sh restart    # a new build (keeps the phones it has)
scripts/notifier.sh stop       # and nothing of it is left on the machine
```

Each takes a machine after the verb (default `spark-d683`); `NOTIFIER_USER` is the SSH user
(default `consulear`), `NOTIFIER_TARGET` the Rust target and glibc version (default
`aarch64-unknown-linux-gnu.2.39`).

After a reboot of the machine, or 7 days without `renew`, run `start` again. (The iOS app will
do this by itself.)

## The configuration

It lives on the Mac only, at `~/.config/consuls-notifier/<host>.json` (0600), and reaches the
notifier over SSH's stdin (`consuls-notifier ctl configure`).
- `stop` and `restart` first save the notifier's current configuration back (`pull`), so
  phones that enabled notifications meanwhile aren't lost. The previous copy is kept as
  `<host>.json.bak`.
- **Never lose `vapid.privateKey`**: every phone's subscription is bound to it. A new key means
  enabling notifications again on every phone.
- The first one came from the old push daemon's files:
  `scripts/notifier.sh import spark-d683 ~/.config/consuls-notifier/legacy`.

| Field | What |
|---|---|
| `vapid` | `privateKey` (P-256, base64url) and `subject` (default: the web app's address). |
| `subscriptions` | The phones to push to. |
| `hosts` | Other machines to watch over SSH (the core's `HostConfig`). Its own machine is skipped: it's `@local` already. |
| `selfName` | This machine's name in pushes; default its tailnet name. |
| `delays` | `needsInputSecs` (60), `finishedSecs` (180). |
| `web` | Serve the phone's web app: `ownerLogins` (default the machine's owner), `publicOrigin`, `allowOrigins`, `tailscaleServe` (true), `httpsPort` (443), `listen` (default a free port on 127.0.0.1). |
| `leaseDays` | Days without a check-in before it stops by itself (7). |

The control socket (`/tmp/consuls-<uid>/ctl.sock`, this user only) takes one JSON request per
line: `configure` (once), `renew`, `status`, `subscriptions`, `setSubscriptions`, `export`,
`stop`. On the machine: `/tmp/consuls-$(id -u)/bin/consuls-notifier ctl status`. A notifier
nobody configures within a minute leaves.

### Tailscale SSH policy

The notifier reaches the other machines with Tailscale SSH. Tailscale's default SSH rule is in
**check** mode: it asks you to approve in a browser, and asks again every 12 h. That stalls an
unattended notifier, which shows "waiting for Tailscale SSH approval".
- The notifier logs the approval link, pushes it to your phone, and the phone app shows an
  **Approve** button.
- To stop it asking, change your SSH rule in the admin console (Access controls) to one of:
  - `"action": "accept"` for `autogroup:member` → `autogroup:self`;
  - keep `"check"` and add `"checkPeriod": "168h"`: then you approve once a week, from the
    notification.

A rule can't single out one untagged machine as the source.

## HTTPS on the tailnet

The phone reaches the app at `https://spark-d683.<tailnet>.ts.net`, through the notifier's
`tailscale serve`. It terminates TLS with the tailnet's certificate, and tells the notifier
who's asking.

Once:
1. In the admin console's **DNS** page, turn on **MagicDNS** and **HTTPS Certificates**.
2. On spark-d683: `sudo tailscale set --operator=consulear`.

Notes:
- Only the machine's owner gets in. The notifier checks the `Tailscale-User-Login` header
  against `ownerLogins`. Each visit renews its lease.
- The API itself only listens on 127.0.0.1.
- While the notifier is stopped, the Home Screen app opens a cached page saying so. Pushes
  still arrive from any notifier that's running.
- The certificate puts the machine's `ts.net` name in public certificate-transparency logs.
- Check with `tailscale serve status --json` on the machine (a foreground serve is listed under
  `Foreground`; plain `status` says "No serve config"): it's there only while the notifier runs.

## The phone

1. Keep the Tailscale app connected (its On-Demand rules can do that for `*.ts.net`).
2. Open `https://spark-d683.<tailnet>.ts.net` in Safari, then Share → **Add to Home Screen**.
3. Open Consuls from the Home Screen and tap **Enable notifications**, then **Send test**.
4. Flip the Notify switch on the agents you want to hear from.

This needs iOS 16.4 or later. Pushes only work from the Home Screen app, not a Safari tab.

Removing the app from the Home Screen ends its subscription, so enable notifications again
after adding it back. The app re-registers itself with the notifier every time it opens; `pull`
afterwards to keep a new subscription on the Mac.

## Troubleshooting

- **No push at all:**
  - Is a notifier running (`scripts/notifier.sh status`)? Is the agent tracked? Is a phone
    subscribed? The app's footer counts devices.
  - Does the agent report through hooks? Agents Consuls starts do. Hand-started ones only do
    with the global hook integration (the bell button on a machine in the desktop app).
- **A push you'd seen anyway:** a desktop app older than the push daemon doesn't write
  `@chm_seen`. Update it.
- **"This isn't yours" (403):** open the app from your own device, through `tailscale serve`,
  not the local port.
- **The test push fails:** check the machine can reach the push service:
  `curl -sI https://web.push.apple.com`.
- **A phone stopped getting pushes:** its subscription expired, and the notifier forgets
  subscriptions the push service says are gone. Open the app and enable notifications again.
- **It's gone:** the machine rebooted, its lease ran out, or (Linux) it went above 400 MB of
  memory and stopped rather than squeeze the machine. Its log goes with it; `start` it again.

Tracked panes keep their `@chm_notify` when the notifier is gone, which is harmless. Untrack
them in the app if you like.
