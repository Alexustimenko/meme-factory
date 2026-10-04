import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaults = JSON.parse(
  await fs.readFile(
    path.join(__dirname, '..', 'data', 'seed-queries.json'),
    'utf8'
  )
);

const hours = clamp(Number(process.env.SCAN_HOURS || 24), 1, 72);
const maxPosts = clamp(Number(process.env.MAX_POSTS || 45), 5, 100);
const maxLinksPerQuery = clamp(
  Number(process.env.MAX_LINKS_PER_QUERY || 15),
  3,
  40
);

const ingestUrl = process.env.INGEST_URL || '';
const ingestKey = process.env.INGEST_KEY || '';

const extra = String(process.env.SCAN_QUERIES || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

if (!ingestUrl || !ingestKey) {
  throw new Error('Нужны GitHub secrets INGEST_URL и INGEST_KEY');
}

console.log(`Scanning TikTok: ${hours}h, maxPosts=${maxPosts}`);

const browser = await chromium.launch({
  headless: true,
});

const context = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'Europe/Berlin',
  viewport: {
    width: 1440,
    height: 1000,
  },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/154.0.0.0 Safari/537.36',
});

await context.route('**/*', async (route) => {
  const type = route.request().resourceType();

  if (['media', 'font'].includes(type)) {
    return route.abort();
  }

  return route.continue();
});

const discoveryPage = await context.newPage();

const creativeTopics = await loadCreativeCenterTopics(discoveryPage);

const queries = [
  ...new Set([
    ...extra,
    ...creativeTopics,
    ...defaults,
  ]),
]
  .filter(Boolean)
  .slice(0, 30);

console.log(`Queries (${queries.length}): ${queries.join(', ')}`);

const foundLinks = new Map();
const directItems = new Map();

let blockedCount = 0;
let pagesVisited = 0;

for (const query of queries) {
  if (foundLinks.size + directItems.size >= maxPosts * 4) {
    break;
  }

  console.log(`Search: ${query}`);

  const cleanTag = query
    .replace(/^#/, '')
    .replace(/\s+/g, '');

  const slug = query
    .replace(/^#/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  const urls = [
    `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`,
    `https://www.tiktok.com/tag/${encodeURIComponent(cleanTag)}`,

    ...(slug
      ? [
          `https://www.tiktok.com/channel/${encodeURIComponent(
            slug
          )}`,
        ]
      : []),
  ];

  for (const target of urls) {
    try {
      pagesVisited += 1;

      const response = await discoveryPage.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: 35_000,
      });

      await discoveryPage.waitForTimeout(2500);

      if (!response || response.status() >= 400) {
        console.log(
          `  HTTP ${response?.status() || 'no response'}: ${target}`
        );

        continue;
      }

      const bodyText = (
        await discoveryPage
          .locator('body')
          .innerText()
          .catch(() => '')
      ).toLowerCase();

      if (
        /captcha|verify to continue|unusual traffic|too many attempts/.test(
          bodyText
        )
      ) {
        blockedCount += 1;

        console.log(`  challenge signal: ${target}`);
      }

      for (let i = 0; i < 4; i++) {
        await discoveryPage.mouse.wheel(0, 2200);
        await discoveryPage.waitForTimeout(700);
      }

      const anchors = await discoveryPage
        .locator('a[href*="/photo/"]')
        .evaluateAll((els) =>
          els
            .map((a) => a.href)
            .filter(Boolean)
        )
        .catch(() => []);

      const scripts = await discoveryPage
        .locator('script')
        .allTextContents()
        .catch(() => []);

      const scriptLinks =
        extractPhotoLinksFromScripts(scripts);

      const scriptItems =
        extractPhotoItemsFromScripts(scripts);

      let added = 0;

      for (
        const link of [...anchors, ...scriptLinks].slice(
          0,
          maxLinksPerQuery * 3
        )
      ) {
        const clean = canonicalTikTokUrl(link);

        if (
          clean &&
          !foundLinks.has(clean)
        ) {
          foundLinks.set(clean, query);
          added += 1;
        }

        if (added >= maxLinksPerQuery) {
          break;
        }
      }

      for (const item of scriptItems) {
        const trend = normalizeItem(
          item,
          itemUrl(item),
          query
        );

        if (!trend) {
          continue;
        }

        if (
          trend.ageHours < 0 ||
          trend.ageHours > hours ||
          trend.imageCount !== 1
        ) {
          continue;
        }

        const key =
          trend.url || trend.id;

        if (!directItems.has(key)) {
          directItems.set(key, trend);
        }

        if (directItems.size >= maxPosts * 2) {
          break;
        }
      }

      console.log(
        `  found: anchors=${anchors.length}, ` +
          `scriptLinks=${scriptLinks.length}, ` +
          `scriptItems=${scriptItems.length}`
      );

      if (
        anchors.length ||
        scriptLinks.length ||
        scriptItems.length
      ) {
        break;
      }
    } catch (error) {
      console.log(
        `  search error: ${error.message}`
      );
    }
  }
}

