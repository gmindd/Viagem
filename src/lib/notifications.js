import { db } from './db.js';

const countPendingForOwner = db.prepare(
  `SELECT COUNT(*) AS n
   FROM join_requests r JOIN events e ON e.id = r.event_id
   WHERE e.owner_id = ? AND r.status = 'pendente'`
);

/** Todos os pedidos por decidir, de todas as viagens que a pessoa organiza. */
export const listPendingForOwner = db.prepare(
  `SELECT r.id, r.message, r.created_at,
          u.id AS user_id, u.name, u.email, u.phone, u.contact_other, u.bio,
          e.slug, e.title, e.phase
   FROM join_requests r
   JOIN events e ON e.id = r.event_id
   JOIN users  u ON u.id = r.user_id
   WHERE e.owner_id = ? AND r.status = 'pendente'
   ORDER BY r.created_at ASC`
);

/**
 * Põe em res.locals o número de pedidos à espera de decisão, para o
 * cabeçalho poder mostrar o aviso em qualquer página. Sem isto, só se
 * descobria que alguém pediu para entrar ao abrir a viagem certa.
 */
export function pendingBadge(req, res, next) {
  res.locals.pendingTotal = req.user ? countPendingForOwner.get(req.user.id).n : 0;
  next();
}
