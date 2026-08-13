# deepseek-harness-tui

**为 DeepSeek Harness 打造的交互式终端聊天界面——终端原生风格，基于 Ink（React 终端 UI 框架）构建。**

准备一个 TokenDance key 和 `dsh` 安装，运行 `dsh --profile tui` 即可获得一个 zero-chrome 的终端聊天界面：底部锚定对话流、工具调用折叠成 cell、thinking 折叠、背景色经 OSC 11 自适应终端主题。它是一个精简、可读的插件（约 800 行 UI），不是对 harness 的重实现。

[English](README.md) · [简体中文](README.zh-CN.md)

[![GitHub stars](https://img.shields.io/github/stars/gxinxing/deepseek-harness-tui)](https://github.com/gxinxing/deepseek-harness-tui)
[![License](https://img.shields.io/github/license/gxinxing/deepseek-harness-tui)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/dsh-0.1.0--rc.6-blue)](https://github.com/deepseek-ai/deepseek-harness)

![deepseek-harness-tui 终端运行截图](assets/screenshot.png)

## 安装

需要 **Node.js ≥ 20** 和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) CLI：

```bash
npm install -g @deepseek-ai/dsh        # 安装 harness（暂无 Homebrew tap）
git clone https://github.com/gxinxing/deepseek-harness-tui
cd deepseek-harness-tui && pnpm install
```

把插件包装进 `tui` profile（一次性）：

```bash
dsh plugin --profile tui add @deepseek-ai/dsh-headless
dsh plugin --profile tui add /path/to/deepseek-harness-tui
```

## 使用

```bash
export TOKENDANCE_API_KEY=sk-...   # 或写入 ~/.dsh/.credentials.yaml（0600）
dsh --profile tui                  # 打开 TUI
```

TUI 内：`ctrl + t` 折叠 thinking，`esc` 中断当前回合，`/help` 查看全部按键与命令。

## 它能做什么

- **终端原生 UI，而不是换个皮的复读机。** transcript 即界面——无边框、无装饰。DeepSeek 品牌 banner（ANSI Shadow logo，渐变配色）只在空态出现；model · cwd 放在底部 dim footer。
- **工具调用折叠成 cell。** 执行中 `⠋ Running <cmd>` → 结束后 `✓ <cmd> • 1.2s`（出错为 `✗`），输出合并进 cell、置暗显示，按 head + tail 截断（`… +N lines`），不会刷出一大墙原始输出。
- **主题由终端推导。** OSC 11 探测真实背景色：消息底色与代码 chip 由它混合而来（深色 12% 白、浅色 4% 黑），绝不写死十六进制；可用 `DSH_TUI_BG=#ffffff` 强制主题测试。
- **Thinking 可折叠。** `ctrl + t` 切换推理轨迹；`esc` 随时通过 `agent.cancel({ kind: 'user' })` 中止回合。
- **Markdown 保持原形。** 标题保留 `#`、围栏代码块保留围栏、行内代码有 chip 底色；中英文/emoji 按正确字符宽度折行，gutter 对齐。
- **实时视口。** transcript 底部锚定，最新内容始终可见；忙碌时显示 braille spinner + 紧凑计时（`Working 5s`）。

## 了解更多

- [INTEGRATION-NOTES.md](INTEGRATION-NOTES.md) —— 事件结构、patch 语义、集成深入解析（`session/event` 如何映射到 UI）
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 底层 agent 框架
- [模型路由（TokenDance）](README.zh-CN.md#模型路由tokendance) —— 网关配置、凭据、一次性 tool-call 守卫

## 模型路由（TokenDance）

profile 补丁（`cordis.patch.yml`）把 `llm-deepseek` 路由到 TokenDance 网关：

```yaml
llm-deepseek:
  apiKeyEnv: TOKENDANCE_API_KEY
  baseURL: https://tokendance.space/gateway/v1
```

provider 注册在 `~/.dsh/settings.yaml`（`llm-pi-ai.providers.tokendance`）：OpenAI 兼容端点、`thinkingFormat: deepseek`，模型为 `deepseek-v4-flash`（默认）与 `deepseek-v4-pro`。切换模型：编辑该文件的 `models` 列表，或在 profile patch 里覆盖 `llm-deepseek.model`。

> **前置修复（一次性，每次安装 dsh 后需重打）。** TokenDance 流式返回 tool-call 增量时 `name`/`id` 为空串，官方 `@deepseek-ai/dsh-llm-deepseek` 适配器会用空串覆盖首个 frame 的 call id，导致 harness 陷入 `unknown tool ""` 死循环。请在 `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js` 应用守卫：
>
> ```diff
> - if (call.id !== void 0) block.callId = call.id
> + if (call.id) block.callId = call.id
> - ... if (call.function?.name !== void 0) ...
> + ... if (call.function?.name) ...
> ```
>
> 已于 2026-08-13 在本机应用。该改动位于全局 dsh 安装中，**升级 `dsh` 后会丢失**——升级后需重新应用（值得提一个上游 PR）。

## 贡献

欢迎提 issue 和 PR。适合新手的好任务：把两个运行时补丁提到上游（TokenDance tool-call 守卫、grep 权限错误容忍）、补充浅色主题截图、把欢迎 banner 移植到其他模型 provider。动事件桥之前先读 [INTEGRATION-NOTES.md](INTEGRATION-NOTES.md)。

## License

[MIT](LICENSE)。独立社区项目，与 DeepSeek、TokenDance 无关联。
