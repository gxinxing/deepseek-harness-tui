import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateItemLines, computeViewport } from '../src/ui.js';

/**
 * Coverage for the pure viewport math. These two functions were exported and
 * imported by the suite but had no assertions of their own; the App render
 * path depends on them, so their contract is pinned here.
 */

const mkItems = (n, kind = 'user') =>
  Array.from({ length: n }, (_, i) => ({ kind, text: `msg ${i}` }));

const BASE = { rows: 24, width: 80, busy: false, todos: [], thinkingOpen: true };

// ── estimateItemLines ──────────────────────────────────────────────────────

describe('estimateItemLines', () => {
  test('always returns a positive integer', () => {
    for (const item of [
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'hello' },
      { kind: 'tool', status: 'ok' },
      { kind: 'divider' },
      { kind: 'unknown-kind', text: 'x' },
    ]) {
      const n = estimateItemLines(item, 80);
      assert.ok(Number.isInteger(n), `${item.kind} should yield an integer`);
      assert.ok(n >= 1, `${item.kind} should yield at least one line`);
    }
  });

  test('null and undefined items do not throw and return at least one line', () => {
    assert.equal(estimateItemLines(null, 80), 1);
    assert.equal(estimateItemLines(undefined, 80), 1);
  });

  test('divider occupies exactly one line', () => {
    assert.equal(estimateItemLines({ kind: 'divider' }, 80), 1);
  });

  test('multi-line user text costs more lines than single-line text', () => {
    const one = estimateItemLines({ kind: 'user', text: 'a' }, 80);
    const three = estimateItemLines({ kind: 'user', text: 'a\nb\nc' }, 80);
    assert.ok(three > one, 'three lines of input should estimate taller');
  });

  test('narrow width wraps into more lines than wide width', () => {
    const item = { kind: 'user', text: 'the quick brown fox jumps over the lazy dog' };
    assert.ok(estimateItemLines(item, 20) > estimateItemLines(item, 200));
  });

  test('assistant reasoning is only counted while thinking is open', () => {
    const item = { kind: 'assistant', text: 'answer', reasoning: 'some private thought' };
    const open = estimateItemLines(item, 80, true);
    const closed = estimateItemLines(item, 80, false);
    assert.ok(open > closed, 'open thinking should estimate taller');
  });

  test('tool output increases the estimate over a bare tool row', () => {
    const bare = estimateItemLines({ kind: 'tool', status: 'ok' }, 80);
    const withOutput = estimateItemLines({ kind: 'tool', status: 'ok', output: 'a\nb\nc' }, 80);
    assert.ok(withOutput > bare);
  });
});

// ── computeViewport ────────────────────────────────────────────────────────

