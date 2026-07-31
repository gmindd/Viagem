import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { db, UPLOADS_DIR } from '../lib/db.js';
import { parseGpx, simplifyTrack, cumulativeDistances } from '../lib/gpx.js';
import { getPois, cachedPois, POI_KINDS } from '../lib/pois.js';
import { cleanText, toNumberOrNull, safeUrl } from '../lib/helpers.js';
import { verifyPendingCsrf } from '../middleware/csrf.js';
import { requireOpen, requireMember, requireOwner } from '../middleware/event-guards.js';

export const router = express.Router({ mergeParams: true });

const MAX_GPX_BYTES = 10 * 1024 * 1024;

// Guarda em memória para poder validar o GPX antes de escrever no disco:
// ficheiros inválidos nunca chegam a ocupar espaço.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_GPX_BYTES, files: 1 }
});

/**
 * Lê um ficheiro do formulário e só depois valida o token CSRF — por esta
 * ordem, porque em multipart o token vem dentro do corpo que o multer lê.
 * Usar sempre este par em vez de multer directamente: assim nenhuma rota de
 * upload pode ficar sem protecção CSRF por esquecimento.
 */
function uploadWithCsrf(field) {
  return [upload.single(field), verifyPendingCsrf];
}

const insertRoute = db.prepare(
  `INSERT INTO event_routes (event_id, day_number, title, notes, file_name, original_name,
                             external_url, distance_km, elevation_m, size_bytes, uploaded_by,
                             position, track_json)
   VALUES (@event_id, @day_number, @title, @notes, @file_name, @original_name,
           @external_url, @distance_km, @elevation_m, @size_bytes, @uploaded_by,
           @position, @track_json)`
);

/* --- Divisão da rota em etapas ------------------------------------- */

const insertSplit = db.prepare(
  `INSERT INTO route_splits (route_id, user_id, position_km, lat, lon, note)
   VALUES (@route_id, @user_id, @position_km, @lat, @lon, @note)`
);
const deleteSplit = db.prepare('DELETE FROM route_splits WHERE id = ? AND route_id = ?');
const findSplit = db.prepare('SELECT * FROM route_splits WHERE id = ? AND route_id = ?');
const listSplits = db.prepare(
  `SELECT s.*, u.name AS author_name
   FROM route_splits s JOIN users u ON u.id = s.user_id
   WHERE s.route_id = ? ORDER BY s.position_km ASC`
);
const countSplitsByUser = db.prepare(
  'SELECT COUNT(*) AS n FROM route_splits WHERE route_id = ? AND user_id = ?'
);

/** Quantas propostas de divisão tem cada percurso, para o resumo. */
export const countSplits = db.prepare(
  'SELECT COUNT(*) AS n FROM route_splits WHERE route_id = ?'
);
const findRoute = db.prepare('SELECT * FROM event_routes WHERE id = ? AND event_id = ?');
const deleteRoute = db.prepare('DELETE FROM event_routes WHERE id = ?');
const nextPosition = db.prepare(
  'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM event_routes WHERE event_id = ?'
);

export const listRoutes = db.prepare(
  `SELECT r.*, u.name AS uploader_name
   FROM event_routes r LEFT JOIN users u ON u.id = r.uploaded_by
   WHERE r.event_id = ?
   ORDER BY CASE WHEN r.day_number IS NULL THEN 1 ELSE 0 END, r.day_number ASC, r.position ASC`
);

/** Totais de todos os percursos de um evento, para o resumo da viagem. */
export const routeTotals = db.prepare(
  `SELECT COUNT(*) AS n,
          COALESCE(SUM(distance_km), 0) AS distance_km,
          COALESCE(SUM(elevation_m), 0) AS elevation_m,
          COUNT(DISTINCT day_number) AS days
   FROM event_routes WHERE event_id = ?`
);

/** Caminho absoluto do ficheiro GPX de um percurso. */
function gpxPathFor(eventId, fileName) {
  return path.join(UPLOADS_DIR, String(eventId), fileName);
}

/** Apaga do disco o ficheiro de um percurso, ignorando o que já não existe. */
export function removeGpxFile(eventId, fileName) {
  if (!fileName) return;
  try {
    fs.unlinkSync(gpxPathFor(eventId, fileName));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Não foi possível apagar o GPX:', err.message);
  }
}

