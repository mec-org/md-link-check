import { readFileSync, statSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectDocumentAnchors } from './headings.js';
import {
  scanHtml,
  scanMarkdown,
  type HtmlTargetReference,
  type LinkKind,
  type MarkdownScan,
} from './parser.js';
import { classifyTarget } from './target.js';

const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const COUNTED_EXTERNAL = /^https?:/i;

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  kind: LinkKind;
  target: string;
  reason: string;
}

/** Everything one checking run produced, ready for either reporter. */
export interface CheckResult {
  /** Broken targets and undefined references, in deterministic document order. */
  diagnostics: Diagnostic[];
  /** Number of unique files that were checked. */
  filesChecked: number;
  /** Number of diagnostics (broken targets plus undefined references). */
  broken: number;
  /** Number of skipped HTTP(S) link and image uses. */
  externalSkipped: number;
}

/**
 * One link or image use in document order, before a reference-style definition
 * is resolved. Raw HTML uses already carry their destination.
 */
type PendingTarget =
  | {
      readonly style: 'direct';
      readonly kind: LinkKind;
      readonly target: string;
      readonly line: number;
      readonly column: number;
    }
  | {
      readonly style: 'reference';
      readonly kind: LinkKind;
      readonly label: string;
      readonly labelText: string;
      readonly line: number;
      readonly column: number;
    };

/**
 * Checks every relative link and image target in the given Markdown files, then
 * the heading anchors and explicit `<a id>`/`<a name>` anchors of fragment-only
 * targets and of relative Markdown targets that exist. This covers Markdown
 * forms and the supported raw HTML forms (`<a href>` and `<img src>`). Use sites
 * from both scanners are checked in document order.
 *
 * Reference-style uses are resolved through their definition in the same
 * document, and are reported at the use site. Every broken target is collected;
 * checking does not stop at the first one.
 *
 * Anchors are cached per resolved file path for one run. The cache stores
 * completed anchor sets, so duplicate-numbering state never crosses documents.
 */
export function checkMarkdown(files: readonly string[]): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const documentAnchors = new Map<string, ReadonlySet<string>>();
  let externalSkipped = 0;

  for (const file of files) {
    const markdown = readFileSync(file, 'utf8');
    const sourceAnchors = anchorsOf(file, markdown, documentAnchors);
    const markdownScan = scanMarkdown(markdown);
    const htmlScan = scanHtml(markdown);

    for (const use of documentOrder(markdownScan, htmlScan.references)) {
      let target: string;
      if (use.style === 'reference') {
        const definition = markdownScan.definitions.get(use.label);
        if (definition === undefined) {
          diagnostics.push({
            file,
            line: use.line,
            column: use.column,
            kind: use.kind,
            target: use.labelText,
            reason: 'reference definition does not exist',
          });
          continue;
        }
        target = definition.target;
      } else {
        target = use.target;
      }

      if (isCountedExternal(target)) {
        externalSkipped += 1;
      }
      const diagnostic = checkTarget(
        file,
        target,
        use.kind,
        use.line,
        use.column,
        sourceAnchors,
        documentAnchors,
      );
      if (diagnostic !== null) {
        diagnostics.push(diagnostic);
      }
    }
  }

  return { diagnostics, filesChecked: files.length, broken: diagnostics.length, externalSkipped };
}

/**
 * Compatibility wrapper for callers that only need the diagnostics. New code
 * should use `checkMarkdown`, which also reports the summary counts.
 */
export function checkMarkdownFiles(files: readonly string[]): Diagnostic[] {
  return checkMarkdown(files).diagnostics;
}

/**
 * Merges Markdown reference-style uses, Markdown inline uses and raw HTML uses
 * into one deterministic document-order list. Ordering by line then column
 * preserves the scanner's document order and lets both scanners agree on one
 * diagnostic sequence.
 */
function documentOrder(
  markdownScan: MarkdownScan,
  htmlReferences: readonly HtmlTargetReference[],
): PendingTarget[] {
  const uses: PendingTarget[] = [];

  for (const reference of markdownScan.references) {
    if (reference.style === 'reference') {
      uses.push({
        style: 'reference',
        kind: reference.kind,
        label: reference.label,
        labelText: reference.labelText,
        line: reference.line,
        column: reference.column,
      });
      continue;
    }
    uses.push({
      style: 'direct',
      kind: reference.kind,
      target: reference.target,
      line: reference.line,
      column: reference.column,
    });
  }

  for (const reference of htmlReferences) {
    uses.push({
      style: 'direct',
      kind: reference.kind,
      target: reference.target,
      line: reference.line,
      column: reference.column,
    });
  }

  return uses.sort((left, right) => left.line - right.line || left.column - right.column);
}

/** True for a skipped HTTP(S) use; other schemes are skipped but not counted. */
function isCountedExternal(target: string): boolean {
  return COUNTED_EXTERNAL.test(target.trim());
}

function checkTarget(
  file: string,
  target: string,
  kind: LinkKind,
  line: number,
  column: number,
  sourceAnchors: ReadonlySet<string>,
  documentAnchors: Map<string, ReadonlySet<string>>,
): Diagnostic | null {
  const trimmed = target.trim();

  if (trimmed.startsWith('#')) {
    const fragment = decodeFragment(trimmed.slice(1));
    if (fragment !== '' && !sourceAnchors.has(fragment)) {
      return { file, line, column, kind, target, reason: 'anchor does not exist' };
    }
    return null;
  }

  const classification = classifyTarget(target);
  if (classification.kind !== 'relative') {
    return null;
  }

  const targetPath = resolve(dirname(file), classification.path);
  const stats = statOf(targetPath);
  if (stats === null) {
    return { file, line, column, kind, target, reason: 'target does not exist' };
  }

  const fragment = classification.fragment;
  if (fragment === null || fragment === '') {
    return null;
  }
  if (!stats.isFile() || !MARKDOWN_FILE.test(classification.path)) {
    return null;
  }

  const targetAnchors = anchorsOf(targetPath, null, documentAnchors);
  if (!targetAnchors.has(decodeFragment(fragment))) {
    return { file, line, column, kind, target, reason: 'anchor does not exist' };
  }
  return null;
}

/**
 * Collects and caches the anchor names one document defines: heading slugs plus
 * explicit `<a id>`/`<a name>` values. The cache stores completed sets, so
 * duplicate-numbering state never crosses documents.
 */
function anchorsOf(
  file: string,
  markdown: string | null,
  cache: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const key = resolve(file);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const contents = markdown ?? readFileSync(key, 'utf8');
  const anchors: ReadonlySet<string> = new Set(collectDocumentAnchors(contents));
  cache.set(key, anchors);
  return anchors;
}

function statOf(targetPath: string): Stats | null {
  try {
    return statSync(targetPath);
  } catch {
    return null;
  }
}

/**
 * Decodes a percent-encoded fragment before comparing it with heading slugs and
 * explicit HTML anchors. A fragment that is not valid percent-encoding is
 * compared as written.
 */
function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
