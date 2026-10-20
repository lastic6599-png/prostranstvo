(function () {
'use strict';

const CFG = window.APP_CONFIG;
const D = window.DATA;
const Native = window.NativeBridge;
const STORE_KEY = 'prostranstvo:v1';

// ══════════════════════════════
// УТИЛИТЫ
// ══════════════════════════════
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const rub = n => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const pct = r => Math.round(r * 100) + '%';
const today = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const mmss = s => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const byId = (list, id) => list.find(x => x.id === id);

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ══════════════════════════════
// СОСТОЯНИЕ (localStorage; в продакшене — сервер)
// ══════════════════════════════
function initialState() {
  const chats = D.chats.map(c => ({
    id: c.id, kind: 'seller', seller: c.seller, unread: c.unread,
    messages: c.messages.map(m => Object.assign({}, m)),
  }));
  chats.unshift({
    id: 'ai', kind: 'ai', unread: 0,
    messages: [{ from: 'them', time: nowTime(),
      text: 'Привет! Я ИИ-ассистент Пространства. Помогу подобрать товар, посчитать экономику продаж или разобраться с призами. Спрашивайте.' }],
  });
  return {
    v: 1,
    createdAt: Date.now(),
    points: 120,
    cart: {},
    following: { c1: true },
    chats,
    episodes: {},
    dropsLeft: {},
    myPrizes: [],
    streak: 0,
    lastVisit: null,
    tasksDay: today(),
    tasksDone: {},
    userRequests: [],
  };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.v === 1) return s;
  } catch (e) { /* приватный режим или битые данные */ }
  return initialState();
}

let state = loadState();
let user = null;        // вошедший пользователь (с сервера) или null для гостя
let syncTimer = null;

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* нет места / запрещено */ }
  // Прогресс вошедшего пользователя сохраняется в базе (с задержкой, чтобы не слать запрос на каждый тик)
  if (user) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushState, 1500);
  }
}

function pushState() {
  clearTimeout(syncTimer);
  if (!user) return;
  api('PUT', '/api/me/state', { state }).catch(() => { /* повторим при следующем сохранении */ });
}

