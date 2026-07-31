import session from 'express-session';
import { db } from './db.js';

const Store = session.Store;

/**
 * Store de sessões para o express-session assente em better-sqlite3.
 * Evita a dependência connect-sqlite3 (que arrasta node-gyp e sqlite3).
 */
export class SqliteSessionStore extends Store {
  constructor({ ttlMs = 1000 * 60 * 60 * 24 * 30, cleanupIntervalMs = 1000 * 60 * 60 } = {}) {
    super();
    this.ttlMs = ttlMs;

    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (@sid, @data, @expires_at)
         ON CONFLICT(sid) DO UPDATE SET data = @data, expires_at = @expires_at`
      ),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      clear: db.prepare('DELETE FROM sessions'),
      length: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?'),
      all: db.prepare('SELECT sid, data FROM sessions WHERE expires_at > ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
    };

    this.prune();
    // Limpeza periódica das sessões expiradas; unref para não segurar o processo
    this.cleanupTimer = setInterval(() => this.prune(), cleanupIntervalMs);
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  // Calcula o timestamp de expiração a partir do cookie da sessão (ou do TTL padrão)
  expiryFor(sess) {
    const cookieExpires = sess?.cookie?.expires;
    if (cookieExpires) return new Date(cookieExpires).getTime();
    return Date.now() + this.ttlMs;
  }

  // Apaga da tabela todas as sessões já expiradas
  prune() {
    this.stmts.prune.run(Date.now());
  }

  // Lê uma sessão pelo sid; devolve null se não existir ou já ter expirado
  get(sid, callback) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        this.stmts.destroy.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  // Grava (insere ou atualiza) a sessão
  set(sid, sess, callback = () => {}) {
    try {
      this.stmts.set.run({
        sid,
        data: JSON.stringify(sess),
        expires_at: this.expiryFor(sess)
      });
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  // Prolonga a validade de uma sessão activa sem reescrever os dados
  touch(sid, sess, callback = () => {}) {
    try {
      this.stmts.touch.run(this.expiryFor(sess), sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  // Remove uma sessão (logout)
  destroy(sid, callback = () => {}) {
    try {
      this.stmts.destroy.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  // Número de sessões activas
  length(callback) {
    try {
      callback(null, this.stmts.length.get(Date.now()).n);
    } catch (err) {
      callback(err);
    }
  }

  // Apaga todas as sessões
  clear(callback = () => {}) {
    try {
      this.stmts.clear.run();
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  // Devolve todas as sessões activas (usado por ferramentas de diagnóstico)
  all(callback) {
    try {
      const rows = this.stmts.all.all(Date.now());
      callback(null, rows.map((r) => JSON.parse(r.data)));
    } catch (err) {
      callback(err);
    }
  }
}
