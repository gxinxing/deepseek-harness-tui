/**
 * dsh-tui Ink UI — plain React (React.createElement only, no JSX, no build).
 *
 * Design: Codex CLI TUI, distilled from openai/codex codex-rs/tui sources.
 *   - No chrome boxes. Terminal-default colors; semantic accents only:
 *     cyan (input ›, user ▌, activity), green (success/output),
 *     red (errors), magenta (brand + `$` prompt), dim (secondary).
 *   - Message prefixes with aligned wrapping: `• ` assistant, `▌ ` user
 *     (user block also carries a faint background), `$ ` commands.
 *   - Tool cells: `• Running <cmd>` (live marker) → `$ <cmd>` + output +
 *     `✓ • 1.2s` / `✗ (1) • 0ms`.
 *   - `• Working (Ns)` status row above the composer while busy.
 *   - Bottom hint row: model · cwd on the left, key hints on the right.
 *   - Markdown: headers stay `#`-prefixed and bold; fenced code blocks keep
 *     their fences; inline `code` gets a subtle chip.
 *   - Hermes-inspired extras: collapsible thinking (t), todo panel (todo/write).
 *
 * All event access is defensive: shapes carry optional fields and the harness
 * iterates fast, so the UI must never crash on unknown types.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { userMessageBg, codeChipBg } from './utils.js'

/** createElement shorthand. */
const el = React.createElement

// ── Codex semantic palette (terminal-default based) ──────────────────────
const ACCENT = 'cyan' // input ›, user ▌, activity markers
const OK = 'green' // ✓, command output
const ERR = 'red' // ✗, errors
const BRAND = 'magenta' // `$` prompt, app mark

/** Codex-style braille spinner (ink-spinner has no braille frame set). */
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function BrailleSpinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % BRAILLE_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])
  return el(Text, null, BRAILLE_FRAMES[frame])
}

/** Caps. */
const MAX_ITEMS = 500
const MAX_TOOL_ARGS = 160
const MAX_RESULT_PREVIEW = 300
const OUTPUT_HEAD = 10 // first output lines kept per tool result
const OUTPUT_TAIL = 6 // last output lines kept per tool result

// ── Width chain (keep in sync with ChatRow layout) ───────────────────────
// App width = columns - 2 (transcript side padding), so rows render at
// `width - 2`. User lines add 1+1 padding; assistant body lines carry a
// 2-column `• ` / `  ` gutter. Estimates must use the same arithmetic or the
// bottom-anchored viewport clips the last line of long messages.
const TRANSCRIPT_PAD = 2
const USER_LINE_PAD = 2
const USER_PREFIX_W = 2 // '▌ '
const MARKDOWN_GUTTER = 2 // '• ' on the first line, '  ' afterwards

const HELP_TEXT = [
  'commands:',
  '  /help         show this help',
  '  /clear        clear the transcript',
  '  /retry        re-send the last message',
  '  /exit, /quit  quit dsh tui',
  'keys:',
  '  ↑ / ↓          scroll transcript',
  '  page up/down   scroll by page',
  '  esc            back to latest',
  '  ctrl + t       toggle thinking display',
  '  ctrl + c       quit',
].join('\n')

// ── Width helpers (CJK-aware) ────────────────────────────────────────────

const WIDE_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f1e6}-\u{1f1ff}\u{1f300}-\u{1faff}]/u
const ZERO_RE = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/

function wcwidth(ch) {
  if (ZERO_RE.test(ch)) return 0
  return WIDE_RE.test(ch) ? 2 : 1
}

function strWidth(text) {
  let w = 0
  for (const ch of text) w += wcwidth(ch)
  return w
}

/** Wrap `text` to `width` columns; returns an array of lines. Newlines split first. */
function wrapText(text, width) {
  if (width < 4) return [text]
  const parts = String(text).split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  const lines = []
  for (const part of parts) {
    if (part === '') {
      lines.push('')
      continue
    }
    let cur = ''
    let curW = 0
    for (const ch of part) {
      const w = wcwidth(ch)
      if (curW + w > width) {
        lines.push(cur)
        cur = ''
        curW = 0
      }
      cur += ch
      curW += w
    }
    if (cur !== '') lines.push(cur)
  }
  return lines.length === 0 ? [''] : lines
}

/**
 * Wrap and prefix: first line gets `prefix`, subsequent lines get `indent`
 * spaces — the Codex aligned-message look.
 */
function prefixedLines(text, width, prefix, indent = 2) {
  const pad = ' '.repeat(indent)
  const avail = Math.max(1, width - indent)
  const lines = wrapText(text, avail)
  if (lines.length === 0) return [prefix]
  return [prefix + lines[0], ...lines.slice(1).map((line) => pad + line)]
}

