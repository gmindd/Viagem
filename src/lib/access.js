import { db } from './db.js';

const findParticipation = db.prepare(
  'SELECT * FROM participants WHERE event_id = ? AND user_id = ?'
);
const findRequest = db.prepare(
  'SELECT * FROM join_requests WHERE event_id = ? AND user_id = ?'
);

/**
 * Modelo de acesso, em duas perguntas distintas:
 *
 *   1. Consegue ABRIR a página?  -> canOpen()
 *      Público e privado: qualquer pessoa. Secreto: só com o link (que já tem).
 *      Excepção: com palavra-passe, é preciso acertar antes de ver seja o que for.
 *
 *   2. É MEMBRO da viagem?       -> isMember()
 *      Só membros vêem ponto de encontro, percursos, mural, participantes e
 *      calendário. Quem não é membro vê apenas a ficha resumida e como entrar.
 *
 * O organizador é sempre as duas coisas.
 */

/** O utilizador criou este evento. */
export function isOwner(event, user) {
  return Boolean(user && event.owner_id === user.id);
}

/** Já faz parte da viagem (tem linha em participants). */
export function isMember(event, user) {
  if (!user) return false;
  if (isOwner(event, user)) return true;
  return Boolean(findParticipation.get(event.id, user.id));
}

/** A sessão acertou a palavra-passe deste evento. */
export function hasPasswordUnlock(session, event) {
  return Boolean(session?.eventAccess?.[event.slug]);
}

/** Guarda na sessão que esta pessoa acertou a palavra-passe. */
export function grantPasswordUnlock(session, event) {
  session.eventAccess = { ...(session.eventAccess ?? {}), [event.slug]: true };
}

/** A sessão entrou por um link de convite válido. */
export function hasInviteGrant(session, event) {
  return Boolean(session?.eventInvites?.[event.slug]);
}

/** Guarda na sessão que esta pessoa chegou por convite. */
export function grantInvite(session, event) {
  session.eventInvites = { ...(session.eventInvites ?? {}), [event.slug]: true };
}

/**
 * Pode abrir a página do evento?
 * A palavra-passe é uma porta: sem ela não se vê nada, como antes.
 */
export function canOpen(event, user, session) {
  if (isOwner(event, user)) return true;
  if (isMember(event, user)) return true;
  if (hasInviteGrant(session, event)) return true;

  if (event.join_policy === 'palavra_passe') {
    return hasPasswordUnlock(session, event);
  }
  return true;
}

/**
 * Estado do pedido de adesão desta pessoa, ou null se nunca pediu.
 * Serve para a página mostrar "pedido enviado" em vez do botão outra vez.
 */
export function joinRequestFor(event, user) {
  if (!user) return null;
  return findRequest.get(event.id, user.id) ?? null;
}

/**
 * O que é que esta pessoa pode fazer para entrar na viagem.
 * Devolve a acção a mostrar na interface.
 */
export function joinOptionFor(event, user, session) {
  if (isMember(event, user)) return 'ja_e_membro';
  if (!user) return 'precisa_conta';

  // Um convite aceite vale como entrada directa, independentemente da política
  if (hasInviteGrant(session, event)) return 'entrada_directa';

  switch (event.join_policy) {
    case 'aberto':
      return 'entrada_directa';
    case 'palavra_passe':
      return hasPasswordUnlock(session, event) ? 'entrada_directa' : 'precisa_palavra_passe';
    case 'pedido': {
      const request = joinRequestFor(event, user);
      if (request?.status === 'pendente') return 'pedido_pendente';
      if (request?.status === 'recusado') return 'pedido_recusado';
      return 'precisa_pedido';
    }
    default:
      return 'precisa_pedido';
  }
}

/** Aparece na listagem pública do site? */
export function isListed(event) {
  return event.visibility === 'publico' || event.visibility === 'privado';
}
