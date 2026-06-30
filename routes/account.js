const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db');

function authRequired(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  next();
}

router.get('/', authRequired, (req, res) => {
  res.render('account', {});
});

router.get('/settings', authRequired, (req, res) => {
  res.render('account-settings', { success: null, error: null });
});

router.post('/settings/username', authRequired, async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!await bcrypt.compare(password, user.password))
    return res.render('account-settings', { error: 'Mot de passe incorrect.', success: null });
  if (!username || username.includes(' ') || username.length > 16 || username.length < 3)
    return res.render('account-settings', { error: 'Pseudo invalide (3-16 caractères, sans espaces).', success: null });
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(username))
    return res.render('account-settings', { error: 'Le pseudo contient des caractères interdits.', success: null });
  const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, user.id);
  if (existing)
    return res.render('account-settings', { error: 'Ce pseudo est déjà pris.', success: null });
  db.prepare('UPDATE users SET username = ?, session_version = session_version + 1 WHERE id = ?').run(username, user.id);
  req.session.user.username = username;
  req.session.user.session_version = user.session_version + 1;
  res.render('account-settings', { success: 'Pseudo mis à jour.', error: null });
});

router.post('/settings/email', authRequired, async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!await bcrypt.compare(password, user.password))
    return res.render('account-settings', { error: 'Mot de passe incorrect.', success: null });
  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, user.id);
  if (existing)
    return res.render('account-settings', { error: 'Cet email est déjà utilisé.', success: null });
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, user.id);
  res.render('account-settings', { success: 'Email mis à jour.', error: null });
});

router.post('/settings/password', authRequired, async (req, res) => {
  const { old_password, new_password, confirm_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!await bcrypt.compare(old_password, user.password))
    return res.render('account-settings', { error: 'Mot de passe actuel incorrect.', success: null });
  if (new_password !== confirm_password)
    return res.render('account-settings', { error: 'Les nouveaux mots de passe ne correspondent pas.', success: null });
  if (new_password.length < 6)
    return res.render('account-settings', { error: 'Mot de passe trop court (min. 6 caractères).', success: null });
  const hash = await bcrypt.hash(new_password, 10);
  db.prepare('UPDATE users SET password = ?, session_version = session_version + 1 WHERE id = ?').run(hash, user.id);
  req.session.user.session_version = user.session_version + 1;
  res.render('account-settings', { success: 'Mot de passe mis à jour.', error: null });
});

router.get('/export/json', authRequired, (req, res) => {
  const id = req.session.user.id;
  const user = db.prepare('SELECT id, username, email, points, level, role, created_at FROM users WHERE id = ?').get(id);
  const wifi = db.prepare('SELECT * FROM wifi_points WHERE author_id = ?').all(id);
  const votes = db.prepare('SELECT * FROM votes WHERE user_id = ?').all(id);
  const comments = db.prepare('SELECT * FROM comments WHERE user_id = ?').all(id);
  res.setHeader('Content-Disposition', 'attachment; filename="mes-donnees.json"');
  res.json({ user, wifi, votes, comments });
});

router.get('/export/csv', authRequired, (req, res) => {
  const id = req.session.user.id;
  const user = db.prepare('SELECT id, username, email, points, level, role, created_at FROM users WHERE id = ?').get(id);
  const wifi = db.prepare('SELECT * FROM wifi_points WHERE author_id = ?').all(id);

  const toCSV = (rows) => {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]).join(',');
    const lines = rows.map(r => Object.values(r).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    return [headers, ...lines].join('\n');
  };

  const csv = ['=== COMPTE ===', toCSV([user]), '', '=== RESEAUX WIFI ===', toCSV(wifi)].join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="mes-donnees.csv"');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + csv);
});

router.post('/delete', authRequired, async (req, res) => {
  const { password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!await bcrypt.compare(password, user.password))
    return res.render('account-settings', { error: 'Mot de passe incorrect.', success: null });

  db.prepare(`UPDATE users SET username = 'Utilisateur supprimé', email = '', password = '', session_version = session_version + 1 WHERE id = ?`).run(user.id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM email_verifications WHERE email = ?').run(user.email);

  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
