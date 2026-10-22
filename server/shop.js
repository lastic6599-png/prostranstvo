// Магазин: каталог, оформление заказа (в том числе без регистрации), мои заказы, отмена.
// Цены и остатки всегда берутся из базы: клиент присылает только id товаров и количество.
'use strict';

const crypto = require('crypto');
const { HttpError, normEmail, validateEmail, clean } = require('./auth');

// Подарочная упаковка, ₽. Поменяйте в .env: GIFT_WRAP_PRICE=350
const GIFT_WRAP_PRICE = Number.isFinite(+process.env.GIFT_WRAP_PRICE) && process.env.GIFT_WRAP_PRICE !== ''
  ? Math.max(0, Math.round(+process.env.GIFT_WRAP_PRICE)) : 300;
const MAX_POSITIONS = 30;
const MAX_QTY = 20;

const DELIVERY = {
  cdek_pvz: 'Пункт выдачи СДЭК',
  courier: 'Курьер до двери',
};

const STATUS = {
  awaiting_payment: 'Ждёт оплаты',
  paid: 'Оплачен',
  shipped: 'Передан в доставку',
  delivered: 'Получен',
  cancelled: 'Отменён',
};

function publicProduct(p) {
  return {
    id: p.id, seller: p.seller_id, name: p.name, desc: p.description, category: p.category,
    emoji: p.emoji, image: p.image_url || null, price: p.price, market: p.market_price || null,
    stock: p.stock, exclusive: !!p.is_exclusive, gift: !!p.is_gift,
  };
}

function publicOrder(o, items) {
  return {
    id: o.id, number: o.number, status: o.status, statusLabel: STATUS[o.status] || o.status,
    itemsTotal: o.items_total, giftWrapCost: o.gift_wrap_cost, deliveryCost: o.delivery_cost, total: o.total,
    deliveryMethod: o.delivery_method, deliveryLabel: DELIVERY[o.delivery_method] || o.delivery_method,
    deliveryAddress: o.delivery_address, isGift: !!o.is_gift, recipientName: o.recipient_name,
    createdAt: o.created_at,
    items: items.map(i => ({ productId: i.product_id, name: i.name, unitPrice: i.unit_price, qty: i.qty })),
  };
}

const phoneDigits = s => String(s || '').replace(/\D/g, '');

