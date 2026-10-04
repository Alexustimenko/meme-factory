import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaults = JSON.parse(
  await fs.readFile(
    path.join(__dirname, "..", "data", "seed-queries.json"),
    "utf8"
  )
);

const hours = clamp(
  Number(process.env.SCAN_HOURS || 24),
  1,
  72
);

const maxPosts = clamp(
  Number(process.env.MAX_POSTS || 60),
  5,
  100
);

const maxLinksPerQuery = clamp(
  Number(process.env.MAX_LINKS_PER_QUERY || 20),
  3,
  40
);

const ingestUrl =
  process.env.INGEST_URL || "";

const ingestKey =
  process.env.INGEST_KEY || "";

const extra = String(
  process.env.SCAN_QUERIES || ""
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

if (!ingestUrl || !ingestKey) {
  throw new Error(
    "Нужны GitHub secrets INGEST_URL и INGEST_KEY"
  );
}

const queries = [
  ...new Set([
    ...extra,
    ...defaults,

    // дополнительные запросы именно под мемы
    "funny meme",
    "relatable meme",
    "work meme",
    "relationship meme",
    "student meme",
    "school meme",
    "programmer meme",
    "life meme",
    "мем",
    "жиза",
    "мем работа",
    "мем отношения",
    "мем универ",
  ]),
]
  .filter(Boolean)
  .slice(0, 30);

console.log(
  `Scanning TikTok via Bing RSS: ${hours}h`
);

console.log(
  `Queries (${queries.length}): ${queries.join(", ")}`
);

/*
 * =========================================================
 * 1. ИЩЕМ TIKTOK PHOTO URL ЧЕРЕЗ BING RSS
 * =========================================================
 */

const foundLinks = new Map();

let bingRequests = 0;

for (const query of queries) {
  if (
    foundLinks.size >=
    maxPosts * 4
  ) {
    break;
  }

  console.log("");
  console.log(
    `Bing discovery: ${query}`
  );

  const searchQueries = [
    `site:tiktok.com "/photo/" "${query}"`,

    `site:www.tiktok.com "${query}" "photo"`,

    `site:tiktok.com inurl:photo "${query}"`,
  ];

  const foundForQuery =
    new Set();

  for (const searchQuery of searchQueries) {
    try {
      bingRequests += 1;

      const links =
        await searchBingRss(
          searchQuery
        );

      console.log(
        `  RSS results: ${links.length}`
      );

      for (const link of links) {
        const clean =
          canonicalTikTokUrl(
            link
          );

        if (!clean) {
          continue;
        }

        foundForQuery.add(
          clean
        );

        if (
          !foundLinks.has(clean)
        ) {
          foundLinks.set(
            clean,
            query
          );
        }

        if (
          foundForQuery.size >=
          maxLinksPerQuery
        ) {
          break;
        }
      }

      if (
        foundForQuery.size >=
        maxLinksPerQuery
      ) {
        break;
      }

      // не долбим Bing слишком быстро
      await sleep(700);
    } catch (error) {
      console.log(
        `  Bing error: ${error.message}`
      );
    }
  }

  console.log(
    `  TikTok photo URLs for query: ${foundForQuery.size}`
  );

  console.log(
    `  Total unique URLs: ${foundLinks.size}`
  );

  await sleep(500);
}

console.log("");
console.log(
  "================================"
);

console.log(
  `Bing requests: ${bingRequests}`
);

console.log(
  `TikTok photo URLs discovered: ${foundLinks.size}`
);

console.log(
  "================================"
);

/*
 * =========================================================
 * 2. ОТКРЫВАЕМ КОНКРЕТНЫЕ TIKTOK ПОСТЫ
 * =========================================================
 */

const browser =
  await chromium.launch({
    headless: true,
  });

const context =
  await browser.newContext({
    locale: "en-US",

    timezoneId:
      "Europe/Berlin",

    viewport: {
      width: 1440,
      height: 1000,
    },

    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/154.0.0.0 Safari/537.36",
  });

/*
 * Видео, аудио и шрифты нам для анализа не нужны.
 * JS и HTML оставляем.
 */
await context.route(
  "**/*",
  async (route) => {
    const type =
      route.request().resourceType();

    if (
      [
        "media",
        "font",
      ].includes(type)
    ) {
      return route.abort();
    }

    return route.continue();
  }
);

const page =
  await context.newPage();

const trends = [];

let inspected = 0;
let blockedCount = 0;
let noJsonCount = 0;
let expiredCount = 0;
let multiImageCount = 0;

let lastVisitedUrl = "";

for (const [url, query] of foundLinks) {
  if (
    inspected >= maxPosts
  ) {
    break;
  }

  inspected += 1;

  lastVisitedUrl = url;

  console.log("");
  console.log(
    `[${inspected}/${Math.min(
      foundLinks.size,
      maxPosts
    )}] ${url}`
  );

  try {
    const response =
      await page.goto(
        url,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            35_000,
        }
      );

    if (!response) {
      console.log(
        "  no HTTP response"
      );

      continue;
    }

    console.log(
      `  HTTP ${response.status()}`
    );

    if (
      response.status() >= 400
    ) {
      continue;
    }

    await page.waitForTimeout(
      1800
    );

    const bodyText =
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).toLowerCase();

    if (
      /captcha|verify to continue|unusual traffic|too many attempts/.test(
        bodyText
      )
    ) {
      blockedCount += 1;

      console.log(
        "  TikTok challenge detected"
      );

      continue;
    }

    /*
     * На TikTok данные поста обычно лежат
     * внутри JSON script-тегов.
     */
    const scripts =
      await page
        .locator("script")
        .allTextContents()
        .catch(() => []);

    console.log(
      `  script tags: ${scripts.length}`
    );

    const item =
      findPhotoItemFromScripts(
        scripts
      );

    if (!item) {
      noJsonCount += 1;

      console.log(
        "  photo JSON not found"
      );

      continue;
    }

    const trend =
      normalizeItem(
        item,
        url,
        query
      );

    if (!trend) {
      console.log(
        "  invalid photo item"
      );

      continue;
    }

    console.log(
      `  age=${trend.ageHours.toFixed(
        2
      )}h`
    );

    console.log(
      `  images=${trend.imageCount}`
    );

    console.log(
      `  views=${formatCompact(
        trend.views
      )}`
    );

    /*
     * Только последние N часов
     */
    if (
      trend.ageHours < 0 ||
      trend.ageHours > hours
    ) {
      expiredCount += 1;

      console.log(
        "  skip: too old"
      );

      continue;
    }

    /*
     * Нам нужны именно мемы
     * с ОДНОЙ картинкой.
     */
    if (
      trend.imageCount !== 1
    ) {
      multiImageCount += 1;

      console.log(
        `  skip: imageCount=${trend.imageCount}`
      );

      continue;
    }

    trends.push(
      trend
    );

    console.log(
      `  ✅ ACCEPTED`
    );

    console.log(
      `  Viral Score: ${trend.viralScore}/100`
    );

    console.log(
      `  Views: ${formatCompact(
        trend.views
      )}`
    );

    console.log(
      `  Views/hour: ${formatCompact(
        trend.viewsPerHour
      )}`
    );
  } catch (error) {
    console.log(
      `  post error: ${error.message}`
    );
  }

  /*
   * Небольшая пауза.
   */
  await sleep(900);
}

