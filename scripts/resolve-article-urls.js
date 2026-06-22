'use strict';

/**
 * resolve-article-urls.js
 *
 * Resolves lnkd.in shortlinks stored as articleUrl to their final destinations.
 * Safe to run multiple times — already-resolved URLs are skipped.
 *
 * Usage:  node scripts/resolve-article-urls.js
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const JSON_PATH    = path.join(__dirname, '..', 'data', 'linkedin-posts.json');
const MAX_REDIRECTS = 8;
const CONCURRENCY   = 5;
const DELAY_MS      = 150;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
};

async function resolveUrl(shortUrl, redirectCount = 0) {
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
  return shortUrl;
}

async function main() {
  const posts = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  const targets = posts.filter(p =>
    (p.articleUrl || '').startsWith('https://lnkd.in') ||
    (p.articleUrl || '').startsWith('http://lnkd.in')
  );

  console.log(`lnkd.in shortlinks to resolve: ${targets.length}`);
  if (!targets.length) { console.log('Nothing to do.'); return; }

  const results = { resolved: 0, linkedin: 0, failed: 0 };

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async post => {
      try {
        const final = await resolveUrl(post.articleUrl);
        if (final === post.articleUrl) {
          // Redirect led back to same URL — lnkd.in may be blocking
          results.failed++;
          process.stdout.write('?');
        } else if (final.includes('linkedin.com')) {
          // LinkedIn article/post — keep shortlink (requires login to be useful)
          results.linkedin++;
          process.stdout.write('L');
        } else {
          post.articleUrl = final;
          results.resolved++;
          process.stdout.write('.');
        }
      } catch (e) {
        results.failed++;
        process.stdout.write('x');
      }
    }));

    // Progress line break every 50 items
    if ((i + CONCURRENCY) % 50 === 0) process.stdout.write('\n');

    if (i + CONCURRENCY < targets.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\n\nResolved: ${results.resolved}  LinkedIn (kept): ${results.linkedin}  Failed: ${results.failed}`);

  fs.writeFileSync(JSON_PATH, JSON.stringify(posts, null, 2), 'utf8');
  console.log('data/linkedin-posts.json updated.');
}

main().catch(e => { console.error(e); process.exit(1); });
