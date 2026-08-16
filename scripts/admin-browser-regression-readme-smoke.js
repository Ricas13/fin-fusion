'use strict';
const fs=require('fs');const path=require('path');const assert=require('assert');
for(const file of ['docs/admin-product-audit.md','docs/admin-product-audit-findings.md','docs/admin-browser-regression.md','docs/admin-review-menu-rationale.md'])assert(fs.existsSync(path.join(__dirname,'..',file)),`${file} missing`);
console.log('admin browser regression documentation smoke: ok');
