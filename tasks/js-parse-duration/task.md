# parseDuration()

Implement `duration.js` (CommonJS, plain Node, no dependencies) exporting
`parseDuration(text)`, which returns a number of milliseconds.

- Input is one or more `<number><unit>` parts, e.g. `"1h30m"`, `"250ms"`,
  `"1.5s"`, `"2d"`. Parts may be separated by whitespace: `"1h 30m"`.
  Leading and trailing whitespace is allowed.
- Units: `ms`, `s`, `m`, `h`, `d`. Numbers are non-negative decimals
  (`1`, `0.5`, `1.25`).
- Anything else throws a `TypeError`: an empty string, a number without a
  unit (`"10"`), an unknown unit (`"5x"`), a unit without a number (`"h"`),
  a negative number, or a non-string argument.
- Round the result to the nearest integer millisecond.
