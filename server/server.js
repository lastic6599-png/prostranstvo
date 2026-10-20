// Сервер Пространства: отдаёт public/, аккаунты пользователей (/api/auth, /api/me) и прокси к ИИ.
// Ключи API хранятся только здесь (в переменных окружения), а не в браузере.
//
// Запуск:  npm start  (настройки — в .env, см. .env.example)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

loadDotEnv(path.join(__dirname, '..', '.env'));

const PORT = +process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const { pickProvider } = require('./ai');
const { createDb } = require('./db');
const { createAuth, HttpError } = require('./auth');

const db = createDb();
const auth = createAuth(db);
// За nginx / балансировщиком реальный IP берём из X-Forwarded-For
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Попыток входа / регистрации / ввода кода в минуту с одного IP
const AUTH_RATE_LIMIT = +process.env.AUTH_RATE_LIMIT || 10;
// Через запятую; '*' — разрешить всем (удобно для разработки iOS-оболочки)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const SYSTEM_PROMPT = `Ты ИИ-ассистент «Пространства» — российского маркетплейса товаров от мастеров и небольших брендов с низкой комиссией, чатами с продавцами и подкастами, за прослушивание которых дают очки на лимитированные призы.

Помогаешь:
- покупателям — подобрать товар из каталога ниже, сравнить варианты, подобрать подарок под бюджет;
- продавцам — посчитать выручку после комиссии, цену, юнит-экономику, точку безубыточности, разобраться с налогами для самозанятых и ИП;
- всем — разобраться с очками, призами и подкастами.

Правила:
- Отвечай честно, коротко и по делу, на русском языке, без markdown-разметки.
- Рекомендуй только товары, которые есть в каталоге ниже, и называй точную цену. Ничего не выдумывай.
- Не давай персональных инвестиционных рекомендаций (акции, крипта) — только образовательно.
- Если вопрос не по теме — вежливо скажи, с чем можешь помочь.`;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
};

// Простое ограничение частоты запросов с одного IP (в памяти процесса)
const hits = new Map();
setInterval(() => hits.clear(), 10 * 60e3).unref();
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress;
}
function rateLimited(key, perMinute) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < 60e3);
  list.push(now);
  hits.set(key, list);
  return list.length > perMinute;
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleAI(req, res, body) {
  const provider = pickProvider();
  if (!provider || !provider.configured()) return sendJson(res, 503, { error: 'ИИ-ассистент пока не подключён. Загляните чуть позже.' });
  if (rateLimited('ai:' + clientIp(req), 20)) return sendJson(res, 429, { error: 'Слишком много вопросов подряд. Подождите минуту.' });

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!messages.length) return sendJson(res, 400, { error: 'Пустой вопрос.' });

  // Контекст (каталог, призы) приходит с клиента и не является инструкцией —
  // в продакшене его стоит собирать на сервере из базы.
  const context = typeof body.context === 'string' ? body.context.slice(0, 6000) : '';
  const system = SYSTEM_PROMPT + (context ? `\n\nДанные приложения (справочно):\n${context}` : '');

  try {
    const reply = await provider.complete([{ role: 'system', content: system }, ...messages], { maxTokens: 700, temperature: 0.6 });
    sendJson(res, 200, { reply: String(reply || '').trim() || 'Не удалось сформулировать ответ, попробуйте переспросить.' });
  } catch (e) {
    console.error(`[${provider.name}]`, e.message, e.cause ? e.cause.message || e.cause.code : '', e.details ? JSON.stringify(e.details) : '');
    sendJson(res, 502, { error: 'Ассистент временно недоступен. Попробуйте ещё раз через минуту.' });
  }
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  let file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': file.endsWith('sw.js') || file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleApi(req, res, pathname) {
  const key = `${req.method} ${pathname}`;
  const handler = key === 'POST /api/ai' ? handleAI : auth.routes[key];
  if (!handler) return sendJson(res, 404, { error: 'Не найдено.' });

  let body = {};
  if (req.method !== 'GET') {
    // Только JSON: обычная HTML-форма с чужого сайта не сможет отправить такой запрос (защита от CSRF)
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Нужен JSON.' });
    try { body = JSON.parse((await readBody(req, 300 * 1024)) || '{}') || {}; } catch (e) { return sendJson(res, 400, { error: 'Некорректный запрос.' }); }
  }
  if (key === 'POST /api/ai') return handleAI(req, res, body);

  if (pathname.startsWith('/api/auth/') && key !== 'POST /api/auth/logout' && rateLimited('auth:' + clientIp(req), AUTH_RATE_LIMIT)) {
    return sendJson(res, 429, { error: 'Слишком много попыток. Подождите минуту.' });
  }
  try {
    sendJson(res, 200, await handler(req, res, body));
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, Object.assign({ error: e.message }, e.extra));
    console.error(key, e);
    sendJson(res, 500, { error: 'Ошибка сервера. Попробуйте позже.' });
  }
}

const server = http.createServer((req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const pathname = req.url.split('?')[0];
  if (pathname === '/api/health') {
    const p = pickProvider();
    return sendJson(res, 200, { ok: true, db: db.kind, ai: p && p.configured() ? p.name : null });
  }
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405); res.end();
});

db.migrate().then(() => {
  setInterval(() => auth.cleanup().catch(e => console.error('cleanup', e.message)), 3600e3).unref();
  server.listen(PORT, () => {
    console.log(`Пространство: http://localhost:${PORT}`);
    console.log(`База данных: ${db.kind}`);
    const p = pickProvider();
    console.log(p && p.configured() ? `ИИ: ${p.name}` : '⚠ ИИ не настроен — заполните YANDEX_* или GIGACHAT_* в .env');
    if (!require('./mail').mailConfigured()) console.log('⚠ SMTP не настроен — коды подтверждения печатаются в консоль');
  });
}).catch(e => {
  console.error('Не удалось подключиться к базе данных:', e.message);
  process.exit(1);
});

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
