import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve o caminho do ficheiro SQLite sem abrir a base de dados.
 * Fica num módulo próprio para o arranque poder validar a pasta
 * antes de o better-sqlite3 tentar (e falhar com um erro obscuro).
 */
export function resolveDbFile(env = process.env) {
  return env.DATABASE_FILE
    ? path.resolve(env.DATABASE_FILE)
    : path.join(__dirname, '..', '..', 'data', 'viagem.db');
}
