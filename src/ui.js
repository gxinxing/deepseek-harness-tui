/**
 * dsh-tui Ink UI — plain React (React.createElement only, no JSX, no build).
 *
 * Design: terminal-native TUI, distilled from Hermes-style agent UIs.
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
import { execFileSync } from 'node:child_process'
import {
  MAX_ITEMS, MAX_TOOL_ARGS, MAX_RESULT_PREVIEW, OUTPUT_HEAD, OUTPUT_TAIL,
  userMessageBg, codeChipBg,
  strWidth, wrapText, prefixedLines, truncate,
  stripAnsi, fmtDuration, fmtElapsedCompact, usageText, reasonText,
  blocksText, toolResultText, splitOutput, splitCodeBlocks,
} from './utils.js'

/** createElement shorthand. */
const el = React.createElement

// ── Semantic palette (terminal-default based) ──────────────────────
const ACCENT = 'cyan' // input ›, user ▌, activity markers
const OK = 'green' // ✓, command output
const ERR = 'red' // ✗, errors
const BRAND = 'magenta' // `$` prompt, app mark

/** Braille spinner (ink-spinner has no braille frame set). */
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function BrailleSpinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % BRAILLE_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])
  return el(Text, null, BRAILLE_FRAMES[frame])
}

const AVAILABLE_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

const HELP_TEXT = [
  'commands:',
  '  /help         show this help',
  '  /model        show current model',
  '  /model <name> switch model (e.g. /model deepseek-v4-pro)',
  '  /copy         copy last response to clipboard',
  '  /clear        clear the transcript',
  '  /exit, /quit  quit dsh tui',
  'keys:',
  '  ctrl + t      toggle thinking display',
  '  ↑ / ↓         recall previous messages',
  '  ctrl + c      quit',
].join('\n')

// ── Markdown (keep `#` and fences, no boxes) ────────────────────────

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
 * column, giving the aligned-gutter look.
 */
