# CSV column sum

Implement `colsum.sh` in the current directory.

Usage: `sh colsum.sh FILE COLUMN`

FILE is a comma-separated file whose first line is a header. There is no
quoting or escaping. Print the sum of the numeric column named COLUMN,
formatted with exactly two decimals (for example `12.50`).

- Blank lines are ignored.
- If COLUMN is not in the header, print an error to stderr, print nothing on
  stdout, and exit with status 2.
- Use POSIX sh and standard tools (awk is fine).
