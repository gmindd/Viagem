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

/** Formata uma data ISO (YYYY-MM-DD) em pt-PT, ex.: "sáb, 12 set 2026". */
export function formatDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return `${WEEKDAYS_PT[d.getDay()]}, ${d.getDate()} ${MONTHS_PT[d.getMonth()]} ${d.getFullYear()}`;
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

/** True quando a data do evento já passou (comparação por dia, não por hora). */
export function isPastDate(isoDate) {
  if (!isoDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return isoDate < today;
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

/** Devolve o rótulo legível de um valor guardado numa lista de opções. */
export function labelFor(list, value) {
  return list.find((item) => item.value === value)?.label ?? value;
}
