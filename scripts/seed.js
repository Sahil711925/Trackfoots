'use strict';
const { seed } = require('../lib/seed');
const n = Number(process.argv[2] || 1200);
console.log(`seeded ${seed(n)} entries -> data/logs.jsonl`);
