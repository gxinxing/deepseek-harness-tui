<p align="center"><strong>deepseek-harness-tui</strong> is an interactive terminal chat for the <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> (dsh) — a Codex CLI–style experience built with <a href="https://github.com/vadimdemedes/ink">Ink</a> (React for terminals).

<p align="center">
  <img src="assets/screenshot.png" alt="deepseek-harness-tui splash" width="80%" />
</p>

</br>
Install the harness (<code>dsh</code>) plus this plugin bundle, run <code>dsh --profile tui</code>, and you get a zero-chrome terminal chat with DeepSeek models: bottom-anchored transcript, tool calls folded into cells, thinking folding, and a theme that adapts to your terminal via OSC 11.</p>

---

## What is this?

`deepseek-harness-tui` is a Cordis plugin bundle that mounts an Ink chat UI on top of the DeepSeek Harness agent. The harness provides the model routing, tool-calling and session engine; this bundle provides the chat interface — the same division of labor as Codex CLI (engine + TUI).

- **Engine**: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`, Node.js ≥ 20)
- **UI**: [Ink](https://github.com/vadimdemedes/ink) + React, ~800 lines in `src/ui.js`
- **Model route**: [TokenDance](https://tokendance.space) gateway → `deepseek-v4-flash` (default)

## Features

- **Zero-chrome design** — the transcript is the surface; the DeepSeek brand banner (ANSI Shadow logo, gradient) appears only on the empty state.
- **Bottom-anchored transcript** — the live viewport always keeps the latest content visible.
- **Tool cells** — a running tool shows `⠋ Running <cmd>`, then settles to `✓ <cmd> • 1.2s` (or `✗` on error); output is merged into the cell, dimmed, and truncated head + tail with a `… +N lines` marker.
- **OSC 11 theme derivation** — user-message tints and inline-code chips are blended from your terminal's actual background, so it looks right in dark and light themes (`DSH_TUI_BG` forces a theme for testing).
- **Thinking folding** — `ctrl + t` toggles the reasoning trace.
- **Esc interrupt** — abort the running turn at any time.
- **Markdown rendering** — headers keep their `#`, fenced code blocks keep their fences, inline code gets a subtle chip.
- **CJK-aware wrapping** — correct character widths for CJK and emoji, continuation lines align to the gutter.

## Quickstart

### 1. Prerequisites

- **Node.js ≥ 20** (check: `node --version`)
- **pnpm** for the local dev bundle (check: `pnpm --version`)
- A **TokenDance** API key (`sk-...`)

### 2. Install DeepSeek Harness

```shell
npm install -g @deepseek-ai/dsh
```

Verify:

```shell
dsh --version    # 0.1.0-rc.6+
```

> **Homebrew**: there is no official `brew` tap yet — use the npm install above. Alternatives: run without installing (`npx @deepseek-ai/dsh web`), or build [from source](https://github.com/deepseek-ai/deepseek-harness) (`pnpm install && pnpm run build && pnpm dsh web`).

### 3. Install deepseek-harness-tui

```shell
git clone https://github.com/gxinxing/deepseek-harness-tui
cd deepseek-harness-tui && pnpm install
```

Wire the plugin bundle into the `tui` profile (one-time):

```shell
dsh plugin --profile tui add @deepseek-ai/dsh-headless
dsh plugin --profile tui add /path/to/deepseek-harness-tui
```

> The first command installs the headless agent engine into the profile; the second mounts this chat UI on top of it. Point `/path/to/...` at your checkout.

### 4. Configure TokenDance

Provide your key in either way:

```shell
# Option A: environment variable
export TOKENDANCE_API_KEY=sk-...
```

```yaml
# Option B: credentials file (~/.dsh/.credentials.yaml, mode 0600)
TOKENDANCE_API_KEY: sk-...
```

The provider and default model (`deepseek-official/deepseek-v4-flash`) come from `~/.dsh/settings.yaml` — see [Model routing](#model-routing-tokendance).

### 5. Run

```shell
dsh --profile tui
```

You should see the DeepSeek banner and the `❯ Ask anything` prompt. Type a message and press Enter — the turn shows `Working` with a spinner while the model responds.

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

## Model routing (TokenDance)

The profile patch (`cordis.patch.yml`) routes `llm-deepseek` through the TokenDance gateway:

```yaml
llm-deepseek:
  apiKeyEnv: TOKENDANCE_API_KEY
  baseURL: https://tokendance.space/gateway/v1
```

### Provider & models

The TokenDance provider is registered in `~/.dsh/settings.yaml` (`llm-pi-ai.providers.tokendance`): OpenAI-compatible endpoint, `thinkingFormat: deepseek`, models `deepseek-v4-flash` (default) and `deepseek-v4-pro`. To switch models, edit the provider's `models` list there, or override `llm-deepseek.model` in your profile patch.

### Prerequisite fix (one-time, per dsh install)

TokenDance streams subsequent tool-call deltas with empty `name`/`id`; the stock `@deepseek-ai/dsh-llm-deepseek` adapter overwrites the first frame's call id with `""` and the harness loops on `unknown tool ""`. Apply the guard in `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`:

```diff
- if (call.id !== void 0) block.callId = call.id
+ if (call.id) block.callId = call.id
- ... if (call.function?.name !== void 0) ...
+ ... if (call.function?.name) ...
```

Applied 2026-08-13 on this machine. This edit lives in the global dsh install and is **lost on `dsh` upgrade** — re-apply after upgrading (worth an upstream PR).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `unknown tool ""` loop or tool cells stuck on `Running` | The prerequisite fix above was lost — re-apply it after any `dsh` upgrade. |
| Empty responses / auth errors | Check `TOKENDANCE_API_KEY` is exported or present in `~/.dsh/.credentials.yaml` (mode `0600`). |
| `dsh: command not found` | `npm install -g @deepseek-ai/dsh` again; make sure npm's global `bin` dir is on `PATH`. |
| Colors look wrong | Force a theme: `DSH_TUI_BG=#ffffff dsh --profile tui` (light) or `#000000` (dark). |
| Banner not showing | The banner is the empty state — it disappears once the first message is sent. |

## Docs

- [**INTEGRATION-NOTES**](./INTEGRATION-NOTES.md) — event shapes, patch semantics, integration deep-dive.
- [**DeepSeek Harness**](https://github.com/deepseek-ai/deepseek-harness) — the underlying agent framework.

## License

This repository is licensed under the [MIT License](LICENSE). © 2026 gxinxing.
