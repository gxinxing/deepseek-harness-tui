# deepseek-harness-tui

<p align="center">
  <img src="assets/screenshot.png" alt="deepseek-harness-tui — DeepSeek Harness terminal chat" width="720">
</p>

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）提供交互式终端聊天界面——Codex CLI 风格，基于 [Ink](https://github.com/vadimdemedes/ink)（React 终端 UI 框架）构建。

deepseek-harness-tui 是一个 Cordis 插件包，在 DeepSeek Harness agent 之上挂载一套 Ink 聊天界面：zero-chrome（零装饰）、底部锚定 transcript、实时状态行、单行输入框。配色以终端默认色为基础，叠加语义化强调色（`cyan` 活动、`green` 成功、`red` 错误、`magenta` 品牌、`dim` 次要），消息底色通过 OSC 11 从终端真实背景推导——在任何主题下都自然协调。

## 特性

- **Zero-chrome 设计** —— 无边框、无面板，transcript 即界面本身。
- **底部锚定 transcript** —— 实时视口始终把最新内容保持在可见区域。
- **工具调用折叠成 cell** —— 执行中显示 `⠋ Running <cmd>`，结束后变为 `✓ <cmd> • 1.2s`（出错为 `✗`）；输出合并进 cell、置暗显示，并按 head + tail 截断，超出部分以 `… +N lines` 标记。
- **OSC 11 主题推导** —— 探测终端背景色（浅色/深色自适应），消息底色与行内代码 chip 均由它混合而来，绝不写死十六进制色值。
- **thinking 折叠** —— `ctrl + t` 切换推理过程显示。
- **Esc 中断** —— 随时中止正在进行的对话回合。
- **Markdown 渲染** —— 标题保留 `#` 前缀、围栏代码块保留围栏、行内代码带轻微 chip 底色。
- **CJK 感知折行** —— 续行对齐到同一 gutter 列，正确处理中日韩全角字符宽度。
- **品牌欢迎界面** —— 空态显示 DeepSeek block logo 标识与标语。
- **状态行** —— 忙碌时显示盲文 spinner + 紧凑计时（`Working 5s`）+ `esc interrupt` 提示。

## 安装 DeepSeek Harness

dsh-tui 运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）之上——请先安装 dsh（三选一）：

- **npm（推荐，全局安装）**：

  ```sh
  npm install -g @deepseek-ai/dsh
  dsh --version        # 0.1.0-rc.6+
  ```

- **npx（免安装试用）**：

  ```sh
  npx @deepseek-ai/dsh web    # 启动官方 Web UI
  ```

- **源码编译**：

  ```sh
  git clone https://github.com/deepseek-ai/deepseek-harness.git
  cd deepseek-harness
  pnpm install && pnpm run build
  pnpm dsh web
  ```

> **Homebrew：** 官方目前没有提供 brew tap，请使用上面的 npm 安装方式。

## 快速开始

```sh
# 一次性准备：clone + 安装（bundle 需要自己的 node_modules）
git clone https://github.com/gxinxing/deepseek-harness-tui
cd deepseek-harness-tui && pnpm install

# 一次性接线（把插件 bundle 装进 tui profile）
dsh plugin --profile tui add @deepseek-ai/dsh-headless
dsh plugin --profile tui add /path/to/deepseek-harness-tui   # 即上面的 checkout 路径

# 运行
dsh --profile tui
```

如果你配置了 `dsh` 启动器别名（如 `~/.local/bin/dsh`），可以让裸 `dsh` 默认走 tui profile——参考启动器里的 `dsh --profile tui` wrapper。

**依赖要求：** Node ≥ 20、`@deepseek-ai/dsh` 0.1.0-rc.6+、本地开发用 pnpm（`pnpm install`；被链接的 bundle 需要自己的 `node_modules`）。

## 快捷键与命令

| 按键 | 作用 |
| --- | --- |
| `ctrl + t` | 切换 thinking 显示 |
| `esc` | 中断正在运行的回合 |
| `ctrl + c` | 退出 |

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示帮助 |
| `/clear` | 清空 transcript |
| `/exit`、`/quit` | 退出 |

## 设计说明

界面提炼自 Codex CLI TUI（`codex-rs/tui`）与 Hermes Agent TUI。没有常驻装饰：transcript 就是界面本体，品牌标识只出现在空态，model · cwd 放在右侧带按键提示的暗色 footer 里。每一行使用 2 列 gutter（`▌ ` 用户、`› ` 输入、`• ` 工具/助手），续行缩进到同一列，整屏读起来是一条对齐的流——并针对中日韩混合宽度文本做了 CJK 感知折行。

工具调用折叠成 cell（spinner → `✓`/`✗` + 合并截断的输出），thinking 收进 `ctrl + t`，消息底色由探测到的终端背景混合而来（深色底 12% 白、浅色底 4% 黑）而非写死十六进制。忙碌时输入框上方显示盲文 spinner、紧凑计时与 `esc interrupt` 提示。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `src/index.js` | Cordis bundle 入口——`tui-runner` 插件：注入 agent 服务、挂载 Ink UI |
| `src/ui.js` | Ink 聊天界面：transcript、输入框、状态行、快捷键与命令 |
| `src/theme.js` | 终端背景探测（OSC 11）+ 推导消息底色 |
| `cordis.patch.yml` | Profile 补丁——禁用 headless 一次性行，插入 `tui-runner` |
| `INTEGRATION-NOTES.md` | dsh 集成语义与实时事件结构的深入说明 |
| `package.json` | 插件清单——`dsh.bundle.patch` 指向补丁文件 |

## Model routing (TokenDance)

配置文件补丁（`cordis.patch.yml`）将 `llm-deepseek` 路由到 TokenDance 网关：

```yaml
llm-deepseek:
  apiKeyEnv: TOKENDANCE_API_KEY
  baseURL: https://tokendance.space/gateway/v1
```

### 凭据配置

把 TokenDance 的 key 通过以下任一方式提供给 `TOKENDANCE_API_KEY`：

- 环境变量：
  ```sh
  export TOKENDANCE_API_KEY=sk-...
  ```
- 凭据文件（`~/.dsh/.credentials.yaml`，权限 0600）：
  ```yaml
  TOKENDANCE_API_KEY: sk-...
  ```

### Provider 与模型

TokenDance provider 注册在 `~/.dsh/settings.yaml`（`llm-pi-ai.providers.tokendance`）：OpenAI 兼容端点、`thinkingFormat: deepseek`，模型为 `deepseek-v4-flash` 与 `deepseek-v4-pro`。

默认模型：`deepseek-official/deepseek-v4-flash`。切换模型：编辑 `~/.dsh/settings.yaml` 中 provider 的 `models` 列表，或在 profile patch 里覆盖 `llm-deepseek.model`。

> **前置修复（一次性，每个 dsh 安装需执行一次）。** TokenDance 流式返回后续 tool-call 增量时 `name`/`id` 为空；官方 `@deepseek-ai/dsh-llm-deepseek` 适配器会用 `""` 覆盖首帧的 call id，导致 harness 在 `unknown tool ""` 上死循环。已在 `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js` 中应用防护：
>
> ```diff
> - if (call.id !== void 0) block.callId = call.id
> + if (call.id) block.callId = call.id
> - ... if (call.function?.name !== void 0) ...
> + ... if (call.function?.name) ...
> ```
>
> 已应用（2026-08-13，本机）。该修改位于全局 dsh 安装中，**升级 `dsh` 后即丢失**——升级后需重新应用（值得提一个 upstream PR）。

## Debug

- `DSH_TUI_BG=#ffffff dsh --profile tui` —— 强制浅色终端背景，方便测试主题。

集成语义（事件结构、补丁行为）详见 [INTEGRATION-NOTES.md](INTEGRATION-NOTES.md)。

## License

MIT —— 见 [LICENSE](LICENSE)。© 2026 gxinxing。
