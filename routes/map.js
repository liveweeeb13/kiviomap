const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  res.render('index');
});

router.get('/leaderboard', (req, res) => {
  const topPoints = db.prepare(`SELECT username, points, level FROM users ORDER BY points DESC LIMIT 20`).all();
  const topNetworks = db.prepare(`SELECT u.username, COUNT(w.id) as count FROM wifi_points w JOIN users u ON w.author_id = u.id GROUP BY u.id ORDER BY count DESC LIMIT 10`).all();
  res.render('leaderboard', { topPoints, topNetworks });
});

router.get('/api/wifi', (req, res) => {
  const points = db.prepare(`SELECT w.*, u.username as author_name FROM wifi_points w LEFT JOIN users u ON w.author_id = u.id`).all();
  const features = points.map(p => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: p
  }));
  res.json({ type: 'FeatureCollection', features });
});

module.exports = router;