/** Apaga a pasta de GPX de um evento (usado quando o evento é apagado). */
export function removeEventGpxDir(eventId) {
  fs.rmSync(path.join(UPLOADS_DIR, String(eventId)), { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Adicionar percurso                                                  */
/* ------------------------------------------------------------------ */

router.post('/percursos', requireOwner, uploadWithCsrf('gpx'), (req, res) => {
  const { event } = req;
  const title = cleanText(req.body.title, 120);
  const notes = cleanText(req.body.notes, 500);
  const dayNumber = toNumberOrNull(req.body.day_number);
  const externalUrl = safeUrl(req.body.external_url);
  const file = req.file;

  if (!file && !externalUrl) {
    res.flash('error', 'Escolhe um ficheiro GPX ou cola um link do percurso.');
    return res.redirect(`/e/${event.slug}#percursos`);
  }

  let parsed = null;
  if (file) {
    parsed = parseGpx(file.buffer.toString('utf8'));
    if (!parsed.valid) {
      res.flash('error', parsed.error);
      return res.redirect(`/e/${event.slug}#percursos`);
    }
  }

  // Nome no disco gerado por nós: o nome original nunca toca no sistema de ficheiros
  let fileName = '';
  if (file) {
    fileName = `${crypto.randomBytes(12).toString('hex')}.gpx`;
    const dir = path.join(UPLOADS_DIR, String(event.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), file.buffer);
  }

  // Guarda o traçado já simplificado: o mapa lê-o daqui em vez de reabrir
  // e reprocessar o ficheiro GPX a cada visita à página.
  const track = parsed?.track?.length ? simplifyTrack(parsed.track) : null;

  insertRoute.run({
    event_id: event.id,
    day_number: dayNumber !== null && dayNumber >= 1 ? Math.floor(dayNumber) : null,
    title: title || parsed?.name || 'Percurso',
    notes,
    file_name: fileName,
    original_name: file ? cleanText(file.originalname, 200) : '',
    external_url: externalUrl,
    distance_km: parsed?.distanceKm ?? toNumberOrNull(req.body.distance_km),
    elevation_m: parsed?.elevationM ?? toNumberOrNull(req.body.elevation_m),
    size_bytes: file?.size ?? null,
    uploaded_by: req.user.id,
    position: nextPosition.get(event.id).p,
    track_json: track ? JSON.stringify(track) : null
  });

  res.flash('success', 'Percurso adicionado.');
  return res.redirect(`/e/${event.slug}#percursos`);
});

/* ------------------------------------------------------------------ */
/* Descarregar e apagar                                                */
/* ------------------------------------------------------------------ */

router.get('/percursos/:id/gpx', requireOpen, requireMember, (req, res) => {
  const route = findRoute.get(Number(req.params.id), req.event.id);
  if (!route || !route.file_name) {
    return res.status(404).render('error', {
      title: 'Percurso não encontrado',
      status: 404,
      message: 'Este percurso já não existe.'
    });
  }

  const download = route.original_name || `${route.title.replace(/[^\w.-]+/g, '-')}.gpx`;
  return res.download(gpxPathFor(req.event.id, route.file_name), download);
});

router.post('/percursos/:id/apagar', requireOwner, (req, res) => {
  const route = findRoute.get(Number(req.params.id), req.event.id);
  if (route) {
    removeGpxFile(req.event.id, route.file_name);
    deleteRoute.run(route.id);
    res.flash('success', 'Percurso removido.');
  }
  return res.redirect(`/e/${req.event.slug}#percursos`);
});

/* ------------------------------------------------------------------ */
/* Mapa: traçado, divisões e pontos de interesse                       */
/* ------------------------------------------------------------------ */

/**
 * Tudo o que o mapa precisa, num só pedido: traçado, divisões propostas
 * e pontos de interesse já em cache. Os POIs só são actualizados a pedido,
 * para não consultar a Overpass em cada abertura da página.
 */
router.get('/percursos/:id/mapa.json', requireOpen, requireMember, (req, res) => {
  const route = findRoute.get(Number(req.params.id), req.event.id);
  if (!route) return res.status(404).json({ error: 'Percurso não encontrado.' });

  let track = [];
  try {
    track = route.track_json ? JSON.parse(route.track_json) : [];
  } catch {
    track = [];
  }

  res.json({
    route: {
      id: route.id,
      title: route.title,
      distanceKm: route.distance_km,
      elevationM: route.elevation_m,
      dayNumber: route.day_number
    },
    track,
    splits: listSplits.all(route.id).map((s) => ({
      id: s.id,
      positionKm: s.position_km,
      lat: s.lat,
      lon: s.lon,
      note: s.note,
      author: s.author_name,
      mine: s.user_id === req.user.id
    })),
    pois: cachedPois(route.id).map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      details: p.details,
      source: p.source
    })),
    kinds: POI_KINDS.map(({ value, label, emoji }) => ({ value, label, emoji })),
    canEditPois: req.isOwner
  });
});