/*
 * =========================================================
 * 3. ДИАГНОСТИКА
 * =========================================================
 */

if (!trends.length) {
  try {
    const artifactDir =
      path.join(
        __dirname,
        "..",
        "artifacts"
      );

    await fs.mkdir(
      artifactDir,
      {
        recursive: true,
      }
    );

    /*
     * Сохраняем скрин последней
     * страницы TikTok.
     */
    await page.screenshot({
      path: path.join(
        artifactDir,
        "last-page.png"
      ),

      fullPage: true,
    }).catch(() => {});

    const debugText =
      await page
        .locator("body")
        .innerText()
        .catch(() => "");

    await fs.writeFile(
      path.join(
        artifactDir,
        "last-page.txt"
      ),

      debugText.slice(
        0,
        200000
      ),

      "utf8"
    );

    await fs.writeFile(
      path.join(
        artifactDir,
        "discovery.json"
      ),

      JSON.stringify(
        {
          scannedAt:
            new Date().toISOString(),

          queries,

          bingRequests,

          discovered:
            foundLinks.size,

          discoveredUrls: [
            ...foundLinks.keys(),
          ],

          inspected,

          accepted:
            trends.length,

          blockedCount,

          noJsonCount,

          expiredCount,

          multiImageCount,

          lastVisitedUrl,
        },

        null,
        2
      ),

      "utf8"
    );

    console.log("");
    console.log(
      "Saved diagnostics to artifacts/"
    );
  } catch (error) {
    console.log(
      `Diagnostics error: ${error.message}`
    );
  }
}

