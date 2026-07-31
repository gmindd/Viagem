/**
 * Mensagens efémeras entre pedidos (padrão POST → redirect → GET).
 * Adiciona res.flash(type, message) e expõe a mensagem pendente em res.locals.flash.
 */
export function flash(req, res, next) {
  res.locals.flash = req.session?.flash ?? null;
  if (req.session?.flash) delete req.session.flash;

  res.flash = (type, message) => {
    req.session.flash = { type, message };
  };

  next();
}
