import crypto from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Protecção CSRF por token sincronizado na sessão.
 * O token é criado uma vez por sessão e injectado em todos os formulários.
 *
 * Envios multipart (upload de ficheiros) são a excepção: nessa altura o corpo
 * ainda não foi lido — quem o lê é o multer, mais à frente na cadeia — por isso
 * a verificação fica marcada como pendente e é feita logo a seguir ao parser.
 * Ver uploadWithCsrf(), que junta as duas coisas para não haver esquecimentos.
 */
export function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (SAFE_METHODS.has(req.method)) return next();

  if (req.is('multipart/form-data')) {
    req.csrfPending = true;
    return next();
  }

  return verify(req, res, next);
}

/**
 * Executa a verificação adiada de um pedido multipart.
 * Se por engano for chamada num pedido que já foi verificado, não faz nada.
 */
export function verifyPendingCsrf(req, res, next) {
  if (!req.csrfPending) return next();
  req.csrfPending = false;
  return verify(req, res, next);
}

/** Compara o token recebido com o da sessão e responde 403 se não bater certo. */
function verify(req, res, next) {
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
