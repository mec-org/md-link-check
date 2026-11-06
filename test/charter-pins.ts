/**
 * Owner-approved v0.4 charter file pins shared by the later scope guards.
 *
 * The owner-approved v0.4 charter (#44, commit `2093d17`) changed `PROJECT.md`
 * and `ROADMAP.md` after the v0.3 milestones. Rather than exempting those two
 * paths from the later scope checks, `test/m14-exit-usage-interaction.test.ts`
 * and `test/m16-artifact-scope.test.ts` accept a changed charter file only when
 * its Git blob hash equals the owner-approved content pinned below. The pin is
 * content-based: it reads the current file with `git hash-object`, needs no git
 * history, and therefore also holds in a shallow CI checkout. Any other content
 * is a violation.
 *
 * A future charter PR approved by the owner updates these two hashes in the
 * same PR that changes the files.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Blob hashes of the owner-approved v0.4 charter content: the bytes of
 * `PROJECT.md` and `ROADMAP.md` at commit `2093d17` (#44).
 */
export const CHARTER_FILE_PINS: Readonly<Record<string, string>> = Object.freeze({
  'PROJECT.md': 'ea3d2ee55f766b0d30956754e4908fa578c6c5c7',
  'ROADMAP.md': 'b7c34bd3902a0a26551d6fb1bb7266134a5fddeb',
});

/** Git blob hash of the bytes currently at `path`; no repository history needed. */
export function gitBlobHash(path: string): string {
  return execFileSync('git', ['hash-object', '--', path], { encoding: 'utf8' }).trim();
}

/**
 * True when `path` is one of the pinned charter files and the bytes under
 * `root` are exactly the owner-approved content. Every other path is `false`,
 * so callers must still apply their own allow rules; this helper never widens
 * access to any path other than the two pinned charter files.
 */
export function isPinnedCharterFile(path: string, root: string): boolean {
  const expected = CHARTER_FILE_PINS[path];
  if (expected === undefined) {
    return false;
  }
  try {
    return gitBlobHash(join(root, path)) === expected;
  } catch {
    return false;
  }
}
