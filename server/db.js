// База данных: PostgreSQL, если задан DATABASE_URL, иначе встроенный SQLite (файл data/app.db).
// Запросы пишутся с плейсхолдерами `?` — для Postgres они превращаются в $1, $2…
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    is_seller INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS email_codes (
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (email, purpose)
  )`,
  // Прогресс в приложении (корзина, чаты, очки, призы) — JSON на пользователя
  `CREATE TABLE IF NOT EXISTS user_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
];

function createPostgres(url) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => Number(v)); // BIGINT → number (миллисекунды влезают)
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined,
  });
  const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  return {
    kind: 'PostgreSQL',
    async all(sql, params = []) { return (await pool.query(toPg(sql), params)).rows; },
    async get(sql, params = []) { return (await pool.query(toPg(sql), params)).rows[0]; },
    async run(sql, params = []) { return { changes: (await pool.query(toPg(sql), params)).rowCount }; },
    async migrate() { for (const s of SCHEMA) await pool.query(s); },
  };
}

function createSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return {
    kind: 'SQLite',
    async all(sql, params = []) { return db.prepare(sql).all(...params); },
    async get(sql, params = []) { return db.prepare(sql).get(...params); },
    async run(sql, params = []) { return { changes: Number(db.prepare(sql).run(...params).changes) }; },
    async migrate() { for (const s of SCHEMA) db.exec(s); },
  };
}

function createDb() {
  if (process.env.DATABASE_URL) return createPostgres(process.env.DATABASE_URL);
  return createSqlite(process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'app.db'));
}

module.exports = { createDb };
