<p align="center"><strong>deepseek-harness-tui</strong> 是为 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>（dsh）打造的交互式终端聊天界面——Codex CLI 风格，基于 <a href="https://github.com/vadimdemedes/ink">Ink</a>（React 终端 UI 框架）构建。

<p align="center">
  <img src="assets/screenshot.png" alt="deepseek-harness-tui 界面预览" width="80%" />
</p>

</br>
安装 harness（<code>dsh</code>）与本插件包后，运行 <code>dsh --profile tui</code>，即可获得一个 zero-chrome 的终端聊天界面：底部锚定对话流、工具调用折叠成 cell、thinking 折叠、背景色经 OSC 11 自适应终端主题。</p>

---

## 这是什么？

`deepseek-harness-tui` 是一个 Cordis 插件包，在 DeepSeek Harness agent 之上挂载一套 Ink 聊天 UI。模型路由、工具调用、会话引擎由 harness 提供，本包只负责聊天界面——与 Codex CLI 的分工一致（引擎 + TUI）。

- **引擎**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，需要 Node.js ≥ 20）
- **界面**：[Ink](https://github.com/vadimdemedes/ink) + React，主体在 `src/ui.js`（约 800 行）
- **模型路由**：[TokenDance](https://tokendance.space) 网关 → 默认 `deepseek-v4-flash`

## 特性

- **Zero-chrome 设计** —— transcript 即界面；DeepSeek 品牌 banner（ANSI Shadow logo，渐变配色）只在空态出现。
- **底部锚定 transcript** —— 实时视口始终把最新内容保持在可见区域。
- **工具调用折叠成 cell** —— 执行中显示 `⠋ Running <cmd>`，结束后变为 `✓ <cmd> • 1.2s`（出错为 `✗`）；输出合并进 cell、置暗显示，按 head + tail 截断，超出部分以 `… +N lines` 标记。
- **OSC 11 主题推导** —— 消息底色与行内代码 chip 由终端真实背景色混合而来，深/浅色主题下都自然；可用 `DSH_TUI_BG` 强制主题测试。
- **Thinking 折叠** —— `ctrl + t` 切换推理轨迹显示。
- **Esc 中断** —— 随时中止当前回合。
- **Markdown 渲染** —— 标题保留 `#`、围栏代码块保留围栏、行内代码有 chip 底色。
- **CJK 感知折行** —— 中英文/emoji 字符宽度正确，续行对齐 gutter。

## 快速开始

### 1. 环境要求

- **Node.js ≥ 20**（验证：`node --version`）
- **pnpm**（本地开发/安装插件包用，验证：`pnpm --version`）
- 一个 **TokenDance** API key（`sk-...`）

### 2. 安装 DeepSeek Harness

```shell
npm install -g @deepseek-ai/dsh
```

验证：

```shell
dsh --version    # 0.1.0-rc.6+
```

> **Homebrew**：官方暂未提供 brew tap，请使用上面的 npm 安装方式。其他选择：免安装试用（`npx @deepseek-ai/dsh web`），或[从源码构建](https://github.com/deepseek-ai/deepseek-harness)（`pnpm install && pnpm run build && pnpm dsh web`）。

### 3. 安装 deepseek-harness-tui

```shell
git clone https://github.com/gxinxing/deepseek-harness-tui
cd deepseek-harness-tui && pnpm install
```

把插件包装进 `tui` profile（一次性）：

```shell
dsh plugin --profile tui add @deepseek-ai/dsh-headless
dsh plugin --profile tui add /path/to/deepseek-harness-tui
```

> 第一条命令把 headless agent 引擎装进 profile；第二条把本聊天 UI 挂载到引擎之上。`/path/to/...` 指向你的 clone 目录。

### 4. 配置 TokenDance

二选一提供 key：

```shell
# 方式 A：环境变量
export TOKENDANCE_API_KEY=sk-...
```

```yaml
# 方式 B：凭据文件（~/.dsh/.credentials.yaml，权限 0600）
TOKENDANCE_API_KEY: sk-...
```

provider 与默认模型（`deepseek-official/deepseek-v4-flash`）来自 `~/.dsh/settings.yaml`，详见[模型路由](#模型路由-tokendance)。

### 5. 运行

```shell
dsh --profile tui
```

看到 DeepSeek banner 和 `❯ Ask anything` 提示即启动成功。输入消息回车，回合进行时会出现 `Working` + 转圈动画。

## 快捷键与命令

| 按键 | 动作 |
| --- | --- |
| `ctrl + t` | 切换 thinking 显示 |
| `esc` | 中断当前回合 |
| `ctrl + c` | 退出 |

| 命令 | 动作 |
| --- | --- |
| `/help` | 显示帮助 |
| `/clear` | 清空对话 |
| `/exit`, `/quit` | 退出 |

## 模型路由（TokenDance）

profile 补丁（`cordis.patch.yml`）把 `llm-deepseek` 路由到 TokenDance 网关：

```yaml
llm-deepseek:
  apiKeyEnv: TOKENDANCE_API_KEY
  baseURL: https://tokendance.space/gateway/v1
```

### Provider 与模型

TokenDance provider 注册在 `~/.dsh/settings.yaml`（`llm-pi-ai.providers.tokendance`）：OpenAI 兼容端点、`thinkingFormat: deepseek`，模型为 `deepseek-v4-flash`（默认）与 `deepseek-v4-pro`。切换模型：编辑该文件的 `models` 列表，或在 profile patch 里覆盖 `llm-deepseek.model`。

### 前置修复（一次性，每次安装 dsh 后需重打）

TokenDance 流式返回 tool-call 增量时 `name`/`id` 为空串，官方 `@deepseek-ai/dsh-llm-deepseek` 适配器会用空串覆盖首个 frame 的 call id，导致 harness 陷入 `unknown tool ""` 死循环。请在 `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js` 应用守卫：

```diff
- if (call.id !== void 0) block.callId = call.id
+ if (call.id) block.callId = call.id
- ... if (call.function?.name !== void 0) ...
+ ... if (call.function?.name) ...
```

已于 2026-08-13 在本机应用。该改动位于全局 dsh 安装中，**升级 `dsh` 后会丢失**——升级后需重新应用（值得提一个上游 PR）。

## 常见问题

| 症状 | 解决办法 |
| --- | --- |
| `unknown tool ""` 死循环，或工具 cell 一直卡在 `Running` | 前置修复丢失了——升级 dsh 后重新应用补丁。 |
| 无回复 / 鉴权报错 | 检查 `TOKENDANCE_API_KEY` 是否已导出，或存在于 `~/.dsh/.credentials.yaml`（权限 0600）。 |
| `dsh: command not found` | 重新 `npm install -g @deepseek-ai/dsh`，并确认 npm 全局 `bin` 目录在 `PATH` 中。 |
| 颜色不对 | 强制主题：`DSH_TUI_BG=#ffffff dsh --profile tui`（浅色）或 `#000000`（深色）。 |
| 没看到 banner | banner 只出现在空态——发出第一条消息后即消失。 |

## 文档

- [**INTEGRATION-NOTES**](./INTEGRATION-NOTES.md) —— 事件结构、patch 语义、集成深入解析。
- [**DeepSeek Harness**](https://github.com/deepseek-ai/deepseek-harness) —— 底层 agent 框架。

## License

本项目基于 [MIT License](LICENSE) 开源。© 2026 gxinxing。
