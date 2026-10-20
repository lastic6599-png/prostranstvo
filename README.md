# Пространство

Маркетплейс вроде Ozon/WB, но с низкой комиссией (5%), чатами с продавцами, ИИ-ассистентом и подкастами, за прослушивание которых дают очки на лимитированные призы.

Сейчас это рабочий прототип: веб-приложение (PWA), которое без переделок оборачивается в iOS-приложение.

## Что есть

| Раздел | Что работает |
|---|---|
| **Главная** | калькулятор «сколько получит продавец» (5% против 15–25%), новый выпуск, популярные товары, кейсы и запросы сообщества |
| **Магазин** | поиск, категории, карточка товара с раскладкой «мастер получит / комиссия», корзина, оформление (+очки) |
| **Подкасты** | плеер с мини-плеером; очки начисляются, только если реально прослушано 90% (перемотка не считается); выпуск может открывать дроп |
| **Чаты** | диалоги с продавцами (товар прикрепляется к сообщению), отклик на запросы, закреплённый чат с ИИ |
| **ИИ-ассистент** | подбирает товары из каталога, считает экономику продаж, рассказывает про призы; ключ API только на сервере |
| **Призы** | лимитированные дропы с остатком и таймером, задания на день, серия дней, мои призы с кодами |

## Запуск

```bash
cp .env.example .env      # впишите GROQ_API_KEY
npm start                 # http://localhost:3000
```

Зависимостей нет, нужен Node.js 18+. Без ключа всё работает, кроме ответов ИИ.

## Структура

```
public/            ← всё, что уходит в браузер / в iOS-приложение
  index.html
  css/app.css
  js/config.js     ← комиссия, адрес API, пороги (без секретов!)
  js/data.js       ← демо-данные (потом заменяются запросами к API)
  js/bridge.js     ← мост JS ↔ Swift (haptic, share, бейдж, события)
  js/app.js        ← логика приложения
  manifest.webmanifest, sw.js, icons/
server/server.js   ← раздача статики + прокси /api/ai к Groq
```

## Как сделать iOS-приложение

### Вариант 1 — Capacitor (рекомендуется)

Нужен Mac с Xcode.

```bash
npm i @capacitor/core @capacitor/cli @capacitor/ios
npx cap init "Пространство" app.prostranstvo --web-dir public
npx cap add ios
npx cap open ios          # откроется Xcode → Run
```

- В `public/js/config.js` укажите `API_BASE: 'https://ваш-сервер'`, так как файлы внутри приложения лежат локально.
- На сервере: `ALLOWED_ORIGINS=capacitor://localhost`.
- Иконка 1024×1024 лежит в `public/icons/icon-1024.png`.
- Плагины для следующего шага: `@capacitor/push-notifications` (сообщения в чатах, старт дропа), `@capacitor/haptics`, `@capacitor/share`.

### Вариант 2 — своя оболочка на Swift (WKWebView)

`bridge.js` уже шлёт сообщения в `window.webkit.messageHandlers.native`:

```swift
let config = WKWebViewConfiguration()
config.userContentController.add(self, name: "native")
config.allowsInlineMediaPlayback = true
config.mediaTypesRequiringUserActionForPlayback = []

func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let body = m.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "haptic": UIImpactFeedbackGenerator(style: .light).impactOccurred()
    case "badge":  // UNUserNotificationCenter.current().setBadgeCount(...)
        break
    default: break
    }
}
// Из Swift можно открыть экран: webView.evaluateJavaScript("App.switchTab('chats')")
```

Для фонового воспроизведения подкастов включите Background Modes → Audio.

### Что важно для App Store

- **Физические товары оплачиваются любой платёжкой** (ЮKassa, CloudPayments, Apple Pay), а не через In-App Purchase. Комиссия Apple на них не распространяется.
- **Чаты и запросы — это пользовательский контент.** Apple требует кнопки «пожаловаться» и «заблокировать», модерацию и принятие правил (Guideline 1.2).
- **Нужен вход** (Sign in with Apple, если есть вход через соцсети) и **удаление аккаунта из приложения** (5.1.1).
- **Розыгрыши призов:** сейчас призы обмениваются на очки, это не лотерея. Если добавите случайный выигрыш, нужны официальные правила и пометка, что Apple не спонсор (5.3).
- **Голый сайт в обёртке отклоняют** (4.2). Нативные пуши, haptics, фоновое аудио и share помогают пройти ревью.

## Что дальше (до продакшена)

1. **Бэкенд и база:** пользователи, товары, заказы, чаты (WebSocket), выпуски.
2. **Очки и дропы считать на сервере.** Сейчас они в `localStorage` и легко подделываются. Списание очков и резерв приза должны быть одной атомарной операцией.
3. **Кабинет продавца:** загрузка товаров, выплаты, статистика.
4. **Оплата и доставка:** платёжный шлюз, СДЭК / Boxberry / ПВЗ.
5. **Подкасты:** хостинг аудио (`audio: 'https://…mp3'` в выпуске, и плеер подхватит), Media Session API / Now Playing.
