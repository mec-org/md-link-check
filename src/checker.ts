import { readFileSync, statSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectHeadingSlugs } from './headings.js';
import { scanMarkdown, type LinkKind } from './parser.js';
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
 * Checks every relative link and image target in the given Markdown files, then
 * the heading anchors of fragment-only targets and of relative Markdown targets
 * that exist. Reference-style uses are resolved through their definition in the
 * same document, and are reported at the use site. Every broken target is
 * collected; checking does not stop at the first one.
 *
 * Heading slugs are cached per resolved file path for one run. The cache stores
 * completed slug sets, so duplicate-numbering state never crosses documents.
 */
export function checkMarkdown(files: readonly string[]): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const headingSlugs = new Map<string, ReadonlySet<string>>();
  let externalSkipped = 0;

  for (const file of files) {
    const markdown = readFileSync(file, 'utf8');
    const sourceSlugs = headingsOf(file, markdown, headingSlugs);
    const scan = scanMarkdown(markdown);

    for (const reference of scan.references) {
      if (reference.style === 'reference') {
        const definition = scan.definitions.get(reference.label);
        if (definition === undefined) {
          diagnostics.push({
            file,
            line: reference.line,
            column: reference.column,
            kind: reference.kind,
            target: reference.labelText,
            reason: 'reference definition does not exist',
          });
          continue;
        }
        if (isCountedExternal(definition.target)) {
          externalSkipped += 1;
        }
        const diagnostic = checkTarget(
          file,
          definition.target,
          reference.kind,
          reference.line,
          reference.column,
          sourceSlugs,
          headingSlugs,
        );
        if (diagnostic !== null) {
          diagnostics.push(diagnostic);
        }
        continue;
      }

      if (isCountedExternal(reference.target)) {
        externalSkipped += 1;
      }
      const diagnostic = checkTarget(
        file,
        reference.target,
        reference.kind,
        reference.line,
        reference.column,
        sourceSlugs,
        headingSlugs,
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
  sourceSlugs: ReadonlySet<string>,
  headingSlugs: Map<string, ReadonlySet<string>>,
): Diagnostic | null {
  const trimmed = target.trim();

  if (trimmed.startsWith('#')) {
    const fragment = decodeFragment(trimmed.slice(1));
    if (fragment !== '' && !sourceSlugs.has(fragment)) {
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

  const targetSlugs = headingsOf(targetPath, null, headingSlugs);
  if (!targetSlugs.has(decodeFragment(fragment))) {
    return { file, line, column, kind, target, reason: 'anchor does not exist' };
  }
  return null;
}

function headingsOf(
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
  const slugs: ReadonlySet<string> = new Set(collectHeadingSlugs(contents));
  cache.set(key, slugs);
  return slugs;
}

function statOf(targetPath: string): Stats | null {
  try {
    return statSync(targetPath);
  } catch {
    return null;
  }
}

/**
 * Decodes a percent-encoded fragment before comparing it with heading slugs.
 * A fragment that is not valid percent-encoding is compared as written.
 */
function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
