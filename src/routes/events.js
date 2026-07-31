import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOpen, requireMember, requireOwner } from '../middleware/event-guards.js';
import {
  generateSlug,
  cleanText,
  toNumberOrNull,
  safeUrl,
  DIFFICULTIES,
  BIKE_TYPES,
  PHASES,
  VISIBILITIES,
  JOIN_POLICIES,
  allowedJoinPolicies,
  daysBetween
} from '../lib/helpers.js';
import {
  isOwner as checkOwner,
  isMember as checkMember,
  canOpen,
  joinOptionFor,
  joinRequestFor
} from '../lib/access.js';
import { listPendingForOwner } from '../lib/notifications.js';
import { router as availabilityRouter, buildAvailability } from './availability.js';
import { router as proposalsRouter, buildProposals, suggestBlocks } from './proposals.js';
import {
  router as gpxRouter,
  gpxUploadErrorHandler,
  listRoutes,
  routeTotals,
  removeEventGpxDir
} from './routes-gpx.js';
import {
  router as membershipRouter,
  ownerRouter as membershipOwnerRouter,
  listPendingRequests,
  countPendingRequests,
  listInvites,
  inviteEntryRoute
} from './membership.js';

export const router = express.Router();

/* ------------------------------------------------------------------ */
/* Consultas                                                           */
/* ------------------------------------------------------------------ */

const insertEvent = db.prepare(
  `INSERT INTO events (owner_id, slug, title, description, phase, start_date, start_time, end_date,
                       availability_start, availability_end, trip_days, days_continuous,
                       meeting_point, distance_km, elevation_m,
                       difficulty, bike_type, route_url, max_participants, visibility, join_policy,
                       access_password_hash)
   VALUES (@owner_id, @slug, @title, @description, @phase, @start_date, @start_time, @end_date,
           @availability_start, @availability_end, @trip_days, @days_continuous,
           @meeting_point, @distance_km, @elevation_m,
           @difficulty, @bike_type, @route_url, @max_participants, @visibility, @join_policy,
           @access_password_hash)`
);

const updateEvent = db.prepare(
  `UPDATE events SET title = @title, description = @description, phase = @phase,
                     start_date = @start_date, start_time = @start_time, end_date = @end_date,
                     availability_start = @availability_start, availability_end = @availability_end,
                     trip_days = @trip_days, days_continuous = @days_continuous,
                     meeting_point = @meeting_point, distance_km = @distance_km,
                     elevation_m = @elevation_m, difficulty = @difficulty, bike_type = @bike_type,
                     route_url = @route_url, max_participants = @max_participants,
                     visibility = @visibility, join_policy = @join_policy,
                     access_password_hash = @access_password_hash, updated_at = datetime('now')
   WHERE id = @id`
);

const findEventBySlug = db.prepare('SELECT * FROM events WHERE slug = ?');
const deleteEventRow = db.prepare('DELETE FROM events WHERE id = ?');

const OWNED_COLUMNS = `e.*,
  (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id) AS member_count,
  (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'going') AS going_count,
  (SELECT COUNT(*) FROM join_requests r WHERE r.event_id = e.id AND r.status = 'pendente') AS pending_count`;

const listOwnedEvents = db.prepare(
  `SELECT ${OWNED_COLUMNS} FROM events e WHERE e.owner_id = ?
   ORDER BY CASE WHEN e.start_date = '' THEN 1 ELSE 0 END, e.start_date ASC`
);

const listJoinedEvents = db.prepare(
  `SELECT ${OWNED_COLUMNS}, p.status AS my_status, u.name AS owner_name
   FROM participants p
   JOIN events e ON e.id = p.event_id
   JOIN users  u ON u.id = e.owner_id
   WHERE p.user_id = ? AND e.owner_id != ?
   ORDER BY CASE WHEN e.start_date = '' THEN 1 ELSE 0 END, e.start_date ASC`
);

// Listagem pública: só público e privado, nunca secreto
const listPublicEvents = db.prepare(
  `SELECT ${OWNED_COLUMNS}, u.name AS owner_name
   FROM events e JOIN users u ON u.id = e.owner_id
   WHERE e.visibility IN ('publico', 'privado')
     AND e.phase != 'concluido'
     AND (e.start_date = '' OR e.start_date >= date('now'))
   ORDER BY CASE WHEN e.start_date = '' THEN 1 ELSE 0 END, e.start_date ASC
   LIMIT 60`
);

