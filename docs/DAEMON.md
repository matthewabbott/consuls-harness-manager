# The push daemon

`consuls-daemon` (`crates/chm-daemon`) is Consuls without a window, on an always-on machine
(here `spark-d683`). It watches the agents on that machine's tmux and on the machines you give
it, and pushes to your phone when an agent you **track** is still waiting for you after a while.
It also serves the phone's web app.

- **Tracking** is per agent and off by default. Flip it with the phone icon on a tile in the
  desktop app, or the switch in the phone's list. It's stored on the tmux pane (`@chm_notify`),
  so every device agrees.
- **When it pushes:**
  - Needs input (a permission prompt, a question): after 1 minute. Finished its turn: after 3.
  - Only if it's still waiting then. Replying, closing the pane, untracking it, or looking at it
    in a desktop app (which writes `@chm_seen` on the pane) cancels the push.
- **Tapping the notification** opens the app at that agent.
- **Coverage:** the daemon's own machine (as `@local`), plus the hosts in its `config.json`.
  The Windows PC isn't covered: it has no SSH server Consuls can use.

## Install and update

From the Mac (the target is never used to compile: it's short of memory):

```sh
brew install zig && cargo install --locked cargo-zigbuild   # once
rustup target add aarch64-unknown-linux-gnu                  # once
scripts/deploy-daemon.sh                                     # builds, copies, (re)starts
```

It runs as a systemd user service, `~/.config/systemd/user/consuls-daemon.service`, with its
memory capped at 250 MB.
- Lingering must be on (`loginctl show-user consulear -p Linger`), so it runs without a login.
- Logs: `journalctl --user -u consuls-daemon -f`.

## Machines to watch

```sh
~/.local/bin/consuls-daemon add-host spark2 consulear
~/.local/bin/consuls-daemon add-host mbas-macbook-pro matthewabbott
~/.local/bin/consuls-daemon hosts
systemctl --user restart consuls-daemon
```

Its own machine is refused: it's already watched as `@local`, and watching it twice would
push everything twice.

### Tailscale SSH policy

The daemon reaches the other machines with Tailscale SSH. Tailscale's default SSH rule is in
**check** mode: it asks you to approve in a browser, and asks again every 12 h. That stalls an
unattended daemon, which shows "waiting for Tailscale SSH approval".
- The daemon logs the approval link, pushes it to your phone, and the phone app shows an
  **Approve** button.
- To stop it asking, change your SSH rule in the admin console (Access controls) to one of:
  - `"action": "accept"` for `autogroup:member` → `autogroup:self`;
  - keep `"check"` and add `"checkPeriod": "168h"`: then you approve once a week, from the
    notification.

A rule can't single out one untagged machine as the source.

## HTTPS on the tailnet

The phone reaches the app at `https://spark-d683.<tailnet>.ts.net`, through `tailscale serve`.
It terminates TLS with the tailnet's certificate, and tells the daemon who's asking.

1. In the admin console's **DNS** page, turn on **MagicDNS** and **HTTPS Certificates**.
2. On spark-d683, once: `sudo tailscale set --operator=consulear`.
3. Then: `tailscale serve --bg --https=443 http://127.0.0.1:8787`.
4. Check it with `tailscale serve status`.

Notes:
- Only the machine's owner gets in. The daemon checks the `Tailscale-User-Login` header against
  `ownerLogins` (default: the machine's owner).
- The daemon itself only listens on 127.0.0.1.
- The certificate puts the machine's `ts.net` name in public certificate-transparency logs.

## The phone

1. Keep the Tailscale app connected (its On-Demand rules can do that for `*.ts.net`).
2. Open `https://spark-d683.<tailnet>.ts.net` in Safari, then Share → **Add to Home Screen**.
3. Open Consuls from the Home Screen and tap **Enable notifications**, then **Send test**.
4. Flip the switch on the agents you want to hear from.

This needs iOS 16.4 or later. Pushes only work from the Home Screen app, not a Safari tab.

Removing the app from the Home Screen ends its subscription, so enable notifications again
after adding it back. The app re-registers itself with the daemon every time it opens.

## Files

The data folder is `~/.local/share/consuls-daemon/`, or `$CONSULS_DAEMON_DIR`:

| File | What |
|---|---|
| `config.json`, `known_hosts.json` | The machines to watch, and their pinned host keys (the core's own). |
| `daemon.json` | Optional settings: `listen`, `ownerLogins`, `publicOrigin`, `needsInputSecs`, `finishedSecs`, `allowOrigins`. |
| `vapid.json` | The daemon's push identity. **Never delete it**: every phone's subscription is bound to it. |
| `subscriptions.json` | The phones that enabled notifications. |

## Troubleshooting

- **No push at all:**
  - Is the agent tracked? Is a phone subscribed? The app's footer counts devices.
  - Does the agent report through hooks? Agents Consuls starts do. Hand-started ones only do
    with the global hook integration (the bell button on a machine in the desktop app).
- **A push you'd seen anyway:** a desktop app older than the push daemon doesn't write
  `@chm_seen`. Update it.
- **"not yours" (403):** open the app from your own device, through `tailscale serve`, not
  `127.0.0.1:8787`.
- **The test push fails:** check the machine can reach the push service:
  `curl -sI https://web.push.apple.com`.
- **A phone stopped getting pushes:** its subscription expired, and the daemon forgets
  subscriptions the push service says are gone. Open the app and enable notifications again.

## Removing it

```sh
systemctl --user disable --now consuls-daemon
tailscale serve --https=443 off
rm -rf ~/.local/bin/consuls-daemon ~/.config/systemd/user/consuls-daemon.service ~/.local/share/consuls-daemon
```

Tracked panes keep their `@chm_notify`, which is harmless. Untrack them in the app if you like.
