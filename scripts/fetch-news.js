const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const Parser = require('rss-parser');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_DAYS = 365;

// ─── Google News RSS locales ────────────────────────────────────────────────
// Covers global Peter Fintl mentions: English, German, Chinese (TW+CN), and other key markets
const RSS_LOCALES = [
  // English — primary coverage
  { hl: 'en-US', gl: 'US', ceid: 'US:en' },
  { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' },
  { hl: 'en-AU', gl: 'AU', ceid: 'AU:en' },
  // German — Austria, Germany, Switzerland (core market)
  { hl: 'de',    gl: 'AT', ceid: 'AT:de' },
  { hl: 'de',    gl: 'DE', ceid: 'DE:de' },
  { hl: 'de',    gl: 'CH', ceid: 'CH:de' },
  // Asia — Taiwan, China, Japan, Korea
  { hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' },
  { hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-Hans' },
  { hl: 'ja',    gl: 'JP', ceid: 'JP:ja' },
  { hl: 'ko',    gl: 'KR', ceid: 'KR:ko' },
  // Europe
  { hl: 'fr-FR', gl: 'FR', ceid: 'FR:fr' },
  { hl: 'it-IT', gl: 'IT', ceid: 'IT:it' },
  { hl: 'nl-NL', gl: 'NL', ceid: 'NL:nl' },
];

function makeRssUrl({ hl, gl, ceid }) {
  return `https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

// ─── Brave Search queries (topic-specific, NOT Peter Fintl name search) ─────
const BRAVE_TOPIC_QUERIES = [
  '"Chinese space launch systems"',
  '"low-cost flights to space" China',
  'China automotive AI 2026',
  'China EV five-year plan 2026',
];

const UTM = 'utm_source=linkedin&utm_medium=profile&utm_campaign=latest_news&utm_content=landing';

// ─── Load Brave API key ───────────────────────────────────────────────────────
let BRAVE_API_KEY = '';
if (process.env.BRAVE_API_KEY) {
  BRAVE_API_KEY = process.env.BRAVE_API_KEY;
  console.log('Brave API key loaded from environment variable');
} else {
  try {
    const secrets = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'secrets', 'brave_search.json'), 'utf8'
    ));
    BRAVE_API_KEY = secrets.apiKey;
    console.log('Brave API key loaded from local secrets file');
  } catch (e) {
    console.warn('Brave API key not found — topic queries will be skipped');
  }
}

// ─── Blocked domains/patterns ────────────────────────────────────────────────
const BLOCKED_DOMAINS = ['linkedin.com', 'x.com', 'twitter.com', 'facebook.com', 'xing.com'];
const BLOCKED_EXTRA   = ['arounddeal.com', 'ramp.com', 'rocketreach.co', 'apollo.io', 'zoominfo.com', 'scio.gov.cn', 'researchgate.net'];
const BLOCKED_URL_PATTERNS = [
  /\/in\/[a-z0-9\-]+\/?$/i,
  /\/profile\//i,
  /^https?:\/\/[^/]+\/?$/,
];

function isBlockedUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if ([...BLOCKED_DOMAINS, ...BLOCKED_EXTRA].some(d => host === d || host.endsWith('.' + d))) return true;
    if (BLOCKED_URL_PATTERNS.some(p => p.test(url))) return true;
  } catch (_) {}
  return false;
}

function canonicalUrl(u) {
  try {
    const parsed = new URL(u);
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(p => parsed.searchParams.delete(p));
    let s = parsed.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch (_) { return u; }
}

function faviconFor(url) {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`; }
  catch (_) { return null; }
}

function addUtm(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('utm_source')) {
      UTM.split('&').forEach(pair => { const [k, v] = pair.split('='); u.searchParams.set(k, v); });
    }
    return u.toString();
  } catch (_) { return url; }
}

