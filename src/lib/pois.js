import { db } from './db.js';
import { boundingBox } from './gpx.js';

/**
 * Pontos de interesse ao longo de um percurso, vindos do OpenStreetMap
 * através da Overpass API.
 *
 * Os resultados ficam guardados na base de dados: a Overpass é um serviço
 * comunitário gratuito e não deve ser consultada a cada visita à página.
 */

/**
 * Servidores Overpass, tentados por ordem. São instâncias comunitárias que
 * ficam sobrecarregadas com frequência, por isso ter alternativas evita que
 * uma indisponibilidade momentânea pareça uma avaria da app.
 */
const OVERPASS_ENDPOINTS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter'
    ];

const CACHE_HOURS = 24 * 7;
const REQUEST_TIMEOUT_MS = 70000;
const OVERPASS_QUERY_TIMEOUT_S = 60;
const MAX_RESULTS = 800;

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
 * Etiquetas OSM agrupadas pela chave a que pertencem. Agrupar por chave em vez
 * de por categoria da app reduz para três os varrimentos que o servidor faz —
 * com uma cláusula por categoria eram seis, cada uma a percorrer o percurso
 * inteiro, e o pedido rebentava o tempo limite em percursos longos.
 */
const OSM_FILTERS = [
  ['amenity', ['restaurant', 'cafe', 'fast_food', 'drinking_water', 'water_point']],
  ['tourism', ['hotel', 'hostel', 'guest_house', 'motel', 'alpine_hut', 'chalet', 'camp_site', 'caravan_site']],
  ['shop', ['bicycle', 'supermarket', 'convenience', 'bakery']]
];

/**
 * Reduz o percurso a pontos espaçados por distância, e não de N em N índices.
 * O `around` da Overpass trata a lista de coordenadas como uma linha contínua,
 * por isso bastam pontos a cada ~1 km para o corredor de procura ficar fechado;
 * mandar centenas de pontos só torna o pedido caro sem melhorar o resultado.
 */
function sampleByDistance(track, spacingKm = 1, maxPoints = 120) {
  if (track.length <= 2) return track;

  const out = [track[0]];
  let accumulated = 0;

  for (let i = 1; i < track.length; i += 1) {
    accumulated += haversineKm(track[i - 1], track[i]);
    if (accumulated >= spacingKm) {
      out.push(track[i]);
      accumulated = 0;
    }
  }
  if (out[out.length - 1] !== track[track.length - 1]) out.push(track[track.length - 1]);

  // Se ainda for demasiado, aumenta o espaçamento em vez de cortar o fim
  if (out.length > maxPoints) {
    const step = Math.ceil(out.length / maxPoints);
    return out.filter((_, i) => i % step === 0 || i === out.length - 1);
  }
  return out;
}

/** Distância entre dois pontos [lat, lon], em km. */
function haversineKm([lat1, lon1], [lat2, lon2]) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * Constrói a consulta Overpass. Em vez da caixa envolvente toda — que num
 * percurso longo apanharia cidades inteiras fora da rota — pede o que está a
 * menos de `radius` metros da linha do percurso.
 *
 * Usa `nwr` e `out center` para apanhar também o que está mapeado como
 * polígono: muitos restaurantes e hotéis são edifícios, não pontos, e uma
 * consulta só a `node` deixava-os todos de fora.
 */
function buildQuery(track, radiusM) {
  const sampled = sampleByDistance(track);
  const line = sampled.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(',');

  const clauses = OSM_FILTERS.map(
    ([key, values]) => `nwr(around:${radiusM},${line})["${key}"~"^(${values.join('|')})$"];`
  ).join('\n  ');

  return `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];
(
  ${clauses}
);
out center ${MAX_RESULTS};`;
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

  const query = buildQuery(track, radiusM);
  const attempt = await queryOverpass(query);

  if (!attempt.ok) {
    return { pois: cached, fromCache: true, error: attempt.error };
  }

  try {
    const elements = Array.isArray(attempt.data.elements) ? attempt.data.elements : [];

    // Substitui o que veio do OSM, preservando o que foi acrescentado à mão
    const save = db.transaction(() => {
      clearOsmPois.run(route.id);
      for (const el of elements) {
        const kind = classify(el.tags);
        if (!kind) continue;

        // Pontos trazem lat/lon; polígonos trazem o centróide em `center`
        const lat = Number.isFinite(el.lat) ? el.lat : el.center?.lat;
        const lon = Number.isFinite(el.lon) ? el.lon : el.center?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        insertPoi.run({
          route_id: route.id,
          external_id: `osm:${el.type}/${el.id}`,
          kind,
          name: String(el.tags?.name ?? '').slice(0, 160),
          lat,
          lon,
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
    console.error(`[pois] falhou a gravação: ${err.message}`);
    return {
      pois: cached,
      fromCache: true,
      error: 'Recebemos os pontos mas não foi possível guardá-los.'
    };
  }
}

/**
 * Envia a consulta, tentando os servidores por ordem até um responder.
 * Devolve { ok, data } ou { ok: false, error } com uma mensagem que explica
 * o que aconteceu — "não deu" sem motivo não ajuda ninguém a decidir se deve
 * tentar outra vez ou reduzir o raio de procura.
 */
async function queryOverpass(query) {
  const problems = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // A Overpass pede que os clientes se identifiquem
          'User-Agent': 'Viagem/1.0 (organizador de viagens de bicicleta)'
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        return { ok: true, data: await res.json() };
      }

      // 429 e 504 são o servidor a dizer "estou cheio"; vale a pena o seguinte
      problems.push(`${hostOf(endpoint)}: HTTP ${res.status}`);
      console.error(`[pois] ${endpoint} respondeu ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      const reason = err.name === 'AbortError' ? 'demorou demasiado' : err.message;
      problems.push(`${hostOf(endpoint)}: ${reason}`);
      console.error(`[pois] ${endpoint} falhou: ${reason}`);
    }
  }

  const overloaded = problems.some((p) => /429|504|demorou/.test(p));
  return {
    ok: false,
    error: overloaded
      ? 'Os servidores de mapas estão sobrecarregados neste momento. Tenta daqui a uns minutos, ou reduz o raio de procura.'
      : `Não foi possível contactar o serviço de mapas (${problems[0] ?? 'sem resposta'}).`
  };
}

/** Nome do servidor, para as mensagens de erro não mostrarem o URL inteiro. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Só o que está em cache, sem tocar na rede. */
export function cachedPois(routeId) {
  return listPoisFor.all(routeId);
}

export { boundingBox };