function createShop(db, auth) {
  async function ordersWithItems(orders) {
    if (!orders.length) return [];
    const ids = orders.map(o => o.id);
    const items = await db.all(
      `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY name`, ids);
    return orders.map(o => publicOrder(o, items.filter(i => i.order_id === o.id)));
  }

  // Гостевые заказы привязываются к аккаунту, когда владелец почты подтвердил её или вошёл
  async function claimOrders(userId, email) {
    await db.run('UPDATE orders SET user_id = ?, updated_at = ? WHERE user_id IS NULL AND contact_email = ?',
      [userId, Date.now(), normEmail(email)]);
  }

  async function newOrderNumber(q) {
    for (let i = 0; i < 10; i++) {
      const number = 'П-' + String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      if (!(await q.get('SELECT 1 AS x FROM orders WHERE number = ?', [number]))) return number;
    }
    throw new Error('Не удалось подобрать номер заказа');
  }

  function parseItems(raw) {
    if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Корзина пуста.');
    const merged = new Map();
    for (const it of raw) {
      const id = clean(it && it.productId, 40);
      const qty = Math.floor(+(it && it.qty));
      if (!id || !(qty >= 1)) throw new HttpError(400, 'Проверьте состав корзины.');
      merged.set(id, (merged.get(id) || 0) + qty);
    }
    if (merged.size > MAX_POSITIONS) throw new HttpError(400, `Не больше ${MAX_POSITIONS} разных товаров в заказе.`);
    for (const [, qty] of merged) if (qty > MAX_QTY) throw new HttpError(400, `Не больше ${MAX_QTY} штук одного товара.`);
    return merged;
  }

  const routes = {
    async 'GET /api/catalog'() {
      const products = await db.all('SELECT * FROM products WHERE is_active = 1 ORDER BY sort, created_at');
      const sellers = await db.all('SELECT id, name, role FROM sellers');
      return {
        products: products.map(publicProduct),
        sellers: Object.fromEntries(sellers.map(s => [s.id, { name: s.name, role: s.role }])),
        giftWrapPrice: GIFT_WRAP_PRICE,
        delivery: DELIVERY,
      };
    },

    async 'POST /api/orders'(req, res, body) {
      const user = await auth.currentUser(req);
      const items = parseItems(body.items);

      const c = body.contact || {};
      const name = clean(c.name, 80);
      const phone = clean(c.phone, 30);
      const email = user ? user.email : normEmail(c.email);
      if (name.length < 2) throw new HttpError(400, 'Укажите имя получателя заказа.');
      if (phoneDigits(phone).length < 10) throw new HttpError(400, 'Проверьте номер телефона.');
      validateEmail(email);

      const d = body.delivery || {};
      const method = String(d.method || '');
      const address = clean(d.address, 300);
      if (!DELIVERY[method]) throw new HttpError(400, 'Выберите способ доставки.');
      if (address.length < 5) throw new HttpError(400, method === 'courier' ? 'Укажите адрес доставки.' : 'Укажите город и пункт выдачи.');

      const g = body.gift || {};
      const isGift = !!g.isGift;
      const recipientName = isGift ? clean(g.recipientName, 80) : '';
      const recipientPhone = isGift ? clean(g.recipientPhone, 30) : '';
      const giftMessage = isGift ? clean(g.message, 300) : '';
      const giftWrap = isGift && !!g.wrap;
      if (isGift && recipientName.length < 2) throw new HttpError(400, 'Укажите имя получателя подарка.');
      if (isGift && phoneDigits(recipientPhone).length < 10) throw new HttpError(400, 'Проверьте телефон получателя подарка.');

      const comment = clean(body.comment, 500);
      if (body.agree !== true) throw new HttpError(400, 'Нужно согласие с условиями покупки.');

      const ids = [...items.keys()];
      const now = Date.now();
      const order = await db.tx(async q => {
        const rows = await q.all(
          `SELECT p.*, s.commission_bp FROM products p JOIN sellers s ON s.id = p.seller_id
           WHERE p.is_active = 1 AND p.id IN (${ids.map(() => '?').join(',')})`, ids);
        const byId = new Map(rows.map(r => [r.id, r]));
        let itemsTotal = 0;
        let commissionTotal = 0;
        const lines = [];
        for (const [id, qty] of items) {
          const p = byId.get(id);
          if (!p) throw new HttpError(409, 'Один из товаров больше не продаётся. Обновите корзину.', { productId: id });
          // Резервируем остаток: если кто-то успел купить раньше, запрос не изменит строку
          const r = await q.run('UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ?', [qty, now, id, qty]);
          if (r.changes !== 1) {
            throw new HttpError(409, p.stock > 0 ? `«${p.name}»: в наличии только ${p.stock} шт.` : `«${p.name}» закончился.`,
              { productId: id, stock: p.stock });
          }
          const sum = p.price * qty;
          const commission = Math.round(sum * p.commission_bp / 10000);
          itemsTotal += sum;
          commissionTotal += commission;
          lines.push({ id, seller: p.seller_id, name: p.name, price: p.price, qty, commission });
        }
        const giftWrapCost = giftWrap ? GIFT_WRAP_PRICE : 0;
        const deliveryCost = 0; // появится с интеграцией СДЭК
        const o = {
          id: crypto.randomUUID(), number: await newOrderNumber(q), user_id: user ? user.id : null,
          status: 'awaiting_payment', items_total: itemsTotal, gift_wrap_cost: giftWrapCost, delivery_cost: deliveryCost,
          total: itemsTotal + giftWrapCost + deliveryCost, commission_total: commissionTotal,
          contact_name: name, contact_phone: phone, contact_email: email, delivery_method: method, delivery_address: address,
          is_gift: isGift ? 1 : 0, gift_wrap: giftWrap ? 1 : 0, gift_message: giftMessage,
          recipient_name: recipientName, recipient_phone: recipientPhone, comment, created_at: now, updated_at: now,
        };
        await q.run(`INSERT INTO orders (id, number, user_id, status, items_total, gift_wrap_cost, delivery_cost, total,
            commission_total, contact_name, contact_phone, contact_email, delivery_method, delivery_address,
            is_gift, gift_wrap, gift_message, recipient_name, recipient_phone, comment, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [o.id, o.number, o.user_id, o.status, o.items_total, o.gift_wrap_cost, o.delivery_cost, o.total,
            o.commission_total, o.contact_name, o.contact_phone, o.contact_email, o.delivery_method, o.delivery_address,
            o.is_gift, o.gift_wrap, o.gift_message, o.recipient_name, o.recipient_phone, o.comment, o.created_at, o.updated_at]);
        for (const l of lines) {
          await q.run(`INSERT INTO order_items (order_id, product_id, seller_id, name, unit_price, qty, commission)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [o.id, l.id, l.seller, l.name, l.price, l.qty, l.commission]);
        }
        return publicOrder(o, lines.map(l => ({ product_id: l.id, name: l.name, unit_price: l.price, qty: l.qty })));
      });

      // Гость: создаём аккаунт по почте (или просим войти, если он уже есть)
      const account = user ? 'ok' : await auth.prepareGuestAccount(email, name, phone);
      return { order, account, email };
    },

    async 'GET /api/orders'(req) {
      const user = await auth.currentUser(req);
      if (!user) throw new HttpError(401, 'Войдите в аккаунт.');
      if (user.email_verified) await claimOrders(user.id, user.email);
      const orders = await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [user.id]);
      return { orders: await ordersWithItems(orders) };
    },

    // Отменить можно только неоплаченный заказ; товар возвращается в остаток
    async 'POST /api/orders/cancel'(req, res, body) {
      const user = await auth.currentUser(req);
      if (!user) throw new HttpError(401, 'Войдите в аккаунт.');
      const id = clean(body.id, 60);
      await db.tx(async q => {
        const r = await q.run(`UPDATE orders SET status = 'cancelled', updated_at = ?
          WHERE id = ? AND user_id = ? AND status = 'awaiting_payment'`, [Date.now(), id, user.id]);
        if (r.changes !== 1) throw new HttpError(409, 'Этот заказ уже нельзя отменить.');
        const items = await q.all('SELECT product_id, qty FROM order_items WHERE order_id = ?', [id]);
        for (const i of items) await q.run('UPDATE products SET stock = stock + ? WHERE id = ?', [i.qty, i.product_id]);
      });
      const o = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
      return { order: (await ordersWithItems([o]))[0] };
    },
  };

  return { routes, claimOrders };
}

module.exports = { createShop };
