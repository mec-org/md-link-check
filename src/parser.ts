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

/** An explicit anchor target declared by `<a id="…">` or `<a name="…">`. */
export interface HtmlAnchorTarget {
  /** The value as written, without surrounding quotes. */
  value: string;
  /** 1-based line number of the opening tag. */
  line: number;
}

/** A raw HTML link or image target found in a supported tag. */
export interface HtmlTargetReference {
  kind: LinkKind;
  /** The value of `href` or `src` as written, without surrounding quotes. */
  target: string;
  /** 1-based line number of the opening tag. */
  line: number;
  /** 1-based column number of the opening `<` of the tag. */
  column: number;
}

/** The result of scanning the supported raw HTML forms in one document. */
export interface HtmlScan {
  /** Explicit anchor targets in document order. */
  readonly anchors: readonly HtmlAnchorTarget[];
  /** Raw HTML link and image targets in document order. */
  readonly references: readonly HtmlTargetReference[];
}

/** One HTML tag found on a single line. */
interface HtmlTag {
  /** Lowercased tag name. */
  name: string;
  /** 0-based index of the line that contains the tag. */
  lineIndex: number;
  /** 0-based index of the opening `<`. */
  start: number;
  /** 0-based index of the closing `>`. */
  end: number;
  /** Attribute value ranges; the first occurrence of a name wins. */
  attributes: ReadonlyMap<string, HtmlAttributeRange | null>;
}

/** A half-open value range inside a tag, excluding surrounding quotes. */
interface HtmlAttributeRange {
  start: number;
  end: number;
}

/** HTML tags that M4 supports; other raw HTML is not scanned. */
const SUPPORTED_HTML_TAGS = new Set(['a', 'img']);

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
 * never returned as inline links or shortcut uses. Supported raw HTML tags
 * (`<a …>` and `<img …>`) are masked too, so link syntax inside their attribute
 * values is not read as Markdown. Autolinks and unsupported raw HTML are
 * outside scope; see `scanHtml` for the supported raw HTML forms.
 */
