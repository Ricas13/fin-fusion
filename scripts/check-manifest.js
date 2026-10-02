'use strict';

const { expandedScript, suiteManifest } = require('./run-check-suite');

const TAGS = Object.freeze(Object.fromEntries(Object.entries(suiteManifest.tags || {})
  .map(([tag, suites]) => [tag, Object.freeze([...suites])])));

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
