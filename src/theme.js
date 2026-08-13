/**
 * Terminal background probing (OSC 11).
 *
 * MUST run before Ink mounts: Ink's key parser treats the terminal's OSC
 * response bytes as keystrokes and would type `]11;rgb:...` into the
 * composer. The probe reads the response in raw mode while Ink is not yet
 * listening, then hands the color to the App as an initial value.
 */

import { hexToRgb, rgbToHex } from './utils.js'

/**
 * Resolve the terminal background color, or `null` when unknown.
 * `DSH_TUI_BG` forces a value (theme testing).
 */
export function probeTerminalBg(timeoutMs = 300) {
  const forced = process.env.DSH_TUI_BG
  if (forced) {
    const rgb = hexToRgb(forced)
    return Promise.resolve(rgb ? rgbToHex(rgb) : null)
  }
  return new Promise((resolve) => {
    const stdin = process.stdin
    const stdout = process.stdout
    if (!stdin || !stdout || !stdin.isTTY || !stdout.isTTY) {
      resolve(null)
      return
    }
    let settled = false
    let buffer = ''
    const finish = (hex) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.off('data', onData)
      try {
        stdin.setRawMode(false)
      } catch {}
      resolve(hex)
    }
    // The terminator (ST `\x1b\\` or BEL `\x07`) is part of the match so the
    // response's tail bytes never reach Ink's key parser as a stray ESC.
    const OSC11_RE = /\x1b\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})(?:\x1b\\|\x07)/i
    const onData = (chunk) => {
      buffer += chunk.toString()
      const match = buffer.match(OSC11_RE)
      if (match) {
        // OSC 11 carries 16-bit (4-digit) channels; the high byte IS the 8-bit
        // conversion. Terminals that send 2-digit values pass through unchanged.
        const scale = (v) => Math.min(255, parseInt(v.slice(0, 2), 16))
        finish(rgbToHex([scale(match[1]), scale(match[2]), scale(match[3])]))
      } else if (buffer.length > 80) {
        finish(null)
      }
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      stdin.setRawMode(true)
      stdin.resume()
    } catch {
      finish(null)
      return
    }
    stdin.on('data', onData)
    try {
      stdout.write('\x1b]11;?\x1b\\')
    } catch {
      finish(null)
    }
  })
}
