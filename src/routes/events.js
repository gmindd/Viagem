import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  generateSlug,
  cleanText,
  toNumberOrNull,
  safeUrl,
  DIFFICULTIES,
  BIKE_TYPES
} from '../lib/helpers.js';

export const router = express.Router();

/* ------------------------------------------------------------------ */
/* Consultas preparadas                                                */
/* ------------------------------------------------------------------ */

const insertEvent = db.prepare(
  `INSERT INTO events (owner_id, slug, title, description, start_date, start_time, end_date,
                       meeting_point, distance_km, elevation_m, difficulty, bike_type,
                       route_url, max_participants, visibility, access_password_hash)
   VALUES (@owner_id, @slug, @title, @description, @start_date, @start_time, @end_date,
           @meeting_point, @distance_km, @elevation_m, @difficulty, @bike_type,
           @route_url, @max_participants, @visibility, @access_password_hash)`
);

const updateEvent = db.prepare(
  `UPDATE events SET title = @title, description = @description, start_date = @start_date,
                     start_time = @start_time, end_date = @end_date, meeting_point = @meeting_point,
                     distance_km = @distance_km, elevation_m = @elevation_m, difficulty = @difficulty,
                     bike_type = @bike_type, route_url = @route_url,
                     max_participants = @max_participants, visibility = @visibility,
                     access_password_hash = @access_password_hash, updated_at = datetime('now')
   WHERE id = @id`
);

const findEventBySlug = db.prepare('SELECT * FROM events WHERE slug = ?');
const deleteEvent = db.prepare('DELETE FROM events WHERE id = ?');

const listOwnedEvents = db.prepare(
  `SELECT e.*, (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'going') AS going_count
   FROM events e WHERE e.owner_id = ? ORDER BY e.start_date ASC, e.start_time ASC`
);

const listJoinedEvents = db.prepare(
  `SELECT e.*, p.status AS my_status, u.name AS owner_name,
          (SELECT COUNT(*) FROM participants p2 WHERE p2.event_id = e.id AND p2.status = 'going') AS going_count
   FROM participants p
   JOIN events e ON e.id = p.event_id
   JOIN users  u ON u.id = e.owner_id
   WHERE p.user_id = ? AND e.owner_id != ?
   ORDER BY e.start_date ASC, e.start_time ASC`
);

const listParticipants = db.prepare(
  `SELECT p.status, p.note, p.created_at, u.id AS user_id, u.name, u.email, u.phone, u.contact_other
   FROM participants p JOIN users u ON u.id = p.user_id
   WHERE p.event_id = ?
   ORDER BY CASE p.status WHEN 'going' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, p.created_at ASC`
);

const getParticipation = db.prepare('SELECT * FROM participants WHERE event_id = ? AND user_id = ?');
const upsertParticipation = db.prepare(
  `INSERT INTO participants (event_id, user_id, status, note)
   VALUES (@event_id, @user_id, @status, @note)
   ON CONFLICT(event_id, user_id)
   DO UPDATE SET status = @status, note = @note, updated_at = datetime('now')`
);
const removeParticipation = db.prepare('DELETE FROM participants WHERE event_id = ? AND user_id = ?');

const listComments = db.prepare(
  `SELECT c.id, c.body, c.created_at, u.name AS author_name, u.id AS author_id
   FROM comments c JOIN users u ON u.id = c.user_id
   WHERE c.event_id = ? ORDER BY c.created_at ASC`
);
const insertComment = db.prepare(
  'INSERT INTO comments (event_id, user_id, body) VALUES (?, ?, ?)'
);
const findComment = db.prepare('SELECT * FROM comments WHERE id = ?');
const deleteComment = db.prepare('DELETE FROM comments WHERE id = ?');

const getOwner = db.prepare('SELECT id, name, email, phone, contact_other FROM users WHERE id = ?');

