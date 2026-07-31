/* =========================================================================
   Mapa do percurso: traçado GPX, pontos de interesse e divisão em etapas.
   Depende do Leaflet, servido localmente em /vendor/leaflet.
   ========================================================================= */

document.addEventListener('DOMContentLoaded', () => {
  const container = document.querySelector('[data-map]');
  if (container && window.L) initMap(container);
});

const POI_STYLE = {
  restaurante: { emoji: '🍽️', color: '#ea7317' },
  dormida: { emoji: '🛏️', color: '#7c3aed' },
  campismo: { emoji: '⛺', color: '#15803d' },
  agua: { emoji: '💧', color: '#0284c7' },
  bicicletas: { emoji: '🔧', color: '#525252' },
  mercearia: { emoji: '🛒', color: '#b45309' }
};

/** Arranca o mapa e carrega os dados do percurso. */
async function initMap(container) {
  const status = document.querySelector('[data-map-status]');
  const map = L.map(container, { scrollWheelZoom: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);

  // O scroll da página não deve ser roubado pelo mapa; com Ctrl faz zoom
  map.on('focus', () => map.scrollWheelZoom.enable());
  map.on('blur', () => map.scrollWheelZoom.disable());

  let data;
  try {
    const res = await fetch(container.dataset.mapUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    if (status) status.textContent = 'Não foi possível carregar o percurso.';
    console.error('mapa:', err);
    return;
  }

  if (!data.track || data.track.length < 2) {
    if (status) status.textContent = 'Este percurso não tem traçado para mostrar.';
    return;
  }

  const line = L.polyline(data.track, { color: '#0f766e', weight: 4, opacity: 0.85 }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [24, 24] });

  markEnds(map, data.track);

  const poiLayers = renderPois(map, data.pois);
  initPoiFilters(poiLayers);

  const splits = new SplitManager(map, container, data);
  splits.renderAll();

  if (status) {
    const total = data.pois.length;
    status.textContent = total
      ? `${total} pontos de interesse no mapa. Clica num marcador para veres os detalhes.`
      : 'Sem pontos de interesse ainda — usa "Procurar pontos" ao lado.';
  }
}

/** Marca visualmente o início e o fim do percurso. */
function markEnds(map, track) {
  const start = track[0];
  const end = track[track.length - 1];

  L.circleMarker(start, { radius: 7, color: '#15803d', fillColor: '#15803d', fillOpacity: 1 })
    .bindPopup('Início do percurso')
    .addTo(map);

  L.circleMarker(end, { radius: 7, color: '#b42318', fillColor: '#b42318', fillOpacity: 1 })
    .bindPopup('Fim do percurso')
    .addTo(map);
}

/** Desenha os pontos de interesse, um grupo por categoria. */
function renderPois(map, pois) {
  const layers = {};

  for (const poi of pois) {
    const style = POI_STYLE[poi.kind] || { emoji: '📍', color: '#5f6b66' };
    if (!layers[poi.kind]) layers[poi.kind] = L.layerGroup().addTo(map);

    const marker = L.marker([poi.lat, poi.lon], {
      icon: L.divIcon({
        className: 'poi-pin',
        html: `<span class="poi-pin__dot" style="border-color:${style.color}">${style.emoji}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      })
    });

    marker.bindPopup(poiPopup(poi));
    marker.addTo(layers[poi.kind]);
  }

  return layers;
}

/** Conteúdo do balão de um ponto de interesse. */
function poiPopup(poi) {
  const name = escapeHtml(poi.name || 'Sem nome');
  const details = poi.details ? `<br><span class="poi-popup__details">${escapeHtml(poi.details)}</span>` : '';
  const link = `https://www.openstreetmap.org/?mlat=${poi.lat}&mlon=${poi.lon}#map=18/${poi.lat}/${poi.lon}`;
  return `<strong>${name}</strong>${details}<br>
    <a href="${link}" target="_blank" rel="noopener noreferrer">Ver no OpenStreetMap</a>`;
}

/** Liga as caixas de filtro às camadas de cada categoria. */
function initPoiFilters(layers) {
  document.querySelectorAll('[data-poi-filter]').forEach((input) => {
    input.addEventListener('change', () => {
      const layer = layers[input.value];
      if (!layer) return;
      if (input.checked) layer.addTo(input.closest('[data-poi-filters]')._map || layer._map);
      else layer.remove();
    });
  });

  // Guarda a referência do mapa para poder voltar a adicionar a camada
  const holder = document.querySelector('[data-poi-filters]');
  if (holder) {
    const anyLayer = Object.values(layers)[0];
    if (anyLayer) holder._map = anyLayer._map;
  }
}

/**
 * Gere as divisões da rota: clicar no percurso com o modo ligado propõe
 * um corte, que é gravado no servidor e passa a ser visível para todos.
 */
class SplitManager {
  constructor(map, container, data) {
    this.map = map;
    this.container = container;
    this.track = data.track;
    this.splits = data.splits;
    this.markers = new Map();
    this.layer = L.layerGroup().addTo(map);
    this.cumulative = cumulativeKm(data.track);

    this.modeToggle = document.querySelector('[data-split-mode]');
    this.list = document.querySelector('[data-splits-list]');

    map.on('click', (event) => this.onMapClick(event));
    if (this.modeToggle) {
      this.modeToggle.addEventListener('change', () => {
        container.classList.toggle('map--splitting', this.modeToggle.checked);
      });
    }
  }

  /** Desenha as divisões já existentes. */
  renderAll() {
    this.layer.clearLayers();
    this.markers.clear();
    for (const split of this.splits) this.addMarker(split);
    this.renderList();
  }

  /** Um marcador losango por divisão proposta. */
  addMarker(split) {
    const marker = L.marker([split.lat, split.lon], {
      icon: L.divIcon({
        className: 'split-pin',
        html: `<span class="split-pin__mark${split.mine ? ' split-pin__mark--mine' : ''}">${split.positionKm.toFixed(0)}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      })
    });
    marker.bindPopup(this.splitPopup(split));
    marker.addTo(this.layer);
    this.markers.set(split.id, marker);
  }

  splitPopup(split) {
    const note = split.note ? `<br>${escapeHtml(split.note)}` : '';
    return `<strong>Divisão ao km ${split.positionKm.toFixed(1)}</strong><br>
      proposta por ${escapeHtml(split.author)}${note}`;
  }

  /** Ao clicar no mapa em modo de divisão, encontra o ponto do percurso mais próximo. */
  async onMapClick(event) {
    if (!this.modeToggle?.checked) return;

    const index = nearestPointIndex(this.track, event.latlng.lat, event.latlng.lng);
    if (index === -1) return;

    const [lat, lon] = this.track[index];
    const positionKm = this.cumulative[index];

    try {
      const res = await fetch(this.container.dataset.splitsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': this.container.dataset.csrf
        },
        body: JSON.stringify({ lat, lon, position_km: positionKm })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Não foi possível marcar a divisão.');

      this.splits.push(body);
      this.splits.sort((a, b) => a.positionKm - b.positionKm);
      this.renderAll();
    } catch (err) {
      window.alert(err.message);
    }
  }

  /** Apaga uma divisão e actualiza o mapa e a lista. */
  async remove(id) {
    try {
      const res = await fetch(`${this.container.dataset.splitsUrl}/${id}/apagar`, {
        method: 'POST',
        headers: { 'x-csrf-token': this.container.dataset.csrf }
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Não foi possível apagar.');
      }
      this.splits = this.splits.filter((s) => s.id !== id);
      this.renderAll();
    } catch (err) {
      window.alert(err.message);
    }
  }

  /** Lista lateral com as etapas que as divisões produzem. */
  renderList() {
    if (!this.list) return;
    this.list.textContent = '';

    if (!this.splits.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Ainda ninguém propôs divisões.';
      this.list.appendChild(li);
      return;
    }

    for (const split of this.splits) {
      const li = document.createElement('li');
      li.className = 'split';

      const body = document.createElement('div');
      body.className = 'split__body';

      const title = document.createElement('p');
      title.className = 'split__title';
      title.textContent = `km ${split.positionKm.toFixed(1)}`;

      const author = document.createElement('p');
      author.className = 'split__author';
      author.textContent = split.mine ? 'proposta tua' : `por ${split.author}`;

      body.append(title, author);
      li.appendChild(body);

      const focus = document.createElement('button');
      focus.type = 'button';
      focus.className = 'link-button';
      focus.textContent = 'Ver';
      focus.addEventListener('click', () => {
        this.map.setView([split.lat, split.lon], 14);
        this.markers.get(split.id)?.openPopup();
      });
      li.appendChild(focus);

      if (split.mine) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'link-button';
        del.textContent = 'Apagar';
        del.addEventListener('click', () => this.remove(split.id));
        li.appendChild(del);
      }

      this.list.appendChild(li);
    }
  }
}

/** Distância acumulada em km ao longo do traçado. */
function cumulativeKm(track) {
  const out = [0];
  for (let i = 1; i < track.length; i += 1) {
    out.push(out[i - 1] + haversineKm(track[i - 1], track[i]));
  }
  return out;
}

/** Distância entre dois pontos [lat, lon], em quilómetros. */
function haversineKm([lat1, lon1], [lat2, lon2]) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** Índice do ponto do percurso mais próximo de uma coordenada clicada. */
function nearestPointIndex(track, lat, lon) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < track.length; i += 1) {
    const d = (track[i][0] - lat) ** 2 + (track[i][1] - lon) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Escapa texto antes de o pôr no HTML dos balões. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
