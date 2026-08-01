import express from 'express';
import { db } from '../lib/db.js';
import { requireOpen, requireMember, requireModerator } from '../middleware/event-guards.js';
import { cleanText, toNumberOrNull } from '../lib/helpers.js';

export const router = express.Router({ mergeParams: true });

const MAX_QUANTITY = 999;

const insertItem = db.prepare(
  `INSERT INTO gear_items (event_id, name, quantity, notes, category, created_by, position)
   VALUES (@event_id, @name, @quantity, @notes, @category, @created_by, @position)`
);
const updateItem = db.prepare(
  `UPDATE gear_items SET name = @name, quantity = @quantity, notes = @notes, category = @category
   WHERE id = @id AND event_id = @event_id`
);
const deleteItem = db.prepare('DELETE FROM gear_items WHERE id = ? AND event_id = ?');
const findItem = db.prepare('SELECT * FROM gear_items WHERE id = ? AND event_id = ?');
const nextPosition = db.prepare(
  'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM gear_items WHERE event_id = ?'
);

const listItems = db.prepare(
  `SELECT g.*, u.name AS author_name
   FROM gear_items g LEFT JOIN users u ON u.id = g.created_by
   WHERE g.event_id = ?
   ORDER BY g.category, g.position, g.id`
);

const listClaims = db.prepare(
  `SELECT c.*, u.name AS user_name
   FROM gear_claims c JOIN users u ON u.id = c.user_id
   WHERE c.item_id IN (SELECT id FROM gear_items WHERE event_id = ?)
   ORDER BY c.created_at`
);

const upsertClaim = db.prepare(
  `INSERT INTO gear_claims (item_id, user_id, quantity, note)
   VALUES (@item_id, @user_id, @quantity, @note)
   ON CONFLICT(item_id, user_id)
   DO UPDATE SET quantity = @quantity, note = @note, updated_at = datetime('now')`
);
const deleteClaim = db.prepare('DELETE FROM gear_claims WHERE item_id = ? AND user_id = ?');
const claimedByOthers = db.prepare(
  'SELECT COALESCE(SUM(quantity), 0) AS n FROM gear_claims WHERE item_id = ? AND user_id != ?'
);

/**
 * Reúne a lista de material com o que já está atribuído, e o resumo do que
 * cada pessoa leva. A soma do que falta é calculada aqui e não na vista,
 * para a página não ter de repetir a mesma conta em três sítios.
 */
