const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const MEDIA_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_KEY = 'tiktok:token';
const TRENDS_KEY = 'trends:latest';
const SCANNER_KEY = 'scanner:last';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === '/api/health') {
        return json({ ok: true, now: new Date().toISOString(), freeStack: true });
      }

      if (url.pathname === '/api/trends' && request.method === 'GET') {
        return getTrends(env);
      }

      if (url.pathname === '/api/admin/ingest' && request.method === 'POST') {
        return ingestTrends(request, env);
      }

      if (url.pathname === '/api/generate' && request.method === 'POST') {
        return generateVariants(request, env);
      }

      if (url.pathname === '/api/image' && request.method === 'POST') {
        return generateBackground(request, env);
      }

      if (url.pathname === '/api/media' && request.method === 'POST') {
        return saveMedia(request, env, url.origin);
      }

      if (url.pathname.startsWith('/media/') && request.method === 'GET') {
        return serveMedia(url.pathname, env);
      }

      if (url.pathname === '/auth/tiktok/start' && request.method === 'GET') {
        return startTikTokAuth(request, env);
      }

      if (url.pathname === '/auth/tiktok/callback' && request.method === 'GET') {
        return finishTikTokAuth(request, env);
      }

      if (url.pathname === '/api/tiktok/status' && request.method === 'GET') {
        return tiktokStatus(env);
      }

      if (url.pathname === '/api/tiktok/logout' && request.method === 'POST') {
        await env.APP_KV.delete(TOKEN_KEY);
        return json({ ok: true });
      }

      if (url.pathname === '/api/tiktok/upload-photo' && request.method === 'POST') {
        return uploadPhotoToTikTok(request, env);
      }

      if (url.pathname === '/api/tiktok/publish-status' && request.method === 'POST') {
        return fetchTikTokPublishStatus(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: error?.message || 'Unknown error' }, 500);
    }
  },
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, 'cache-control': 'no-store', ...extraHeaders },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error('Некорректный JSON');
  }
}

async function getTrends(env) {
  const [cached, scanner] = await Promise.all([
    env.APP_KV.get(TRENDS_KEY, 'json'),
    env.APP_KV.get(SCANNER_KEY, 'json'),
  ]);

  return json({
    ok: true,
    data: cached || { scannedAt: null, hours: 24, trends: [] },
    scanner: scanner || null,
  });
}

