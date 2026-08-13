/**
 * Pure utility functions for dsh-tui — no React/Ink dependencies.
 *
 * Extracted from ui.js so they can be unit-tested in isolation.
 */

// ── Caps ──────────────────────────────────────────────────────────────────
export const MAX_ITEMS = 500
export const MAX_TOOL_ARGS = 160
export const MAX_RESULT_PREVIEW = 300
export const OUTPUT_HEAD = 10 // first output lines kept per tool result
export const OUTPUT_TAIL = 6 // last output lines kept per tool result

// ── Color utilities ───────────────────────────────────────────────────────

export const isLightBg = (rgb) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 128

export const blend = (fg, bg, alpha) => [
  Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
  Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
  Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
]

export const rgbToHex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

/**
 * Parse `#rrggbb` into an RGB triple, or `null` when the input is not a
 * color. `null` (rather than a black triple) is the single source of truth
 * for "unknown background": theme.js needs it to tell a failed OSC 11 probe
 * apart from a terminal that really is black. Callers that need a color
 * substitute their own fallback — see UNKNOWN_BG below.
 */
export const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '')
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
}

/** Tints assume a black background when the real one is unknown. */
const UNKNOWN_BG = [0, 0, 0]

/** Faint block behind user messages (user_message_bg_rgb). */
export const userMessageBg = (bgHex) => {
  const bg = hexToRgb(bgHex) ?? UNKNOWN_BG
  const light = isLightBg(bg)
  return rgbToHex(blend(light ? [0, 0, 0] : [255, 255, 255], bg, light ? 0.04 : 0.12))
}

/** Slightly stronger chip behind inline code. */
export const codeChipBg = (bgHex) => {
  const bg = hexToRgb(bgHex) ?? UNKNOWN_BG
  const light = isLightBg(bg)
  return rgbToHex(blend(light ? [0, 0, 0] : [255, 255, 255], bg, light ? 0.08 : 0.22))
}

// ── Width helpers (CJK-aware) ─────────────────────────────────────────────

const WIDE_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f1e6}-\u{1f1ff}\u{1f300}-\u{1faff}]/u
const ZERO_RE = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/

export function wcwidth(ch) {
  if (ZERO_RE.test(ch)) return 0
  return WIDE_RE.test(ch) ? 2 : 1
}

export function strWidth(text) {
  let w = 0
  for (const ch of text) w += wcwidth(ch)
  return w
}

// ── Text wrapping ─────────────────────────────────────────────────────────

/** Wrap `text` to `width` columns; returns an array of lines. Newlines split first. */
export function wrapText(text, width) {
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
 * spaces — the aligned-gutter look.
 */
export function prefixedLines(text, width, prefix, indent = 2) {
  const pad = ' '.repeat(indent)
  const avail = Math.max(1, width - indent)
  const lines = wrapText(text, avail)
  if (lines.length === 0) return [prefix]
  return [prefix + lines[0], ...lines.slice(1).map((line) => pad + line)]
}

/** Clip a string to `max` chars with an ellipsis. */
export function truncate(text, max) {
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

// ── ANSI stripping ────────────────────────────────────────────────────────

/** Strip CSI/OSC escapes so raw tool bytes cannot repaint the TUI. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '')
}

// ── Time formatting ───────────────────────────────────────────────────────

export function fmtDuration(ms) {
  const sec = Math.max(0, ms) / 1000
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

/** Compact elapsed: 0s, 59s, 1m 02s, 1h 02m 03s. */
export function fmtElapsedCompact(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

// ── Token usage ───────────────────────────────────────────────────────────

/** Compact token-usage line; omits missing fields. */
export function usageText(usage) {
  if (!usage || typeof usage !== 'object') return ''
  const parts = []
  if (typeof usage.inputTokens === 'number') parts.push(`${usage.inputTokens}in`)
  if (typeof usage.outputTokens === 'number') parts.push(`${usage.outputTokens}out`)
  if (typeof usage.cacheReadTokens === 'number') parts.push(`${usage.cacheReadTokens}cache`)
  return parts.length > 0 ? `usage: ${parts.join(' ')}` : ''
}

// ── Turn reason ───────────────────────────────────────────────────────────

/** Human label for a turn-end reason. */
export function reasonText(reason) {
  if (!reason || typeof reason !== 'object') return 'ended'
  switch (reason.kind) {
    case 'completed': return '✓ completed'
    case 'error': return `✗ error: ${reason.error?.code ?? 'UNKNOWN'} ${reason.error?.message ?? ''}`
    case 'aborted': return '⏹ aborted'
    case 'max-tokens': return '⚠ max-tokens'
    default: return String(reason.kind)
  }
}

// ── Content extraction ────────────────────────────────────────────────────

/** Join the text of every block of one `type` in a message content array. */
export function blocksText(content, type) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && block.type === type && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** First text found in a tool-result message (ToolResultBlock inner blocks). */
export function toolResultText(message) {
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

// ── Output truncation ─────────────────────────────────────────────────────

/** Cap tool output to head + tail lines with an ellipsis marker. */
export function splitOutput(text) {
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

// ── Markdown block splitting ──────────────────────────────────────────────

/** Split text into fenced code blocks and plain segments. */
export function splitCodeBlocks(text) {
  if (text === '') return [{ type: 'text', content: '' }]
  const blocks = []
  const fence = /```[\s\S]*?```/g
  let last = 0
  let match
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) {
      const content = text.slice(last, match.index).replace(/^\n+|\n+$/g, '')
      if (content !== '') blocks.push({ type: 'text', content })
    }
    blocks.push({ type: 'code', content: match[0] })
    last = match.index + match[0].length
  }
  // Remaining text after last fence (or entire string if no fence matched).
  if (last < text.length) {
    const remaining = text.slice(last)
    // If it starts with an unclosed fence, treat it as a code block.
    if (remaining.startsWith('```')) {
      blocks.push({ type: 'code', content: remaining })
    } else {
      const content = remaining.replace(/^\n+|\n+$/g, '')
      if (content !== '') blocks.push({ type: 'text', content })
    }
  }
  return blocks
}