export function buildGear(event, user) {
  const items = listItems.all(event.id);
  if (!items.length) {
    return { active: false, items: [], byPerson: [], totals: { needed: 0, claimed: 0, missing: 0 } };
  }

  const claims = listClaims.all(event.id);
  const byItem = new Map(items.map((i) => [i.id, []]));
  const byPerson = new Map();

  for (const claim of claims) {
    byItem.get(claim.item_id)?.push(claim);

    if (!byPerson.has(claim.user_id)) {
      byPerson.set(claim.user_id, { id: claim.user_id, name: claim.user_name, items: [], total: 0 });
    }
  }

  const decorated = items.map((item) => {
    const itemClaims = byItem.get(item.id) ?? [];
    const claimed = itemClaims.reduce((sum, c) => sum + c.quantity, 0);
    const mine = user ? itemClaims.find((c) => c.user_id === user.id) : null;

    // Preenche o resumo por pessoa enquanto se percorre
    for (const claim of itemClaims) {
      const person = byPerson.get(claim.user_id);
      person.items.push({ name: item.name, quantity: claim.quantity, note: claim.note });
      person.total += claim.quantity;
    }

    return {
      ...item,
      claims: itemClaims,
      claimed,
      missing: Math.max(0, item.quantity - claimed),
      complete: claimed >= item.quantity,
      myQuantity: mine?.quantity ?? 0,
      myNote: mine?.note ?? '',
      // Quanto é que esta pessoa pode ainda assumir sem passar do necessário
      maxForMe: Math.max(0, item.quantity - (claimed - (mine?.quantity ?? 0)))
    };
  });

  const totals = decorated.reduce(
    (acc, i) => ({
      needed: acc.needed + i.quantity,
      claimed: acc.claimed + Math.min(i.claimed, i.quantity),
      missing: acc.missing + i.missing
    }),
    { needed: 0, claimed: 0, missing: 0 }
  );

  return {
    active: true,
    items: decorated,
    byPerson: [...byPerson.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    totals
  };
}

/* ------------------------------------------------------------------ */
/* Gerir a lista (organizador e moderadores)                           */
/* ------------------------------------------------------------------ */

router.post('/material', requireOpen, requireModerator, (req, res) => {
  const { event } = req;
  const name = cleanText(req.body.name, 120);
  const quantity = toNumberOrNull(req.body.quantity);

  if (name.length < 2) {
    res.flash('error', 'Dá um nome ao material.');
    return res.redirect(`/e/${event.slug}#material`);
  }

  insertItem.run({
    event_id: event.id,
    name,
    quantity: clampQuantity(quantity ?? 1),
    notes: cleanText(req.body.notes, 300),
    category: cleanText(req.body.category, 60),
    created_by: req.user.id,
    position: nextPosition.get(event.id).p
  });

  res.flash('success', 'Material acrescentado à lista.');
  return res.redirect(`/e/${event.slug}#material`);
});

router.post('/material/:id/editar', requireOpen, requireModerator, (req, res) => {
  const { event } = req;
  const item = findItem.get(Number(req.params.id), event.id);
  if (!item) {
    res.flash('error', 'Esse material já não existe.');
    return res.redirect(`/e/${event.slug}#material`);
  }

  const name = cleanText(req.body.name, 120);
  const quantity = clampQuantity(toNumberOrNull(req.body.quantity) ?? item.quantity);

  if (name.length < 2) {
    res.flash('error', 'Dá um nome ao material.');
    return res.redirect(`/e/${event.slug}#material`);
  }

  updateItem.run({
    id: item.id,
    event_id: event.id,
    name,
    quantity,
    notes: cleanText(req.body.notes, 300),
    category: cleanText(req.body.category, 60)
  });

  res.flash('success', 'Material actualizado.');
  return res.redirect(`/e/${event.slug}#material`);
});

router.post('/material/:id/apagar', requireOpen, requireModerator, (req, res) => {
  deleteItem.run(Number(req.params.id), req.event.id);
  res.flash('success', 'Material removido da lista.');
  return res.redirect(`/e/${req.event.slug}#material`);
});

/* ------------------------------------------------------------------ */
/* Assumir material (qualquer participante)                            */
/* ------------------------------------------------------------------ */

router.post('/material/:id/levo', requireOpen, requireMember, (req, res) => {
  const { event } = req;
  const item = findItem.get(Number(req.params.id), event.id);
  if (!item) {
    res.flash('error', 'Esse material já não existe.');
    return res.redirect(`/e/${event.slug}#material`);
  }

  const wanted = clampQuantity(toNumberOrNull(req.body.quantity) ?? 1);
  const note = cleanText(req.body.note, 160);

  // Zero significa "afinal não levo"
  if (wanted <= 0) {
    deleteClaim.run(item.id, req.user.id);
    res.flash('success', `Deixaste de levar ${item.name}.`);
    return res.redirect(`/e/${event.slug}#material`);
  }

  // Não deixa assumir mais do que falta, contando o que os outros já levam
  const others = claimedByOthers.get(item.id, req.user.id).n;
  const room = item.quantity - others;

  if (room <= 0) {
    res.flash('error', `${item.name} já está todo atribuído.`);
    return res.redirect(`/e/${event.slug}#material`);
  }

  const quantity = Math.min(wanted, room);
  upsertClaim.run({ item_id: item.id, user_id: req.user.id, quantity, note });

  res.flash(
    'success',
    quantity < wanted
      ? `Ficaste com ${quantity} × ${item.name} — era só o que faltava.`
      : `Ficaste com ${quantity} × ${item.name}.`
  );
  return res.redirect(`/e/${event.slug}#material`);
});

/** Limita a quantidade a um intervalo com sentido. */
function clampQuantity(value) {
  const n = Math.floor(Number(value) || 0);
  if (n < 0) return 0;
  return Math.min(n, MAX_QUANTITY);
}
