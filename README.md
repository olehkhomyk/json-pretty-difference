# JSON Diff

A private, offline macOS JSON formatter and semantic comparison tool built with Rust and Tauri 2.

## Install on macOS

Apple Silicon Macs (M1 or newer):

```sh
curl -fsSL https://raw.githubusercontent.com/olehkhomyk/json-pretty-difference/main/install.sh | zsh
```

The installer downloads the prebuilt app, verifies its code signature, installs it into `/Applications` (or `~/Applications` when needed), and opens it. JSON Diff does not upload JSON or require a server.

## Features

- One-editor formatter mode on launch
- Automatic validation and two-space pretty printing
- Rainbow bracket pairs, active pair highlighting, and JSON syntax highlighting
- Collapsible objects and arrays with original line numbers preserved
- Difference toggle with side-by-side editors
- Optional line-by-line synchronized scrolling
- Semantic object comparison (object key order is ignored)
- Added, removed, and changed line highlighting
- Collapsed-by-default difference object with JSON paths
- Drag-and-drop and local `.json` file opening
- No server, analytics, uploads, or network requests
- No Node/npm dependency: the frontend is static and the logic runs in Rust

## Run in development

```sh
cargo run --manifest-path src-tauri/Cargo.toml
```

## Run tests

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```

## Build the macOS app

Install the official Tauri CLI once:

```sh
cargo install tauri-cli --version '^2' --locked
```

Then build and ad-hoc sign the local application:

```sh
./scripts/build-app.sh
```

The application will be created at `dist/JSON Diff.app` and ad-hoc signed for local use.

## Privacy model

All parsing and comparison happens inside the local application. The Tauri content security policy only permits application-owned resources, and the app contains no HTTP client, analytics SDK, or remote scripts.

