import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

export class InputError extends Error {}

/**
 * Resolves the Markdown files to check. Explicit file inputs are always
 * checked; directory inputs are walked recursively in sorted order, skipping
 * `.git` and `node_modules`. The returned paths keep the caller's form (for
 * example `.` produces `README.md`, not an absolute path) and are sorted by
 * their resolved location so the order is deterministic across platforms.
 */
export function discoverMarkdownFiles(inputs: readonly string[]): string[] {
  const found = new Map<string, string>();

  for (const input of inputs) {
    let inputStat;
    try {
      inputStat = statSync(input);
    } catch {
      throw new InputError(`cannot access input path "${input}"`);
    }

    if (inputStat.isFile()) {
      found.set(resolve(input), input);
      continue;
    }
    if (!inputStat.isDirectory()) {
      throw new InputError(`input path "${input}" is not a file or directory`);
    }
    walk(input, input, found);
  }

  return [...found.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([, displayPath]) => displayPath);
}

function walk(directory: string, displayDirectory: string, found: Map<string, string>): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    compare(left.name, right.name),
  );

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      walk(join(directory, entry.name), join(displayDirectory, entry.name), found);
      continue;
    }
    if (entry.isFile() && MARKDOWN_FILE.test(entry.name)) {
      found.set(resolve(directory, entry.name), join(displayDirectory, entry.name));
    }
  }
}

function compare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
