import { maskCodeLines } from './parser.js';

/** An ATX or setext heading found in Markdown, before it is slugged. */
export interface Heading {
  /** 1 for a setext `=` or ATX `#` heading, up to 6 for ATX headings. */
  level: number;
  /** Heading text without the ATX marker or optional closing hashes. */
  text: string;
  /** 1-based line number of the heading text. */
  line: number;
}

/** A half-open range of an inline code span within heading text. */
interface CodeRange {
  start: number;
  end: number;
}

/** One run of underscores and whether CommonMark can use it as a delimiter. */
interface DelimiterRun {
  start: number;
  length: number;
  canOpen: boolean;
  canClose: boolean;
}

const ATX_HEADING = /^( {0,3})(#{1,6})(?=[ \t]|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const CLOSING_HASHES = /[ \t]+#+[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLOCK_MARKER = /^ {0,3}(?:>[ \t]?|[*+-][ \t]|\d{1,9}[.)][ \t])/;

/**
 * Collects ATX and setext headings in document order. Fenced and indented code
 * blocks are excluded with the same masking that link scanning uses, and ATX
 * headings inside inline code are not matched because such a line starts with a
 * backtick rather than `#`.
 *
 * A setext heading is recognised only when the line directly above its
 * underline is paragraph text at the top level, contains something other than
 * inline code, and the underline is not inside a code block. That keeps
 * ordinary horizontal rules out of the heading list; multi-line paragraph text
 * and headings inside block quotes are not collected.
 */
export function scanHeadings(markdown: string): Heading[] {
  const lines = markdown.split(/\r?\n/);
  const { masked, codeBlock } = maskCodeLines(lines);
  const headings: Heading[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (codeBlock[index] === true) {
      continue;
    }

    const atx = parseAtxHeading(line);
    if (atx !== null) {
      headings.push({ level: atx.level, text: atx.text, line: index + 1 });
      continue;
    }

    const underline = SETEXT_UNDERLINE.exec(lines[index + 1] ?? '');
    if (underline === null || codeBlock[index + 1] === true) {
      continue;
    }
    if (!isSetextParagraphText(line, masked[index] ?? '')) {
      continue;
    }

    const marker = underline[1] ?? '';
    headings.push({
      level: marker.charAt(0) === '=' ? 1 : 2,
      text: line.trim(),
      line: index + 1,
    });
  }

  return headings;
}

/**
 * Applies the project's GitHub-style heading slug rule to a heading's rendered
 * text: lowercase, drop punctuation except hyphens and underscores, then
 * convert whitespace to hyphens.
 *
 * Inline link destinations are replaced by their labels, inline code keeps its
 * literal content, and matched `_` emphasis markers are removed while literal
 * intraword underscores stay. Unicode normalisation and HTML entities are not
 * modelled; characters that are not letters, numbers, combining marks,
 * whitespace, hyphens or underscores are dropped.
 */
export function slugifyHeading(text: string): string {
  return renderedHeadingText(text.trim())
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/gu, '-');
}

/**
 * Collects the slug of every heading in document order. The first use of a base
 * slug is returned unchanged; every slug handed out is then reserved, so
 * repeated headings get the next free `-1`, `-2` suffix and a naturally
 * occurring slug such as `foo-1` is never handed out twice.
 */
export function collectHeadingSlugs(markdown: string): string[] {
  const reserved = new Map<string, number>();

  return scanHeadings(markdown).map((heading) =>
    reserveSlug(slugifyHeading(heading.text), reserved),
  );
}

function reserveSlug(base: string, reserved: Map<string, number>): string {
  if (!reserved.has(base)) {
    reserved.set(base, 0);
    return base;
  }

  let slug = base;
  while (reserved.has(slug)) {
    const suffix = (reserved.get(base) ?? 0) + 1;
    reserved.set(base, suffix);
    slug = `${base}-${suffix}`;
  }
  reserved.set(slug, 0);
  return slug;
}

/**
 * Approximates the text GitHub renders for a heading before slugging: inline
 * and reference-style link syntax becomes its label, inline code is kept
 * literally, and underscore emphasis markers are removed where CommonMark
 * treats them as delimiters.
 */
function renderedHeadingText(text: string): string {
  const withoutLinkDestinations = stripInlineLinkDestinations(text);
  const codeRanges = inlineCodeRanges(withoutLinkDestinations);
  return removeUnderscoreEmphasis(withoutLinkDestinations, codeRanges);
}

function stripInlineLinkDestinations(text: string): string {
  let result = '';
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);

    if (character === '`' && !isEscaped(text, index)) {
      const fenceLength = countCharacterRun(text, index, '`');
      const closing = findClosingBackticks(text, index + fenceLength, fenceLength);
      if (closing !== -1) {
        result += text.slice(index, closing + fenceLength);
        index = closing + fenceLength;
        continue;
      }
    }

    if (character === '!' && text.charAt(index + 1) === '[' && !isEscaped(text, index)) {
      const image = parseLinkLike(text, index + 1);
      if (image !== null) {
        result += stripInlineLinkDestinations(text.slice(index + 2, image.labelEnd));
        index = image.end;
        continue;
      }
    }

    if (character === '[' && !isEscaped(text, index)) {
      const link = parseLinkLike(text, index);
      if (link !== null) {
        result += stripInlineLinkDestinations(text.slice(index + 1, link.labelEnd));
        index = link.end;
        continue;
      }
    }

    result += character;
    index += 1;
  }

  return result;
}

