-- Esquema da base de dados (SQLite)
-- Executado em cada arranque; todas as instruções são idempotentes.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Utilizadores registados (email + palavra-passe, nome e contactos)
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  phone          TEXT    NOT NULL DEFAULT '',
  contact_other  TEXT    NOT NULL DEFAULT '',
  bio            TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Eventos (passeios). visibility: 'free' = qualquer pessoa com o link entra,
-- 'password' = pede palavra-passe do evento antes de mostrar detalhes.
CREATE TABLE IF NOT EXISTS events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug                 TEXT    NOT NULL UNIQUE,
  title                TEXT    NOT NULL,
  description          TEXT    NOT NULL DEFAULT '',
  start_date           TEXT    NOT NULL,
  start_time           TEXT    NOT NULL DEFAULT '',
  end_date             TEXT    NOT NULL DEFAULT '',
  meeting_point        TEXT    NOT NULL DEFAULT '',
  distance_km          REAL,
  elevation_m          INTEGER,
  difficulty           TEXT    NOT NULL DEFAULT 'moderado',
  bike_type            TEXT    NOT NULL DEFAULT 'qualquer',
  route_url            TEXT    NOT NULL DEFAULT '',
  max_participants     INTEGER,
  visibility           TEXT    NOT NULL DEFAULT 'free',
  access_password_hash TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_owner ON events(owner_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_date);

-- Inscrições. status: 'going' | 'maybe' | 'out'
CREATE TABLE IF NOT EXISTS participants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  status     TEXT    NOT NULL DEFAULT 'going',
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id);

-- Mural de mensagens de cada evento
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_event ON comments(event_id);

-- Sessões (store do express-session sobre better-sqlite3)
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
