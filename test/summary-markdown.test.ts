/**
 * M18 — Markdown escaping for run-summary values.
 *
 * These tests exercise the pure escaper directly. Representative expected
 * strings are written out literally, never derived from the implementation or
 * from a second copy of the production mapping, so the representation is
 * checked independently of how it is produced. The escaper is not connected to
 * the action yet; M19 will pass every summary value through it.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeSummaryValue,
  SUMMARY_VALUE_MAX_EXPANSION,
} from '../src/summary-markdown.js';

/** Every character class that must never appear raw in an escaped value. */
const RAW_LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f]/;

describe('M18 summary-value Markdown escaping', () => {
  it('escapes Markdown structural punctuation', () => {
    expect(escapeSummaryValue('`')).toBe('\\`');
    expect(escapeSummaryValue('|')).toBe('\\|');
    expect(escapeSummaryValue('*')).toBe('\\*');
    expect(escapeSummaryValue('_')).toBe('\\_');
    expect(escapeSummaryValue('[')).toBe('\\[');
    expect(escapeSummaryValue(']')).toBe('\\]');
    expect(escapeSummaryValue('<')).toBe('&lt;');
    expect(escapeSummaryValue('>')).toBe('&gt;');

    const escaped = escapeSummaryValue('`|*_[]<>');
    expect(escaped).toBe('\\`\\|\\*\\_\\[\\]&lt;&gt;');
    expect(escaped).not.toMatch(RAW_LINE_BREAK_OR_CONTROL);
  });

  it('escapes an ampersand so entity-like text stays literal', () => {
    expect(escapeSummaryValue('&')).toBe('&amp;');
    expect(escapeSummaryValue('&lt;')).toBe('&amp;lt;');
    expect(escapeSummaryValue('&amp;')).toBe('&amp;amp;');
  });

  it('escapes a leading heading marker', () => {
    expect(escapeSummaryValue('# heading')).toBe('\\# heading');
    expect(escapeSummaryValue('## subheading')).toBe('\\#\\# subheading');
    // This implementation escapes every `#`, including one away from the
    // leading structural position; it still renders as the input text.
    expect(escapeSummaryValue('issue #1')).toBe('issue \\#1');
  });

  it('encodes line breaks as visible text on one line', () => {
    expect(escapeSummaryValue('\n')).toBe('\\n');
    expect(escapeSummaryValue('\r')).toBe('\\r');
    expect(escapeSummaryValue('before\nafter')).toBe('before\\nafter');
    expect(escapeSummaryValue('before\rafter')).toBe('before\\rafter');
    expect(escapeSummaryValue('before\r\nafter')).toBe('before\\r\\nafter');

    for (const value of ['a\rb', 'a\nb', 'a\r\nb']) {
      const escaped = escapeSummaryValue(value);
      expect(escaped).not.toMatch(/[\r\n]/);
      expect(escaped).not.toMatch(RAW_LINE_BREAK_OR_CONTROL);
      expect(escaped.split('\n')).toHaveLength(1);
    }
  });

  it('encodes tabs and control characters without deletion', () => {
    expect(escapeSummaryValue('\t')).toBe('\\t');
    expect(escapeSummaryValue('\u0000')).toBe('\\u0000');
    expect(escapeSummaryValue('a\u0001b')).toBe('a\\u0001b');
    expect(escapeSummaryValue('a\u000bb')).toBe('a\\u000bb');
    expect(escapeSummaryValue('\u001f')).toBe('\\u001f');
    expect(escapeSummaryValue('\u007f')).toBe('\\u007f');
    expect(escapeSummaryValue('left\tmiddle\u0000right\u007f')).toBe(
      'left\\tmiddle\\u0000right\\u007f',
    );

    for (const value of ['\u0000', 'a\u0001b', '\u000b', '\u001f', '\u007f']) {
      const escaped = escapeSummaryValue(value);
      expect(escaped.length).toBeGreaterThan(value.length);
      expect(escaped).not.toMatch(RAW_LINE_BREAK_OR_CONTROL);
    }
  });

  it('distinguishes literal escape-like text from encoded controls', () => {
    expect(escapeSummaryValue('\\')).toBe('\\\\');
    expect(escapeSummaryValue('\\n')).toBe('\\\\n');
    expect(escapeSummaryValue('\n')).toBe('\\n');
    expect(escapeSummaryValue('\\r')).toBe('\\\\r');
    expect(escapeSummaryValue('\r')).toBe('\\r');
    expect(escapeSummaryValue('\\t')).toBe('\\\\t');
    expect(escapeSummaryValue('\t')).toBe('\\t');
    expect(escapeSummaryValue('\\u0000')).toBe('\\\\u0000');
    expect(escapeSummaryValue('\u0000')).toBe('\\u0000');

    const pairs = [
      ['\\n', '\n'],
      ['\\r', '\r'],
      ['\\t', '\t'],
      ['\\u0000', '\u0000'],
    ] as const;
    for (const [literal, control] of pairs) {
      expect(escapeSummaryValue(literal)).not.toBe(
        escapeSummaryValue(control),
      );
    }
  });

  it('preserves mixed value meaning in one escaped entry', () => {
    const value = 'docs/a b|c`d*e_f[g]<h>&i#j.md\r\n# not a heading';

    expect(escapeSummaryValue(value)).toBe(
      'docs/a b\\|c\\`d\\*e\\_f\\[g\\]&lt;h&gt;&amp;i\\#j.md\\r\\n\\# not a heading',
    );

    const escaped = escapeSummaryValue(value);
    expect(escaped).not.toMatch(RAW_LINE_BREAK_OR_CONTROL);
    expect(escaped.split('\n')).toHaveLength(1);
    expect(escaped.indexOf('docs/a b')).toBeLessThan(escaped.indexOf('j.md'));
    expect(escaped.indexOf('j.md')).toBeLessThan(escaped.indexOf('# not'));
  });

  it('has bounded deterministic expansion', () => {
    expect(SUMMARY_VALUE_MAX_EXPANSION).toBe(6);

    const speciallyEncoded = [
      '\\',
      '`',
      '|',
      '*',
      '_',
      '[',
      ']',
      '<',
      '>',
      '&',
      '#',
      '\n',
      '\r',
      '\t',
      '\u0000',
      '\u0001',
      '\u001f',
      '\u007f',
    ];
    for (const character of speciallyEncoded) {
      const escaped = escapeSummaryValue(character);
      expect(escaped.length).toBeLessThanOrEqual(
        SUMMARY_VALUE_MAX_EXPANSION * character.length,
      );
    }

    // The longest encoding is the six-code-unit control form, and it is tight.
    expect(escapeSummaryValue('\u0000')).toHaveLength(6);
    expect(escapeSummaryValue('\u007f')).toHaveLength(6);

    const worstCase = '\u0000'.repeat(1_000);
    const worstCaseEscaped = escapeSummaryValue(worstCase);
    expect(worstCaseEscaped).toHaveLength(
      SUMMARY_VALUE_MAX_EXPANSION * worstCase.length,
    );
    expect(escapeSummaryValue(worstCase)).toBe(worstCaseEscaped);

    const mixed = 'docs/a b|c`d*e_f[g]<h>&i#j.md\r\n'.repeat(50);
    const mixedEscaped = escapeSummaryValue(mixed);
    expect(mixedEscaped.length).toBeLessThanOrEqual(
      SUMMARY_VALUE_MAX_EXPANSION * mixed.length,
    );
    expect(escapeSummaryValue(mixed)).toBe(mixedEscaped);
  });

  it('preserves non-ASCII text unchanged', () => {
    expect(escapeSummaryValue('café/日本-🚀.md')).toBe('café/日本-🚀.md');
    expect(escapeSummaryValue('🚀')).toHaveLength(2);
    expect([...escapeSummaryValue('🚀')]).toEqual(['🚀']);
  });

  it('leaves ordinary values unchanged', () => {
    expect(escapeSummaryValue('docs/guide.md')).toBe('docs/guide.md');
    expect(escapeSummaryValue('missing.md')).toBe('missing.md');
    expect(escapeSummaryValue('target does not exist')).toBe(
      'target does not exist',
    );
    expect(escapeSummaryValue('  docs/guide.md  ')).toBe('  docs/guide.md  ');
    expect(escapeSummaryValue('a  b')).toBe('a  b');
  });

  it('handles the empty string', () => {
    expect(escapeSummaryValue('')).toBe('');
    expect(escapeSummaryValue('')).toHaveLength(0);
    expect(escapeSummaryValue('')).toBe(escapeSummaryValue(''));
  });
});