/** Clip a string to `max` chars with an ellipsis. */
function truncate(text, max) {
  if (typeof text !== 'string') return ''
  if (strWidth(text) <= max) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = wcwidth(ch)
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

/** Join the text of every block of one `type` in a message content array. */
function blocksText(content, type) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && block.type === type && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** First text found in a tool-result message (ToolResultBlock inner blocks). */
function toolResultText(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner && typeof inner === 'object' && inner.type === 'text' && typeof inner.text === 'string') {
          parts.push(inner.text)
        }
      }
    }
  }
  return parts.join('\n')
}

/** Human label for a turn-end reason. */
function reasonText(reason) {
  if (!reason || typeof reason !== 'object') return 'ended'
  switch (reason.kind) {
    case 'completed': return '✓ completed'
    case 'error': return `✗ error: ${reason.error?.code ?? 'UNKNOWN'} ${reason.error?.message ?? ''}`
    case 'aborted': return '⏹ aborted'
    case 'max-tokens': return '⚠ max-tokens'
    default: return String(reason.kind)
  }
}

/** Strip CSI/OSC escapes so raw tool bytes cannot repaint the TUI. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '')
}

/** Compact token-usage line; omits missing fields. */
function usageText(usage) {
  if (!usage || typeof usage !== 'object') return ''
  const parts = []
  if (typeof usage.inputTokens === 'number') parts.push(`${usage.inputTokens}in`)
  if (typeof usage.outputTokens === 'number') parts.push(`${usage.outputTokens}out`)
  if (typeof usage.cacheReadTokens === 'number') parts.push(`${usage.cacheReadTokens}cache`)
  return parts.length > 0 ? `usage: ${parts.join(' ')}` : ''
}

function fmtDuration(ms) {
  const sec = Math.max(0, ms) / 1000
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

/** Codex-style compact elapsed: 0s, 59s, 1m 02s, 1h 02m 03s. */
function fmtElapsedCompact(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

// ── Markdown (Codex-style: keep `#` and fences, no boxes) ────────────────

/** Split text into fenced code blocks and plain segments. */
function splitCodeBlocks(text) {
  const blocks = []
  const lines = String(text).split('\n')
  let inFence = false
  let buf = []
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inFence) {
        buf.push(line)
        blocks.push({ type: 'code', content: buf.join('\n') })
        buf = []
        inFence = false
      } else {
        if (buf.length > 0) {
          blocks.push({ type: 'text', content: buf.join('\n') })
          buf = []
        }
        inFence = true
        buf.push(line)
      }
    } else {
      buf.push(line)
    }
  }
  if (buf.length > 0) {
    blocks.push({ type: inFence ? 'code' : 'text', content: buf.join('\n') })
  }
  return blocks
}

/** Inline tokens: `code`, **bold**, *italic*. Returns Text children. */
function renderInline(text, keyPrefix, chipBg) {
  const nodes = []
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g
  let last = 0
  let match
  let key = 0
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(el(Text, { key: `${keyPrefix}-${key++}` }, text.slice(last, match.index)))
    const token = match[0]
    if (match[1] !== undefined) {
      nodes.push(
        el(Text, { key: `${keyPrefix}-${key++}`, backgroundColor: chipBg }, token.slice(1, -1)),
      )
    } else if (match[2] !== undefined) {
      nodes.push(el(Text, { key: `${keyPrefix}-${key++}`, bold: true }, token.slice(2, -2)))
    } else {
      nodes.push(el(Text, { key: `${keyPrefix}-${key++}`, italic: true }, token.slice(1, -1)))
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(el(Text, { key: `${keyPrefix}-${key++}` }, text.slice(last)))
  return nodes
}

/**
 * Markdown body for an assistant message. Headers keep their `#` signs
 * (bold), fenced blocks keep fences, plain text renders inline-styled.
 * Returns an array of rendered lines (one Text per line). `prefix` (e.g.
 * `• `) is applied to the first line only; later lines indent to the same
 * column, giving the Codex aligned-gutter look.
 */
function markdownLines(text, width, indent = 2, chipBg = '#333333', prefix = '') {
  const pad = ' '.repeat(indent)
  // `width` is the available content width; the gutter must come out of it or
  // every rendered line is one wider than the estimate and wraps a second,
  // flush-left line (misaligned continuation, clipped tail).
  const gutterW = prefix !== '' ? strWidth(prefix) : indent
  const avail = Math.max(1, width - gutterW)
  const out = []
  let blockKey = 0
  let first = true
  const gutter = () => {
    const g = first ? (prefix !== '' ? prefix : pad) : pad
    first = false
    return g
  }
  for (const block of splitCodeBlocks(text)) {
    if (block.type === 'code') {
      // Keep fences verbatim; wrap long code lines.
      for (const line of wrapText(block.content, avail)) {
        out.push(el(Text, { key: `b${blockKey}`, wrap: 'wrap' }, gutter() + line))
        blockKey += 1
      }
    } else {
      for (const rawLine of block.content.split('\n')) {
        const trimmed = rawLine.replace(/^\s+/, '')
        const isHeader = /^#{1,6}\s/.test(trimmed)
        if (trimmed === '') {
          out.push(el(Text, { key: `b${blockKey}`, wrap: 'wrap' }))
          blockKey += 1
          continue
        }
        const wrapped = wrapText(trimmed, avail)
        for (const line of wrapped) {
          if (isHeader) {
            out.push(el(Text, { key: `b${blockKey}`, bold: true, wrap: 'wrap' }, gutter() + line))
          } else {
            out.push(
              el(Text, { key: `b${blockKey}`, wrap: 'wrap' }, gutter(), ...renderInline(line, `i${blockKey}`, chipBg)),
            )
          }
          blockKey += 1
        }
      }
    }
  }
  if (out.length === 0) out.push(el(Text, { key: 'empty' }))
  return out
}

/** Body lines for a plain (non-markdown) message with a prefix. */
function plainLines(text, width, prefix, indent = 2) {
  return prefixedLines(text, width, prefix, indent).map((line, i) =>
    el(Text, { key: `l${i}`, wrap: 'wrap' }, line),
  )
}

// ── Transcript rows ───────────────────────────────────────────────────────

/** Cap tool output to head + tail lines with an ellipsis marker. */
function splitOutput(text) {
  if (typeof text !== 'string' || text === '') return null
  const clean = stripAnsi(text).replace(/\r\n?/g, '\n')
  const capped = truncate(clean, MAX_RESULT_PREVIEW)
  const lines = capped.split('\n')
  if (lines.length <= OUTPUT_HEAD + OUTPUT_TAIL) return { lines, omitted: 0 }
  return {
    lines: [...lines.slice(0, OUTPUT_HEAD), ...lines.slice(-OUTPUT_TAIL)],
    omitted: lines.length - OUTPUT_HEAD - OUTPUT_TAIL,
  }
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) }
  }
  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: '' })
    }
  }
  componentDidCatch(error) {
    console.error(`dsh-tui: render error: ${error instanceof Error ? error.message : String(error)}`)
  }
  render() {
    if (this.state.hasError) {
      return el(Text, { color: ERR, wrap: 'wrap' }, `⚠ render error: ${this.state.message}`)
    }
    return this.props.children
  }
}

