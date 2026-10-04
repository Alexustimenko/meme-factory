const state = {
  trends: [],
  selectedTrend: null,
  variants: [],
  selectedVariant: null,
  background: null,
  mediaUrl: null,
  publishId: null,
  tiktokConnected: false,
};

const $ = (id) => document.getElementById(id);
const canvas = $('memeCanvas');
const ctx = canvas.getContext('2d');

$('refreshBtn').addEventListener('click', loadTrends);
$('generateBtn').addEventListener('click', generateIdeas);
$('imageBtn').addEventListener('click', generateImage);
$('downloadBtn').addEventListener('click', downloadCanvas);
$('memeText').addEventListener('input', renderCanvas);
$('confirmUpload').addEventListener('change', updatePublishButton);
$('publishBtn').addEventListener('click', publishToTikTok);
$('statusBtn').addEventListener('click', checkPublishStatus);

boot();

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) alert(params.get('error'));
  await Promise.all([loadTrends(), loadTikTokStatus()]);
  if (params.has('tiktok') || params.has('error')) history.replaceState({}, '', '/');
}

async function loadTrends() {
  $('scanMeta').textContent = 'Загружаю свежий кэш…';
  try {
    const result = await api('/api/trends');
    state.trends = result.data?.trends || [];
    const date = result.data?.scannedAt ? new Date(result.data.scannedAt).toLocaleString('ru-RU') : 'ещё не запускался';
    const scanner = result.scanner;
    $('scanMeta').textContent = `Последний удачный набор: ${date}. Найдено: ${state.trends.length}.${scanner ? ` Последний скан: ${scanner.accepted} принято из ${scanner.candidates} кандидатов.` : ''}`;
    renderTrends();
  } catch (error) {
    $('scanMeta').textContent = error.message;
  }
}

async function loadTikTokStatus() {
  try {
    const result = await api('/api/tiktok/status');
    state.tiktokConnected = Boolean(result.connected);
    const node = $('tiktokStatus');
    if (!result.configured) {
      node.textContent = '● TikTok API: не настроен';
      node.className = 'status';
      $('tiktokConnect').textContent = 'Настроить / подключить';
    } else if (result.connected) {
      node.textContent = '● TikTok: подключён';
      node.className = 'status ok';
      $('tiktokConnect').textContent = 'Переподключить TikTok';
    } else {
      node.textContent = '● TikTok: не подключён';
      node.className = 'status';
      $('tiktokConnect').textContent = 'Подключить TikTok';
    }
    updatePublishButton();
  } catch {
    $('tiktokStatus').textContent = '● TikTok: ошибка статуса';
  }
}

