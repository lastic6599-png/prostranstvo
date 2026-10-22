// Регистрация по email, подтверждение кодом, вход, сброс пароля, профиль и прогресс пользователя.
'use strict';

const crypto = require('crypto');
const { sendCode } = require('./mail');

const SESSION_DAYS = 30;
const CODE_TTL = 15 * 60e3;
const CODE_RESEND_MS = 60e3;
const CODE_MAX_ATTEMPTS = 5;
const STATE_MAX_BYTES = 256 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = e => String(e || '').trim().toLowerCase();
const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Чтобы время ответа «нет такого пользователя» не отличалось от «неверный пароль»
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw new HttpError(400, 'Пароль должен быть не короче 8 символов.');
  if (p.length > 200) throw new HttpError(400, 'Слишком длинный пароль.');
}

function validateEmail(email) {
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Проверьте адрес почты.');
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, city: u.city, phone: u.phone,
    isSeller: !!u.is_seller, emailVerified: !!u.email_verified, createdAt: u.created_at,
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth(db) {
  // Флаг Secure ставим, только если сайт открыт по HTTPS — иначе браузер не сохранит cookie
  const isHttps = req => !!req.socket.encrypted ||
    (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-proto'] || '').startsWith('https'));

  function setSessionCookie(req, res, token, maxAgeSec) {
    res.setHeader('Set-Cookie', [
      `sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, isHttps(req) ? 'Secure' : '',
    ].filter(Boolean).join('; '));
  }

  async function createSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
      [sha256(token), userId, now, now + SESSION_DAYS * 864e5, clean(req.headers['user-agent'], 300)]);
    setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  }

  async function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    const row = await db.get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
      [sha256(token), Date.now()]);
    return row || null;
  }

  async function requireUser(req) {
    const u = await currentUser(req);
    if (!u) throw new HttpError(401, 'Войдите в аккаунт.');
    return u;
  }

  async function issueCode(email, purpose) {
    const existing = await db.get('SELECT created_at FROM email_codes WHERE email = ? AND purpose = ?', [email, purpose]);
    if (existing && Date.now() - existing.created_at < CODE_RESEND_MS) {
      throw new HttpError(429, 'Код уже отправлен. Повторно — через минуту.');
    }
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const now = Date.now();
    await db.run('DELETE FROM email_codes WHERE email = ? AND purpose = ?', [email, purpose]);
    await db.run('INSERT INTO email_codes (email, purpose, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)',
      [email, purpose, sha256(email + ':' + code), now + CODE_TTL, now]);
    try {
      await sendCode(email, code, purpose);
    } catch (e) {
      console.error('[mail]', e.message);
      await db.run('DELETE FROM email_codes WHERE email = ? AND purpose = ?', [email, purpose]);
      throw new HttpError(502, 'Не удалось отправить письмо. Попробуйте позже.');
    }
  }

  async function consumeCode(email, purpose, code) {
    const row = await db.get('SELECT * FROM email_codes WHERE email = ? AND purpose = ?', [email, purpose]);
    if (!row || row.expires_at < Date.now()) throw new HttpError(400, 'Код устарел. Запросите новый.');
    if (row.attempts >= CODE_MAX_ATTEMPTS) throw new HttpError(429, 'Слишком много попыток. Запросите новый код.');
    const ok = crypto.timingSafeEqual(Buffer.from(sha256(email + ':' + String(code || '').trim())), Buffer.from(row.code_hash));
    if (!ok) {
      await db.run('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?', [email, purpose]);
      throw new HttpError(400, 'Неверный код.');
    }
    await db.run('DELETE FROM email_codes WHERE email = ? AND purpose = ?', [email, purpose]);
  }

  // Заказ без регистрации: создаём неподтверждённый аккаунт по почте из заказа и отправляем код.
  // Возвращает 'verify' — нужно подтвердить почту кодом, 'login' — аккаунт уже есть, нужно войти.
  async function prepareGuestAccount(email, name, phone) {
    const u = await db.get('SELECT id, email_verified FROM users WHERE email = ?', [email]);
    if (u && u.email_verified) return 'login';
    if (!u) {
      const now = Date.now();
      // Пароль случайный: задать свой можно через «Регистрация» или «Забыли пароль?» с той же почтой
      await db.run(`INSERT INTO users (id, email, password_hash, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), email, hashPassword(crypto.randomBytes(24).toString('base64')), clean(name, 80), clean(phone, 30), now, now]);
    }
    try {
      await issueCode(email, 'verify');
    } catch (e) {
      // Заказ уже создан: если письмо не ушло, код можно запросить ещё раз
      if (e.status !== 429) console.error('[guest]', e.message);
    }
    return 'verify';
  }

  async function userState(userId) {
    const row = await db.get('SELECT data FROM user_state WHERE user_id = ?', [userId]);
    return row ? JSON.parse(row.data) : null;
  }

  // ── Обработчики ──
  const routes = {
    async 'POST /api/auth/register'(req, res, body) {
      const email = normEmail(body.email);
      validateEmail(email);
      validatePassword(body.password);
      const name = clean(body.name, 80);
      const existing = await db.get('SELECT id, email_verified FROM users WHERE email = ?', [email]);
      if (existing && existing.email_verified) throw new HttpError(409, 'Этот email уже зарегистрирован. Войдите или восстановите пароль.');
      const now = Date.now();
      if (existing) {
        // Регистрация не была подтверждена — разрешаем начать заново
        await db.run('UPDATE users SET password_hash = ?, name = ?, updated_at = ? WHERE id = ?',
          [hashPassword(body.password), name, now, existing.id]);
      } else {
        await db.run(`INSERT INTO users (id, email, password_hash, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), email, hashPassword(body.password), name, now, now]);
      }
      await issueCode(email, 'verify');
      return { needVerify: true, email };
    },

    async 'POST /api/auth/verify'(req, res, body) {
      const email = normEmail(body.email);
      await consumeCode(email, 'verify', body.code);
      const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
      if (!user) throw new HttpError(400, 'Аккаунт не найден.');
      await db.run('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?', [Date.now(), user.id]);
      user.email_verified = 1;
      await createSession(req, res, user.id);
      return { user: publicUser(user), state: await userState(user.id) };
    },

    async 'POST /api/auth/resend'(req, res, body) {
      const email = normEmail(body.email);
      const user = await db.get('SELECT email_verified FROM users WHERE email = ?', [email]);
      if (user && !user.email_verified) await issueCode(email, 'verify');
      return { ok: true };
    },

    async 'POST /api/auth/login'(req, res, body) {
      const email = normEmail(body.email);
      const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
      const ok = checkPassword(String(body.password || ''), user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) throw new HttpError(401, 'Неверный email или пароль.');
      if (!user.email_verified) {
        try { await issueCode(email, 'verify'); } catch (e) { if (e.status !== 429) throw e; }
        return { needVerify: true, email };
      }
      await createSession(req, res, user.id);
      return { user: publicUser(user), state: await userState(user.id) };
    },

    async 'POST /api/auth/logout'(req, res) {
      const token = parseCookies(req.headers.cookie).sid;
      if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
      setSessionCookie(req, res, '', 0);
      return { ok: true };
    },

    async 'POST /api/auth/reset/request'(req, res, body) {
      const email = normEmail(body.email);
      validateEmail(email);
      const user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
      // Ответ одинаковый, есть аккаунт или нет — чтобы нельзя было перебирать чужие адреса
      if (user) {
        try { await issueCode(email, 'reset'); } catch (e) { if (e.status !== 429) throw e; }
      }
      return { ok: true };
    },

    async 'POST /api/auth/reset/confirm'(req, res, body) {
      const email = normEmail(body.email);
      validatePassword(body.password);
      await consumeCode(email, 'reset', body.code);
      const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
      if (!user) throw new HttpError(400, 'Аккаунт не найден.');
      // Почта подтверждена кодом; старые сессии (например, на чужом устройстве) завершаем
      await db.run('UPDATE users SET password_hash = ?, email_verified = 1, updated_at = ? WHERE id = ?',
        [hashPassword(body.password), Date.now(), user.id]);
      await db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      user.email_verified = 1;
      await createSession(req, res, user.id);
      return { user: publicUser(user), state: await userState(user.id) };
    },

    async 'GET /api/me'(req) {
      const user = await requireUser(req);
      return { user: publicUser(user), state: await userState(user.id) };
    },

    async 'PATCH /api/me'(req, res, body) {
      const user = await requireUser(req);
      const next = {
        name: body.name != null ? clean(body.name, 80) : user.name,
        city: body.city != null ? clean(body.city, 80) : user.city,
        phone: body.phone != null ? clean(body.phone, 30) : user.phone,
        is_seller: body.isSeller != null ? (body.isSeller ? 1 : 0) : user.is_seller,
      };
      await db.run('UPDATE users SET name = ?, city = ?, phone = ?, is_seller = ?, updated_at = ? WHERE id = ?',
        [next.name, next.city, next.phone, next.is_seller, Date.now(), user.id]);
      return { user: publicUser(Object.assign(user, next)) };
    },

    async 'PUT /api/me/state'(req, res, body) {
      const user = await requireUser(req);
      const data = JSON.stringify(body.state || null);
      if (Buffer.byteLength(data) > STATE_MAX_BYTES) throw new HttpError(413, 'Слишком много данных.');
      const now = Date.now();
      await db.run(`INSERT INTO user_state (user_id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, [user.id, data, now]);
      return { ok: true, updatedAt: now };
    },

    // Удаление аккаунта (обязательно для App Store)
    async 'DELETE /api/me'(req, res, body) {
      const user = await requireUser(req);
      if (!checkPassword(String(body.password || ''), user.password_hash)) throw new HttpError(401, 'Неверный пароль.');
      await db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      await db.run('DELETE FROM user_state WHERE user_id = ?', [user.id]);
      await db.run('DELETE FROM email_codes WHERE email = ?', [user.email]);
      await db.run('DELETE FROM users WHERE id = ?', [user.id]);
      setSessionCookie(req, res, '', 0);
      return { ok: true };
    },
  };

  async function cleanup() {
    const now = Date.now();
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
    await db.run('DELETE FROM email_codes WHERE expires_at < ?', [now]);
  }

  return { routes, currentUser, cleanup, prepareGuestAccount };
}

module.exports = { createAuth, HttpError, normEmail, validateEmail, clean };
