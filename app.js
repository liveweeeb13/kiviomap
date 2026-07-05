require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const axios = require('axios');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);

if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET manquant dans .env');

app.use(helmet({ contentSecurityPolicy: false }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.user = req.session.user || null;
  next();
});

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const token = req.get('x-csrf-token') || req.body?._csrf;
  if (!token || token !== req.session.csrfToken) {
    if (req.accepts('json')) return res.status(403).json({ error: 'Jeton CSRF invalide' });
    return res.status(403).send('Jeton CSRF invalide');
  }
  next();
});

app.use(async (req, res, next) => {
  if (!req.session.user) return next();
  const db = require('./db');
  const user = db.prepare('SELECT banned, session_version FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || user.banned) {
    req.session.destroy(() => {});
    return res.redirect('/auth/login');
  }
  const dbVersion = user.session_version ?? 0;
  const sessVersion = req.session.user.session_version ?? 0;
  if (dbVersion !== sessVersion) {
    req.session.destroy(() => {});
    return res.redirect('/auth/login');
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);
app.use('/auth/forgot', authLimiter);
app.use('/auth/resend-code', authLimiter);

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function adminAuth(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send('Accès refusé');
  next();
}

app.get('/admin/mail', adminAuth, (req, res) => {
  const db = require('./db');
  const users = db.prepare('SELECT id, username, email FROM users WHERE banned = 0 ORDER BY username').all();
  res.render('admin-mail', { users });
});

app.post('/admin/mail', adminAuth, async (req, res) => {
  const db = require('./db');
  const { recipients, subject, body } = req.body;
  const recipientList = Array.isArray(recipients) ? recipients : [recipients];

  let targets;
  if (recipientList.includes('__all__')) {
    targets = db.prepare('SELECT username, email FROM users WHERE banned = 0 AND email != \'\'').all();
  } else {
    const placeholders = recipientList.map(() => '?').join(',');
    targets = db.prepare(`SELECT username, email FROM users WHERE id IN (${placeholders})`).all(...recipientList);
  }

  const html = `<!DOCTYPE html>
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
            ${body.split('\n').map(line => line.trim() ? `<p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.7">${escapeHtml(line)}</p>` : '<br>').join('')}
            <hr style="border:none;border-top:1px solid #ebebeb;margin:24px 0">
            <p style="margin:0;font-size:13px;color:#999">L'équipe Kiviomap</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
  </html>`;

  let sent = 0;
  try {
    for (const target of targets) {
      await sendBrevoEmail({ to: target.email, subject, html });
      sent++;
    }
    const users = db.prepare('SELECT id, username, email FROM users WHERE banned = 0 ORDER BY username').all();
    res.render('admin-mail', { users, sent });
  } catch (e) {
    console.error('Erreur envoi mail custom:', e.response?.data || e.message);
    const users = db.prepare('SELECT id, username, email FROM users WHERE banned = 0 ORDER BY username').all();
    res.render('admin-mail', { users, error: e.message });
  }
});

app.get('/admin', adminAuth, (req, res) => {
  const db = require('./db');
  const users = db.prepare('SELECT id, username, email, points, level, role, banned FROM users ORDER BY id').all();
  const networks = db.prepare('SELECT id, ssid, lat, lng FROM wifi_points ORDER BY id').all();
  res.render('admin', { users, networks, success: req.query.success });
});

app.post('/admin/user/:id/ban', adminAuth, async (req, res) => {
  const db = require('./db');
  const user = db.prepare('SELECT username, email FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.redirect('/admin');
  db.prepare('UPDATE users SET banned = 1, session_version = session_version + 1 WHERE id = ?').run(req.params.id);
  try {
    await sendBrevoEmail({
      to: user.email,
      subject: 'Votre compte Kiviomap a été banni',
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
                    Ton compte Kiviomap a été définitivement banni.
                  </p>
                  <p style="margin:0 0 16px;font-size:15px;color:#444;line-height:1.7">
                    Cette décision est définitive.
                  </p>
                  <p style="margin:0 0 28px;font-size:15px;color:#444;line-height:1.7">
                    Cet email a été envoyé automatiquement.
                  </p>
                  <hr style="border:none;border-top:1px solid #ebebeb;margin:0 0 24px">
                  <p style="margin:0;font-size:13px;color:#999">L'équipe Kiviomap</p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `,
    });
  } catch (e) {
    console.error('Erreur envoi mail ban:', e.response?.data || e.message);
  }
  res.redirect('/admin?success=1');
});

