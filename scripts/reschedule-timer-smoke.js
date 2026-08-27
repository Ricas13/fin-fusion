'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const retired=path.join(__dirname,'..','src','platform','reschedule-timer.js');
assert(!fs.existsSync(retired),'retired standalone reschedule timer must stay removed; live workers own their scheduling loops');
console.log('retired reschedule timer guard: ok');
