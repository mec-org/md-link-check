/**
 * M18 — Markdown escaping for run-summary values.
 *
 * These tests exercise the pure escaper directly. Representative expected
 * strings are written out literally, never derived from the implementation or
 * from a second copy of the production mapping, so the representation is
 * checked independently of how it is produced. The escaper is not connected to
 * the action yet; M19 will pass every summary value through it.
 *
 * Because the escaped value is placed in a rendered Markdown summary, the
 * distinction tests also apply a small independent inline-text renderer that
 * resolves the two CommonMark constructs the escaper itself introduces:
 * backslash escapes and character references. Structure tests assert that the
 * raw escaping patterns cannot trigger GFM autolinks, strikethrough or a list.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeSummaryValue,
  SUMMARY_VALUE_MAX_EXPANSION,
} from '../src/summary-markdown.js';

/** Every character class that must never appear raw in an escaped value. */
const RAW_LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f]/;

/** CommonMark ASCII punctuation: every character a backslash may escape. */
const ASCII_PUNCTUATION = /[!"#$%&'()*+,\-.\/:;<=>?@[\\\]^_`{|}~]/;

/** Named character references that the escaper emits. */
const NAMED_ENTITY_DECODINGS = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
]);

/**
 * Renders the inline text meaning of a Markdown fragment by resolving
 * backslash escapes and character references the way CommonMark does. It does
 * not interpret emphasis, links, lists or other structure; tests for those
 * assert that the triggering raw patterns never survive escaping.
 */
function renderInlineText(markdown: string): string {
  let rendered = '';
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown.charAt(index);

    if (character === '\\') {
      const escaped = markdown.charAt(index + 1);
      if (escaped !== '' && ASCII_PUNCTUATION.test(escaped)) {
        rendered += escaped;
        index += 1;
      } else {
        rendered += '\\';
      }
      continue;
    }

    if (character === '&') {
      const entity =
        /^&(#(?:[0-9]{1,7}|[xX][0-9a-fA-F]{1,6})|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(
          markdown.slice(index),
        );
      const body = entity?.[1];
      const decoded = body === undefined ? undefined : decodeEntity(body);
      if (entity !== null && decoded !== undefined) {
        rendered += decoded;
        index += entity[0].length - 1;
        continue;
      }
    }

    rendered += character;
  }
  return rendered;
}

