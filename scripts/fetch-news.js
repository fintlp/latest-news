
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

// FEED_URLS handling:
// - If FEED_URLS is provided it may be comma-separated OR newline-separated.
// - If FEED_URLS is the literal string 'ALL' or FEED_ALL=1, expand to a wide set of locales.
const FEED_URLS_ENV = process.env.FEED_URLS || '';
const FEED_ALL_FLAG = (process.env.FEED_ALL || '').toString() === '1' || FEED_URLS_ENV.toUpperCase() === 'ALL';

const LOCALES_WIDE = [
  // English markets
  {hl: 'en-US', gl: 'US', ceid: 'US:en'},
  {hl: 'en-GB', gl: 'GB', ceid: 'GB:en'},
  {hl: 'en-AU', gl: 'AU', ceid: 'AU:en'},
  {hl: 'en-CA', gl: 'CA', ceid: 'CA:en'},
  {hl: 'en-IN', gl: 'IN', ceid: 'IN:en'},
  // German DACH
  {hl: 'de', gl: 'DE', ceid: 'DE:de'},
  {hl: 'de', gl: 'AT', ceid: 'AT:de'},
  {hl: 'de', gl: 'CH', ceid: 'CH:de'},
  // French
  {hl: 'fr-FR', gl: 'FR', ceid: 'FR:fr'},
  {hl: 'fr-CA', gl: 'CA', ceid: 'CA:fr'},
  // Spanish
  {hl: 'es-ES', gl: 'ES', ceid: 'ES:es'},
  {hl: 'es-AR', gl: 'AR', ceid: 'AR:es'},
  // Italian / Dutch / Nordic
  {hl: 'it-IT', gl: 'IT', ceid: 'IT:it'},
  {hl: 'nl-NL', gl: 'NL', ceid: 'NL:nl'},
  {hl: 'sv-SE', gl: 'SE', ceid: 'SE:sv'},
  {hl: 'da-DK', gl: 'DK', ceid: 'DK:da'},
  // Asian markets
  {hl: 'ja-JP', gl: 'JP', ceid: 'JP:ja'},
  {hl: 'ko-KR', gl: 'KR', ceid: 'KR:ko'},
  {hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-CN'},
  {hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-TW'},
  {hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-BR'},
  {hl: 'pt-PT', gl: 'PT', ceid: 'PT:pt-PT'},
  {hl: 'ru-RU', gl: 'RU', ceid: 'RU:ru'},
  {hl: 'tr-TR', gl: 'TR', ceid: 'TR:tr'},
  {hl: 'ar-SA', gl: 'SA', ceid: 'SA:ar'},
  {hl: 'hi-IN', gl: 'IN', ceid: 'IN:hi'}
];

function makeFeed({hl, gl, ceid}) {
  return `https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

function parseFeedUrlsEnv(env) {
  // split on newlines or commas
  return env.split(/\s*[\n,]\s*/).map(s => s.trim()).filter(Boolean);
}

let FEEDS = [];
if (FEED_ALL_FLAG) {
  FEEDS = LOCALES_WIDE.map(makeFeed);
} else if (FEED_URLS_ENV) {
  FEEDS = parseFeedUrlsEnv(FEED_URLS_ENV);
} else {
  // sensible default (backwards-compatible subset)
  FEEDS = [
    {hl: 'en-US', gl: 'US', ceid: 'US:en'},
    {hl: 'en-GB', gl: 'GB', ceid: 'GB:en'},
    {hl: 'en-AU', gl: 'AU', ceid: 'AU:en'},
    {hl: 'de', gl: 'AT', ceid: 'AT:de'},
    {hl: 'de', gl: 'DE', ceid: 'DE:de'},
    {hl: 'de', gl: 'CH', ceid: 'CH:de'},
    {hl: 'fr-FR', gl: 'FR', ceid: 'FR:fr'},
    {hl: 'es-ES', gl: 'ES', ceid: 'ES:es'},
    {hl: 'it-IT', gl: 'IT', ceid: 'IT:it'},
    {hl: 'nl-NL', gl: 'NL', ceid: 'NL:nl'},
    {hl: 'sv-SE', gl: 'SE', ceid: 'SE:sv'},
    {hl: 'da-DK', gl: 'DK', ceid: 'DK:da'},
    {hl: 'ja-JP', gl: 'JP', ceid: 'JP:ja'},
    {hl: 'ko-KR', gl: 'KR', ceid: 'KR:ko'}
  ].map(makeFeed);
}

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
  const feedSummaries = [];
  for (const feedUrl of FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      const items = (feed.items || []).map(i => normalizeItem(i)).filter(n => n.publishedAt);
      for (const n of items) allItems.push(n);
      if (items.length) {
        const dates = items.map(i => new Date(i.publishedAt).getTime()).filter(Boolean);
        const earliest = new Date(Math.min(...dates)).toISOString();
        const latest = new Date(Math.max(...dates)).toISOString();
        console.log(`Feed OK: ${feedUrl} items=${items.length} earliest=${earliest} latest=${latest}`);
        feedSummaries.push({ feed: feedUrl, items: items.length, earliest, latest });
      } else {
        console.log(`Feed OK: ${feedUrl} items=0`);
        feedSummaries.push({ feed: feedUrl, items: 0 });
      }
    } catch (e) {
      console.error('Feed failed:', feedUrl, e.message);
      feedSummaries.push({ feed: feedUrl, error: e.message });
    }
  }
  // expose summaries for writing debug file
  fetchAll._summaries = feedSummaries;
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

    // Write per-feed debug info (temporary)
    try {
      const dbg = fetchAll._summaries || [];
      fs.writeFileSync(path.join(dataDir, 'feed-debug.json'), JSON.stringify(dbg, null, 2), 'utf8');
    } catch (e) { /* ignore debug write failures */ }

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
