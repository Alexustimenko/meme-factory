# Meme Radar — полностью бесплатная облачная версия

Стек:

- Cloudflare Workers + Static Assets — сайт и backend.
- Cloudflare Workers AI — генерация текста и нового фона.
- Cloudflare KV — тренды, TikTok OAuth token и временные PNG.
- GitHub Actions + Playwright — облачный сканер публичных TikTok photo-постов.
- TikTok Content Posting API — отправка фото в TikTok через MEDIA_UPLOAD.

На ноутбуке ничего тяжёлого постоянно не работает: после первоначальной настройки ты используешь только браузер.

Главная инструкция: **SETUP_RU.md**.

## Важно

Сканер работает с публичным TikTok web и не обходит CAPTCHA, антибот-защиту или логин-челленджи. Если TikTok временно блокирует GitHub runner, предыдущий непустой кэш трендов сохраняется.

TikTok Content Posting API требует собственного Developer App, OAuth scope `video.upload` и подтверждённый URL prefix для `/media/`. В зависимости от статуса приложения TikTok может ограничивать публикацию/загрузку до завершения app review. До этого готовый PNG всегда можно скачать вручную.
