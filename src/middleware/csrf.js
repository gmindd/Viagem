import crypto from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Protecção CSRF por token sincronizado na sessão.
 * O token é criado uma vez por sessão e injectado em todos os formulários.
 */
export function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (SAFE_METHODS.has(req.method)) return next();

  const sent = req.body?._csrf || req.get('x-csrf-token') || '';
  if (!timingSafeEqual(sent, req.session.csrfToken)) {
    return res.status(403).render('error', {
      title: 'Pedido inválido',
      status: 403,
      message: 'O formulário expirou ou é inválido. Volta atrás e tenta de novo.'
    });
  }
  return next();
}

/** Comparação de strings resistente a ataques de temporização. */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
