const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Parser = require('rss-parser');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_DAYS = 365;

const FEED_URLS_ENV = process.env.FEED_URLS || '';
const FEED_ALL_FLAG = (process.env.FEED_ALL || '').toString() === '1' || FEED_URLS_ENV.toUpperCase() === 'ALL';

const LOCALES_WIDE = [
  {hl: 'en-US', gl: 'US', ceid: 'US:en'}, {hl: 'en-GB', gl: 'GB', ceid: 'GB:en'},
  {hl: 'en-AU', gl: 'AU', ceid: 'AU:en'}, {hl: 'en-CA', gl: 'CA', ceid: 'CA:en'},
  {hl: 'en-IN', gl: 'IN', ceid: 'IN:en'}, {hl: 'de', gl: 'DE', ceid: 'DE:de'},
  {hl: 'de', gl: 'AT', ceid: 'AT:de'}, {hl: 'de', gl: 'CH', ceid: 'CH:de'},
  {hl: 'fr-FR', gl: 'FR', ceid: 'FR:fr'}, {hl: 'fr-CA', gl: 'CA', ceid: 'CA:fr'},
  {hl: 'es-ES', gl: 'ES', ceid: 'ES:es'}, {hl: 'es-AR', gl: 'AR', ceid: 'AR:es'},
  {hl: 'it-IT', gl: 'IT', ceid: 'IT:it'}, {hl: 'nl-NL', gl: 'NL', ceid: 'NL:nl'},
  {hl: 'sv-SE', gl: 'SE', ceid: 'SE:sv'}, {hl: 'da-DK', gl: 'DK', ceid: 'DK:da'},
  {hl: 'ja-JP', gl: 'JP', ceid: 'JP:ja'}, {hl: 'ko-KR', gl: 'KR', ceid: 'KR:ko'}
];

function makeFeed({hl, gl, ceid}) {
  return `https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

let FEEDS = [];
if (FEED_ALL_FLAG) {
  FEEDS = LOCALES_WIDE.map(makeFeed);
} else if (FEED_URLS_ENV) {
  FEEDS = FEED_URLS_ENV.split(/\s*[\n,]\s*/).map(s => s.trim()).filter(Boolean);
} else {
  FEEDS = [
    {hl: 'en-US', gl: 'US', ceid: 'US:en'}, {hl: 'en-GB', gl: 'GB', ceid: 'GB:en'},
    {hl: 'en-AU', gl: 'AU', ceid: 'AU:en'}, {hl: 'de', gl: 'AT', ceid: 'AT:de'},
    {hl: 'de', gl: 'DE', ceid: 'DE:de'}, {hl: 'de', gl: 'CH', ceid: 'CH:de'}
  ].map(makeFeed);
}

const UTM = 'utm_source=linkedin&utm_medium=profile&utm_campaign=latest_news&utm_content=landing';
const parser = new Parser({ timeout: 20000 });

function faviconFor(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const d = u.hostname;
    return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=128` : null;
  } catch (_) { return null; }
}

const _metaCache = new Map();

async function fetchFinalMeta(possiblyGoogleNewsUrl) {
  if (!possiblyGoogleNewsUrl) return null;
  if (_metaCache.has(possiblyGoogleNewsUrl)) return _metaCache.get(possiblyGoogleNewsUrl);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);

  let meta = { finalUrl: '', origin: null, ogImage: null, ogDesc: null, title: null };
  try {
    const res = await fetch(possiblyGoogleNewsUrl, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    
    meta.finalUrl = res.url || '';
    try { meta.origin = new URL(meta.finalUrl).origin; } catch (_) {}

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
        const html = await res.text();
        const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || 
                             html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                            html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i);
        const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                           html.match(/<title[^>]*>([^<]+)<\/title>/i);

        if (ogImageMatch) meta.ogImage = ogImageMatch[1].replace(/&amp;/g, '&');
        if (ogDescMatch) meta.ogDesc = ogDescMatch[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        if (titleMatch) meta.title = titleMatch[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    }
  } catch (err) {
    // silently fail
  } finally {
    clearTimeout(t);
  }
  
  _metaCache.set(possiblyGoogleNewsUrl, meta);
  return meta;
}

