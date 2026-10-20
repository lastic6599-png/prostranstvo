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
| **ИИ-ассистент** | YandexGPT или GigaChat: подбирает товары из каталога, считает экономику продаж, рассказывает про призы; ключ API только на сервере |
| **Призы** | лимитированные дропы с остатком и таймером, задания на день, серия дней, мои призы с кодами |

## Запуск у себя

```bash
cp .env.example .env      # заполните ключи ИИ (см. ниже)
npm start                 # http://localhost:3000
```

Зависимостей нет, нужен Node.js 18+. Без ключей всё работает, кроме ответов ИИ.
Проверка: http://localhost:3000/api/health покажет, какой ИИ подключён.

## ИИ-ассистент (работает в РФ)

Сервер поддерживает **YandexGPT** и **GigaChat**. Оба доступны из России и оплачиваются российской картой.
Ключи лежат только на сервере, браузер их не видит.

### YandexGPT (рекомендуется)

1. Зайдите на [console.yandex.cloud](https://console.yandex.cloud) и создайте платёжный аккаунт (новым пользователям дают грант).
2. Откройте каталог (по умолчанию `default`). Его ID видно на странице каталога, это `YANDEX_FOLDER_ID`.
3. **Сервисные аккаунты** → «Создать» → роль `ai.languageModels.user`.
4. В сервисном аккаунте: «Создать новый ключ» → «API-ключ». Скопируйте секрет в `YANDEX_API_KEY`.
5. Модель: `yandexgpt-lite/latest` дешевле и быстрее, `yandexgpt/latest` умнее.

### GigaChat (Сбер)

1. Зайдите на [developers.sber.ru](https://developers.sber.ru/studio) → GigaChat API → создайте проект.
2. Скопируйте **«Ключ авторизации»** в `GIGACHAT_AUTH_KEY`. Для физлиц есть бесплатный лимит (`GIGACHAT_SCOPE=GIGACHAT_API_PERS`).
3. Серверы GigaChat используют сертификат Минцифры. В Docker он ставится автоматически. При запуске без Docker
   скачайте [корневой сертификат](https://www.gosuslugi.ru/crt) и запустите сервер с `NODE_EXTRA_CA_CERTS=/путь/к/russian_trusted_root_ca.pem`.

## Выложить сайт в интернет (хостинг в РФ)

Проект собирается из `Dockerfile`, поэтому подойдёт любой хостинг с Docker.

**Проще всего: Timeweb Cloud → Apps** (или аналог у Selectel / Yandex Cloud Serverless Containers):
1. «Создать приложение» → Docker → подключите GitHub-репозиторий и ветку.
2. В переменных окружения укажите `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`, `TRUST_PROXY=1`.
3. Порт `3000`. После сборки вы получите адрес с HTTPS, потом можно привязать свой домен.

**На своём VPS** (Ubuntu с установленным Docker):
```bash
git clone https://github.com/lastic6599-png/prostranstvo.git && cd prostranstvo
cp .env.example .env && nano .env
docker build -t prostranstvo . && docker run -d --restart=always --env-file .env -p 3000:3000 prostranstvo
```
Для HTTPS и домена поставьте перед сервером nginx или Caddy.

Если на сайте появятся регистрация и заказы, персональные данные россиян по 152-ФЗ нужно хранить на серверах в РФ.
Хостинг в России решает это сразу.

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