/* ------------------------------------------------------------------ */
/* Middleware de carregamento e controlo de acesso                     */
/* ------------------------------------------------------------------ */

/** Carrega o evento a partir do slug do URL ou devolve 404. */
function loadEvent(req, res, next) {
  const event = findEventBySlug.get(req.params.slug);
  if (!event) {
    return res.status(404).render('error', {
      title: 'Evento não encontrado',
      status: 404,
      message: 'Este link não corresponde a nenhum evento. Confirma com quem to enviou.'
    });
  }
  req.event = event;
  req.isOwner = Boolean(req.user && req.user.id === event.owner_id);
  return next();
}

/** True se a sessão já desbloqueou este evento protegido por palavra-passe. */
function hasUnlocked(req, event) {
  return Boolean(req.session.eventAccess?.[event.slug]);
}

/**
 * Garante acesso ao evento: eventos livres são sempre visíveis com o link;
 * eventos protegidos exigem a palavra-passe (o dono passa sempre).
 */
function requireEventAccess(req, res, next) {
  const { event } = req;
  if (event.visibility === 'free' || req.isOwner || hasUnlocked(req, event)) return next();

  return res.status(401).render('events/unlock', {
    title: event.title,
    event,
    errors: []
  });
}

/** Só o criador do evento pode editar, apagar ou ver os contactos. */
function requireOwner(req, res, next) {
  if (req.isOwner) return next();
  return res.status(403).render('error', {
    title: 'Sem permissão',
    status: 403,
    message: 'Só quem criou o evento o pode gerir.'
  });
}

/* ------------------------------------------------------------------ */
/* Painel do utilizador                                                */
/* ------------------------------------------------------------------ */

router.get('/painel', requireAuth, (req, res) => {
  res.render('dashboard', {
    title: 'Os meus passeios',
    owned: listOwnedEvents.all(req.user.id),
    joined: listJoinedEvents.all(req.user.id, req.user.id)
  });
});

/* ------------------------------------------------------------------ */
/* Criar evento                                                        */
/* ------------------------------------------------------------------ */

router.get('/eventos/novo', requireAuth, (req, res) => {
  res.render('events/form', {
    title: 'Novo passeio',
    mode: 'create',
    errors: [],
    values: { visibility: 'free', difficulty: 'moderado', bike_type: 'qualquer' },
    difficulties: DIFFICULTIES,
    bikeTypes: BIKE_TYPES
  });
});

router.post('/eventos/novo', requireAuth, async (req, res) => {
  const { values, errors, accessPassword } = readEventForm(req.body);

  if (values.visibility === 'password' && !accessPassword) {
    errors.push('Define a palavra-passe do evento (ou escolhe "Aberto a quem tiver o link").');
  }

  if (errors.length) {
    return res.status(400).render('events/form', {
      title: 'Novo passeio',
      mode: 'create',
      errors,
      values,
      difficulties: DIFFICULTIES,
      bikeTypes: BIKE_TYPES
    });
  }

  const slug = uniqueSlug();
  insertEvent.run({
    ...values,
    owner_id: req.user.id,
    slug,
    access_password_hash:
      values.visibility === 'password' ? await bcrypt.hash(accessPassword, 12) : null
  });

  res.flash('success', 'Passeio criado. Partilha o link com o pessoal!');
  return res.redirect(`/e/${slug}`);
});

/* ------------------------------------------------------------------ */
/* Página pública do evento (link de partilha)                         */
/* ------------------------------------------------------------------ */

router.get('/e/:slug', loadEvent, requireEventAccess, (req, res) => {
  const { event } = req;
  const participants = listParticipants.all(event.id);
  const goingCount = participants.filter((p) => p.status === 'going').length;

  res.render('events/show', {
    title: event.title,
    event,
    owner: getOwner.get(event.owner_id),
    isOwner: req.isOwner,
    participants,
    goingCount,
    isFull: event.max_participants ? goingCount >= event.max_participants : false,
    myParticipation: req.user ? getParticipation.get(event.id, req.user.id) : null,
    comments: listComments.all(event.id),
    shareUrl: `${req.appBaseUrl}/e/${event.slug}`
  });
});

