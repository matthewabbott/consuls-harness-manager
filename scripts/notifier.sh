#!/bin/sh
# Runs the notifier (consuls-notifier) on a machine for a while, from this Mac. Nothing is
# installed there and nothing restarts it: it lives in a private tmux server, keeps its
# configuration in memory, and removes its folder (/tmp/consuls-<uid>, binary included) when it
# stops — when told to, at reboot, or after its lease (7 days without a check-in). See
# docs/NOTIFIER.md.
#
#   scripts/notifier.sh start [host]          build, upload, start and configure it
#   scripts/notifier.sh restart [host]        pull, stop, start (a new build)
#   scripts/notifier.sh stop [host]           pull, then stop it
#   scripts/notifier.sh renew [host] [days]   check in: the lease runs from now
#   scripts/notifier.sh status [host]
#   scripts/notifier.sh pull [host]           save its configuration here (phones added since)
#   scripts/notifier.sh log [host]            its recent output
#   scripts/notifier.sh import <host> <dir>   a configuration from the old push daemon's files
#
# host defaults to spark-d683. The configuration, push key included, is kept on this Mac only:
# ~/.config/consuls-notifier/<host>.json (0600); it reaches the notifier over SSH's stdin.
# NOTIFIER_USER (default consulear) is the SSH user, NOTIFIER_TARGET (default
# aarch64-unknown-linux-gnu.2.39) the Rust target and glibc version. Builds need zig and
# cargo-zigbuild (brew install zig; cargo install --locked cargo-zigbuild).
set -eu

VERB=${1:-}
HOST=${2:-spark-d683}
LOGIN=${NOTIFIER_USER:-consulear}
TARGET=${NOTIFIER_TARGET:-aarch64-unknown-linux-gnu.2.39}
TRIPLE=${TARGET%.*.*}
DEST="$LOGIN@$HOST"
KEEP="$HOME/.config/consuls-notifier"
CUSTODY="$KEEP/$HOST.json"
TMUX_NAME=consuls-notifier
cd "$(dirname "$0")/.."

# Run on the machine (by its login shell). Every remote script starts with this.
PRELUDE='D=/tmp/consuls-$(id -u); N="$D/bin/consuls-notifier"
T=$(command -v tmux || ls /opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux 2>/dev/null | head -n 1)'

remote() {
  ssh "$DEST" "$PRELUDE
$1"
}

running() {
  remote '[ -x "$N" ] && "$N" ctl status >/dev/null 2>&1'
}

pull() {
  umask 077
  mkdir -p "$KEEP" && chmod 700 "$KEEP"
  if ! remote '"$N" ctl export' >"$CUSTODY.new" || ! grep -q '"privateKey"' "$CUSTODY.new"; then
    rm -f "$CUSTODY.new"
    echo "couldn't read the configuration from the notifier on $HOST" >&2
    return 1
  fi
  [ -f "$CUSTODY" ] && cp -p "$CUSTODY" "$CUSTODY.bak"
  mv "$CUSTODY.new" "$CUSTODY"
  echo "saved its configuration to $CUSTODY"
}

stop() {
  remote '
    "$N" ctl stop >/dev/null 2>&1 || { [ -n "$T" ] && "$T" -L '"$TMUX_NAME"' kill-server 2>/dev/null; } || true
    i=0
    while [ -e "$D" ] || { [ -n "$T" ] && "$T" -L '"$TMUX_NAME"' has-session 2>/dev/null; }; do
      i=$((i + 1))
      if [ $i -gt 50 ]; then echo "it did not stop within 10 s" >&2; exit 1; fi
      sleep 0.2
    done'
  echo "stopped the notifier on $HOST: nothing of it is left there"
}

build() {
  npm run build:phone
  cargo zigbuild -p chm-daemon --bin consuls-notifier --profile notifier --target "$TARGET"
}

start() {
  [ -f "$CUSTODY" ] || { echo "no configuration for $HOST at $CUSTODY (see 'import')" >&2; exit 1; }
  if running; then
    echo "a notifier is already running on $HOST (restart replaces it)" >&2
    exit 1
  fi
  build
  # Into a folder only we can use: refuse one that's someone else's or a symlink.
  remote '
    umask 077
    if [ -e "$D" ] || [ -L "$D" ]; then
      owner=$(stat -c %u "$D" 2>/dev/null || stat -f %u "$D")
      if [ -L "$D" ] || [ ! -d "$D" ] || [ "$owner" != "$(id -u)" ]; then echo "$D is not ours" >&2; exit 1; fi
    fi
    mkdir -p "$D/bin" && chmod 700 "$D" "$D/bin"
    cat >"$N.new" && chmod 700 "$N.new" && mv -f "$N.new" "$N"' <"target/$TRIPLE/notifier/consuls-notifier"
  remote '
    [ -n "$T" ] || { echo "no tmux on this machine" >&2; exit 1; }
    env -u TMUX -u TMUX_PANE "$T" -L '"$TMUX_NAME"' -f /dev/null new-session -d -s notifier -x 160 -y 50 \
      "exec env -u TMUX -u TMUX_PANE CONSULS_TMUX_NAME='"$TMUX_NAME"' MALLOC_ARENA_MAX=2 RUST_LOG=info,russh=warn $N run"
    i=0
    while [ ! -S "$D/ctl.sock" ]; do
      i=$((i + 1))
      if [ $i -gt 50 ]; then echo "it did not start" >&2; "$T" -L '"$TMUX_NAME"' capture-pane -p -t notifier 2>/dev/null; exit 1; fi
      sleep 0.2
    done
    exec "$N" ctl configure' <"$CUSTODY"
  echo "started the notifier on $HOST"
  remote '"$N" ctl status'
}

case "$VERB" in
  start) start ;;
  restart)
    if running; then
      pull
      stop
    fi
    start
    ;;
  stop)
    if running; then pull; fi
    stop
    ;;
  renew)
    case ${3:-7} in *[!0-9]*) echo "days must be a number" >&2; exit 2 ;; esac
    remote '"$N" ctl renew '"${3:-}"
    ;;
  status) remote '"$N" ctl status 2>/dev/null || { echo "no notifier running" >&2; exit 1; }' ;;
  pull) pull ;;
  log) remote '"$T" -L '"$TMUX_NAME"' capture-pane -p -J -t notifier -S -200 | sed "/^$/d"' ;;
  import)
    [ $# -eq 3 ] || { echo "usage: $0 import <host> <dir>" >&2; exit 2; }
    [ -e "$CUSTODY" ] && { echo "$CUSTODY exists already" >&2; exit 1; }
    umask 077
    mkdir -p "$KEEP" && chmod 700 "$KEEP"
    cargo run -q -p chm-daemon --bin consuls-notifier -- import-legacy "$3" >"$CUSTODY.new"
    mv "$CUSTODY.new" "$CUSTODY"
    echo "wrote $CUSTODY"
    ;;
  *)
    sed -n '8,15p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
