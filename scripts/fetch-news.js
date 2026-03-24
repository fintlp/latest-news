const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_DAYS = 365;

// Load Brave Search API Key from secrets
let BRAVE_API_KEY = '';
try {
  const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'secrets', 'brave_search.json'), 'utf8'));
  BRAVE_API_KEY = secrets.apiKey;
} catch (e) {
  console.error('Failed to load Brave API key:', e.message);
  process.exit(1);
}

const SEARCH_QUERIES = [
  '"Peter Fintl"',
  '"Chinese space launch systems"',
  '"low-cost flights to space" China',
  'automotive AI "Peter Fintl"'
];

const UTM = 'utm_source=linkedin&utm_medium=profile&utm_campaign=latest_news&utm_content=landing';

async function fetchFromBrave(query) {
  console.log(`Searching Brave for: ${query}`);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
  
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY
      }
    });
    if (!res.ok) throw new Error(`Brave API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return data.web?.results || [];
  } catch (e) {
    console.error(`Search failed for "${query}":`, e.message);
    return [];
  }
}

function faviconFor(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=128`;
  } catch (_) { return null; }
}

async function fetchFinalMeta(itemUrl) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let meta = { ogImage: null, ogDesc: null, title: null };
  try {
    const res = await fetch(itemUrl, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      const html = await res.text();
      const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i) || 
                     html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i);
      const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);

      if (ogImage) meta.ogImage = ogImage[1].replace(/&amp;/g, '&');
      if (ogDesc) meta.ogDesc = ogDesc[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      if (ogTitle) meta.title = ogTitle[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    }
  } catch (e) {} finally { clearTimeout(t); }
  return meta;
}

async function normalizeItem(result) {
  const url = result.url;
  const meta = await fetchFinalMeta(url);
  
  let finalLink = url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('utm_source')) {
      UTM.split('&').forEach(pair => { const [k, v] = pair.split('='); u.searchParams.set(k, v); });
    }
    finalLink = u.toString();
  } catch (_) {}

  const source = result.profile?.name || (new URL(url)).hostname.replace('www.', '');
  const publishedAt = result.page_age || new Date().toISOString();
  
  const idBasis = [result.title, source, url].join('|');
  const id = crypto.createHash('sha1').update(idBasis).digest('hex');

  return {
    id,
    title: meta.title || result.title,
    url: finalLink,
    source: source,
    sourceUrl: result.profile?.url || new URL(url).origin,
    faviconUrl: faviconFor(url),
    imageUrl: meta.ogImage || null,
    publishedAt: publishedAt,
    snippet: meta.ogDesc || result.description
  };
}

async function run() {
  console.log("Fetching news via Brave Search API...");
  const rawResults = [];
  for (const query of SEARCH_QUERIES) {
    const results = await fetchFromBrave(query);
    rawResults.push(...results);
  }

  const normalized = [];
  for (const res of rawResults) {
    normalized.push(await normalizeItem(res));
  }

  // Dedupe and Sort
  const uniqueMap = new Map();
  normalized.forEach(item => {
    if (!uniqueMap.has(item.id)) uniqueMap.set(item.id, item);
  });
  
  const latest = Array.from(uniqueMap.values()).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'news.json'), JSON.stringify(latest, null, 2));

  const archivePath = path.join(dataDir, 'archive.json');
  let archive = [];
  if (fs.existsSync(archivePath)) {
    try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch {}
  }

  const mergedMap = new Map();
  [...archive, ...latest].forEach(it => mergedMap.set(it.id, it));
  
  const now = Date.now();
  const pruned = Array.from(mergedMap.values())
    .filter(i => (now - new Date(i.publishedAt).getTime()) <= RETAIN_DAYS * ONE_DAY_MS)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  fs.writeFileSync(archivePath, JSON.stringify(pruned, null, 2));

  console.log(`Brave fetch complete. Latest: ${latest.length}, Archive: ${pruned.length}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