console.log(
  `Discovery: links=${foundLinks.size}, ` +
    `directPhotoItems=${directItems.size}, ` +
    `pages=${pagesVisited}, ` +
    `blockedSignals=${blockedCount}`
);

const trends = [
  ...directItems.values(),
];

const postPage = await context.newPage();

let inspected = 0;

for (const [url, query] of foundLinks) {
  if (
    inspected >= maxPosts ||
    trends.length >= maxPosts
  ) {
    break;
  }

  if (
    trends.some(
      (x) => x.url === url
    )
  ) {
    continue;
  }

  inspected += 1;

  try {
    const response = await postPage.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 35_000,
    });

    if (
      !response ||
      response.status() >= 400
    ) {
      continue;
    }

    await postPage.waitForTimeout(1200);

    const scripts = await postPage
      .locator('script')
      .allTextContents();

    const item =
      findPhotoItemFromScripts(scripts);

    if (!item) {
      continue;
    }

    const trend = normalizeItem(
      item,
      url,
      query
    );

    if (!trend) {
      continue;
    }

    if (
      trend.ageHours < 0 ||
      trend.ageHours > hours
    ) {
      continue;
    }

    if (
      trend.imageCount !== 1
    ) {
      continue;
    }

    trends.push(trend);

    console.log(
      `  + ${trend.viralScore}/100 | ` +
        `${formatCompact(trend.views)} | ` +
        `${trend.ageHours.toFixed(1)}h | ` +
        `${url}`
    );
  } catch (error) {
    console.log(
      `  post error: ${error.message}`
    );
  }
}

if (!trends.length) {
  try {
    const artifactDir = path.join(
      __dirname,
      '..',
      'artifacts'
    );

    await fs.mkdir(
      artifactDir,
      {
        recursive: true,
      }
    );

    await discoveryPage.screenshot({
      path: path.join(
        artifactDir,
        'last-page.png'
      ),
      fullPage: true,
    });

    const debugText = await discoveryPage
      .locator('body')
      .innerText()
      .catch(() => '');

    await fs.writeFile(
      path.join(
        artifactDir,
        'last-page.txt'
      ),
      debugText.slice(0, 200000),
      'utf8'
    );

    await fs.writeFile(
      path.join(
        artifactDir,
        'discovery.json'
      ),
      JSON.stringify(
        {
          creativeTopics,
          queries,

          foundLinks: [
            ...foundLinks.keys(),
          ],

          directItems: [
            ...directItems.keys(),
          ],

          pagesVisited,
          blockedCount,
        },
        null,
        2
      ),
      'utf8'
    );

    console.log(
      'Saved zero-result diagnostics to artifacts/'
    );
  } catch (error) {
    console.log(
      `Could not save diagnostics: ${error.message}`
    );
  }
}

await browser.close();

const unique =
  dedupeTrends(trends);

unique.sort(
  (a, b) =>
    b.viralScore -
      a.viralScore ||
    b.viewsPerHour -
      a.viewsPerHour
);

