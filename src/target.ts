export type TargetClassification =
  | { kind: 'relative'; path: string; fragment: string | null }
  | { kind: 'skipped'; reason: 'empty' | 'external' | 'fragment' | 'absolute' };

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Decides how a Markdown target's path should be treated.
 *
 * Only relative paths are checked. A fragment-only target has no path to check
 * and is reported as skipped here; the checker validates its anchor separately.
 * Absolute (root-relative) targets are out of scope, and any URI (including
 * HTTP and HTTPS) is skipped without network access.
 */
export function classifyTarget(rawTarget: string): TargetClassification {
  const target = rawTarget.trim();
  if (target === '') {
    return { kind: 'skipped', reason: 'empty' };
  }
  if (target.startsWith('//') || URI_SCHEME.test(target)) {
    return { kind: 'skipped', reason: 'external' };
  }
  if (target.startsWith('#')) {
    return { kind: 'skipped', reason: 'fragment' };
  }
  if (target.startsWith('/')) {
    return { kind: 'skipped', reason: 'absolute' };
  }

  const hash = target.indexOf('#');
  if (hash === -1) {
    return { kind: 'relative', path: target, fragment: null };
  }

  const path = target.slice(0, hash);
  if (path === '') {
    return { kind: 'skipped', reason: 'fragment' };
  }
  return { kind: 'relative', path, fragment: target.slice(hash + 1) };
}
