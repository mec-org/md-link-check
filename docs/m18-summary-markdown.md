# M18 — Summary values and Markdown escaping

Base: `bedfcde1e6b080645094a87d7d0c7b8f0d7bcd4c` (M17, #46). Hardened after
M18 merged in `c20c394` (#48); the follow-up changes below are on top of that.

M18 adds one internal, pure utility that escapes a single untrusted value so a
later milestone can place it inside one inline Markdown summary entry. The
escaped value is for file names, link targets and failure reasons. M18 does not
wire the utility into the GitHub Action and writes no job summary; M19 is
expected to pass every value through it, and M20 writes the summary.

## Module and export

`src/summary-markdown.ts` exports:

- `escapeSummaryValue(value: string): string` — escapes one value;
- `SUMMARY_VALUE_MAX_EXPANSION` — the documented expansion bound (`6`).

The module has no runtime imports, reads no environment, performs no I/O and
adds no runtime dependency. It iterates the input by Unicode code point, so
surrogate pairs and other non-ASCII text are never split or rewritten.

## Encoding rules

One input code point produces one output; the table shows both the escaped
source and what a reader sees after GitHub renders the summary as GFM.

```text
input               raw output     rendered text
\                   \\\\           \\
`                   \`             `
|                   \|             |
*                   \*             *
_                   \_             _
[                   \[             [
]                   \]             ]
<                   &lt;           <
>                   &gt;           >
&                   &amp;          &
#                   \#             #
~                   \~             ~
-                   \-             -
+                   \+             +
:                   \:             :
=                   \=             =
$                   \u0024         \u0024   (visible code; see math note)
4+ leading spaces   &#32; each     spaces
www.                www\.          www.
1. / 1) marker      1\. / 1\)      1. / 1)
LF                  \n             \n   (two visible characters)
CR                  \r             \r   (two visible characters)
TAB                 \t             \t   (two visible characters)
other C0 / DEL      \uXXXX         \uXXXX
anything else       unchanged      unchanged
```

Notes:

- **Rendered backslash distinction.** A literal backslash is written as four
  backslashes, which GFM renders as two visible backslashes. That is what keeps
  literal escape-like text distinguishable from an encoded control *in the
  rendered summary*: literal input `\n` renders as `\\n` (two backslashes and
  `n`), while an actual LF renders as `\n` (one backslash and `n`). Doubling
  only the source backslash would render both as `\n` and defeat the
  representation.
- **Strikethrough and emphasis.** `~` is escaped so `~~text~~` cannot become
  strikethrough; `*` and `_` are escaped so they cannot emphasise. All three
  render back as themselves.
- **Extended autolinks.** `:` is escaped, which breaks the `http://` and
  `https://` source patterns that GFM would auto-link, and the dot of `www.` is
  escaped wherever it follows `www` (case-insensitively). Both render back as
  the original visible text.
- **Setext headings and thematic breaks.** `=` is escaped so `===` cannot turn
  the preceding line into a setext heading; `-`, `*` and `_` are already
  escaped, so no thematic break or list item can form.
