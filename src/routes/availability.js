import express from 'express';
import { db } from '../lib/db.js';
import { dateRange, groupByMonth } from '../lib/helpers.js';
import { requireOpen, requireMember, requireOwner } from '../middleware/event-guards.js';

export const router = express.Router({ mergeParams: true });

const clearAvailability = db.prepare(
  'DELETE FROM event_availability WHERE event_id = ? AND user_id = ?'
);
const insertAvailability = db.prepare(
  'INSERT OR IGNORE INTO event_availability (event_id, user_id, date) VALUES (?, ?, ?)'
);

const listAvailability = db.prepare(
  `SELECT a.date, a.user_id, u.name
   FROM event_availability a JOIN users u ON u.id = a.user_id
   WHERE a.event_id = ?`
);

const countRespondents = db.prepare(
  'SELECT COUNT(DISTINCT user_id) AS n FROM event_availability WHERE event_id = ?'
);

/**
 * Monta o calendário de disponibilidades de um evento:
 * meses a desenhar, quem marcou cada dia, e os melhores dias.
 */
export function buildAvailability(event, user) {
  const days = dateRange(event.availability_start, event.availability_end);
  if (!days.length) {
    return { active: false, months: [], byDate: new Map(), mine: new Set(), best: [], respondents: 0 };
  }

  const rows = listAvailability.all(event.id);

  // Quem está disponível em cada dia
  const byDate = new Map(days.map((d) => [d, []]));
  const mine = new Set();
  for (const row of rows) {
    if (byDate.has(row.date)) byDate.get(row.date).push(row.name);
    if (user && row.user_id === user.id) mine.add(row.date);
  }

  const respondents = countRespondents.get(event.id).n;

  // Dias com mais gente disponível, para o organizador decidir depressa
  const best = [...byDate.entries()]
    .filter(([, names]) => names.length > 0)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([date, names]) => ({ date, names, count: names.length }));

  return {
    active: true,
    months: groupByMonth(days),
    byDate,
    mine,
    best,
    respondents,
    maxCount: Math.max(1, ...[...byDate.values()].map((n) => n.length))
  };
}

/* ------------------------------------------------------------------ */
/* Guardar as datas de uma pessoa                                      */
/* ------------------------------------------------------------------ */

router.post('/disponibilidades', requireOpen, requireMember, (req, res) => {
  const { event } = req;
  const valid = new Set(dateRange(event.availability_start, event.availability_end));

  // Aceita uma ou várias caixas com o mesmo nome
  const submitted = [].concat(req.body.dates ?? []);
  const chosen = [...new Set(submitted.filter((d) => valid.has(d)))];

  // Substitui a marcação anterior por inteiro, numa transacção
  const save = db.transaction(() => {
    clearAvailability.run(event.id, req.user.id);
    for (const date of chosen) insertAvailability.run(event.id, req.user.id, date);
  });
  save();

  res.flash(
    'success',
    chosen.length
      ? `Guardámos ${chosen.length} dia${chosen.length === 1 ? '' : 's'} em que podes.`
      : 'Marcámos que não tens nenhum dia disponível nesta janela.'
  );
  return res.redirect(`/e/${event.slug}#datas`);
});

/* ------------------------------------------------------------------ */
/* O organizador fecha a data escolhida                                */
/* ------------------------------------------------------------------ */

const setChosenDate = db.prepare(
  `UPDATE events SET start_date = ?, phase = 'preparacao', updated_at = datetime('now')
   WHERE id = ?`
);

router.post('/disponibilidades/escolher', requireOwner, (req, res) => {
  const { event } = req;
  const date = String(req.body.date ?? '');
  const valid = new Set(dateRange(event.availability_start, event.availability_end));

  if (!valid.has(date)) {
    res.flash('error', 'Essa data não está dentro da janela em análise.');
    return res.redirect(`/e/${event.slug}#datas`);
  }

  setChosenDate.run(date, event.id);
  res.flash('success', 'Data escolhida. A viagem passou à fase de preparação.');
  return res.redirect(`/e/${event.slug}`);
});
