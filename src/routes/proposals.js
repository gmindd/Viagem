import express from 'express';
import { db } from '../lib/db.js';
import { requireOpen, requireMember, requireOwner } from '../middleware/event-guards.js';
import { cleanText, addDays, daysBetween, dateRange, consecutiveRuns } from '../lib/helpers.js';
import { sendEmail, proposalsEmail } from '../lib/email.js';

export const router = express.Router({ mergeParams: true });

export const VOTE_LABELS = { sim: 'Pode ser', talvez: 'Talvez', nao: 'Não posso' };

const insertProposal = db.prepare(
  `INSERT INTO date_proposals (event_id, start_date, end_date, note)
   VALUES (@event_id, @start_date, @end_date, @note)
   ON CONFLICT(event_id, start_date, end_date) DO UPDATE SET note = @note`
);
const deleteProposal = db.prepare('DELETE FROM date_proposals WHERE id = ? AND event_id = ?');
const findProposal = db.prepare('SELECT * FROM date_proposals WHERE id = ? AND event_id = ?');
const listProposalRows = db.prepare(
  'SELECT * FROM date_proposals WHERE event_id = ? ORDER BY start_date ASC'
);

const upsertVote = db.prepare(
  `INSERT INTO proposal_votes (proposal_id, user_id, vote) VALUES (@proposal_id, @user_id, @vote)
   ON CONFLICT(proposal_id, user_id) DO UPDATE SET vote = @vote`
);
const listVotes = db.prepare(
  `SELECT v.proposal_id, v.vote, u.id AS user_id, u.name
   FROM proposal_votes v JOIN users u ON u.id = v.user_id
   WHERE v.proposal_id IN (SELECT id FROM date_proposals WHERE event_id = ?)`
);

const listMembers = db.prepare(
  'SELECT u.id, u.name FROM participants p JOIN users u ON u.id = p.user_id WHERE p.event_id = ?'
);

const setFinalDates = db.prepare(
  `UPDATE events SET start_date = ?, end_date = ?, phase = 'preparacao', updated_at = datetime('now')
   WHERE id = ?`
);
const setPhase = db.prepare(
  "UPDATE events SET phase = ?, updated_at = datetime('now') WHERE id = ?"
);

const memberEmails = db.prepare(
  `SELECT u.id, u.name, u.email FROM participants p JOIN users u ON u.id = p.user_id
   WHERE p.event_id = ? AND u.id != ?`
);

/**
 * Reúne as propostas com os votos de cada uma, ordenadas pelo apoio que têm.
 * "sim" vale 2 e "talvez" vale 1, para um talvez de muitos não perder
 * automaticamente para um sim de poucos.
 */
export function buildProposals(event, user) {
  const rows = listProposalRows.all(event.id);
  if (!rows.length) return { active: false, proposals: [], memberCount: 0, voterCount: 0 };

  const votes = listVotes.all(event.id);
  const byProposal = new Map(rows.map((r) => [r.id, []]));
  const voters = new Set();
  for (const v of votes) {
    byProposal.get(v.proposal_id)?.push(v);
    voters.add(v.user_id);
  }

  const proposals = rows.map((row) => {
    const all = byProposal.get(row.id) ?? [];
    const grouped = {
      sim: all.filter((v) => v.vote === 'sim'),
      talvez: all.filter((v) => v.vote === 'talvez'),
      nao: all.filter((v) => v.vote === 'nao')
    };
    return {
      ...row,
      days: daysBetween(row.start_date, row.end_date),
      votes: grouped,
      myVote: user ? all.find((v) => v.user_id === user.id)?.vote ?? null : null,
      score: grouped.sim.length * 2 + grouped.talvez.length
    };
  });

  const best = Math.max(...proposals.map((p) => p.score));
  for (const p of proposals) p.isBest = best > 0 && p.score === best;

  return {
    active: true,
    proposals,
    memberCount: listMembers.all(event.id).length,
    voterCount: voters.size
  };
}

/**
 * Sugere blocos de datas a partir das disponibilidades já marcadas:
 * ordena os blocos possíveis pelo número de pessoas que podem em todos os
 * dias do bloco, para o organizador não ter de os procurar a olho.
 */
export function suggestBlocks(event, availabilityByDate) {
  const tripDays = event.trip_days && event.trip_days > 0 ? event.trip_days : 1;
  const window = dateRange(event.availability_start, event.availability_end);
  if (window.length < tripDays) return [];

  const suggestions = [];
  for (let i = 0; i + tripDays <= window.length; i += 1) {
    const block = window.slice(i, i + tripDays);

    // Quem está disponível em TODOS os dias do bloco
    let common = null;
    for (const day of block) {
      const names = new Set((availabilityByDate.get(day) ?? []).map((n) => n));
      common = common === null ? names : new Set([...common].filter((n) => names.has(n)));
      if (common.size === 0) break;
    }

    suggestions.push({
      start_date: block[0],
      end_date: block[block.length - 1],
      count: common ? common.size : 0,
      names: common ? [...common] : []
    });
  }

  return suggestions
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count || a.start_date.localeCompare(b.start_date))
    .slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Gerir propostas (organizador)                                       */
