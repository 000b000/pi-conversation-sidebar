# Pi Conversation Sidebar

A right-side conversation index for [Pi](https://pi.dev)'s fullscreen TUI.

The sidebar reserves its own columns in the layout instead of drawing an overlay. The transcript is reflowed to the left, while the input dock and footer stay full width. The sidebar only spans the transcript area, and its bottom border shares the input bar's top border row — no floating gap and no covered input.

```text
┌──────────────────────── transcript ────────────────────────┬─ Conversation ─┐
│                                                            │▸ user prompt   │
│                                                            │↳ assistant    │
│                                                            │▸ user prompt   │
│                                                            │↳ assistant    │
└────────────────────────────────────────────────────────────┴────────────────┘
──────────────────────────── input bar (full width) ────────────────────────────
────────────────────────── status / footer (full width) ────────────────────────
```

## Features

- User prompts (`▸`) and assistant replies (`↳`) each get their own row.
- No per-message numbers and no `U`/`A` letters; the selected row is highlighted.
- Jump to any message with `Enter` or a mouse click.
- `e` loads a selected user prompt into the editor (only when the editor is empty).
- Mouse wheel, keyboard paging, first/last navigation.
- CJK-aware truncation using terminal display width.
- Assistant messages with no visible text (tool calls / thinking only) do not take a row.
- Automatically hides on terminals narrower than 96 columns.
- The sidebar height follows the transcript: it shrinks when the editor grows and never covers the input dock or footer.

## Requirements

- Pi 1.4.x.
- Fullscreen TUI mode (the default `tuiMode: "fullscreen"`).
- At least 96 terminal columns.
- Regular TUI mode is not supported because it has no extension-controlled viewport layout.

## Install

From GitHub:

```bash
pi install git:github.com/000b000/pi-conversation-sidebar
```

Try without adding it to settings:

```bash
pi -e git:github.com/000b000/pi-conversation-sidebar
```

From a local checkout:

```bash
pi -e ./index.ts
```

Restart Pi, or run `/reload` in a running session.

## Keys

When the editor is focused:

| Key | Action |
| --- | --- |
| `Alt+H` | Focus the sidebar |
| Mouse click on a row | Jump to that message |

When the sidebar is focused:

| Key | Action |
| --- | --- |
| `j` / `Down` | Next message |
| `k` / `Up` | Previous message |
| `[` / `]` or `Ctrl+U` / `Ctrl+D` | Page up / page down |
| `Home` / `End` or `g` / `G` | First / last message |
| `Enter` | Scroll the transcript to the selected message |
| `e` | Load a selected user prompt into the editor |
| `Esc` | Return focus to the editor (sidebar stays visible) |
| `q` / `Alt+H` | Hide the sidebar |

## Commands

```text
/sidebar          toggle visibility
/sidebar on       show
/sidebar off      hide
/sidebar focus    show and focus
/sidebar toggle   toggle visibility
```

## How it works

The extension replaces the fullscreen layout root with:

```text
VStack(
  HStack(transcript, sidebar),
  input dock
)
```

The input dock is full width. The sidebar's height ends at the input dock; its bottom border is merged into the editor's top border row so the two look connected. When queued messages or custom widgets appear above the editor, the sidebar falls back to its own bottom border above them.

The extension also removes Pi's default blank spacer row above the editor so the bottom edges line up. Removing the extension and reloading restores the default spacing.

## Notes

- `Enter` is a read-only jump. It does not change the session tree branch; use Pi's `/tree` to branch from a message.
- The implementation relies on Pi 1.4.x fullscreen layout internals (`layoutRoot` / `setLayoutRoot`). If a future Pi version changes those internals, the extension fails safe and does not draw a sidebar.
- After changing the TUI mode in `/settings`, run `/reload` to remount the sidebar.
- Sidebar width is controlled by `SIDEBAR_WIDTH` at the top of `index.ts` (default 38 columns).

## Development

```bash
pi -e ./index.ts
```

The extension is a single TypeScript file and has no runtime dependencies beyond the packages Pi provides.

## License

MIT

---

# 中文说明

把多轮对话中的用户提问和助手回复逐条列在 Pi 全屏 TUI 的**右侧**，用于快速定位和跳转。

它不是覆盖层：扩展把全屏布局改成“上半部分水平分栏 + 下方完整输入区”。侧栏只占对话区高度，输入框、状态行和 footer 保持全宽；侧栏底边与输入栏顶部边框共用同一行，不会悬空，也不会遮挡输入区。

## 功能

- 用户消息用 `▸` 标记，助手回复用 `↳` 标记，每条消息单独一行。
- 不显示消息序号和 `U`/`A` 字母，选中项用背景高亮。
- `Enter` 或鼠标点击跳转到任意消息。
- 选中用户消息后按 `e`，可把原始提问载入输入框（仅在输入框为空时）。
- 支持鼠标滚轮、翻页、首尾跳转。
- 按终端显示宽度处理中文/宽字符截断。
- 纯工具调用/思考、没有可见文本的助手消息不占行。
- 终端宽度低于 96 列时自动隐藏。
- 侧栏高度跟随对话区：输入框变高时自动缩短，不遮挡输入栏和 footer。

## 安装

```bash
pi install git:github.com/000b000/pi-conversation-sidebar
```

临时试用：

```bash
pi -e git:github.com/000b000/pi-conversation-sidebar
```

本地开发：

```bash
pi -e ./index.ts
```

重启 Pi，或在运行中的 Pi 里执行 `/reload`。

## 快捷键

输入框获得焦点时：

| 按键 | 作用 |
| --- | --- |
| `Alt+H` | 聚焦侧栏 |
| 鼠标点击条目 | 跳转到该条消息 |

侧栏获得焦点时：

| 按键 | 作用 |
| --- | --- |
| `j` / `↓` | 下一条 |
| `k` / `↑` | 上一条 |
| `[` / `]` 或 `Ctrl+U` / `Ctrl+D` | 翻页 |
| `Home` / `End` 或 `g` / `G` | 第一条 / 最后一条 |
| `Enter` | 滚动到选中消息 |
| `e` | 把选中的用户提问载入输入框 |
| `Esc` | 回到输入框（侧栏保持显示） |
| `q` / `Alt+H` | 隐藏侧栏 |

## 命令

```text
/sidebar          显示 / 隐藏
/sidebar on       显示
/sidebar off      隐藏
/sidebar focus    显示并聚焦侧栏
/sidebar toggle   显示 / 隐藏
```

## 说明

- `Enter` 是只读跳转，不会改变会话树分支；需要从某条消息重新分支时使用 Pi 自带的 `/tree`。
- `e` 只对用户消息生效；选中助手回复时按 `e` 会提示不能载入。
- 扩展依赖 Pi 1.4.x 的全屏布局内部接口（`layoutRoot` / `setLayoutRoot`）。如果未来版本接口变化，扩展会安全回退为不显示侧栏。
- 在 `/settings` 中切换 TUI 模式后，执行一次 `/reload` 让侧栏重新挂载。
- 侧栏宽度由 `index.ts` 顶部的 `SIDEBAR_WIDTH` 控制，默认 38 列。

## 许可证

MIT
