# Word frequency (POSIX sh)

Implement `wordfreq.sh` in the current directory.

Usage: `sh wordfreq.sh FILE N`

Print the N most frequent words in FILE, one per line, as `COUNT WORD`
(a single space between them, no leading spaces).

- A word is a maximal run of ASCII letters `a-z` / `A-Z`. Everything else
  (digits, punctuation, whitespace) separates words.
- Counting is case-insensitive; print words in lowercase.
- Order by count, highest first; break ties alphabetically (ascending).
- If there are fewer than N distinct words, print all of them.
- Use only POSIX sh and standard tools (tr, sort, uniq, awk, head, ...).
