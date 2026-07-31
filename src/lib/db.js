import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveDbFile } from './db-path.js';
import { runMigrations } from './migrations.js';

const DB_FILE = resolveDbFile();

// Garante que a pasta de dados existe antes de abrir o ficheiro SQLite
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// O esquema é gerido por migrações versionadas: cada arranque aplica só o que
// falta, sempre por acrescento, com cópia de segurança antes de alterar nada.
runMigrations(db, DB_FILE);

/** Pasta onde ficam os ficheiros GPX carregados, ao lado da base de dados. */
export const UPLOADS_DIR = path.join(path.dirname(DB_FILE), 'routes');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export { DB_FILE };
