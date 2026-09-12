'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const candidates = [
  'customer-readability.css',
  'platform-shell.css',
  'playback-analytics.css',
  'customer-account-notifications.css',
];
const searchableExtensions = new Set(['.js','.ejs','.css','.json','.md','.yml','.yaml','.html','.sh','.txt']);
const ignoredDirectories = new Set(['.git','node_modules','.npm','coverage']);
const matches = new Map(candidates.map(name => [name, []]));

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (!searchableExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const relative = path.relative(root, absolute).replaceAll('\\', '/');
    let text;
    try { text = fs.readFileSync(absolute, 'utf8'); } catch (_) { continue; }
    for (const candidate of candidates) {
      if (relative === `public/css/${candidate}`) continue;
      if (!text.includes(candidate)) continue;
      text.split(/\r?\n/).forEach((line, index) => {
        if (line.includes(candidate)) matches.get(candidate).push(`${relative}:${index + 1}: ${line.trim()}`);
      });
    }
  }
}

walk(root);
for (const candidate of candidates) {
  const refs = matches.get(candidate);
  console.log(`\n=== ${candidate} (${refs.length} reference${refs.length === 1 ? '' : 's'}) ===`);
  if (!refs.length) console.log('NO REFERENCES FOUND');
  else refs.forEach(ref => console.log(ref));
}