app.post('/admin/user/:id/unban', adminAuth, async (req, res) => {
  const db = require('./db');
  const user = db.prepare('SELECT username, email FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.redirect('/admin');
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(req.params.id);
  try {
    await sendBrevoEmail({
      to: user.email,
      subject: 'Votre bannissement Kiviomap a été annulé',
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
                    Ton bannissement a été annulé. Tu peux de nouveau te connecter à ton compte Kiviomap.
                  </p>
                  <hr style="border:none;border-top:1px solid #ebebeb;margin:0 0 24px">
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
    console.error('Erreur envoi mail unban:', e.response?.data || e.message);
  }
  res.redirect('/admin?success=1');
});

app.post('/admin/network/:id/delete', adminAuth, (req, res) => {
  const db = require('./db');
  db.prepare('DELETE FROM verifications WHERE wifi_id = ?').run(req.params.id);
  db.prepare('DELETE FROM votes WHERE wifi_id = ?').run(req.params.id);
  db.prepare('DELETE FROM comments WHERE wifi_id = ?').run(req.params.id);
  db.prepare('DELETE FROM wifi_history WHERE wifi_id = ?').run(req.params.id);
  db.prepare('DELETE FROM wifi_points WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

app.post('/admin/user/:id', adminAuth, async (req, res) => {
  const db = require('./db');
  const bcrypt = require('bcrypt');
  const { username, email, password, points, role } = req.body;
  const parsedPoints = Math.max(0, Number.parseInt(points, 10) || 0);
  const level = Math.min(100, Math.trunc(1 + Math.sqrt(parsedPoints / 10)));
  if (password && password.trim()) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET username=?, email=?, password=?, points=?, level=?, role=?, session_version=session_version+1 WHERE id=?').run(username, email, hash, parsedPoints, level, role, req.params.id);
  } else {
    db.prepare('UPDATE users SET username=?, email=?, points=?, level=?, role=? WHERE id=?').run(username, email, parsedPoints, level, role, req.params.id);
  }
  if (req.session.user.id == req.params.id) {
    const updated = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    req.session.user.role = updated.role;
    req.session.user.points = updated.points;
    req.session.user.level = updated.level;
  }
  res.redirect('/admin?success=1');
});

app.get('/terms', (req, res) => res.render('terms'));
app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/legal', (req, res) => res.render('legal'));

app.use('/', require('./routes/map'));
app.use('/auth', require('./routes/auth'));
app.use('/account', require('./routes/account'));
app.use('/wifi', require('./routes/wifi'));

app.get('/faq/speedtest', (req, res) => {
  res.render('faq-speedtest');
});

app.get('/faq/ssid', (req, res) => {
  res.render('faq-ssid');
});

app.get('/faq/security', (req, res) => {
  res.render('faq-security');
});

app.get('/faq/password', (req, res) => {
  res.render('faq-password');
});

app.get('/faq/captiveportal', (req, res) => {
  res.render('faq-captiveportal');
});

app.get('/faq/isp', (req, res) => {
  res.render('faq-isp');
});

app.get('/faq/location', (req, res) => {
  res.render('faq-location');
});

app.get('/faq/hours', (req, res) => {
  res.render('faq-hours');
});

app.get('/faq/gateway', (req, res) => {
  res.render('faq-gateway');
});

app.get('/faq/coordinates', (req, res) => {
  res.render('faq-coordinates');
});

app.get('/faq/dhcp', (req, res) => {
  res.render('faq-dhcp');
});

// Speed test endpoints
app.get('/speedtest/download', (req, res) => {
  const size = 5 * 1024 * 1024; // 5MB
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', size);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.alloc(size));
});

app.post('/speedtest/upload', (req, res) => {
  res.json({ ok: true });
});

app.listen(2004, () => console.log('Kiviomap running on http://localhost:2004'));
