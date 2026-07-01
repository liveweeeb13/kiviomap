const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../db');

async function sendBrevoEmail({ to, subject, html }) {
  await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender: { email: process.env.FROM_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    },
    {
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, success: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.render('login', { error: 'Email ou mot de passe incorrect.', success: null });
  }
  if (user.banned) {
    return res.render('login', { error: 'Ce compte a été banni.', success: null });
  }
  req.session.user = { id: user.id, username: user.username, points: user.points, level: user.level, role: user.role, session_version: user.session_version };
  res.redirect('/');
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { error: null });
});

router.post('/register', async (req, res) => {
  const { username, email, password, confirm_password, accept_terms, accept_privacy } = req.body;
  if (!accept_terms) return res.render('register', { error: 'Tu dois accepter les conditions d\'utilisation.' });
  if (!accept_privacy) return res.render('register', { error: 'Tu dois accepter la politique de confidentialité.' });
  if (password !== confirm_password) return res.render('register', { error: 'Les mots de passe ne correspondent pas.' });
  if (password.length < 6) return res.render('register', { error: 'Mot de passe trop court (min. 6 caractères).' });
  if (username.includes(' ')) return res.render('register', { error: 'Le pseudo ne peut pas contenir d\'espaces.' });
  if (username.length > 16) return res.render('register', { error: 'Le pseudo ne peut pas dépasser 16 caractères.' });
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(username)) return res.render('register', { error: 'Le pseudo contient des caractères interdits.' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (existing) return res.render('register', { error: 'Email ou pseudo déjà utilisé.' });

  const hash = await bcrypt.hash(password, 10);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

  db.prepare('DELETE FROM email_verifications WHERE email = ?').run(email);
  db.prepare('INSERT INTO email_verifications (email, code, username, password, expires_at) VALUES (?, ?, ?, ?, ?)').run(email, code, username, hash, expires);

  try {
    await sendBrevoEmail({
      to: email,
      subject: 'Ton code de vérification Kiviomap',
      html: `
        <!DOCTYPE html>
        <html lang="fr">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#f4f4f4;font-family:'Segoe UI',Arial,sans-serif">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 16px">
            <tr><td align="center">
              <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
                <tr><td style="padding:32px 40px 24px">
                  <p style="margin:0;font-size:22px;font-weight:700;color:#1a1a1a">Kiviomap</p>
                </td></tr>
                <tr><td style="padding:0 40px 32px">
                  <p style="margin:0 0 20px;font-size:16px;color:#1a1a1a">Bonjour ${username},</p>
                  <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.7">Voici ton code de vérification pour finaliser ton inscription :</p>
                  <div style="text-align:center;margin:28px 0">
                    <span style="display:inline-block;background:#f5f0eb;border:2px solid #c87941;border-radius:10px;padding:18px 40px;font-size:36px;font-weight:800;letter-spacing:10px;color:#c87941">${code}</span>
                  </div>
                  <p style="margin:0 0 8px;font-size:13px;color:#999;text-align:center">Ce code est valable <strong>15 minutes</strong>.</p>
                  <hr style="border:none;border-top:1px solid #ebebeb;margin:24px 0">
                  <p style="margin:0;font-size:13px;color:#999">Si tu n'es pas à l'origine de cette inscription, ignore cet email.</p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `,
    });
  } catch (e) {
    console.error('Erreur envoi mail vérification:', e.response?.data || e.message);
    return res.render('register', { error: 'Erreur lors de l\'envoi du mail, réessaie.' });
  }

  db.prepare('UPDATE email_verifications SET last_sent_at = ? WHERE email = ?').run(new Date().toISOString(), email);
  req.session.pendingEmail = email;
  res.redirect('/auth/verify-email');
});

router.get('/verify-email', (req, res) => {
  if (req.session.user) return res.redirect('/');
  if (!req.session.pendingEmail) return res.redirect('/auth/register');
  const pending = db.prepare('SELECT last_sent_at FROM email_verifications WHERE email = ?').get(req.session.pendingEmail);
  const elapsed = pending?.last_sent_at ? Date.now() - new Date(pending.last_sent_at).getTime() : Infinity;
  const resendCooldown = elapsed < 60000 ? Math.ceil((60000 - elapsed) / 1000) : 0;
  res.render('verify-pending', { email: req.session.pendingEmail, error: null, resent: false, resendCooldown });
});

router.post('/verify-email', async (req, res) => {
  if (req.session.user) return res.redirect('/');
  const email = req.session.pendingEmail;
  if (!email) return res.redirect('/auth/register');

  const { code } = req.body;
  const pending = db.prepare('SELECT * FROM email_verifications WHERE email = ?').get(email);
  const elapsed = pending?.last_sent_at ? Date.now() - new Date(pending.last_sent_at).getTime() : Infinity;
  const resendCooldown = elapsed < 60000 ? Math.ceil((60000 - elapsed) / 1000) : 0;

  if (!pending) {
    return res.render('verify-pending', { email, error: 'Aucune inscription en attente pour cet email.', resent: false, resendCooldown });
  }
  if (new Date(pending.expires_at) < new Date()) {
    db.prepare('DELETE FROM email_verifications WHERE email = ?').run(email);
    req.session.pendingEmail = null;
    return res.render('register', { error: 'Le code a expiré, recommence l\'inscription.' });
  }
  if (pending.code !== code.trim()) {
    return res.render('verify-pending', { email, error: 'Code incorrect, réessaie.', resent: false, resendCooldown });
  }

  const result = db.prepare('INSERT INTO users (username, email, password, email_verified) VALUES (?, ?, ?, 1)').run(pending.username, email, pending.password);
  db.prepare('DELETE FROM email_verifications WHERE email = ?').run(email);
  req.session.pendingEmail = null;
  req.session.user = { id: result.lastInsertRowid, username: pending.username, points: 0, level: 1, role: 'member', session_version: 0 };
  res.redirect('/');
});

router.post('/resend-code', async (req, res) => {
  if (req.session.user) return res.redirect('/');
  const email = req.session.pendingEmail;
  if (!email) return res.redirect('/auth/register');

  const pending = db.prepare('SELECT * FROM email_verifications WHERE email = ?').get(email);
  if (!pending) return res.redirect('/auth/register');

  const lastSentAt = pending.last_sent_at ? new Date(pending.last_sent_at).getTime() : 0;
  const elapsed = Date.now() - lastSentAt;
  if (elapsed < 60000) {
    const wait = Math.ceil((60000 - elapsed) / 1000);
    return res.render('verify-pending', { email, error: null, resent: false, resendCooldown: wait });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('UPDATE email_verifications SET code = ?, expires_at = ?, last_sent_at = ? WHERE email = ?').run(code, expires, new Date().toISOString(), email);

  try {
    await sendBrevoEmail({
      to: email,
      subject: 'Ton nouveau code de vérification Kiviomap',
      html: `
        <!DOCTYPE html>
        <html lang="fr">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#f4f4f4;font-family:'Segoe UI',Arial,sans-serif">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 16px">
            <tr><td align="center">
              <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
                <tr><td style="padding:32px 40px 24px">
                  <p style="margin:0;font-size:22px;font-weight:700;color:#1a1a1a">Kiviomap</p>
                </td></tr>
                <tr><td style="padding:0 40px 32px">
                  <p style="margin:0 0 20px;font-size:16px;color:#1a1a1a">Bonjour ${pending.username},</p>
                  <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.7">Voici ton nouveau code de vérification :</p>
                  <div style="text-align:center;margin:28px 0">
                    <span style="display:inline-block;background:#f5f0eb;border:2px solid #c87941;border-radius:10px;padding:18px 40px;font-size:36px;font-weight:800;letter-spacing:10px;color:#c87941">${code}</span>
                  </div>
                  <p style="margin:0 0 8px;font-size:13px;color:#999;text-align:center">Ce code est valable <strong>15 minutes</strong>.</p>
                  <hr style="border:none;border-top:1px solid #ebebeb;margin:24px 0">
                  <p style="margin:0;font-size:13px;color:#999">Si tu n'es pas à l'origine de cette inscription, ignore cet email.</p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `,
    });
  } catch (e) {
    console.error('Erreur renvoi code:', e.response?.data || e.message);
    return res.render('verify-pending', { email, error: 'Erreur lors de l\'envoi, réessaie.', resent: false, resendCooldown: 60 });
  }

  res.render('verify-pending', { email, error: null, resent: true, resendCooldown: 60 });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/forgot', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('forgot', { error: null, success: null });
});

router.post('/forgot', async (req, res) => {
  const { email } = req.body;
  const user = db.prepare('SELECT id, username FROM users WHERE email = ?').get(email);
  // On renvoie toujours le meme message pour ne pas divulguer si l'email existe
  const ok = { error: null, success: 'Cliques sur le lien envoyé par email.' };
  if (!user) return res.render('forgot', ok);

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expires);

  const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/auth/reset/${token}`;

  try {
    await sendBrevoEmail({
      to: email,
      subject: 'Réinitialisation de ton mot de passe Kiviomap',
      html: `
        <!DOCTYPE html>
        <html lang="fr">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#f4f4f4;font-family:'Segoe UI',Arial,sans-serif">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 16px">
            <tr><td align="center">
              <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
                <tr><td style="padding:32px 40px 24px">
                  <p style="margin:0;font-size:22px;font-weight:700;color:#1a1a1a">Kiviomap</p>
                </td></tr>
                <tr><td style="padding:0 40px 32px">
                  <p style="margin:0 0 20px;font-size:16px;color:#1a1a1a">Bonjour ${user.username},</p>
                  <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.7">
                    On a reçu une demande de réinitialisation de mot de passe pour ton compte.
                  </p>
                  <p style="margin:0 0 24px;font-size:15px;color:#444;line-height:1.7">
                    Clique sur le bouton ci-dessous pour choisir un nouveau mot de passe. Ce lien est valable <strong>1 heure</strong>.
                  </p>
                  <a href="${resetUrl}" style="display:inline-block;background:#c87941;color:#1c1a17;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:700;font-size:15px">Réinitialiser mon mot de passe</a>
                  <p style="margin:24px 0 0;font-size:13px;color:#999">Si tu n'es pas à l'origine de cette demande, ignore cet email.</p>
                  <hr style="border:none;border-top:1px solid #ebebeb;margin:24px 0">
                  <p style="margin:0;font-size:13px;color:#999">Cet email a été envoyé automatiquement.</p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `,
    });
  } catch (e) {
    console.error('Erreur envoi mail reset:', e.response?.data || e.message);
  }

  res.render('forgot', ok);
});

router.get('/reset/:token', (req, res) => {
  const reset = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(req.params.token);
  if (!reset || new Date(reset.expires_at) < new Date()) {
    return res.render('forgot', { error: 'Ce lien est invalide ou a expiré.', success: null });
  }
  res.render('reset', { token: req.params.token, error: null });
});

router.post('/reset/:token', async (req, res) => {
  const { password, confirm_password } = req.body;
  const reset = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(req.params.token);
  if (!reset || new Date(reset.expires_at) < new Date()) {
    return res.render('forgot', { error: 'Ce lien est invalide ou a expiré.', success: null });
  }
  if (password !== confirm_password) return res.render('reset', { token: req.params.token, error: 'Les mots de passe ne correspondent pas.' });
  if (password.length < 6) return res.render('reset', { token: req.params.token, error: 'Mot de passe trop court (min. 6 caractères).' });

  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ?, session_version = session_version + 1 WHERE id = ?').run(hash, reset.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(reset.user_id);

  res.render('login', { error: null, success: 'Mot de passe mis à jour, tu peux te connecter.' });
});

module.exports = router;
