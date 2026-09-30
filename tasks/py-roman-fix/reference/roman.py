PAIRS = [
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
    (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
    (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
]
SYMBOLS = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}


def to_roman(n):
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 3999:
        raise ValueError(f"cannot convert {n!r}")
    out = []
    for value, sym in PAIRS:
        count, n = divmod(n, value)
        out.append(sym * count)
    return "".join(out)


def from_roman(s):
    if not isinstance(s, str) or s == "":
        raise ValueError("empty numeral")
    s = s.upper()
    total = 0
    for i, c in enumerate(s):
        if c not in SYMBOLS:
            raise ValueError(f"bad numeral character {c!r}")
        v = SYMBOLS[c]
        if i + 1 < len(s) and s[i + 1] in SYMBOLS and SYMBOLS[s[i + 1]] > v:
            total -= v
        else:
            total += v
    return total