function extractImageUrl(item) {
  const pickUrl = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      for (const x of v) { const u = pickUrl(x); if (u) return u; }
      return null;
    }
    if (typeof v === 'object') return v.url || v.href || v.link || v.src || null;
    return null;
  };
  const direct = pickUrl(item.enclosure) || pickUrl(item.enclosures) || pickUrl(item['media:content']) || pickUrl(item['media:thumbnail']);
  if (direct) return direct;
  return null;
}

async function normalizeItem(item) {
  const publishedAt = item.isoDate || item.pubDate || item.pubdate || null;
  let url = item.link || item.guid || '';

  let meta = null;
  if (url) {
      meta = await fetchFinalMeta(url);
  }

  let finalLink = meta && meta.finalUrl ? meta.finalUrl : url;
  try {
    const u = new URL(finalLink);
    if (!u.searchParams.has('utm_source')) {
      UTM.split('&').forEach(pair => { const [k, v] = pair.split('='); u.searchParams.set(k, v); });
    }
    finalLink = u.toString();
  } catch (_) { }

  let source = '';
  let sourceUrl = '';
  if (typeof item.source === 'string') {
    source = item.source;
  } else if (item.source && typeof item.source === 'object') {
    source = item.source.title || '';
    sourceUrl = item.source.url || '';
  }
  
  // Google News RSS fallback: publisher is in <font color="#6f6f6f">
  if (!source && item.content) {
      const match = item.content.match(/<font color=["']#6f6f6f["']>([^<]+)<\/font>/i);
      if (match && match[1]) {
          source = match[1].trim();
      }
  }
  
  if (!source) source = item.creator || '';

  if (!sourceUrl && meta && meta.origin) sourceUrl = meta.origin;

  let imageUrl = (meta && meta.ogImage) ? meta.ogImage : extractImageUrl(item);
  let rawSnippet = (item.contentSnippet || item.content || '').toString().trim().replace(/\s+/g, ' ');
  if (source && rawSnippet.endsWith(source)) {
      rawSnippet = rawSnippet.substring(0, rawSnippet.length - source.length).trim();
  }
  // Remove trailing "  " or " -"
  rawSnippet = rawSnippet.replace(/[\s\-]+$/, '');
  
  let snippet = (meta && meta.ogDesc) ? meta.ogDesc : rawSnippet.slice(0, 300);
  let title = (meta && meta.title) ? meta.title : (item.title || '');

  if (title && source && title.endsWith(` - ${source}`)) {
      title = title.substring(0, title.length - (` - ${source}`.length));
  }

  const faviconUrl = faviconFor(sourceUrl);

  const idBasis = [item.title || '', publishedAt || '', source || '', url.replace(/([?&]utm_[^=]+=[^&]+)/g,'')].join('|');
  const id = crypto.createHash('sha1').update(idBasis).digest('hex');

  return {
    id,
    title,
    url: finalLink,
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
    } catch (e) { console.error('Feed failed:', feedUrl, e.message); }
  }
  return allItems;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
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
    console.log("Fetching and parsing Google News feeds, extracting rich metadata...");
    const latest = sortDesc(dedupe(await fetchAll())).filter(i => i.title && i.title !== "Google News");

    const dataDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(path.join(dataDir, 'news.json'), JSON.stringify(latest, null, 2), 'utf8');

    const archivePath = path.join(dataDir, 'archive.json');
    let archive = [];
    if (fs.existsSync(archivePath)) {
      try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch {}
    }
    
    // Merge matching by ID, prefer newest scrape for updated meta
    const mergedMap = new Map();
    [...archive, ...latest].forEach(it => {
        if (!mergedMap.has(it.id)) {
            mergedMap.set(it.id, it);
        } else {
            // update existing if we have better data
            const existing = mergedMap.get(it.id);
            if (!existing.imageUrl && it.imageUrl) existing.imageUrl = it.imageUrl;
            if (!existing.source && it.source) existing.source = it.source;
            if (it.snippet && it.snippet.length > existing.snippet?.length) existing.snippet = it.snippet;
            mergedMap.set(it.id, existing);
        }
    });

    const merged = sortDesc(Array.from(mergedMap.values()));
    const pruned = pruneToLastYear(merged);

    fs.writeFileSync(archivePath, JSON.stringify(pruned, null, 2), 'utf8');

    console.log(`Latest: ${latest.length} items`);
    console.log(`Archive (≤365d): ${pruned.length} items`);
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
})();
