import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resolveDbFile } from './db-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_FILE = resolveDbFile();

// Garante que a pasta de dados existe antes de abrir o ficheiro SQLite
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE);

// Aplica o esquema (idempotente) em cada arranque
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

export { DB_FILE };
