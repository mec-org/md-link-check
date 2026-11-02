export type LinkKind = 'link' | 'image';

/** An inline link or image found in Markdown, before its target is classified. */
export interface InlineReference {
  kind: LinkKind;
  target: string;
  /** 1-based line number of the `[` or `!` that starts the reference. */
  line: number;
  /** 1-based column number of the `[` or `!` that starts the reference. */
  column: number;
}

interface ParsedLink {
  target: string;
  end: number;
}

/** The result of masking every code exclusion in a Markdown document. */
export interface MaskedLines {
  /** The document's lines with code replaced by spaces; the line count is unchanged. */
  readonly masked: readonly string[];
  /** True for each line that belongs to a fenced or indented code block. */
  readonly codeBlock: readonly boolean[];
}

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLANK_LINE = /^[ \t]*$/;
const INDENTED_CODE = /^(?: {4,}|\t)/;

/**
 * Finds inline links (`[label](target)`) and images (`![alt](target)`).
 *
 * Fenced code blocks, inline code spans and indented code blocks are masked
 * before scanning, so link-looking text inside them is ignored. Reference-style
 * links, raw HTML and autolinks are intentionally outside the supported scope
 * and are not returned.
 */
export function scanInlineReferences(markdown: string): InlineReference[] {
  const lines = markdown.split(/\r?\n/);
  const { masked: maskedLines } = maskCodeLines(lines);
  const references: InlineReference[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const original = lines[lineIndex] ?? '';
    const masked = maskedLines[lineIndex] ?? '';
    let index = 0;

    while (index < masked.length) {
      const imageStart = masked.charAt(index) === '!' && masked.charAt(index + 1) === '[';
      const linkStart = masked.charAt(index) === '[';
      if (!imageStart && !linkStart) {
        index += 1;
        continue;
      }

      const bracket = imageStart ? index + 1 : index;
      if (isEscaped(masked, index) || isEscaped(masked, bracket)) {
        index += 1;
        continue;
      }

      const parsed = parseInlineLink(masked, original, bracket);
      if (parsed === null) {
        index += 1;
        continue;
      }

      if (parsed.target !== '') {
        references.push({
          kind: imageStart ? 'image' : 'link',
          target: parsed.target,
          line: lineIndex + 1,
          column: index + 1,
        });
      }
      index = parsed.end;
    }
  }

  return references;
}

/**
 * Masks fenced code blocks, indented code blocks and inline code spans with
 * spaces, preserving line count and column positions. Link scanning and heading
 * collection share this single code-exclusion interpretation.
 */
export function maskCodeLines(lines: readonly string[]): MaskedLines {
  const masked: string[] = [];
  const codeBlock: boolean[] = [];
  let fence: { character: string; length: number } | null = null;
  let inIndentedCode = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    if (fence !== null) {
      masked.push(' '.repeat(line.length));
      codeBlock.push(true);
      const closing = CLOSING_FENCE.exec(line);
      const marker = closing?.[1];
      if (marker !== undefined && marker.charAt(0) === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const opening = OPENING_FENCE.exec(line)?.[1];
    if (opening !== undefined) {
      fence = { character: opening.charAt(0), length: opening.length };
      masked.push(' '.repeat(line.length));
      codeBlock.push(true);
      inIndentedCode = false;
      continue;
    }

    if (isIndentedCodeLine(lines, index, inIndentedCode)) {
      masked.push(' '.repeat(line.length));
      codeBlock.push(true);
      inIndentedCode = true;
      continue;
    }

    inIndentedCode = false;
    masked.push(maskInlineCode(line));
    codeBlock.push(false);
  }

  return { masked, codeBlock };
}

/**
 * Indented code blocks are detected conservatively: a four-space or tab
 * indented line starts one only at the beginning of the document or after a
 * blank line. That avoids dropping links from list continuations, at the cost
 * of missing links in deeply indented blocks after a blank line.
 */
function isIndentedCodeLine(lines: readonly string[], index: number, continuing: boolean): boolean {
  const line = lines[index] ?? '';
  if (!INDENTED_CODE.test(line)) {
    return false;
  }
  if (continuing || index === 0) {
    return true;
  }
  return BLANK_LINE.test(lines[index - 1] ?? '');
}

function maskInlineCode(line: string): string {
  let result = '';
  let index = 0;

  while (index < line.length) {
    if (line.charAt(index) !== '`' || isEscaped(line, index)) {
      result += line.charAt(index);
      index += 1;
      continue;
    }

    const openingLength = countCharacterRun(line, index, '`');
    const closing = findClosingBackticks(line, index + openingLength, openingLength);
    if (closing === -1) {
      result += line.slice(index, index + openingLength);
      index += openingLength;
      continue;
    }

    const end = closing + openingLength;
    result += ' '.repeat(end - index);
    index = end;
  }

  return result;
}

function findClosingBackticks(line: string, start: number, length: number): number {
  let index = start;
  while (index < line.length) {
    if (line.charAt(index) !== '`') {
      index += 1;
      continue;
    }
    const runLength = countCharacterRun(line, index, '`');
    if (runLength === length) {
      return index;
    }
    index += runLength;
  }
  return -1;
}

function parseInlineLink(masked: string, original: string, bracket: number): ParsedLink | null {
  const close = findClosingBracket(masked, bracket);
  if (close === -1 || masked.charAt(close + 1) !== '(') {
    return null;
  }

  let position = close + 2;
  while (position < masked.length && isWhitespace(masked.charAt(position))) {
    position += 1;
  }
  if (position >= masked.length) {
    return null;
  }

  if (masked.charAt(position) === '<') {
    const targetStart = position + 1;
    let cursor = targetStart;
    while (cursor < masked.length) {
      if (masked.charAt(cursor) === '>' && !isEscaped(masked, cursor)) {
        break;
      }
      cursor += 1;
    }
    if (cursor >= masked.length) {
      return null;
    }
    const end = parseTitleAndClosingParen(masked, cursor + 1);
    if (end === null) {
      return null;
    }
    return { target: original.slice(targetStart, cursor), end };
  }

  let cursor = position;
  let depth = 0;
  while (cursor < masked.length) {
    const character = masked.charAt(cursor);
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === '(') {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (character === ')') {
      if (depth === 0) {
        return { target: original.slice(position, cursor), end: cursor + 1 };
      }
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (isWhitespace(character)) {
      break;
    }
    cursor += 1;
  }

  const end = parseTitleAndClosingParen(masked, cursor);
  if (end === null) {
    return null;
  }
  return { target: original.slice(position, cursor), end };
}

function parseTitleAndClosingParen(text: string, start: number): number | null {
  let position = start;
  while (position < text.length && isWhitespace(text.charAt(position))) {
    position += 1;
  }
  if (position >= text.length) {
    return null;
  }

  const opener = text.charAt(position);
  if (opener === ')') {
    return position + 1;
  }
  if (opener !== '"' && opener !== "'" && opener !== '(') {
    return null;
  }

  const closer = opener === '(' ? ')' : opener;
  position += 1;
  let closed = false;
  while (position < text.length) {
    const character = text.charAt(position);
    if (character === '\\') {
      position += 2;
      continue;
    }
    position += 1;
    if (character === closer) {
      closed = true;
      break;
    }
  }
  if (!closed) {
    return null;
  }

  while (position < text.length && isWhitespace(text.charAt(position))) {
    position += 1;
  }
  if (text.charAt(position) !== ')') {
    return null;
  }
  return position + 1;
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

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\t';
}
