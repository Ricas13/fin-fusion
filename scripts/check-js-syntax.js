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

function ghaEscape(value) {
    return String(value || '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

const files = walk(ROOT).sort();
let failed = 0;
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        failed += 1;
        const relative = path.relative(ROOT,file).replace(/\\/g,'/');
        const detail = String(result.stderr || result.stdout || 'Node syntax check failed').trim();
        process.stderr.write(`\nSyntax failure: ${relative}\n${detail}\n`);
        if (process.env.GITHUB_ACTIONS === 'true') {
            process.stdout.write(`::error file=${ghaEscape(relative)},title=JavaScript syntax failure::${ghaEscape(detail.slice(0,3000))}\n`);
        }
    }
}
console.log(`Checked ${files.length} JavaScript files; failures=${failed}`);
if (failed) process.exitCode = 1;
