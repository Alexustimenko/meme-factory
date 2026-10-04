# Пошаговая настройка Meme Radar за 0 $

Ниже — путь от пустого аккаунта до работающего сайта. Платные API не нужны.

## Что понадобится

1. Бесплатный аккаунт GitHub.
2. Бесплатный аккаунт Cloudflare.
3. Аккаунт TikTok.
4. Node.js 20+ **только для первоначального деплоя с компьютера**. После настройки сайт работает в облаке.

---

# Часть 1. Залить проект в GitHub

1. Создай на GitHub новый **Public** repository, например `meme-radar`.
2. Открой терминал в папке проекта.
3. Выполни:

```bash
npm install

git init
git add .
git commit -m "Initial Meme Radar cloud version"
git branch -M main
git remote add origin https://github.com/ТВОЙ_ЛОГИН/meme-radar.git
git push -u origin main
```

Public нужен потому, что стандартные GitHub-hosted runners для public repository работают бесплатно. **Никогда не записывай Client Secret, TikTok token или INGEST_KEY прямо в файлы репозитория** — для них используются GitHub Secrets и Cloudflare Secrets.

---

# Часть 2. Cloudflare Worker + KV + Workers AI

## 2.1 Войти в Cloudflare через Wrangler

```bash
npx wrangler login
```

Откроется браузер. Разреши доступ.

## 2.2 Создать бесплатный KV namespace

```bash
npx wrangler kv namespace create APP_KV
```

В ответе будет ID примерно такой:

```text
id = "1234567890abcdef1234567890abcdef"
```

Открой `wrangler.jsonc` и замени:

```json
"id": "PUT_YOUR_KV_NAMESPACE_ID_HERE"
```

на полученный ID.

## 2.3 Первый деплой

```bash
npm run deploy
```

Wrangler выдаст адрес примерно:

```text
https://tiktok-meme-radar-free.ТВОЙ-SUBDOMAIN.workers.dev
```

Сохрани этот адрес. Назовём его `WORKER_URL`.

Открой `WORKER_URL` в браузере. Сайт уже должен открываться.

## 2.4 Создать секрет для GitHub-сканера

Придумай длинную случайную строку, например 40+ символов.

```bash
npx wrangler secret put INGEST_SECRET
```

Wrangler попросит значение — вставь строку. Сохрани её: она понадобится в GitHub Secrets. Секрет хранится в Cloudflare и не попадает в public GitHub repository.

---

# Часть 3. Подключить GitHub Actions — реальные тренды

Открой репозиторий GitHub:

`Settings -> Secrets and variables -> Actions -> Secrets -> New repository secret`

Создай два secrets.

### INGEST_URL

Значение:

```text
https://ТВОЙ-WORKER.workers.dev/api/admin/ingest
```

### INGEST_KEY

Значение — та же строка, которую ты ввёл в `wrangler secret put INGEST_SECRET`.

Дополнительно можно открыть:

`Settings -> Secrets and variables -> Actions -> Variables`

и создать `SCAN_QUERIES`, например:

```text
мем,жиза,работа мем,отношения мем,универ мем,meme,relatable meme
```

Если переменную не создавать — используются запросы из `data/seed-queries.json`.

Теперь:

1. GitHub -> `Actions`.
2. Выбери `Scan TikTok trends`.
3. Нажми `Run workflow`.
4. Подожди завершения workflow.
5. Открой Meme Radar и нажми `Обновить список`.

Workflow также запускается автоматически каждые 6 часов.

Если TikTok покажет CAPTCHA облачному runner, скрипт не обходит её. В таком случае в Actions будет сообщение, а старый непустой список трендов не удалится.

---

# Часть 4. Workers AI

Дополнительный ключ не нужен. В `wrangler.jsonc` уже есть AI binding:

```json
"ai": { "binding": "AI" }
```

По умолчанию используются:

```text
Текст: @cf/meta/llama-3.2-3b-instruct
Картинка: @cf/black-forest-labs/flux-1-schnell
```

После деплоя кнопки `Сгенерировать 3 идеи` и `Создать картинку` обращаются прямо к Workers AI.

Текст на картинку накладывается Canvas-ом в браузере, поэтому AI не должен рисовать буквы.

---

# Часть 5. TikTok Developer App

Эта часть нужна только для кнопки `Отправить в TikTok`. Поиск, генерация и скачивание PNG работают и без неё.

## 5.1 Создать приложение

1. Открой TikTok for Developers.
2. Создай Developer App.
3. Добавь Web platform.
4. Добавь продукты **Login Kit** и **Content Posting API**.
5. Добавь scope:

```text
user.info.basic
video.upload
```

## 5.2 Redirect URI

В Login Kit добавь точно:

