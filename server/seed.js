// Стартовый каталог для разработки и демо. Записывается в базу один раз, если товаров ещё нет.
// Когда появится кабинет продавца, товары будут добавлять сами продавцы.
'use strict';

const sellers = [
  { id: 's1', name: 'Андрей М.', role: 'Мастер по дереву · Москва' },
  { id: 's2', name: 'Марина К.', role: 'Хендмейд · СПб' },
  { id: 's3', name: 'Ольга Т.', role: 'Ароматика · Казань' },
  { id: 's4', name: 'Виктор Л.', role: 'Кожевник · Екатеринбург' },
  { id: 's5', name: 'Семья Громовых', role: 'Пасека · Алтай' },
  { id: 's6', name: 'Надя В.', role: 'Декор · Новосибирск' },
];

const products = [
  { id: 'p1', seller: 's1', emoji: '🪵', name: 'Поднос из дуба ручной работы', category: 'Мебель', price: 3200, market: 5500, stock: 12, gift: true,
    desc: 'Цельный массив дуба, покрытие натуральным маслом с воском. 45 × 30 см. Подходит для подачи и как элемент декора.' },
  { id: 'p2', seller: 's2', emoji: '💍', name: 'Серьги из серебра с янтарём', category: 'Украшения', price: 1800, market: 2900, stock: 8, gift: true,
    desc: 'Серебро 925 пробы, балтийский янтарь. Каждая пара уникальна — камни подбираются вручную.' },
  { id: 'p3', seller: 's3', emoji: '🕯️', name: 'Свечи из соевого воска, набор 3 шт', category: 'Декор', price: 890, market: 1400, stock: 40, gift: true,
    desc: 'Соевый воск, хлопковый фитиль, ароматы: сандал, инжир, табак-ваниль. Время горения ~35 часов каждая.' },
  { id: 'p4', seller: 's4', emoji: '🎒', name: 'Кожаный рюкзак ручного шитья', category: 'Одежда', price: 12500, market: 22000, stock: 3,
    desc: 'Растительное дубление, вощёная нить, латунная фурнитура. Отделение для ноутбука 14".' },
  { id: 'p5', seller: 's5', emoji: '🍯', name: 'Мёд таёжный, 1 кг', category: 'Еда', price: 750, market: 1100, stock: 60,
    desc: 'Собран в 2026 году на собственной пасеке в Горном Алтае. Без нагрева и добавок.' },
  { id: 'p6', seller: 's6', emoji: '🪴', name: 'Кашпо из бетона, ручная лепка', category: 'Декор', price: 640, market: 980, stock: 25,
    desc: 'Архитектурный бетон с водоотталкивающей пропиткой. Дренажное отверстие, войлочная подошва.' },
  { id: 'p7', seller: 's2', emoji: '🧣', name: 'Шарф из мериноса', category: 'Одежда', price: 2400, market: 3800, stock: 6, gift: true,
    desc: 'Ручное вязание, 100% меринос. Не колется, 180 × 30 см.' },
  { id: 'p8', seller: 's1', emoji: '🪑', name: 'Табурет из ясеня', category: 'Мебель', price: 6900, market: 11000, stock: 2,
    desc: 'Шиповое соединение без металла, высота 45 см. Выдерживает до 150 кг.' },
  { id: 'p9', seller: 's6', emoji: '🧺', name: 'Корзина из ротанга', category: 'Ручная работа', price: 1900, market: 2700, stock: 10,
    desc: 'Плетение вручную, диаметр 35 см. Для пледов, игрушек или белья.' },
  { id: 'p10', seller: 's5', emoji: '🍵', name: 'Иван-чай ферментированный, 200 г', category: 'Еда', price: 420, market: 690, stock: 80, gift: true,
    desc: 'Листовой, ручная ферментация. Мягкий вкус с медовыми нотами.' },
];

async function seedCatalog(db) {
  const row = await db.get('SELECT COUNT(*) AS n FROM products');
  if (Number(row.n) > 0) return false;
  const now = Date.now();
  await db.tx(async q => {
    for (const s of sellers) {
      await q.run('INSERT INTO sellers (id, name, role, created_at) VALUES (?, ?, ?, ?)', [s.id, s.name, s.role, now]);
    }
    let sort = 0;
    for (const p of products) {
      await q.run(`INSERT INTO products (id, seller_id, name, description, category, emoji, price, market_price, stock,
          is_gift, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.seller, p.name, p.desc, p.category, p.emoji, p.price, p.market || null, p.stock, p.gift ? 1 : 0, sort++, now, now]);
    }
  });
  return true;
}

module.exports = { seedCatalog };
