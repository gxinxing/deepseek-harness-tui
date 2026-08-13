# deepseek-harness-tui

**An interactive terminal chat for DeepSeek Harness — terminal-native style, built with Ink (React for terminals).**

Give it a TokenDance key and a `dsh` install; run `dsh --profile tui` and you get a zero-chrome terminal chat with DeepSeek models: bottom-anchored transcript, tool calls folded into cells, thinking folding, and a theme that adapts to your terminal via OSC 11. It's a thin, readable plugin (~800 lines of UI) — not a re-implementation of the harness.

[English](README.md) · [简体中文](README.zh-CN.md)

[![GitHub stars](https://img.shields.io/github/stars/gxinxing/deepseek-harness-tui)](https://github.com/gxinxing/deepseek-harness-tui)
[![License](https://img.shields.io/github/license/gxinxing/deepseek-harness-tui)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/dsh-0.1.0--rc.6-blue)](https://github.com/deepseek-ai/deepseek-harness)

![deepseek-harness-tui running in a terminal](assets/screenshot.png)

## Install

Requires **Node.js ≥ 20** and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) CLI:

```bash
npm install -g @deepseek-ai/dsh        # the harness (no Homebrew tap yet)
git clone https://github.com/gxinxing/deepseek-harness-tui
cd deepseek-harness-tui && pnpm install
```

Wire the plugin bundle into the `tui` profile (one-time):

```bash
dsh plugin --profile tui add @deepseek-ai/dsh-headless
dsh plugin --profile tui add /path/to/deepseek-harness-tui
```

## Use

```bash
export TOKENDANCE_API_KEY=sk-...   # or add it to ~/.dsh/.credentials.yaml (0600)
dsh --profile tui                  # open the TUI
```

In the TUI: `ctrl + t` folds the thinking trace, `esc` interrupts the running turn, `/help` shows all keys and commands.

## What it does

- **Terminal-native UI, not a re-skinned echo.** The transcript is the surface — no boxes, no chrome. The DeepSeek brand banner (ANSI Shadow logo, gradient) greets you only on the empty state; model · cwd live in a dim footer.
- **Tool calls fold into cells.** `⠋ Running <cmd>` while active → `✓ <cmd> • 1.2s` (or `✗` on error), with output merged into the cell, dimmed, and truncated head + tail (`… +N lines`). No interleaved wall of raw output.
- **Theme derived from your terminal.** OSC 11 probes the real background: message tints and code chips are blended from it (12% white over dark, 4% black over light) — never hardcoded hex. Force a theme with `DSH_TUI_BG=#ffffff` for testing.
- **Thinking you can fold.** `ctrl + t` toggles the reasoning trace; `esc` aborts the turn at any time via `agent.cancel({ kind: 'user' })`.
- **Markdown that keeps its shape.** Headers keep their `#`, fenced blocks keep their fences, inline code gets a subtle chip — and CJK/emoji wrap at correct character widths with an aligned gutter.
- **A live viewport.** The transcript is bottom-anchored; the tail is always visible. Busy state shows a braille spinner + compact elapsed timer (`Working 5s`).

## Learn more

- [INTEGRATION-NOTES.md](INTEGRATION-NOTES.md) — event shapes, patch semantics, and the integration deep-dive (how `session/event` maps to the UI)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the underlying agent framework
- [Model routing (TokenDance)](README.md#model-routing-tokendance) — gateway config, credentials, and the one-time tool-call guard

## Model routing (TokenDance)

The profile patch (`cordis.patch.yml`) routes `llm-deepseek` through the TokenDance gateway:

```yaml
llm-deepseek:
  apiKeyEnv: TOKENDANCE_API_KEY
  baseURL: https://tokendance.space/gateway/v1
```

The provider is registered in `~/.dsh/settings.yaml` (`llm-pi-ai.providers.tokendance`): OpenAI-compatible endpoint, `thinkingFormat: deepseek`, models `deepseek-v4-flash` (default) and `deepseek-v4-pro`. Switch models by editing the provider's `models` list or overriding `llm-deepseek.model` in your profile patch.

> **Prerequisite fix (one-time, per dsh install).** TokenDance streams subsequent tool-call deltas with empty `name`/`id`; the stock `@deepseek-ai/dsh-llm-deepseek` adapter overwrites the first frame's call id with `""` and the harness loops on `unknown tool ""`. Apply the guard in `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`:
>
> ```diff
> - if (call.id !== void 0) block.callId = call.id
> + if (call.id) block.callId = call.id
> - ... if (call.function?.name !== void 0) ...
> + ... if (call.function?.name) ...
> ```
>
> Applied 2026-08-13 on this machine. The edit lives in the global dsh install and is **lost on `dsh` upgrade** — re-apply after upgrading (worth an upstream PR).

## Self-inspection · Self-repair · Self-update loop

This project ships a complete automated quality gate — **inspect → repair → update — closed loop**:

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Local dev   │    │  Pre-commit  │    │  CI / PR     │
│  pnpm check  │───▶│  lint-staged │───▶│  ci.yml      │
│  (one-shot)  │    │  (git commit)│    │  (GitHub)    │
└──────────────┘    └──────────────┘    └──────────────┘
      ▲                                       │
      │                                       ▼
      │                            ┌──────────────────────┐
      │                            │  lint + format:check  │
      │                            │  + test (Node 20/22)  │
      │                            └──────────────────────┘
      │                                       │
      ▼                                       ▼
┌──────────────────────────────────────────────────────────┐
│          deps.yml  (auto-scan every Mon 06:00 UTC)        │
│  Update found → auto PR → review & merge → closed loop   │
└──────────────────────────────────────────────────────────┘
```

### Local inspection

```bash
pnpm check        # all-in-one: lint → format:check → test
pnpm lint         # code quality (ESLint)
pnpm format:check # style gate (Prettier)
pnpm test         # unit tests (Node built-in runner, 57 cases)
```

### Local self-repair

```bash
pnpm lint:fix     # auto-fix all fixable ESLint issues
pnpm format       # auto-format all source files
```

**On every `git commit`** (husky + lint-staged):
- staged `*.js` files → `prettier --write` + `eslint --fix` before the commit lands
- committed code is always clean — no manual `pnpm format` needed

### Dependency self-update

```bash
pnpm deps:check   # scan all deps for available upgrades (grouped + audit)
pnpm deps:update  # bump package.json to latest compatible + pnpm install
```

**GitHub Actions auto-runs** (`.github/workflows/deps.yml`):
- Every Monday 06:00 UTC
- Creates a `deps/auto-update-YYYYMMDD` branch + PR when updates exist
- Manual trigger available from the GitHub Actions tab

### CI gate (`.github/workflows/ci.yml`)

| Trigger | Job | Matrix |
|---------|-----|--------|
| `push` / `pull_request` to main | `inspect` | Node 20 + Node 22 |
| | lint | ✅ |
| | format:check | ✅ |
| | test (57 cases) | ✅ |
| | coverage upload | Node 22 only |

Any stage failure blocks the merge — main is always green.

## Contributing

Issues and PRs are welcome. Good first tasks: upstream the two runtime patches (TokenDance tool-call guard, grep permission-error tolerance), add a screenshot for light themes, or port the welcome banner to other model providers. See [INTEGRATION-NOTES.md](INTEGRATION-NOTES.md) before touching the event bridge.

## License

[MIT](LICENSE). An independent community project, not affiliated with DeepSeek or TokenDance.
