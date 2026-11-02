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

/** A reference definition (`[label]: target`) found in Markdown. */
export interface ReferenceDefinition {
  /** Lookup key: the label text trimmed and lowercased. */
  label: string;
  /** The label text as written, trimmed. */
  labelText: string;
  /** The destination as written, without angle brackets or title. */
  target: string;
  /** 1-based line number of the definition. */
  line: number;
  /** 1-based column number of the definition's opening `[`. */
  column: number;
}

/**
 * A full, collapsed or shortcut reference-style use of a definition, before the
 * matching definition is resolved.
 */
export interface ReferenceUse {
  kind: LinkKind;
  /**
   * Lookup key: the reference label or, for collapsed and shortcut forms, the
   * link text; trimmed and lowercased.
   */
  label: string;
  /**
   * The reference label (or shortcut link text) as written and trimmed. It is
   * reported for an undefined reference, which has no destination.
   */
  labelText: string;
  /** 1-based line number of the `[` or `!` that starts the use. */
  line: number;
  /** 1-based column number of the `[` or `!` that starts the use. */
  column: number;
}

/** A link or image use found in a document, in document order. */
export type MarkdownReference =
  | ({ style: 'inline' } & InlineReference)
  | ({ style: 'reference' } & ReferenceUse);

/** The result of scanning one Markdown document. */
export interface MarkdownScan {
  /** Inline links/images and reference-style uses in document order. */
  readonly references: readonly MarkdownReference[];
  /** The first definition for each normalized label. */
  readonly definitions: ReadonlyMap<string, ReferenceDefinition>;
}

interface ParsedLink {
  target: string;
  end: number;
}

interface ParsedReferenceUse {
  reference: ReferenceUse;
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
const DEFINITION_START = /^( {0,3})\[/;

/**
 * Finds inline links (`[label](target)`), inline images (`![alt](target)`),
 * full reference-style uses (`[text][label]`), collapsed uses (`[text][]`) and
 * shortcut uses (`[text]`), plus every reference definition (`[label]: target`).
 *
 * A shortcut use is a reference only when a matching definition exists;
 * otherwise it stays ordinary bracketed text, so prose brackets do not become
 * findings. Full and collapsed uses are reported even when their definition is
 * missing, so the checker can report an undefined reference at the use site.
 *
 * Fenced code blocks, indented code blocks and inline code spans are masked
 * before scanning, so syntax inside them is ignored. Reference definitions are
 * never returned as inline links or shortcut uses. Raw HTML and autolinks are
 * outside the supported scope.
 */
export function scanMarkdown(markdown: string): MarkdownScan {
  const lines = markdown.split(/\r?\n/);
  const { masked: maskedLines } = maskCodeLines(lines);
  const definitions = new Map<string, ReferenceDefinition>();
  const definitionLines = new Set<number>();

  // Definitions are collected first so shortcut uses anywhere in the document
  // can resolve, and so a definition line is never read as a shortcut use.
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const definition = parseReferenceDefinition(
      lines[lineIndex] ?? '',
      maskedLines[lineIndex] ?? '',
      lineIndex + 1,
    );
    if (definition === null) {
      continue;
    }
    definitionLines.add(lineIndex);
    if (!definitions.has(definition.label)) {
      definitions.set(definition.label, definition);
    }
  }

  const references: MarkdownReference[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (definitionLines.has(lineIndex)) {
      continue;
    }
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

      const kind: LinkKind = imageStart ? 'image' : 'link';
      const inline = parseInlineLink(masked, original, bracket);
      if (inline !== null) {
        if (inline.target !== '') {
          references.push({
            style: 'inline',
            kind,
            target: inline.target,
            line: lineIndex + 1,
            column: index + 1,
          });
        }
        index = inline.end;
        continue;
      }

      const reference = parseReferenceUse(
        masked,
        original,
        bracket,
        kind,
        lineIndex + 1,
        index + 1,
        definitions,
      );
      if (reference !== null) {
        references.push({ style: 'reference', ...reference.reference });
        index = reference.end;
        continue;
      }

      index += 1;
    }
  }

  return { references, definitions };
}

/**
 * Finds inline links and images only. Reference-style syntax is deliberately
 * excluded here; use `scanMarkdown` to scan every supported form.
 */
