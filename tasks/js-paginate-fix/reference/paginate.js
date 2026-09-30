"use strict";

function paginate(items, page, pageSize) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be an integer >= 1");
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be an integer >= 1");
  const start = (page - 1) * pageSize;
  const totalPages = Math.ceil(items.length / pageSize);
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