const top =
  unique.slice(0, 40);

const payload = {
  scannedAt:
    new Date().toISOString(),

  hours,

  candidates:
    foundLinks.size +
    directItems.size,

  queries,

  trends: top,

  note: top.length
    ? `Found ${top.length} eligible one-photo posts. ` +
      `discoveryLinks=${foundLinks.size}, ` +
      `directItems=${directItems.size}, ` +
      `blockedSignals=${blockedCount}`
    : `No eligible one-photo posts found. ` +
      `discoveryLinks=${foundLinks.size}, ` +
      `directItems=${directItems.size}, ` +
      `blockedSignals=${blockedCount}, ` +
      `creativeTopics=${creativeTopics.length}. ` +
      `TikTok may be withholding public post data from the GitHub runner.`,
};

const upload =
  await fetch(ingestUrl, {
    method: 'POST',

    headers: {
      authorization:
        `Bearer ${ingestKey}`,

      'content-type':
        'application/json',
    },

    body: JSON.stringify(
      payload
    ),
  });

const resultText =
  await upload.text();

if (!upload.ok) {
  throw new Error(
    `Ingest failed ${upload.status}: ${resultText}`
  );
}

console.log(
  `Ingest OK: ${resultText}`
);

async function loadCreativeCenterTopics(
  page
) {
  const targets = [
    'https://ads.tiktok.com/creative/creativeCenter/trends?region=US&period=7',

    'https://ads.tiktok.com/creative/creativeCenter/trends?region=GB&period=7',
  ];

  const topics =
    new Set();

  for (const target of targets) {
    try {
      console.log(
        `Creative Center: ${target}`
      );

      const response =
        await page.goto(
          target,
          {
            waitUntil:
              'domcontentloaded',

            timeout: 35_000,
          }
        );

      if (
        !response ||
        response.status() >= 400
      ) {
        continue;
      }

      await page.waitForTimeout(
        3500
      );

      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(
          0,
          1800
        );

        await page.waitForTimeout(
          600
        );
      }

      const text =
        await page
          .locator('body')
          .innerText()
          .catch(() => '');

      for (
        const match of text.matchAll(
          /#([\p{L}\p{N}_]{2,50})/gu
        )
      ) {
        topics.add(
          `#${match[1]}`
        );

        if (
          topics.size >= 15
        ) {
          break;
        }
      }

      if (
        topics.size >= 15
      ) {
        break;
      }
    } catch (error) {
      console.log(
        `  Creative Center error: ${error.message}`
      );
    }
  }

  const list = [
    ...topics,
  ].slice(0, 15);

  console.log(
    `Creative Center topics: ${list.length}` +
      `${
        list.length
          ? ` -> ${list.join(', ')}`
          : ''
      }`
  );

  return list;
}

