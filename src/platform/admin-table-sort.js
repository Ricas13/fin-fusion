'use strict';

const DIRECTIONS = new Set(['asc', 'desc']);

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalize(query, columns, defaultKey) {
  const keys = Object.keys(columns || {});
  if (!keys.length) throw new Error('At least one sortable column is required.');
  const fallback = own(columns, defaultKey) ? defaultKey : keys[0];
  const requestedKey = String(query?.sort || query?.key || '');
  const key = own(columns, requestedKey) ? requestedKey : fallback;
  const spec = columns[key] || {};
  const fallbackDirection = DIRECTIONS.has(spec.defaultDirection) ? spec.defaultDirection : 'asc';
  const requestedDirection = String(query?.dir || query?.direction || '').toLowerCase();
  const direction = DIRECTIONS.has(requestedDirection) ? requestedDirection : fallbackDirection;
  return { key, direction };
}

function orderBy(sort, columns, tieBreaker = '') {
  const spec = columns?.[sort?.key];
  if (!spec || !spec.expression) throw new Error('Unknown sortable column.');
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
  const nulls = spec.nulls === 'first' ? ' NULLS FIRST' : spec.nulls === 'last' ? ' NULLS LAST' : '';
  return `ORDER BY ${spec.expression} ${direction}${nulls}${tieBreaker ? `, ${tieBreaker}` : ''}`;
}

function nextDirection(sort, key, columns) {
  if (!own(columns, key)) throw new Error('Unknown sortable column.');
  if (sort?.key === key) return sort.direction === 'asc' ? 'desc' : 'asc';
  return columns[key].defaultDirection === 'desc' ? 'desc' : 'asc';
}

module.exports = { normalize, orderBy, nextDirection };