async function api(method, path, body) {
  const res = await fetch(CFG.API_BASE + path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Нет связи с сервером.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function addPoints(n, reason) {
  state.points += n;
  save();
  renderHeader();
  if (reason) toast(`+${n} очков · ${reason}`);
  Native.haptic('success');
}

// Ежедневная серия и бонус за вход
function checkStreak() {
  const t = today();
  if (state.lastVisit === t) return;
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  state.streak = state.lastVisit === y ? state.streak + 1 : 1;
  state.lastVisit = t;
  if (state.tasksDay !== t) { state.tasksDay = t; state.tasksDone = {}; }
  const bonus = Math.min(state.streak, 7) * 2;
  state.points += bonus;
  save();
  setTimeout(() => toast(`День ${state.streak} подряд · +${bonus} очков`), 600);
}
checkStreak();

function completeTask(event) {
  const task = D.tasks.find(t => t.event === event);
  if (!task || state.tasksDone[task.id]) return;
  state.tasksDone[task.id] = true;
  addPoints(task.points, task.name);
  renderPrizes();
}

// ══════════════════════════════
// НАВИГАЦИЯ
// ══════════════════════════════
let currentTab = 'home';
function switchTab(name) {
  if (name === 'ai') { openThread('ai'); return; }
  closeAllOverlays();
  currentTab = name;
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('#content-wrap').scrollTop = 0;
}

const overlayStack = [];
let suppressPop = 0; // сколько ближайших popstate вызваны нами самими
function openOverlay(id) {
  const el = document.getElementById(id);
  if (overlayStack.includes(id)) return;
  overlayStack.push(id);
  el.style.zIndex = 300 + overlayStack.length;
  el.classList.add('open');
  history.pushState({ overlay: id }, '');
}
function hideOverlay(id) {
  const i = overlayStack.indexOf(id);
  if (i === -1) return;
  overlayStack.splice(i, 1);
  document.getElementById(id).classList.remove('open');
  if (id === 'thread-overlay') openThreadId = null;
}
function closeOverlay(id) {
  if (!overlayStack.includes(id)) return;
  hideOverlay(id);
  suppressPop++;
  history.back();
}
function closeAllOverlays() {
  const n = overlayStack.length;
  while (overlayStack.length) hideOverlay(overlayStack[overlayStack.length - 1]);
  if (n) { suppressPop++; history.go(-n); }
}
// Системное «назад» (свайп, кнопка браузера) закрывает верхний экран
window.addEventListener('popstate', () => {
  if (suppressPop) { suppressPop--; return; }
  const top = overlayStack[overlayStack.length - 1];
  if (top) hideOverlay(top);
});

// ══════════════════════════════
// ШАПКА / БЕЙДЖИ
// ══════════════════════════════
function cartCount() { return Object.values(state.cart).reduce((a, b) => a + b, 0); }
function unreadCount() { return state.chats.reduce((a, c) => a + (c.unread || 0), 0); }

function renderHeader() {
  $('#points-value').textContent = state.points;
  $('#ach-points').textContent = state.points;
  const cc = cartCount();
  $('#cart-badge').hidden = !cc;
  $('#cart-badge').textContent = cc;
  const un = unreadCount();
  $('#chats-badge').hidden = !un;
  $('#chats-badge').textContent = un;
  Native.setBadge(un);
}

// ══════════════════════════════
// ГЛАВНАЯ
// ══════════════════════════════
function renderCommission() {
  const price = +$('#cc-price').value;
  $('#cc-price-label').textContent = rub(price);
  const rows = [{ name: 'Пространство', rate: CFG.COMMISSION, ours: true }].concat(CFG.COMPETITOR_RATES);
  $('#cc-rows').innerHTML = rows.map(r => {
    const net = price * (1 - r.rate);
    return `<div class="cc-row${r.ours ? ' ours' : ''}">
      <div class="cc-row-top"><span class="name">${esc(r.name)} · ${pct(r.rate)}</span><span class="val">${rub(net)}</span></div>
      <div class="cc-bar"><div class="cc-bar-fill" style="width:${(1 - r.rate) * 100}%"></div></div>
    </div>`;
  }).join('');
}

function productCard(p) {
  const s = D.sellers[p.seller];
  return `<button class="product-card" data-product="${p.id}">
    <div class="product-img">${p.emoji}<div class="product-seller-tag">${esc(s.name)}</div></div>
    <div class="product-info">
      <div class="product-name">${esc(p.name)}</div>
      <div class="product-maker">${esc(s.role)}</div>
      <div class="product-price-row">
        <div class="product-price">${rub(p.price)}</div>
        ${p.market ? `<div class="product-market-price">${rub(p.market)}</div>` : ''}
      </div>
    </div>
  </button>`;
}

function caseCard(c) {
  const s = D.sellers[c.seller];
  const f = !!state.following[c.id];
  const progress = Math.round(c.day / c.total * 100);
  return `<div class="case-card">
    <div class="case-head">
      <div class="case-avatar">${esc(s.name[0])}</div>
      <div class="case-meta"><div class="case-name">${esc(s.name)}</div><div class="case-role">${esc(s.role)}</div></div>
      <button class="follow-btn${f ? ' following' : ''}" data-follow="${c.id}">${f ? 'Слежу' : '+ Следить'}</button>
    </div>
    <div class="case-goal">Цель: ${esc(c.goal)}</div>
    <div class="progress-bar-wrap">
      <div class="progress-label"><span>День ${c.day} из ${c.total}</span><span>${progress}%</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
    </div>
    <div class="case-update"><div class="case-update-label">Последнее обновление · ${esc(c.when)}</div>${esc(c.update)}</div>
  </div>`;
}

function requestCard(r) {
  return `<div class="request-card">
    <div class="request-tag">${esc(r.tag)}</div>
    <div class="request-title">${esc(r.title)}</div>
    <div class="request-desc">${esc(r.desc)}</div>
    <div class="request-footer">
      <div class="request-author">${esc(r.author)} · ${esc(r.when)}</div>
      ${r.mine ? '<span class="request-author">Ваш запрос</span>' : `<button class="respond-btn" data-respond="${r.id}">Откликнуться</button>`}
    </div>
  </div>`;
}

function allRequests() { return state.userRequests.concat(D.requests); }

function renderHome() {
  $('#hero-commission').textContent = 'от ' + pct(CFG.COMMISSION);
  $('#today-date').textContent = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  $('#home-drops-left').textContent = D.drops.reduce((a, d) => a + dropLeft(d), 0);
  renderCommission();
  $('#home-episode').innerHTML = episodeRow(D.episodes[0]);
  $('#home-products').innerHTML = D.products.slice(0, 6).map(productCard).join('');
  $('#community-cases').innerHTML = D.cases.map(caseCard).join('');
  $('#requests-list').innerHTML = allRequests().map(requestCard).join('');
}

// ══════════════════════════════
// МАГАЗИН
// ══════════════════════════════
let shopCategory = 'Все';
let shopQuery = '';

function renderShop() {
  $('#shop-badge').textContent = `Комиссия площадки — ${pct(CFG.COMMISSION)}`;
  $('#banner-commission').textContent = pct(CFG.COMMISSION);
  $('#shop-filter').innerHTML = D.categories.map(c =>
    `<button class="filter-chip${c === shopCategory ? ' active' : ''}" data-category="${esc(c)}">${esc(c)}</button>`).join('');
  const q = shopQuery.trim().toLowerCase();
  const list = D.products.filter(p =>
    (shopCategory === 'Все' || p.category === shopCategory) &&
    (!q || (p.name + ' ' + D.sellers[p.seller].name).toLowerCase().includes(q)));
  $('#shop-grid').innerHTML = list.map(productCard).join('');
  $('#shop-empty').hidden = list.length > 0;
}

function openProduct(id) {
  const p = byId(D.products, id);
  const s = D.sellers[p.seller];
  const fee = p.price * CFG.COMMISSION;
  $('#product-body').innerHTML = `
    <div class="product-img big">${p.emoji}<div class="product-seller-tag">${esc(s.name)}</div></div>
    <div class="pd">
      <div class="pd-name">${esc(p.name)}</div>
      <div class="pd-maker">${esc(s.name)} · ${esc(s.role)}</div>
      <div class="pd-prices">
        <div class="pd-price">${rub(p.price)}</div>
        ${p.market ? `<div class="product-market-price">${rub(p.market)} в рознице</div>` : ''}
      </div>
      <div class="pd-desc">${esc(p.desc)}</div>
      <div class="pd-split">Из ${rub(p.price)} мастер получит <b>${rub(p.price - fee)}</b>, площадка — ${rub(fee)} (${pct(CFG.COMMISSION)}).</div>
      <div class="pd-points">+${Math.floor(p.price / CFG.RUB_PER_POINT)} очков за покупку</div>
      <div class="btn-row">
        <button class="btn" data-chat-seller="${p.seller}" data-chat-product="${p.id}">Написать</button>
        <button class="btn primary" data-add-cart="${p.id}">В корзину</button>
      </div>
    </div>`;
  $('#product-body').scrollTop = 0;
  openOverlay('product-overlay');
}

function addToCart(id) {
  state.cart[id] = (state.cart[id] || 0) + 1;
  save();
  renderHeader();
  Native.haptic('light');
  toast('Добавлено в корзину');
  completeTask('add_to_cart');
  if (overlayStack.includes('cart-overlay')) renderCart();
}

function renderCart() {
  const items = Object.entries(state.cart).filter(([, q]) => q > 0);
  const body = $('#cart-body');
  body.classList.add('padded');
  if (!items.length) {
    body.innerHTML = `<div class="empty">Корзина пуста</div>
      <button class="btn primary" style="width:100%" data-go="shop">В магазин</button>`;
    return;
  }
  let total = 0;
  const rows = items.map(([id, q]) => {
    const p = byId(D.products, id);
    total += p.price * q;
    return `<div class="cart-item">
      <div class="cart-thumb">${p.emoji}</div>
      <div class="cart-info"><div class="cart-name">${esc(p.name)}</div><div class="cart-price">${rub(p.price)} · ${esc(D.sellers[p.seller].name)}</div></div>
      <div class="qty"><button data-qty="${id}" data-d="-1">−</button><span>${q}</span><button data-qty="${id}" data-d="1">+</button></div>
    </div>`;
  }).join('');
  const toSellers = total * (1 - CFG.COMMISSION);
  body.innerHTML = rows + `
    <div class="cart-total">
      <div class="cart-line"><span>Мастера получат</span><span>${rub(toSellers)}</span></div>
      <div class="cart-line"><span>Комиссия площадки</span><span>${rub(total - toSellers)}</span></div>
      <div class="cart-line"><span>Очки за заказ</span><span>+${Math.floor(total / CFG.RUB_PER_POINT)}</span></div>
      <div class="cart-line total"><span>Итого</span><span>${rub(total)}</span></div>
    </div>
    <button class="btn gold" style="width:100%" data-action="checkout">Оформить заказ</button>`;
}

function checkout() {
  if (!user) return requireLogin('Войдите, чтобы оформить заказ');
  const total = Object.entries(state.cart).reduce((a, [id, q]) => a + byId(D.products, id).price * q, 0);
  // Здесь будет создание заказа на сервере и оплата (ЮKassa / CloudPayments / Apple Pay).
  state.cart = {};
  save();
  renderCart();
  addPoints(Math.floor(total / CFG.RUB_PER_POINT), 'заказ оформлен');
  Native.event('order_created', { total });
}

// ══════════════════════════════
// ПОДКАСТЫ + ПЛЕЕР
// ══════════════════════════════
let podShow = 'Все';
const ICON_PLAY = '<svg viewBox="0 0 24 24" class="fill"><polygon points="7 4 20 12 7 20"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" class="fill"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';

function epState(id) {
  return state.episodes[id] || (state.episodes[id] = { pos: 0, listened: 0, done: false });
}

function episodeRow(ep) {
  const st = epState(ep.id);
  const playing = player.epId === ep.id && player.playing;
  const drop = ep.unlocks && byId(D.drops, ep.unlocks);
  return `<div class="episode">
    <div class="ep-cover">${ep.emoji}</div>
    <div class="ep-body">
      ${drop ? `<div class="ep-drop">Открывает дроп</div>` : ''}
      <div class="ep-show">${esc(ep.show)} · ${esc(ep.date)}</div>
      <div class="ep-title">${esc(ep.title)}</div>
      <div class="ep-desc">${esc(ep.desc)}</div>
      <div class="ep-foot">
        <button class="ep-play" data-play="${ep.id}">${playing ? ICON_PAUSE : ICON_PLAY}${playing ? 'Пауза' : st.pos > 0 && !st.done ? 'Продолжить' : 'Слушать'}</button>
        <span class="ep-meta">${Math.round(ep.duration / 60)} мин</span>
        <span class="ep-reward${st.done ? ' done' : ''}">${st.done ? '✓ очки получены' : `+${ep.points} очков`}</span>
      </div>
      <div class="ep-progress"><div data-ep-progress="${ep.id}" style="width:${st.pos / ep.duration * 100}%"></div></div>
    </div>
  </div>`;
}

function renderPodcasts() {
  $('#pod-filter').innerHTML = D.shows.map(s =>
    `<button class="filter-chip${s === podShow ? ' active' : ''}" data-show="${esc(s)}">${esc(s)}</button>`).join('');
  $('#episode-list').innerHTML = D.episodes.filter(e => podShow === 'Все' || e.show === podShow).map(episodeRow).join('');
  $('#home-episode').innerHTML = episodeRow(D.episodes[0]);
}

const player = { epId: null, playing: false, timer: null, audio: null, lastTime: 0, lastSave: 0 };

function playEpisode(id) {
  if (player.epId === id) { player.playing ? pausePlayer() : resumePlayer(); return; }
  stopPlayer();
  const ep = byId(D.episodes, id);
  const st = epState(id);
  if (st.pos >= ep.duration) st.pos = 0;
  player.epId = id;
  if (ep.audio) {
    player.audio = new Audio(ep.audio);
    player.audio.currentTime = st.pos;
    player.lastTime = st.pos;
    player.audio.addEventListener('timeupdate', onAudioTime);
    player.audio.addEventListener('ended', () => { pausePlayer(); });
  }
  $('#mini-player').hidden = false;
  document.body.classList.add('has-player');
  resumePlayer();
}

function resumePlayer() {
  player.playing = true;
  if (player.audio) {
    player.audio.play().catch(() => { player.playing = false; updatePlayerUI(); });
  } else {
    // Демо-режим без аудиофайла: имитируем воспроизведение
    clearInterval(player.timer);
    player.timer = setInterval(() => advance(0.25 * CFG.DEMO_PLAYBACK_RATE, true), 250);
  }
  updatePlayerUI();
  renderPodcasts();
}

function pausePlayer() {
  player.playing = false;
  clearInterval(player.timer);
  if (player.audio) player.audio.pause();
  save();
  updatePlayerUI();
  renderPodcasts();
}

function stopPlayer() {
  if (!player.epId) return;
  pausePlayer();
  if (player.audio) { player.audio.src = ''; player.audio = null; }
  player.epId = null;
}

function onAudioTime() {
  const t = player.audio.currentTime;
  const delta = t - player.lastTime;
  player.lastTime = t;
  // Перемотка не засчитывается как прослушивание
  advance(delta, delta > 0 && delta < 2, t);
}

// delta — на сколько секунд сдвинулась позиция; listened — считать ли это прослушиванием
function advance(delta, listened, absolutePos) {
  const ep = byId(D.episodes, player.epId);
  const st = epState(ep.id);
  st.pos = Math.min(ep.duration, absolutePos != null ? absolutePos : st.pos + delta);
  if (listened) st.listened = Math.min(ep.duration, st.listened + delta);
  if (!st.done && st.listened >= ep.duration * CFG.LISTEN_THRESHOLD) finishEpisode(ep);
  if (st.pos >= ep.duration && !player.audio) pausePlayer();
  if (Date.now() - player.lastSave > 2000) { player.lastSave = Date.now(); save(); }
  updatePlayerUI();
}

function forward30() {
  if (!player.epId) return;
  const ep = byId(D.episodes, player.epId);
  if (player.audio) {
    player.audio.currentTime = Math.min(ep.duration, player.audio.currentTime + 30);
  } else {
    advance(30, false);
  }
}

function finishEpisode(ep) {
  const st = epState(ep.id);
  st.done = true;
  addPoints(ep.points, 'выпуск прослушан');
  completeTask('episode_done');
  if (ep.unlocks) {
    const d = byId(D.drops, ep.unlocks);
    setTimeout(() => toast(`Открыт дроп «${d.name}»`), 2800);
  }
  Native.event('episode_done', { id: ep.id });
  renderPodcasts();
  renderPrizes();
}

function updatePlayerUI() {
  if (!player.epId) { $('#mini-player').hidden = true; document.body.classList.remove('has-player'); return; }
  const ep = byId(D.episodes, player.epId);
  const st = epState(ep.id);
  const p = st.pos / ep.duration * 100;
  $('#mp-cover').textContent = ep.emoji;
  $('#mp-title').textContent = ep.title;
  $('#mp-meta').textContent = `${mmss(st.pos)} / ${mmss(ep.duration)} · ${st.done ? 'очки получены' : `слушай до конца: +${ep.points}`}`;
  $('#mp-fill').style.width = p + '%';
  $('#mp-toggle').innerHTML = player.playing ? ICON_PAUSE : ICON_PLAY;
  $$(`[data-ep-progress="${ep.id}"]`).forEach(el => { el.style.width = p + '%'; });
}

// ══════════════════════════════
// ПРИЗЫ
// ══════════════════════════════
function dropLeft(d) { return state.dropsLeft[d.id] != null ? state.dropsLeft[d.id] : d.left; }
function dropEndsAt(d) { return state.createdAt + d.endsInHours * 3600e3; }
function timeLeft(ms) {
  if (ms <= 0) return 'завершён';
  const h = Math.floor(ms / 3600e3), m = Math.floor(ms % 3600e3 / 60e3);
  return h >= 24 ? `${Math.floor(h / 24)} д ${h % 24} ч` : `${h} ч ${m} мин`;
}

function renderPrizes() {
  $('#streak-num').textContent = state.streak;
  $('#drops-list').innerHTML = D.drops.map(d => {
    const left = dropLeft(d);
    const ms = dropEndsAt(d) - Date.now();
    const owned = state.myPrizes.some(p => p.dropId === d.id);
    const locked = d.requiresEpisode && !epState(d.requiresEpisode).done;
    let label = `Забрать за ${d.cost} очков`;
    let disabled = false;
    if (owned) { label = 'Уже ваш'; disabled = true; }
    else if (ms <= 0) { label = 'Дроп завершён'; disabled = true; }
    else if (!left) { label = 'Разобрали'; disabled = true; }
    else if (locked) { label = 'Дослушайте выпуск, чтобы открыть'; }
    else if (state.points < d.cost) { label = `Нужно ещё ${d.cost - state.points} очков`; disabled = true; }
    const rarity = { legendary: 'Легендарный', rare: 'Редкий', common: 'Обычный' }[d.rarity];
    return `<div class="drop-card">
      <div class="drop-top">
        <div class="drop-icon">${d.icon}</div>
        <div><div class="drop-name">${esc(d.name)}</div><div class="drop-desc">${esc(d.desc)}</div></div>
        <div class="prize-rarity ${d.rarity}">${rarity}</div>
      </div>
      <div class="drop-bottom">
        <div class="drop-stats"><span>Осталось <b>${left}</b> из ${d.total}</span><span class="drop-timer" data-drop-timer="${d.id}">${timeLeft(ms)}</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${left / d.total * 100}%"></div></div>
        <button class="btn ${locked && !owned ? '' : 'primary'}" data-claim="${d.id}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>
      </div>
    </div>`;
  }).join('');

  $('#tasks-list').innerHTML = D.tasks.map(t => {
    const done = !!state.tasksDone[t.id];
    return `<div class="task-item${done ? ' done-item' : ''}">
      <div class="task-check${done ? ' done' : ''}"></div>
      <div class="task-info"><div class="task-name">${esc(t.name)}</div><div class="task-pts">+${t.points} очков</div></div>
      ${done ? '' : `<button class="task-go" data-go="${t.go}">Выполнить →</button>`}
    </div>`;
  }).join('');

  $('#my-prizes').innerHTML = state.myPrizes.length ? state.myPrizes.map(p => {
    const d = byId(D.drops, p.dropId);
    return `<div class="prize-card">
      <div class="prize-icon">${d.icon}</div>
      <div class="prize-info"><div class="prize-name">${esc(d.name)}</div><div class="prize-code">${esc(p.code)}</div></div>
    </div>`;
  }).join('') : '<div class="prize-desc">Пока пусто — заберите первый приз из дропов выше.</div>';
}

function claimDrop(id) {
  const d = byId(D.drops, id);
  if (d.requiresEpisode && !epState(d.requiresEpisode).done) {
    const ep = byId(D.episodes, d.requiresEpisode);
    switchTab('podcasts');
    toast(`Дослушайте «${ep.title}»`);
    return;
  }
  if (!user) return requireLogin('Войдите, чтобы забрать приз');
  const left = dropLeft(d);
  if (!left || state.points < d.cost || state.myPrizes.some(p => p.dropId === id)) return;
  if (!confirm(`Обменять ${d.cost} очков на «${d.name}»?`)) return;
  // В продакшене списание и резерв приза делает сервер атомарно — иначе лимит можно обойти.
  state.points -= d.cost;
  state.dropsLeft[id] = left - 1;
  const code = 'PR-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  state.myPrizes.unshift({ dropId: id, code, at: Date.now() });
  save();
  renderHeader();
  renderPrizes();
  renderHome();
  Native.haptic('success');
  toast(`Приз ваш! Код: ${code}`);
}

// ══════════════════════════════
// ЧАТЫ
// ══════════════════════════════
let openThreadId = null;
let pendingProduct = null;

function threadInfo(t) {
  if (t.kind === 'ai') return { name: 'ИИ-ассистент', role: 'Отвечает сразу', initial: '✦' };
  if (t.kind === 'seller') { const s = D.sellers[t.seller]; return { name: s.name, role: s.role, initial: s.name[0] }; }
  return { name: t.name, role: t.role || 'Участник', initial: t.name[0] };
}

function renderChats() {
  $('#chat-list').innerHTML = state.chats.map(t => {
    const info = threadInfo(t);
    const last = t.messages[t.messages.length - 1];
    const preview = last ? (last.from === 'me' ? 'Вы: ' : '') + last.text : '';
    return `<button class="msg-item" data-thread="${t.id}">
      <div class="msg-avatar${t.kind === 'ai' ? ' ai' : ''}">${esc(info.initial)}</div>
      <div class="msg-info">
        <div class="msg-name">${esc(info.name)}${t.kind === 'ai' ? '<span class="msg-role">ИИ</span>' : ''}</div>
        <div class="msg-preview">${esc(preview)}</div>
      </div>
      <div class="msg-side">
        <div class="msg-time">${last ? esc(last.time) : ''}</div>
        ${t.unread ? `<div class="msg-unread">${t.unread}</div>` : ''}
      </div>
    </button>`;
  }).join('');
}

function getOrCreateThread(opts) {
  let t = state.chats.find(c => c.id === opts.id);
  if (!t) {
    t = Object.assign({ unread: 0, messages: [] }, opts);
    state.chats.splice(1, 0, t);
    save();
  }
  return t;
}

function openThread(id, productId) {
  const t = state.chats.find(c => c.id === id);
  if (!t) return;
  openThreadId = id;
  pendingProduct = productId || null;
  t.unread = 0;
  save();
  const info = threadInfo(t);
  const av = $('#thread-avatar');
  av.textContent = info.initial;
  av.className = 'msg-avatar small' + (t.kind === 'ai' ? ' ai' : '');
  $('#thread-title').textContent = info.name;
  $('#thread-sub').textContent = info.role;
  renderThread();
  renderSuggestions();
  renderHeader();
  renderChats();
  openOverlay('thread-overlay');
}

function bubble(m, t) {
  const p = m.productId && byId(D.products, m.productId);
  const label = m.from === 'them' && t.kind === 'ai' ? '<div class="ai-label">Ассистент</div>' : '';
  return `<div class="chat-bubble ${m.from}">${label}${p ? `<div class="chat-product" data-product="${p.id}">
      <div class="cart-thumb">${p.emoji}</div><div><div class="cart-name">${esc(p.name)}</div><div class="cart-price">${rub(p.price)}</div></div>
    </div>` : ''}${esc(m.text)}${m.time ? `<div class="chat-time">${esc(m.time)}</div>` : ''}</div>`;
}

function renderThread() {
  const t = state.chats.find(c => c.id === openThreadId);
  if (!t) return;
  const body = $('#thread-body');
  body.innerHTML = t.messages.map(m => bubble(m, t)).join('') +
    (t.typing ? `<div class="chat-bubble them">${t.kind === 'ai' ? '<div class="ai-label">Ассистент</div>' : ''}<span class="ai-typing">···</span></div>` : '');
  body.scrollTop = body.scrollHeight;
}

function renderSuggestions() {
  const t = state.chats.find(c => c.id === openThreadId);
  let chips = [];
  if (t.kind === 'ai') chips = D.aiSuggestions;
  else if (pendingProduct) chips = ['Есть в наличии?', 'Сколько стоит доставка?', 'Можно сделать на заказ?'];
  const box = $('#thread-suggestions');
  box.hidden = !chips.length;
  box.innerHTML = chips.map(c => `<button class="suggest-chip" data-suggest="${esc(c)}">${esc(c)}</button>`).join('');
}

function sendMessage(text) {
  text = text.trim();
  const t = state.chats.find(c => c.id === openThreadId);
  if (!text || !t || t.typing) return;
  const msg = { from: 'me', text, time: nowTime() };
  if (pendingProduct) { msg.productId = pendingProduct; pendingProduct = null; }
  t.messages.push(msg);
  save();
  renderThread();
  renderSuggestions();
  renderChats();
  if (t.kind === 'ai') { askAI(t); return; }
  if (t.kind === 'seller') completeTask('message_seller');
  // Демо: продавец отвечает автоматически. В продакшене — WebSocket / push.
  t.typing = true;
  renderThread();
  setTimeout(() => {
    t.typing = false;
    t.messages.push({ from: 'them', text: D.sellerAutoReplies[Math.floor(Math.random() * D.sellerAutoReplies.length)], time: nowTime() });
    if (openThreadId !== t.id) t.unread = (t.unread || 0) + 1;
    save();
    renderThread();
    renderChats();
    renderHeader();
  }, 1400);
}

function aiContext() {
  const catalog = D.products.map(p => `${p.name} — ${p.price} ₽ (${p.category}, продавец ${D.sellers[p.seller].name})`).join('\n');
  const drops = D.drops.map(d => `${d.name}: ${d.cost} очков, осталось ${dropLeft(d)} из ${d.total}`
    + (d.requiresEpisode ? `, нужно дослушать выпуск «${byId(D.episodes, d.requiresEpisode).title}»` : '')).join('\n');
  const eps = D.episodes.map(e => `«${e.title}» (${e.show}, ${Math.round(e.duration / 60)} мин, +${e.points} очков)`).join('\n');
  return `Комиссия площадки: ${pct(CFG.COMMISSION)}.\nОчки пользователя: ${state.points}.\n\nКаталог:\n${catalog}\n\nПризы:\n${drops}\n\nПодкасты:\n${eps}`;
}

async function askAI(t) {
  completeTask('ask_ai');
  t.typing = true;
  renderThread();
  let reply;
  try {
    const history = t.messages.slice(-20).map(m => ({ role: m.from === 'me' ? 'user' : 'assistant', content: m.text }));
    const res = await fetch(CFG.API_BASE + '/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, context: aiContext() }),
    });
    const data = await res.json().catch(() => ({}));
    reply = res.ok && data.reply ? data.reply : (data.error || 'Ассистент сейчас недоступен. Попробуйте позже.');
  } catch (e) {
    reply = 'Нет соединения с сервером. Проверьте интернет и попробуйте ещё раз.';
  }
  t.typing = false;
  t.messages.push({ from: 'them', text: reply, time: nowTime() });
  if (openThreadId !== t.id) t.unread = (t.unread || 0) + 1;
  save();
  renderThread();
  renderChats();
  renderHeader();
}

// ══════════════════════════════
// АККАУНТ
// ══════════════════════════════
let authView = 'login';   // login | register | verify | reset | reset-confirm
let authEmail = '';
let authBusy = false;

function renderAll() {
  renderHeader();
  renderHome();
  renderShop();
  renderPodcasts();
  renderChats();
  renderPrizes();
  renderProfile();
  if (overlayStack.includes('cart-overlay')) renderCart();
}

function renderProfileButton() {
  const btn = $('#profile-btn');
  btn.classList.toggle('signed-in', !!user);
  btn.innerHTML = user
    ? esc((user.name || user.email)[0].toUpperCase())
    : '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>';
}

function requireLogin(reason) {
  authView = 'login';
  renderProfile();
  openOverlay('profile-overlay');
  toast(reason);
}

function field(name, label, type, attrs) {
  return `<label class="field"><span>${label}</span><input name="${name}" type="${type}" ${attrs || ''}></label>`;
}

function renderProfile() {
  renderProfileButton();
  const body = $('#profile-body');
  $('#profile-title').textContent = user ? 'Профиль' : 'Вход';

  if (user) {
    const prizes = state.myPrizes.length;
    body.innerHTML = `
      <div class="profile-head">
        <div class="profile-avatar">${esc((user.name || user.email)[0].toUpperCase())}</div>
        <div>
          <div class="profile-name">${esc(user.name || 'Без имени')}</div>
          <div class="profile-email">${esc(user.email)} ${user.emailVerified ? '<span class="verified">✓ подтверждён</span>' : ''}</div>
        </div>
      </div>
      <div class="profile-stats">
        <div><b>${state.points}</b><span>очков</span></div>
        <div><b>${state.streak}</b><span>дней подряд</span></div>
        <div><b>${prizes}</b><span>призов</span></div>
      </div>
      <form class="auth-form" data-form="profile">
        ${field('name', 'Имя', 'text', `value="${esc(user.name)}" autocomplete="name" maxlength="80"`)}
        ${field('city', 'Город', 'text', `value="${esc(user.city)}" autocomplete="address-level2" maxlength="80"`)}
        ${field('phone', 'Телефон', 'tel', `value="${esc(user.phone)}" autocomplete="tel" maxlength="30"`)}
        <label class="check"><input type="checkbox" name="isSeller" ${user.isSeller ? 'checked' : ''}> Я продаю свои товары</label>
        <button class="btn primary" type="submit">Сохранить</button>
      </form>
      <div class="profile-actions">
        <button class="btn" data-action="logout">Выйти</button>
        <button class="link-btn danger" data-action="delete-account">Удалить аккаунт</button>
      </div>`;
    return;
  }

  const views = {
    login: `
      <div class="auth-lead">Войдите, чтобы оформлять заказы, забирать призы и не терять прогресс на другом устройстве.</div>
      <div class="segmented"><button class="seg active">Вход</button><button class="seg" data-auth-view="register">Регистрация</button></div>
      <form class="auth-form" data-form="login">
        ${field('email', 'Email', 'email', `value="${esc(authEmail)}" autocomplete="email" required`)}
        ${field('password', 'Пароль', 'password', 'autocomplete="current-password" required')}
        <button class="btn primary" type="submit">Войти</button>
        <button class="link-btn" type="button" data-auth-view="reset">Забыли пароль?</button>
      </form>`,
    register: `
      <div class="auth-lead">Регистрация займёт минуту. На почту придёт код подтверждения.</div>
      <div class="segmented"><button class="seg" data-auth-view="login">Вход</button><button class="seg active">Регистрация</button></div>
      <form class="auth-form" data-form="register">
        ${field('name', 'Имя', 'text', 'autocomplete="name" maxlength="80"')}
        ${field('email', 'Email', 'email', `value="${esc(authEmail)}" autocomplete="email" required`)}
        ${field('password', 'Пароль (от 8 символов)', 'password', 'autocomplete="new-password" minlength="8" required')}
        <button class="btn primary" type="submit">Зарегистрироваться</button>
        <div class="auth-note">Регистрируясь, вы соглашаетесь с правилами сервиса и обработкой персональных данных.</div>
      </form>`,
    verify: `
      <div class="auth-lead">Мы отправили 6-значный код на <b>${esc(authEmail)}</b>. Проверьте папку «Спам», если письма нет.</div>
      <form class="auth-form" data-form="verify">
        ${field('code', 'Код из письма', 'text', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required class="code-input"')}
        <button class="btn primary" type="submit">Подтвердить</button>
        <button class="link-btn" type="button" data-action="resend-code">Отправить код ещё раз</button>
        <button class="link-btn" type="button" data-auth-view="login">← Назад</button>
      </form>`,
    reset: `
      <div class="auth-lead">Укажите почту — пришлём код для сброса пароля.</div>
      <form class="auth-form" data-form="reset">
        ${field('email', 'Email', 'email', `value="${esc(authEmail)}" autocomplete="email" required`)}
        <button class="btn primary" type="submit">Получить код</button>
        <button class="link-btn" type="button" data-auth-view="login">← Назад</button>
      </form>`,
    'reset-confirm': `
      <div class="auth-lead">Если аккаунт с адресом <b>${esc(authEmail)}</b> существует, мы отправили на него код.</div>
      <form class="auth-form" data-form="reset-confirm">
        ${field('code', 'Код из письма', 'text', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required class="code-input"')}
        ${field('password', 'Новый пароль (от 8 символов)', 'password', 'autocomplete="new-password" minlength="8" required')}
        <button class="btn primary" type="submit">Сменить пароль</button>
        <button class="link-btn" type="button" data-auth-view="reset">← Назад</button>
      </form>`,
  };
  body.innerHTML = views[authView] + '<div class="form-error" id="auth-error"></div>';
}

// Пользователь вошёл: подтягиваем прогресс из базы или переносим туда гостевой
function applyLogin(data, quiet) {
  user = data.user;
  if (data.state && data.state.v === 1) {
    state = data.state;
    checkStreak();
  } else {
    pushState();
  }
  save();
  renderAll();
  if (!quiet) toast(`Добро пожаловать${user.name ? ', ' + user.name : ''}!`);
}

async function submitAuthForm(form) {
  if (authBusy) return;
  const f = Object.fromEntries(new FormData(form));
  const errBox = $('#auth-error');
  if (errBox) errBox.textContent = '';
  authBusy = true;
  form.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    switch (form.dataset.form) {
      case 'login': {
        authEmail = f.email.trim();
        const r = await api('POST', '/api/auth/login', { email: f.email, password: f.password });
        if (r.needVerify) { authView = 'verify'; renderProfile(); toast('Подтвердите почту — код отправлен'); }
        else { applyLogin(r); closeOverlay('profile-overlay'); }
        break;
      }
      case 'register': {
        authEmail = f.email.trim();
        await api('POST', '/api/auth/register', { email: f.email, password: f.password, name: f.name });
        authView = 'verify';
        renderProfile();
        break;
      }
      case 'verify': {
        const r = await api('POST', '/api/auth/verify', { email: authEmail, code: f.code });
        applyLogin(r);
        closeOverlay('profile-overlay');
        break;
      }
      case 'reset':
        authEmail = f.email.trim();
        await api('POST', '/api/auth/reset/request', { email: f.email });
        authView = 'reset-confirm';
        renderProfile();
        break;
      case 'reset-confirm': {
        const r = await api('POST', '/api/auth/reset/confirm', { email: authEmail, code: f.code, password: f.password });
        applyLogin(r, true);
        toast('Пароль изменён');
        closeOverlay('profile-overlay');
        break;
      }
      case 'profile': {
        const r = await api('PATCH', '/api/me', { name: f.name, city: f.city, phone: f.phone, isSeller: !!f.isSeller });
        user = r.user;
        renderProfile();
        toast('Сохранено');
        break;
      }
    }
  } catch (e) {
    const box = $('#auth-error');
    if (box) box.textContent = e.message; else toast(e.message);
    if (e.status === 401 && form.dataset.form === 'profile') { user = null; renderAll(); }
  } finally {
    authBusy = false;
    form.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}

async function logout() {
  pushState();
  try { await api('POST', '/api/auth/logout'); } catch (e) { /* всё равно выходим локально */ }
  user = null;
  // На общем устройстве данные прошлого пользователя не должны оставаться
  state = initialState();
  checkStreak();
  save();
  authView = 'login';
  renderAll();
  closeOverlay('profile-overlay');
  toast('Вы вышли из аккаунта');
}

async function deleteAccount() {
  const password = prompt('Удаление аккаунта необратимо: профиль, очки и призы будут стёрты.\nВведите пароль для подтверждения:');
  if (!password) return;
  try {
    await api('DELETE', '/api/me', { password });
  } catch (e) {
    return toast(e.message);
  }
  user = null;
  state = initialState();
  checkStreak();
  save();
  authView = 'login';
  renderAll();
  closeOverlay('profile-overlay');
  toast('Аккаунт удалён');
}

document.addEventListener('submit', e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  submitAuthForm(form);
});

