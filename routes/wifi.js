const express = require('express');
const router = express.Router();
const db = require('../db');

function auth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Connexion requise' });
  next();
}

function computeScore(wifiId) {
  const verifs = db.prepare(`SELECT status, created_at FROM verifications WHERE wifi_id = ? ORDER BY created_at DESC`).all(wifiId);
  if (!verifs.length) return 50;
  const now = Date.now();
  const works = verifs.filter(v => v.status === 'works' || v.status === 'connected').length;
  const broken = verifs.filter(v => v.status === 'broken').length;
  const total = works + broken;
  let score = (works / total) * 100;
  const lastVerif = verifs[0];
  const daysAgo = (now - new Date(lastVerif.created_at).getTime()) / 86400000;
  const decay = Math.max(0, 1 - daysAgo / 180);
  if (lastVerif.status === 'broken') score = Math.max(0, score - 20 * decay);
  return Math.min(100, Math.max(0, score)).toFixed(1);
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function addPoints(userId, pts) {
  db.prepare(`UPDATE users SET points = points + ?, level = MIN(100, CAST(1 + SQRT(points / 10.0) AS INT)) WHERE id = ?`).run(pts, userId);
  const user = db.prepare(`SELECT points, level FROM users WHERE id = ?`).get(userId);
  return user;
}

router.get('/add', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  res.render('wifi-detail', {
    wifi: null, votes: [], history: [], comments: [], stats: {},
    addLat: req.query.lat || '', addLng: req.query.lng || ''
  });
});

router.get('/:id/json', (req, res) => {
  const wifi = db.prepare(`SELECT w.*, u.username as author_name FROM wifi_points w LEFT JOIN users u ON w.author_id = u.id WHERE w.id = ?`).get(req.params.id);
  if (!wifi) return res.status(404).json({ error: 'Introuvable' });
  const comments = db.prepare(`SELECT c.content, c.created_at, u.username FROM comments c JOIN users u ON c.user_id = u.id WHERE wifi_id = ? ORDER BY c.created_at DESC`).all(wifi.id);
  const history = db.prepare(`SELECT h.action, h.snapshot, h.created_at, u.username FROM wifi_history h JOIN users u ON h.user_id = u.id WHERE wifi_id = ? ORDER BY h.created_at DESC LIMIT 20`).all(wifi.id);
  const verif_stats = db.prepare(`SELECT status, COUNT(*) as count FROM verifications WHERE wifi_id = ? GROUP BY status`).all(wifi.id);
  const works = verif_stats.find(v => v.status === 'works')?.count || 0;
  const broken = verif_stats.find(v => v.status === 'broken')?.count || 0;
  const votes = db.prepare(`SELECT download_mbps, upload_mbps, ping_ms FROM votes WHERE wifi_id = ?`).all(wifi.id);
  const avgDown = votes.filter(v => v.download_mbps).map(v => v.download_mbps);
  const avgUp = votes.filter(v => v.upload_mbps).map(v => v.upload_mbps);
  const avgPing = votes.filter(v => v.ping_ms).map(v => v.ping_ms);
  res.json({
    wifi,
    comments,
    history,
    stats: {
      works, broken,
      avg_download: avgDown.length ? (avgDown.reduce((a,b)=>a+b,0)/avgDown.length).toFixed(1) : null,
      avg_upload: avgUp.length ? (avgUp.reduce((a,b)=>a+b,0)/avgUp.length).toFixed(1) : null,
      avg_ping: avgPing.length ? (avgPing.reduce((a,b)=>a+b,0)/avgPing.length).toFixed(0) : null,
    }
  });
});

