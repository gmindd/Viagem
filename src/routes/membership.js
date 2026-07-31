import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';
import { cleanText, toNumberOrNull } from '../lib/helpers.js';
import {
  isMember,
  grantPasswordUnlock,
  grantInvite,
  hasInviteGrant,
  hasPasswordUnlock,
  joinRequestFor
} from '../lib/access.js';
import { requireOwner } from '../middleware/event-guards.js';
import { sendEmail, joinRequestEmail, joinDecisionEmail } from '../lib/email.js';

/** Acções de quem quer entrar ou sair: qualquer utilizador com sessão. */
export const router = express.Router({ mergeParams: true });

/**
 * Acções de gestão da viagem: aprovar pedidos e emitir convites.
 * Router separado para ser montado atrás de requireOwner — se estivesse
 * junto ao anterior, bastaria ser membro para aprovar adesões.
 */
export const ownerRouter = express.Router({ mergeParams: true });

const addMember = db.prepare(
  `INSERT INTO participants (event_id, user_id, status, joined_via)
   VALUES (@event_id, @user_id, @status, @joined_via)
   ON CONFLICT(event_id, user_id) DO NOTHING`
);
const removeMember = db.prepare('DELETE FROM participants WHERE event_id = ? AND user_id = ?');

const upsertRequest = db.prepare(
  `INSERT INTO join_requests (event_id, user_id, message, status)
   VALUES (@event_id, @user_id, @message, 'pendente')
   ON CONFLICT(event_id, user_id)
   DO UPDATE SET message = @message, status = 'pendente', decided_at = NULL, decided_by = NULL`
);
const decideRequest = db.prepare(
  `UPDATE join_requests SET status = ?, decided_at = datetime('now'), decided_by = ?
   WHERE event_id = ? AND user_id = ?`
);
const findUser = db.prepare('SELECT id, name, email FROM users WHERE id = ?');
const findRequestById = db.prepare('SELECT * FROM join_requests WHERE id = ? AND event_id = ?');

export const listPendingRequests = db.prepare(
  `SELECT r.id, r.message, r.created_at, u.id AS user_id, u.name, u.email, u.phone, u.contact_other
   FROM join_requests r JOIN users u ON u.id = r.user_id
   WHERE r.event_id = ? AND r.status = 'pendente'
   ORDER BY r.created_at ASC`
);
export const countPendingRequests = db.prepare(
  "SELECT COUNT(*) AS n FROM join_requests WHERE event_id = ? AND status = 'pendente'"
);

const insertInvite = db.prepare(
  `INSERT INTO event_invites (event_id, token, label, max_uses, expires_at, created_by)
   VALUES (@event_id, @token, @label, @max_uses, @expires_at, @created_by)`
);
const findInvite = db.prepare('SELECT * FROM event_invites WHERE token = ?');
const useInvite = db.prepare('UPDATE event_invites SET uses = uses + 1 WHERE id = ?');
const deleteInvite = db.prepare('DELETE FROM event_invites WHERE id = ? AND event_id = ?');
export const listInvites = db.prepare(
  'SELECT * FROM event_invites WHERE event_id = ? ORDER BY created_at DESC'
);

