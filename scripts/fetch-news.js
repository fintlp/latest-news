const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_DAYS = 365;

// Domains to exclude (login walls, profile pages, homepages — not articles)
const BLOCKED_DOMAINS = [
  'linkedin.com', 'x.com', 'twitter.com', 'facebook.com',
  'xing.com'
];

// URL patterns that indicate non-article pages
const BLOCKED_URL_PATTERNS = [
  /\/in\/[a-z0-9\-]+\/?$/i,       // LinkedIn profiles
  /\/profile\//i,                   // generic profile pages
  /^https?:\/\/[^/]+\/?$/,          // bare homepages
];

// Domains that are known sources for Peter — pass even without "fintl" in snippet
const TRUSTED_DOMAINS = [
  'capgemini.com', 'capgemini-engineering.com', 'table.media', 'table.briefings',
  'firmenauto.de', 'automobilwoche.de', 'handelsblatt.com', 'faz.net',
  'sueddeutsche.de', 'spiegel.de', 'stern.de', 'focus.de', 'heise.de',
  'elektroauto-news.net', 'a3ps.at', 'car-symposium.com', 'iaa-transportation.com',
  'directindustry.com', 'automotive-iq.com', 'bosch.com',
  'researchgate.net', 'youtube.com', 'futurezone.at',
];

// Domains to always block (garbage/scraper sites)
const BLOCKED_EXTRA_DOMAINS = ['arounddeal.com', 'ramp.com', 'rocketreach.co', 'apollo.io', 'zoominfo.com', 'english.scio.gov.cn', 'scio.gov.cn'];

const TOPIC_ONLY_QUERIES = ['"Chinese space launch systems"', '"low-cost flights to space" China'];

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

// Web search queries (broad coverage)
const WEB_QUERIES = [
  '"Peter Fintl"',
  '"Peter Fintl" Capgemini',
  '"Peter Fintl" automotive',
  '"Peter Fintl" interview',
  '"Peter Fintl" China',
  '"Peter Fintl" Elektroauto',
  '"Peter Fintl" KI',
  '"Peter Fintl" innovation',
];

// News-specific queries (recent press coverage)
const NEWS_QUERIES = [
  '"Peter Fintl"',
  '"Peter Fintl" Capgemini',
  '"Chinese space launch systems"',
  '"low-cost flights to space" China',
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

async function fetchFromBrave(query, { endpoint = 'web', offset = 0 } = {}) {
  const label = endpoint === 'news' ? 'news' : `web+${offset}`;
  console.log(`  [${label}] ${query}`);
  const base = endpoint === 'news'
    ? 'https://api.search.brave.com/res/v1/news/search'
    : 'https://api.search.brave.com/res/v1/web/search';
  const url = `${base}?q=${encodeURIComponent(query)}&count=20${offset ? `&offset=${offset}` : ''}`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    // News endpoint returns data.results, web returns data.web.results
    return data.results || data.web?.results || [];
  } catch (e) {
    console.error(`  Search failed [${label}] "${query}": ${e.message}`);
    return [];
  }
}