async function ingestTrends(request, env) {
  const auth = request.headers.get('authorization') || '';
  const expected = env.INGEST_SECRET || '';
  if (!expected || auth !== `Bearer ${expected}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const payload = await readJson(request);
  const trends = Array.isArray(payload.trends) ? payload.trends.slice(0, 100) : [];
  const scannerState = {
    at: new Date().toISOString(),
    scannedAt: payload.scannedAt || new Date().toISOString(),
    candidates: Number(payload.candidates || 0),
    accepted: trends.length,
    queries: Array.isArray(payload.queries) ? payload.queries.slice(0, 50) : [],
    note: String(payload.note || ''),
  };

  await env.APP_KV.put(SCANNER_KEY, JSON.stringify(scannerState));

  if (trends.length) {
    const cache = {
      scannedAt: payload.scannedAt || new Date().toISOString(),
      hours: Number(payload.hours || 24),
      source: 'TikTok public web scan',
      trends,
    };
    await env.APP_KV.put(TRENDS_KEY, JSON.stringify(cache));
  }

  return json({ ok: true, stored: trends.length, preservedPreviousIfEmpty: trends.length === 0 });
}

async function generateVariants(request, env) {
  const body = await readJson(request);
  const trend = body.trend || {};
  const count = clamp(Number(body.count || 3), 1, 5);
  const hashtags = normalizeHashtags(trend.hashtags || []);
  const sourceText = String(trend.caption || '').slice(0, 1000);

  const system = [
    'Ты придумываешь короткие русскоязычные мемы для TikTok в формате одной картинки.',
    'Создавай НОВЫЕ шутки на близкую жизненную ситуацию, не копируй формулировку исходника.',
    'Текст должен читаться за 1-2 секунды, быть понятным без контекста и помещаться на одной картинке.',
    'Не используй хэштеги внутри текста мема.',
    'Верни только валидный JSON без markdown.',
  ].join(' ');

  const prompt = `Исходный залетевший пост:\n${sourceText || '(без подписи)'}\n\nТема/поисковый запрос: ${String(trend.query || 'мем')}\nСтатистика: views=${Number(trend.views || 0)}, likes=${Number(trend.likes || 0)}, shares=${Number(trend.shares || 0)}, ageHours=${Number(trend.ageHours || 0).toFixed(1)}.\nХэштеги исходника: ${hashtags.join(' ') || '(нет)'}\n\nСоздай ${count} оригинальных вариантов. Формат JSON строго такой: {"variants":[{"text":"текст мема","caption":"короткая подпись без хэштегов","imagePrompt":"English prompt for a funny reaction image, no text, no letters, no logos, vertical-friendly composition, leave visual breathing room at the top"}]}.`;

  const model = env.TEXT_MODEL || '@cf/meta/llama-3.2-3b-instruct';
  const ai = await env.AI.run(model, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature: 0.9,
    max_tokens: 900,
  });

  const raw = String(ai?.response || ai?.result?.response || '');
  const parsed = parseJsonObject(raw);
  let variants = Array.isArray(parsed?.variants) ? parsed.variants : [];

  variants = variants
    .slice(0, count)
    .map((item, index) => ({
      id: `v${index + 1}`,
      text: String(item.text || '').trim().slice(0, 420),
      caption: String(item.caption || '').trim().slice(0, 500),
      imagePrompt: String(item.imagePrompt || '').trim().slice(0, 1800),
    }))
    .filter((v) => v.text && v.imagePrompt);

  if (!variants.length) {
    variants = fallbackVariants(trend, count);
  }

  return json({ ok: true, variants, hashtags, model });
}

async function generateBackground(request, env) {
  const body = await readJson(request);
  let prompt = String(body.prompt || '').trim();
  if (!prompt) return json({ error: 'prompt обязателен' }, 400);

  prompt = `${prompt}. Meme reaction image. No text, no captions, no letters, no watermark, no logo. Strong facial/emotional reaction. Clean composition. The final meme will have large text overlaid by the web app, so keep the upper area visually simple.`.slice(0, 2048);

  const model = env.IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
  const result = await env.AI.run(model, {
    prompt,
    steps: 4,
    seed: Math.floor(Math.random() * 1_000_000_000) + 1,
  });

  const image = result?.image;
  if (!image) return json({ error: 'Workers AI не вернул изображение' }, 502);

  return json({ ok: true, dataUri: `data:image/jpeg;base64,${image}`, model });
}

async function saveMedia(request, env, origin) {
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
    return json({ error: 'Поддерживаются PNG, JPEG и WEBP' }, 415);
  }

  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) {
    return json({ error: 'Размер картинки должен быть от 1 байта до 8 МБ' }, 400);
  }

  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const id = crypto.randomUUID();
  const file = `${id}.${extension}`;

  await env.APP_KV.put(`media:${file}`, bytes, {
    expirationTtl: MEDIA_TTL_SECONDS,
    metadata: { contentType, createdAt: new Date().toISOString() },
  });

  return json({
    ok: true,
    file,
    mediaUrl: `${origin}/media/${file}`,
    expiresInDays: 7,
  });
}

async function serveMedia(pathname, env) {
  const file = decodeURIComponent(pathname.slice('/media/'.length));

  if (env.TIKTOK_VERIFY_FILENAME && file === env.TIKTOK_VERIFY_FILENAME) {
    return new Response(env.TIKTOK_VERIFY_CONTENT || '', {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (!/^[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(file)) {
    return new Response('Not found', { status: 404 });
  }

  const found = await env.APP_KV.getWithMetadata(`media:${file}`, { type: 'arrayBuffer' });
  if (!found?.value) return new Response('Not found', { status: 404 });

  return new Response(found.value, {
    headers: {
      'content-type': found.metadata?.contentType || 'image/png',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function startTikTokAuth(request, env) {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    return json({ error: 'Сначала добавь TIKTOK_CLIENT_KEY и TIKTOK_CLIENT_SECRET в Cloudflare secrets' }, 400);
  }

  const requestUrl = new URL(request.url);
  const redirectUri = `${requestUrl.origin}/auth/tiktok/callback`;
  const state = randomToken(24);
  const scopes = env.TIKTOK_SCOPES || 'user.info.basic,video.upload';
  const authUrl = new URL('https://www.tiktok.com/v2/auth/authorize/');
  authUrl.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY);
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      location: authUrl.toString(),
      'set-cookie': `tt_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

async function finishTikTokAuth(request, env) {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) return redirectHome(url.origin, `TikTok OAuth: ${error}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = getCookie(request.headers.get('cookie') || '', 'tt_oauth_state');
  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectHome(url.origin, 'Ошибка OAuth state. Попробуй подключить TikTok ещё раз.');
  }

  const redirectUri = `${url.origin}/auth/tiktok/callback`;
  const form = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const token = await response.json();
  if (!response.ok || token.error) {
    return redirectHome(url.origin, token.error_description || token.error || 'Не удалось получить TikTok token');
  }

  await storeTikTokToken(env, token);
  return new Response(null, {
    status: 302,
    headers: {
      location: '/?tiktok=connected',
      'set-cookie': 'tt_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}

function redirectHome(origin, message) {
  const target = new URL('/', origin);
  target.searchParams.set('error', message);
  return Response.redirect(target.toString(), 302);
}

async function tiktokStatus(env) {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    return json({ configured: false, connected: false, reason: 'TikTok secrets не настроены' });
  }

  try {
    const token = await ensureTikTokToken(env);
    return json({
      configured: true,
      connected: Boolean(token?.access_token),
      scope: token?.scope || '',
      openId: token?.open_id || '',
      expiresAt: token?.expires_at || null,
    });
  } catch (error) {
    return json({ configured: true, connected: false, reason: error.message });
  }
}

async function uploadPhotoToTikTok(request, env) {
  const body = await readJson(request);
  if (body.confirmed !== true) {
    return json({ error: 'Перед отправкой требуется явное подтверждение пользователя' }, 400);
  }

  const requestUrl = new URL(request.url);
  const mediaUrl = String(body.mediaUrl || '');
  if (!mediaUrl.startsWith(`${requestUrl.origin}/media/`)) {
    return json({ error: 'mediaUrl должен указывать на /media/ этого приложения' }, 400);
  }

  const token = await ensureTikTokToken(env);
  const title = cutCodePoints(String(body.title || 'Meme'), 90);
  const description = cutCodePoints(String(body.description || ''), 4000);

  const payload = {
    post_info: { title, description },
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: [mediaUrl],
    },
    post_mode: 'MEDIA_UPLOAD',
    media_type: 'PHOTO',
    is_aigc: true,
  };

  const response = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.access_token}`,
      'content-type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();

  if (!response.ok || data?.error?.code !== 'ok') {
    return json({
      error: data?.error?.message || data?.error?.code || `TikTok HTTP ${response.status}`,
      code: data?.error?.code || null,
      raw: data,
    }, response.ok ? 400 : response.status);
  }

  return json({
    ok: true,
    publishId: data.data?.publish_id,
    message: 'Фото отправлено в TikTok. Открой уведомление во входящих TikTok и заверши публикацию.',
  });
}

async function fetchTikTokPublishStatus(request, env) {
  const body = await readJson(request);
  const publishId = String(body.publishId || '').trim();
  if (!publishId) return json({ error: 'publishId обязателен' }, 400);

  const token = await ensureTikTokToken(env);
  const response = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.access_token}`,
      'content-type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const data = await response.json();
  if (!response.ok || data?.error?.code !== 'ok') {
    return json({ error: data?.error?.message || data?.error?.code || 'Ошибка статуса', raw: data }, response.ok ? 400 : response.status);
  }
  return json({ ok: true, ...data.data });
}

async function ensureTikTokToken(env) {
  const current = await env.APP_KV.get(TOKEN_KEY, 'json');
  if (!current?.refresh_token) throw new Error('TikTok не подключён');

  if (current.access_token && Number(current.expires_at || 0) > Date.now() + 5 * 60 * 1000) {
    return current;
  }

  const form = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
  });
  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const token = await response.json();
  if (!response.ok || token.error) throw new Error(token.error_description || token.error || 'Не удалось обновить TikTok token');
  return storeTikTokToken(env, token);
}

async function storeTikTokToken(env, token) {
  const stored = {
    ...token,
    expires_at: Date.now() + Number(token.expires_in || 86400) * 1000,
    refresh_expires_at: Date.now() + Number(token.refresh_expires_in || 31536000) * 1000,
    stored_at: Date.now(),
  };
  await env.APP_KV.put(TOKEN_KEY, JSON.stringify(stored));
  return stored;
}

function normalizeHashtags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  return [...new Set(list.map((x) => String(x || '').trim().replace(/^#/, '')).filter(Boolean))]
    .slice(0, 12)
    .map((x) => `#${x}`);
}

function parseJsonObject(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch {}
  }
  return null;
}

function fallbackVariants(trend, count) {
  const topic = String(trend.query || 'жиза').trim();
  const bases = [
    `Когда думаешь: «ну это на пять минут»\nИ через три часа всё ещё ${topic}`,
    `Я: сегодня всё будет по плану\nЖизнь через 15 минут: ${topic}`,
    `Никто:\nАбсолютно никто:\nМой мозг в самый неподходящий момент: ${topic}`,
    `Когда уже всё сделал\nНо вспоминаешь ещё одну мелочь`,
    `Планы на день / То, что получилось на самом деле`,
  ];
  return bases.slice(0, count).map((text, i) => ({
    id: `f${i + 1}`,
    text,
    caption: 'Слишком жизненно',
    imagePrompt: 'A funny expressive reaction portrait, overwhelmed but relatable, cinematic candid photo, no text, no letters, no logo, clean upper background, vertical composition',
  }));
}

function randomToken(bytes = 24) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(cookieHeader, name) {
  for (const pair of cookieHeader.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function cutCodePoints(text, max) {
  return Array.from(text).slice(0, max).join('');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
