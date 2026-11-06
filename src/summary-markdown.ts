/**
 * Markdown escaping for untrusted run-summary values.
 *
 * M18 adds this internal, pure utility. It is not connected to the GitHub
 * Action, to `src/action-runner.ts` or to the CLI, and it writes no job
 * summary. M19 is expected to pass every value it places in the summary (file
 * names, link targets and failure reasons) through {@link escapeSummaryValue}.
 *
 * The function turns one value into one deterministic, bounded sequence that
 * can be placed inside a single inline Markdown summary entry without
 * changing the surrounding document structure. It reads no environment,
 * performs no I/O and imports nothing.
 *
 * Encoding table (one code point in, its output; generated encodings are never
 * re-escaped):
 *
 * ```
 * input             output
 * \                 \\\\        (renders as \\)
 * `                 \`
 * |                 \|
 * *                 \*
 * _                 \_
 * [                 \[
 * ]                 \]
 * <                 &lt;
 * >                 &gt;
 * &                 &amp;
 * #                 \#
 * ~                 \~
 * -                 \-
 * +                 \+
 * :                 \:
 * www.              www\.       (dot escaped wherever it follows "www")
 * 1. / 1) marker   1\. / 1\)   (only in a leading ordered-list marker)
 * LF                \n
 * CR                \r
 * TAB               \t
 * other C0 / DEL    \uXXXX      (lowercase four-digit hexadecimal)
 * anything else     unchanged
 * ```
 *
 * A literal backslash is written as four backslashes, which Markdown renders
 * as two visible backslashes. That rendering is what makes a literal
 * backslash sequence distinguishable from an encoded control: the literal
 * input `\n` renders as `\\n` (two backslashes), while an actual LF renders as
 * `\n` (one backslash). Merely doubling the source backslash would render both
 * as `\n` and defeat the representation once the summary is rendered.
 *
 * The extra `~`, `-`, `+`, `:`, `www.` and ordered-marker encodings neutralise
 * the remaining GFM inline and block constructs that the packet's required set
 * does not name: strikethrough (`~~`), extended autolinks (`http://`,
 * `https://`, `www.`) and a value that starts a line with a list marker. They
 * all render back as the original visible characters. The encoding table, the
 * rendered-context guarantee and the bounded-expansion guarantee are documented
 * in `docs/m18-summary-markdown.md`.
 */

/**
 * Maximum output expansion for one escaped value: each input UTF-16 code unit
 * produces at most this many output UTF-16 code units.
 *
 * The longest encoding is the six-code-unit `\uXXXX` form used for the covered
 * control characters, so `escapeSummaryValue(value).length <= 6 *
 * value.length` for every string, including the empty string. The bound is
 * tight: an input of only U+0000 expands by exactly this factor. There is no
 * truncation: a value is always escaped in full.
 */
export const SUMMARY_VALUE_MAX_EXPANSION = 6;

/**
 * Markdown-significant and control-character encodings, applied to one input
 * code point at a time. Each mapping replaces exactly one input code point and
 * is emitted once, directly into the output, so no encoding is escaped again.
 */
const CHARACTER_ENCODINGS = new Map<string, string>([
  ['\\', '\\\\\\\\'],
  ['`', '\\`'],
  ['|', '\\|'],
  ['*', '\\*'],
  ['_', '\\_'],
  ['[', '\\['],
  [']', '\\]'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['&', '&amp;'],
  ['#', '\\#'],
  ['~', '\\~'],
  ['-', '\\-'],
  ['+', '\\+'],
  [':', '\\:'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/**
 * Escapes one untrusted value for one inline Markdown summary entry.
 *
 * The function is pure and deterministic: the same input always yields the
 * same output, and it never reads state, throws for a string input, deletes,
 * trims, collapses, reorders or truncates content. Every input code point is
 * represented in order either by itself (non-ASCII text, including surrogate
 * pairs) or by its documented visible encoding. The result contains no raw CR,
 * LF, TAB, C0 control or DEL character, so it is one physical line.
 *
 * The escaped result is also safe after Markdown renders it: literal
 * backslash text and encoded controls remain distinguishable, GFM
 * strikethrough, the `http://`, `https://` and `www.` extended autolinks and a
 * leading list marker cannot form, and every escape except the literal
 * backslash renders back to the visible character it replaced (a literal
 * backslash renders as two, by design). GFM can still auto-link a bare email
 * address; preventing that would require changing the visible value, so it is
 * documented as a limitation rather than handled.
 *
 * The empty string maps to the empty string.
 */
export function escapeSummaryValue(value: string): string {
  const orderedMarkerIndex = orderedMarkerPunctuationIndex(value);
  let escaped = '';
  let index = 0;
  for (const character of value) {
    escaped += encodeCharacter(character, value, index, orderedMarkerIndex);
    index += character.length;
  }
  return escaped;
}

/**
 * Encodes one Unicode code point. Iterating the input by code point keeps
 * surrogate pairs intact; only ASCII Markdown punctuation and the covered
 * ASCII control characters are rewritten.
 */
function encodeCharacter(
  character: string,
  value: string,
  index: number,
  orderedMarkerIndex: number,
): string {
  const encoding = CHARACTER_ENCODINGS.get(character);
  if (encoding !== undefined) {
    return encoding;
  }

  if (index === orderedMarkerIndex && (character === '.' || character === ')')) {
    return `\\${character}`;
  }
  if (character === '.' && followsWww(value, index)) {
    return '\\.';
  }

  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return character;
  }
  if (codePoint <= 0x1f || codePoint === 0x7f) {
    return `\\u${codePoint.toString(16).padStart(4, '0')}`;
  }
  return character;
}

/**
 * Index of the `.` or `)` in a leading ordered-list marker, or -1 when the
 * value does not start with one. GFM allows up to three leading spaces and at
 * most nine digits before the marker punctuation, which must be followed by
 * whitespace or the end of the value.
 */
function orderedMarkerPunctuationIndex(value: string): number {
  const match = /^ {0,3}[0-9]{1,9}[.)](?=\s|$)/.exec(value);
  if (match === null) {
    return -1;
  }
  return match[0].length - 1;
}

/**
 * True for the dot of a `www.` prefix: escaping it stops GFM's extended
 * autolink from turning the value into a link while rendering the same text.
 * Escaping every dot after `www` (even inside a longer word) is harmless.
 */
function followsWww(value: string, dotIndex: number): boolean {
  if (dotIndex < 3) {
    return false;
  }
  return value.slice(dotIndex - 3, dotIndex).toLowerCase() === 'www';
}