function ChatRow({ item, width, thinkingOpen, themeBg }) {
  switch (item.kind) {
    case 'user': {
      // Faint derived background + cyan ▌ prefix (Codex user-message style).
      return el(
        Box,
        { flexDirection: 'column', backgroundColor: userMessageBg(themeBg), paddingY: 0, flexShrink: 0 },
        ...plainLines(item.text, width - TRANSCRIPT_PAD - USER_LINE_PAD, '▌ ', 2).map((line, i) =>
          el(Box, { key: `u${i}`, paddingLeft: 1, paddingRight: 1 }, line)),
      )
    }
    case 'assistant': {
      const lines = []
      if (item.reasoning !== '' && thinkingOpen) {
        lines.push(
          el(Box, { key: 'thinking', flexDirection: 'column' },
            el(Text, { dimColor: true, bold: true }, '  thinking'),
            ...wrapText(item.reasoning, Math.max(1, width - 6)).map((line, i) =>
              el(Text, { key: `t${i}`, dimColor: true, italic: true, wrap: 'wrap' }, `    ${line}`)),
          ),
        )
      }
      if (item.text !== '') {
        lines.push(
          el(Box, { key: 'body', flexDirection: 'column' }, ...markdownLines(item.text, width - TRANSCRIPT_PAD, 2, codeChipBg(themeBg), '• ')),
        )
      }
      if (item.usage) {
        lines.push(el(Text, { key: 'usage', dimColor: true, wrap: 'wrap' }, `  ${usageText(item.usage)}`))
      }
      if (lines.length === 0) return null
      return el(Box, { flexDirection: 'column', marginTop: 1, flexShrink: 0 }, ...lines)
    }
    case 'tool': {
      const done = item.status === 'done'
      const failed = item.status === 'error'
      const mark = failed ? el(Text, { key: 'm', color: ERR, bold: true }, '✗') : done ? el(Text, { key: 'm', color: OK, bold: true }, '✓') : el(BrailleSpinner, { key: 'm' })
      const label = done || failed ? '' : 'Running '
      const seconds = typeof item.seconds === 'number' ? ` • ${fmtDuration(item.seconds * 1000)}` : ''
      // Cap the head to one rendered line: a wrapping head would break the
      // aligned look and the one-line estimate.
      const cmd = truncate(`${item.name} ${truncate(item.args, MAX_TOOL_ARGS)}`.trim(), Math.max(12, width - 16))
      const outputLines = splitOutput(item.output)
      const rows = [
        el(Text, { key: 'head', wrap: 'wrap' },
          el(Text, {}, '  '), mark,
          el(Text, { bold: !done && !failed, color: done || failed ? undefined : ACCENT }, ` ${label}${cmd}`),
          el(Text, { dimColor: true }, seconds)),
      ]
      if (outputLines !== null) {
        let outIndex = 0
        for (const line of outputLines.lines) {
          // Pre-wrap to keep the 4-space indent on continuations (Ink would
          // otherwise wrap flush-left).
          for (const wrapped of wrapText(line, Math.max(1, width - 6))) {
            rows.push(el(Text, { key: `o${outIndex++}`, dimColor: true, wrap: 'wrap' }, `    ${wrapped}`))
          }
        }
        if (outputLines.omitted > 0) {
          rows.push(el(Text, { key: 'ell', dimColor: true, wrap: 'wrap' }, `    … +${outputLines.omitted} lines`))
        }
      }
      if (failed && item.error) {
        const errText = `    error: ${item.error.code ?? item.error.name ?? 'unknown'}`
        rows.push(el(Text, { key: 'err', color: ERR, wrap: 'wrap' }, truncate(errText, Math.max(12, width - 2))))
      }
      return el(Box, { flexDirection: 'column', marginTop: 1, flexShrink: 0 }, ...rows)
    }
    case 'divider':
      return el(Text, { dimColor: true }, '  ' + '─'.repeat(Math.min(48, width - 4)))
    default: // status rows: dim; red when the turn failed.
      return el(Text, { dimColor: !item.error, color: item.error ? ERR : undefined, wrap: 'wrap' }, item.text)
  }
}

