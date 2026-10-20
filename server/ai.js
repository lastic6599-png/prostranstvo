// Провайдеры ИИ, доступные из России.
// Все функции принимают messages в формате [{ role: 'system'|'user'|'assistant', content }]
// и возвращают текст ответа.
'use strict';

const crypto = require('crypto');

const env = process.env;
const TIMEOUT_MS = 30e3;

async function postJson(url, headers, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 500) }; }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.details = data;
    throw err;
  }
  return data;
}

// ── YandexGPT (Yandex Cloud AI Studio) ──
// Нужны: YANDEX_API_KEY (API-ключ сервисного аккаунта с ролью ai.languageModels.user) и YANDEX_FOLDER_ID.
const yandex = {
  name: 'YandexGPT',
  configured: () => !!(env.YANDEX_API_KEY && env.YANDEX_FOLDER_ID),
  async complete(messages, { maxTokens, temperature }) {
    const model = env.YANDEX_MODEL || 'yandexgpt-lite/latest';
    const data = await postJson(
      env.YANDEX_URL || 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      { Authorization: `Api-Key ${env.YANDEX_API_KEY}`, 'x-folder-id': env.YANDEX_FOLDER_ID },
      {
        modelUri: `gpt://${env.YANDEX_FOLDER_ID}/${model}`,
        completionOptions: { stream: false, temperature, maxTokens: String(maxTokens) },
        messages: messages.map(m => ({ role: m.role, text: m.content })),
      }
    );
    return data.result.alternatives[0].message.text;
  },
};

// ── GigaChat (Сбер) ──
// Нужен GIGACHAT_AUTH_KEY — «Ключ авторизации» из личного кабинета developers.sber.ru.
// Сертификаты GigaChat выданы Минцифры: серверу нужен корневой сертификат
// (NODE_EXTRA_CA_CERTS=/путь/russian_trusted_root_ca.pem), см. README.
let gigaToken = null; // { value, expiresAt }

async function gigaAccessToken() {
  if (gigaToken && gigaToken.expiresAt - Date.now() > 60e3) return gigaToken.value;
  const r = await fetch(env.GIGACHAT_OAUTH_URL || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${env.GIGACHAT_AUTH_KEY}`,
      RqUID: crypto.randomUUID(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: `scope=${encodeURIComponent(env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS')}`,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    const err = new Error(`GigaChat OAuth HTTP ${r.status}`);
    err.details = data;
    throw err;
  }
  gigaToken = { value: data.access_token, expiresAt: data.expires_at || Date.now() + 25 * 60e3 };
  return gigaToken.value;
}

const gigachat = {
  name: 'GigaChat',
  configured: () => !!env.GIGACHAT_AUTH_KEY,
  async complete(messages, { maxTokens, temperature }) {
    const url = env.GIGACHAT_URL || 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';
    const body = { model: env.GIGACHAT_MODEL || 'GigaChat', messages, max_tokens: maxTokens, temperature };
    let data;
    try {
      data = await postJson(url, { Authorization: `Bearer ${await gigaAccessToken()}` }, body);
    } catch (e) {
      if (!/HTTP 401/.test(e.message)) throw e;
      gigaToken = null; // токен протух раньше срока — пробуем один раз заново
      data = await postJson(url, { Authorization: `Bearer ${await gigaAccessToken()}` }, body);
    }
    return data.choices[0].message.content;
  },
};

// ── Любой OpenAI-совместимый API (свой сервер, агрегатор и т. п.) ──
const openaiCompatible = {
  name: 'OpenAI-compatible',
  configured: () => !!(env.OPENAI_COMPAT_URL && env.OPENAI_COMPAT_KEY),
  async complete(messages, { maxTokens, temperature }) {
    const data = await postJson(env.OPENAI_COMPAT_URL, { Authorization: `Bearer ${env.OPENAI_COMPAT_KEY}` },
      { model: env.OPENAI_COMPAT_MODEL, messages, max_tokens: maxTokens, temperature });
    return data.choices[0].message.content;
  },
};

const PROVIDERS = { yandex, gigachat, openai: openaiCompatible };

// AI_PROVIDER=yandex|gigachat|openai. Если не задан — первый настроенный по порядку.
function pickProvider() {
  if (env.AI_PROVIDER) return PROVIDERS[env.AI_PROVIDER] || null;
  return Object.values(PROVIDERS).find(p => p.configured()) || null;
}

module.exports = { pickProvider };
