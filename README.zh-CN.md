<p align="center"><strong>deepseek-harness-tui</strong> 是为 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>（dsh）打造的交互式终端聊天界面——Codex CLI 风格，基于 <a href="https://github.com/vadimdemedes/ink">Ink</a>（React 终端 UI 框架）构建。

<p align="center">
  <img src="assets/screenshot.png" alt="deepseek-harness-tui 界面预览" width="80%" />
</p>

</br>
安装 <code>dsh</code>（harness）与本插件包后，运行 <code>dsh --profile tui</code> 即可在终端里和 DeepSeek 模型聊天：zero-chrome 对话流、工具调用折叠成 cell、背景色经 OSC 11 自适应终端主题。</p>

---

## 快速开始

### 安装 DeepSeek Harness

先安装 `Node.js`（≥ 20），再用 npm 安装 harness CLI：

```shell
npm install -g @deepseek-ai/dsh
```

官方暂未提供 Homebrew tap，请使用上面的 npm 方式；也可以免安装试用（`npx @deepseek-ai/dsh web`）或[从源码构建](https://github.com/deepseek-ai/deepseek-harness)。

### 安装 deepseek-harness-tui

```shell
git clone https://github.com/gxinxing/deepseek-harness-tui
cd deepseek-harness-tui && pnpm install
```

然后把插件包装进 `tui` profile：

```shell
dsh plugin --profile tui add @deepseek-ai/dsh-headless
dsh plugin --profile tui add /path/to/deepseek-harness-tui
```

### 运行

```shell
dsh --profile tui
```

### 接入 TokenDance

把 TokenDance 的 key 通过 `export TOKENDANCE_API_KEY=sk-...` 或写入 `~/.dsh/.credentials.yaml`（权限 `0600`）提供。默认模型为 `deepseek-official/deepseek-v4-flash`，详见[模型路由](#模型路由-tokendance)。

## 特性

- **Zero-chrome 设计** —— transcript 即界面；DeepSeek 品牌 banner 只在空态出现。
- **底部锚定 transcript** —— 实时视口始终把最新内容保持在可见区域。
- **工具调用折叠成 cell** —— `⠋ Running <cmd>` → `✓ <cmd> • 1.2s`（出错为 `✗`），输出合并进 cell、置暗显示，超出部分以 `… +N lines` 截断。
- **OSC 11 主题推导** —— 消息底色与代码 chip 由终端真实背景色混合而来，深/浅色主题下都自然。
- **Thinking 折叠** —— `ctrl + t` 切换推理轨迹显示。
- **Esc 中断** —— 随时中止当前回合。
- **Markdown 渲染** —— 标题、围栏代码块、行内代码 chip。
- **CJK 感知折行** —— 中英文/emoji 宽度正确，gutter 对齐。

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

profile 补丁（`cordis.patch.yml`）将 `llm-deepseek` 路由到 TokenDance 网关：

```yaml
llm-deepseek:
  apiKeyEnv: TOKENDANCE_API_KEY
  baseURL: https://tokendance.space/gateway/v1
```

### 凭据配置

- 环境变量：`export TOKENDANCE_API_KEY=sk-...`
- 凭据文件（`~/.dsh/.credentials.yaml`，权限 `0600`）：`TOKENDANCE_API_KEY: sk-...`

### Provider 与模型

TokenDance provider 注册在 `~/.dsh/settings.yaml`（`llm-pi-ai.providers.tokendance`）：OpenAI 兼容端点、`thinkingFormat: deepseek`，模型为 `deepseek-v4-flash` 与 `deepseek-v4-pro`。切换模型：编辑该文件中的 `models` 列表，或在 profile patch 里覆盖 `llm-deepseek.model`。

> **前置修复（一次性，每次安装 dsh 后需重打）。** TokenDance 流式返回 tool-call 增量时 `name`/`id` 为空串，官方 `@deepseek-ai/dsh-llm-deepseek` 适配器会用空串覆盖首个 frame 的 call id，导致 harness 陷入 `unknown tool ""` 死循环。已在 `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js` 应用守卫：
>
> ```diff
> - if (call.id !== void 0) block.callId = call.id
> + if (call.id) block.callId = call.id
> - ... if (call.function?.name !== void 0) ...
> + ... if (call.function?.name) ...
> ```
>
> 已于 2026-08-13 在本机应用。该改动位于全局 dsh 安装中，**升级 `dsh` 后会丢失**——升级后需重新应用（值得提一个上游 PR）。

## 文档

- [**INTEGRATION-NOTES**](./INTEGRATION-NOTES.md) —— 事件结构、patch 语义、集成深入解析。
- [**DeepSeek Harness**](https://github.com/deepseek-ai/deepseek-harness) —— 底层 agent 框架。

## Debug

- `DSH_TUI_BG=#ffffff dsh --profile tui` —— 强制浅色终端背景，用于主题测试。

本项目基于 [MIT License](LICENSE) 开源。