/** Um convite só serve se não expirou e ainda tem utilizações. */
function inviteIsUsable(invite) {
  if (!invite) return false;
  if (invite.expires_at && invite.expires_at < new Date().toISOString().slice(0, 10)) return false;
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Entrar na viagem                                                    */
/* ------------------------------------------------------------------ */

router.post('/entrar', (req, res) => {
  const { event } = req;

  if (isMember(event, req.user)) {
    return res.redirect(`/e/${event.slug}`);
  }

  const allowed =
    event.join_policy === 'aberto' ||
    hasInviteGrant(req.session, event) ||
    (event.join_policy === 'palavra_passe' && hasPasswordUnlock(req.session, event));

  if (!allowed) {
    res.flash('error', 'Esta viagem não tem entrada livre.');
    return res.redirect(`/e/${event.slug}`);
  }

  addMember.run({
    event_id: event.id,
    user_id: req.user.id,
    status: event.phase === 'datas' ? 'maybe' : 'going',
    joined_via: hasInviteGrant(req.session, event) ? 'convite' : event.join_policy
  });

  res.flash('success', 'Já fazes parte desta viagem!');
  return res.redirect(`/e/${event.slug}`);
});

/** Sair da viagem por vontade própria. */
router.post('/sair', (req, res) => {
  removeMember.run(req.event.id, req.user.id);
  res.flash('success', 'Saíste desta viagem.');
  return res.redirect(`/e/${req.event.slug}`);
});

/* ------------------------------------------------------------------ */
/* Palavra-passe da viagem                                             */
/* ------------------------------------------------------------------ */

router.post('/acesso', async (req, res) => {
  const { event } = req;
  const password = String(req.body.event_password ?? '');
  const ok = event.access_password_hash
    ? await bcrypt.compare(password, event.access_password_hash)
    : false;

  if (!ok) {
    return res.status(401).render('events/unlock', {
      title: event.title,
      event,
      errors: ['Palavra-passe errada.']
    });
  }

  grantPasswordUnlock(req.session, event);

  // Com sessão iniciada, acertar a palavra-passe entra logo na viagem
  if (req.user && !isMember(event, req.user)) {
    addMember.run({
      event_id: event.id,
      user_id: req.user.id,
      status: event.phase === 'datas' ? 'maybe' : 'going',
      joined_via: 'palavra_passe'
    });
  }

  return res.redirect(`/e/${event.slug}`);
});

/* ------------------------------------------------------------------ */
/* Pedidos de adesão                                                   */
/* ------------------------------------------------------------------ */

router.post('/pedido', (req, res) => {
  const { event } = req;

  if (isMember(event, req.user)) return res.redirect(`/e/${event.slug}`);

  if (event.join_policy !== 'pedido') {
    res.flash('error', 'Esta viagem não aceita pedidos de adesão.');
    return res.redirect(`/e/${event.slug}`);
  }

  const existing = joinRequestFor(event, req.user);
  if (existing?.status === 'recusado') {
    res.flash('error', 'O teu pedido anterior foi recusado. Fala com quem organiza.');
    return res.redirect(`/e/${event.slug}`);
  }

  const message = cleanText(req.body.message, 300);
  upsertRequest.run({ event_id: event.id, user_id: req.user.id, message });

  // O email é um extra: se falhar, o pedido fica na mesma à espera na app
  const owner = findUser.get(event.owner_id);
  if (owner) {
    sendEmail({
      to: owner.email,
      ...joinRequestEmail({
        ownerName: owner.name,
        requesterName: req.user.name,
        requesterEmail: req.user.email,
        eventTitle: event.title,
        message,
        url: `${req.appBaseUrl}/pedidos`,
        appName: req.app.locals.appName
      })
    }).catch(() => {});
  }

  res.flash('success', 'Pedido enviado. Quem organiza vai receber-te na lista.');
  return res.redirect(`/e/${event.slug}`);
});

/**
 * Para onde voltar depois de decidir um pedido: a página central de pedidos
 * quando a decisão veio de lá, senão a própria viagem. Só aceita o valor
 * conhecido, para o campo do formulário não poder redireccionar para fora.
 */
function afterDecision(req) {
  return req.body.voltar === 'pedidos' ? '/pedidos' : `/e/${req.event.slug}#pedidos`;
}

/** Avisa por email quem pediu para entrar, assim que houver decisão. */
function notifyDecision(req, userId, accepted) {
  const person = findUser.get(userId);
  if (!person) return;
  sendEmail({
    to: person.email,
    ...joinDecisionEmail({
      name: person.name,
      eventTitle: req.event.title,
      accepted,
      url: `${req.appBaseUrl}/e/${req.event.slug}`,
      appName: req.app.locals.appName
    })
  }).catch(() => {});
}

ownerRouter.post('/pedidos/:id/aceitar', requireOwner, (req, res) => {
  const request = findRequestById.get(Number(req.params.id), req.event.id);
  if (request) {
    const accept = db.transaction(() => {
      decideRequest.run('aceite', req.user.id, req.event.id, request.user_id);
      addMember.run({
        event_id: req.event.id,
        user_id: request.user_id,
        status: req.event.phase === 'datas' ? 'maybe' : 'going',
        joined_via: 'pedido'
      });
    });
    accept();
    notifyDecision(req, request.user_id, true);
    res.flash('success', 'Pedido aceite.');
  }
  return res.redirect(afterDecision(req));
});

ownerRouter.post('/pedidos/:id/recusar', requireOwner, (req, res) => {
  const request = findRequestById.get(Number(req.params.id), req.event.id);
  if (request) {
    decideRequest.run('recusado', req.user.id, req.event.id, request.user_id);
    notifyDecision(req, request.user_id, false);
    res.flash('success', 'Pedido recusado.');
  }
  return res.redirect(afterDecision(req));
});

/* ------------------------------------------------------------------ */
/* Convites                                                            */
/* ------------------------------------------------------------------ */

ownerRouter.post('/convites', requireOwner, (req, res) => {
  const maxUses = toNumberOrNull(req.body.max_uses);
  const expires = cleanText(req.body.expires_at, 10);

  insertInvite.run({
    event_id: req.event.id,
    token: crypto.randomBytes(16).toString('base64url'),
    label: cleanText(req.body.label, 60),
    max_uses: maxUses !== null && maxUses >= 1 ? Math.floor(maxUses) : null,
    expires_at: /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires : null,
    created_by: req.user.id
  });

  res.flash('success', 'Convite criado. Copia o link e envia-o.');
  return res.redirect(`/e/${req.event.slug}/definicoes#convites`);
});

ownerRouter.post('/convites/:id/apagar', requireOwner, (req, res) => {
  deleteInvite.run(Number(req.params.id), req.event.id);
  res.flash('success', 'Convite anulado.');
  return res.redirect(`/e/${req.event.slug}/definicoes#convites`);
});

/**
 * Entrada por link de convite. Fica fora do router de eventos porque o token
 * é que identifica o evento — quem recebe o link não precisa de saber o slug.
 */
export function inviteEntryRoute(req, res) {
  const invite = findInvite.get(req.params.token);

  if (!inviteIsUsable(invite)) {
    return res.status(404).render('error', {
      title: 'Convite inválido',
      status: 404,
      message: 'Este convite já não é válido. Pede um novo a quem organiza a viagem.'
    });
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(invite.event_id);
  if (!event) {
    return res.status(404).render('error', {
      title: 'Viagem não encontrada',
      status: 404,
      message: 'A viagem deste convite já não existe.'
    });
  }

  grantInvite(req.session, event);

  // Sem sessão iniciada, o convite fica guardado e aplica-se depois do login
  if (!req.user) {
    req.session.returnTo = `/e/${event.slug}`;
    req.session.flash = {
      type: 'success',
      message: 'Convite válido! Entra ou cria conta para te juntares à viagem.'
    };
    return res.redirect('/entrar');
  }

  if (!isMember(event, req.user)) {
    const join = db.transaction(() => {
      addMember.run({
        event_id: event.id,
        user_id: req.user.id,
        status: event.phase === 'datas' ? 'maybe' : 'going',
        joined_via: 'convite'
      });
      useInvite.run(invite.id);
    });
    join();
    req.session.flash = { type: 'success', message: 'Convite aceite. Bem-vindo(a) à viagem!' };
  }

  return res.redirect(`/e/${event.slug}`);
}
