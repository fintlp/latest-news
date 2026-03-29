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
const BLOCKED_EXTRA   = ['arounddeal.com', 'ramp.com', 'rocketreach.co', 'apollo.io', 'zoominfo.com', 'scio.gov.cn'];
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

    meta.ogImage    = get([/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i, /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i]);
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

// ─── Fetch Google News RSS for one locale ────────────────────────────────────
const rssParser = new Parser({ timeout: 15000 });

async function fetchRssFeed(locale) {
  const feedUrl = makeRssUrl(locale);
  try {
    const feed = await rssParser.parseURL(feedUrl);
    return (feed.items || []).map(item => ({
      _source: 'rss',
      _locale: `${locale.gl}`,
      url: item.link || item.guid || '',
      title: item.title || '',
      description: item.contentSnippet || '',
      pubDate: item.isoDate || item.pubDate || null,
      rawItem: item,
    }));
  } catch (e) {
    console.warn(`  RSS failed [${locale.gl}]: ${e.message}`);
    return [];
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

  return { id, title, url: finalUrl, source, sourceUrl: '', faviconUrl: faviconFor(url), imageUrl: meta.ogImage || null, publishedAt, snippet };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  console.log('Fetching Peter Fintl news (Google RSS + Brave topics)...');
  const rawResults = [];

  // 1. Google News RSS — stagger requests to avoid hammering
  console.log(`  Fetching ${RSS_LOCALES.length} Google News RSS feeds...`);
  for (const locale of RSS_LOCALES) {
    process.stdout.write(`    [${locale.gl}] `);
    const items = await fetchRssFeed(locale);
    process.stdout.write(`${items.length} items\n`);
    rawResults.push(...items);
    await new Promise(r => setTimeout(r, 300)); // 300ms between requests
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
  const pruned = Array.from(mergedMap.values())
    .filter(i => (now - new Date(i.publishedAt).getTime()) <= RETAIN_DAYS * ONE_DAY_MS)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  fs.writeFileSync(path.join(dataDir, 'news.json'), JSON.stringify(latest, null, 2));
  fs.writeFileSync(archivePath, JSON.stringify(pruned, null, 2));
  console.log(`Done. Latest: ${latest.length} · Archive: ${pruned.length}`);
}

run().catch(err => { console.error(err); process.exit(1); });
