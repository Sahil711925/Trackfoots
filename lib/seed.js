'use strict';
/** seed.js (lib) — reusable so the server can reseed during a demo. */
const store = require('./store');

const USERS = ['rahul', 'priya', 'arjun', 'sneha', 'vikram', 'meera', 'karthik', 'ananya', 'imran', 'divya'];
const ACTIONS = [
  'login success', 'login failed', 'logout',
  'GET /api/orders', 'POST /api/orders', 'GET /api/users',
  'UPDATE profile', 'DELETE /api/orders/1182',
  'sudo su', 'cat /etc/passwd', 'systemctl restart nginx',
  'db backup complete', 'firewall rule added',
];
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const IP = () => `103.${ri(1, 254)}.${ri(1, 254)}.${ri(1, 254)}`;

function seed(count = 1200) {
  store.ensure();
  const start = Date.now() - count * 40 * 1000;
  const batch = [];
  for (let i = 0; i < count; i++) {
    batch.push({
      ts: new Date(start + i * 40 * 1000).toISOString(),
      actor: USERS[ri(0, USERS.length - 1)],
      action: ACTIONS[ri(0, ACTIONS.length - 1)],
      meta: { ip: IP(), ua: 'Mozilla/5.0', session: ri(10000, 99999) },
    });
  }
  store.appendMany(batch);
  return count;
}

module.exports = { seed };
