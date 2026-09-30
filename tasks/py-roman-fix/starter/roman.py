VALUES = [(1000, "M"), (500, "D"), (100, "C"), (50, "L"), (10, "X"), (5, "V"), (1, "I")]


def to_roman(n):
    out = ""
    for value, sym in VALUES:
        while n >= value:
            out += sym
            n -= value
    return out


def from_roman(s):
    lookup = {sym: value for value, sym in VALUES}
    return sum(lookup[c] for c in s)
