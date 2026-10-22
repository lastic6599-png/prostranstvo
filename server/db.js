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

  // ── Магазин ──
  // Продавец площадки. user_id — аккаунт продавца (появится вместе с кабинетом продавца).
  // commission_bp — комиссия в базисных пунктах: 1000 = 10%. С Pro-подпиской будет ниже.
  `CREATE TABLE IF NOT EXISTS sellers (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    commission_bp INTEGER NOT NULL DEFAULT 1000,
    created_at BIGINT NOT NULL
  )`,
  // Цены — в целых рублях. stock — сколько штук можно продать.
  // is_exclusive — эксклюзив площадки (будет доступен по подписке), is_gift — показывать в «Подарках».
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES sellers(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL,
    market_price INTEGER,
    stock INTEGER NOT NULL DEFAULT 0,
    is_exclusive INTEGER NOT NULL DEFAULT 0,
    is_gift INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  // Заказ. Контакты и адрес — снимок на момент заказа. user_id пустой, пока гость не подтвердил почту.
  // status: awaiting_payment → paid → shipped → delivered, или cancelled.
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL UNIQUE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    items_total INTEGER NOT NULL,
    gift_wrap_cost INTEGER NOT NULL DEFAULT 0,
    delivery_cost INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    commission_total INTEGER NOT NULL DEFAULT 0,
    contact_name TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    delivery_method TEXT NOT NULL,
    delivery_address TEXT NOT NULL DEFAULT '',
    is_gift INTEGER NOT NULL DEFAULT 0,
    gift_wrap INTEGER NOT NULL DEFAULT 0,
    gift_message TEXT NOT NULL DEFAULT '',
    recipient_name TEXT NOT NULL DEFAULT '',
    recipient_phone TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(contact_email)`,
  // Состав заказа: снимок названия и цены, комиссия площадки по каждой позиции
  `CREATE TABLE IF NOT EXISTS order_items (
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id),
    seller_id TEXT NOT NULL,
    name TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    commission INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (order_id, product_id)
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
  const api = conn => ({
    async all(sql, params = []) { return (await conn.query(toPg(sql), params)).rows; },
    async get(sql, params = []) { return (await conn.query(toPg(sql), params)).rows[0]; },
    async run(sql, params = []) { return { changes: (await conn.query(toPg(sql), params)).rowCount }; },
  });
  return Object.assign(api(pool), {
    kind: 'PostgreSQL',
    async migrate() { for (const s of SCHEMA) await pool.query(s); },
    // Несколько запросов как одно целое: либо выполнятся все, либо ни один
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(api(client));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  });
}

function createSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const api = {
    async all(sql, params = []) { return db.prepare(sql).all(...params); },
    async get(sql, params = []) { return db.prepare(sql).get(...params); },
    async run(sql, params = []) { return { changes: Number(db.prepare(sql).run(...params).changes) }; },
  };
  return Object.assign({}, api, {
    kind: 'SQLite',
    async migrate() { for (const s of SCHEMA) db.exec(s); },
    // SQLite синхронный: пока функция ждёт только запросы к базе, чужие запросы не вклиниваются
    async tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(api);
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  });
}

function createDb() {
  if (process.env.DATABASE_URL) return createPostgres(process.env.DATABASE_URL);
  return createSqlite(process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'app.db'));
}

module.exports = { createDb };
