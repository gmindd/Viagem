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

MIGRATIONS.push({
  version: 4,
  name: 'Duração da viagem, propostas de datas, recuperação de palavra-passe, divisões de rota e pontos de interesse',
  up(db) {
    /* --- Duração da viagem --------------------------------------- */
    // Quantos dias dura, e se têm de ser seguidos. Serve para validar a
    // disponibilidade: com 3 dias seguidos, marcar 3 dias soltos não chega.
    addColumn(db, 'events', 'trip_days', 'INTEGER');
    addColumn(db, 'events', 'days_continuous', 'INTEGER NOT NULL DEFAULT 1');

    /* --- Propostas de datas -------------------------------------- */
    // Depois de recolher disponibilidades, o organizador propõe alguns
    // blocos de datas e o grupo vota no que prefere.
    db.exec(`
      CREATE TABLE IF NOT EXISTS date_proposals (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        start_date TEXT    NOT NULL,
        end_date   TEXT    NOT NULL,
        note       TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(event_id, start_date, end_date)
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_event ON date_proposals(event_id);

      CREATE TABLE IF NOT EXISTS proposal_votes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id INTEGER NOT NULL REFERENCES date_proposals(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vote        TEXT    NOT NULL DEFAULT 'sim',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(proposal_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_votes_proposal ON proposal_votes(proposal_id);
    `);

    /* --- Recuperação de palavra-passe ---------------------------- */
    // Guarda-se o hash do token, não o token: quem leia a base de dados não
    // consegue recuperar contas alheias.
    db.exec(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT    NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        used_at    TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
    `);

    /* --- Divisão da rota em etapas -------------------------------- */
    // Cada participante marca onde acha que a rota deve ser cortada.
    // position_km é a distância desde o início do percurso.
    db.exec(`
      CREATE TABLE IF NOT EXISTS route_splits (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id    INTEGER NOT NULL REFERENCES event_routes(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position_km REAL    NOT NULL,
        lat         REAL,
        lon         REAL,
        note        TEXT    NOT NULL DEFAULT '',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_splits_route ON route_splits(route_id);
    `);

    /* --- Pontos de interesse ao longo da rota --------------------- */
    // Cache dos resultados do Overpass mais o que for acrescentado à mão,
    // para não repetir a consulta externa a cada visita à página.
    db.exec(`
      CREATE TABLE IF NOT EXISTS route_pois (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id    INTEGER NOT NULL REFERENCES event_routes(id) ON DELETE CASCADE,
        external_id TEXT,
        kind        TEXT    NOT NULL,
        name        TEXT    NOT NULL DEFAULT '',
        lat         REAL    NOT NULL,
        lon         REAL    NOT NULL,
        details     TEXT    NOT NULL DEFAULT '',
        source      TEXT    NOT NULL DEFAULT 'osm',
        added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pois_route ON route_pois(route_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pois_external ON route_pois(route_id, external_id)
        WHERE external_id IS NOT NULL;
    `);

    // Quando foi a última vez que se foram buscar POIs a esta rota
    addColumn(db, 'event_routes', 'pois_fetched_at', 'TEXT');
    // Traçado simplificado do GPX, para o mapa não reler o ficheiro a cada visita
    addColumn(db, 'event_routes', 'track_json', 'TEXT');
  }
});

MIGRATIONS.push({
  version: 5,
  name: 'Moderadores, checklist de material e avisos do mural por email',
  up(db) {
    /* --- Moderadores --------------------------------------------- */
    // 'membro' ou 'moderador'. Quem organiza é identificado por events.owner_id
    // e não precisa de papel próprio — teria de ser mantido em dois sítios.
    addColumn(db, 'participants', 'role', "TEXT NOT NULL DEFAULT 'membro'");

    /* --- Material a levar ----------------------------------------- */
    db.exec(`
      CREATE TABLE IF NOT EXISTS gear_items (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name       TEXT    NOT NULL,
        quantity   INTEGER NOT NULL DEFAULT 1,
        notes      TEXT    NOT NULL DEFAULT '',
        category   TEXT    NOT NULL DEFAULT '',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_gear_event ON gear_items(event_id);

      CREATE TABLE IF NOT EXISTS gear_claims (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES gear_items(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quantity   INTEGER NOT NULL DEFAULT 1,
        note       TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(item_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_claims_item ON gear_claims(item_id);
    `);

    /* --- Avisos do mural por email -------------------------------- */
    // Regista quando a mensagem foi enviada, para o botão não reenviar
    // por engano e para se ver na página que já saiu.
    addColumn(db, 'comments', 'emailed_at', 'TEXT');
    addColumn(db, 'comments', 'emailed_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
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