/** Decodes one character-reference body, returning undefined when unknown. */
function decodeEntity(body: string): string | undefined {
  if (body.startsWith('#')) {
    const hexadecimal = body.charAt(1) === 'x' || body.charAt(1) === 'X';
    const codePoint = hexadecimal
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
      return String.fromCodePoint(codePoint);
    }
    return undefined;
  }
  return NAMED_ENTITY_DECODINGS.get(body);
}

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

  it('neutralises GFM strikethrough and extended autolinks', () => {
    expect(escapeSummaryValue('~')).toBe('\\~');
    expect(escapeSummaryValue('~~text~~')).toBe('\\~\\~text\\~\\~');
    expect(escapeSummaryValue(':')).toBe('\\:');
    expect(escapeSummaryValue('http://example.com/a_b')).toBe(
      'http\\://example.com/a\\_b',
    );
    expect(escapeSummaryValue('https://example.com')).toBe(
      'https\\://example.com',
    );
    expect(escapeSummaryValue('www.example.com')).toBe(
      'www\\.example.com',
    );
    expect(escapeSummaryValue('see http://x www.y')).toBe(
      'see http\\://x www\\.y',
    );

    const escaped = escapeSummaryValue(
      '~~text~~ http://example.com https://example.com www.example.com',
    );
    expect(escaped).not.toMatch(/~~/);
    expect(escaped).not.toMatch(/https?:\/\//);
    expect(escaped).not.toContain('www.');
    expect(renderInlineText(escaped)).toBe(
      '~~text~~ http://example.com https://example.com www.example.com',
    );
  });

  it('neutralises leading list and block markers', () => {
    expect(escapeSummaryValue('- item')).toBe('\\- item');
    expect(escapeSummaryValue('+ item')).toBe('\\+ item');
    expect(escapeSummaryValue('1. item')).toBe('1\\. item');
    expect(escapeSummaryValue('1) item')).toBe('1\\) item');
    expect(escapeSummaryValue('  1. item')).toBe('  1\\. item');
    expect(escapeSummaryValue('---')).toBe('\\-\\-\\-');
    expect(escapeSummaryValue('> quote')).toBe('&gt; quote');
    expect(escapeSummaryValue('# heading')).toBe('\\# heading');

    // Only a leading ordered-list marker is special; dotted versions and a
    // marker away from the start are ordinary text.
    expect(escapeSummaryValue('version 1.2')).toBe('version 1.2');
    expect(escapeSummaryValue('1.2 release')).toBe('1.2 release');
    expect(escapeSummaryValue('see 1. item')).toBe('see 1. item');
    expect(renderInlineText(escapeSummaryValue('- item'))).toBe('- item');
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
    expect(escapeSummaryValue('\\')).toBe('\\\\\\\\');
    expect(escapeSummaryValue('\\n')).toBe('\\\\\\\\n');
    expect(escapeSummaryValue('\n')).toBe('\\n');
    expect(escapeSummaryValue('\\r')).toBe('\\\\\\\\r');
    expect(escapeSummaryValue('\r')).toBe('\\r');
    expect(escapeSummaryValue('\\t')).toBe('\\\\\\\\t');
    expect(escapeSummaryValue('\t')).toBe('\\t');
    expect(escapeSummaryValue('\\u0000')).toBe('\\\\\\\\u0000');
    expect(escapeSummaryValue('\u0000')).toBe('\\u0000');

    // The criterion is about the rendered summary, not only the raw string:
    // four source backslashes render as two, while a control encoding renders
    // as one backslash plus a letter.
    expect(renderInlineText(escapeSummaryValue('\\'))).toBe('\\\\');
    expect(renderInlineText(escapeSummaryValue('\\n'))).toBe('\\\\n');
    expect(renderInlineText(escapeSummaryValue('\n'))).toBe('\\n');
    expect(renderInlineText(escapeSummaryValue('\\r'))).toBe('\\\\r');
    expect(renderInlineText(escapeSummaryValue('\r'))).toBe('\\r');
    expect(renderInlineText(escapeSummaryValue('\\t'))).toBe('\\\\t');
    expect(renderInlineText(escapeSummaryValue('\t'))).toBe('\\t');
    expect(renderInlineText(escapeSummaryValue('\\u0000'))).toBe(
      '\\\\u0000',
    );
    expect(renderInlineText(escapeSummaryValue('\u0000'))).toBe('\\u0000');

    const pairs = [
      ['\\n', '\n'],
      ['\\r', '\r'],
      ['\\t', '\t'],
      ['\\u0000', '\u0000'],
    ] as const;
    for (const [literal, control] of pairs) {
      expect(renderInlineText(escapeSummaryValue(literal))).not.toBe(
        renderInlineText(escapeSummaryValue(control)),
      );
    }
  });

  it('preserves mixed value meaning in one escaped entry', () => {
    const value =
      'docs/a b|c`d*e_f[g]<h>&i#j~k-l+m:n.md\r\n# not a heading www.example.com';

    expect(escapeSummaryValue(value)).toBe(
      'docs/a b\\|c\\`d\\*e\\_f\\[g\\]&lt;h&gt;&amp;i\\#j\\~k\\-l\\+m\\:n.md\\r\\n\\# not a heading www\\.example.com',
    );

    const escaped = escapeSummaryValue(value);
    expect(escaped).not.toMatch(RAW_LINE_BREAK_OR_CONTROL);
    expect(escaped.split('\n')).toHaveLength(1);
    expect(renderInlineText(escaped)).toBe(
      'docs/a b|c`d*e_f[g]<h>&i#j~k-l+m:n.md\\r\\n# not a heading www.example.com',
    );
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
      '~',
      '-',
      '+',
      ':',
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

    for (const value of ['www.example.com', '1. item', 'http://example.com']) {
      expect(escapeSummaryValue(value).length).toBeLessThanOrEqual(
        SUMMARY_VALUE_MAX_EXPANSION * value.length,
      );
    }

    const worstCase = '\u0000'.repeat(1_000);
    const worstCaseEscaped = escapeSummaryValue(worstCase);
    expect(worstCaseEscaped).toHaveLength(
      SUMMARY_VALUE_MAX_EXPANSION * worstCase.length,
    );
    expect(escapeSummaryValue(worstCase)).toBe(worstCaseEscaped);

    const mixed = 'docs/a b|c`d*e_f[g]<h>&i#j~k-l+m:n.md\r\n'.repeat(50);
    const mixedEscaped = escapeSummaryValue(mixed);
    expect(mixedEscaped.length).toBeLessThanOrEqual(
      SUMMARY_VALUE_MAX_EXPANSION * mixed.length,
    );
    expect(escapeSummaryValue(mixed)).toBe(mixedEscaped);
  });

  it('preserves non-ASCII text unchanged', () => {
    expect(escapeSummaryValue('café/日本🚀.md')).toBe('café/日本🚀.md');
    expect(escapeSummaryValue('🚀')).toHaveLength(2);
    expect([...escapeSummaryValue('🚀')]).toEqual(['🚀']);
    // Only the ASCII hyphen is escaped; the surrounding code points are kept.
    expect(escapeSummaryValue('日本-🚀')).toBe('日本\\-🚀');
  });

  it('leaves ordinary values unchanged', () => {
    expect(escapeSummaryValue('docs/guide.md')).toBe('docs/guide.md');
    expect(escapeSummaryValue('missing.md')).toBe('missing.md');
    expect(escapeSummaryValue('target does not exist')).toBe(
      'target does not exist',
    );
    expect(escapeSummaryValue('  docs/guide.md  ')).toBe('  docs/guide.md  ');
    expect(escapeSummaryValue('a  b')).toBe('a  b');
    expect(escapeSummaryValue('version 1.2')).toBe('version 1.2');
  });

  it('renders escaped punctuation back to the visible source text', () => {
    const value = '`|*_[]<>#~-+:&';
    expect(renderInlineText(escapeSummaryValue(value))).toBe(value);

    expect(escapeSummaryValue('my-file.md')).toBe('my\\-file.md');
    expect(escapeSummaryValue('docs/a:b.md')).toBe('docs/a\\:b.md');
    expect(escapeSummaryValue('1+1=2')).toBe('1\\+1=2');
    for (const ordinary of ['my-file.md', 'docs/a:b.md', '1+1=2']) {
      expect(renderInlineText(escapeSummaryValue(ordinary))).toBe(ordinary);
    }
  });

  it('handles the empty string', () => {
    expect(escapeSummaryValue('')).toBe('');
    expect(escapeSummaryValue('')).toHaveLength(0);
    expect(escapeSummaryValue('')).toBe(escapeSummaryValue(''));
  });
});
