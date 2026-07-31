import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db } from '../lib/db.js';
import { requireGuest } from '../middleware/auth.js';
import { normalizeEmail, isValidEmail } from '../lib/helpers.js';
import { sendEmail, passwordResetEmail, emailIsConfigured } from '../lib/email.js';

export const router = express.Router();

const TOKEN_HOURS = 2;
const TOKEN_TTL_MS = TOKEN_HOURS * 60 * 60 * 1000;

const findUserByEmail = db.prepare('SELECT id, name, email FROM users WHERE email = ?');
const insertReset = db.prepare(
  'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
);
const findReset = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?');
const markUsed = db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?");
const invalidateUserTokens = db.prepare(
  "UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL"
);
const updatePassword = db.prepare(
  "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
);
const getUserById = db.prepare('SELECT id, name, email FROM users WHERE id = ?');
const prune = db.prepare('DELETE FROM password_resets WHERE expires_at < ?');

// Mais apertado que o login: pedir recuperações em massa é uma forma de
// incomodar terceiros e de gastar a quota de envio de emails.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Demasiados pedidos de recuperação. Tenta daqui a uma hora.'
});

/** Guarda-se o hash do token; o valor em claro só existe no email. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Pedir o link                                                        */
/* ------------------------------------------------------------------ */

router.get('/recuperar', requireGuest, (req, res) => {
  res.render('auth/forgot', {
    title: 'Recuperar palavra-passe',
    errors: [],
    values: {},
    sent: false,
    emailConfigured: emailIsConfigured()
  });
});

router.post('/recuperar', requireGuest, resetLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);

  if (!isValidEmail(email)) {
    return res.status(400).render('auth/forgot', {
      title: 'Recuperar palavra-passe',
      errors: ['O email não parece válido.'],
      values: { email },
      sent: false,
      emailConfigured: emailIsConfigured()
    });
  }

  prune.run(Date.now());
  const user = findUserByEmail.get(email);

  // Só se envia se a conta existir, mas a resposta é sempre a mesma:
  // dizer "não existe conta" revelaria quem está registado.
  if (user) {
    const token = crypto.randomBytes(32).toString('base64url');
    invalidateUserTokens.run(user.id);
    insertReset.run(user.id, hashToken(token), Date.now() + TOKEN_TTL_MS);

    const url = `${req.appBaseUrl}/recuperar/${token}`;
    const message = passwordResetEmail({
      name: user.name,
      url,
      appName: req.app.locals.appName,
      hours: TOKEN_HOURS
    });
    await sendEmail({ to: user.email, ...message });
  }

  return res.render('auth/forgot', {
    title: 'Recuperar palavra-passe',
    errors: [],
    values: { email },
    sent: true,
    emailConfigured: emailIsConfigured()
  });
});

/* ------------------------------------------------------------------ */
/* Definir a palavra-passe nova                                        */
/* ------------------------------------------------------------------ */

/** Valida o token do URL e devolve o registo, ou null se não servir. */
function usableReset(token) {
  const row = findReset.get(hashToken(String(token || '')));
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

router.get('/recuperar/:token', requireGuest, (req, res) => {
  if (!usableReset(req.params.token)) {
    return res.status(400).render('auth/reset-invalid', { title: 'Link expirado' });
  }
  return res.render('auth/reset', {
    title: 'Definir palavra-passe nova',
    errors: [],
    token: req.params.token
  });
});

router.post('/recuperar/:token', requireGuest, resetLimiter, async (req, res) => {
  const reset = usableReset(req.params.token);
  if (!reset) {
    return res.status(400).render('auth/reset-invalid', { title: 'Link expirado' });
  }

  const password = String(req.body.password ?? '');
  const confirm = String(req.body.password_confirm ?? '');
  const errors = [];

  if (password.length < 8) errors.push('A palavra-passe precisa de pelo menos 8 caracteres.');
  if (password !== confirm) errors.push('As palavras-passe não coincidem.');

  if (errors.length) {
    return res.status(400).render('auth/reset', {
      title: 'Definir palavra-passe nova',
      errors,
      token: req.params.token
    });
  }

  const hash = await bcrypt.hash(password, 12);
  const apply = db.transaction(() => {
    updatePassword.run(hash, reset.user_id);
    markUsed.run(reset.id);
    // Qualquer outro link pendente deixa de servir
    invalidateUserTokens.run(reset.user_id);
  });
  apply();

  const user = getUserById.get(reset.user_id);

  // Sessão nova, já autenticada: evita obrigar a escrever a palavra-passe
  // acabada de definir, e impede a reutilização da sessão anterior.
  return req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.id;
    req.session.flash = { type: 'success', message: 'Palavra-passe alterada. Bem-vindo(a) de volta!' };
    res.redirect('/painel');
  });
});
