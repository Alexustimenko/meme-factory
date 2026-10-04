import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaults = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'seed-queries.json'), 'utf8'));
const hours = clamp(Number(process.env.SCAN_HOURS || 24), 1, 72);
const maxPosts = clamp(Number(process.env.MAX_POSTS || 45), 5, 100);
const maxLinksPerQuery = clamp(Number(process.env.MAX_LINKS_PER_QUERY || 15), 3, 40);
const ingestUrl = process.env.INGEST_URL || '';
const ingestKey = process.env.INGEST_KEY || '';
const extra = String(process.env.SCAN_QUERIES || '').split(',').map((x) => x.trim()).filter(Boolean);
const queries = [...new Set([...extra, ...defaults])].slice(0, 30);

if (!ingestUrl || !ingestKey) {
  throw new Error('Нужны GitHub secrets INGEST_URL и INGEST_KEY');
}

console.log(`Scanning TikTok: ${hours}h, queries=${queries.length}, maxPosts=${maxPosts}`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'ru-RU',
  timezoneId: 'Europe/Berlin',
  viewport: { width: 1440, height: 1000 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
});

await context.route('**/*', async (route) => {
  const type = route.request().resourceType();
  if (['media', 'font'].includes(type)) return route.abort();
  return route.continue();
});

const searchPage = await context.newPage();
const foundLinks = new Map();
let blockedCount = 0;

for (const query of queries) {
  if (foundLinks.size >= maxPosts * 3) break;
  console.log(`Search: ${query}`);
  const urls = [
    `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`,
    `https://www.tiktok.com/tag/${encodeURIComponent(query.replace(/^#/, '').replace(/\s+/g, ''))}`,
  ];

  for (const target of urls) {
    try {
      const response = await searchPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 35_000 });
      await searchPage.waitForTimeout(3000);
      if (!response || response.status() >= 400) {
        console.log(`  HTTP ${response?.status() || 'no response'}: ${target}`);
        continue;
      }

      const bodyText = (await searchPage.locator('body').innerText().catch(() => '')).toLowerCase();
      if (/captcha|verify to continue|unusual traffic|too many attempts/.test(bodyText)) blockedCount += 1;

      for (let i = 0; i < 5; i++) {
        await searchPage.mouse.wheel(0, 2200);
        await searchPage.waitForTimeout(900);
      }

      const links = await searchPage.locator('a[href*="/photo/"]').evaluateAll((els) =>
        els.map((a) => a.href).filter(Boolean)
      ).catch(() => []);

      for (const link of links.slice(0, maxLinksPerQuery)) {
        const clean = canonicalTikTokUrl(link);
        if (clean && !foundLinks.has(clean)) foundLinks.set(clean, query);
      }
      if (links.length) break;
    } catch (error) {
      console.log(`  search error: ${error.message}`);
    }
  }
}

console.log(`Photo links found: ${foundLinks.size}`);
const postPage = await context.newPage();
const trends = [];
let inspected = 0;

for (const [url, query] of foundLinks) {
  if (inspected >= maxPosts) break;
  inspected += 1;
  try {
    const response = await postPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    if (!response || response.status() >= 400) continue;
    await postPage.waitForTimeout(1200);

    const scripts = await postPage.locator('script').allTextContents();
    const item = findPhotoItemFromScripts(scripts);
    if (!item) continue;

    const trend = normalizeItem(item, url, query);
    if (!trend) continue;
    if (trend.ageHours < 0 || trend.ageHours > hours) continue;
    if (trend.imageCount !== 1) continue;

    trends.push(trend);
    console.log(`  + ${trend.viralScore}/100 | ${formatCompact(trend.views)} | ${trend.ageHours.toFixed(1)}h | ${url}`);
  } catch (error) {
    console.log(`  post error: ${error.message}`);
  }
}

await browser.close();
trends.sort((a, b) => b.viralScore - a.viralScore || b.viewsPerHour - a.viewsPerHour);
const top = trends.slice(0, 40);

const payload = {
  scannedAt: new Date().toISOString(),
  hours,
  candidates: foundLinks.size,
  queries,
  trends: top,
  note: top.length
    ? `Found ${top.length} one-photo posts from public TikTok pages.`
    : `No eligible posts found. TikTok may have returned no public photo links or challenged the runner. blockedSignals=${blockedCount}`,
};