router.get('/:id', (req, res) => {
  const accept = req.headers.accept || '';
  const isDesktop = !/(Mobile|Android|iPhone|iPad)/i.test(req.headers['user-agent'] || '');
  if (isDesktop && accept.includes('text/html')) {
    return res.render('index');
  }
  const wifi = db.prepare(`SELECT w.*, u.username as author_name FROM wifi_points w LEFT JOIN users u ON w.author_id = u.id WHERE w.id = ?`).get(req.params.id);
  if (!wifi) return res.status(404).send('Réseau introuvable');
  const votes = db.prepare(`SELECT type, download_mbps, upload_mbps, ping_ms, reason, comment, u.username, votes.created_at FROM votes JOIN users u ON votes.user_id = u.id WHERE wifi_id = ? ORDER BY votes.created_at DESC`).all(wifi.id);
  const history = db.prepare(`SELECT h.action, h.snapshot, h.created_at, u.username FROM wifi_history h JOIN users u ON h.user_id = u.id WHERE wifi_id = ? ORDER BY h.created_at DESC LIMIT 20`).all(wifi.id);
  const comments = db.prepare(`SELECT c.content, c.created_at, u.username FROM comments c JOIN users u ON c.user_id = u.id WHERE wifi_id = ? ORDER BY c.created_at DESC`).all(wifi.id);
  const verif_stats = db.prepare(`SELECT status, COUNT(*) as count FROM verifications WHERE wifi_id = ? GROUP BY status`).all(wifi.id);
  const works = verif_stats.find(v => v.status === 'works')?.count || 0;
  const broken = verif_stats.find(v => v.status === 'broken')?.count || 0;
  const avgDown = votes.filter(v => v.download_mbps).map(v => v.download_mbps);
  const avgUp = votes.filter(v => v.upload_mbps).map(v => v.upload_mbps);
  const avgPing = votes.filter(v => v.ping_ms).map(v => v.ping_ms);
  const stats = {
    works, broken,
    avg_download: avgDown.length ? (avgDown.reduce((a, b) => a + b, 0) / avgDown.length).toFixed(1) : null,
    avg_upload: avgUp.length ? (avgUp.reduce((a, b) => a + b, 0) / avgUp.length).toFixed(1) : null,
    avg_ping: avgPing.length ? (avgPing.reduce((a, b) => a + b, 0) / avgPing.length).toFixed(0) : null,
  };
  res.render('wifi-detail', { wifi, votes, history, comments, stats });
});

