#!/usr/bin/env node
'use strict';
/**
 * seed-real.js — CLI: fill the demo with authentic-format log lines instead of invented ones.
 *   node scripts/seed-real.js [count]      default 1200
 */
require('../lib/env');
const { seedReal } = require('../lib/seed-real');

const count = Number(process.argv[2] || 1200);
const n = seedReal(count, { log: (m) => process.stderr.write(m + '\n') });
console.log(`seeded ${n} entries from real parsed samples`);
