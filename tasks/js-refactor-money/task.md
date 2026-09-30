# Extract src/money.js

`src/cart.js` and `src/invoice.js` each carry their own copy of the same
money logic: converting dollars to cents, adding tax, and formatting cents as
US dollars. Refactor it:

1. Create `src/money.js` (CommonJS) exporting:
   - `toCents(amount)`: dollars to integer cents, rounded to the nearest cent;
   - `applyTax(cents, ratePct)`: `cents` plus the tax, the tax rounded to a
     whole cent;
   - `formatUSD(cents)`: e.g. `"$1,234.56"`, `"$0.05"`, `"-$3.10"`. Use
     thousands separators.
2. Make `src/cart.js` and `src/invoice.js` use `require("./money")`, and
   delete their inline copies. They must not call `Math.round` or
   `padStart` themselves any more.
3. The public behaviour of `cartTotal` and `invoiceLines` must not change,
   except that amounts of $1,000 or more now get thousands separators.
   `node test/run.js` must keep passing.