/* ------------------------------------------------------------------ */

router.post('/propostas', requireOwner, (req, res) => {
  const { event } = req;
  const start = cleanText(req.body.start_date, 10);
  const tripDays = event.trip_days && event.trip_days > 0 ? event.trip_days : 1;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    res.flash('error', 'Indica a data de início da proposta.');
    return res.redirect(`/e/${event.slug}#propostas`);
  }

  // O fim é calculado a partir da duração da viagem: uma proposta com menos
  // dias do que a viagem não faria sentido nenhum.
  const end = cleanText(req.body.end_date, 10) || addDays(start, tripDays - 1);
  if (end < start) {
    res.flash('error', 'A proposta acaba antes de começar.');
    return res.redirect(`/e/${event.slug}#propostas`);
  }

  insertProposal.run({
    event_id: event.id,
    start_date: start,
    end_date: end,
    note: cleanText(req.body.note, 200)
  });

  // Criar a primeira proposta faz a viagem avançar de fase sozinha
  if (event.phase === 'datas') setPhase.run('propostas', event.id);

  res.flash('success', 'Proposta adicionada.');
  return res.redirect(`/e/${event.slug}#propostas`);
});

router.post('/propostas/:id/apagar', requireOwner, (req, res) => {
  deleteProposal.run(Number(req.params.id), req.event.id);
  res.flash('success', 'Proposta removida.');
  return res.redirect(`/e/${req.event.slug}#propostas`);
});

/** Avisa por email quem ainda não votou. */
router.post('/propostas/avisar', requireOwner, async (req, res) => {
  const { event } = req;
  const count = listProposalRows.all(event.id).length;
  if (!count) {
    res.flash('error', 'Ainda não há propostas para votar.');
    return res.redirect(`/e/${event.slug}#propostas`);
  }

  const url = `${req.appBaseUrl}/e/${event.slug}#propostas`;
  const recipients = memberEmails.all(event.id, req.user.id);

  const results = await Promise.all(
    recipients.map((m) =>
      sendEmail({
        to: m.email,
        ...proposalsEmail({
          name: m.name,
          eventTitle: event.title,
          count,
          url,
          appName: req.app.locals.appName
        })
      })
    )
  );

  const sent = results.filter((r) => r.sent).length;
  const skipped = results.some((r) => r.skipped);

  res.flash(
    skipped ? 'error' : 'success',
    skipped
      ? 'O envio de emails não está configurado neste servidor, por isso ninguém foi avisado.'
      : `Avisámos ${sent} de ${recipients.length} participantes.`
  );
  return res.redirect(`/e/${event.slug}#propostas`);
});

/** Fecha a votação escolhendo uma das propostas. */
router.post('/propostas/:id/escolher', requireOwner, (req, res) => {
  const proposal = findProposal.get(Number(req.params.id), req.event.id);
  if (!proposal) {
    res.flash('error', 'Essa proposta já não existe.');
    return res.redirect(`/e/${req.event.slug}#propostas`);
  }

  setFinalDates.run(proposal.start_date, proposal.end_date, req.event.id);
  res.flash('success', 'Datas fechadas. A viagem passou à fase de preparação.');
  return res.redirect(`/e/${req.event.slug}`);
});

/* ------------------------------------------------------------------ */
/* Votar (participantes)                                               */
/* ------------------------------------------------------------------ */

router.post('/propostas/:id/votar', requireOpen, requireMember, (req, res) => {
  const proposal = findProposal.get(Number(req.params.id), req.event.id);
  if (!proposal) {
    res.flash('error', 'Essa proposta já não existe.');
    return res.redirect(`/e/${req.event.slug}#propostas`);
  }

  const vote = ['sim', 'talvez', 'nao'].includes(req.body.vote) ? req.body.vote : 'talvez';
  upsertVote.run({ proposal_id: proposal.id, user_id: req.user.id, vote });

  res.flash('success', 'Voto registado.');
  return res.redirect(`/e/${req.event.slug}#propostas`);
});

/** Volta atrás para recolher mais disponibilidades. */
router.post('/propostas/reabrir', requireOwner, (req, res) => {
  setPhase.run('datas', req.event.id);
  res.flash('success', 'Voltámos à recolha de disponibilidades.');
  return res.redirect(`/e/${req.event.slug}#datas`);
});

export { consecutiveRuns };