/** Live streaming block while a turn is in flight. */
function StreamBlock({ stream, width, thinkingOpen, themeBg }) {
  const children = []
  if (stream.reasoning !== '' && thinkingOpen) {
    children.push(
      el(Box, { key: 'reasoning', flexDirection: 'column', marginTop: 1 },
        el(Text, { dimColor: true, bold: true }, '  thinking'),
        ...wrapText(stream.reasoning, Math.max(1, width - 6)).map((line, i) =>
          el(Text, { key: `t${i}`, dimColor: true, italic: true, wrap: 'wrap' }, `    ${line}`)),
      ),
    )
  }
  if (stream.text !== '') {
    children.push(
      el(Box, { key: 'text', flexDirection: 'column', marginTop: 1 }, ...markdownLines(stream.text, width - TRANSCRIPT_PAD, 2, codeChipBg(themeBg), '• ')),
    )
  }
  if (stream.tool !== null) {
    const name = stream.tool.name !== '' ? stream.tool.name : 'tool'
    children.push(
      el(Text, { key: 'tool', wrap: 'wrap' },
        el(Text, {}, '  '),
        el(BrailleSpinner, { key: 'sp' }),
        el(Text, { bold: true, color: ACCENT }, ` Running ${name}`),
        el(Text, { dimColor: true }, ` ${truncate(stream.tool.args, MAX_TOOL_ARGS)}`)),
    )
  }
  return children.length === 0 ? null : el(Box, { flexDirection: 'column' }, ...children)
}

/** Todo list panel (whole-list snapshot from todo/write). */
function TodoPanel({ todos }) {
  if (!Array.isArray(todos) || todos.length === 0) return null
  return el(
    Box,
    { flexDirection: 'column', marginTop: 1, flexShrink: 0 },
    el(Text, { dimColor: true, bold: true }, '  todos'),
    ...todos.map((todo, index) => {
      const done = todo && todo.status === 'completed'
      const inProgress = todo && todo.status === 'in_progress'
      return el(
        Text,
        { key: index, dimColor: !done, color: done ? OK : inProgress ? ACCENT : undefined, wrap: 'wrap' },
        `    ${done ? '✓' : inProgress ? '◐' : '☐'} ${todo && typeof todo.content === 'string' ? todo.content : ''}`,
      )
    }),
  )
}

// ── App ───────────────────────────────────────────────────────────────────

