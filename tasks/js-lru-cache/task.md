# LRU cache

Implement `lru.js` (CommonJS, plain Node, no dependencies) exporting a class
`LRUCache`:

```js
const { LRUCache } = require("./lru.js");
const c = new LRUCache(2); // capacity: integer >= 1, else throw RangeError
```

- `get(key)`: the value, or `undefined` if absent. A hit makes the key the
  most recently used.
- `set(key, value)`: insert or update. The key becomes the most recently
  used. If that pushes the size over capacity, evict the least recently used
  key. Returns the cache (chainable).
- `has(key)`: boolean. Does NOT change recency.
- `delete(key)`: boolean, true when something was removed.
- `size`: a getter with the current number of entries.
