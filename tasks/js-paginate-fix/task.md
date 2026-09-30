# Fix paginate()

`paginate.js` (CommonJS, plain Node, no dependencies) exports
`paginate(items, page, pageSize)`. Pages are 1-based. It should return:

```js
{ items, page, pageSize, totalItems, totalPages, hasPrev, hasNext }
```

- `items` is the slice for that page; a page past the end gives `[]`.
- `totalPages` is the number of pages needed (0 for an empty list).
- `hasPrev` is true when page > 1; `hasNext` is true when page < totalPages.
- `page` or `pageSize` that is not an integer >= 1 throws a `RangeError`.

The current code returns the wrong slice and the wrong page count. Fix it.