await browser.close();

/*
 * =========================================================
 * 4. СОРТИРУЕМ ПО VIRAL SCORE
 * =========================================================
 */

const unique =
  dedupeTrends(
    trends
  );

unique.sort(
  (a, b) =>
    b.viralScore -
      a.viralScore ||
    b.viewsPerHour -
      a.viewsPerHour ||
    b.views -
      a.views
);

const top =
  unique.slice(
    0,
    40
  );

console.log("");
console.log(
  "================================"
);

console.log(
  `Discovered: ${foundLinks.size}`
);

console.log(
  `Inspected: ${inspected}`
);

console.log(
  `Accepted: ${top.length}`
);

console.log(
  `Too old: ${expiredCount}`
);

console.log(
  `Multi-image: ${multiImageCount}`
);

console.log(
  `No TikTok JSON: ${noJsonCount}`
);

console.log(
  `Challenge signals: ${blockedCount}`
);

console.log(
  "================================"
);

/*
 * =========================================================
 * 5. ОТПРАВЛЯЕМ РЕЗУЛЬТАТ В CLOUDFLARE
 * =========================================================
 */

const payload = {
  scannedAt:
    new Date().toISOString(),

  hours,

  candidates:
    foundLinks.size,

  queries,

  trends:
    top,

  note:
    top.length
      ? (
          `Found ${top.length} eligible one-photo posts. ` +
          `discovered=${foundLinks.size}, ` +
          `inspected=${inspected}, ` +
          `blocked=${blockedCount}`
        )
      : (
          `No eligible posts. ` +
          `Bing discovered=${foundLinks.size}, ` +
          `inspected=${inspected}, ` +
          `noJson=${noJsonCount}, ` +
          `expired=${expiredCount}, ` +
          `multiImage=${multiImageCount}, ` +
          `blocked=${blockedCount}`
        ),
};

const upload =
  await fetch(
    ingestUrl,
    {
      method: "POST",

      headers: {
        authorization:
          `Bearer ${ingestKey}`,

        "content-type":
          "application/json",
      },

      body:
        JSON.stringify(
          payload
        ),
    }
  );

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

/*
 * =========================================================
 * BING RSS
 * =========================================================
 */