export function App({ agent, onEvent, onExit, onInterrupt, firstSeq = 0, model = '?', themeBg = '#000000' }) {
  const [items, setItems] = useState([])
  const [todos, setTodos] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [stream, setStream] = useState({ reasoning: '', text: '', tool: null })
  const [hint, setHint] = useState(null)
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const [scrollLines, setScrollLines] = useState(0)
  const viewportStep = useRef(5)
  const [, setTick] = useState(0) // drives the Working elapsed timer
  const usageRef = useRef(null)
  const hintTimer = useRef(undefined)
  const exiting = useRef(false)
  const lastUserText = useRef('')
  const toolStarts = useRef(new Map())
  const runningTools = useRef(new Map()) // callId → { name, args } while the row is live
  const toolResults = useRef(new Map()) // callId → done info (out-of-order guard)
  const turnStart = useRef(undefined)
  const lastEventAt = useRef(Date.now())
  const { exit: inkExit } = useApp()
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 100
  const rows = stdout?.rows ?? 30
  const width = Math.max(20, cols - 2)

  // Working elapsed timer while busy.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setTick((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  /** Append one transcript entry, dropping the oldest rows past MAX_ITEMS. */
  const pushItem = useCallback((item) => {
    setItems((prev) => [...prev.slice(-(MAX_ITEMS - 1)), item])
  }, [])

  const clearHint = useCallback(() => {
    if (hintTimer.current !== undefined) clearTimeout(hintTimer.current)
    hintTimer.current = undefined
    setHint(null)
  }, [])

  const flashHint = useCallback((text, ms = 1500) => {
    setHint(text)
    if (hintTimer.current !== undefined) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => {
      hintTimer.current = undefined
      setHint(null)
    }, ms)
  }, [])

  const showBusyHint = useCallback(() => flashHint('(busy — waiting for the model)'), [flashHint])

  /** Exit the Ink app, then request the harness process exit. Never twice. */
  const handleExit = useCallback(() => {
    if (exiting.current) return
    exiting.current = true
    inkExit()
    onExit()
  }, [inkExit, onExit])

  // Global keys: esc interrupts the live turn, ctrl + t toggles thinking,
  // ctrl + c quits. Bare letters never hijack typing.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') handleExit()
    else if (key.escape && busy && typeof onInterrupt === 'function') onInterrupt()
    else if (key.escape) setScrollLines(0)
    else if (key.ctrl && input === 't') setThinkingOpen((v) => !v)
    else if (key.upArrow || key.pageUp) setScrollLines((v) => v + viewportStep.current)
    else if (key.downArrow || key.pageDown) setScrollLines((v) => Math.max(0, v - viewportStep.current))
  })

  /** Map one SessionEvent to UI state. Defensive: unknown shapes are ignored. */
  const handleEvent = useCallback(
    (event) => {
      if (!event || typeof event !== 'object') return
      lastEventAt.current = Date.now()
      // Events below the agent's live boundary are seed history, not chat.
      if (typeof event.seq === 'number' && event.seq < firstSeq) return
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      switch (event.type) {
        case 'turn/start':
          setBusy(true)
          turnStart.current = Date.now()
          lastEventAt.current = Date.now()
          setScrollLines(0)
          setStream({ reasoning: '', text: '', tool: null })
          runningTools.current.clear()
          toolResults.current.clear()
          // Mirror the harness todos projection: cleared by the next turn/start
          // (turn/end keeps the finished checklist visible).
          setTodos([])
          usageRef.current = null
          break
        case 'turn/end': {
          setBusy(false)
          turnStart.current = undefined
          clearHint()
          const reason = data.reason && typeof data.reason === 'object' ? data.reason : {}
          if (data.usage && typeof data.usage === 'object') usageRef.current = data.usage
          // Close any tool rows the harness never finished: a dangling spinner
          // reads as a stuck TUI even when the turn itself ended.
          const dangling = [...runningTools.current.entries()]
          runningTools.current.clear()
          if (dangling.length > 0) {
            const danglingIds = new Set(dangling.map(([id]) => id))
            const closed = reason.kind === 'completed' ? 'done' : 'error'
            setItems((prev) =>
              prev.map((item) =>
                item.kind === 'tool' && item.status === 'running' && danglingIds.has(item.callId)
                  ? {
                      ...item,
                      status: closed,
                      error:
                        closed === 'error'
                          ? { name: 'interrupted', code: 'turn-ended' }
                          : undefined,
                    }
                  : item,
              ),
            )
          }
          const label = reasonText(reason)
          const usageLine = usageText(usageRef.current)
          const isError = reason.kind === 'error'
          const parts = [label]
          if (usageLine !== '') parts.push(usageLine)
          if (isError) parts.push('/retry 重试')
          const text = parts.join(' · ')
          setItems((prev) => {
            const divider = prev.length === 0 ? [] : [{ kind: 'divider' }]
            return [...prev, ...divider, { kind: 'status', text, error: isError }]
          })
          break
        }
        case 'assistant/chunk': {
          const chunk = data.chunk && typeof data.chunk === 'object' ? data.chunk : {}
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            setStream((prev) => ({ ...prev, text: prev.text + chunk.text }))
          } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            setStream((prev) => ({ ...prev, reasoning: prev.reasoning + chunk.text }))
          } else if (chunk.type === 'tool-call-delta' && typeof chunk.argumentsDelta === 'string') {
            setStream((prev) => ({
              ...prev,
              tool: {
                name: typeof chunk.name === 'string' ? chunk.name : prev.tool?.name ?? '',
                args: (prev.tool?.args ?? '') + chunk.argumentsDelta,
              },
            }))
          } else if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
            usageRef.current = chunk.usage
          }
          break
        }
        case 'assistant/message': {
          const message = data.message && typeof data.message === 'object' ? data.message : {}
          const content = Array.isArray(message.content) ? message.content : []
          const itemUsage = data.usage && typeof data.usage === 'object' ? data.usage : undefined
          if (itemUsage) usageRef.current = itemUsage
          setStream({ reasoning: '', text: '', tool: null })
          pushItem({
            kind: 'assistant',
            text: blocksText(content, 'text'),
            reasoning: blocksText(content, 'reasoning'),
            usage: itemUsage,
          })
          break
        }
        case 'tool/call': {
          const callId = typeof data.callId === 'string' ? data.callId : `t${Date.now()}`
          setStream((prev) => (prev.tool ? { ...prev, tool: null } : prev))
          const name = typeof data.name === 'string' ? data.name : 'tool'
          const args = typeof data.arguments === 'string' ? data.arguments : ''
          const pre = toolResults.current.get(callId)
          if (pre !== undefined) {
            // The result arrived before its call row (out-of-order stream):
            // render the row already done instead of leaving a live spinner.
            toolResults.current.delete(callId)
            pushItem({ kind: 'tool', callId, name, args, ...pre })
          } else {
            toolStarts.current.set(callId, Date.now())
            runningTools.current.set(callId, { name, args })
            pushItem({ kind: 'tool', callId, name, args, status: 'running' })
          }
          break
        }
        case 'tool/result': {
          const message = data.message && typeof data.message === 'object' ? data.message : undefined
          const callId =
            typeof data.callId === 'string'
              ? data.callId
              : message && message.source && typeof message.source.callId === 'string'
                ? message.source.callId
                : undefined
          const resultBlock = Array.isArray(message?.content)
            ? message.content.find((block) => block && block.type === 'tool-result')
            : undefined
          const errorInfo = data.error && typeof data.error === 'object' ? data.error : undefined
          const isError = errorInfo !== undefined ? true : resultBlock ? resultBlock.isError === true : false
          const start = callId !== undefined ? toolStarts.current.get(callId) : undefined
          if (callId !== undefined) toolStarts.current.delete(callId)
          const seconds = start !== undefined ? (Date.now() - start) / 1000 : undefined
          const text = toolResultText(message)
          const info = {
            status: isError ? 'error' : 'done',
            seconds,
            output: text,
            error: isError ? { name: errorInfo?.name ?? 'tool error', code: errorInfo?.code } : undefined,
          }
          let target = callId
          if (target === undefined) {
            // No id on the wire: patch the oldest still-running tool row.
            const first = runningTools.current.keys().next()
            if (!first.done) target = first.value
          }
          if (target !== undefined) runningTools.current.delete(target)
          // Stash the outcome so a late tool/call (out-of-order stream) can
          // render the row done; capped so the guard cannot grow unbounded.
          toolResults.current.set(target ?? `t${Date.now()}`, info)
          if (toolResults.current.size > 32) {
            toolResults.current.delete(toolResults.current.keys().next().value)
          }
          setItems((prev) =>
            prev.map((item) =>
              item.kind === 'tool' && target !== undefined && item.callId === target
                ? { ...item, ...info }
                : item,
            ),
          )
          break
        }
        case 'todo/write': {
          if (Array.isArray(data.todos)) setTodos(data.todos)
          break
        }
        default:
          // user/message is already shown optimistically; unknown event types
          // (fast-moving harness) are ignored safely.
          break
      }
    },
    [firstSeq, pushItem, clearHint],
  )

  // Register this component's event consumer with the non-React bridge once.
  useEffect(() => {
    onEvent(handleEvent)
    return () => onEvent(null)
  }, [onEvent, handleEvent])

  const send = useCallback(
    (text) => {
      const value = typeof text === 'string' ? text.trim() : ''
      if (value === '') return
      if (busy) {
        showBusyHint()
        return
      }
      setInput('')
      setHint(null)
      setScrollLines(0)
      setBusy(true)
      lastUserText.current = value
      pushItem({ kind: 'user', text: value })
      try {
        // Fire-and-forget: session events drive the UI, not this promise.
        agent.followup(createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }))
      } catch (error) {
        setBusy(false)
        pushItem({ kind: 'status', text: `✗ ${error instanceof Error ? error.message : String(error)}`, error: true })
      }
    },
    [busy, agent, pushItem, showBusyHint],
  )

  const handleSubmit = useCallback(
    (value) => {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return
      // Slash commands stay usable while a turn is running (quit/clear must
      // never be hostage to the model).
      if (text === '/help') {
        setInput('')
        setHint(null)
        pushItem({ kind: 'status', text: HELP_TEXT })
        return
      }
      if (text === '/clear') {
        setInput('')
        setHint(null)
        setItems([])
        setTodos([])
        setStream({ reasoning: '', text: '', tool: null })
        usageRef.current = null
        toolStarts.current = new Map()
        runningTools.current = new Map()
        toolResults.current = new Map()
        setScrollLines(0)
        return
      }
      if (text === '/exit' || text === '/quit') {
        setInput('')
        handleExit()
        return
      }
      if (text === '/retry') {
        setInput('')
        if (busy) {
          showBusyHint()
        } else if (lastUserText.current === '') {
          flashHint('(nothing to retry yet)')
        } else {
          send(lastUserText.current)
        }
        return
      }
      if (busy) {
        showBusyHint()
        return
      }
      send(text)
    },
    [busy, handleExit, send, showBusyHint, flashHint],
  )

  // ── Viewport: keep the transcript tail visible (bottom-anchored), with
  // line-based scrolling on top (scrollLines = lines offset from the bottom).
  const viewport = computeViewport({ items, rows, width, scrollLines, busy, todos, thinkingOpen })
  const { visible, scrollLines: clampedLines, atBottom, step } = viewport
  useEffect(() => {
    viewportStep.current = step
  }, [step])

  // ── Layout ───────────────────────────────────────────────────────────────────
  // Empty state: DeepSeek brand banner + info panel (Hermes-style), no
  // permanent chrome — model · cwd live in the footer once the chat starts.
  const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : ''
  const home = typeof process !== 'undefined' ? process.env.HOME : undefined
  const shortCwd =
    cwd !== '' && home && cwd.startsWith(home) ? (cwd === home ? '~' : `~${cwd.slice(home.length)}`) : cwd

  const DEEPSEEK_LOGO = [
    '██████╗ ███████╗███████╗██████╗ ███████╗███████╗███████╗██╗  ██╗',
    '██╔══██╗██╔════╝██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██║ ██╔╝',
    '██║  ██║█████╗  █████╗  ██████╔╝███████╗█████╗  █████╗  █████╔╝ ',
    '██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ╚════██║██╔══╝  ██╔══╝  ██╔═██╗ ',
    '██████╔╝███████╗███████╗██║     ███████║███████╗███████╗██║  ██╗',
    '╚═════╝ ╚══════╝╚══════╝╚═╝     ╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝',
  ]
  const LOGO_GRADIENT = ['#4D6BFE', '#5B79FE', '#6D8AFE', '#829CFE', '#9AB1FF', '#B5C6FF']

  const welcome =
    items.length === 0 && stream.text === '' && stream.reasoning === '' && stream.tool === null
      ? el(
          Box,
          { flexDirection: 'column', alignItems: 'center', marginTop: 1, paddingLeft: 1, paddingRight: 1 },
          ...DEEPSEEK_LOGO.map((line, i) => el(Text, { key: `logo${i}`, color: LOGO_GRADIENT[i] }, line)),
          el(Box, { flexDirection: 'row', marginTop: 1 },
            el(Text, { bold: true, color: '#6D8AFE' }, 'DeepSeek Harness'),
            el(Text, { dimColor: true }, '  ·  terminal AI chat for the DeepSeek Harness')),
          el(Box, { borderStyle: 'single', borderColor: '#4D6BFE', marginTop: 1, paddingLeft: 2, paddingRight: 2, flexDirection: 'column' },
            el(Box, { flexDirection: 'row' },
              el(Text, { dimColor: true }, 'model     '),
              el(Text, { bold: true }, model),
              el(Text, { dimColor: true }, '  ·  StepFun Step Explore')),
            el(Box, { flexDirection: 'row' },
              el(Text, { dimColor: true }, 'directory '),
              el(Text, {}, shortCwd)),
            el(Box, { flexDirection: 'row' },
              el(Text, { dimColor: true }, 'commands  '),
              el(Text, {}, '/help · /clear · /exit')),
          ),
          el(Text, { dimColor: true, marginTop: 1 }, 'press /help for keys · ctrl + c to quit'),
        )
      : null

  const transcript = el(
    Box,
    { flexDirection: 'column', paddingLeft: 1, paddingRight: 1 },
    el(ErrorBoundary, { resetKey: items.length },
      el(TodoPanel, { todos }),
      welcome,
      ...visible.map((item, index) => el(ChatRow, { key: index, item, width, thinkingOpen, themeBg })),
      ...(clampedLines === 0
        ? [el(StreamBlock, { key: 'stream', stream, width, thinkingOpen, themeBg })]
        : []),
    ),
  )

  const idleSeconds = busy ? Math.floor((Date.now() - lastEventAt.current) / 1000) : 0
  const statusRow = busy
    ? el(
        Box,
        { paddingLeft: 1, paddingRight: 1, flexDirection: 'row' },
        el(BrailleSpinner),
        el(Text, { bold: true, color: ACCENT }, ' Working'),
        el(Text, { dimColor: true }, ` ${turnStart.current !== undefined ? fmtElapsedCompact(Date.now() - turnStart.current) : ''}`),
        ...(idleSeconds >= 15
          ? [el(Text, { dimColor: true, color: idleSeconds >= 60 ? ERR : undefined }, ` · 模型思考中 ${idleSeconds}s`)]
          : []),
        el(Box, { flexGrow: 1 }),
        el(Text, { dimColor: true }, 'esc interrupt'),
      )
    : null

  const scrollHint = !atBottom
    ? el(Text, { dimColor: true }, `  ↑ ${clampedLines} line${clampedLines === 1 ? '' : 's'} above · esc back to latest`)
    : null

  const inputRow = el(
    Box,
    { paddingLeft: 1, paddingRight: 1, flexDirection: 'row' },
    el(Text, { bold: true, color: ACCENT }, '❯ '),
    el(TextInput, { value: input, onChange: setInput, onSubmit: handleSubmit, placeholder: 'Ask anything' }),
  )

  const hintLeft = `  ${model} · ${shortCwd}`
  const hintRightParts = []
  if (hint !== null) hintRightParts.push(hint)
  hintRightParts.push(thinkingOpen ? 'ctrl + t: hide thinking' : 'ctrl + t: show thinking')
  hintRightParts.push('ctrl + c quit')
  const hintRow = el(
    Box,
    { paddingLeft: 1, paddingRight: 1, flexDirection: 'row' },
    el(Text, { dimColor: true }, hintLeft),
    el(Box, { flexGrow: 1 }),
    el(Text, { dimColor: true }, hintRightParts.join('   ')),
  )

  return el(
    Box,
    { flexDirection: 'column', height: '100%' },
    el(Box, { flexGrow: 1, flexDirection: 'column', overflow: 'hidden' }, transcript),
    statusRow,
    scrollHint,
    inputRow,
    hintRow,
  )
}

