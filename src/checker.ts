import { readFileSync, statSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectHeadingSlugs } from './headings.js';
import { scanInlineReferences, type InlineReference, type LinkKind } from './parser.js';
import { classifyTarget } from './target.js';

const MARKDOWN_FILE = /\.(?:md|markdown)$/i;

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  kind: LinkKind;
  target: string;
  reason: string;
}

/**
 * Checks every relative link and image target in the given Markdown files, then
 * the heading anchors of fragment-only targets and of relative Markdown targets
 * that exist. All broken targets are collected; checking does not stop at the
 * first one.
 *
 * Heading slugs are cached per resolved file path for one run. The cache stores
 * completed slug sets, so duplicate-numbering state never crosses documents.
 */
export function checkMarkdownFiles(files: readonly string[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const headingSlugs = new Map<string, ReadonlySet<string>>();

  for (const file of files) {
    const markdown = readFileSync(file, 'utf8');
    const sourceSlugs = headingsOf(file, markdown, headingSlugs);

    for (const reference of scanInlineReferences(markdown)) {
      const target = reference.target.trim();

      if (target.startsWith('#')) {
        const fragment = decodeFragment(target.slice(1));
        if (fragment !== '' && !sourceSlugs.has(fragment)) {
          diagnostics.push(missingAnchor(file, reference));
        }
        continue;
      }

      const classification = classifyTarget(reference.target);
      if (classification.kind !== 'relative') {
        continue;
      }

      const targetPath = resolve(dirname(file), classification.path);
      const stats = statOf(targetPath);
      if (stats === null) {
        diagnostics.push({
          file,
          line: reference.line,
          column: reference.column,
          kind: reference.kind,
          target: reference.target,
          reason: 'target does not exist',
        });
        continue;
      }

      const fragment = classification.fragment;
      if (fragment === null || fragment === '') {
        continue;
      }
      if (!stats.isFile() || !MARKDOWN_FILE.test(classification.path)) {
        continue;
      }

      const targetSlugs = headingsOf(targetPath, null, headingSlugs);
      if (!targetSlugs.has(decodeFragment(fragment))) {
        diagnostics.push(missingAnchor(file, reference));
      }
    }
  }

  return diagnostics;
}

function missingAnchor(file: string, reference: InlineReference): Diagnostic {
  return {
    file,
    line: reference.line,
    column: reference.column,
    kind: reference.kind,
    target: reference.target,
    reason: 'anchor does not exist',
  };
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
