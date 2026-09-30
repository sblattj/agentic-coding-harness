# merge()

Implement `intervals.py` with `merge(intervals)` (standard library only).

- `intervals` is an iterable of `(start, end)` pairs of numbers describing
  closed intervals, in any order.
- Return a new list of tuples, sorted by start. Overlapping intervals are
  merged, and so are touching ones: `(1, 3)` and `(3, 5)` become `(1, 5)`.
- Do not mutate the input.
- A pair with `start > end` raises `ValueError`.
- An empty input gives `[]`.