export function scanMarkdown(markdown: string): MarkdownScan {
  const lines = markdown.split(/\r?\n/);
  const { masked: codeMaskedLines } = maskCodeLines(lines);
  const maskedLines = maskSupportedHtmlTags(codeMaskedLines, findHtmlTags(codeMaskedLines));
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
 * Finds the supported raw HTML forms: explicit anchors from `<a id="…">` and
 * `<a name="…">`, links from `<a href="…">`, and images from `<img src="…">`.
 *
 * Tag and attribute names are matched ASCII case-insensitively, attributes may
 * appear in any order, and values may be double-quoted, single-quoted or
 * unquoted. The first syntactically valid occurrence of a duplicated relevant
 * attribute on one tag wins. Values are kept literally, so HTML entities,
 * percent-encoding, Unicode normalization and repeated explicit anchor names
 * are not interpreted. Empty values are ignored.
 *
 * Fenced code blocks, indented code blocks and inline code spans are masked
 * with the same exclusions `scanMarkdown` uses, so supported-looking tags inside
 * them are not found. Tags must be closed on the same line; an unclosed tag and
 * malformed attribute syntax are ignored. Other raw HTML is not scanned.
 */
export function scanHtml(markdown: string): HtmlScan {
  const lines = markdown.split(/\r?\n/);
  const { masked: codeMaskedLines } = maskCodeLines(lines);
  const anchors: HtmlAnchorTarget[] = [];
  const references: HtmlTargetReference[] = [];

  for (const tag of findHtmlTags(codeMaskedLines)) {
    const line = tag.lineIndex + 1;
    const column = tag.start + 1;
    const original = lines[tag.lineIndex] ?? '';

    if (tag.name === 'a') {
      const id = attributeValue(tag, original, 'id');
      if (id !== null) {
        anchors.push({ value: id, line });
      }
      const name = attributeValue(tag, original, 'name');
      if (name !== null) {
        anchors.push({ value: name, line });
      }
      const href = attributeValue(tag, original, 'href');
      if (href !== null) {
        references.push({ kind: 'link', target: href, line, column });
      }
      continue;
    }

    if (tag.name === 'img') {
      const src = attributeValue(tag, original, 'src');
      if (src !== null) {
        references.push({ kind: 'image', target: src, line, column });
      }
    }
  }

  return { anchors, references };
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
 * Finds every HTML-like opening tag on the code-masked lines. A `<` starts a tag
 * only when an ASCII letter follows; scanning resumes after each tag's closing
 * `>`, so a quote-aware tag boundary never scans beyond it.
 */
function findHtmlTags(maskedLines: readonly string[]): HtmlTag[] {
  const tags: HtmlTag[] = [];

  for (let lineIndex = 0; lineIndex < maskedLines.length; lineIndex += 1) {
    const line = maskedLines[lineIndex] ?? '';
    let index = 0;

    while (index < line.length) {
      const start = line.indexOf('<', index);
      if (start === -1) {
        break;
      }
      const tag = parseHtmlTag(line, lineIndex, start);
      if (tag === null) {
        index = start + 1;
        continue;
      }
      tags.push(tag);
      index = tag.end + 1;
    }
  }

  return tags;
}

/**
 * Parses one opening tag from `<` to the matching `>` on the same line. A `>`
 * inside a quoted attribute value does not end the tag.
 */
function parseHtmlTag(line: string, lineIndex: number, start: number): HtmlTag | null {
  let cursor = start + 1;
  if (!isAsciiLetter(line.charAt(cursor))) {
    return null;
  }

  const nameStart = cursor;
  cursor += 1;
  while (cursor < line.length && isHtmlTagNameCharacter(line.charAt(cursor))) {
    cursor += 1;
  }
  const name = line.slice(nameStart, cursor).toLowerCase();
  const attributesStart = cursor;

  let quote: string | null = null;
  while (cursor < line.length) {
    const character = line.charAt(cursor);
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      cursor += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === '>') {
      return {
        name,
        lineIndex,
        start,
        end: cursor,
        attributes: parseHtmlAttributes(line, attributesStart, cursor),
      };
    }
    cursor += 1;
  }

  return null;
}

/**
 * Parses the attributes between a tag name and its closing `>`. Attribute names
 * are compared as complete names, so `data-href`, `srcset` and `name-extra` are
 * not the supported attributes. The first occurrence of a duplicated name wins.
 */
function parseHtmlAttributes(
  line: string,
  start: number,
  end: number,
): ReadonlyMap<string, HtmlAttributeRange | null> {
  const attributes = new Map<string, HtmlAttributeRange | null>();
  let cursor = start;

  while (cursor < end) {
    while (cursor < end && isHtmlWhitespace(line.charAt(cursor))) {
      cursor += 1;
    }
    if (cursor >= end) {
      break;
    }
    if (line.charAt(cursor) === '/') {
      cursor += 1;
      continue;
    }
    if (!isHtmlAttributeNameStartCharacter(line.charAt(cursor))) {
      cursor += 1;
      continue;
    }

    const nameStart = cursor;
    cursor += 1;
    while (cursor < end && isHtmlAttributeNameCharacter(line.charAt(cursor))) {
      cursor += 1;
    }
    const name = line.slice(nameStart, cursor).toLowerCase();

    let equalCursor = cursor;
    while (equalCursor < end && isHtmlWhitespace(line.charAt(equalCursor))) {
      equalCursor += 1;
    }
    if (line.charAt(equalCursor) !== '=') {
      if (!attributes.has(name)) {
        attributes.set(name, null);
      }
      continue;
    }

    cursor = equalCursor + 1;
    while (cursor < end && isHtmlWhitespace(line.charAt(cursor))) {
      cursor += 1;
    }

    const quote = line.charAt(cursor);
    let range: HtmlAttributeRange | null = null;
    if (quote === '"' || quote === "'") {
      const valueStart = cursor + 1;
      const closing = line.indexOf(quote, valueStart);
      if (closing !== -1 && closing < end) {
        range = { start: valueStart, end: closing };
        cursor = closing + 1;
      } else {
        cursor = end;
      }
    } else if (cursor < end) {
      const valueStart = cursor;
      while (cursor < end && !isHtmlWhitespace(line.charAt(cursor))) {
        cursor += 1;
      }
      range = { start: valueStart, end: cursor };
    }

    if (!attributes.has(name)) {
      attributes.set(name, range);
    }
  }

  return attributes;
}

/**
 * Reads a supported attribute from the original line. The code-masked line
 * supplied positions, which are preserved, so inline code inside an HTML
 * attribute does not change the value text. Absent, valueless and empty values
 * read as null.
 */
function attributeValue(tag: HtmlTag, line: string, name: string): string | null {
  const range = tag.attributes.get(name);
  if (range === undefined || range === null) {
    return null;
  }
  const value = line.slice(range.start, range.end);
  return value === '' ? null : value;
}

/** Replaces every supported `<a …>` or `<img …>` tag with spaces. */
function maskSupportedHtmlTags(
  maskedLines: readonly string[],
  tags: readonly HtmlTag[],
): readonly string[] {
  const rangesByLine = new Map<number, Array<{ start: number; end: number }>>();
  for (const tag of tags) {
    if (!SUPPORTED_HTML_TAGS.has(tag.name)) {
      continue;
    }
    const ranges = rangesByLine.get(tag.lineIndex);
    const range = { start: tag.start, end: tag.end };
    if (ranges === undefined) {
      rangesByLine.set(tag.lineIndex, [range]);
    } else {
      ranges.push(range);
    }
  }
  if (rangesByLine.size === 0) {
    return maskedLines;
  }

  const masked = [...maskedLines];
  for (const [lineIndex, ranges] of rangesByLine) {
    const line = masked[lineIndex] ?? '';
    let result = '';
    let cursor = 0;
    for (const range of ranges) {
      result += line.slice(cursor, range.start);
      result += ' '.repeat(range.end + 1 - range.start);
      cursor = range.end + 1;
    }
    masked[lineIndex] = result + line.slice(cursor);
  }
  return masked;
}

function isAsciiLetter(character: string): boolean {
  return (
    (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z')
  );
}

function isAsciiDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isHtmlTagNameCharacter(character: string): boolean {
  return (
    isAsciiLetter(character) ||
    isAsciiDigit(character) ||
    character === '-' ||
    character === '_' ||
    character === ':' ||
    character === '.'
  );
}

function isHtmlAttributeNameStartCharacter(character: string): boolean {
  return isAsciiLetter(character) || character === '_' || character === ':';
}

function isHtmlAttributeNameCharacter(character: string): boolean {
  return (
    isHtmlAttributeNameStartCharacter(character) ||
    isAsciiDigit(character) ||
    character === '-' ||
    character === '.'
  );
}

function isHtmlWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\f' || character === '\r';
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
 * Normalizes a reference label for matching: surrounding whitespace is trimmed,
 * every internal run of spaces or tabs collapses to one space, and the text is
 * lowercased.
 */
function normalizeLabel(label: string): string {
  return label.trim().replace(/[ \t]+/g, ' ').toLowerCase();
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