// Desbloqueio de um evento protegido por palavra-passe
router.post('/e/:slug/acesso', loadEvent, async (req, res) => {
  const { event } = req;
  const password = String(req.body.event_password ?? '');
  const ok = event.access_password_hash
    ? await bcrypt.compare(password, event.access_password_hash)
    : true;

  if (!ok) {
    return res.status(401).render('events/unlock', {
      title: event.title,
      event,
      errors: ['Palavra-passe errada.']
    });
  }

  req.session.eventAccess = { ...(req.session.eventAccess ?? {}), [event.slug]: true };
  return res.redirect(`/e/${event.slug}`);
});

/* ------------------------------------------------------------------ */
/* Inscrições                                                          */
/* ------------------------------------------------------------------ */

router.post('/e/:slug/inscricao', loadEvent, requireAuth, requireEventAccess, (req, res) => {
  const { event } = req;
  const status = ['going', 'maybe', 'out'].includes(req.body.status) ? req.body.status : 'going';
  const note = cleanText(req.body.note, 200);

  // Verifica o limite de vagas apenas para quem ainda não está confirmado
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

  upsertParticipation.run({ event_id: event.id, user_id: req.user.id, status, note });
  res.flash('success', 'Inscrição actualizada.');
  return res.redirect(`/e/${event.slug}#participantes`);
});

router.post('/e/:slug/inscricao/cancelar', loadEvent, requireAuth, (req, res) => {
  removeParticipation.run(req.event.id, req.user.id);
  res.flash('success', 'Saíste da lista deste passeio.');
  return res.redirect(`/e/${req.event.slug}`);
});

// O organizador pode remover alguém da lista
router.post('/e/:slug/participantes/:userId/remover', loadEvent, requireAuth, requireOwner, (req, res) => {
  removeParticipation.run(req.event.id, Number(req.params.userId));
  res.flash('success', 'Participante removido.');
  return res.redirect(`/e/${req.event.slug}#participantes`);
});

// Exportação dos contactos dos inscritos (só para o organizador)
router.get('/e/:slug/participantes.csv', loadEvent, requireAuth, requireOwner, (req, res) => {
  const rows = listParticipants.all(req.event.id);
  const header = ['Nome', 'Email', 'Telemóvel', 'Outro contacto', 'Estado', 'Nota'];
  const csv = [header, ...rows.map((r) => [
    r.name, r.email, r.phone, r.contact_other, r.status, r.note
  ])]
    .map((cols) => cols.map(csvCell).join(','))
    .join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="participantes-${req.event.slug}.csv"`);
  res.send(`﻿${csv}`);
});

/* ------------------------------------------------------------------ */
/* Mural de mensagens                                                  */
/* ------------------------------------------------------------------ */

router.post('/e/:slug/comentarios', loadEvent, requireAuth, requireEventAccess, (req, res) => {
  const body = cleanText(req.body.body, 1000);
  if (body) {
    insertComment.run(req.event.id, req.user.id, body);
  } else {
    res.flash('error', 'A mensagem estava vazia.');
  }
  return res.redirect(`/e/${req.event.slug}#mural`);
});

router.post('/e/:slug/comentarios/:id/apagar', loadEvent, requireAuth, (req, res) => {
  const comment = findComment.get(Number(req.params.id));
  // Apaga o autor da mensagem ou o organizador do evento
  if (comment && comment.event_id === req.event.id &&
      (comment.user_id === req.user.id || req.isOwner)) {
    deleteComment.run(comment.id);
  }
  return res.redirect(`/e/${req.event.slug}#mural`);
});

/* ------------------------------------------------------------------ */
/* Editar e apagar                                                     */
/* ------------------------------------------------------------------ */