// ── Viewport math (pure, exported for tests) ───────────────────────────────

/** Line count of a markdown body as rendered by markdownLines(). */
function markdownLineCount(text, width) {
  const avail = Math.max(1, width - TRANSCRIPT_PAD - MARKDOWN_GUTTER)
  let n = 0
  for (const block of splitCodeBlocks(String(text))) {
    n += wrapText(block.content, avail).length
  }
  return n
}

/**
 * Rendered-line estimate for one transcript item, matching ChatRow layout.
 * Overestimating slightly is fine (viewport clips the tail, never the head).
 */
export function estimateItemLines(item, width, thinkingOpen = true) {
  const avail = Math.max(1, width - 6)
  const text = item && typeof item.text === 'string' ? item.text : ''
  const output = item && typeof item.output === 'string' ? item.output : ''
  switch (item && item.kind) {
    case 'user': {
      let n = 0
      for (const line of text.split('\n')) {
        n += wrapText(line, Math.max(1, width - TRANSCRIPT_PAD - USER_LINE_PAD - USER_PREFIX_W)).length
      }
      return Math.max(1, n)
    }
    case 'assistant': {
      let n = 1 // marginTop
      if (thinkingOpen && item.reasoning !== undefined && item.reasoning !== '') {
        n += 1 + wrapText(String(item.reasoning), avail).length
      }
      if (text !== '') n += markdownLineCount(text, width)
      if (item.usage) n += 1
      return Math.max(1, n)
    }
    case 'tool': {
      let n = 2 // marginTop + status head
      const out = splitOutput(output)
      if (out !== null) {
        for (const line of out.lines) n += wrapText(line, avail).length
        if (out.omitted > 0) n += 1
      }
      if (item.status === 'error' && item.error) n += 1
      return Math.max(1, n)
    }
    case 'divider':
      return 1
    default:
      return Math.max(1, wrapText(String(item && item.text ? item.text : ''), Math.max(1, width - 2)).length)
  }
}

