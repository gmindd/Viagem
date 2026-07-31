/**
 * Leitor de GPX suficiente para o que a app precisa: distância, desnível
 * acumulado e número de pontos. Trabalha por extracção directa dos pontos em
 * vez de construir a árvore XML toda — um GPX de uma etapa longa tem dezenas
 * de milhares de pontos e não vale a pena carregá-lo inteiro em memória.
 */

const TRKPT = /<(?:trkpt|rtept)\b[^>]*\blat\s*=\s*["']([-\d.]+)["'][^>]*\blon\s*=\s*["']([-\d.]+)["'][^>]*>([\s\S]*?)<\/(?:trkpt|rtept)>|<(?:trkpt|rtept)\b[^>]*\blat\s*=\s*["']([-\d.]+)["'][^>]*\blon\s*=\s*["']([-\d.]+)["'][^>]*\/>/gi;
const ELE = /<ele>\s*([-\d.]+)\s*<\/ele>/i;
const NAME = /<name>([\s\S]{0,200}?)<\/name>/i;

const EARTH_RADIUS_M = 6371000;

// Subidas abaixo deste valor são ruído do GPS, não desnível real
const ELEVATION_NOISE_M = 3;

/** Distância entre dois pontos geográficos, em metros (fórmula de haversine). */
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Analisa o conteúdo de um ficheiro GPX.
 * Devolve { valid, name, points, distanceKm, elevationM, error }.
 */
export function parseGpx(content) {
  if (typeof content !== 'string' || !content.includes('<gpx')) {
    return { valid: false, error: 'O ficheiro não parece ser um GPX válido.' };
  }

  let previous = null;
  let distanceM = 0;
  let elevationGain = 0;
  let lastElevation = null;
  let points = 0;
  const coords = [];

  TRKPT.lastIndex = 0;
  let match = TRKPT.exec(content);
  while (match !== null) {
    // O padrão tem duas alternativas (com corpo e auto-fechado)
    const lat = Number(match[1] ?? match[4]);
    const lon = Number(match[2] ?? match[5]);
    const body = match[3] ?? '';

    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      points += 1;
      coords.push([lat, lon]);

      if (previous) {
        distanceM += haversine(previous.lat, previous.lon, lat, lon);
      }
      previous = { lat, lon };

      const eleMatch = body ? ELE.exec(body) : null;
      if (eleMatch) {
        const ele = Number(eleMatch[1]);
        if (Number.isFinite(ele)) {
          if (lastElevation !== null && ele - lastElevation > ELEVATION_NOISE_M) {
            elevationGain += ele - lastElevation;
          }
          // Só actualiza a referência quando a variação sai do ruído,
          // senão pequenas oscilações somavam desnível que não existe.
          if (lastElevation === null || Math.abs(ele - lastElevation) > ELEVATION_NOISE_M) {
            lastElevation = ele;
          }
        }
      }
    }

    match = TRKPT.exec(content);
  }

  if (!points) {
    return { valid: false, error: 'O GPX não tem pontos de percurso.' };
  }

  const nameMatch = NAME.exec(content);

  return {
    valid: true,
    name: nameMatch ? decodeEntities(nameMatch[1].trim()) : '',
    points,
    distanceKm: Math.round((distanceM / 1000) * 10) / 10,
    elevationM: Math.round(elevationGain),
    track: coords
  };
}

/**
 * Reduz o traçado a um número de pontos manejável para desenhar no mapa,
 * mantendo a forma (algoritmo de Ramer–Douglas–Peucker).
 * Um GPX de uma etapa longa tem dezenas de milhares de pontos; enviá-los
 * todos para o browser tornaria o mapa lento sem se notar diferença.
 */
export function simplifyTrack(coords, tolerance = 0.00008, maxPoints = 3000) {
  if (coords.length <= 2) return coords;

  let simplified = douglasPeucker(coords, tolerance);

  // Se ainda for grande de mais, aumenta a tolerância em vez de cortar a eito,
  // para não perder curvas inteiras do percurso.
  let attempts = 0;
  let t = tolerance;
  while (simplified.length > maxPoints && attempts < 8) {
    t *= 2;
    simplified = douglasPeucker(coords, t);
    attempts += 1;
  }
  return simplified;
}

/** Distância perpendicular de um ponto ao segmento definido por dois outros. */
function perpendicularDistance([lat, lon], [lat1, lon1], [lat2, lon2]) {
  const dx = lat2 - lat1;
  const dy = lon2 - lon1;
  if (dx === 0 && dy === 0) return Math.hypot(lat - lat1, lon - lon1);
  const t = ((lat - lat1) * dx + (lon - lon1) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(lat - (lat1 + clamped * dx), lon - (lon1 + clamped * dy));
}

/** Implementação iterativa, para não estourar a pilha em percursos longos. */
function douglasPeucker(points, tolerance) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;

    for (let i = first + 1; i < last; i += 1) {
      const dist = perpendicularDistance(points[i], points[first], points[last]);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }

    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Distância acumulada, em km, ao longo do traçado.
 * Usada para dizer a que quilómetro fica um ponto de divisão da rota.
 */
export function cumulativeDistances(track) {
  const out = [0];
  for (let i = 1; i < track.length; i += 1) {
    const d = haversine(track[i - 1][0], track[i - 1][1], track[i][0], track[i][1]);
    out.push(out[i - 1] + d / 1000);
  }
  return out;
}

/** Caixa envolvente do traçado, para centrar o mapa e consultar POIs. */
export function boundingBox(track) {
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const [lat, lon] of track) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/** Descodifica as entidades XML que aparecem em nomes de percursos. */
function decodeEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}
