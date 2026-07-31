import crypto from 'node:crypto';

// Alfabeto sem caracteres ambíguos (0/O, 1/l/I) para links legíveis em voz alta
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Gera um identificador aleatório para o link de partilha de um evento. */
export function generateSlug(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
}

/** Validação simples de email (o formato completo RFC não acrescenta nada útil aqui). */
export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/** Normaliza o email para comparação e armazenamento (minúsculas, sem espaços). */
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Limpa e limita o comprimento de um campo de texto vindo de um formulário. */
export function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

/** Converte para número ou devolve null quando o campo vem vazio/inválido. */
export function toNumberOrNull(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Aceita apenas URLs http(s); tudo o resto vira string vazia (evita javascript:). */
export function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

// Nomes escritos à mão em vez de Intl: os dados de locale (ICU) variam entre
// instalações de Node e o pt-PT abreviado nem sempre existe no servidor.
const WEEKDAYS_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/**
 * Formata uma data ISO (YYYY-MM-DD) em pt-PT, ex.: "sáb, 12 set 2026".
 * Lida em UTC para que a data escrita seja sempre a que está guardada,
 * seja qual for o fuso do servidor.
 */
export function formatDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return `${WEEKDAYS_PT[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_PT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Formata um timestamp do SQLite ("YYYY-MM-DD HH:MM:SS", sempre em UTC)
 * para a hora local do servidor, ex.: "12 set, 14:05".
 * Define TZ=Europe/Lisbon no contentor para as horas baterem certo.
 */
export function formatDateTime(sqliteTimestamp) {
  if (!sqliteTimestamp) return '';
  const d = new Date(`${sqliteTimestamp.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return sqliteTimestamp;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS_PT[d.getMonth()]}, ${hh}:${mm}`;
}

/** Data de hoje no fuso do servidor, em formato ISO (YYYY-MM-DD). */
export function todayIso() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/**
 * True quando a data do evento já passou (comparação por dia, não por hora).
 * Usa a data local do servidor: com a data UTC, entre a meia-noite local e a
 * meia-noite UTC o "hoje" ficava trocado.
 */
export function isPastDate(isoDate) {
  if (!isoDate) return false;
  return isoDate < todayIso();
}

export const DIFFICULTIES = [
  { value: 'passeio', label: 'Passeio' },
  { value: 'moderado', label: 'Moderado' },
  { value: 'exigente', label: 'Exigente' },
  { value: 'epico', label: 'Épico' }
];

export const BIKE_TYPES = [
  { value: 'qualquer', label: 'Qualquer bicicleta' },
  { value: 'estrada', label: 'Estrada' },
  { value: 'gravel', label: 'Gravel' },
  { value: 'btt', label: 'BTT' },
  { value: 'cicloturismo', label: 'Cicloturismo' },
  { value: 'eletrica', label: 'Elétrica' }
];

export const STATUS_LABELS = {
  going: 'Vou',
  maybe: 'Talvez',
  out: 'Não vou'
};

/**
 * Fases da viagem. O organizador escolhe em que fase está, e a página do
 * evento muda de acordo: em "datas" mostra o calendário de disponibilidades,
 * em "preparacao" mostra os percursos.
 */
export const PHASES = [
  {
    value: 'datas',
    label: 'A combinar datas',
    short: 'Datas',
    description: 'Ainda não há data. Cada pessoa marca no calendário os dias em que pode.'
  },
  {
    value: 'propostas',
    label: 'A votar nas datas',
    short: 'Propostas',
    description: 'Recolhidas as disponibilidades, ficam algumas datas em cima da mesa para o grupo votar.'
  },
  {
    value: 'preparacao',
    label: 'Preparação',
    short: 'Preparação',
    description: 'Data escolhida. A tratar de percursos, dormidas e logística.'
  },
  {
    value: 'confirmado',
    label: 'Confirmado',
    short: 'Confirmado',
    description: 'Está tudo fechado. Só falta pedalar.'
  },
  {
    value: 'concluido',
    label: 'Concluído',
    short: 'Concluído',
    description: 'A viagem já aconteceu.'
  }
];

/** Quem vê o evento. */
export const VISIBILITIES = [
  {
    value: 'publico',
    label: 'Público',
    description: 'Aparece na lista de viagens do site e qualquer pessoa pode entrar.'
  },
  {
    value: 'privado',
    label: 'Privado',
    description: 'Aparece na lista, mas só se entra por convite, palavra-passe ou pedido aprovado.'
  },
  {
    value: 'secreto',
    label: 'Secreto',
    description: 'Não aparece em lado nenhum. Só quem receber o link o encontra.'
  }
];

/** Como é que alguém passa a fazer parte da viagem. */
export const JOIN_POLICIES = [
  {
    value: 'aberto',
    label: 'Entrada livre',
    description: 'Quem tiver conta entra directamente.'
  },
  {
    value: 'palavra_passe',
    label: 'Palavra-passe',
    description: 'É preciso saber a palavra-passe da viagem.'
  },
  {
    value: 'pedido',
    label: 'Pedido de adesão',
    description: 'A pessoa pede para entrar e o organizador aceita ou recusa.'
  }
];

/** Combinações permitidas: uma viagem pública não pode ter entrada condicionada. */
export function allowedJoinPolicies(visibility) {
  if (visibility === 'publico') return ['aberto'];
  return ['palavra_passe', 'pedido', 'aberto'];
}

/** Formata uma distância em km sem casas decimais desnecessárias. */
export function formatKm(value) {
  if (value === null || value === undefined) return '';
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

/**
 * Constrói a lista de dias entre duas datas ISO, para o calendário de
 * disponibilidades. Limitada a 120 dias para o calendário não ficar gigante.
 *
 * Toda a aritmética é feita em UTC de propósito: com meia-noite local,
 * toISOString() converte para UTC e num fuso a leste de Greenwich recua um
 * dia, deslocando o calendário inteiro (o dia 1 aparecia como 31 do mês
 * anterior e o último dia da janela deixava de ser seleccionável).
 */
export function dateRange(startIso, endIso, maxDays = 120) {
  if (!startIso || !endIso || endIso < startIso) return [];
  const days = [];
  const cursor = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return [];

  while (cursor <= end && days.length < maxDays) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Dia da semana de uma data ISO (0 = domingo), sem interferência do fuso. */
export function weekdayOf(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/** Agrupa uma lista de dias por mês, para o calendário desenhar um bloco por mês. */
export function groupByMonth(isoDates) {
  const months = new Map();
  for (const iso of isoDates) {
    const key = iso.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(iso);
  }
  return [...months.entries()].map(([key, days]) => {
    const [year, month] = key.split('-').map(Number);
    return {
      key,
      label: `${MONTHS_LONG_PT[month - 1]} de ${year}`,
      // Recuo até à coluna do primeiro dia REALMENTE mostrado, com a semana a
      // começar à segunda. Tem de partir de days[0] e não do dia 1 do mês: uma
      // janela que comece a meio do mês desalinhava a grelha toda, e o erro
      // passa despercebido quando calha começar no dia 1.
      offset: (weekdayOf(days[0]) + 6) % 7,
      days
    };
  });
}

const MONTHS_LONG_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

export const WEEKDAY_INITIALS_PT = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'];

/** Soma dias a uma data ISO, em UTC para não sofrer com fusos. */
export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Número de dias entre duas datas ISO, inclusive (12→14 = 3 dias). */
export function daysBetween(startIso, endIso) {
  const a = new Date(`${startIso}T00:00:00Z`).getTime();
  const b = new Date(`${endIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * Parte uma lista de datas ISO em blocos de dias consecutivos.
 * Ex.: [1,2,3,7,8] → [[1,2,3],[7,8]]
 */
export function consecutiveRuns(isoDates) {
  const sorted = [...new Set(isoDates)].sort();
  const runs = [];
  let current = [];

  for (const iso of sorted) {
    if (current.length && addDays(current[current.length - 1], 1) === iso) {
      current.push(iso);
    } else {
      if (current.length) runs.push(current);
      current = [iso];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

/** O bloco seguido mais longo dentro de uma lista de datas. */
export function longestRun(isoDates) {
  return consecutiveRuns(isoDates).reduce((max, run) => Math.max(max, run.length), 0);
}

/**
 * Verifica se as datas marcadas chegam para a viagem.
 * Devolve { ok, error } — com dias seguidos exige um bloco contínuo do
 * tamanho da viagem, não apenas o número total de dias.
 */
export function checkAvailabilityFits(isoDates, tripDays, continuous) {
  const dates = [...new Set(isoDates)];
  if (!tripDays || tripDays < 1) return { ok: true };
  if (dates.length === 0) return { ok: true };

  if (continuous) {
    const run = longestRun(dates);
    if (run < tripDays) {
      return {
        ok: false,
        error:
          `A viagem é de ${tripDays} dias seguidos. Marcaste ${dates.length} ` +
          `dia${dates.length === 1 ? '' : 's'}, mas o teu bloco mais longo é de ` +
          `${run} dia${run === 1 ? '' : 's'} seguidos. Marca pelo menos ${tripDays} dias consecutivos.`
      };
    }
    return { ok: true };
  }

  if (dates.length < tripDays) {
    return {
      ok: false,
      error:
        `A viagem é de ${tripDays} dias. Marcaste ${dates.length} — ` +
        `escolhe pelo menos mais ${tripDays - dates.length}.`
    };
  }
  return { ok: true };
}

/** Devolve o rótulo legível de um valor guardado numa lista de opções. */
export function labelFor(list, value) {
  return list.find((item) => item.value === value)?.label ?? value;
}
