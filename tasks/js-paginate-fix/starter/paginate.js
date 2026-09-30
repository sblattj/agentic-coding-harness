"use strict";

function paginate(items, page, pageSize) {
  const start = page * pageSize;
  const totalPages = Math.floor(items.length / pageSize);
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalItems: items.length,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

module.exports = { paginate };