// ══════════════════════════════
// СОБЫТИЯ
// ══════════════════════════════
document.addEventListener('click', e => {
  const el = e.target.closest('[data-auth-view],[data-go],[data-tab],[data-product],[data-add-cart],[data-chat-seller],[data-qty],[data-follow],[data-respond],[data-category],[data-show],[data-play],[data-claim],[data-thread],[data-suggest],[data-close],[data-action],[data-seg]');
  if (!el) return;
  const ds = el.dataset;

  if (ds.authView) {
    const input = $('#profile-body input[name=email]');
    if (input && input.value) authEmail = input.value.trim();
    authView = ds.authView;
    return renderProfile();
  }
  if (ds.tab) return switchTab(ds.tab);
  if (ds.go) return switchTab(ds.go);
  if (ds.close !== undefined) return closeOverlay(el.closest('[data-overlay]').id);
  if (ds.addCart) return addToCart(ds.addCart);
  if (ds.chatSeller) {
    getOrCreateThread({ id: ds.chatSeller, kind: 'seller', seller: ds.chatSeller });
    return openThread(ds.chatSeller, ds.chatProduct);
  }
  if (ds.product) return openProduct(ds.product);
  if (ds.qty) {
    state.cart[ds.qty] = Math.max(0, (state.cart[ds.qty] || 0) + +ds.d);
    if (!state.cart[ds.qty]) delete state.cart[ds.qty];
    save(); renderHeader(); return renderCart();
  }
  if (ds.follow) {
    const wasFollowing = !!state.following[ds.follow];
    if (wasFollowing) delete state.following[ds.follow]; else state.following[ds.follow] = true;
    save(); renderHome();
    if (!wasFollowing) completeTask('follow_case');
    return;
  }
  if (ds.respond) {
    const r = byId(allRequests(), ds.respond);
    const t = getOrCreateThread({ id: 'req-' + r.id, kind: 'user', name: r.author, role: r.title });
    return openThread(t.id);
  }
  if (ds.category) { shopCategory = ds.category; return renderShop(); }
  if (ds.show) { podShow = ds.show; return renderPodcasts(); }
  if (ds.play) return playEpisode(ds.play);
  if (ds.claim) return claimDrop(ds.claim);
  if (ds.thread) return openThread(ds.thread);
  if (ds.suggest) return sendMessage(ds.suggest);
  if (ds.seg) {
    $$('#community-tabs .seg').forEach(b => b.classList.toggle('active', b === el));
    $('#community-cases').hidden = ds.seg !== 'cases';
    $('#community-requests').hidden = ds.seg !== 'requests';
    return;
  }

  switch (ds.action) {
    case 'open-ai': return openThread('ai');
    case 'open-cart': renderCart(); return openOverlay('cart-overlay');
    case 'open-profile': renderProfile(); return openOverlay('profile-overlay');
    case 'logout': return logout();
    case 'delete-account': return deleteAccount();
    case 'resend-code':
      return api('POST', '/api/auth/resend', { email: authEmail })
        .then(() => toast('Код отправлен ещё раз'))
        .catch(err => toast(err.message));
    case 'checkout': return checkout();
    case 'become-seller':
      openThread('ai');
      $('#thread-input').value = 'Хочу продавать в Пространстве. С чего начать и сколько я буду получать с продажи?';
      return;
    case 'add-request': {
      const title = prompt('Что вы ищете?');
      if (!title || !title.trim()) return;
      const desc = prompt('Пара слов подробнее (необязательно)') || '';
      state.userRequests.unshift({ id: 'u' + Date.now(), tag: 'Запрос', title: title.trim(), desc: desc.trim(), author: 'Вы', when: 'только что', mine: true });
      save(); renderHome();
      return toast('Запрос опубликован');
    }
  }
});

