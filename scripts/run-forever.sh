#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/slack-error-harness.log"
PID_FILE="$LOG_DIR/slack-error-harness.pid"
LOCK_DIR="$LOG_DIR/slack-error-harness.lock"

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  existing_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] supervisor already running. pid=$existing_pid" >> "$LOG_FILE"
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi

cleanup() {
  rm -rf "$LOCK_DIR"
}

trap cleanup EXIT INT TERM
echo "$$" > "$LOCK_DIR/pid"

load_env() {
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
}

echo "$$" > "$PID_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] supervisor started. pid=$$" >> "$LOG_FILE"

# 봇 전용 mody-server 클론을 1시간마다 최신 main으로 맞춘다.
load_env
if [[ -n "${MODY_REPO_PATH:-}" && -d "$MODY_REPO_PATH/.git" ]]; then
  (
    while true; do
      git -C "$MODY_REPO_PATH" pull -q --ff-only >> "$LOG_FILE" 2>&1 || true
      sleep 3600
    done
  ) &
  REPO_SYNC_PID=$!
  trap 'kill "$REPO_SYNC_PID" 2>/dev/null; cleanup' EXIT INT TERM
fi

while true; do
  load_env
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] bot process starting" >> "$LOG_FILE"
  (
    cd "$ROOT_DIR"
    node src/index.js
  ) >> "$LOG_FILE" 2>&1

  exit_code=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] bot exited. code=$exit_code" >> "$LOG_FILE"
  sleep 5
done
