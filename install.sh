#!/bin/zsh
set -euo pipefail

APP_NAME="JSON Diff.app"
ARCHIVE_NAME="JSON-Diff-macOS-arm64.zip"
DOWNLOAD_URL="https://raw.githubusercontent.com/olehkhomyk/json-pretty-difference/main/release/$ARCHIVE_NAME"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "JSON Diff installer supports macOS only." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This build requires an Apple Silicon Mac (M1 or newer)." >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

ARCHIVE_PATH="$TEMP_DIR/$ARCHIVE_NAME"
EXTRACT_PATH="$TEMP_DIR/extracted"

echo "Downloading JSON Diff…"
curl --fail --location --silent --show-error --retry 3 \
  "$DOWNLOAD_URL" \
  --output "$ARCHIVE_PATH"

mkdir -p "$EXTRACT_PATH"
ditto -x -k "$ARCHIVE_PATH" "$EXTRACT_PATH"

SOURCE_APP="$EXTRACT_PATH/$APP_NAME"
if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Downloaded archive does not contain $APP_NAME." >&2
  exit 1
fi

codesign --verify --deep --strict "$SOURCE_APP"

if [[ -w "/Applications" ]]; then
  INSTALL_DIR="/Applications"
else
  INSTALL_DIR="$HOME/Applications"
  mkdir -p "$INSTALL_DIR"
fi

DESTINATION="$INSTALL_DIR/$APP_NAME"
BACKUP_APP="$TEMP_DIR/previous-$APP_NAME"

if [[ -d "$DESTINATION" ]]; then
  mv "$DESTINATION" "$BACKUP_APP"
fi

if ! ditto "$SOURCE_APP" "$DESTINATION"; then
  if [[ -d "$BACKUP_APP" ]]; then
    mv "$BACKUP_APP" "$DESTINATION"
  fi
  echo "Could not install JSON Diff." >&2
  exit 1
fi

echo "Installed JSON Diff to $DESTINATION"
open "$DESTINATION"