export function scanInlineReferences(markdown: string): InlineReference[] {
  const inline: InlineReference[] = [];
  for (const reference of scanMarkdown(markdown).references) {
    if (reference.style !== 'inline') {
      continue;
    }
    inline.push({
      kind: reference.kind,
      target: reference.target,
      line: reference.line,
      column: reference.column,
    });
  }
  return inline;
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

/**
 * Parses a single-line reference definition. The masked line is used to decide
 * what is syntax, while the original line supplies the destination text, so
 * code spans can never contribute a definition.
 */
function parseReferenceDefinition(
  original: string,
  masked: string,
  line: number,
): ReferenceDefinition | null {
  const start = DEFINITION_START.exec(masked);
  if (start === null) {
    return null;
  }

  const bracket = (start[1] ?? '').length;
  const labelEnd = findClosingBracket(masked, bracket);
  if (labelEnd === -1 || masked.charAt(labelEnd + 1) !== ':') {
    return null;
  }

  const rawLabel = original.slice(bracket + 1, labelEnd);
  const labelText = rawLabel.trim();
  const label = normalizeLabel(labelText);
  if (label === '' || hasUnescapedBracket(labelText)) {
    return null;
  }

  const destination = parseDefinitionDestination(masked, original, labelEnd + 2);
  if (destination === null) {
    return null;
  }

  return { label, labelText, target: destination, line, column: bracket + 1 };
}

/**
 * Parses the destination of a reference definition, optionally followed by a
 * `"…"`, `'…'` or `(…)` title and trailing whitespace. Returns the destination
 * as written, or null when the line is not a valid definition.
 */
function parseDefinitionDestination(
  masked: string,
  original: string,
  afterColon: number,
): string | null {
  let cursor = afterColon;
  while (cursor < masked.length && isWhitespace(masked.charAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= masked.length) {
    return null;
  }

  let target: string;
  if (masked.charAt(cursor) === '<') {
    const targetStart = cursor + 1;
    cursor = targetStart;
    while (cursor < masked.length) {
      if (masked.charAt(cursor) === '>' && !isEscaped(masked, cursor)) {
        break;
      }
      cursor += 1;
    }
    if (cursor >= masked.length) {
      return null;
    }
    target = original.slice(targetStart, cursor);
    cursor += 1;
  } else {
    const targetStart = cursor;
    while (cursor < masked.length && !isWhitespace(masked.charAt(cursor))) {
      cursor += 1;
    }
    target = original.slice(targetStart, cursor);
  }

  while (cursor < masked.length && isWhitespace(masked.charAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= masked.length) {
    return target;
  }

  const opener = masked.charAt(cursor);
  if (opener !== '"' && opener !== "'" && opener !== '(') {
    return null;
  }
  const closer = opener === '(' ? ')' : opener;
  cursor += 1;
  let closed = false;
  while (cursor < masked.length) {
    const character = masked.charAt(cursor);
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    cursor += 1;
    if (character === closer) {
      closed = true;
      break;
    }
  }
  if (!closed) {
    return null;
  }

  while (cursor < masked.length && isWhitespace(masked.charAt(cursor))) {
    cursor += 1;
  }
  return cursor === masked.length ? target : null;
}

/**
 * Parses a full, collapsed or shortcut reference-style use at `bracket`.
 * Shortcut uses resolve only against an existing definition; full and collapsed
 * uses are returned even without one so the checker can report them.
 */
function parseReferenceUse(
  masked: string,
  original: string,
  bracket: number,
  kind: LinkKind,
  line: number,
  column: number,
  definitions: ReadonlyMap<string, ReferenceDefinition>,
): ParsedReferenceUse | null {
  const linkTextEnd = findClosingBracket(masked, bracket);
  if (linkTextEnd === -1) {
    return null;
  }

  const linkText = original.slice(bracket + 1, linkTextEnd);

  if (masked.charAt(linkTextEnd + 1) === '[') {
    const labelEnd = findClosingBracket(masked, linkTextEnd + 1);
    if (labelEnd === -1) {
      return null;
    }
    const rawLabel = original.slice(linkTextEnd + 2, labelEnd);
    const collapsed = rawLabel === '';
    if (!collapsed && rawLabel.trim() === '') {
      return null;
    }
    const labelText = (collapsed ? linkText : rawLabel).trim();
    const label = normalizeLabel(labelText);
    if (label === '' || hasUnescapedBracket(labelText)) {
      return null;
    }
    return {
      reference: { kind, label, labelText, line, column },
      end: labelEnd + 1,
    };
  }

  const labelText = linkText.trim();
  const label = normalizeLabel(labelText);
  if (label === '' || hasUnescapedBracket(labelText) || !definitions.has(label)) {
    return null;
  }
  return {
    reference: { kind, label, labelText, line, column },
    end: linkTextEnd + 1,
  };
}

/**
 * Normalizes a reference label for matching: surrounding whitespace is trimmed
 * and the text is lowercased. Internal whitespace is not collapsed.
 */
function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/** True when the text contains a `[` or `]` that is not backslash-escaped. */
function hasUnescapedBracket(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[' || character === ']') {
      return true;
    }
  }
  return false;
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
