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
 * Applies the project's GitHub-style heading slug rule: lowercase, drop
 * punctuation except hyphens, then convert whitespace to hyphens.
 *
 * Unicode normalisation, HTML entities, percent-decoding, escaped punctuation
 * and emoji are intentionally not modelled; anything that is not a letter,
 * number, combining mark, whitespace or hyphen is dropped.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '')
    .replace(/\s/gu, '-');
}

/**
 * Collects the slug of every heading in document order. A repeated base slug
 * gets `-1`, `-2`, and so on, counted independently for each document.
 */
export function collectHeadingSlugs(markdown: string): string[] {
  const seen = new Map<string, number>();

  return scanHeadings(markdown).map((heading) => {
    const base = slugifyHeading(heading.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  });
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
