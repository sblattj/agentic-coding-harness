# Fix getenv.sh

`getenv.sh FILE KEY` prints the value of KEY from a `.env`-style file. Users
report several bugs. Fix the script so that:

- Only lines of the form `KEY=value` (KEY at the very start of the line)
  match. Commented-out lines (`#KEY=...`) and other keys that merely end
  with KEY (`OTHER_KEY=...`) must not match.
- The value is everything after the FIRST `=`; values may contain `=`.
- If the whole value is wrapped in double quotes, strip that one pair only.
  Quotes inside the value are kept.
- If the key appears more than once, the LAST occurrence wins.
- If the key is absent, print nothing and exit 1.

Keep it POSIX sh.
