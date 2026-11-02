import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scanInlineReferences, type LinkKind } from './parser.js';
import { classifyTarget } from './target.js';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  kind: LinkKind;
  target: string;
  reason: string;
}

/**
 * Checks every relative link and image target in the given Markdown files.
 * All broken targets are collected; checking does not stop at the first one.
 */
export function checkMarkdownFiles(files: readonly string[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const file of files) {
    const markdown = readFileSync(file, 'utf8');
    for (const reference of scanInlineReferences(markdown)) {
      const classification = classifyTarget(reference.target);
      if (classification.kind !== 'relative') {
        continue;
      }

      const targetPath = resolve(dirname(file), classification.path);
      if (!exists(targetPath)) {
        diagnostics.push({
          file,
          line: reference.line,
          column: reference.column,
          kind: reference.kind,
          target: reference.target,
          reason: 'target does not exist',
        });
      }
    }
  }

  return diagnostics;
}

function exists(targetPath: string): boolean {
  try {
    statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}
