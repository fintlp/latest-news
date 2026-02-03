
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

function faviconFor(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const d = u.hostname;
    if (!d) return null;
    return `https://www.google.com/s2/favicons?domain=${d}&sz=128`;
  } catch (_) {
    return null;
  }
}



const _finalOriginCache = new Map();

async function resolveFinalOrigin(possiblyGoogleNewsUrl) {
  try {
    if (!possiblyGoogleNewsUrl) return null;
    if (_finalOriginCache.has(possiblyGoogleNewsUrl)) return _finalOriginCache.get(possiblyGoogleNewsUrl);

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);

    // Follow redirects; response.url becomes the final URL.
    const res = await fetch(possiblyGoogleNewsUrl, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VeraxBot/1.0; +https://fintlp.github.io/latest-news/)'
      }
    });
    clearTimeout(t);

    const finalUrl = res.url || '';
    let origin = null;
    try { origin = new URL(finalUrl).origin; } catch (_) { origin = null; }

    _finalOriginCache.set(possiblyGoogleNewsUrl, origin);
    return origin;
  } catch (_) {
    _finalOriginCache.set(possiblyGoogleNewsUrl, null);
    return null;
  }
}
function extractImageUrl(item) {
  // Try common RSS image fields first
  const pickUrl = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      for (const x of v) {
        const u = pickUrl(x);
        if (u) return u;
      }
      return null;
    }
    if (typeof v === 'object') {
      return v.url || v.href || v.link || v.src || null;
    }
    return null;
  };

  const direct = pickUrl(item.enclosure) || pickUrl(item.enclosures) || pickUrl(item['media:content']) || pickUrl(item['media:thumbnail']);
  if (direct) return direct;

  // Fallback: parse <img src=...> from any HTML-ish fields
  const html = [item.content, item['content:encoded'], item.summary, item.description].filter(Boolean).join(' ');
  if (html) {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && m[1]) return m[1];
  }

  return null;
}

async function normalizeItem(item) {
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

  // Google News RSS: rss-parser may expose <source> as a string OR an object { title, url }
  let source = '';
  let sourceUrl = '';
  const src = item.source;
  if (typeof src === 'string') {
    source = src;
  } else if (src && typeof src === 'object') {
    source = src.title || '';
    sourceUrl = src.url || '';
  }
  if (!source) source = item.creator || '';


  // Fallback: if RSS doesn't give us a sourceUrl, follow Google News redirects and use the publisher domain
  if (!sourceUrl && url && url.includes('news.google.com')) {
    const origin = await resolveFinalOrigin(url);
    if (origin) sourceUrl = origin;
  }

  const imageUrl = extractImageUrl(item);
  const faviconUrl = faviconFor(sourceUrl);

  // Use a stable id for dedupe (hash of title+pubDate+source+stripped link)
  const idBasis = [item.title || '', publishedAt || '', source || '', url.replace(/([?&]utm_[^=]+=[^&]+)/g,'')].join('|');
  const id = crypto.createHash('sha1').update(idBasis).digest('hex');

  return {
    id,
    title: item.title || '',
    url,
    source,
    sourceUrl,
    faviconUrl,
    imageUrl,
    publishedAt,
    snippet
  };
}

async function fetchAll() {
  const allItems = [];
  for (const feedUrl of FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      const items = (await Promise.all((feed.items || []).map(i => normalizeItem(i)))).filter(n => n.publishedAt);
      for (const n of items) allItems.push(n);
      if (items.length) {
        const dates = items.map(i => new Date(i.publishedAt).getTime()).filter(Boolean);
        const earliest = new Date(Math.min(...dates)).toISOString();
        const latest = new Date(Math.max(...dates)).toISOString();
        console.log(`Feed OK: ${feedUrl} items=${items.length} earliest=${earliest} latest=${latest}`);
      } else {
        console.log(`Feed OK: ${feedUrl} items=0`);
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