function markdownLines(text, width, indent = 2, chipBg = '#333333', prefix = '') {
  const pad = ' '.repeat(indent)
  const avail = Math.max(1, width - indent)
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

function ChatRow({ item, width, thinkingOpen, themeBg }) {
  switch (item.kind) {
    case 'user': {
      // Faint derived background + cyan ▌ prefix (user-message style).
      return el(
        Box,
        { flexDirection: 'column', backgroundColor: userMessageBg(themeBg), paddingY: 0, flexShrink: 0 },
        ...plainLines(item.text, width - 2, '▌ ', 2).map((line, i) =>
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
          el(Box, { key: 'body', flexDirection: 'column' }, ...markdownLines(item.text, width, 2, codeChipBg(themeBg), '• ')),
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
      const cmd = `${item.name} ${truncate(item.args, MAX_TOOL_ARGS)}`.trim()
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
        rows.push(el(Text, { key: 'err', color: ERR, wrap: 'wrap' }, `    error: ${item.error.code ?? item.error.name ?? 'unknown'}`))
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
      el(Box, { key: 'text', flexDirection: 'column', marginTop: 1 }, ...markdownLines(stream.text, width, 2, codeChipBg(themeBg), '• ')),
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

export function App({ agent, onEvent, onExit, onInterrupt, onModelSwitch, firstSeq = 0, model = '?', themeBg = '#000000' }) {
  const [items, setItems] = useState([])
  const [todos, setTodos] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [stream, setStream] = useState({ reasoning: '', text: '', tool: null })
  const [hint, setHint] = useState(null)
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const [, setTick] = useState(0) // drives the Working elapsed timer
  const usageRef = useRef(null)
  const hintTimer = useRef(undefined)
  const exiting = useRef(false)
  const toolStarts = useRef(new Map())
  const turnStart = useRef(undefined)
  const historyRef = useRef([])
  const historyIdx = useRef(-1) // -1 = not navigating; >=0 = position in history
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

  const showBusyHint = useCallback(() => {
    setHint('(busy — waiting for the model)')
    if (hintTimer.current !== undefined) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => {
      hintTimer.current = undefined
      setHint(null)
    }, 1500)
  }, [])

  /** Exit the Ink app, then request the harness process exit. Never twice. */
  const handleExit = useCallback(() => {
    if (exiting.current) return
    exiting.current = true
    inkExit()
    onExit()
  }, [inkExit, onExit])

  // Global keys: esc interrupts the live turn, ctrl + t toggles thinking,
  // ctrl + c quits, up/down recalls input history. Bare letters never hijack typing.
  useInput((rawInput, key) => {
    if (key.ctrl && rawInput === 'c') handleExit()
    else if (key.escape && busy && typeof onInterrupt === 'function') onInterrupt()
    else if (key.ctrl && rawInput === 't') setThinkingOpen((v) => !v)
    else if (key.upArrow) {
      const hist = historyRef.current
      if (hist.length === 0) return
      const next = historyIdx.current < 0 ? hist.length - 1 : Math.max(0, historyIdx.current - 1)
      historyIdx.current = next
      setInput(hist[next])
    } else if (key.downArrow) {
      const hist = historyRef.current
      if (hist.length === 0 || historyIdx.current < 0) return
      const next = historyIdx.current + 1
      if (next >= hist.length) {
        historyIdx.current = -1
        setInput('')
      } else {
        historyIdx.current = next
        setInput(hist[next])
      }
    }
  })

  /** Map one SessionEvent to UI state. Defensive: unknown shapes are ignored. */
  const handleEvent = useCallback(
    (event) => {
      if (!event || typeof event !== 'object') return
      // Events below the agent's live boundary are seed history, not chat.
      if (typeof event.seq === 'number' && event.seq < firstSeq) return
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      switch (event.type) {
        case 'turn/start':
          setBusy(true)
          turnStart.current = Date.now()
          setStream({ reasoning: '', text: '', tool: null })
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
          const label = reasonText(reason)
          const usageLine = usageText(usageRef.current)
          const text = usageLine === '' ? label : `${label} · ${usageLine}`
          const isError = reason.kind === 'error'
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
          toolStarts.current.set(callId, Date.now())
          pushItem({
            kind: 'tool',
            callId,
            name: typeof data.name === 'string' ? data.name : 'tool',
            args: typeof data.arguments === 'string' ? data.arguments : '',
            status: 'running',
          })
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
          setItems((prev) =>
            prev.map((item) =>
              item.kind === 'tool' && callId !== undefined && item.callId === callId
                ? {
                    ...item,
                    status: isError ? 'error' : 'done',
                    seconds,
                    output: text,
                    error: isError ? { name: errorInfo?.name ?? 'tool error', code: errorInfo?.code } : undefined,
                  }
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
      if (text === '/model') {
        setInput('')
        setHint(null)
        pushItem({ kind: 'status', text: `current model: ${model}\navailable: ${AVAILABLE_MODELS.join(', ')}` })
        return
      }
      if (text.startsWith('/model ')) {
        const requested = text.slice('/model '.length).trim()
        setInput('')
        setHint(null)
        if (!AVAILABLE_MODELS.includes(requested)) {
          pushItem({ kind: 'status', text: `✗ unknown model: ${requested}\navailable: ${AVAILABLE_MODELS.join(', ')}`, error: true })
          return
        }
        if (typeof onModelSwitch === 'function') {
          const result = onModelSwitch(requested)
          if (result === true) {
            pushItem({ kind: 'status', text: `✓ switched to ${requested}` })
          } else {
            pushItem({ kind: 'status', text: `✗ model switch not supported in this session`, error: true })
          }
        } else {
          pushItem({ kind: 'status', text: '✗ model switching is not available', error: true })
        }
        return
      }
      if (text === '/copy') {
        setInput('')
        setHint(null)
        const lastAssistant = [...items].reverse().find((item) => item.kind === 'assistant' && item.text !== '')
        if (!lastAssistant) {
          pushItem({ kind: 'status', text: '✗ no response to copy', error: true })
          return
        }
        try {
          const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip'
          execFileSync(cmd, { input: lastAssistant.text, stdio: ['pipe', 'ignore', 'ignore'] })
          pushItem({ kind: 'status', text: '✓ copied last response to clipboard' })
        } catch {
          pushItem({ kind: 'status', text: '✗ clipboard not available (install pbcopy or xclip)', error: true })
        }
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
        return
      }
      if (text === '/exit' || text === '/quit') {
        setInput('')
        handleExit()
        return
      }
      if (busy) {
        showBusyHint()
        return
      }
      // Push to history (dedupe consecutive duplicates).
      const hist = historyRef.current
      if (hist.length === 0 || hist[hist.length - 1] !== text) hist.push(text)
      historyIdx.current = -1
      setInput('')
      setHint(null)
      setBusy(true)
      pushItem({ kind: 'user', text })
      try {
        // Fire-and-forget: session events drive the UI, not this promise.
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      } catch (error) {
        setBusy(false)
        pushItem({ kind: 'status', text: `✗ ${error instanceof Error ? error.message : String(error)}`, error: true })
      }
    },
    [busy, agent, handleExit, pushItem, showBusyHint, items, model, onModelSwitch],
  )

  // ── Viewport: keep the transcript tail visible (bottom-anchored). ──
  // Rough per-item height estimates; good enough to avoid clipping the tail.
  const estimateLines = (item) => {
    const text =
      item && typeof item.text === 'string'
        ? item.text
        : item && typeof item.output === 'string'
          ? item.output
          : ''
    const wrapped = Math.max(1, Math.ceil(strWidth(text) / Math.max(1, width - 6)))
    switch (item.kind) {
      case 'user': return wrapped + 2
      case 'assistant':
        return Math.ceil(text.split('\n').length * 1.1) + (item.reasoning ? 3 : 0) + 2
      case 'tool': return 2 + (item.output ? Math.min(wrapped, OUTPUT_HEAD + OUTPUT_TAIL + 2) : 0)
      case 'divider': return 1
      default: return Math.max(1, typeof item.text === 'string' ? item.text.split('\n').length : 1)
    }
  }
  const chromeLines = (busy ? 1 : 0) + 1 + 1 + (items.length === 0 ? 1 : 0) + (todos.length > 0 ? 2 + todos.length : 0)
  const available = Math.max(6, rows - chromeLines)
  let visible = items
  let total = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const h = estimateLines(items[i])
    if (total + h > available && i < items.length - 1) {
      visible = items.slice(i + 1)
      break
    }
    total += h
  }

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
              el(Text, { dimColor: true }, '  ·  TokenDance gateway')),
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
    el(TodoPanel, { todos }),
    welcome,
    ...visible.map((item, index) => el(ChatRow, { key: index, item, width, thinkingOpen, themeBg })),
    el(StreamBlock, { key: 'stream', stream, width, thinkingOpen, themeBg }),
  )

  const statusRow = busy
    ? el(
        Box,
        { paddingLeft: 1, paddingRight: 1, flexDirection: 'row' },
        el(BrailleSpinner),
        el(Text, { bold: true, color: ACCENT }, ' Working'),
        el(Text, { dimColor: true }, ` ${turnStart.current !== undefined ? fmtElapsedCompact(Date.now() - turnStart.current) : ''}`),
        el(Box, { flexGrow: 1 }),
        el(Text, { dimColor: true }, 'esc interrupt'),
      )
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
  hintRightParts.push(thinkingOpen ? 'ctrl+t hide' : 'ctrl+t show')
  hintRightParts.push('↑↓ history')
  hintRightParts.push('ctrl+c quit')
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
    inputRow,
    hintRow,
  )
}

// Pure helpers, re-exported for tests (imported from ./utils.js).
export { wrapText, truncate, splitOutput, stripAnsi, userMessageBg, codeChipBg, markdownLines, splitCodeBlocks }
