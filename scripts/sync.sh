#!/bin/bash
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SELF="$REPO/scripts/sync.sh"
STATE="${MEMORY_SYNC_STATE:-$HOME/.local/state/memory-store}"
LOG="$STATE/sync.log"
LOCK="$STATE/lock"
PENDING="$STATE/pending"
MATCH="${MEMORY_SYNC_MATCH:-/memory/[^/ ]+\.md|CLAUDE\.md|Obsidian Vault/|/Archive/}"
LABEL="${MEMORY_SYNC_LABEL:-memory-store.sync}"
INTERVAL="${MEMORY_SYNC_INTERVAL:-900}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p "$STATE"

node_bin() {
  command -v node 2>/dev/null || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1
}

trim_log() {
  [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 1048576 ] && tail -c 524288 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  return 0
}

take_lock() {
  mkdir "$LOCK" 2>/dev/null && return 0
  [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null && return 1
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null
}

run() {
  if ! take_lock; then
    touch "$PENDING"
    return 0
  fi
  echo $$ >"$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
  trim_log
  local node
  node="$(node_bin)"
  while :; do
    rm -f "$PENDING"
    (cd "$REPO" && "$node" src/seed.mjs --quiet) >>"$LOG" 2>&1 || echo "$(date -u +%FT%TZ) seed failed" >>"$LOG"
    [ -f "$PENDING" ] || break
  done
}

background() {
  nohup "$SELF" run </dev/null >/dev/null 2>&1 &
}

hook() {
  local target
  target="$(jq -r '.tool_input | (.file_path // .notebook_path // .command // "")' 2>/dev/null)"
  if printf '%s' "$target" | grep -Eq "$MATCH"; then background; fi
  return 0
}

install_launchd() {
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SELF</string><string>run</string></array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$plist" && echo "loaded $LABEL every ${INTERVAL}s, log $LOG"
}

uninstall_launchd() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" && echo "removed $LABEL"
}

case "${1:-run}" in
  run) run ;;
  bg) background ;;
  hook) hook ;;
  install) install_launchd ;;
  uninstall) uninstall_launchd ;;
  *) echo "usage: $0 run|bg|hook|install|uninstall" >&2; exit 2 ;;
esac