```text
https://ТВОЙ-WORKER.workers.dev/auth/tiktok/callback
```

Redirect URI должен совпадать символ-в-символ.

## 5.3 Website / Terms / Privacy

Можно использовать страницы проекта:

```text
Website:
https://ТВОЙ-WORKER.workers.dev/

Privacy:
https://ТВОЙ-WORKER.workers.dev/privacy.html

Terms:
https://ТВОЙ-WORKER.workers.dev/terms.html
```

Перед production review отредактируй тексты Privacy/Terms под себя при необходимости.

## 5.4 Client Key и Client Secret

В Cloudflare terminal добавь их как secrets:

```bash
npx wrangler secret put TIKTOK_CLIENT_KEY
npx wrangler secret put TIKTOK_CLIENT_SECRET
```

После этого снова:

```bash
npm run deploy
```

Открой Meme Radar и нажми `Подключить TikTok`.

---

# Часть 6. Подтвердить URL для TikTok Photo Upload

TikTok photo upload использует `PULL_FROM_URL`, поэтому нужно подтвердить, что приложение контролирует:

```text
https://ТВОЙ-WORKER.workers.dev/media/
```

В TikTok Developer App:

1. Открой `URL properties` / `Verify properties`.
2. Выбери **URL prefix**.
3. Введи:

```text
https://ТВОЙ-WORKER.workers.dev/media/
```

4. TikTok даст signature file: у него будет имя файла и содержимое.
5. Открой `wrangler.jsonc`.
6. В `vars` заполни:

```json
"TIKTOK_VERIFY_FILENAME": "ИМЯ_ФАЙЛА_ОТ_TIKTOK",
"TIKTOK_VERIFY_CONTENT": "СОДЕРЖИМОЕ_ФАЙЛА_ОТ_TIKTOK"
```

7. Выполни:

```bash
npm run deploy
```

8. Проверь в браузере:

```text
https://ТВОЙ-WORKER.workers.dev/media/ИМЯ_ФАЙЛА_ОТ_TIKTOK
```

Должно открыться ровно содержимое signature file без редиректа.

9. Вернись в TikTok Developer Portal и нажми Verify.

После успешной проверки любой временный PNG вида

```text
https://ТВОЙ-WORKER.workers.dev/media/UUID.png
```

подходит для `PULL_FROM_URL`.

---

# Часть 7. Как пользоваться

1. Открываешь `WORKER_URL`.
2. Слева видишь реальные найденные однофоточные TikTok posts за последние 24 часа.
3. У каждого есть Viral Score, views, views/hour, likes, shares и возраст.
4. Кликаешь по тренду.
5. Нажимаешь `Сгенерировать 3 идеи`.
6. Выбираешь вариант.
7. Нажимаешь `Создать картинку`.
8. При желании меняешь текст, подпись и хэштеги.
9. Можешь нажать `Скачать PNG`.
10. Для отправки через API ставишь галочку подтверждения и нажимаешь `Отправить в TikTok`.
11. При `MEDIA_UPLOAD` TikTok отправляет уведомление во входящие; открываешь его в TikTok и заканчиваешь редактирование/публикацию.

---

# Часть 8. Что реально бесплатно

При небольшом личном использовании проект укладывается в бесплатные лимиты Cloudflare Workers, Workers AI и KV, а GitHub Actions для public repository использует бесплатные standard runners.

Не включай платные Cloudflare планы и не добавляй платные внешние AI API.

Если бесплатный дневной лимит Workers AI закончится, генерация просто начнёт возвращать ошибку до следующего сброса лимита — неожиданный платный счёт из этого проекта не создаётся.

---

# Ограничения, которые важно знать

1. TikTok не предоставляет бесплатный официальный API «все вирусные мемы планеты за 24 часа». Сканер ищет кандидатов через публичные web-страницы по набору мемных запросов.
2. TikTok может менять HTML или показывать CAPTCHA GitHub runner. Проект не обходит защиту; при необходимости обновляется `scripts/scan-tiktok.mjs`.
3. Для официальной отправки фото TikTok требует URL verification и соответствующий OAuth scope.
4. TikTok может ограничивать Content Posting API для неаудированных приложений. Если API не разрешает отправку твоему аккаунту до review, генератор всё равно полностью работает, а готовый PNG и подпись можно загрузить в TikTok вручную.
5. Сгенерированный фон отмечается как AI-generated при API-отправке (`is_aigc: true`).

---

# Полезные команды

Проверить синтаксис:

```bash
npm run check
```

Локально посмотреть UI/API во время разработки:

```bash
npm run dev
```

Обновить облако:

```bash
npm run deploy
```

Запустить сканер локально не требуется. Он работает через GitHub Actions.