async function searchBingRss(
  query
) {
  const url =
    new URL(
      "https://www.bing.com/search"
    );

  url.searchParams.set(
    "q",
    query
  );

  url.searchParams.set(
    "format",
    "rss"
  );

  url.searchParams.set(
    "count",
    "50"
  );

  url.searchParams.set(
    "setlang",
    "en-US"
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/154 Safari/537.36",

          accept:
            "application/rss+xml, application/xml, text/xml;q=0.9,*/*;q=0.8",
        },
      }
    );

  if (!response.ok) {
    throw new Error(
      `Bing HTTP ${response.status}`
    );
  }

  const xml =
    await response.text();

  /*
   * Сохраняем все TikTok photo URLs,
   * которые встречаются в RSS.
   */
  const links =
    new Set();

  const items =
    [
      ...xml.matchAll(
        /<item>([\s\S]*?)<\/item>/gi
      ),
    ];

  for (const item of items) {
    const content =
      item[1] || "";

    /*
     * Берём link.
     */
    const rssLink =
      extractXmlTag(
        content,
        "link"
      );

    if (rssLink) {
      for (
        const found of extractTikTokPhotoUrls(
          rssLink
        )
      ) {
        links.add(
          found
        );
      }
    }

    /*
     * Иногда URL может попасть
     * в description/title.
     */
    const description =
      extractXmlTag(
        content,
        "description"
      );

    for (
      const found of extractTikTokPhotoUrls(
        description
      )
    ) {
      links.add(
        found
      );
    }

    const title =
      extractXmlTag(
        content,
        "title"
      );

    for (
      const found of extractTikTokPhotoUrls(
        title
      )
    ) {
      links.add(
        found
      );
    }
  }

  /*
   * Дополнительно ищем URL
   * прямо во всём XML.
   */
  for (
    const found of extractTikTokPhotoUrls(
      xml
    )
  ) {
    links.add(
      found
    );
  }

  return [
    ...links,
  ];
}

