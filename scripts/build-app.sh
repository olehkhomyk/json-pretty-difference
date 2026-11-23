#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
APP_PATH="$PROJECT_DIR/dist/JSON Diff.app"
SOURCE_APP="$PROJECT_DIR/src-tauri/target/release/bundle/macos/JSON Diff.app"

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "Tauri CLI is required. Install it with: cargo install tauri-cli --version '^2' --locked" >&2
  exit 1
fi

cargo tauri build

mkdir -p "$PROJECT_DIR/dist"
if [[ -d "$APP_PATH" ]]; then
  rm -rf "$APP_PATH"
fi
ditto "$SOURCE_APP" "$APP_PATH"

codesign --force --sign - "$APP_PATH"

echo "$APP_PATH"

