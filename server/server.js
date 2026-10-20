// Мини-сервер без зависимостей: отдаёт public/ и проксирует запросы к ИИ.
// Ключ API хранится только здесь (в переменной окружения), а не в браузере.
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
// За nginx / балансировщиком реальный IP берём из X-Forwarded-For
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
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

// Простое ограничение частоты: 20 запросов к ИИ в минуту с одного IP
const hits = new Map();
setInterval(() => hits.clear(), 10 * 60e3).unref();
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress;
}
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60e3);
  list.push(now);
  hits.set(ip, list);
  return list.length > 20;
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

async function handleAI(req, res) {
  const provider = pickProvider();
  if (!provider || !provider.configured()) return sendJson(res, 503, { error: 'ИИ-ассистент пока не подключён. Загляните чуть позже.' });
  if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: 'Слишком много вопросов подряд. Подождите минуту.' });

  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: 'Некорректный запрос.' }); }

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
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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

const server = http.createServer((req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url === '/api/ai' && req.method === 'POST') return handleAI(req, res);
  if (req.url === '/api/health') {
    const p = pickProvider();
    return sendJson(res, 200, { ok: true, ai: p && p.configured() ? p.name : null });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405); res.end();
});

server.listen(PORT, () => {
  console.log(`Пространство: http://localhost:${PORT}`);
  const p = pickProvider();
  console.log(p && p.configured() ? `ИИ: ${p.name}` : '⚠ ИИ не настроен — заполните YANDEX_* или GIGACHAT_* в .env');
});

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
