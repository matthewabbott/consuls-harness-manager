#!/bin/sh
# The Consuls server (consuls-server) on one of your machines, from this Mac: it serves the phone's
# web app and pushes notifications. Nothing restarts it: it runs in a private tmux server until
# it's stopped, the machine reboots, or a week passes unused. Its install folder
# (~/.local/share/consuls-server) stays, so it can be started again from anywhere — over SSH from
# a phone: ~/.local/share/consuls-server/consuls-server start. See docs/SERVER.md.
#
#   scripts/server.sh install [host]     build and upload (and the config, if it has none yet)
#   scripts/server.sh start [host]
#   scripts/server.sh restart [host]     install a new build, then stop and start
#   scripts/server.sh stop [host]        pull, then stop (its files stay)
#   scripts/server.sh status [host]
#   scripts/server.sh log [host]         the current run's log
#   scripts/server.sh pull [host]        save its configuration here (machines, phones)
#   scripts/server.sh uninstall [host]   pull, then remove everything it keeps there
#
# host defaults to spark-d683. The configuration, push key included, is kept here too:
# ~/.config/consuls-server/<host>.json (0600). SERVER_USER (default consulear) is the SSH user,
# SERVER_TARGET (default aarch64-unknown-linux-gnu.2.39) the Rust target and glibc version.
# Builds need zig and cargo-zigbuild (brew install zig; cargo install --locked cargo-zigbuild).
set -eu

VERB=${1:-}
HOST=${2:-spark-d683}
LOGIN=${SERVER_USER:-consulear}
TARGET=${SERVER_TARGET:-aarch64-unknown-linux-gnu.2.39}
TRIPLE=${TARGET%.*.*}
DEST="$LOGIN@$HOST"
KEEP="$HOME/.config/consuls-server"
CUSTODY="$KEEP/$HOST.json"
cd "$(dirname "$0")/.."

# Every remote script starts with this: its install folder, made private if it isn't there yet.
PRELUDE='H="$HOME/.local/share/consuls-server"; S="$H/consuls-server"'

remote() {
  ssh "$DEST" "$PRELUDE
$1"
}

pull() {
  umask 077
  mkdir -p "$KEEP" && chmod 700 "$KEEP"
  if ! remote '"$S" ctl export' >"$CUSTODY.new" 2>/dev/null || ! grep -q '"privateKey"' "$CUSTODY.new"; then
    rm -f "$CUSTODY.new"
    echo "the server on $HOST isn't running: kept the configuration saved here before" >&2
    return 0
  fi
  [ -f "$CUSTODY" ] && cp -p "$CUSTODY" "$CUSTODY.bak"
  mv "$CUSTODY.new" "$CUSTODY"
  echo "saved its configuration to $CUSTODY"
}

install() {
  [ -f "$CUSTODY" ] || { echo "no configuration for $HOST at $CUSTODY" >&2; exit 1; }
  npm run build:web
  cargo zigbuild -p chm-daemon --bin consuls-server --profile server --target "$TARGET"
  # Into a folder only we can use: refuse one that's someone else's or a symlink.
  remote '
    umask 077
    if [ -e "$H" ] || [ -L "$H" ]; then
      owner=$(stat -c %u "$H" 2>/dev/null || stat -f %u "$H")
      if [ -L "$H" ] || [ ! -d "$H" ] || [ "$owner" != "$(id -u)" ]; then echo "$H is not ours" >&2; exit 1; fi
    fi
    mkdir -p "$H" && chmod 700 "$H"
    cat >"$S.new" && chmod 700 "$S.new" && mv -f "$S.new" "$S"' <"target/$TRIPLE/server/consuls-server"
  # The config only when it has none: from then on the server's own (machines added from the
  # app, phones) is the one that's current; `pull` brings it here.
  remote '
    umask 077
    if [ -e "$H/config.json" ]; then cat >/dev/null; echo "kept its config.json"; else cat >"$H/config.json" && echo "wrote its config.json"; fi' <"$CUSTODY"
  echo "installed on $HOST: $(remote '"$S" --version')"
}

case "$VERB" in
  install) install ;;
  start) remote '"$S" start' ;;
  restart)
    install
    pull
    remote '"$S" stop; "$S" start'
    ;;
  stop)
    pull
    remote '"$S" stop'
    ;;
  status) remote '"$S" status' ;;
  log) remote '"$S" log' ;;
  pull) pull ;;
  uninstall)
    pull
    remote '"$S" uninstall'
    ;;
  *)
    sed -n '8,15p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
