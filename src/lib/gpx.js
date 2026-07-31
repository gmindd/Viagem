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

  TRKPT.lastIndex = 0;
  let match = TRKPT.exec(content);
  while (match !== null) {
    // O padrão tem duas alternativas (com corpo e auto-fechado)
    const lat = Number(match[1] ?? match[4]);
    const lon = Number(match[2] ?? match[5]);
    const body = match[3] ?? '';

    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      points += 1;

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
    elevationM: Math.round(elevationGain)
  };
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