const upload = await fetch(ingestUrl, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${ingestKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(payload),
});
const resultText = await upload.text();
if (!upload.ok) throw new Error(`Ingest failed ${upload.status}: ${resultText}`);
console.log(`Ingest OK: ${resultText}`);

function findPhotoItemFromScripts(scripts) {
  for (const text of scripts) {
    const t = String(text || '').trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
    if (!t.includes('imagePost') && !t.includes('playCount')) continue;
    let parsed;
    try { parsed = JSON.parse(t); } catch { continue; }
    const item = walkForItem(parsed);
    if (item) return item;
  }
  return null;
}

function walkForItem(root) {
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < 200_000) {
    const node = stack.pop();
    visited += 1;
    if (!node || typeof node !== 'object') continue;

    const stats = node.stats || node.statsV2;
    const imagePost = node.imagePost;
    if (stats && imagePost && Array.isArray(imagePost.images) && (node.id || node.itemId) && node.createTime) {
      return node;
    }

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) if (node[i] && typeof node[i] === 'object') stack.push(node[i]);
    } else {
      for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
    }
  }
  return null;
}

function normalizeItem(item, url, query) {
  const stats = item.stats || item.statsV2 || {};
  const images = item.imagePost?.images || [];
  if (images.length !== 1) return null;

  const createSeconds = Number(item.createTime || 0);
  if (!Number.isFinite(createSeconds) || createSeconds <= 0) return null;
  const createdAt = new Date(createSeconds * 1000);
  const ageHours = (Date.now() - createdAt.getTime()) / 3_600_000;

  const views = num(stats.playCount ?? stats.playCountV2);
  const likes = num(stats.diggCount);
  const comments = num(stats.commentCount);
  const shares = num(stats.shareCount);
  const viewsPerHour = views / Math.max(ageHours, 0.5);
  const engagementRate = views > 0 ? (likes + comments + shares) / views : 0;
  const shareRate = views > 0 ? shares / views : 0;
  const viralScore = scoreViral({ views, viewsPerHour, engagementRate, shareRate, ageHours });
  const caption = String(item.desc || item.title || '').trim();
  const hashtags = extractHashtags(item, caption);
  const imageUrl = firstImageUrl(images[0]);
  const author = typeof item.author === 'object'
    ? (item.author.uniqueId || item.author.nickname || '')
    : (item.author || item.authorId || '');

  return {
    id: String(item.id || item.itemId),
    url,
    query,
    author: String(author || ''),
    caption,
    hashtags,
    imageUrl,
    imageCount: images.length,
    views,
    likes,
    comments,
    shares,
    createdAt: createdAt.toISOString(),
    ageHours: round(ageHours, 2),
    viewsPerHour: Math.round(viewsPerHour),
    engagementRate: round(engagementRate, 4),
    shareRate: round(shareRate, 4),
    viralScore,
  };
}

function firstImageUrl(image) {
  const possible = [
    image?.imageURL?.urlList,
    image?.displayImage?.urlList,
    image?.thumbnail?.urlList,
    image?.imageUrl?.urlList,
    image?.urlList,
  ];
  for (const list of possible) if (Array.isArray(list) && list[0]) return list[0];
  return '';
}

function extractHashtags(item, caption) {
  const set = new Set();
  for (const match of caption.matchAll(/#([\p{L}\p{N}_]+)/gu)) set.add(match[1]);
  for (const c of item.challenges || []) {
    const title = c?.title || c?.chaName;
    if (title) set.add(String(title).replace(/^#/, ''));
  }
  return [...set].slice(0, 15);
}

function scoreViral({ views, viewsPerHour, engagementRate, shareRate, ageHours }) {
  const raw =
    12 * Math.log10(viewsPerHour + 1) +
    6 * Math.log10(views + 1) +
    Math.min(25, engagementRate * 120) +
    Math.min(15, shareRate * 600) +
    Math.max(0, 6 - ageHours / 4) -
    45;
  return clamp(Math.round(raw), 0, 100);
}

function canonicalTikTokUrl(value) {
  try {
    const url = new URL(value);
    if (!url.hostname.endsWith('tiktok.com') || !url.pathname.includes('/photo/')) return '';
    return `https://www.tiktok.com${url.pathname}`;
  } catch { return ''; }
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}
function round(n, digits) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function formatCompact(n) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
}