describe('computeViewport', () => {
  test('bottom anchored by default: scrollLines 0 reports atBottom', () => {
    const v = computeViewport({ ...BASE, items: mkItems(5), scrollLines: 0 });
    assert.equal(v.scrollLines, 0);
    assert.equal(v.atBottom, true);
  });

  test('visible is a contiguous tail-anchored slice of items at the bottom', () => {
    const items = mkItems(5);
    const v = computeViewport({ ...BASE, items, scrollLines: 0 });
    assert.ok(Array.isArray(v.visible));
    assert.equal(v.visible.at(-1), items.at(-1), 'last visible item is the newest item');
    for (const item of v.visible) {
      assert.ok(items.includes(item), 'visible items all come from the input');
    }
  });

  test('empty transcript yields an empty viewport without throwing', () => {
    const v = computeViewport({ ...BASE, items: [], scrollLines: 0 });
    assert.deepEqual(v.visible, []);
    assert.equal(v.maxScroll, 0);
    assert.equal(v.atBottom, true);
    assert.equal(v.atTop, true);
  });

  test('negative scrollLines is clamped to the bottom', () => {
    const v = computeViewport({ ...BASE, items: mkItems(5), scrollLines: -50 });
    assert.equal(v.scrollLines, 0);
    assert.equal(v.atBottom, true);
  });

  test('overscroll is clamped to maxScroll and reports atTop', () => {
    const v = computeViewport({ ...BASE, items: mkItems(5), scrollLines: 99999 });
    assert.equal(v.scrollLines, v.maxScroll);
    assert.equal(v.atTop, true);
    assert.equal(v.atBottom, false);
    assert.ok(v.visible.length >= 1, 'the top of the transcript stays visible');
  });

  test('maxScroll is never negative', () => {
    for (const n of [0, 1, 3, 50]) {
      const v = computeViewport({ ...BASE, items: mkItems(n), scrollLines: 0 });
      assert.ok(v.maxScroll >= 0, `maxScroll should be >= 0 for ${n} items`);
    }
  });

  test('a long transcript is clipped to fewer items than the total', () => {
    const items = mkItems(200);
    const v = computeViewport({ ...BASE, items, scrollLines: 0 });
    assert.ok(v.visible.length > 0, 'something is visible');
    assert.ok(v.visible.length < items.length, 'a 200-item transcript is clipped');
  });

  test('a short transcript is shown in full', () => {
    const items = mkItems(3);
    const v = computeViewport({ ...BASE, items, scrollLines: 0 });
    assert.equal(v.visible.length, items.length);
  });

  test('more terminal rows show at least as many items', () => {
    const items = mkItems(200);
    const small = computeViewport({ ...BASE, rows: 12, items, scrollLines: 0 });
    const large = computeViewport({ ...BASE, rows: 60, items, scrollLines: 0 });
    assert.ok(large.visible.length >= small.visible.length);
  });

  test('scroll step is a positive integer of at least 4 lines', () => {
    for (const rows of [1, 5, 24, 120]) {
      const v = computeViewport({ ...BASE, rows, items: mkItems(10), scrollLines: 0 });
      assert.ok(Number.isInteger(v.step), 'step is an integer');
      assert.ok(v.step >= 4, `step should be >= 4 for rows=${rows}`);
    }
  });

  test('degenerate tiny terminal still yields a usable viewport', () => {
    const v = computeViewport({ ...BASE, rows: 1, items: mkItems(50), scrollLines: 0 });
    assert.ok(v.visible.length >= 1, 'never renders an empty transcript when items exist');
    assert.ok(v.step >= 4);
  });

  test('todos and busy chrome never grow the visible slice', () => {
    const items = mkItems(200);
    const plain = computeViewport({ ...BASE, items, scrollLines: 0 });
    const crowded = computeViewport({
      ...BASE,
      items,
      scrollLines: 0,
      busy: true,
      todos: [{ text: 'a' }, { text: 'b' }],
    });
    assert.ok(crowded.visible.length <= plain.visible.length, 'chrome only takes space away');
  });

  test('optional todos and thinkingOpen arguments default safely', () => {
    const v = computeViewport({
      items: mkItems(3),
      rows: 24,
      width: 80,
      scrollLines: 0,
      busy: false,
    });
    assert.equal(v.visible.length, 3);
    assert.equal(v.atBottom, true);
  });
});

// ── Width-chain alignment (render vs estimate) ────────────────────────────
// ChatRow renders user lines at `width - TRANSCRIPT_PAD - USER_LINE_PAD -
// USER_PREFIX_W` (width - 6) and assistant markdown at
// `width - TRANSCRIPT_PAD - MARKDOWN_GUTTER` (width - 4). The estimates must
// wrap at the same widths or the bottom-anchored viewport clips the last line
// of long messages.

describe('width chain stays aligned with the render layout', () => {
  test('user text wraps at width - 6', () => {
    const one = estimateItemLines({ kind: 'user', text: 'x'.repeat(74) }, 80);
    const two = estimateItemLines({ kind: 'user', text: 'x'.repeat(75) }, 80);
    assert.equal(one, 1, '74 chars fits one rendered line at width 80');
    assert.equal(two, 2, '75 chars wraps to two rendered lines at width 80');
  });

  test('assistant markdown wraps at width - 4 (gutter + transcript padding)', () => {
    const one = estimateItemLines({ kind: 'assistant', text: 'x'.repeat(76) }, 80);
    const two = estimateItemLines({ kind: 'assistant', text: 'x'.repeat(77) }, 80);
    assert.equal(one, 2, '76 chars fits one body line + marginTop');
    assert.equal(two, 3, '77 chars wraps to two body lines + marginTop');
  });

  test('narrow widths still align the same chain', () => {
    // 30 columns → user avail 24, assistant body avail 26.
    assert.equal(estimateItemLines({ kind: 'user', text: 'x'.repeat(24) }, 30), 1);
    assert.equal(estimateItemLines({ kind: 'user', text: 'x'.repeat(25) }, 30), 2);
    assert.equal(estimateItemLines({ kind: 'assistant', text: 'x'.repeat(26) }, 30), 2);
    assert.equal(estimateItemLines({ kind: 'assistant', text: 'x'.repeat(27) }, 30), 3);
  });
});
