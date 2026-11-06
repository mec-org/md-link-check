/**
 * Markdown for the run summary: value escaping and the diagnostic list.
 *
 * M18 added {@link escapeSummaryValue}, an internal, pure utility that turns one
 * untrusted value into one deterministic, bounded sequence that can be placed
 * inside a single inline Markdown summary entry without changing the
 * surrounding document structure. M19 adds {@link formatRunSummaryMarkdown},
 * which places the three M17 counts and the first
 * {@link SUMMARY_DIAGNOSTIC_LIMIT} findings into deterministic Markdown and
 * passes every file, target and reason through the M18 escaper.
 *
 * Neither export is connected to the GitHub Action, to `src/action-runner.ts`
 * or to the CLI, and neither writes a job summary or performs any I/O. The
 * module reads no environment and has no runtime imports: the M17 contract
 * types are imported with `import type` and are erased at compile time.
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
 * =                 \=
 * $                 \u0024      (visible code; see math note)
 * 4+ leading spaces &#32; each  (renders as spaces)
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
 * The extra `~`, `-`, `+`, `:`, `=`, `www.` and ordered-marker encodings
 * neutralise the remaining GFM inline and block constructs that the packet's
 * required set does not name: strikethrough (`~~`), extended autolinks
 * (`http://`, `https://`, `www.`), setext underlines (`===`) and a value that
 * starts a line with a list marker. They all render back as the original
 * visible characters. Four or more leading spaces are written as `&#32;`
 * entities so a value that starts a line cannot become an indented code block;
 * one to three leading spaces are left as spaces.
 *
 * `$` cannot be neutralised with a Markdown escape: GitHub's math renderer
 * still creates `$...$` math from `\$` and from `&#36;` because it resolves
 * escapes and character references before detecting math. A `$` is therefore
 * written as the visible `\u0024` code, like a control character, so no raw
 * dollar sign can form math. Together with the literal backslash and the
 * covered controls, `$` is the only input whose rendered form is a visible
 * code rather than the source character.
 *
 * The encoding table, the rendered-context guarantee and the bounded-expansion
 * guarantee are documented in `docs/m18-summary-markdown.md`.
 */

import type { ActionSummary, BrokenLinkResult } from './run.js';

/**
 * Maximum output expansion for one escaped value: each input UTF-16 code unit
 * produces at most this many output UTF-16 code units.
 *
 * The longest encodings are the six-code-unit `\uXXXX` forms used for the
 * covered control characters and for `$`, so `escapeSummaryValue(value).length
 * <= 6 * value.length` for every string, including the empty string. The bound
 * is tight: an input of only U+0000 or only `$` expands by exactly this
 * factor. There is no truncation: a value is always escaped in full.
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
  ['=', '\\='],
  ['$', '\\u0024'],
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
 * The escaped result is also safe after Markdown renders it: literal backslash
 * text and encoded controls remain distinguishable, GFM strikethrough, the
 * `http://`, `https://` and `www.` extended autolinks, math, setext headings,
 * indented code and a leading list marker cannot form, and every escape except
 * the literal backslash and `$` renders back to the visible character it
 * replaced. A literal backslash renders as two backslashes and `$` renders as
 * the visible `\u0024` code, both by design. GFM can still auto-link a bare
 * email address; preventing that would require changing the visible value, so
 * it is documented as a limitation rather than handled.
 *
 * The empty string maps to the empty string.
 */
