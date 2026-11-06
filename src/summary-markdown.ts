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
 * \                 \\
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
 * LF                \n
 * CR                \r
 * TAB               \t
 * other C0 / DEL    \uXXXX   (lowercase four-digit hexadecimal)
 * anything else     unchanged
 * ```
 *
 * Every literal backslash is doubled, so input that already looks like an
 * escape (`\n`, `\u0000`) keeps its literal meaning in the escaped string and
 * is never confused with the encoding of the corresponding control character.
 * Every `#` is escaped, not only a leading one, so a value stays safe wherever
 * a future summary layout places it; the escaped text still renders as `#`.
 * Angle brackets use HTML entities, and `&` is escaped so an input such as
 * `&lt;` stays the four literal characters it was rather than becoming `<`.
 *
 * The representation, its invariants and the bounded-expansion guarantee are
 * documented in `docs/m18-summary-markdown.md`.
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
  ['\\', '\\\\'],
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
 * The empty string maps to the empty string.
 */
export function escapeSummaryValue(value: string): string {
  let escaped = '';
  for (const character of value) {
    escaped += encodeCharacter(character);
  }
  return escaped;
}

/**
 * Encodes one Unicode code point. Iterating the input by code point keeps
 * surrogate pairs intact; only ASCII Markdown punctuation and the covered
 * ASCII control characters are rewritten.
 */
function encodeCharacter(character: string): string {
  const encoding = CHARACTER_ENCODINGS.get(character);
  if (encoding !== undefined) {
    return encoding;
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
