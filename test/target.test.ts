import { describe, expect, it } from 'vitest';
import { classifyTarget } from '../src/target.js';

describe('target classification', () => {
  it('skips http and https destinations', () => {
    expect(classifyTarget('https://example.com/guide.md')).toEqual({
      kind: 'skipped',
      reason: 'external',
    });
    expect(classifyTarget('http://example.com/image.png')).toEqual({
      kind: 'skipped',
      reason: 'external',
    });
    expect(classifyTarget('HTTPS://example.com/guide.md')).toEqual({
      kind: 'skipped',
      reason: 'external',
    });
  });

  it('skips fragment-only destinations', () => {
    expect(classifyTarget('#installation')).toEqual({ kind: 'skipped', reason: 'fragment' });
  });

  it('strips a fragment before validating a relative file path', () => {
    expect(classifyTarget('docs/guide.md#installation')).toEqual({
      kind: 'relative',
      path: 'docs/guide.md',
      fragment: 'installation',
    });
  });

  it('skips root-relative and non-http targets as unsupported', () => {
    expect(classifyTarget('/docs/guide.md')).toEqual({ kind: 'skipped', reason: 'absolute' });
    expect(classifyTarget('mailto:someone@example.com')).toEqual({
      kind: 'skipped',
      reason: 'external',
    });
    expect(classifyTarget('  ')).toEqual({ kind: 'skipped', reason: 'empty' });
  });
});
