'use strict';

const { expandedScript } = require('./run-check-suite');

const TAGS = Object.freeze({
  fast: Object.freeze(['check:fast']),
  db: Object.freeze(['check:db']),
  billing: Object.freeze(['check:fast:commerce-support', 'check:db:commerce']),
  access: Object.freeze([
    'check:fast:foundation',
    'check:fast:customer-access',
    'check:fast:service-access',
    'check:db:integrity',
    'check:db:access',
    'check:db:concurrency'
  ]),
  browser: Object.freeze(['check:fast:admin-ux', 'check:fast:dashboards', 'check:fast:operations']),
  security: Object.freeze(['check:fast:foundation'])
});

function normalizeTags(values = []) {
  const tags = [...new Set((Array.isArray(values) ? values : [values])
    .flatMap(value => String(value || '').split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean))];
  if (!tags.length) throw new Error(`Choose at least one check tag: ${Object.keys(TAGS).join(', ')}`);
  const unknown = tags.filter(tag => !TAGS[tag]);
  if (unknown.length) throw new Error(`Unknown check tag(s): ${unknown.join(', ')}. Available: ${Object.keys(TAGS).join(', ')}`);
  return tags;
}

function suitesForTags(values) {
  const tags = normalizeTags(values);
  return [...new Set(tags.flatMap(tag => TAGS[tag]))];
}

function commandsForTags(values, expand = expandedScript) {
  const suites = suitesForTags(values);
  const seen = new Set();
  const commands = [];
  for (const suite of suites) {
    for (const command of expand(suite)) {
      if (seen.has(command)) continue;
      seen.add(command);
      commands.push(command);
    }
  }
  return commands;
}

module.exports = { TAGS, normalizeTags, suitesForTags, commandsForTags };