function renderTrends() {
  const grid = $('trendsGrid');
  const empty = $('emptyState');
  grid.innerHTML = '';

  if (!state.trends.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = `<h2>Пока нет данных</h2><p>После настройки GitHub Actions запусти workflow <b>Scan TikTok trends</b> вручную. Если TikTok выдаст CAPTCHA облачному runner, старый непустой кэш сохранится, а в Actions будет видна причина.</p>`;
    return;
  }
  empty.classList.add('hidden');

  for (const trend of state.trends) {
    const card = document.createElement('article');
    card.className = `trend-card card ${state.selectedTrend?.id === trend.id ? 'selected' : ''}`;
    card.innerHTML = `
      ${trend.imageUrl ? `<img class="trend-image" src="${escapeAttr(trend.imageUrl)}" referrerpolicy="no-referrer" loading="lazy" alt="TikTok meme preview">` : `<div class="trend-image"></div>`}
      <div class="trend-body">
        <div class="trend-caption">${escapeHtml(trend.caption || '(пост без подписи)')}</div>
        <div class="metrics">
          <span class="metric viral">🔥 ${trend.viralScore}/100</span>
          <span class="metric">👁 ${compact(trend.views)}</span>
          <span class="metric">⚡ ${compact(trend.viewsPerHour)}/ч</span>
          <span class="metric">❤️ ${compact(trend.likes)}</span>
          <span class="metric">↗ ${compact(trend.shares)}</span>
          <span class="metric">🕒 ${Number(trend.ageHours).toFixed(1)}ч</span>
        </div>
        <div class="tags">${(trend.hashtags || []).map((x) => `#${escapeHtml(x.replace(/^#/, ''))}`).join(' ')}</div>
      </div>`;
    card.addEventListener('click', () => selectTrend(trend));
    grid.appendChild(card);
  }
}

function selectTrend(trend) {
  state.selectedTrend = trend;
  state.variants = [];
  state.selectedVariant = null;
  state.background = null;
  state.mediaUrl = null;
  state.publishId = null;
  $('studioEmpty').classList.add('hidden');
  $('studioContent').classList.remove('hidden');
  $('editor').classList.add('hidden');
  $('variants').innerHTML = '';
  $('sourceCaption').textContent = trend.caption || '(без подписи)';
  $('sourceLink').href = trend.url;
  $('sourceMetrics').innerHTML = `
    <span class="metric viral">🔥 ${trend.viralScore}/100</span>
    <span class="metric">👁 ${compact(trend.views)}</span>
    <span class="metric">⚡ ${compact(trend.viewsPerHour)}/ч</span>
    <span class="metric">ER ${(Number(trend.engagementRate) * 100).toFixed(1)}%</span>`;
  $('aiMessage').textContent = '';
  renderTrends();
}

async function generateIdeas() {
  if (!state.selectedTrend) return;
  setBusy($('generateBtn'), true, 'Генерирую…');
  $('aiMessage').textContent = 'Workers AI придумывает новые шутки, не копируя исходник.';
  try {
    const result = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ trend: state.selectedTrend, count: 3 }),
    });
    state.variants = result.variants || [];
    renderVariants(result.hashtags || []);
    $('aiMessage').textContent = `Готово · ${result.model}`;
  } catch (error) {
    $('aiMessage').textContent = `Ошибка: ${error.message}`;
  } finally {
    setBusy($('generateBtn'), false, '✨ Сгенерировать 3 идеи');
  }
}

function renderVariants(hashtags) {
  const root = $('variants');
  root.innerHTML = '';
  for (const variant of state.variants) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'variant';
    node.innerHTML = `${escapeHtml(variant.text).replaceAll('\n', '<br>')}<small>${escapeHtml(variant.caption)}</small>`;
    node.addEventListener('click', () => {
      state.selectedVariant = variant;
      [...root.children].forEach((x) => x.classList.remove('selected'));
      node.classList.add('selected');
      $('editor').classList.remove('hidden');
      $('memeText').value = variant.text;
      $('captionInput').value = variant.caption;
      $('hashtagsInput').value = hashtags.join(' ');
      state.background = null;
      state.mediaUrl = null;
      $('canvasPlaceholder').classList.remove('hidden');
      $('downloadBtn').disabled = true;
      $('publishMessage').textContent = '';
      updatePublishButton();
    });
    root.appendChild(node);
  }
}

async function generateImage() {
  if (!state.selectedVariant) return;
  setBusy($('imageBtn'), true, 'Создаю…');
  try {
    const result = await api('/api/image', {
      method: 'POST',
      body: JSON.stringify({ prompt: state.selectedVariant.imagePrompt }),
    });
    state.background = await loadImage(result.dataUri);
    state.mediaUrl = null;
    renderCanvas();
    $('canvasPlaceholder').classList.add('hidden');
    $('downloadBtn').disabled = false;
    $('publishMessage').textContent = `Фон создан · ${result.model}. Текст поверх картинки рисуется прямо в браузере.`;
    updatePublishButton();
  } catch (error) {
    $('publishMessage').textContent = `Ошибка генерации картинки: ${error.message}`;
  } finally {
    setBusy($('imageBtn'), false, '🖼 Создать картинку');
  }
}

function renderCanvas() {
  if (!state.background) return;
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);

  const img = state.background;
  const scale = Math.max(W / img.width, H / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);

  const grad = ctx.createLinearGradient(0, 0, 0, H * .55);
  grad.addColorStop(0, 'rgba(0,0,0,.72)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H * .6);

  const text = $('memeText').value.trim();
  const fontSize = autoFontSize(text);
  ctx.font = `900 ${fontSize}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(8, fontSize * .12);
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';

  const lines = wrapMultiline(text, W - 110, fontSize);
  let y = 58;
  const lineH = fontSize * 1.06;
  for (const line of lines.slice(0, 9)) {
    ctx.strokeText(line, W / 2, y);
    ctx.fillText(line, W / 2, y);
    y += lineH;
  }
}

function autoFontSize(text) {
  const length = Array.from(text || '').length;
  if (length < 70) return 76;
  if (length < 120) return 64;
  if (length < 180) return 54;
  return 46;
}

function wrapMultiline(text, maxWidth, fontSize) {
  ctx.font = `900 ${fontSize}px Arial, Helvetica, sans-serif`;
  const lines = [];
  for (const paragraph of text.split(/\n+/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    if (line) lines.push(line);
  }
  return lines;
}

async function publishToTikTok() {
  if (!state.background || !$('confirmUpload').checked) return;
  setBusy($('publishBtn'), true, 'Отправляю…');
  $('publishMessage').textContent = 'Сохраняю PNG в бесплатный Cloudflare KV…';
  try {
    if (!state.mediaUrl) {
      const blob = await canvasBlob();
      const media = await api('/api/media', { method: 'POST', headers: { 'content-type': 'image/png' }, body: blob });
      state.mediaUrl = media.mediaUrl;
    }

    const description = [
      $('captionInput').value.trim(),
      $('hashtagsInput').value.trim(),
    ].filter(Boolean).join('\n\n');

    const result = await api('/api/tiktok/upload-photo', {
      method: 'POST',
      body: JSON.stringify({
        confirmed: true,
        mediaUrl: state.mediaUrl,
        title: $('captionInput').value.trim().slice(0, 90) || 'Meme',
        description,
      }),
    });
    state.publishId = result.publishId;
    $('publishMessage').textContent = result.message;
    $('statusBtn').classList.remove('hidden');
  } catch (error) {
    $('publishMessage').textContent = `Не отправлено: ${error.message}. PNG всё равно можно скачать кнопкой выше.`;
  } finally {
    setBusy($('publishBtn'), false, '🚀 Отправить в TikTok');
    updatePublishButton();
  }
}

async function checkPublishStatus() {
  if (!state.publishId) return;
  setBusy($('statusBtn'), true, 'Проверяю…');
  try {
    const result = await api('/api/tiktok/publish-status', {
      method: 'POST',
      body: JSON.stringify({ publishId: state.publishId }),
    });
    $('publishMessage').textContent = `TikTok status: ${result.status}${result.fail_reason ? ` · ${result.fail_reason}` : ''}`;
  } catch (error) {
    $('publishMessage').textContent = `Статус: ${error.message}`;
  } finally {
    setBusy($('statusBtn'), false, 'Проверить статус отправки');
  }
}

function updatePublishButton() {
  $('publishBtn').disabled = !(state.background && state.tiktokConnected && $('confirmUpload').checked);
}

function downloadCanvas() {
  const a = document.createElement('a');
  a.download = `meme-${Date.now()}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

function canvasBlob() {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не удалось создать PNG')), 'image/png', .94));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось открыть AI-картинку'));
    img.src = src;
  });
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === 'string' && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  let data;
  try { data = await response.json(); } catch { data = { error: await response.text() }; }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  button.textContent = text;
}
function compact(value) {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
function escapeAttr(value) { return escapeHtml(value); }