const listParticipants = db.prepare(
  `SELECT p.status, p.note, p.created_at, p.joined_via,
          u.id AS user_id, u.name, u.email, u.phone, u.contact_other
   FROM participants p JOIN users u ON u.id = p.user_id
   WHERE p.event_id = ?
   ORDER BY CASE p.status WHEN 'going' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, p.created_at ASC`
);

const getParticipation = db.prepare('SELECT * FROM participants WHERE event_id = ? AND user_id = ?');
// Upsert em vez de UPDATE: se por alguma razão a linha não existir, a resposta
// é criada em vez de se perder em silêncio.
const updateStatus = db.prepare(
  `INSERT INTO participants (event_id, user_id, status, note, joined_via)
   VALUES (@event_id, @user_id, @status, @note, 'resposta')
   ON CONFLICT(event_id, user_id)
   DO UPDATE SET status = @status, note = @note, updated_at = datetime('now')`
);

// Quem cria a viagem entra logo como participante
const addOwnerAsParticipant = db.prepare(
  `INSERT INTO participants (event_id, user_id, status, joined_via)
   VALUES (?, ?, ?, 'organizador')
   ON CONFLICT(event_id, user_id) DO NOTHING`
);
const removeParticipation = db.prepare('DELETE FROM participants WHERE event_id = ? AND user_id = ?');

const listComments = db.prepare(
  `SELECT c.id, c.body, c.created_at, u.name AS author_name, u.id AS author_id
   FROM comments c JOIN users u ON u.id = c.user_id
   WHERE c.event_id = ? ORDER BY c.created_at ASC`
);
const insertComment = db.prepare('INSERT INTO comments (event_id, user_id, body) VALUES (?, ?, ?)');
const findComment = db.prepare('SELECT * FROM comments WHERE id = ?');
const deleteComment = db.prepare('DELETE FROM comments WHERE id = ?');

const getOwner = db.prepare('SELECT id, name, email, phone, contact_other FROM users WHERE id = ?');

// Quantos participantes tem a viagem. Necessário para a ficha resumida que
// quem ainda não é membro vê, onde a lista de participantes está escondida.
const countMembers = db.prepare('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?');

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

/** Carrega o evento e o papel de quem o está a ver. */
function loadEvent(req, res, next) {
  const event = findEventBySlug.get(req.params.slug);
  if (!event) {
    return res.status(404).render('error', {
      title: 'Viagem não encontrada',
      status: 404,
      message: 'Este link não corresponde a nenhuma viagem. Confirma com quem to enviou.'
    });
  }
  req.event = event;
  req.isOwner = checkOwner(event, req.user);
  req.isMember = checkMember(event, req.user);
  return next();
}




/* ------------------------------------------------------------------ */
/* Painel e listagem pública                                           */
/* ------------------------------------------------------------------ */

router.get('/painel', requireAuth, (req, res) => {
  res.render('dashboard', {
    title: 'As minhas viagens',
    owned: listOwnedEvents.all(req.user.id),
    joined: listJoinedEvents.all(req.user.id, req.user.id)
  });
});

router.get('/pedidos', requireAuth, (req, res) => {
  res.render('requests', {
    title: 'Pedidos para entrar',
    requests: listPendingForOwner.all(req.user.id)
  });
});

router.get('/viagens', (req, res) => {
  res.render('discover', {
    title: 'Viagens a acontecer',
    events: listPublicEvents.all()
  });
});

/* ------------------------------------------------------------------ */
/* Criar                                                               */
/* ------------------------------------------------------------------ */

const FORM_OPTIONS = {
  difficulties: DIFFICULTIES,
  bikeTypes: BIKE_TYPES,
  phases: PHASES,
  visibilities: VISIBILITIES,
  joinPolicies: JOIN_POLICIES
};

