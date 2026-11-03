/**
 * Test-only helpers for the M11 safe-annotation-values evidence.
 *
 * The parser and decoders below are deliberately independent of
 * `src/annotation.ts`. They understand only the documented workflow-command
 * grammar this repository emits and decode the permitted escape sequences, so
 * the tests can prove semantic preservation instead of using the production
 * encoder as its own oracle.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrokenLinkResult } from '../src/run.js';

/** Repository root, resolved from this test file rather than the cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Committed checker fixture whose portable file names and targets contain
 * characters that workflow commands treat specially. Colon file names and CR/LF
 * values are deliberately synthetic because they are not portable file names.
 */
export const M11_SPECIAL_VALUES_FIXTURE = join(
  REPO_ROOT,
  'test',
  'fixtures',
  'm11-special-values',
);

/**
 * The fixture's findings, relative to the fixture root, in the CLI's
 * deterministic result order.
 */
export const M11_SPECIAL_VALUES_FINDINGS = [
  { file: '100%.md', line: 3, target: 'missing-target.md', reason: 'target does not exist' },
  { file: 'README.md', line: 3, target: 'docs/100%.md', reason: 'target does not exist' },
  { file: 'README.md', line: 4, target: 'docs/a,b.md', reason: 'target does not exist' },
  { file: 'README.md', line: 5, target: 'docs/a:b.md', reason: 'target does not exist' },
  { file: 'README.md', line: 6, target: 'docs/::error.md', reason: 'target does not exist' },
  { file: 'README.md', line: 7, target: 'docs/::warning.md', reason: 'target does not exist' },
  { file: 'README.md', line: 8, target: 'docs/日本語.md', reason: 'target does not exist' },
  { file: 'README.md', line: 9, target: 'docs/literal%0A.md', reason: 'target does not exist' },
  { file: 'README.md', line: 10, target: 'docs/a=b"c.md', reason: 'target does not exist' },
  { file: 'comma,file.md', line: 3, target: 'missing-target.md', reason: 'target does not exist' },
] as const satisfies readonly BrokenLinkResult[];

/** Property-channel percent-escape sequences this repository emits. */
const PROPERTY_ESCAPE_DECODES = new Map<string, string>([
  ['25', '%'],
  ['0D', '\r'],
  ['0A', '\n'],
  ['3A', ':'],
  ['2C', ','],
]);

/** Message/data-channel percent-escape sequences this repository emits. */
const DATA_ESCAPE_DECODES = new Map<string, string>([
  ['25', '%'],
  ['0D', '\r'],
  ['0A', '\n'],
]);

/** One annotation parsed into its decoded channels. */
export interface ParsedAnnotation {
  readonly annotation: string;
  /** The `file` property exactly as it appears in the command. */
  readonly rawFile: string;
  /** The decoded `file` property value. */
  readonly file: string;
  readonly line: number;
  /** The message exactly as it appears in the command. */
  readonly rawMessage: string;
  /** The decoded message: the bounded `target — reason` text. */
  readonly message: string;
}

/** Decodes one property-channel value using an independent implementation. */
export function decodePropertyValue(encoded: string): string {
  return decodeWorkflowText(encoded, PROPERTY_ESCAPE_DECODES, 'property');
}

/** Decodes one message/data-channel value using an independent implementation. */
export function decodeMessageData(encoded: string): string {
  return decodeWorkflowText(encoded, DATA_ESCAPE_DECODES, 'message');
}

/**
 * Parses one rendered annotation back into its properties and message. Only the
 * known `file` and `line` properties are accepted; duplicate, missing,
 * unexpected or malformed properties are rejected, as is a literal line
 * terminator anywhere in the command.
 */
export function parseAnnotation(annotation: string): ParsedAnnotation {
  if (!annotation.startsWith('::error ')) {
    throw new Error(`unexpected annotation opener: ${annotation}`);
  }
  if (annotation.includes('\r') || annotation.includes('\n')) {
    throw new Error(`annotation contains a literal line terminator: ${annotation}`);
  }

  const body = annotation.slice('::error '.length);
  const separatorIndex = body.indexOf('::');
  if (separatorIndex === -1) {
    throw new Error(`annotation is missing the property/message separator: ${annotation}`);
  }

  const propertySection = body.slice(0, separatorIndex);
  const rawMessage = body.slice(separatorIndex + '::'.length);
  const properties = new Map<string, string>();

  for (const component of propertySection.split(',')) {
    const equalsIndex = component.indexOf('=');
    if (equalsIndex <= 0) {
      throw new Error(`malformed annotation property "${component}": ${annotation}`);
    }
    const name = component.slice(0, equalsIndex);
    const value = component.slice(equalsIndex + 1);
    if (properties.has(name)) {
      throw new Error(`duplicate annotation property "${name}": ${annotation}`);
    }
    properties.set(name, value);
  }

  for (const name of properties.keys()) {
    if (name !== 'file' && name !== 'line') {
      throw new Error(`unexpected annotation property "${name}": ${annotation}`);
    }
  }

  const rawFile = properties.get('file');
  const rawLine = properties.get('line');
  if (rawFile === undefined || rawLine === undefined) {
    throw new Error(`annotation is missing the file or line property: ${annotation}`);
  }
  if (!/^\d+$/.test(rawLine)) {
    throw new Error(`annotation line is not an integer: ${annotation}`);
  }
  const line = Number(rawLine);
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error(`annotation line is not a positive integer: ${annotation}`);
  }

  return {
    annotation,
    rawFile,
    file: decodePropertyValue(rawFile),
    line,
    rawMessage,
    message: decodeMessageData(rawMessage),
  };
}

/**
 * Decodes a value by scanning forward once. Every `%` must begin one of the
 * channel's supported escapes, so a truncated `%XX` sequence is rejected rather
 * than passing as literal text.
 */
function decodeWorkflowText(
  encoded: string,
  decodes: ReadonlyMap<string, string>,
  channel: string,
): string {
  let decoded = '';
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded.charAt(index);
    if (character !== '%') {
      decoded += character;
      continue;
    }
    const code = encoded.slice(index + 1, index + 3);
    const replacement = decodes.get(code);
    if (replacement === undefined) {
      throw new Error(`invalid ${channel} workflow escape "%${code}" in "${encoded}"`);
    }
    decoded += replacement;
    index += 2;
  }
  return decoded;
}