router.post('/add', auth, (req, res) => {
  const { ssid, password, encryption, captive_portal, gateway, dhcp_range, download_mbps, upload_mbps, ping_ms, isp, place_type, hours, lat, lng, force } = req.body;
  if (!ssid || !encryption || !lat || !lng) return res.status(400).json({ error: 'Champs obligatoires manquants' });

  if (!force) {
    const nearby = db.prepare(`SELECT id, ssid, lat, lng FROM wifi_points WHERE LOWER(ssid) = LOWER(?)`).all(ssid);
    const duplicate = nearby.find(w => haversineMeters(parseFloat(lat), parseFloat(lng), w.lat, w.lng) < 100);
    if (duplicate) return res.status(409).json({ duplicate: { id: duplicate.id, ssid: duplicate.ssid } });
  }

  const result = db.prepare(`INSERT INTO wifi_points (ssid, password, encryption, captive_portal, gateway, dhcp_range, download_mbps, upload_mbps, ping_ms, isp, place_type, hours, lat, lng, author_id, last_verified) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .run(ssid, password || null, encryption, captive_portal === 'on' ? 1 : 0, gateway || null, dhcp_range || null, download_mbps || null, upload_mbps || null, ping_ms || null, isp || null, place_type || null, hours || null, parseFloat(lat), parseFloat(lng), req.session.user.id);
  db.prepare(`INSERT INTO wifi_history (wifi_id, user_id, action, snapshot) VALUES (?,?,?,?)`).run(result.lastInsertRowid, req.session.user.id, 'Réseau ajouté', JSON.stringify(req.body));
  const updated = addPoints(req.session.user.id, 10);
  req.session.user.points = updated.points;
  req.session.user.level = updated.level;
  res.json({ id: result.lastInsertRowid });
});

router.post('/:id/edit', auth, (req, res) => {
  const wifi = db.prepare(`SELECT * FROM wifi_points WHERE id = ?`).get(req.params.id);
  if (!wifi) return res.status(404).json({ error: 'Introuvable' });
  const { ssid, password, encryption, captive_portal, gateway, dhcp_range, download_mbps, upload_mbps, ping_ms, isp, place_type, hours, lat, lng } = req.body;
  db.prepare(`UPDATE wifi_points SET ssid=?, password=?, encryption=?, captive_portal=?, gateway=?, dhcp_range=?, download_mbps=?, upload_mbps=?, ping_ms=?, isp=?, place_type=?, hours=?, lat=?, lng=? WHERE id=?`)
    .run(ssid, password || null, encryption, (captive_portal === 'on' || captive_portal === '1') ? 1 : 0, gateway || null, dhcp_range || null, download_mbps || null, upload_mbps || null, ping_ms || null, isp || null, place_type || null, hours || null, parseFloat(lat) || wifi.lat, parseFloat(lng) || wifi.lng, wifi.id);
  db.prepare(`INSERT INTO wifi_history (wifi_id, user_id, action, snapshot) VALUES (?,?,?,?)`).run(wifi.id, req.session.user.id, 'Informations modifiées', JSON.stringify({ before: wifi, after: req.body }));
  const score = computeScore(wifi.id);
  db.prepare(`UPDATE wifi_points SET confidence_score = ? WHERE id = ?`).run(score, wifi.id);
  const updated = addPoints(req.session.user.id, 5);
  req.session.user.points = updated.points;
  req.session.user.level = updated.level;
  res.json({ ok: true });
});

router.post('/:id/verify', auth, (req, res) => {
  const { status } = req.body;
  if (!['works', 'broken'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  const last = db.prepare(`SELECT created_at FROM verifications WHERE wifi_id = ? AND user_id = ? AND status != 'connected' ORDER BY created_at DESC LIMIT 1`).get(req.params.id, req.session.user.id);
  if (last) {
    const hoursSince = (Date.now() - new Date(last.created_at + 'Z').getTime()) / 3600000;
    if (hoursSince < 24) return res.status(429).json({ error: 'Cooldown 24h', remaining: Math.ceil(24 - hoursSince) });
  }
  db.prepare(`INSERT INTO verifications (wifi_id, user_id, status) VALUES (?,?,?)`).run(req.params.id, req.session.user.id, status);
  db.prepare(`UPDATE wifi_points SET last_verified = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  const score = computeScore(req.params.id);
  db.prepare(`UPDATE wifi_points SET confidence_score = ? WHERE id = ?`).run(score, req.params.id);
  db.prepare(`INSERT INTO wifi_history (wifi_id, user_id, action, snapshot) VALUES (?,?,?,?)`).run(req.params.id, req.session.user.id, status === 'works' ? '✅ Fonctionne' : '❌ Ne fonctionne plus', '{}');
  const updated = addPoints(req.session.user.id, 3);
  req.session.user.points = updated.points;
  req.session.user.level = updated.level;
  res.json({ ok: true, score });
});

router.post('/:id/comment', auth, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length < 2) return res.status(400).json({ error: 'Commentaire trop court' });
  const last = db.prepare(`SELECT created_at FROM comments WHERE wifi_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`).get(req.params.id, req.session.user.id);
  if (last) {
    const minSince = (Date.now() - new Date(last.created_at + 'Z').getTime()) / 60000;
    if (minSince < 5) return res.status(429).json({ error: 'Cooldown', remaining: Math.ceil(5 - minSince) });
  }
  db.prepare(`INSERT INTO comments (wifi_id, user_id, content) VALUES (?,?,?)`).run(req.params.id, req.session.user.id, content.trim());
  res.json({ ok: true });
});

router.get('/:id/history', (req, res) => {
  const history = db.prepare(`SELECT h.action, h.snapshot, h.created_at, u.username FROM wifi_history h JOIN users u ON h.user_id = u.id WHERE wifi_id = ? ORDER BY h.created_at DESC`).all(req.params.id);
  res.json(history);
});

module.exports = router;
