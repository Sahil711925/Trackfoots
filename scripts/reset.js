'use strict';
/** reset.js — wipe the demo data and start clean. */
const fs = require('fs');
const path = require('path');
const data = path.join(__dirname, '..', 'data');
fs.rmSync(data, { recursive: true, force: true });
console.log('data wiped');