function faviconFor(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=128`;
  } catch (_) { return null; }
}

// Try to parse a date string — returns ISO string or null
function tryParseDate(val) {
  if (!val) return null;
  const d = new Date(val.trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchFinalMeta(itemUrl) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let meta = { ogImage: null, ogDesc: null, title: null, publishedAt: null };
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

      // Try all common publish date meta tags, in priority order
      const dateCandidates = [
        html.match(/<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i),
        html.match(/<meta[^>]+name=["']article:published_time["'][^>]*content=["']([^"']+)["']/i),
        html.match(/<meta[^>]+property=["']og:article:published_time["'][^>]*content=["']([^"']+)["']/i),
        html.match(/<meta[^>]+name=["']date["'][^>]*content=["']([^"']+)["']/i),
        html.match(/<meta[^>]+name=["']pubdate["'][^>]*content=["']([^"']+)["']/i),
        html.match(/<meta[^>]+itemprop=["']datePublished["'][^>]*content=["']([^"']+)["']/i),
        html.match(/<time[^>]+datetime=["']([^"']+)["']/i),
      ];
      for (const m of dateCandidates) {
        const parsed = tryParseDate(m?.[1]);
        if (parsed) { meta.publishedAt = parsed; break; }
      }
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

  // Source: news endpoint uses source.name; web uses profile.name or hostname
  const rawSource = result.source?.name || result.profile?.name
    || result.meta_url?.hostname?.replace('www.', '')
    || new URL(url).hostname.replace('www.', '');
  const source = rawSource.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Clean snippet — strip HTML entities and tags
  const rawSnippet = (result.description || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ').trim();
  const snippet = meta.ogDesc || rawSnippet;

  // Priority: page meta tags > Brave age (news endpoint) > Brave page_age (web) > fallback to today
  const braveDate = result.age || null;
  const publishedAt = meta.publishedAt || tryParseDate(braveDate) || parsePublishedAt(result) || new Date().toISOString();

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

  // Web search: all queries, 2 pages each (0-19, 20-39)
  for (const query of WEB_QUERIES) {
    const p1 = await fetchFromBrave(query, { endpoint: 'web', offset: 0 });
    p1.forEach(r => r._query = query);
    rawResults.push(...p1);
    if (p1.length === 20) {
      const p2 = await fetchFromBrave(query, { endpoint: 'web', offset: 20 });
      p2.forEach(r => r._query = query);
      rawResults.push(...p2);
    }
  }

  // News search: dedicated news endpoint for freshest articles
  for (const query of NEWS_QUERIES) {
    const news = await fetchFromBrave(query, { endpoint: 'news' });
    news.forEach(r => r._query = query);
    rawResults.push(...news);
  }

  // Filter results
  const filtered = rawResults.filter(r => {
    if (isBlockedUrl(r.url)) return false;
    // Block extra garbage domains
    try {
      const host = new URL(r.url).hostname.replace('www.', '');
      if (BLOCKED_EXTRA_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return false;
    } catch (_) {}
    // Topic-only queries (space etc.) pass without name check
    if (TOPIC_ONLY_QUERIES.some(q => r._query === q)) return true;
    // Trusted domains pass even without "fintl" in snippet
    try {
      const host = new URL(r.url).hostname.replace('www.', '');
      if (TRUSTED_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return true;
    } catch (_) {}
    // Otherwise require "fintl" in title or description
    const text = ((r.title || '') + ' ' + (r.description || '')).toLowerCase();
    return text.includes('fintl');
  });
  console.log(`  ${rawResults.length} raw results → ${filtered.length} after filtering`);

  // Normalize (fetch meta in parallel, max 5 at a time)
  const normalized = [];
  const chunks = [];
  for (let i = 0; i < filtered.length; i += 5) chunks.push(filtered.slice(i, i + 5));
  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(r => normalizeItem(r)));
    normalized.push(...results);
  }

  // Helper: strip UTM params + trailing slash → canonical URL for dedup
  function canonicalUrl(u) {
    try {
      const parsed = new URL(u);
      ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(p => parsed.searchParams.delete(p));
      let s = parsed.toString();
      if (s.endsWith('/')) s = s.slice(0, -1);
      return s.toLowerCase();
    } catch (_) { return u.toLowerCase(); }
  }

  // Dedupe: by canonical URL first, then by normalized title
  const seenUrls = new Set();
  const seenTitles = new Set();
  const uniqueItems = [];
  for (const item of normalized) {
    const cu = canonicalUrl(item.url);
    const ct = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seenUrls.has(cu) || seenTitles.has(ct)) continue;
    seenUrls.add(cu);
    seenTitles.add(ct);
    uniqueItems.push(item);
  }

  const latest = uniqueItems
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Load manual overrides — these always win and are never deleted by fetches
  const overridesPath = path.join(dataDir, 'manual-overrides.json');
  let overrides = [];
  if (fs.existsSync(overridesPath)) {
    try { overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8')); } catch {}
  }
  // Ensure all overrides have manually_added flag + a stable ID
  overrides = overrides.map(o => {
    if (!o.id) o.id = crypto.createHash('sha1').update(o.url + (o.title || '')).digest('hex');
    return { ...o, manually_added: true };
  });

  // Load existing archive
  const archivePath = path.join(dataDir, 'archive.json');
  let archive = [];
  if (fs.existsSync(archivePath)) {
    try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch {}
  }

  // Build merged map: archive base → latest updates → manual overrides always on top
  const mergedMap = new Map();
  archive.forEach(it => mergedMap.set(it.id, it));
  latest.forEach(it => {
    const existing = mergedMap.get(it.id);
    // Don't overwrite manually_added entries with auto-fetched ones
    if (existing?.manually_added) return;
    mergedMap.set(it.id, it);
  });
  // Manual overrides always win (keyed by their ID so they can be updated)
  overrides.forEach(o => mergedMap.set(o.id, o));

  const now = Date.now();
  const pruned = Array.from(mergedMap.values())
    .filter(i => (now - new Date(i.publishedAt).getTime()) <= RETAIN_DAYS * ONE_DAY_MS)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  fs.writeFileSync(path.join(dataDir, 'news.json'), JSON.stringify(latest, null, 2));
  fs.writeFileSync(archivePath, JSON.stringify(pruned, null, 2));

  console.log(`Done. Latest: ${latest.length} · Archive (with overrides): ${pruned.length}`);
}

run().catch(err => { console.error(err); process.exit(1); });
