# deepseek-harness-tui

<p align="center">
  <img src="assets/screenshot.png" alt="deepseek-harness-tui — DeepSeek Harness terminal chat" width="720">
</p>

Interactive terminal chat for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a Codex CLI–style chat experience, built with [Ink](https://github.com/vadimdemedes/ink).

deepseek-harness-tui is a Cordis plugin bundle that mounts an Ink chat UI on top of the DeepSeek Harness agent: zero-chrome, bottom-anchored transcript, live status row, single-line composer. Colors are terminal-default plus semantic accents (`cyan` activity, `green` success, `red` errors, `magenta` brand, `dim` secondary), and message tints are derived from your terminal's actual background via OSC 11 — it looks right in any theme.

## Features

- **Zero-chrome design** — no boxes, no panels; the transcript is the surface.
- **Bottom-anchored transcript** — a live viewport that always keeps the tail visible.
- **Tool cells** — tool calls fold into a single cell: `⠋ Running <cmd>` while active, then `✓ <cmd> • 1.2s` (or `✗` on error); output is merged into the cell, dimmed, and truncated to head + tail with a `… +N lines` marker.
- **OSC 11 theme derivation** — the terminal background is probed (light/dark adaptive); user-message tints and inline-code chips are blended from it, never hardcoded.
- **Thinking folding** — `ctrl + t` toggles the reasoning trace.
- **Esc interrupt** — abort the running turn at any time.
- **Markdown rendering** — headers keep their `#` prefixes, fenced code blocks keep their fences, inline code gets a subtle chip.
- **CJK-aware wrapping** — continuation lines indent to the same gutter column with correct CJK character widths.
- **Brand welcome screen** — the empty state shows the DeepSeek block logo mark plus a tagline.
- **Status row** — braille spinner + compact elapsed timer (`Working 5s`) + `esc interrupt` hint while busy.

## Installing DeepSeek Harness

dsh-tui runs on top of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — install it first (pick one):

- **npm (recommended)** — global CLI:

  ```sh
  npm install -g @deepseek-ai/dsh
  dsh --version        # 0.1.0-rc.6+
  ```

- **npx** — run without installing:

  ```sh
  npx @deepseek-ai/dsh web    # starts the official Web UI
  ```

- **From source**:

  ```sh
  git clone https://github.com/deepseek-ai/deepseek-harness.git
  cd deepseek-harness
  pnpm install && pnpm run build
  pnpm dsh web
  ```

> **Homebrew:** there is no official `brew` tap yet — use the npm install above.

## Quick start

```sh
# one-time setup: clone + install (the bundle needs its own node_modules)
git clone https://github.com/gxinxing/deepseek-harness-tui
cd deepseek-harness-tui && pnpm install

# one-time wiring (installs the plugin bundle into the tui profile)
dsh plugin --profile tui add @deepseek-ai/dsh-headless
dsh plugin --profile tui add /path/to/deepseek-harness-tui   # the checkout from above

# run
dsh --profile tui
```

If you have a `dsh` launcher alias (e.g. `~/.local/bin/dsh`), plain `dsh` can default to the tui profile — see the `dsh --profile tui` wrapper in your launcher.

**Requirements:** Node ≥ 20, `@deepseek-ai/dsh` 0.1.0-rc.6+, pnpm for local dev (`pnpm install`; the linked bundle needs its own `node_modules`).

## Keys & commands

| Key | Action |
| --- | --- |
| `ctrl + t` | toggle thinking display |
| `esc` | interrupt the running turn |
| `ctrl + c` | quit |

| Command | Action |
| --- | --- |
| `/help` | show help |
| `/clear` | clear the transcript |
| `/exit`, `/quit` | quit |

## Design

The UI is distilled from the Codex CLI TUI (`codex-rs/tui`) and the Hermes Agent TUI. There is no permanent chrome: the transcript is the surface, the brand mark appears only in the empty state, and model · cwd live in a dim footer with key hints on the right. Every row uses a 2-column gutter (`▌ ` user, `› ` composer, `• ` tools/assistant) with continuation lines indented to the same column, so the transcript reads as one aligned stream — with CJK-aware wrapping for mixed-width text.

Tool calls collapse into cells (spinner → `✓`/`✗` + merged, truncated output), thinking folds behind `ctrl + t`, and message tints are blended from the probed terminal background (12% white over dark, 4% black over light) rather than hardcoded hex. While busy, a braille spinner with a compact elapsed timer and an `esc interrupt` hint sits above the composer.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/index.js` | Cordis bundle entry — `tui-runner` plugin: injects the agent services, mounts the Ink UI |
| `src/ui.js` | Ink chat UI: transcript, composer, status row, keys & commands |
| `src/theme.js` | Terminal background probing (OSC 11) + derived message tints |
| `cordis.patch.yml` | Profile patch — disables the headless one-shot rows, inserts `tui-runner` |
| `INTEGRATION-NOTES.md` | Deep dive into dsh integration semantics and live event shapes |
| `package.json` | Plugin manifest — `dsh.bundle.patch` points at the patch file |

## Model routing (TokenDance)

The profile patch (`cordis.patch.yml`) routes `llm-deepseek` through the TokenDance gateway:

```yaml
llm-deepseek:
  apiKeyEnv: TOKENDANCE_API_KEY
  baseURL: https://tokendance.space/gateway/v1
```

### Credentials

Point `TOKENDANCE_API_KEY` at your TokenDance key, either way:

- Environment variable:
  ```sh
  export TOKENDANCE_API_KEY=sk-...
  ```
- Credentials file (`~/.dsh/.credentials.yaml`, mode 0600):
  ```yaml
  TOKENDANCE_API_KEY: sk-...
  ```

### Provider & models

The TokenDance provider is registered in `~/.dsh/settings.yaml` (`llm-pi-ai.providers.tokendance`): OpenAI-compatible endpoint, `thinkingFormat: deepseek`, models `deepseek-v4-flash` and `deepseek-v4-pro`.

Default model: `deepseek-official/deepseek-v4-flash`. To switch models, edit the provider's `models` list in `~/.dsh/settings.yaml` or override `llm-deepseek.model` in your profile patch.

> **Prerequisite fix (one-time, per dsh install).** TokenDance streams subsequent tool-call deltas with empty `name`/`id`; the stock `@deepseek-ai/dsh-llm-deepseek` adapter overwrites the first frame's call id with `""` and the harness loops on `unknown tool ""`. Applied the guard in `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`:
>
> ```diff
> - if (call.id !== void 0) block.callId = call.id
> + if (call.id) block.callId = call.id
> - ... if (call.function?.name !== void 0) ...
> + ... if (call.function?.name) ...
> ```
>
> Applied 2026-08-13 on this machine. This edit lives in the global dsh install and is **lost on `dsh` upgrade** — re-apply after upgrading (worth an upstream PR).

## Debug

- `DSH_TUI_BG=#ffffff dsh --profile tui` — force a light terminal background for theme testing.

Integration semantics (event shapes, patch behavior) are documented in [INTEGRATION-NOTES.md](INTEGRATION-NOTES.md).

## License

MIT — see [LICENSE](LICENSE). © 2026 gxinxing.