router.get('/e/:slug/editar', loadEvent, requireAuth, requireOwner, (req, res) => {
  res.render('events/form', {
    title: `Editar — ${req.event.title}`,
    mode: 'edit',
    errors: [],
    values: req.event,
    difficulties: DIFFICULTIES,
    bikeTypes: BIKE_TYPES
  });
});

router.post('/e/:slug/editar', loadEvent, requireAuth, requireOwner, async (req, res) => {
  const { event } = req;
  const { values, errors, accessPassword } = readEventForm(req.body);

  // Ao mudar para "protegido" é preciso palavra-passe; se já existia, pode ficar como está
  const needsNewPassword = values.visibility === 'password' && !event.access_password_hash;
  if (needsNewPassword && !accessPassword) {
    errors.push('Define a palavra-passe do evento.');
  }

  if (errors.length) {
    return res.status(400).render('events/form', {
      title: `Editar — ${event.title}`,
      mode: 'edit',
      errors,
      values: { ...event, ...values },
      difficulties: DIFFICULTIES,
      bikeTypes: BIKE_TYPES
    });
  }

  let access_password_hash = null;
  if (values.visibility === 'password') {
    access_password_hash = accessPassword
      ? await bcrypt.hash(accessPassword, 12)
      : event.access_password_hash;
  }

  updateEvent.run({ ...values, id: event.id, access_password_hash });
  res.flash('success', 'Passeio actualizado.');
  return res.redirect(`/e/${event.slug}`);
});

router.post('/e/:slug/apagar', loadEvent, requireAuth, requireOwner, (req, res) => {
  deleteEvent.run(req.event.id);
  res.flash('success', 'Passeio apagado.');
  return res.redirect('/painel');
});

/* ------------------------------------------------------------------ */
/* Auxiliares                                                          */
/* ------------------------------------------------------------------ */

/** Lê e valida os campos do formulário de evento. */
function readEventForm(body) {
  const values = {
    title: cleanText(body.title, 120),
    description: cleanText(body.description, 4000),
    start_date: cleanText(body.start_date, 10),
    start_time: cleanText(body.start_time, 5),
    end_date: cleanText(body.end_date, 10),
    meeting_point: cleanText(body.meeting_point, 200),
    distance_km: toNumberOrNull(body.distance_km),
    elevation_m: toNumberOrNull(body.elevation_m),
    difficulty: DIFFICULTIES.some((d) => d.value === body.difficulty) ? body.difficulty : 'moderado',
    bike_type: BIKE_TYPES.some((b) => b.value === body.bike_type) ? body.bike_type : 'qualquer',
    route_url: safeUrl(body.route_url),
    max_participants: toNumberOrNull(body.max_participants),
    visibility: body.visibility === 'password' ? 'password' : 'free'
  };
  const accessPassword = String(body.access_password ?? '').trim();
  const errors = [];

  if (values.title.length < 3) errors.push('Dá um nome ao passeio.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.start_date)) errors.push('Indica a data de início.');
  if (values.end_date && values.end_date < values.start_date) {
    errors.push('A data de fim é anterior à data de início.');
  }
  if (values.max_participants !== null && values.max_participants < 1) {
    errors.push('O limite de participantes tem de ser pelo menos 1.');
  }
  if (accessPassword && accessPassword.length < 4) {
    errors.push('A palavra-passe do evento precisa de pelo menos 4 caracteres.');
  }
  if (body.route_url && !values.route_url) {
    errors.push('O link do percurso tem de começar por http:// ou https://.');
  }

  return { values, errors, accessPassword };
}

/** Gera um slug garantidamente livre na base de dados. */
function uniqueSlug() {
  for (let i = 0; i < 10; i += 1) {
    const slug = generateSlug();
    if (!findEventBySlug.get(slug)) return slug;
  }
  return generateSlug(16);
}

/** Escapa um valor para CSV (aspas duplas e separadores). */
function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
