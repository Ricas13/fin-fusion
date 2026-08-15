'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules','.git','backups']);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

const files = walk(ROOT).sort();
let failed = 0;
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        failed += 1;
        process.stderr.write(`\nSyntax failure: ${path.relative(ROOT,file)}\n${result.stderr || result.stdout}`);
    }
}
console.log(`Checked ${files.length} JavaScript files; failures=${failed}`);
if (failed) process.exitCode = 1;
