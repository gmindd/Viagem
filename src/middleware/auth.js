import { db } from '../lib/db.js';

const findUserById = db.prepare(
  'SELECT id, email, name, phone, contact_other, bio, created_at FROM users WHERE id = ?'
);

/**
 * Carrega o utilizador da sessão e disponibiliza-o em req.user e res.locals.user.
 * Se a sessão apontar para um utilizador apagado, limpa a sessão.
 */
export function loadUser(req, res, next) {
  res.locals.user = null;
  req.user = null;

  const userId = req.session?.userId;
  if (userId) {
    const user = findUserById.get(userId);
    if (user) {
      req.user = user;
      res.locals.user = user;
    } else {
      delete req.session.userId;
    }
  }
  next();
}

/** Bloqueia rotas privadas; guarda o destino para redireccionar após o login. */
export function requireAuth(req, res, next) {
  if (req.user) return next();

  if (req.method === 'GET') {
    req.session.returnTo = req.originalUrl;
  }
  req.session.flash = { type: 'error', message: 'Inicia sessão para continuares.' };
  return res.redirect('/entrar');
}

/** Impede que quem já tem sessão iniciada volte às páginas de registo/login. */
export function requireGuest(req, res, next) {
  if (req.user) return res.redirect('/painel');
  next();
}
