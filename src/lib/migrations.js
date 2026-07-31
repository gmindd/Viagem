import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Auxiliares seguros                                                  */
/* ------------------------------------------------------------------ */

/** True se a tabela existir na base de dados. */
function hasTable(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

/** True se a coluna já existir — o SQLite não tem ADD COLUMN IF NOT EXISTS. */
function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/**
 * Acrescenta uma coluna só se ainda não existir.
 * ADD COLUMN nunca reescreve a tabela nem toca nas linhas existentes,
 * por isso é sempre seguro para dados já gravados.
 */
function addColumn(db, table, column, definition) {
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/* ------------------------------------------------------------------ */
/* Migrações                                                           */
/* ------------------------------------------------------------------ */

/**
 * Lista ordenada de migrações. Cada uma corre uma única vez, dentro de uma
 * transacção, e a versão aplicada fica em PRAGMA user_version.
 *
 * Regra: uma migração só acrescenta (tabelas, colunas, índices) ou transforma
 * dados existentes. Nunca apaga colunas nem tabelas com dados de utilizadores.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'Esquema inicial',
    up(db) {
      // schema.sql é idempotente: em bases de dados criadas antes das migrações
      // as tabelas já existem e este passo não altera nada.
      db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    }
  },

  {
    version: 2,
    name: 'Fases do evento, visibilidade em três níveis, disponibilidades, GPX, convites e pedidos',
    up(db) {
      /* --- Fases -------------------------------------------------- */
      // datas → recolher disponibilidades; preparacao → planear percursos;
      // confirmado → tudo fechado; concluido → já aconteceu.
      addColumn(db, 'events', 'phase', "TEXT NOT NULL DEFAULT 'preparacao'");

      // Janela de datas mostrada no calendário de disponibilidades
      addColumn(db, 'events', 'availability_start', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'events', 'availability_end', "TEXT NOT NULL DEFAULT ''");

      /* --- Visibilidade e forma de adesão ------------------------- */
      // visibility: publico | privado | secreto
      // join_policy: aberto | palavra_passe | pedido
      addColumn(db, 'events', 'join_policy', "TEXT NOT NULL DEFAULT 'aberto'");

      // Converte os valores antigos preservando a privacidade actual.
      // Antes não havia listagem pública: qualquer evento só era acessível a
      // quem tivesse o link. O equivalente exacto hoje é "secreto", por isso é
      // para aí que vão — passá-los a "publico" seria expô-los sem o dono pedir.
      const rows = db.prepare('SELECT id, visibility FROM events').all();
      const setVisibility = db.prepare(
        'UPDATE events SET visibility = ?, join_policy = ? WHERE id = ?'
      );
      for (const row of rows) {
        if (row.visibility === 'free') {
          setVisibility.run('secreto', 'aberto', row.id);
        } else if (row.visibility === 'password') {
          setVisibility.run('secreto', 'palavra_passe', row.id);
        }
      }

      /* --- Datas disponíveis de cada participante ------------------ */
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_availability (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
          date       TEXT    NOT NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE(event_id, user_id, date)
        );
        CREATE INDEX IF NOT EXISTS idx_availability_event ON event_availability(event_id);
      `);

      /* --- Percursos: vários GPX, um por dia ou vários por dia ----- */
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_routes (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          day_number    INTEGER,
          title         TEXT    NOT NULL,
          notes         TEXT    NOT NULL DEFAULT '',
          file_name     TEXT    NOT NULL DEFAULT '',
          original_name TEXT    NOT NULL DEFAULT '',
          external_url  TEXT    NOT NULL DEFAULT '',
          distance_km   REAL,
          elevation_m   INTEGER,
          size_bytes    INTEGER,
          uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
          position      INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_routes_event ON event_routes(event_id);
      `);

      /* --- Pedidos de adesão --------------------------------------- */
      db.exec(`
        CREATE TABLE IF NOT EXISTS join_requests (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
          message    TEXT    NOT NULL DEFAULT '',
          status     TEXT    NOT NULL DEFAULT 'pendente',
          decided_at TEXT,
          decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE(event_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_requests_event ON join_requests(event_id, status);
      `);

      /* --- Convites por link --------------------------------------- */
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_invites (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          token      TEXT    NOT NULL UNIQUE,
          label      TEXT    NOT NULL DEFAULT '',
          max_uses   INTEGER,
          uses       INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_invites_event ON event_invites(event_id);
      `);

      /* --- Quem já tem acesso ao evento ---------------------------- */
      // Marca como membros todos os inscritos actuais, para ninguém perder
      // o acesso a um evento em que já participava.
      addColumn(db, 'participants', 'joined_via', "TEXT NOT NULL DEFAULT 'legado'");

      /* --- A data deixa de ser obrigatória na fase de datas -------- */
      // start_date foi criada como NOT NULL. Na fase "datas" ainda não há data,
      // por isso passa a aceitar string vazia — o NOT NULL mantém-se satisfeito.
    }
  }
];

MIGRATIONS.push({
  version: 3,
  name: 'Quem organiza passa a constar na lista de participantes',
  up(db) {
    // Quem cria a viagem obviamente vai, mas nunca era inscrito: a lista
    // aparecia a zero e o botão de guardar a resposta não fazia nada, porque
    // actualizava uma linha que não existia.
    // Sempre 'going': quem organiza vai, mesmo enquanto a data não está fechada.
    db.exec(`
      INSERT INTO participants (event_id, user_id, status, joined_via)
      SELECT e.id, e.owner_id, 'going', 'organizador'
      FROM events e
      WHERE NOT EXISTS (
        SELECT 1 FROM participants p WHERE p.event_id = e.id AND p.user_id = e.owner_id
      )
    `);
  }
});

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/* ------------------------------------------------------------------ */
/* Execução                                                            */
/* ------------------------------------------------------------------ */

/** Lê a versão do esquema gravada na própria base de dados. */
export function currentVersion(db) {
  return db.pragma('user_version', { simple: true });
}

/** True se a base de dados já tem dados que valha a pena proteger. */
function hasUserData(db) {
  if (!hasTable(db, 'users')) return false;
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

/**
 * Copia a base de dados antes de migrar, para que uma migração falhada
 * nunca signifique perder contas ou eventos.
 * Devolve o caminho da cópia, ou null se não havia dados para copiar.
 */
function backupBeforeMigrating(db, dbFile, fromVersion) {
  if (!hasUserData(db)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(
    path.dirname(dbFile),
    `backup-v${fromVersion}-${stamp}.db`
  );

  // VACUUM INTO produz uma cópia consistente sem parar a aplicação
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

/**
 * Aplica as migrações em falta, por ordem, cada uma numa transacção.
 * Se alguma falhar, a transacção é revertida e o processo pára com erro:
 * é preferível não arrancar a arrancar com o esquema a meio.
 */
export function runMigrations(db, dbFile) {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from);

  if (!pending.length) return { from, to: from, applied: [], backup: null };

  // A cópia depende de haver dados, não da versão: uma base de dados criada
  // antes de existirem migrações está em user_version 0 e é justamente a que
  // mais importa proteger.
  const backup = backupBeforeMigrating(db, dbFile, from);
  if (backup) console.log(`Cópia de segurança antes de migrar: ${backup}`);

  const applied = [];
  for (const migration of pending) {
    const run = db.transaction(() => {
      migration.up(db);
      // pragma não aceita parâmetros ligados; version vem da lista acima, não do exterior
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      run();
      applied.push(migration);
      console.log(`Migração ${migration.version} aplicada: ${migration.name}`);
    } catch (err) {
      console.error(`\nA migração ${migration.version} (${migration.name}) falhou e foi revertida.`);
      if (backup) console.error(`A base de dados está intacta. Cópia adicional em: ${backup}`);
      throw err;
    }
  }

  return { from, to: currentVersion(db), applied, backup };
}
