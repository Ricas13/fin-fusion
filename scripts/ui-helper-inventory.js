'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const platformRoot = path.join(root, 'src', 'platform');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const categories = Object.freeze({
  htmlEscape: /function\s+(?:esc|escapeHtml|escapeHTML)\s*\(|const\s+(?:esc|escapeHtml|escapeHTML)\s*=/,
  csrfInput: /function\s+(?:csrfHidden|csrfInput|csrfField)\s*\(|const\s+(?:csrfHidden|csrfInput|csrfField)\s*=/,
  confirmation: /function\s+(?:parseConfirmation|confirmationMatches|requireConfirmation)\s*\(|const\s+(?:parseConfirmation|confirmationMatches|requireConfirmation)\s*=/,
  dateTime: /function\s+(?:fmtDate|formatDate|formatDateTime|dt)\s*\(|const\s+(?:fmtDate|formatDate|formatDateTime|dt)\s*=/,
  redirectNotice: /function\s+(?:redirectNotice|noticeRedirect|redirectWithNotice|redirectError)\s*\(|const\s+(?:redirectNotice|noticeRedirect|redirectWithNotice|redirectError)\s*=/,
  statusPill: /function\s+(?:pill|statusPill|toneForStatus)\s*\(|const\s+(?:pill|statusPill|toneForStatus)\s*=/,
  formUi: /function\s+(?:buttonForm|formRow|card|fieldRow)\s*\(|const\s+(?:buttonForm|formRow|card|fieldRow)\s*=/
});

const report = Object.fromEntries(Object.keys(categories).map(key => [key, []]));
for (const file of walk(platformRoot)) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  for (const [category, pattern] of Object.entries(categories)) {
    if (pattern.test(text)) report[category].push(rel);
  }
}

for (const files of Object.values(report)) files.sort();

console.log(JSON.stringify({
  canonical: {
    htmlEscapeAndCsrf: 'src/platform/html-primitives.js',
    checkboxForms: 'src/platform/admin-checkbox-form.js',
    money: 'src/platform/money-format.js'
  },
  candidates: report
}, null, 2));
