const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  res.render('index');
});

router.get('/u/:id', (req, res) => {
  const profile = db.prepare('SELECT id, username, points, level, created_at FROM users WHERE id = ? AND banned = 0').get(req.params.id);
  if (!profile) return res.redirect('/');
  const wifiCount = db.prepare('SELECT COUNT(*) as c FROM wifi_points WHERE author_id = ?').get(profile.id).c;
  const verifCount = db.prepare('SELECT COUNT(*) as c FROM verifications WHERE user_id = ?').get(profile.id).c;
  const commentCount = db.prepare('SELECT COUNT(*) as c FROM comments WHERE user_id = ?').get(profile.id).c;
  const rawHistory = db.prepare(`
    SELECT h.action, h.snapshot, h.created_at, w.ssid, w.id as wifi_id
    FROM wifi_history h
    JOIN wifi_points w ON h.wifi_id = w.id
    WHERE h.user_id = ?
    ORDER BY h.created_at DESC
  `).all(profile.id);

  const diffFields = ['ssid','password','encryption','captive_portal','gateway','dhcp_range','isp','place_type','hours','download_mbps','upload_mbps','ping_ms'];
  function normVal(v) { return (v==='1'||v===1||v===true) ? true : (v===null||v===undefined||v==='') ? null : v; }
  function fmtVal(v) { return v===null ? '•' : v===true ? 'Oui' : v===false ? 'Non' : String(v); }

  const history = rawHistory.map(h => {
    let diffs = [];
    try {
      const snap = h.snapshot ? JSON.parse(h.snapshot) : null;
      if (snap && snap.before && snap.after) {
        diffs = diffFields.map(f => {
          const o = normVal(snap.before[f]), n = normVal(snap.after[f]);
          const ot = fmtVal(o), nt = fmtVal(n);
          if (ot === nt) return null;
          return { f, ot, nt, kind: o===null ? 'added' : n===null ? 'removed' : 'changed' };
        }).filter(Boolean);
      }
    } catch(e) {}
    return { ...h, diffs };
  });

  res.render('profile', { profile, wifiCount, verifCount, commentCount, history });
});

router.get('/leaderboard', (req, res) => {
  const topPoints = db.prepare(`SELECT id, username, points, level FROM users ORDER BY points DESC LIMIT 20`).all();
  const topNetworks = db.prepare(`SELECT u.id, u.username, COUNT(w.id) as count FROM wifi_points w JOIN users u ON w.author_id = u.id GROUP BY u.id ORDER BY count DESC LIMIT 10`).all();
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