function extractXmlTag(
  xml,
  tag
) {
  const regex =
    new RegExp(
      `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match =
    xml.match(
      regex
    );

  return match
    ? decodeXml(
        match[1]
      )
    : "";
}

function decodeXml(
  value
) {
  return String(
    value || ""
  )
    .replaceAll(
      "<![CDATA[",
      ""
    )
    .replaceAll(
      "]]>",
      ""
    )
    .replaceAll(
      "&amp;",
      "&"
    )
    .replaceAll(
      "&quot;",
      '"'
    )
    .replaceAll(
      "&#39;",
      "'"
    )
    .replaceAll(
      "&lt;",
      "<"
    )
    .replaceAll(
      "&gt;",
      ">"
    );
}

function extractTikTokPhotoUrls(
  input
) {
  const result =
    new Set();

  let text =
    decodeXml(
      input
    );

  /*
   * Иногда URL закодирован
   * через %2F / %3A.
   */
  for (
    let i = 0;
    i < 2;
    i++
  ) {
    try {
      const decoded =
        decodeURIComponent(
          text
        );

      if (
        decoded === text
      ) {
        break;
      }

      text =
        decoded;
    } catch {
      break;
    }
  }

  text =
    text
      .replaceAll(
        "\\/",
        "/"
      )
      .replaceAll(
        "\\u002F",
        "/"
      )
      .replaceAll(
        "\\u003A",
        ":"
      );

  const regex =
    /https?:\/\/(?:www\.)?tiktok\.com\/@[^\/\s"'<>?&]+\/photo\/\d+/gi;

  for (
    const match of text.matchAll(
      regex
    )
  ) {
    const clean =
      canonicalTikTokUrl(
        match[0]
      );

    if (clean) {
      result.add(
        clean
      );
    }
  }

  return [
    ...result,
  ];
}

/*
 * =========================================================
 * TIKTOK JSON
 * =========================================================
 */

function findPhotoItemFromScripts(
  scripts
) {
  const items =
    extractPhotoItemsFromScripts(
      scripts
    );

  return (
    items[0] ||
    null
  );
}

function extractPhotoItemsFromScripts(
  scripts
) {
  const out = [];

  const seen =
    new Set();

  for (
    const raw of scripts
  ) {
    const text =
      String(
        raw || ""
      ).trim();

    if (!text) {
      continue;
    }

    /*
     * Сначала интересуют скрипты,
     * в которых вообще встречается imagePost.
     */
    if (
      !text.includes(
        "imagePost"
      )
    ) {
      continue;
    }

    /*
     * Большинство TikTok state scripts
     * являются чистым JSON.
     */
    if (
      text[0] === "{" ||
      text[0] === "["
    ) {
      try {
        const parsed =
          JSON.parse(
            text
          );

        for (
          const item of walkForItems(
            parsed,
            100
          )
        ) {
          const id =
            String(
              item.id ||
              item.itemId ||
              ""
            );

          if (
            !id ||
            seen.has(id)
          ) {
            continue;
          }

          seen.add(id);

          out.push(
            item
          );
        }
      } catch {
        // это не чистый JSON
      }
    }
  }

  return out;
}

function walkForItems(
  root,
  limit = 100
) {
  const stack = [
    root,
  ];

  const found = [];

  let visited = 0;

  while (
    stack.length &&
    visited < 300000 &&
    found.length < limit
  ) {
    const node =
      stack.pop();

    visited += 1;

    if (
      !node ||
      typeof node !==
        "object"
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
      found.push(
        node
      );

      continue;
    }

    if (
      Array.isArray(
        node
      )
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
            "object"
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
            "object"
        ) {
          stack.push(
            value
          );
        }
      }
    }
  }

  return found;
}

/*
 * =========================================================
 * NORMALIZATION
 * =========================================================
 */

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
    item.imagePost
      ?.images ||
    [];

  const createSeconds =
    Number(
      item.createTime ||
      0
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
      createSeconds *
      1000
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
        ) /
        views
      : 0;

  const shareRate =
    views > 0
      ? shares /
        views
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
      ""
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
      "object"
      ? (
          item.author
            .uniqueId ||
          item.author
            .nickname ||
          ""
        )
      : (
          item.author ||
          item.authorId ||
          ""
        );

  return {
    id:
      String(
        item.id ||
        item.itemId ||
        ""
      ),

    url,

    query,

    author:
      String(
        author || ""
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

function firstImageUrl(
  image
) {
  const possible = [
    image?.imageURL
      ?.urlList,

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
      Array.isArray(
        list
      ) &&
      list[0]
    ) {
      return list[0];
    }
  }

  return "";
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
    const challenge of
      item.challenges ||
      []
  ) {
    const title =
      challenge?.title ||
      challenge?.chaName;

    if (title) {
      set.add(
        String(
          title
        ).replace(
          /^#/,
          ""
        )
      );
    }
  }

  return [
    ...set,
  ].slice(
    0,
    15
  );
}

/*
 * =========================================================
 * VIRAL SCORE
 * =========================================================
 */

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
        viewsPerHour +
        1
      ) +

    6 *
      Math.log10(
        views +
        1
      ) +

    Math.min(
      25,
      engagementRate *
        120
    ) +

    Math.min(
      15,
      shareRate *
        600
    ) +

    Math.max(
      0,
      6 -
        ageHours /
          4
    ) -

    45;

  return clamp(
    Math.round(
      raw
    ),
    0,
    100
  );
}

/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

function canonicalTikTokUrl(
  value
) {
  try {
    const url =
      new URL(
        value
      );

    if (
      !url.hostname.endsWith(
        "tiktok.com"
      )
    ) {
      return "";
    }

    const match =
      url.pathname.match(
        /\/@([^/]+)\/photo\/(\d+)/
      );

    if (!match) {
      return "";
    }

    return (
      `https://www.tiktok.com/` +
      `@${match[1]}/photo/${match[2]}`
    );
  } catch {
    return "";
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
      map.get(
        key
      );

    if (
      !old ||
      Number(
        item.views ||
        0
      ) >
      Number(
        old.views ||
        0
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

function num(
  value
) {
  const n =
    Number(
      value ||
      0
    );

  return Number.isFinite(
    n
  )
    ? n
    : 0;
}

function round(
  n,
  digits
) {
  const p =
    10 **
    digits;

  return (
    Math.round(
      n *
      p
    ) /
    p
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
    "en",
    {
      notation:
        "compact",

      maximumFractionDigits:
        1,
    }
  ).format(
    n ||
    0
  );
}

function sleep(
  ms
) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}