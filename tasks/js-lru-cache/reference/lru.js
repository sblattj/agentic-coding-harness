"use strict";

class LRUCache {
  #map = new Map();
  #capacity;

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be an integer >= 1");
    this.#capacity = capacity;
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key, value) {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#capacity) this.#map.delete(this.#map.keys().next().value);
    return this;
  }

  has(key) {
    return this.#map.has(key);
  }

  delete(key) {
    return this.#map.delete(key);
  }

  get size() {
    return this.#map.size;
  }
}

module.exports = { LRUCache };
