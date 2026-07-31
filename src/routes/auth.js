import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db } from '../lib/db.js';
import { requireGuest } from '../middleware/auth.js';
import { isValidEmail, normalizeEmail, cleanText } from '../lib/helpers.js';

export const router = express.Router();

const insertUser = db.prepare(
  `INSERT INTO users (email, password_hash, name, phone, contact_other)
   VALUES (@email, @password_hash, @name, @phone, @contact_other)`
);
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');

// Trava tentativas repetidas de login/registo a partir do mesmo IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Demasiadas tentativas. Espera uns minutos e tenta de novo.'
});

router.get('/registar', requireGuest, (req, res) => {
  res.render('auth/register', { title: 'Criar conta', errors: [], values: {} });
});

router.post('/registar', requireGuest, authLimiter, async (req, res) => {
  const values = {
    name: cleanText(req.body.name, 120),
    email: normalizeEmail(req.body.email),
    phone: cleanText(req.body.phone, 40),
    contact_other: cleanText(req.body.contact_other, 120)
  };
  const password = String(req.body.password ?? '');
  const passwordConfirm = String(req.body.password_confirm ?? '');
  const errors = [];

  if (values.name.length < 2) errors.push('Indica o teu nome.');
  if (!isValidEmail(values.email)) errors.push('O email não parece válido.');
  if (!values.phone && !values.contact_other) {
    errors.push('Indica pelo menos um contacto (telemóvel ou outro).');
  }
  if (password.length < 8) errors.push('A palavra-passe precisa de pelo menos 8 caracteres.');
  if (password !== passwordConfirm) errors.push('As palavras-passe não coincidem.');
  if (!errors.length && findByEmail.get(values.email)) {
    errors.push('Já existe uma conta com este email.');
  }

  if (errors.length) {
    return res.status(400).render('auth/register', { title: 'Criar conta', errors, values });
  }

  const password_hash = await bcrypt.hash(password, 12);
  const result = insertUser.run({ ...values, password_hash });

  // Regenera a sessão no login para evitar fixação de sessão
  return req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = result.lastInsertRowid;
    req.session.flash = { type: 'success', message: `Bem-vindo(a), ${values.name}!` };
    res.redirect('/painel');
  });
});

router.get('/entrar', requireGuest, (req, res) => {
  res.render('auth/login', { title: 'Entrar', errors: [], values: {} });
});

router.post('/entrar', requireGuest, authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password ?? '');
  const user = findByEmail.get(email);

  // Mensagem genérica: não revela se o email existe
  const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!ok) {
    return res.status(401).render('auth/login', {
      title: 'Entrar',
      errors: ['Email ou palavra-passe incorrectos.'],
      values: { email }
    });
  }

  const returnTo = req.session.returnTo;
  return req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.id;
    req.session.flash = { type: 'success', message: `Olá de novo, ${user.name}!` };
    res.redirect(safeReturnTo(returnTo));
  });
});

router.post('/sair', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('viagem.sid');
    res.redirect('/');
  });
});

/** Só aceita redireccionamentos internos, para evitar open redirect. */
function safeReturnTo(target) {
  if (typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')) {
    return target;
  }
  return '/painel';
}
