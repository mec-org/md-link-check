/**
 * Workflow-command annotation formatting for broken-link findings.
 *
 * This module is pure: it consumes the M9 structured finding contract and
 * returns deterministic GitHub workflow-command strings. It performs no I/O,
 * reads no environment, inspects no filesystem path and imports no discovery,
 * parser, checking, transport, cache, scheduler or reporting module.
 *
 * Values come from the structured finding unescaped: the property channel
 * (`file`) escapes `%`, CR, LF, `:` and `,`; the message channel (target and
 * reason) escapes `%`, CR and LF. Every source code point is escaped exactly
 * once, so `%` is replaced first in effect and formatter-generated `%XX`
 * sequences are never escaped again. Composing `target`, the ` — ` separator
 * and `reason` before the single message pass keeps ordinary commas and colons
 * as readable message data. Each finding renders to exactly one command with no
 * line terminator, and the bounds apply to the escaped text: the source finding,
 * the CLI diagnostics and the JSON values stay unescaped and unchanged.
 *
 * M10 defines and tests this formatter only. It is deliberately not imported by
 * the CLI or the action wrapper yet; action emission belongs to a later
 * milestone. It is an internal seam for the action, not a supported library
 * API, and callers must treat findings as read-only.
 */
import type { BrokenLinkResult } from './run.js';

/**
 * Internal upper bounds, in Unicode code points, for one rendered annotation.
 *
 * The bounds apply to rendered (workflow-escaped) text: a value within its
 * bound is emitted unchanged, and a value above it is shortened to fit and ends
 * with {@link TRUNCATION_MARKER}. Shortening keeps whole surrogate pairs and
 * never splits a workflow escape, so the escaped annotation stays valid and
 * bounded even when its values need escaping. The bounds apply to annotation
 * rendering only: the structured finding itself is never shortened or modified.
 */
export const ANNOTATION_LIMITS = Object.freeze({
  /** Maximum characters in the rendered `file` property. */
  file: 4_096,
  /** Maximum characters in the rendered target part of the message. */
  target: 8_192,
  /** Maximum characters in the rendered reason part of the message. */
  reason: 8_192,
  /** Maximum characters in the rendered annotation message. */
  message: 16_384,
});

/** Marker appended to a value shortened to an annotation bound. */
export const TRUNCATION_MARKER = '…';

/**
 * Workflow-command message/data escapes. Escaping each source character exactly
 * once means a percent sign is escaped first in effect: an escape introduced
 * for a later character is never escaped again.
 */
const DATA_CHANNEL_ESCAPES = new Map<string, string>([
  ['%', '%25'],
  ['\r', '%0D'],
  ['\n', '%0A'],
]);

/**
 * Workflow-command property escapes: the data-channel escapes plus the
 * property separators `:` and `,`.
 */
const PROPERTY_CHANNEL_ESCAPES = new Map<string, string>([
  ...DATA_CHANNEL_ESCAPES,
  [':', '%3A'],
  [',', '%2C'],
]);

/** One rendered value together with its length in Unicode code points. */
interface BoundedText {
  readonly text: string;
  readonly points: number;
}

/**
 * Formats one broken-link finding as exactly one GitHub error workflow command:
 *
 * `::error file=<escaped-file>,line=<line>::<escaped-message>`
 *
 * The message is `<target> — <reason>`, derived directly from the structured
 * finding. The returned string has no line terminator so the emitter can
 * control line boundaries. `line` keeps the finding's one-based source line.
 */
export function formatAnnotation(finding: BrokenLinkResult): string {
  const file = renderBounded(
    finding.file,
    escapePropertyCharacter,
    ANNOTATION_LIMITS.file,
  );
  const target = renderBounded(
    finding.target,
    escapeDataCharacter,
    ANNOTATION_LIMITS.target,
  );
  const separator = ' — ';
  const reasonBudget = Math.max(
    1,
    ANNOTATION_LIMITS.message - target.points - separator.length,
  );
  const reason = renderBounded(
    finding.reason,
    escapeDataCharacter,
    Math.min(ANNOTATION_LIMITS.reason, reasonBudget),
  );

  return (
    `::error file=${file.text},line=${finding.line}::` +
    `${target.text}${separator}${reason.text}`
  );
}

/**
 * Formats findings one-to-one in their supplied order. The input list and its
 * findings are not mutated, sorted or deduplicated; zero findings return zero
 * annotations.
 */
export function formatAnnotations(
  findings: readonly BrokenLinkResult[],
): readonly string[] {
  return findings.map((finding) => formatAnnotation(finding));
}

/**
 * Escapes and shortens one value to at most `limit` Unicode code points in the
 * rendered workflow command, appending the truncation marker when it had to
 * shorten. A whole escape sequence or surrogate pair is always kept or
 * dropped, never split.
 */
function renderBounded(
  value: string,
  escapeCharacter: (character: string) => string,
  limit: number,
): BoundedText {
  const atoms: Array<{ readonly text: string; readonly points: number }> = [];
  let points = 0;
  let complete = true;

  for (const character of value) {
    const atom = escapeCharacter(character);
    const atomPoints = atom === character ? 1 : atom.length;
    if (points + atomPoints > limit) {
      complete = false;
      break;
    }
    atoms.push({ text: atom, points: atomPoints });
    points += atomPoints;
  }

  if (complete) {
    return { text: atoms.map((atom) => atom.text).join(''), points };
  }

  while (points > limit - TRUNCATION_MARKER.length) {
    const removed = atoms.pop();
    if (removed === undefined) {
      break;
    }
    points -= removed.points;
  }

  return {
    text: `${atoms.map((atom) => atom.text).join('')}${TRUNCATION_MARKER}`,
    points: points + TRUNCATION_MARKER.length,
  };
}

/** Escapes one character for the workflow-command data channel. */
function escapeDataCharacter(character: string): string {
  return DATA_CHANNEL_ESCAPES.get(character) ?? character;
}

/** Escapes one character for the workflow-command property channel. */
function escapePropertyCharacter(character: string): string {
  return PROPERTY_CHANNEL_ESCAPES.get(character) ?? character;
}