/**
 * Compute the visible transcript slice for a scroll position.
 * `scrollLines` is the offset in rendered lines from the bottom (0 = bottom
 * anchored, i.e. the latest messages are visible).
 */
export function computeViewport({ items, rows, width, scrollLines, busy, todos = [], thinkingOpen = true }) {
  const heights = items.map((item) => estimateItemLines(item, width, thinkingOpen))
  const totalLines = heights.reduce((a, b) => a + b, 0)
  // Chrome rows: status row (busy) + scroll hint + composer + footer +
  // empty-state banner + todo panel.
  const chromeLines =
    (busy ? 1 : 0) +
    (scrollLines > 0 ? 1 : 0) +
    2 +
    (items.length === 0 ? 1 : 0) +
    (todos.length > 0 ? 2 + todos.length : 0)
  const available = Math.max(6, rows - chromeLines)
  const maxScroll = Math.max(0, totalLines - 1)
  const lines = Math.min(Math.max(0, scrollLines), maxScroll)

  let visible = []
  if (items.length > 0) {
    // Window bottom = the item that contains the `lines`-th line from bottom.
    let endIdx = items.length - 1
    let consumed = 0
    for (let i = items.length - 1; i >= 0; i--) {
      if (consumed + heights[i] > lines) {
        endIdx = i
        break
      }
      consumed += heights[i]
      if (i === 0) endIdx = 0
    }
    // Fill upward from the window bottom until the viewport is full.
    let startIdx = endIdx
    let total = 0
    for (let i = endIdx; i >= 0; i--) {
      if (total + heights[i] > available) break
      total += heights[i]
      startIdx = i
    }
    visible = items.slice(startIdx, endIdx + 1)
  }
  return {
    visible,
    scrollLines: lines,
    maxScroll,
    atBottom: lines === 0,
    atTop: lines >= maxScroll,
    step: Math.max(4, Math.floor(available / 2)),
  }
}

// Pure helpers, exported for tests (no Ink dependencies beyond React elements).
export { wrapText, truncate, splitOutput, stripAnsi, userMessageBg, codeChipBg, markdownLines, splitCodeBlocks }
