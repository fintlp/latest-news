'use strict';

/**
 * download-linkedin-article-images.js
 *
 * For LinkedIn posts that have no image/video/document but contain a URL
 * in the post text, this script:
 *   1. Resolves the URL (follows lnkd.in redirects)
 *   2. Fetches the article page and extracts the og:image
 *   3. Downloads the image to assets/linkedin-articles/
 *   4. Updates data/linkedin-posts.json with the local path
 *
 * Usage:  node scripts/download-linkedin-article-images.js
 * Idempotent — already-processed posts are skipped.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const url   = require('url');

const JSON_PATH  = path.join(__dirname, '..', 'data', 'linkedin-posts.json');
const IMG_DIR    = path.join(__dirname, '..', 'assets', 'linkedin-articles');
const LOCAL_BASE = 'assets/linkedin-articles';

const CONCURRENCY = 3;
const DELAY_MS    = 300;
const MAX_REDIRECTS = 8;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                'Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─── URL helpers ──────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s)"<>]+/g;

function cleanUrl(u) {
  return u.replace(/[)\].,;!?'"]+$/, '').trim();
}

function extractFirstUrl(text) {
  const matches = text.match(URL_RE);
  if (!matches) return null;
  const cleaned = matches.map(cleanUrl).filter(u => {
    // Skip LinkedIn profile/post URLs — those don't have article OG images
    return !u.includes('linkedin.com/in/') && !u.includes('linkedin.com/posts/');
  });
  return cleaned[0] || null;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function get(reqUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(reqUrl); } catch { return reject(new Error(`Invalid URL: ${reqUrl}`)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(reqUrl, { headers: HEADERS }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, reqUrl).href;
        return get(next, redirectCount + 1).then(resolve).catch(reject);
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function resolveUrl(shortUrl, redirectCount = 0) {
  // Follow redirects recursively, returning the final URL.
  // (res.req is not reliably available in all Node versions, so we track
  //  the URL ourselves through the redirect chain instead.)
  if (redirectCount > MAX_REDIRECTS) return shortUrl;
  const res = await new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(shortUrl); } catch { return reject(new Error(`Invalid URL: ${shortUrl}`)); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(shortUrl, { headers: HEADERS }, resolve);
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
  res.resume();
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
    const next = res.headers.location.startsWith('http')
      ? res.headers.location
      : new URL(res.headers.location, shortUrl).href;
    return resolveUrl(next, redirectCount + 1);
  }
  return shortUrl; // no redirect — this IS the final URL
}

async function fetchHtml(pageUrl) {
  return new Promise(async (resolve, reject) => {
    let res;
    try { res = await get(pageUrl); } catch (e) { return reject(e); }

    if (res.statusCode !== 200) {
      res.resume();
      return reject(new Error(`HTTP ${res.statusCode}`));
    }

    // Only read up to 64 KB — og:image is always in <head>
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      if (buf.length > 65536) { res.destroy(); resolve(buf); }
    });
    res.on('end', () => resolve(buf));
    res.on('error', reject);
  });
}

function extractOgImage(html, baseUrl) {
  // og:image
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (m) return resolveImageUrl(m[1], baseUrl);

  // twitter:image fallback
  m = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (m) return resolveImageUrl(m[1], baseUrl);

  return null;
}

function resolveImageUrl(imgUrl, baseUrl) {
  if (!imgUrl) return null;
  // Decode HTML entities
  imgUrl = imgUrl.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').trim();
  if (imgUrl.startsWith('//')) return 'https:' + imgUrl;
  if (imgUrl.startsWith('http')) return imgUrl;
  try { return new URL(imgUrl, baseUrl).href; } catch { return null; }
}

function extFromUrl(imgUrl, ct) {
  if (ct) {
    if (ct.includes('png'))  return '.png';
    if (ct.includes('gif'))  return '.gif';
    if (ct.includes('webp')) return '.webp';
    if (ct.includes('svg'))  return '.svg';
    return '.jpg';
  }
  const p = imgUrl.split('?')[0];
  const e = path.extname(p).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(e) ? e : '.jpg';
}

async function downloadImage(imgUrl, destBase) {
  return new Promise(async (resolve, reject) => {
    let res;
    try { res = await get(imgUrl); } catch (e) { return reject(e); }

    if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }

    const ext  = extFromUrl(imgUrl, res.headers['content-type']);
    const dest = destBase + ext;
    const out  = fs.createWriteStream(dest);
    res.pipe(out);
    out.on('finish', () => out.close(() => resolve(dest)));
    out.on('error', reject);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function processPost(post) {
  const rawUrl = extractFirstUrl(post.text || '');
  if (!rawUrl) return { status: 'no-url' };

  // Already has a local article image — still resolve URL for articleUrl
  const destBase = path.join(IMG_DIR, `${post.id}-article`);
  const existing = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].find(e =>
    fs.existsSync(destBase + e)
  );
  if (existing) {
    // Resolve the article URL even for already-downloaded images
    let articleUrl = null;
    try {
      const resolved = await resolveUrl(rawUrl);
      if (!resolved.includes('linkedin.com')) articleUrl = resolved;
    } catch { /* ignore */ }
    return { status: 'skip', localPath: `${LOCAL_BASE}/${post.id}-article${existing}`, articleUrl };
  }

  // Resolve lnkd.in → final URL
  let finalUrl = rawUrl;
  try {
    finalUrl = await resolveUrl(rawUrl);
    // Skip if still pointing to LinkedIn (requires login to scrape)
    if (finalUrl.includes('linkedin.com')) {
      return { status: 'skip-linkedin', url: finalUrl };
    }
  } catch (e) {
    return { status: 'error-resolve', msg: e.message, url: rawUrl };
  }

  // Fetch HTML and extract og:image
  let html;
  try { html = await fetchHtml(finalUrl); }
  catch (e) { return { status: 'error-fetch', msg: e.message, url: finalUrl }; }

  const ogImg = extractOgImage(html, finalUrl);
  if (!ogImg) return { status: 'no-og-image', url: finalUrl };

  // Download image
  try {
    const localFile = await downloadImage(ogImg, destBase);
    const localPath = `${LOCAL_BASE}/${path.basename(localFile)}`;
    return { status: 'ok', localPath, articleUrl: finalUrl };
  } catch (e) {
    return { status: 'error-download', msg: e.message, url: ogImg };
  }
}

