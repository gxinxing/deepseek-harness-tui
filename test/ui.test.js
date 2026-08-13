import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { wrapText, truncate, splitOutput, stripAnsi, userMessageBg, codeChipBg, markdownLines, splitCodeBlocks } from '../src/ui.js'

// ── splitCodeBlocks ───────────────────────────────────────────────────────

describe('splitCodeBlocks', () => {
  test('plain text with no fences returns a single text block', () => {
    const result = splitCodeBlocks('hello world')
    assert.deepEqual(result, [{ type: 'text', content: 'hello world' }])
  })

  test('single code block returns one code block', () => {
    const input = '```js\nconsole.log(1)\n```'
    const result = splitCodeBlocks(input)
    assert.deepEqual(result, [{ type: 'code', content: input }])
  })

  test('code block containing backticks is NOT split', () => {
    const input = '```\nfoo `bar` baz\n```'
    const result = splitCodeBlocks(input)
    assert.deepEqual(result, [{ type: 'code', content: input }])
  })

  test('text before and after code yields three blocks', () => {
    const input = 'before\n```\ncode\n```\nafter'
    const result = splitCodeBlocks(input)
    assert.deepEqual(result, [
      { type: 'text', content: 'before' },
      { type: 'code', content: '```\ncode\n```' },
      { type: 'text', content: 'after' },
    ])
  })

  test('multiple code blocks separated by text', () => {
    const input = '```\na\n```\nmid\n```\nb\n```'
    const result = splitCodeBlocks(input)
    assert.deepEqual(result, [
      { type: 'code', content: '```\na\n```' },
      { type: 'text', content: 'mid' },
      { type: 'code', content: '```\nb\n```' },
    ])
  })

  test('empty string returns a single empty text block', () => {
    const result = splitCodeBlocks('')
    assert.deepEqual(result, [{ type: 'text', content: '' }])
  })

  test('unclosed fence is treated as a single code block', () => {
    const input = '```\nhello'
    const result = splitCodeBlocks(input)
    assert.deepEqual(result, [{ type: 'code', content: input }])
  })
})

// ── wrapText ──────────────────────────────────────────────────────────────

describe('wrapText', () => {
  test('short string within width returns single line', () => {
    assert.deepEqual(wrapText('hello', 10), ['hello'])
  })

  test('wrapping splits long string at width boundary', () => {
    const result = wrapText('hello world', 5)
    assert.ok(result.length > 1, 'should produce more than one line')
    assert.equal(result[0], 'hello', 'first line should be "hello"')
    // Every character from the original should be present across all lines
    const joined = result.join('')
    assert.equal(joined, 'hello world', 'all characters preserved')
  })

  test('newline splitting produces separate lines', () => {
    assert.deepEqual(wrapText('a\nb', 10), ['a', 'b'])
  })

  test('CJK characters are width 2', () => {
    assert.deepEqual(wrapText('你好世界', 4), ['你好', '世界'])
  })

  test('empty string returns array with one empty string', () => {
    assert.deepEqual(wrapText('', 10), [''])
  })
})

// ── truncate ──────────────────────────────────────────────────────────────

describe('truncate', () => {
  test('no truncation when within max', () => {
    assert.equal(truncate('hello', 10), 'hello')
  })

  test('truncation with ellipsis', () => {
    assert.equal(truncate('hello', 3), 'he…')
  })

  test('CJK truncation respects display width', () => {
    // 你好 is 4 columns wide (2 per CJK char); max 3 → keep 2 cols + ellipsis
    assert.equal(truncate('你好', 3), '你…')
  })
})

// ── stripAnsi ─────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  test('removes color codes', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red')
  })

  test('removes OSC sequence entirely', () => {
    assert.equal(stripAnsi('\x1b]11;rgb:1/2/3\x1b\\'), '')
  })

  test('plain text passes through unchanged', () => {
    assert.equal(stripAnsi('hello'), 'hello')
  })

  test('mixed escape sequences and plain text', () => {
    assert.equal(stripAnsi('\x1b[1mbold\x1b[0m text'), 'bold text')
  })
})

// ── splitOutput ───────────────────────────────────────────────────────────