/** Vai buscar pontos de interesse ao OpenStreetMap ao longo do percurso. */
router.post('/percursos/:id/pois', requireOpen, requireMember, async (req, res) => {
  const route = findRoute.get(Number(req.params.id), req.event.id);
  if (!route) {
    res.flash('error', 'Percurso não encontrado.');
    return res.redirect(`/e/${req.event.slug}#percursos`);
  }

  const radius = Math.min(3000, Math.max(200, Number(req.body.radius) || 800));
  const { pois, error } = await getPois(route, { radiusM: radius, force: true });

  res.flash(
    error ? 'error' : 'success',
    error || `Encontrámos ${pois.length} pontos de interesse até ${radius} m do percurso.`
  );
  return res.redirect(`/e/${req.event.slug}/percursos/${route.id}/mapa`);
});

/** Página do mapa de um percurso. */
router.get('/percursos/:id/mapa', requireOpen, requireMember, (req, res) => {
  const route = findRoute.get(Number(req.params.id), req.event.id);
  if (!route) {
    return res.status(404).render('error', {
      title: 'Percurso não encontrado',
      status: 404,
      message: 'Este percurso já não existe.'
    });
  }

  res.render('events/map', {
    title: `${route.title} — mapa`,
    event: req.event,
    route,
    isOwner: req.isOwner,
    splits: listSplits.all(route.id),
    poiCount: cachedPois(route.id).length,
    kinds: POI_KINDS,
    hasTrack: Boolean(route.track_json)
  });
});

/* --- Divisões propostas por cada participante ---------------------- */

const MAX_SPLITS_PER_PERSON = 20;

router.post('/percursos/:id/divisoes', requireOpen, requireMember, (req, res) => {
  const route = findRoute.get(Number(req.params.id), req.event.id);
  if (!route) return res.status(404).json({ error: 'Percurso não encontrado.' });

  const lat = Number(req.body.lat);
  const lon = Number(req.body.lon);
  const positionKm = Number(req.body.position_km);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(positionKm)) {
    return res.status(400).json({ error: 'Ponto inválido.' });
  }
  if (countSplitsByUser.get(route.id, req.user.id).n >= MAX_SPLITS_PER_PERSON) {
    return res.status(400).json({ error: `Já marcaste o máximo de ${MAX_SPLITS_PER_PERSON} divisões.` });
  }

  const info = insertSplit.run({
    route_id: route.id,
    user_id: req.user.id,
    position_km: Math.round(positionKm * 100) / 100,
    lat,
    lon,
    note: cleanText(req.body.note, 160)
  });

  return res.status(201).json({
    id: info.lastInsertRowid,
    positionKm: Math.round(positionKm * 100) / 100,
    lat,
    lon,
    note: cleanText(req.body.note, 160),
    author: req.user.name,
    mine: true
  });
});

router.post('/percursos/:id/divisoes/:splitId/apagar', requireOpen, requireMember, (req, res) => {
  const route = findRoute.get(Number(req.params.id), req.event.id);
  const split = route ? findSplit.get(Number(req.params.splitId), route.id) : null;

  // Cada pessoa apaga as suas; quem organiza pode apagar qualquer uma
  if (!split || (split.user_id !== req.user.id && !req.isOwner)) {
    return res.status(403).json({ error: 'Não podes apagar esta divisão.' });
  }

  deleteSplit.run(split.id, route.id);
  return res.json({ ok: true });
});

/** Erros do multer (ficheiro grande demais) em mensagem legível. */
export function gpxUploadErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'O ficheiro GPX é demasiado grande (máximo 10 MB).'
        : 'Não foi possível ler o ficheiro enviado.';
    res.flash('error', message);
    return res.redirect(req.event ? `/e/${req.event.slug}#percursos` : '/painel');
  }
  return next(err);
}