$('#cc-price').addEventListener('input', renderCommission);
$('#shop-search').addEventListener('input', e => { shopQuery = e.target.value; renderShop(); });
$('#mp-toggle').addEventListener('click', () => player.playing ? pausePlayer() : resumePlayer());
$('#mp-fwd').addEventListener('click', forward30);

const threadInput = $('#thread-input');
$('#thread-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = threadInput.value;
  threadInput.value = '';
  threadInput.style.height = '';
  sendMessage(v);
});
threadInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#thread-form').requestSubmit(); }
});
threadInput.addEventListener('input', () => {
  threadInput.style.height = 'auto';
  threadInput.style.height = Math.min(threadInput.scrollHeight, 120) + 'px';
});

// Обновление таймеров дропов
setInterval(() => {
  D.drops.forEach(d => {
    const el = document.querySelector(`[data-drop-timer="${d.id}"]`);
    if (el) el.textContent = timeLeft(dropEndsAt(d) - Date.now());
  });
}, 30e3);

// Сохраняем позицию плеера при сворачивании приложения
document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); pushState(); } });

// ══════════════════════════════
// СТАРТ
// ══════════════════════════════
renderAll();

// Если есть активная сессия — подтягиваем профиль и прогресс из базы
api('GET', '/api/me').then(r => applyLogin(r, true)).catch(() => { /* гость */ });

// Глубокие ссылки: #shop, #podcasts, #chats, #prizes, #ai, #product=p1
(function handleHash() {
  const h = location.hash.slice(1);
  if (!h) return;
  const [k, v] = h.split('=');
  if (k === 'product' && byId(D.products, v)) openProduct(v);
  else if (['home', 'shop', 'podcasts', 'chats', 'prizes', 'ai'].includes(k)) switchTab(k);
  else if (k === 'login') { renderProfile(); openOverlay('profile-overlay'); }
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Доступ для нативной оболочки (например, открыть вкладку из push-уведомления)
window.App = { switchTab, openProduct, openThread, playEpisode, openProfile: () => { renderProfile(); openOverlay('profile-overlay'); } };
})();