async function main() {
  fs.mkdirSync(IMG_DIR, { recursive: true });

  const posts = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  // Target: posts with a URL in text that need image download OR articleUrl resolution
  const targets = posts.filter(p => {
    URL_RE.lastIndex = 0;
    return URL_RE.test(p.text || '') && !p.articleUrl;
  });
  URL_RE.lastIndex = 0;

  console.log(`Posts to process: ${targets.length}`);

  const results = { ok: 0, skip: 0, noOg: 0, error: 0, linkedIn: 0 };

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(batch.map(p => processPost(p)));

    outcomes.forEach((out, j) => {
      const post = batch[j];
      switch (out.status) {
        case 'ok':
          // Only use article image if the post has no other image
          if (!post.imageUrl) {
            post.imageUrl   = out.localPath;
            post.imageUrls  = [out.localPath];
          }
          if (out.articleUrl) post.articleUrl = out.articleUrl;
          results.ok++;
          console.log(`  ✓ ${post.id}  ${out.localPath}`);
          break;
        case 'skip':
          if (!post.imageUrl) {
            post.imageUrl   = out.localPath;
            post.imageUrls  = [out.localPath];
          }
          if (out.articleUrl) post.articleUrl = out.articleUrl;
          results.skip++;
          break;
        case 'skip-linkedin':
          results.linkedIn++;
          break;
        case 'no-og-image':
          results.noOg++;
          console.log(`  – no og:image  ${out.url?.slice(0, 70)}`);
          break;
        default:
          results.error++;
          console.log(`  ✗ ${out.status}  ${out.msg}  ${(out.url||'').slice(0, 60)}`);
      }
    });

    if (i + CONCURRENCY < targets.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nDone — ok:${results.ok} skipped:${results.skip} no-og:${results.noOg} linkedin:${results.linkedIn} errors:${results.error}`);

  fs.writeFileSync(JSON_PATH, JSON.stringify(posts, null, 2), 'utf8');
  console.log('data/linkedin-posts.json updated.');
}

main().catch(e => { console.error(e); process.exit(1); });
