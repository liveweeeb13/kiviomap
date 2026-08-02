const assert = require('assert');
const crypto = require('crypto');
const db = require('../db');

async function run() {
  await db.ready;

  const username = `uuidtest${Date.now()}`;
  const email = `${username}@example.com`;
  const userId = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, email, password) VALUES (?, ?, ?, ?)')
    .run(userId, username, email, 'secret');
  const userRow = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  assert.strictEqual(typeof userRow.id, 'string', 'user id should be a UUID string');
  assert.match(userRow.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'user id should be a valid UUID');

  const wifiId = crypto.randomUUID();
  const wifiResult = db.prepare(`INSERT INTO wifi_points (id, ssid, encryption, lat, lng, author_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(wifiId, `Test WiFi ${Date.now()}`, 'open', 48.8566, 2.3522, userRow.id);
  const wifiRow = db.prepare('SELECT id FROM wifi_points WHERE id = ?').get(wifiId);
  assert.strictEqual(typeof wifiRow.id, 'string', 'wifi id should be a UUID string');
  assert.match(wifiRow.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'wifi id should be a valid UUID');

  console.log('UUID regression test passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
