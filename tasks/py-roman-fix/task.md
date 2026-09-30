# Fix roman.py

`roman.py` has `to_roman(n)` and `from_roman(s)`. Both ignore subtractive
notation: `to_roman(4)` gives `"IIII"` and `from_roman("IX")` gives 11. Fix
both:

- `to_roman(n)`: an int from 1 to 3999 gives the standard numeral (`4` →
  `"IV"`, `1994` → `"MCMXCIV"`). Anything else (0, negative, 4000+, not an
  int, including `bool`) raises `ValueError`.
- `from_roman(s)`: accepts upper or lower case and returns the int. An empty
  string or any character outside `IVXLCDM` raises `ValueError`.
- `from_roman(to_roman(n)) == n` for every n in 1..3999.