function extractPhotoLinksFromScripts(
  scripts
) {
  const out =
    new Set();

  const patterns = [
    /https?:\\?\/?\\?\/www\.tiktok\.com\\?\/@[^"'\\\s<>]+\\?\/photo\\?\/\d+/gi,

    /\/(@[^"'\\\s<>]+)\/photo\/(\d+)/gi,
  ];

  for (const raw of scripts) {
    const text = String(
      raw || ''
    )
      .replaceAll(
        '\\u002F',
        '/'
      )
      .replaceAll(
        '\\/',
        '/'
      )
      .replaceAll(
        '\\u003A',
        ':'
      );

    for (
      const pattern of patterns
    ) {
      for (
        const match of text.matchAll(
          pattern
        )
      ) {
        let value =
          match[0];

        if (
          value.startsWith(
            '/@'
          )
        ) {
          value =
            `https://www.tiktok.com${value}`;
        }

        value =
          value.replaceAll(
            '\\',
            ''
          );

        const clean =
          canonicalTikTokUrl(
            value
          );

        if (clean) {
          out.add(clean);
        }
      }
    }
  }

  return [
    ...out,
  ];
}

function extractPhotoItemsFromScripts(
  scripts
) {
  const out = [];
  const seen =
    new Set();

  for (const text of scripts) {
    const t = String(
      text || ''
    ).trim();

    if (
      !t ||
      (
        t[0] !== '{' &&
        t[0] !== '['
      )
    ) {
      continue;
    }

    if (
      !t.includes(
        'imagePost'
      )
    ) {
      continue;
    }

    let parsed;

    try {
      parsed =
        JSON.parse(t);
    } catch {
      continue;
    }

    for (
      const item of walkForItems(
        parsed,
        60
      )
    ) {
      const id = String(
        item.id ||
          item.itemId ||
          ''
      );

      if (
        !id ||
        seen.has(id)
      ) {
        continue;
      }

      seen.add(id);

      out.push(item);
    }
  }

  return out;
}

function findPhotoItemFromScripts(
  scripts
) {
  return (
    extractPhotoItemsFromScripts(
      scripts
    )[0] || null
  );
}

function walkForItems(
  root,
  limit = 50
) {
  const stack = [
    root,
  ];

  const found = [];

  let visited = 0;

  while (
    stack.length &&
    visited < 250_000 &&
    found.length < limit
  ) {
    const node =
      stack.pop();

    visited += 1;

    if (
      !node ||
      typeof node !==
        'object'
    ) {
      continue;
    }

    const stats =
      node.stats ||
      node.statsV2;

    const imagePost =
      node.imagePost;

    if (
      stats &&
      imagePost &&
      Array.isArray(
        imagePost.images
      ) &&
      (
        node.id ||
        node.itemId
      ) &&
      node.createTime
    ) {
      found.push(node);
      continue;
    }

    if (
      Array.isArray(node)
    ) {
      for (
        let i =
          node.length - 1;
        i >= 0;
        i--
      ) {
        if (
          node[i] &&
          typeof node[i] ===
            'object'
        ) {
          stack.push(
            node[i]
          );
        }
      }
    } else {
      for (
        const value of Object.values(
          node
        )
      ) {
        if (
          value &&
          typeof value ===
            'object'
        ) {
          stack.push(value);
        }
      }
    }
  }

  return found;
}

function normalizeItem(
  item,
  url,
  query
) {
  const stats =
    item.stats ||
    item.statsV2 ||
    {};

  const images =
    item.imagePost?.images ||
    [];

  if (
    images.length !== 1
  ) {
    return null;
  }

  const createSeconds =
    Number(
      item.createTime || 0
    );

  if (
    !Number.isFinite(
      createSeconds
    ) ||
    createSeconds <= 0
  ) {
    return null;
  }

  const createdAt =
    new Date(
      createSeconds * 1000
    );

  const ageHours =
    (
      Date.now() -
      createdAt.getTime()
    ) /
    3_600_000;

  const views =
    num(
      stats.playCount ??
        stats.playCountV2
    );

  const likes =
    num(
      stats.diggCount
    );

  const comments =
    num(
      stats.commentCount
    );

  const shares =
    num(
      stats.shareCount
    );

  const viewsPerHour =
    views /
    Math.max(
      ageHours,
      0.5
    );

  const engagementRate =
    views > 0
      ? (
          likes +
          comments +
          shares
        ) / views
      : 0;

  const shareRate =
    views > 0
      ? shares / views
      : 0;

  const viralScore =
    scoreViral({
      views,
      viewsPerHour,
      engagementRate,
      shareRate,
      ageHours,
    });

  const caption =
    String(
      item.desc ||
        item.title ||
        ''
    ).trim();

  const hashtags =
    extractHashtags(
      item,
      caption
    );

  const imageUrl =
    firstImageUrl(
      images[0]
    );

  const author =
    typeof item.author ===
    'object'
      ? (
          item.author.uniqueId ||
          item.author.nickname ||
          ''
        )
      : (
          item.author ||
          item.authorId ||
          ''
        );

  return {
    id: String(
      item.id ||
        item.itemId
    ),

    url:
      url ||
      itemUrl(item),

    query,

    author:
      String(
        author || ''
      ),

    caption,

    hashtags,

    imageUrl,

    imageCount:
      images.length,

    views,
    likes,
    comments,
    shares,

    createdAt:
      createdAt.toISOString(),

    ageHours:
      round(
        ageHours,
        2
      ),

    viewsPerHour:
      Math.round(
        viewsPerHour
      ),

    engagementRate:
      round(
        engagementRate,
        4
      ),

    shareRate:
      round(
        shareRate,
        4
      ),

    viralScore,
  };
}

function itemUrl(item) {
  const id = String(
    item?.id ||
      item?.itemId ||
      ''
  );

  const author =
    typeof item?.author ===
    'object'
      ? (
          item.author.uniqueId ||
          ''
        )
      : String(
          item?.author ||
            ''
        );

  if (
    !id ||
    !author
  ) {
    return '';
  }

  return (
    `https://www.tiktok.com/` +
    `@${author}/photo/${id}`
  );
}

function firstImageUrl(
  image
) {
  const possible = [
    image?.imageURL?.urlList,

    image?.displayImage
      ?.urlList,

    image?.thumbnail
      ?.urlList,

    image?.imageUrl
      ?.urlList,

    image?.urlList,
  ];

  for (
    const list of possible
  ) {
    if (
      Array.isArray(list) &&
      list[0]
    ) {
      return list[0];
    }
  }

  return '';
}

function extractHashtags(
  item,
  caption
) {
  const set =
    new Set();

  for (
    const match of caption.matchAll(
      /#([\p{L}\p{N}_]+)/gu
    )
  ) {
    set.add(
      match[1]
    );
  }

  for (
    const c of item.challenges ||
    []
  ) {
    const title =
      c?.title ||
      c?.chaName;

    if (title) {
      set.add(
        String(title).replace(
          /^#/,
          ''
        )
      );
    }
  }

  return [
    ...set,
  ].slice(0, 15);
}

function scoreViral({
  views,
  viewsPerHour,
  engagementRate,
  shareRate,
  ageHours,
}) {
  const raw =
    12 *
      Math.log10(
        viewsPerHour + 1
      ) +
    6 *
      Math.log10(
        views + 1
      ) +
    Math.min(
      25,
      engagementRate *
        120
    ) +
    Math.min(
      15,
      shareRate * 600
    ) +
    Math.max(
      0,
      6 -
        ageHours / 4
    ) -
    45;

  return clamp(
    Math.round(raw),
    0,
    100
  );
}

function canonicalTikTokUrl(
  value
) {
  try {
    const url =
      new URL(value);

    if (
      !url.hostname.endsWith(
        'tiktok.com'
      ) ||
      !url.pathname.includes(
        '/photo/'
      )
    ) {
      return '';
    }

    const match =
      url.pathname.match(
        /\/@([^/]+)\/photo\/(\d+)/
      );

    if (!match) {
      return '';
    }

    return (
      `https://www.tiktok.com/` +
      `@${match[1]}/photo/${match[2]}`
    );
  } catch {
    return '';
  }
}

function dedupeTrends(
  items
) {
  const map =
    new Map();

  for (
    const item of items
  ) {
    const key =
      item.id ||
      item.url;

    if (!key) {
      continue;
    }

    const old =
      map.get(key);

    if (
      !old ||
      Number(
        item.views || 0
      ) >
        Number(
          old.views || 0
        )
    ) {
      map.set(
        key,
        item
      );
    }
  }

  return [
    ...map.values(),
  ];
}

function num(value) {
  const n =
    Number(
      value || 0
    );

  return Number.isFinite(n)
    ? n
    : 0;
}

function round(
  n,
  digits
) {
  const p =
    10 ** digits;

  return (
    Math.round(
      n * p
    ) / p
  );
}

function clamp(
  n,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(
      max,
      n
    )
  );
}

function formatCompact(
  n
) {
  return new Intl.NumberFormat(
    'en',
    {
      notation:
        'compact',

      maximumFractionDigits:
        1,
    }
  ).format(
    n || 0
  );
}