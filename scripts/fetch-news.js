const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_DAYS = 365;

// Domains to exclude (login walls, profile pages, homepages — not articles)
const BLOCKED_DOMAINS = [
  'linkedin.com', 'x.com', 'twitter.com', 'facebook.com',
  'researchgate.net', 'xing.com'
];

// URL patterns that indicate non-article pages
const BLOCKED_URL_PATTERNS = [
  /\/in\/[a-z0-9\-]+\/?$/i,       // LinkedIn profiles
  /\/profile\//i,                   // generic profile pages
  /^https?:\/\/[^/]+\/?$/,          // bare homepages
];

// Load Brave Search API Key
let BRAVE_API_KEY = '';
try {
  const secrets = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'secrets', 'brave_search.json'), 'utf8'
  ));
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

function isBlockedUrl(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, '');
    if (BLOCKED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) return true;
    if (BLOCKED_URL_PATTERNS.some(p => p.test(url))) return true;
  } catch (_) {}
  return false;
}

async function fetchFromBrave(query) {
  console.log(`  Searching: ${query}`);
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
    console.error(`  Search failed: ${e.message}`);
    return [];
  }
}

function faviconFor(url) {
  try {
    const u = new URL(url);
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
      const ogDesc  = html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
                  || html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i);
      const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
      if (ogImage) meta.ogImage = ogImage[1].replace(/&amp;/g, '&');
      if (ogDesc)  meta.ogDesc  = ogDesc[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/<[^>]+>/g, '');
      if (ogTitle) meta.title   = ogTitle[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    }
  } catch (_) {} finally { clearTimeout(t); }
  return meta;
}

// Parse Brave's page_age field to ISO date string
function parsePublishedAt(result) {
  // Brave returns page_age as ISO or human-readable
  const raw = result.page_age || result.extra_snippets?.[0] || null;
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

async function normalizeItem(result) {
  const url = result.url;

  // Add UTM params
  let finalLink = url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('utm_source')) {
      UTM.split('&').forEach(pair => { const [k, v] = pair.split('='); u.searchParams.set(k, v); });
    }
    finalLink = u.toString();
  } catch (_) {}

  const meta = await fetchFinalMeta(url);

  const rawSource = result.profile?.name || new URL(url).hostname.replace('www.', '');
  const source = rawSource.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Clean snippet — strip HTML entities and tags
  const rawSnippet = (result.description || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ').trim();
  const snippet = meta.ogDesc || rawSnippet;

  const publishedAt = parsePublishedAt(result) || new Date().toISOString();

  const idBasis = [result.title, source, url.replace(/([?&]utm_[^=&]+=[^&]*)/g, '')].join('|');
  const id = crypto.createHash('sha1').update(idBasis).digest('hex');

  return {
    id,
    title: meta.title || result.title,
    url: finalLink,
    source,
    sourceUrl: result.profile?.url || new URL(url).origin,
    faviconUrl: faviconFor(url),
    imageUrl: meta.ogImage || null,
    publishedAt,
    snippet
  };
}

async function run() {
  console.log('Fetching news via Brave Search API...');

  const rawResults = [];
  for (const query of SEARCH_QUERIES) {
    const results = await fetchFromBrave(query);
    rawResults.push(...results);
  }

  // Filter out blocked domains/profiles
  const filtered = rawResults.filter(r => !isBlockedUrl(r.url));
  console.log(`  ${rawResults.length} raw results → ${filtered.length} after filtering`);

  // Normalize (fetch meta in parallel, max 5 at a time)
  const normalized = [];
  const chunks = [];
  for (let i = 0; i < filtered.length; i += 5) chunks.push(filtered.slice(i, i + 5));
  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(r => normalizeItem(r)));
    normalized.push(...results);
  }

  // Dedupe by ID
  const uniqueMap = new Map();
  normalized.forEach(item => {
    if (!uniqueMap.has(item.id)) uniqueMap.set(item.id, item);
  });

  const latest = Array.from(uniqueMap.values())
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Merge with archive (preserve manually_added items)
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const archivePath = path.join(dataDir, 'archive.json');
  let archive = [];
  if (fs.existsSync(archivePath)) {
    try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch {}
  }

  // Build merged map — latest takes priority, but preserve manually_added flag
  const mergedMap = new Map();
  archive.forEach(it => mergedMap.set(it.id, it));
  latest.forEach(it => {
    const existing = mergedMap.get(it.id);
    if (existing && existing.manually_added) {
      // Keep manual entry but update meta if we have better data
      mergedMap.set(it.id, { ...it, manually_added: true });
    } else {
      mergedMap.set(it.id, it);
    }
  });

  const now = Date.now();
  const pruned = Array.from(mergedMap.values())
    .filter(i => (now - new Date(i.publishedAt).getTime()) <= RETAIN_DAYS * ONE_DAY_MS)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  fs.writeFileSync(path.join(dataDir, 'news.json'), JSON.stringify(latest, null, 2));
  fs.writeFileSync(archivePath, JSON.stringify(pruned, null, 2));

  console.log(`Done. Latest: ${latest.length} · Archive: ${pruned.length}`);
}

run().catch(err => { console.error(err); process.exit(1); });