router.get('/eventos/novo', requireAuth, (req, res) => {
  res.render('events/form', {
    title: 'Nova viagem',
    mode: 'create',
    errors: [],
    values: {
      phase: 'preparacao',
      trip_days: 1,
      days_continuous: 1,
      visibility: 'privado',
      join_policy: 'pedido',
      difficulty: 'moderado',
      bike_type: 'qualquer'
    },
    ...FORM_OPTIONS
  });
});

router.post('/eventos/novo', requireAuth, async (req, res) => {
  const { values, errors, accessPassword } = readEventForm(req.body);

  if (values.join_policy === 'palavra_passe' && !accessPassword) {
    errors.push('Define a palavra-passe da viagem.');
  }

  if (errors.length) {
    return res.status(400).render('events/form', {
      title: 'Nova viagem',
      mode: 'create',
      errors,
      values,
      ...FORM_OPTIONS
    });
  }

  const slug = uniqueSlug();
  const hash =
    values.join_policy === 'palavra_passe' ? await bcrypt.hash(accessPassword, 12) : null;

  const create = db.transaction(() => {
    const { lastInsertRowid } = insertEvent.run({
      ...values,
      owner_id: req.user.id,
      slug,
      access_password_hash: hash
    });
    // Quem organiza vai, mesmo na fase em que a data ainda não está fechada
    addOwnerAsParticipant.run(lastInsertRowid, req.user.id, 'going');
  });
  create();

  res.flash('success', 'Viagem criada. Partilha o link com o pessoal!');
  return res.redirect(`/e/${slug}`);
});

/* ------------------------------------------------------------------ */
/* Página da viagem                                                    */
/* ------------------------------------------------------------------ */

router.get('/e/:slug', loadEvent, requireOpen, (req, res) => {
  const { event } = req;
  const participants = req.isMember ? listParticipants.all(event.id) : [];
  const goingCount = participants.filter((p) => p.status === 'going').length;
  const availability = req.isMember
    ? buildAvailability(event, req.user)
    : { active: false, months: [], byDate: new Map(), mine: new Set(), best: [], people: [], missing: [], respondents: 0 };

  res.render('events/show', {
    title: event.title,
    event,
    owner: getOwner.get(event.owner_id),
    isOwner: req.isOwner,
    isMember: req.isMember,
    joinOption: joinOptionFor(event, req.user, req.session),
    myRequest: joinRequestFor(event, req.user),
    participants,
    goingCount,
    memberCount: countMembers.get(event.id).n,
    isFull: event.max_participants ? goingCount >= event.max_participants : false,
    myParticipation: req.user ? getParticipation.get(event.id, req.user.id) : null,
    comments: req.isMember ? listComments.all(event.id) : [],
    routes: req.isMember ? listRoutes.all(event.id) : [],
    totals: routeTotals.get(event.id),
    availability,
    proposals: req.isMember ? buildProposals(event, req.user) : { active: false, proposals: [] },
    suggestions: req.isOwner && availability.active ? suggestBlocks(event, availability.byDate) : [],
    pendingRequests: req.isOwner ? listPendingRequests.all(event.id) : [],
    shareUrl: `${req.appBaseUrl}/e/${event.slug}`
  });
});

/* ------------------------------------------------------------------ */
/* Inscrição (estado) — só membros                                     */
/* ------------------------------------------------------------------ */

router.post('/e/:slug/estado', loadEvent, requireAuth, requireOpen, requireMember, (req, res) => {
  const { event } = req;
  const status = ['going', 'maybe', 'out'].includes(req.body.status) ? req.body.status : 'going';
  const note = cleanText(req.body.note, 200);

  if (status === 'going' && event.max_participants) {
    const current = getParticipation.get(event.id, req.user.id);
    if (current?.status !== 'going') {
      const goingCount = listParticipants.all(event.id).filter((p) => p.status === 'going').length;
      if (goingCount >= event.max_participants) {
        res.flash('error', 'As vagas estão esgotadas. Podes marcar "Talvez" e ficar atento.');
        return res.redirect(`/e/${event.slug}`);
      }
    }
  }

  updateStatus.run({ event_id: event.id, user_id: req.user.id, status, note });
  res.flash('success', 'Actualizámos a tua resposta.');
  return res.redirect(`/e/${event.slug}#participantes`);
});

