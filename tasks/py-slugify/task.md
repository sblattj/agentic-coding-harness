# slugify()

Implement `slug.py` with `slugify(text, max_length=None)` (standard library
only):

- Fold accents to ASCII (`"Crème Brûlée"` → `"creme-brulee"`), then
  lowercase.
- Every run of characters that are not `a-z` or `0-9` becomes a single `-`.
  No leading or trailing `-`.
- If `max_length` is given and the slug is longer, cut it to at most
  `max_length` characters. Cut at a `-` boundary when there is one, so no
  word is split, and never end with `-`. If the first word alone is longer
  than `max_length`, hard-cut that word.
- Text with no usable characters gives `""`.
