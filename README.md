# Better Codex Status

A small [Pi](https://pi.dev) extension that adds `/codex-status`.

It asks the authenticated Codex CLI for the current account rate limits and displays a user-only overlay with progress bars for the 5-hour and weekly allowances. The result is not added to the chat or sent to the model.

The other extension(s) had issues and was not updated, so I made this.

## Requirements

- Pi with extension support
- Codex CLI installed and authenticated
- `codex` available on `PATH` (or set `CODEX_CLI` to its executable path)

## Usage

```text
/codex-status
```

Press **Enter** or **Escape** to close the overlay. Use `/reload` after installing or updating the extension in an existing session.

## Install

```bash
pi install https://github.com/zmn-hamid/better-codex-status
```