router.post('/e/:slug/participantes/:userId/remover', loadEvent, requireAuth, requireOwner, (req, res) => {
  removeParticipation.run(req.event.id, Number(req.params.userId));
  res.flash('success', 'Participante removido.');
  return res.redirect(`/e/${req.event.slug}#participantes`);
});

router.get('/e/:slug/participantes.csv', loadEvent, requireAuth, requireOwner, (req, res) => {
  const rows = listParticipants.all(req.event.id);
  const header = ['Nome', 'Email', 'Telemóvel', 'Outro contacto', 'Estado', 'Entrou por', 'Nota'];
  const csv = [header, ...rows.map((r) => [
    r.name, r.email, r.phone, r.contact_other, r.status, r.joined_via, r.note
  ])]
    .map((cols) => cols.map(csvCell).join(','))
    .join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="participantes-${req.event.slug}.csv"`);
  res.send(`﻿${csv}`);
});

/* ------------------------------------------------------------------ */
/* Mural — só membros                                                  */
/* ------------------------------------------------------------------ */

router.post('/e/:slug/comentarios', loadEvent, requireAuth, requireOpen, requireMember, (req, res) => {
  const body = cleanText(req.body.body, 1000);
  if (body) insertComment.run(req.event.id, req.user.id, body);
  else res.flash('error', 'A mensagem estava vazia.');
  return res.redirect(`/e/${req.event.slug}#mural`);
});

router.post('/e/:slug/comentarios/:id/apagar', loadEvent, requireAuth, (req, res) => {
  const comment = findComment.get(Number(req.params.id));
  if (comment && comment.event_id === req.event.id &&
      (comment.user_id === req.user.id || req.isOwner)) {
    deleteComment.run(comment.id);
  }
  return res.redirect(`/e/${req.event.slug}#mural`);
});

/* ------------------------------------------------------------------ */
/* Definições da viagem                                                */
/* ------------------------------------------------------------------ */

router.get('/e/:slug/definicoes', loadEvent, requireAuth, requireOwner, (req, res) => {
  res.render('events/settings', {
    title: `Definições — ${req.event.title}`,
    event: req.event,
    errors: [],
    values: req.event,
    invites: listInvites.all(req.event.id),
    pendingCount: countPendingRequests.get(req.event.id).n,
    inviteBase: `${req.appBaseUrl}/convite`,
    ...FORM_OPTIONS
  });
});

router.post('/e/:slug/definicoes', loadEvent, requireAuth, requireOwner, async (req, res) => {
  const { event } = req;
  const { values, errors, accessPassword } = readEventForm(req.body);

  const needsPassword = values.join_policy === 'palavra_passe' && !event.access_password_hash;
  if (needsPassword && !accessPassword) errors.push('Define a palavra-passe da viagem.');

  if (errors.length) {
    return res.status(400).render('events/settings', {
      title: `Definições — ${event.title}`,
      event,
      errors,
      values: { ...event, ...values },
      invites: listInvites.all(event.id),
      pendingCount: countPendingRequests.get(event.id).n,
      inviteBase: `${req.appBaseUrl}/convite`,
      ...FORM_OPTIONS
    });
  }

  let access_password_hash = null;
  if (values.join_policy === 'palavra_passe') {
    access_password_hash = accessPassword
      ? await bcrypt.hash(accessPassword, 12)
      : event.access_password_hash;
  }

  updateEvent.run({ ...values, id: event.id, access_password_hash });
  res.flash('success', 'Definições guardadas.');
  return res.redirect(`/e/${event.slug}`);
});

router.post('/e/:slug/apagar', loadEvent, requireAuth, requireOwner, (req, res) => {
  removeEventGpxDir(req.event.id);
  deleteEventRow.run(req.event.id);
  res.flash('success', 'Viagem apagada.');
  return res.redirect('/painel');
});

/* ------------------------------------------------------------------ */
/* Sub-routers                                                         */
/* ------------------------------------------------------------------ */

// Cada sub-router declara os seus próprios guardas em cada rota (ver
// middleware/event-guards.js). Aqui só se garante o evento e a sessão, para
// que um pedido que não pertença a este router possa seguir para o seguinte.
const eventContext = [loadEvent, requireAuth];

