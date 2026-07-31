import { db } from './db.js';
import { boundingBox } from './gpx.js';

/**
 * Pontos de interesse ao longo de um percurso, vindos do OpenStreetMap
 * através da Overpass API.
 *
 * Os resultados ficam guardados na base de dados: a Overpass é um serviço
 * comunitário gratuito e não deve ser consultada a cada visita à página.
 */

const OVERPASS_ENDPOINT = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const CACHE_HOURS = 24 * 7;
const REQUEST_TIMEOUT_MS = 25000;

/** Categorias procuradas, com a etiqueta OSM correspondente. */
export const POI_KINDS = [
  { value: 'restaurante', label: 'Restaurantes', emoji: '🍽️', query: 'amenity~"^(restaurant|cafe|fast_food)$"' },
  { value: 'dormida', label: 'Dormidas', emoji: '🛏️', query: 'tourism~"^(hotel|hostel|guest_house|motel|alpine_hut|chalet)$"' },
  { value: 'campismo', label: 'Campismo', emoji: '⛺', query: 'tourism~"^(camp_site|caravan_site)$"' },
  { value: 'agua', label: 'Água', emoji: '💧', query: 'amenity~"^(drinking_water|water_point)$"' },
  { value: 'bicicletas', label: 'Oficinas', emoji: '🔧', query: 'shop~"^(bicycle)$"' },
  { value: 'mercearia', label: 'Mercearias', emoji: '🛒', query: 'shop~"^(supermarket|convenience|bakery)$"' }
];

// O índice único de external_id é parcial (só quando não é nulo), por isso o
// upsert tem de repetir a mesma condição — sem ela o SQLite não reconhece o
// alvo do conflito e recusa preparar a instrução.
const insertPoi = db.prepare(
  `INSERT INTO route_pois (route_id, external_id, kind, name, lat, lon, details, source, added_by)
   VALUES (@route_id, @external_id, @kind, @name, @lat, @lon, @details, @source, @added_by)
   ON CONFLICT(route_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
     name = @name, lat = @lat, lon = @lon, details = @details, kind = @kind`
);
const listPoisFor = db.prepare('SELECT * FROM route_pois WHERE route_id = ? ORDER BY kind, name');
const clearOsmPois = db.prepare("DELETE FROM route_pois WHERE route_id = ? AND source = 'osm'");
const touchRoute = db.prepare("UPDATE event_routes SET pois_fetched_at = datetime('now') WHERE id = ?");

/** A cache ainda serve? */
function cacheIsFresh(route) {
  if (!route.pois_fetched_at) return false;
  const fetched = new Date(`${route.pois_fetched_at.replace(' ', 'T')}Z`).getTime();
  return Date.now() - fetched < CACHE_HOURS * 60 * 60 * 1000;
}

/**
 * Constrói a consulta Overpass. Em vez da caixa envolvente toda — que num
 * percurso longo apanharia cidades inteiras fora da rota — pede o que está a
 * menos de `radius` metros da linha do percurso.
 */
function buildQuery(track, radiusM) {
  // A Overpass tem limite de tamanho de pedido: reduz-se o traçado a um
  // número de pontos suficiente para desenhar o corredor de procura.
  const step = Math.max(1, Math.ceil(track.length / 300));
  const sampled = track.filter((_, i) => i % step === 0);
  const line = sampled.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(',');

  const clauses = POI_KINDS.map(
    (kind) => `node(around:${radiusM},${line})[${kind.query}];`
  ).join('\n  ');

  return `[out:json][timeout:25];
(
  ${clauses}
);
out body ${600};`;
}

/** Descobre a que categoria pertence um nó devolvido pela Overpass. */
function classify(tags) {
  if (!tags) return null;
  if (['restaurant', 'cafe', 'fast_food'].includes(tags.amenity)) return 'restaurante';
  if (['hotel', 'hostel', 'guest_house', 'motel', 'alpine_hut', 'chalet'].includes(tags.tourism)) return 'dormida';
  if (['camp_site', 'caravan_site'].includes(tags.tourism)) return 'campismo';
  if (['drinking_water', 'water_point'].includes(tags.amenity)) return 'agua';
  if (tags.shop === 'bicycle') return 'bicicletas';
  if (['supermarket', 'convenience', 'bakery'].includes(tags.shop)) return 'mercearia';
  return null;
}

/** Junta morada, telefone e horário num texto curto para o balão do mapa. */
function detailsFrom(tags) {
  const parts = [];
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  if (street) parts.push(street);
  if (tags['addr:city']) parts.push(tags['addr:city']);
  if (tags.phone || tags['contact:phone']) parts.push(tags.phone || tags['contact:phone']);
  if (tags.opening_hours) parts.push(tags.opening_hours);
  return parts.join(' · ').slice(0, 300);
}

/**
 * Devolve os POIs de um percurso, indo buscá-los ao OpenStreetMap se a cache
 * estiver velha. Nunca rebenta: se a Overpass falhar, devolve o que houver
 * em cache e assinala o erro.
 */
export async function getPois(route, { radiusM = 800, force = false } = {}) {
  const cached = listPoisFor.all(route.id);

  if (!force && cacheIsFresh(route)) {
    return { pois: cached, fromCache: true };
  }
  if (!route.track_json) {
    return { pois: cached, fromCache: true, error: 'Este percurso não tem traçado para procurar à volta.' };
  }

  let track;
  try {
    track = JSON.parse(route.track_json);
  } catch {
    return { pois: cached, fromCache: true, error: 'O traçado guardado está ilegível.' };
  }
  if (!Array.isArray(track) || track.length < 2) {
    return { pois: cached, fromCache: true, error: 'Traçado insuficiente.' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // A Overpass pede que os clientes se identifiquem
        'User-Agent': 'Viagem/1.0 (organizador de viagens de bicicleta)'
      },
      body: new URLSearchParams({ data: buildQuery(track, radiusM) }).toString(),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.error(`[pois] Overpass respondeu ${res.status}`);
      return { pois: cached, fromCache: true, error: 'O serviço de mapas não respondeu. Mostramos o que já tínhamos.' };
    }

    const data = await res.json();
    const elements = Array.isArray(data.elements) ? data.elements : [];

    // Substitui o que veio do OSM, preservando o que foi acrescentado à mão
    const save = db.transaction(() => {
      clearOsmPois.run(route.id);
      for (const el of elements) {
        const kind = classify(el.tags);
        if (!kind || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
        insertPoi.run({
          route_id: route.id,
          external_id: `osm:${el.type}/${el.id}`,
          kind,
          name: String(el.tags?.name ?? '').slice(0, 160),
          lat: el.lat,
          lon: el.lon,
          details: detailsFrom(el.tags ?? {}),
          source: 'osm',
          added_by: null
        });
      }
      touchRoute.run(route.id);
    });
    save();

    return { pois: listPoisFor.all(route.id), fromCache: false };
  } catch (err) {
    console.error(`[pois] falhou a consulta: ${err.message}`);
    return {
      pois: cached,
      fromCache: true,
      error: 'Não foi possível actualizar os pontos de interesse agora.'
    };
  }
}

/** Só o que está em cache, sem tocar na rede. */
export function cachedPois(routeId) {
  return listPoisFor.all(routeId);
}

export { boundingBox };