function tryParseDate(val) {
  if (!val) return null;
  const d = new Date(String(val).trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── Outlet logo + domain map (from as-seen-in.json) ────────────────────────
const AS_SEEN_IN_PATH = path.join(__dirname, '..', 'data', 'as-seen-in.json');
// domain → logo  (for direct URL matching)
const OUTLET_LOGO_MAP = new Map();
// normalized-name → {logo, domain}  (for source-name matching)
const OUTLET_BY_SOURCE = new Map();

function normalizeSourceKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

try {
  const outlets = JSON.parse(fs.readFileSync(AS_SEEN_IN_PATH, 'utf8'));
  for (const outlet of outlets) {
    try {
      const host = new URL(outlet.url).hostname.replace(/^www\./, '');
      const faviconLogo = `https://www.google.com/s2/favicons?domain=${host}&sz=256`;
      const entry = { logo: faviconLogo, domain: host };
      OUTLET_LOGO_MAP.set(host, faviconLogo);
      // Index by normalized outlet name
      OUTLET_BY_SOURCE.set(normalizeSourceKey(outlet.name), entry);
      // Index by domain root (e.g. "handelsblatt" from "handelsblatt.com")
      const domainRoot = host.split('.')[0];
      if (domainRoot) OUTLET_BY_SOURCE.set(normalizeSourceKey(domainRoot), entry);
      // Index by explicit aliases (e.g. "sz.de", "dw", "faz")
      for (const alias of (outlet.aliases || [])) {
        OUTLET_BY_SOURCE.set(normalizeSourceKey(alias), entry);
        OUTLET_LOGO_MAP.set(alias.toLowerCase().replace(/^www\./, ''), clearbitLogo);
      }
    } catch (_) {}
  }
} catch (_) {}

// ─── Fetch OG meta + publish date from article page ─────────────────────────
async function fetchPageMeta(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let meta = { ogImage: null, ogDesc: null, title: null, publishedAt: null };
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return meta;
    const html = await res.text();

    const get = (patterns) => { for (const p of patterns) { const m = html.match(p); if (m?.[1]) return m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim(); } return null; };

    meta.ogImage    = get([
      /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
      /<meta[^>]+property=["']og:image:secure_url["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image:secure_url["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
      /<meta[^>]+property=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
    ]);
    // Resolve relative image URLs
    if (meta.ogImage && !meta.ogImage.startsWith('http')) {
      try { meta.ogImage = new URL(meta.ogImage, url).toString(); } catch (_) { meta.ogImage = null; }
    }
    meta.ogDesc     = get([/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i])?.replace(/<[^>]+>/g, '');
    meta.title      = get([/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i]);

    const dateCandidates = [
      /<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+itemprop=["']datePublished["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']date["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']pubdate["'][^>]*content=["']([^"']+)["']/i,
      /<time[^>]+datetime=["']([^"']+)["']/i,
    ];
    for (const p of dateCandidates) {
      const parsed = tryParseDate(html.match(p)?.[1]);
      if (parsed) { meta.publishedAt = parsed; break; }
    }
  } catch (_) {} finally { clearTimeout(t); }
  return meta;
}

// ─── Extract image URL from RSS item media fields ────────────────────────────
function extractRssImage(item) {
  // media:content url attribute
  const mc = item['media:content'] || item.mediaContent;
  if (mc) {
    const u = mc?.$ ? mc.$.url : (mc?.url || null);
    if (u && typeof u === 'string' && u.startsWith('http')) return u;
    // array of media:content elements
    if (Array.isArray(mc)) {
      for (const el of mc) {
        const eu = el?.$ ? el.$.url : (el?.url || null);
        if (eu && typeof eu === 'string' && eu.startsWith('http')) return eu;
      }
    }
  }
  // media:thumbnail url attribute
  const mt = item['media:thumbnail'] || item.mediaThumbnail;
  if (mt) {
    const u = mt?.$ ? mt.$.url : (mt?.url || null);
    if (u && typeof u === 'string' && u.startsWith('http')) return u;
  }
  // enclosure (image type)
  if (item.enclosure?.url && (item.enclosure.type || '').startsWith('image/')) return item.enclosure.url;
  return null;
}

// ─── Fetch Google News RSS for one locale ────────────────────────────────────
const rssParser = new Parser({
  timeout: 15000,
  customFields: {
    item: [
      ['media:content', 'media:content'],
      ['media:thumbnail', 'media:thumbnail'],
    ]
  }
});

async function fetchRssFeed(locale) {
  const feedUrl = makeRssUrl(locale);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(feedUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xmlText = await response.text();
    const feed = await rssParser.parseString(xmlText);
    return (feed.items || []).map(item => ({
      _source: 'rss',
      _locale: `${locale.gl}`,
      url: item.link || item.guid || '',
      title: item.title || '',
      description: item.contentSnippet || '',
      pubDate: item.isoDate || item.pubDate || null,
      rssImage: extractRssImage(item),
      rawItem: item,
    }));
  } catch (e) {
    console.warn(`  RSS failed [${locale.gl}]: ${e.message}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Brave topic search ───────────────────────────────────────────────────────
async function fetchBraveTopic(query) {
  if (!BRAVE_API_KEY) return [];
  console.log(`  [brave] ${query}`);
  const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=10`;
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY } });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return (data.results || []).map(r => ({
      _source: 'brave',
      _query: query,
      url: r.url,
      title: r.title || '',
      description: r.description || '',
      pubDate: r.age || null,
      rawItem: r,
    }));
  } catch (e) {
    console.warn(`  Brave failed: ${e.message}`);
    return [];
  }
}

// ─── Normalize a raw result into a card item ─────────────────────────────────
async function normalizeItem(raw) {
  const url = raw.url;
  // Don't fetch page meta for Google News redirect URLs — they block bots.
  // Only fetch for direct article URLs (Brave results).
  const isGoogleNewsUrl = url.includes('news.google.com');
  const meta = isGoogleNewsUrl ? { ogImage: null, ogDesc: null, title: null, publishedAt: null } : await fetchPageMeta(url);

  // Extract source name from Google News RSS content
  let source = '';
  if (raw._source === 'rss' && raw.rawItem?.content) {
    const m = raw.rawItem.content.match(/<font color=["']#6f6f6f["']>([^<]+)<\/font>/i);
    if (m) source = m[1].trim();
  }
  if (!source && raw.rawItem?.source) {
    source = typeof raw.rawItem.source === 'string' ? raw.rawItem.source : raw.rawItem.source?.title || '';
  }
  if (!source && raw.rawItem?.creator) source = raw.rawItem.creator;
  if (!source) {
    try { source = new URL(url).hostname.replace('www.', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); } catch (_) {}
  }

  const cleanSnippet = (s = '') => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  // Remove " - Source Name" suffix from title (Google News RSS format)
  let title = meta.title || raw.title || '';
  if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(` - ${source}`).length).trim();
  // Also strip trailing " - Source" where source might differ slightly
  title = title.replace(/\s+-\s+[\w\s\.\-]+$/, t => {
    // Only strip if what follows looks like a publication name (short, no lowercase start)
    const suffix = t.replace(/\s+-\s+/, '');
    return suffix.length < 40 ? '' : t;
  }).trim();

  const snippet = meta.ogDesc || cleanSnippet(raw.description);
  const publishedAt = meta.publishedAt || tryParseDate(raw.pubDate) || new Date().toISOString();
  const finalUrl = addUtm(url);

  const idBasis = [title, source, canonicalUrl(url)].join('|');
  const id = crypto.createHash('sha1').update(idBasis).digest('hex');

  // ── Image priority: og/twitter scrape → RSS media → outlet logo → favicon ──
  let imageUrl = meta.ogImage || raw.rssImage || null;

  // Real article domain (may differ from news.google.com redirect URL)
  let articleDomain = null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host !== 'news.google.com') articleDomain = host;
  } catch (_) {}

  // Outlet logo — try article domain, then source name, then domain extracted from source
  if (!imageUrl) {
    const sourceDomainForLogo = source.match(/([a-z0-9][a-z0-9\-]+\.[a-z]{2,4})$/i)?.[1]?.toLowerCase();
    const logo =
      (articleDomain && OUTLET_LOGO_MAP.get(articleDomain)) ||
      OUTLET_BY_SOURCE.get(normalizeSourceKey(source))?.logo ||
      (sourceDomainForLogo && OUTLET_LOGO_MAP.get(sourceDomainForLogo)) ||
      null;
    if (logo) imageUrl = logo;
  }

  // Favicon fallback — prefer real article domain derived from source name
  if (!imageUrl) {
    // Extract trailing domain from source (e.g. "TVS tvsvizzera.it" → "tvsvizzera.it")
    // Only accept TLDs of 2–4 chars (covers .de .com .info but not .Briefings)
    const sourceDomainMatch = source.match(/([a-z0-9][a-z0-9\-]+\.[a-z]{2,4})$/i);
    const sourceDomain = sourceDomainMatch ? sourceDomainMatch[1].toLowerCase() : null;
    // Or look up known outlet domain
    const knownDomain = OUTLET_BY_SOURCE.get(normalizeSourceKey(source))?.domain || null;
    const faviconDomain = articleDomain || sourceDomain || knownDomain;
    if (faviconDomain) {
      imageUrl = `https://www.google.com/s2/favicons?domain=${faviconDomain}&sz=256`;
    }
  }

  // Final fallback: favicon of whatever URL we have
  if (!imageUrl) {
    try { imageUrl = `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=256`; } catch (_) {}
  }

  return { id, title, url: finalUrl, source, sourceUrl: '', faviconUrl: faviconFor(url), imageUrl, publishedAt, snippet };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  console.log('Fetching Peter Fintl news (Google RSS + Brave topics)...');
  const rawResults = [];

  // 1. Google News RSS — concurrent with limit
  console.log(`  Fetching ${RSS_LOCALES.length} Google News RSS feeds...`);
  const concurrency = 3;
  for (let i = 0; i < RSS_LOCALES.length; i += concurrency) {
    const chunk = RSS_LOCALES.slice(i, i + concurrency);
    const promises = chunk.map(async locale => {
      const items = await fetchRssFeed(locale);
      console.log(`    [${locale.gl}] ${items.length} items`);
      return items;
    });
    const results = await Promise.allSettled(promises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        rawResults.push(...result.value);
      }
    }
    if (i + concurrency < RSS_LOCALES.length) {
      await new Promise(r => setTimeout(r, 300)); // small delay between chunks
    }
  }

  // 2. Brave topic queries
  console.log('  Fetching topic queries via Brave...');
  for (const query of BRAVE_TOPIC_QUERIES) {
    const items = await fetchBraveTopic(query);
    rawResults.push(...items);
  }

  // 3. Filter — all results must either be from RSS (already filtered by "Peter Fintl" query)
  // or mention "fintl" if from Brave (except dedicated topic queries like space articles)
  const TOPIC_ONLY = ['"Chinese space launch systems"', '"low-cost flights to space" China'];
  const filtered = rawResults.filter(r => {
    if (!r.url || isBlockedUrl(r.url)) return false;
    if (r._source === 'brave') {
      if (!TOPIC_ONLY.includes(r._query)) {
        const text = ((r.title || '') + ' ' + (r.description || '')).toLowerCase();
        if (!text.includes('fintl')) return false;
      }
    }
    return true;
  });
  console.log(`  ${rawResults.length} raw → ${filtered.length} after filtering`);

  // 4. Normalize (batch of 8, skip page meta for Google News URLs to stay fast)
  const normalized = [];
  for (let i = 0; i < filtered.length; i += 8) {
    const batch = filtered.slice(i, i + 8);
    const results = await Promise.all(batch.map(r => normalizeItem(r)));
    normalized.push(...results.filter(r => r.title && r.title !== 'Google News'));
  }

  // 5. Dedupe by canonical URL then by title
  const seenUrls = new Set();
  const seenTitles = new Set();
  const uniqueItems = [];
  for (const item of normalized) {
    const cu = canonicalUrl(item.url).toLowerCase();
    const ct = item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '').slice(0, 60); // include CJK chars
    if (seenUrls.has(cu) || seenTitles.has(ct)) continue;
    seenUrls.add(cu);
    seenTitles.add(ct);
    uniqueItems.push(item);
  }

  const latest = uniqueItems.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // 6. Merge with archive + manual overrides
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const overridesPath = path.join(dataDir, 'manual-overrides.json');
  let overrides = [];
  if (fs.existsSync(overridesPath)) {
    try { overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8')); } catch {}
  }
  overrides = overrides.map(o => {
    if (!o.id) o.id = crypto.createHash('sha1').update(o.url + (o.title || '')).digest('hex');
    return { ...o, manually_added: true };
  });

  const archivePath = path.join(dataDir, 'archive.json');
  let archive = [];
  if (fs.existsSync(archivePath)) {
    try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch {}
  }

  const mergedMap = new Map();
  archive.forEach(it => mergedMap.set(it.id, it));
  latest.forEach(it => { if (!mergedMap.get(it.id)?.manually_added) mergedMap.set(it.id, it); });
  overrides.forEach(o => mergedMap.set(o.id, o));

  const now = Date.now();
  const seenArchiveTitles = new Set();
  const pruned = Array.from(mergedMap.values())
    .filter(i => (now - new Date(i.publishedAt).getTime()) <= RETAIN_DAYS * ONE_DAY_MS)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .filter(i => {
      if (i.manually_added) return true; // always keep manual overrides
      const key = (i.title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '').slice(0, 60);
      if (!key || seenArchiveTitles.has(key)) return false;
      seenArchiveTitles.add(key);
      return true;
    });

  fs.writeFileSync(path.join(dataDir, 'news.json'), JSON.stringify(latest, null, 2));
  fs.writeFileSync(archivePath, JSON.stringify(pruned, null, 2));
  console.log(`Done. Latest: ${latest.length} · Archive: ${pruned.length}`);
}

function runWithTimeout(ms) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Script timed out after ${ms}ms`));
    }, ms);
    run().then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

runWithTimeout(180000).catch(err => { console.error(err); process.exit(1); });
