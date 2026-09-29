#!/bin/sh
# Builds the push daemon on this machine (never on the target: it may be short of memory) and
# (re)starts it there as a systemd user service. See docs/DAEMON.md.
#
#   scripts/deploy-daemon.sh [host]
#
# host defaults to spark-d683; DAEMON_USER (default consulear) is the SSH user, DAEMON_TARGET
# (default aarch64-unknown-linux-gnu.2.39) the Rust target and glibc version. Needs zig and
# cargo-zigbuild (brew install zig; cargo install --locked cargo-zigbuild).
set -eu

HOST=${1:-spark-d683}
USER=${DAEMON_USER:-consulear}
TARGET=${DAEMON_TARGET:-aarch64-unknown-linux-gnu.2.39}
TRIPLE=${TARGET%.*.*}
cd "$(dirname "$0")/.."

npm run build:phone
cargo zigbuild -p chm-daemon --release --target "$TARGET"

ssh "$USER@$HOST" 'mkdir -p ~/.local/bin ~/.config/systemd/user'
scp -q "target/$TRIPLE/release/consuls-daemon" "$USER@$HOST:.local/bin/consuls-daemon.new"
scp -q scripts/consuls-daemon.service "$USER@$HOST:.config/systemd/user/consuls-daemon.service"
ssh "$USER@$HOST" '
  set -e
  chmod +x ~/.local/bin/consuls-daemon.new
  mv ~/.local/bin/consuls-daemon.new ~/.local/bin/consuls-daemon
  systemctl --user daemon-reload
  systemctl --user enable consuls-daemon >/dev/null 2>&1
  systemctl --user restart consuls-daemon
  sleep 3
  systemctl --user --no-pager --lines=8 status consuls-daemon || true
'
