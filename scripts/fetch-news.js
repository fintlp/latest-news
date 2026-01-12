
/**
 * Fetch multiple Google News RSS feeds → merge → dedupe → 1-year archive.
 * Runs in GitHub Actions on a schedule; writes:
 *   data/news.json     (latest run, newest-first)
 *   data/archive.json  (rolling 365 days, newest-first)
 *
 * Google News RSS search format (community-documented):
 *   https://news.google.com/rss/search?q={query}&hl={lang}&gl={country}&ceid={country}:{lang}
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Parser = require('rss-parser');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_DAYS = 365;

// Comma-separated FEED_URLS env var supported; otherwise use a sensible multi-locale default.
const FEED_URLS_ENV = process.env.FEED_URLS;

const DEFAULT_FEEDS = [
  // English-major markets
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=en-GB&gl=GB&ceid=GB:en',
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=en-AU&gl=AU&ceid=AU:en',
  // DACH (German)
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=de&gl=AT&ceid=AT:de',
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=de&gl=DE&ceid=DE:de',
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=de&gl=CH&ceid=CH:de',
  // Western Europe
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=fr&gl=FR&ceid=FR:fr',
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=es&gl=ES&ceid=ES:es',
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=it&gl=IT&ceid=IT:it',
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=nl&gl=NL&ceid=NL:nl',
  // Nordics
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=sv&gl=SE&ceid=SE:sv',
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=da&gl=DK&ceid=DK:da',
  // Asia selections
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=ja&gl=JP&ceid=JP:ja',
  'https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=ko&gl=KR&ceid=KR:ko'
];

const FEEDS = FEED_URLS_ENV
  ? FEED_URLS_ENV.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_FEEDS;

const UTM = 'utm_source=linkedin&utm_medium=profile&utm_campaign=latest_news&utm_content=landing';

const parser = new Parser({ timeout: 20000 });

function normalizeItem(item) {
  const publishedAt = item.isoDate || item.pubDate || item.pubdate || null;
  let url = item.link || item.guid || '';

  // Append UTM params when possible
  try {
    const u = new URL(url);
    if (!u.searchParams.has('utm_source')) {
      UTM.split('&').forEach(pair => {
        const [k, v] = pair.split('=');
        u.searchParams.set(k, v);
      });
    }
    url = u.toString();
  } catch (_) { /* leave url as-is if not parseable */ }

  const snippet = (item.contentSnippet || item.content || '')
    .toString().trim().replace(/\s+/g, ' ').slice(0, 300);

  const source = (item.source && item.source.title) || item.creator || '';

  // Use a stable id for dedupe (hash of title+pubDate+source+stripped link)
  const idBasis = [item.title || '', publishedAt || '', source || '', url.replace(/([?&]utm_[^=]+=[^&]+)/g,'')].join('|');
  const id = crypto.createHash('sha1').update(idBasis).digest('hex');

  return {
    id,
    title: item.title || '',
    url,
    source,
    publishedAt,
    snippet
  };
}

async function fetchAll() {
  const allItems = [];
  for (const feedUrl of FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of (feed.items || [])) {
        const n = normalizeItem(item);
        if (n.publishedAt) allItems.push(n);
      }
    } catch (e) {
      console.error('Feed failed:', feedUrl, e.message);
    }
  }
  return allItems;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!seen.has(it.id)) {
      seen.add(it.id);
      out.push(it);
    }
  }
  return out;
}

function sortDesc(items) {
  return items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

function pruneToLastYear(items) {
  const now = Date.now();
  return items.filter(i => (now - new Date(i.publishedAt).getTime()) <= RETAIN_DAYS * ONE_DAY_MS);
}

(function run() {
  (async () => {
    const latest = sortDesc(dedupe(await fetchAll()));

    // Ensure ./data exists
    const dataDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    // Write latest snapshot
    fs.writeFileSync(path.join(dataDir, 'news.json'), JSON.stringify(latest, null, 2), 'utf8');

    // Merge into archive (rolling 1 year)
    const archivePath = path.join(dataDir, 'archive.json');
    let archive = [];
    if (fs.existsSync(archivePath)) {
      try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch {}
    }
    const merged = sortDesc(dedupe([...latest, ...archive]));
    const pruned = pruneToLastYear(merged);

    fs.writeFileSync(archivePath, JSON.stringify(pruned, null, 2), 'utf8');

    console.log(`Latest: ${latest.length} items`);
    console.log(`Archive (≤365d): ${pruned.length} items`);
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
})();
