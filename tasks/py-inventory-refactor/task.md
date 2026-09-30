# Refactor the inventory package

The `inventory/` package has `Store` (in `inventory/store.py`) and
`summary()` (in `inventory/report.py`). Refactor it, standard library only:

1. Rename `Store.calc()` to `Store.total_value()`.
2. Keep `Store.calc()` working as a deprecated alias. It must emit a
   `DeprecationWarning` and return the same value.
3. `report.summary()` duplicates the value computation. Make it call
   `store.total_value()` instead of reading prices and quantities itself.
4. Keep the output format of `summary()` unchanged. The existing tests
   (`python3 -m unittest discover -s tests`) must keep passing. Update them
   to use `total_value()`.
