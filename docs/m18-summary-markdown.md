# M18 — Summary values and Markdown escaping

Base: `bedfcde1e6b080645094a87d7d0c7b8f0d7bcd4c` (M17, #46).

M18 adds one internal, pure utility that escapes a single untrusted value so a
later milestone can place it inside one inline Markdown summary entry. The
escaped value is for file names, link targets and failure reasons. M18 does not
wire the utility into the GitHub Action and writes no job summary; M19 is
expected to pass every value through it, and M20 writes the summary.

## Module and export

`src/summary-markdown.ts` exports:

- `escapeSummaryValue(value: string): string` — escapes one value;
- `SUMMARY_VALUE_MAX_EXPANSION` — the documented expansion bound (`6`).

The module imports nothing, reads no environment, performs no I/O and adds no
runtime dependency. It iterates the input by Unicode code point, so surrogate
pairs and other non-ASCII text are never split or rewritten.

## Encoding rules

One input code point produces one of these outputs. The input is scanned once
and each encoding is written directly to the result, so a generated encoding is
never escaped again.

```text
input             output
\                 \\
`                 \`
|                 \|
*                 \*
_                 \_
[                 \[
]                 \]
<                 &lt;
>                 &gt;
&                 &amp;
#                 \#
LF                \n
CR                \r
TAB               \t
other C0 / DEL    \uXXXX   (lowercase four-digit hexadecimal, e.g. \u0000, \u001f, \u007f)
anything else     unchanged
```

Notes:

- **Backslash disambiguation.** Every literal backslash is doubled. A literal
  backslash followed by `n`, `r`, `t` or `u0000` therefore keeps its literal
  meaning and is distinct in the escaped string from the encoding of the actual
  control character: literal `\n` (two input characters) becomes `\\n` (three
  output characters), while LF becomes `\n` (two output characters).
- **Heading marker.** Every `#` is backslash-escaped, not only one in a leading
  position, so the value stays safe wherever a future summary layout places it.
  The escaped text still renders as `#`.
- **Angle brackets and ampersand.** `<` and `>` become `&lt;` and `&gt;`, so
  they cannot open raw HTML or an autolink. `&` becomes `&amp;`, so input such
  as `&lt;` stays the four literal characters it was instead of rendering as
  `<`; entity-like text cannot collide with an encoded bracket.
- **Line breaks and controls.** LF, CR and TAB have the visible sequences
  above; U+0000–U+001F not covered by those and U+007F use the fixed-width
  `\uXXXX` form. No raw line break or covered control remains, and the
  representation is unambiguous.
- **Everything else** — ordinary text and all non-ASCII characters — is
  emitted unchanged. Nothing is deleted, trimmed, collapsed, reordered or
  truncated.
- **Empty input** maps to the empty string.

## Guarantees

- **One physical line.** The output contains no raw CR, LF, TAB, C0 control or
  DEL character.
- **Meaning and order.** Every input character remains represented, in order,
  by itself or by its documented encoding.
- **Deterministic.** The same input always produces the same output.
- **Bounded.** Each input UTF-16 code unit produces at most
  `SUMMARY_VALUE_MAX_EXPANSION` (6) output UTF-16 code units, so
  `escapeSummaryValue(value).length <= 6 * value.length` for every string,
  including the empty string. The longest encoding is the six-code-unit
  `\uXXXX` control form, and the bound is tight for repeated U+0000. The value
  is always escaped in full; M18 defines no truncation.

## Tests

`test/summary-markdown.test.ts` covers each required character class with
literal expected strings:

1. `escapes Markdown structural punctuation` — backticks, pipes, asterisks,
   underscores, brackets and angle brackets;
2. `escapes an ampersand so entity-like text stays literal`;
3. `escapes a leading heading marker` — a leading `#` and a `#` away from the
   leading position;
4. `encodes line breaks as visible text on one line` — LF, CR and CRLF;
5. `encodes tabs and control characters without deletion` — TAB, U+0000, an
   interior C0 control, U+001F and U+007F;
6. `distinguishes literal escape-like text from encoded controls` — literal
   `\n`, `\r`, `\t` and `\u0000` against the encoded controls;
7. `preserves mixed value meaning in one escaped entry` — one representative
   value with every special class and a CRLF, exact escaped string;
8. `has bounded deterministic expansion` — the bound for every specially
   encoded character, mixed and repeated worst-case input, identical repeat
   calls;
9. `preserves non-ASCII text unchanged`;
10. `leaves ordinary values unchanged`;
11. `handles the empty string`.

## Not connected to the action

`src/summary-markdown.ts` is not imported by `src/action.ts`,
`src/action-runner.ts`, `src/action-outputs.ts`, the CLI, or any other
production module. M18 writes no job summary and changes no CLI text or JSON,
annotation, action output, action input or exit behavior. The checked-in
`action-dist/index.cjs` is unchanged because the utility is outside the action
execution path, and the existing M17 v0.3 surface-regression tests remain
byte-for-byte unchanged.