/**
 * Returns the label range of an inline link (`[label](target)`) or a full or
 * collapsed reference-style link (`[label][reference]`, `[label][]`). A
 * shortcut reference (`[label]`) has no trailing syntax to drop and is left to
 * the normal slug rule, which already discards the surrounding brackets.
 */
function parseLinkLike(text: string, bracket: number): { labelEnd: number; end: number } | null {
  const labelEnd = findClosingBracket(text, bracket);
  if (labelEnd === -1) {
    return null;
  }
  if (text.charAt(labelEnd + 1) === '(') {
    const closing = findClosingParen(text, labelEnd + 1);
    if (closing === -1) {
      return null;
    }
    return { labelEnd, end: closing + 1 };
  }
  if (text.charAt(labelEnd + 1) === '[') {
    const referenceEnd = findClosingBracket(text, labelEnd + 1);
    if (referenceEnd !== -1) {
      return { labelEnd, end: referenceEnd + 1 };
    }
  }
  return null;
}

function inlineCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  let index = 0;

  while (index < text.length) {
    if (text.charAt(index) !== '`' || isEscaped(text, index)) {
      index += 1;
      continue;
    }
    const fenceLength = countCharacterRun(text, index, '`');
    const closing = findClosingBackticks(text, index + fenceLength, fenceLength);
    if (closing === -1) {
      index += fenceLength;
      continue;
    }
    const end = closing + fenceLength;
    ranges.push({ start: index, end });
    index = end;
  }

  return ranges;
}

function removeUnderscoreEmphasis(text: string, codeRanges: readonly CodeRange[]): string {
  const runs: DelimiterRun[] = [];
  let codeIndex = 0;
  let index = 0;

  while (index < text.length) {
    while (codeIndex < codeRanges.length && (codeRanges[codeIndex]?.end ?? 0) <= index) {
      codeIndex += 1;
    }
    const codeRange = codeRanges[codeIndex];
    if (codeRange !== undefined && index >= codeRange.start) {
      index = codeRange.end;
      continue;
    }

    if (text.charAt(index) !== '_' || isEscaped(text, index)) {
      index += 1;
      continue;
    }
    const length = countCharacterRun(text, index, '_');
    runs.push(classifyUnderscoreRun(text, index, length));
    index += length;
  }

  if (runs.length === 0) {
    return text;
  }

  const removed = new Set<number>();
  const openers: number[] = [];
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    if (run === undefined) {
      continue;
    }
    if (run.canClose && openers.length > 0) {
      removed.add(runIndex);
      const opener = openers.pop();
      if (opener !== undefined) {
        removed.add(opener);
      }
      continue;
    }
    if (run.canOpen) {
      openers.push(runIndex);
    }
  }

  if (removed.size === 0) {
    return text;
  }

  let result = '';
  let cursor = 0;
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    if (run === undefined || !removed.has(runIndex)) {
      continue;
    }
    result += text.slice(cursor, run.start);
    cursor = run.start + run.length;
  }
  return result + text.slice(cursor);
}

function classifyUnderscoreRun(text: string, start: number, length: number): DelimiterRun {
  const previous = start === 0 ? '' : text.charAt(start - 1);
  const next = text.charAt(start + length);
  const leftFlanking = next !== '' && !isWhitespaceCharacter(next);
  const rightFlanking = previous !== '' && !isWhitespaceCharacter(previous);

  return {
    start,
    length,
    canOpen:
      leftFlanking &&
      (previous === '' || isWhitespaceCharacter(previous) || isPunctuationCharacter(previous)),
    canClose:
      rightFlanking && (next === '' || isWhitespaceCharacter(next) || isPunctuationCharacter(next)),
  };
}

function parseAtxHeading(line: string): { level: number; text: string } | null {
  const match = ATX_HEADING.exec(line);
  if (match === null) {
    return null;
  }

  const indent = (match[1] ?? '').length;
  const level = (match[2] ?? '').length;
  const text = line.slice(indent + level).replace(CLOSING_HASHES, '').trim();
  return { level, text };
}

function isSetextParagraphText(line: string, maskedLine: string): boolean {
  if (line.trim() === '' || maskedLine.trim() === '') {
    return false;
  }
  if (parseAtxHeading(line) !== null) {
    return false;
  }
  return !SETEXT_UNDERLINE.test(line) && !THEMATIC_BREAK.test(line) && !BLOCK_MARKER.test(line);
}

function findClosingBracket(text: string, open: number): number {
  let depth = 0;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') {
      depth += 1;
      continue;
    }
    if (character !== ']') {
      continue;
    }
    if (depth === 0) {
      return index;
    }
    depth -= 1;
  }
  return -1;
}

function findClosingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character !== ')') {
      continue;
    }
    if (depth === 0) {
      return index;
    }
    depth -= 1;
  }
  return -1;
}

function findClosingBackticks(text: string, start: number, length: number): number {
  let index = start;
  while (index < text.length) {
    if (text.charAt(index) !== '`') {
      index += 1;
      continue;
    }
    const runLength = countCharacterRun(text, index, '`');
    if (runLength === length) {
      return index;
    }
    index += runLength;
  }
  return -1;
}

function countCharacterRun(text: string, start: number, character: string): number {
  let length = 0;
  while (text.charAt(start + length) === character) {
    length += 1;
  }
  return length;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isWhitespaceCharacter(character: string): boolean {
  return /\s/u.test(character);
}

function isPunctuationCharacter(character: string): boolean {
  return /[\p{P}\p{S}]/u.test(character);
}