router.use('/e/:slug', eventContext, membershipOwnerRouter);
router.use('/e/:slug', eventContext, membershipRouter);
router.use('/e/:slug', eventContext, availabilityRouter);
router.use('/e/:slug', eventContext, proposalsRouter);
router.use('/e/:slug', eventContext, gpxRouter, gpxUploadErrorHandler);

// Entrada por convite: o token identifica a viagem
router.get('/convite/:token', inviteEntryRoute);

/* ------------------------------------------------------------------ */
/* Auxiliares                                                          */
/* ------------------------------------------------------------------ */

/** Lê e valida o formulário de viagem, partilhado entre criar e definições. */
function readEventForm(body) {
  const phase = PHASES.some((p) => p.value === body.phase) ? body.phase : 'preparacao';
  const visibility = VISIBILITIES.some((v) => v.value === body.visibility) ? body.visibility : 'privado';

  // Uma viagem pública não pode ter entrada condicionada
  const permitted = allowedJoinPolicies(visibility);
  const joinPolicy = permitted.includes(body.join_policy) ? body.join_policy : permitted[0];

  const values = {
    title: cleanText(body.title, 120),
    description: cleanText(body.description, 4000),
    phase,
    start_date: cleanText(body.start_date, 10),
    start_time: cleanText(body.start_time, 5),
    end_date: cleanText(body.end_date, 10),
    availability_start: cleanText(body.availability_start, 10),
    availability_end: cleanText(body.availability_end, 10),
    trip_days: toNumberOrNull(body.trip_days),
    days_continuous: body.days_continuous === 'nao' ? 0 : 1,
    meeting_point: cleanText(body.meeting_point, 200),
    distance_km: toNumberOrNull(body.distance_km),
    elevation_m: toNumberOrNull(body.elevation_m),
    difficulty: DIFFICULTIES.some((d) => d.value === body.difficulty) ? body.difficulty : 'moderado',
    bike_type: BIKE_TYPES.some((b) => b.value === body.bike_type) ? body.bike_type : 'qualquer',
    route_url: safeUrl(body.route_url),
    max_participants: toNumberOrNull(body.max_participants),
    visibility,
    join_policy: joinPolicy
  };
  if (values.trip_days !== null) values.trip_days = Math.floor(values.trip_days);

  const accessPassword = String(body.access_password ?? '').trim();
  const errors = [];
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

  if (values.title.length < 3) errors.push('Dá um nome à viagem.');

  if (phase === 'datas') {
    // Na fase de datas ainda não há data marcada: o que interessa é a janela
    if (!isDate(values.availability_start) || !isDate(values.availability_end)) {
      errors.push('Indica a janela de datas a considerar (de e até).');
    } else if (values.availability_end < values.availability_start) {
      errors.push('A janela de datas termina antes de começar.');
    } else if (values.trip_days && daysBetween(values.availability_start, values.availability_end) < values.trip_days) {
      errors.push(
        `A janela tem menos dias do que a viagem (${values.trip_days}). Alarga a janela ou reduz a duração.`
      );
    }
  } else if (!isDate(values.start_date)) {
    errors.push('Indica a data da viagem.');
  }

  if (values.end_date && values.start_date && values.end_date < values.start_date) {
    errors.push('A data de fim é anterior à data de início.');
  }
  if (values.trip_days !== null && (values.trip_days < 1 || values.trip_days > 60)) {
    errors.push('A duração da viagem tem de estar entre 1 e 60 dias.');
  }
  if (values.max_participants !== null && values.max_participants < 1) {
    errors.push('O limite de participantes tem de ser pelo menos 1.');
  }
  if (accessPassword && accessPassword.length < 4) {
    errors.push('A palavra-passe da viagem precisa de pelo menos 4 caracteres.');
  }
  if (body.route_url && !values.route_url) {
    errors.push('O link do percurso tem de começar por http:// ou https://.');
  }

  return { values, errors, accessPassword };
}

/** Gera um slug garantidamente livre. */
function uniqueSlug() {
  for (let i = 0; i < 10; i += 1) {
    const slug = generateSlug();
    if (!findEventBySlug.get(slug)) return slug;
  }
  return generateSlug(16);
}

/** Escapa um valor para CSV. */
function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