- **Math.** GitHub resolves backslash escapes and character references before
  it detects math: `\$a\$`, `&#36;a&#36;` and `&dollar;a&dollar;` all still
  become `$a$` math (verified with GitHub's Markdown API), and inserting an
  entity between the dollar signs does not prevent it. A `$` is therefore
  written as the visible `\u0024` code, like a control character, so no raw
  dollar sign can form `$...$` or `$$...$$`. This is the second visible-code
  exception, alongside the covered control characters.
- **Indented code.** Four or more leading spaces would make an indented code
  block at the start of a Markdown line, so each of them is written as `&#32;`.
  The raw line then starts with `&` and the rendered text keeps the spaces; one
  to three leading spaces cannot start an indented code block and are kept as
  spaces.
- **Block structure.** The output has no raw line break, so a value cannot
  introduce a new line or paragraph. `>` becomes `&gt;`, `#` is escaped
  anywhere, backticks and pipes are escaped, `-` and `+` are escaped, and an
  ordered-list marker at the start of the value (up to three leading spaces,
  1–9 digits, then `.` or `)` and whitespace) has that punctuation escaped;
  `1.2` and a marker away from the start are ordinary text.
- **Angle brackets and ampersand.** `<` and `>` become `&lt;` and `&gt;`, so
  they cannot open raw HTML or an autolink. `&` becomes `&amp;`, so input such
  as `&lt;` stays the four literal characters it was instead of rendering as
  `<`; entity-like text cannot collide with an encoded bracket.
- **Line breaks and controls.** LF, CR and TAB have the visible sequences
  above; U+0000–U+001F not covered by those and U+007F use the fixed-width
  `\uXXXX` form. No raw line break or covered control remains.
- **Everything else** — ordinary text and all non-ASCII characters — is
  emitted unchanged. Nothing is deleted, trimmed, collapsed, reordered or
  truncated.
- **Empty input** maps to the empty string.

### Note for M19

Escaped values are intended for ordinary inline Markdown and table cells, as
the packet states. Do not place an escaped value inside a code span or fenced
code block: backslash escapes and character references are not interpreted
there, so the representation would be displayed literally. A literal backslash
renders as two backslashes and `$` renders as `\u0024`; both are deliberate
visible representations, not missing input.

### Known limitation

GitHub's GFM renderer turns a bare email address such as `user@example.com`
into a `mailto:` link. Backslash-escaping the `@` or writing it as a character
reference still renders `@`, and GitHub still auto-links the rendered text
(checked against GitHub's Markdown API), so preventing that link would require
changing the visible value, which M18 forbids. M18 therefore covers the
required bracket links, the `http://`, `https://` and `www.` autolinks, and
math; bare-email links remain a documented limitation of rendering-driven GFM.

## Guarantees

- **One physical line.** The output contains no raw CR, LF, TAB, C0 control or
  DEL character.
- **Meaning and order.** Every input character remains represented, in order,
  by itself or by its documented encoding. Every escape except a literal
  backslash, `$` and the covered controls renders back to the character it
  replaced; a literal backslash renders as two visible backslashes, `$` and
  controls render as visible codes corresponding to the original characters.
- **Deterministic.** The same input always produces the same output.
- **Bounded.** Each input UTF-16 code unit produces at most
  `SUMMARY_VALUE_MAX_EXPANSION` (6) output UTF-16 code units, so
  `escapeSummaryValue(value).length <= 6 * value.length` for every string,
  including the empty string. The longest encodings are the six-code-unit
  `\uXXXX` forms used for controls and `$`, and the bound is tight for repeated
  U+0000 or `$`; leading spaces expand fivefold. The value is always escaped in
  full; M18 defines no truncation.

## Tests

`test/summary-markdown.test.ts` covers each required character class with
literal expected strings, plus an independent inline-text renderer that
resolves backslash escapes and character references the way CommonMark does
and a table-row splitter that follows escaped pipes:

1. `escapes Markdown structural punctuation` — backticks, pipes, asterisks,
   underscores, brackets and angle brackets;
2. `escapes an ampersand so entity-like text stays literal`;
3. `escapes a leading heading marker` — a leading `#` and a `#` away from the
   leading position;
4. `neutralises GFM strikethrough and extended autolinks` — `~~`, `http://`,
   `https://`, `www.`, and the rendered-text check;
5. `neutralises leading list and block markers` — `-`, `+`, `1.`, `1)`, three
   leading spaces, thematic break, block quote, heading, and non-marker cases;
6. `neutralises setext, math and indented-code markers` — `===`, `$a$`,
   `$$a$$`, four leading spaces, three leading spaces and rendered text;
7. `keeps an escaped value inside one Markdown table cell` — escaped pipe,
   escaped backslash and code span in a table row, cell count and rendered text;
8. `encodes line breaks as visible text on one line` — LF, CR and CRLF;
9. `encodes tabs and control characters without deletion` — TAB, U+0000, an
   interior C0 control, U+001F and U+007F;
10. `distinguishes literal escape-like text from encoded controls` — literal
    `\`, `\n`, `\r`, `\t`, `\u0000` and `\u0024` against the encoded controls
    and `$`, both raw and rendered;
11. `preserves mixed value meaning in one escaped entry` — one representative
    value with every special class and a CRLF, exact escaped and rendered text;
12. `has bounded deterministic expansion` — the bound for every specially
    encoded character, mixed and repeated worst-case input, identical repeat
    calls;
13. `preserves non-ASCII text unchanged`;
14. `leaves ordinary values unchanged`;
15. `renders escaped punctuation back to the visible source text`;
16. `handles the empty string`.

## Not connected to the action

`src/summary-markdown.ts` is not imported by `src/action.ts`,
`src/action-runner.ts`, `src/action-outputs.ts`, the CLI, or any other
production module. M18 writes no job summary and changes no CLI text or JSON,
annotation, action output, action input or exit behavior. The checked-in
`action-dist/index.cjs` is unchanged because the utility is outside the action
execution path, and the existing M17 v0.3 surface-regression tests remain
byte-for-byte unchanged.
