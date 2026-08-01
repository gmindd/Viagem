import { canOpen } from '../lib/access.js';

/**
 * Guardas de acesso a uma viagem, para usar **rota a rota**.
 *
 * Deliberadamente não são aplicados com router.use(): montados assim,
 * correriam para todos os caminhos que atravessam o router, incluindo os que
 * pertencem a routers seguintes, e bloqueariam pedidos legítimos antes de
 * chegarem ao sítio certo. Cada rota declara o que exige.
 *
 * Todos assumem que loadEvent já correu e preencheu req.event, req.isOwner
 * e req.isMember.
 */

/** Barra viagens fechadas por palavra-passe a quem ainda não a acertou. */
export function requireOpen(req, res, next) {
  if (canOpen(req.event, req.user, req.session)) return next();
  return res.status(401).render('events/unlock', {
    title: req.event.title,
    event: req.event,
    errors: []
  });
}

/** Conteúdo reservado a quem faz parte da viagem. */
export function requireMember(req, res, next) {
  if (req.isMember) return next();
  res.flash('error', 'Precisas de fazer parte desta viagem para isso.');
  return res.redirect(`/e/${req.event.slug}`);
}

/**
 * Material e avisos: quem organiza e os moderadores.
 * Não cobre definições da viagem nem gestão de participantes — isso continua
 * a ser só de quem organiza.
 */
export function requireModerator(req, res, next) {
  if (req.isModerator) return next();
  return res.status(403).render('error', {
    title: 'Sem permissão',
    status: 403,
    message: 'Só quem organiza a viagem e os moderadores podem fazer isto.'
  });
}

/** Gestão da viagem: só quem a organiza. */
export function requireOwner(req, res, next) {
  if (req.isOwner) return next();
  return res.status(403).render('error', {
    title: 'Sem permissão',
    status: 403,
    message: 'Só quem organiza a viagem a pode gerir.'
  });
}