export function escapeSummaryValue(value: string): string {
  const orderedMarkerIndex = orderedMarkerPunctuationIndex(value);
  const leadingSpaces = leadingSpacesToEncode(value);
  let escaped = '';
  let index = 0;
  for (const character of value) {
    escaped += encodeCharacter(
      character,
      value,
      index,
      orderedMarkerIndex,
      leadingSpaces,
    );
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
  leadingSpaces: number,
): string {
  if (character === ' ' && index < leadingSpaces) {
    return '&#32;';
  }

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
 * Number of leading spaces to write as `&#32;` entities, or zero when the
 * value has fewer than four. Four spaces at the start of a Markdown line make
 * an indented code block; an entity starts with `&`, so the escaped line
 * cannot be read as indentation while the rendered text keeps its spaces.
 */
function leadingSpacesToEncode(value: string): number {
  const match = /^ +/.exec(value);
  const count = match?.[0].length ?? 0;
  return count >= 4 ? count : 0;
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

/**
 * Maximum number of broken-link diagnostics listed in one run-summary
 * Markdown document (`50`).
 *
 * The formatter lists the first `SUMMARY_DIAGNOSTIC_LIMIT` findings and, when
 * there are more, states the total and how many were not listed. The limit
 * bounds the number of entries, never the length of one entry: no diagnostic
 * value is truncated. It is an exported constant so the formatter, its tests
 * and the M20 summary writer share one documented bound.
 */
export const SUMMARY_DIAGNOSTIC_LIMIT = 50;

/**
 * Formats the Markdown run summary for one completed check from the M17 counts
 * and ordered findings.
 *
 * The output is a fragment, not a complete file, and always ends with exactly
 * one newline. It has this exact grammar; `<n>` is a decimal number and a
 * trailing `...` marks zero or more repetitions:
 *
 * ```text
 * ## Results
 *
 * - Checked: <filesChecked>
 * - Broken: <broken>
 * - External skipped: <externalSkipped>
 *
 * ## Diagnostics            (only when at least one finding is supplied)
 *
 * - <file>:<line>: <target> — <reason>
 * ...
 *
 * <total> total diagnostics; <notListed> not listed.   (only when total > 50)
 * ```
 *
 * The three supplied counts are rendered unchanged and before the diagnostics.
 * The complete input order is preserved; only the prefix of the first
 * {@link SUMMARY_DIAGNOSTIC_LIMIT} findings is listed. `total` is
 * `diagnostics.length`, `listed` is `min(total, SUMMARY_DIAGNOSTIC_LIMIT)` and
 * `notListed` is `max(total - SUMMARY_DIAGNOSTIC_LIMIT, 0)`. When there are no
 * findings the diagnostics section is omitted, so a clean run ends after the
 * three count lines.
 *
 * Every file, target and reason is passed through {@link escapeSummaryValue},
 * so each finding stays one inline Markdown entry. Values are escaped in full;
 * the formatter truncates neither a value nor a line number. The resulting
 * Markdown is deterministic and locale-independent.
 *
 * The function is pure: it performs no I/O, reads no environment, has no
 * runtime imports and does not mutate, sort, deduplicate or regroup the input.
 * It is not called by the action or the CLI.
 *
 * @param counts The M17 authoritative summary counts of the same completed run.
 * @param diagnostics The M17 ordered findings of that run; `counts.broken` is
 *   that run's number of diagnostics, so it equals `diagnostics.length`.
 */
export function formatRunSummaryMarkdown(
  counts: ActionSummary,
  diagnostics: readonly BrokenLinkResult[],
): string {
  const total = diagnostics.length;
  const listed = diagnostics.slice(0, SUMMARY_DIAGNOSTIC_LIMIT);
  const lines = [
    '## Results',
    '',
    `- Checked: ${counts.filesChecked}`,
    `- Broken: ${counts.broken}`,
    `- External skipped: ${counts.externalSkipped}`,
  ];

  if (listed.length > 0) {
    lines.push('', '## Diagnostics', '');
    for (const diagnostic of listed) {
      lines.push(
        `- ${escapeSummaryValue(diagnostic.file)}:${diagnostic.line}: ` +
          `${escapeSummaryValue(diagnostic.target)} — ` +
          `${escapeSummaryValue(diagnostic.reason)}`,
      );
    }
  }

  if (total > SUMMARY_DIAGNOSTIC_LIMIT) {
    lines.push(
      '',
      `${total} total diagnostics; ${total - SUMMARY_DIAGNOSTIC_LIMIT} not listed.`,
    );
  }

  return `${lines.join('\n')}\n`;
}