describe('splitOutput', () => {
  test('null input returns null', () => {
    assert.equal(splitOutput(null), null)
  })

  test('empty string returns null', () => {
    assert.equal(splitOutput(''), null)
  })

  test('short output returns all lines with zero omitted', () => {
    assert.deepEqual(splitOutput('a\nb\nc'), { lines: ['a', 'b', 'c'], omitted: 0 })
  })

  test('long output (>16 lines) returns head + tail with omitted count', () => {
    // Generate 20 lines (exceeds OUTPUT_HEAD=10 + OUTPUT_TAIL=6 = 16)
    const lines = []
    for (let i = 1; i <= 20; i++) {
      lines.push(`line${String(i).padStart(2, '0')}`)
    }
    const input = lines.join('\n')
    const result = splitOutput(input)
    assert.ok(result !== null, 'should not return null for non-empty input')
    // Head: first 10 lines, Tail: last 6 lines
    assert.equal(result.lines.length, 16, 'should return 16 lines (10 head + 6 tail)')
    assert.equal(result.lines[0], 'line01', 'first line should be line01')
    assert.equal(result.lines[9], 'line10', '10th line should be line10')
    assert.equal(result.lines[10], 'line15', '11th line should be line15 (start of tail)')
    assert.equal(result.lines[15], 'line20', 'last line should be line20')
    assert.equal(result.omitted, 4, 'should omit 4 lines (20 - 10 - 6)')
  })
})

// ── userMessageBg ──────────────────────────────────────────────────────────

describe('userMessageBg', () => {
  test('dark background returns a valid hex string', () => {
    const result = userMessageBg('#000000')
    assert.match(result, /^#[0-9a-f]{6}$/i)
  })

  test('light background returns a valid hex string', () => {
    const result = userMessageBg('#ffffff')
    assert.match(result, /^#[0-9a-f]{6}$/i)
  })

  test('dark vs light backgrounds produce different values', () => {
    const dark = userMessageBg('#000000')
    const light = userMessageBg('#ffffff')
    assert.notEqual(dark, light, 'dark and light backgrounds should produce different tints')
  })

  test('null input returns fallback without throwing', () => {
    // hexToRgb(null) → [0,0,0]; isLightBg([0,0,0]) → false;
    // blend([255,255,255], [0,0,0], 0.12) → [31,31,31] → #1f1f1f
    assert.equal(userMessageBg(null), '#1f1f1f')
    assert.equal(userMessageBg(undefined), '#1f1f1f')
    assert.equal(userMessageBg('invalid'), '#1f1f1f')
  })
})

// ── codeChipBg ────────────────────────────────────────────────────────────

describe('codeChipBg', () => {
  test('dark background returns a valid hex string', () => {
    const result = codeChipBg('#000000')
    assert.match(result, /^#[0-9a-f]{6}$/i)
  })

  test('light background returns a valid hex string', () => {
    const result = codeChipBg('#ffffff')
    assert.match(result, /^#[0-9a-f]{6}$/i)
  })

  test('dark vs light backgrounds produce different values', () => {
    const dark = codeChipBg('#000000')
    const light = codeChipBg('#ffffff')
    assert.notEqual(dark, light, 'dark and light backgrounds should produce different tints')
  })

  test('null input returns fallback without throwing', () => {
    // hexToRgb(null) → [0,0,0]; isLightBg([0,0,0]) → false;
    // blend([255,255,255], [0,0,0], 0.22) → [56,56,56] → #383838
    assert.equal(codeChipBg(null), '#383838')
    assert.equal(codeChipBg(undefined), '#383838')
    assert.equal(codeChipBg('invalid'), '#383838')
  })
})

// ── markdownLines ──────────────────────────────────────────────────────────

describe('markdownLines', () => {
  test('returns an array', () => {
    const result = markdownLines('hello world', 80)
    assert.ok(Array.isArray(result), 'should return an array')
  })

  test('has at least one element for any input', () => {
    const result = markdownLines('hello world', 80)
    assert.ok(result.length >= 1, 'should have at least one element')
  })

  test('simple header produces at least one element', () => {
    const result = markdownLines('# Title', 80)
    assert.ok(Array.isArray(result), 'should return an array')
    assert.ok(result.length >= 1, 'should have at least one element for a header')
  })
})
