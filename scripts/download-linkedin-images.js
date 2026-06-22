'use strict';

/**
 * download-linkedin-images.js
 *
 * Downloads all LinkedIn post images to assets/linkedin-images/
 * and rewrites imageUrl / imageUrls in data/linkedin-posts.json
 * to use local paths.
 *
 * Usage:  node scripts/download-linkedin-images.js
 *
 * Idempotent — already-downloaded files are skipped.
 * Run this before the CDN tokens expire (check expiry in the URLs).
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const url     = require('url');

const JSON_PATH  = path.join(__dirname, '..', 'data', 'linkedin-posts.json');
const IMG_DIR    = path.join(__dirname, '..', 'assets', 'linkedin-images');
const LOCAL_BASE = 'assets/linkedin-images'; // path used in JSON

const CONCURRENCY = 5;   // parallel downloads
const DELAY_MS    = 100; // ms between batches (be polite)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extFromContentType(ct) {
  if (!ct) return '.jpg';
  if (ct.includes('png'))  return '.png';
  if (ct.includes('gif'))  return '.gif';
  if (ct.includes('webp')) return '.webp';
  return '.jpg';
}

function download(imgUrl, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(imgUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(imgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                      'Chrome/124.0.0.0 Safari/537.36',
        'Referer':    'https://www.linkedin.com/'
      }
    }, res => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return download(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const ext  = extFromContentType(res.headers['content-type']);
      const final = destPath.replace(/\.\w+$/, ext);

      const out = fs.createWriteStream(final);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(final)));
      out.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function runBatch(tasks) {
  return Promise.all(tasks.map(t => t()));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure output dir exists
  fs.mkdirSync(IMG_DIR, { recursive: true });

  const posts = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  // Build work list: { postId, imgIndex, remoteUrl, localPath (placeholder ext) }
  const work = [];
  for (const post of posts) {
    const urls = post.imageUrls || (post.imageUrl ? [post.imageUrl] : []);
    urls.forEach((u, i) => {
      if (!u) return;
      // Skip if already local
      if (u.startsWith('assets/') || u.startsWith('/assets/')) return;
      const placeholder = path.join(IMG_DIR, `${post.id}-${i}.jpg`);
      work.push({ post, imgIndex: i, remoteUrl: u, placeholder });
    });
  }

  console.log(`Images to download: ${work.length}`);

  // Skip already-downloaded files (any extension)
  const toDownload = work.filter(w => {
    const base = w.placeholder.replace(/\.jpg$/, '');
    const already = ['.jpg', '.png', '.gif', '.webp'].some(e =>
      fs.existsSync(base + e)
    );
    return !already;
  });

  console.log(`Already on disk: ${work.length - toDownload.length}  Downloading: ${toDownload.length}`);

  let done = 0, errors = 0;

  for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
    const batch = toDownload.slice(i, i + CONCURRENCY);
    const tasks = batch.map(w => async () => {
      try {
        const finalPath = await download(w.remoteUrl, w.placeholder);
        w.resolvedPath = finalPath;
        done++;
      } catch (e) {
        console.warn(`  ✗ [${w.post.id}-${w.imgIndex}] ${e.message}`);
        errors++;
      }
    });

    await runBatch(tasks);
    process.stdout.write(`\r  Progress: ${Math.min(i + CONCURRENCY, toDownload.length)}/${toDownload.length}  (${errors} errors)`);

    if (i + CONCURRENCY < toDownload.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nDownloaded: ${done}  Errors: ${errors}`);

  // ─── Rewrite JSON ────────────────────────────────────────────────────────────
  console.log('Rewriting data/linkedin-posts.json with local paths...');

  for (const post of posts) {
    if (!post.imageUrls?.length) continue;

    const newUrls = post.imageUrls.map((u, i) => {
      // Already local
      if (u.startsWith('assets/') || u.startsWith('/assets/')) return u;
      // Find the downloaded file (any extension)
      const base = path.join(IMG_DIR, `${post.id}-${i}`);
      for (const ext of ['.jpg', '.png', '.gif', '.webp']) {
        if (fs.existsSync(base + ext)) {
          return `${LOCAL_BASE}/${post.id}-${i}${ext}`;
        }
      }
      // Download failed — keep original CDN URL as fallback
      return u;
    });

    post.imageUrls = newUrls;
    post.imageUrl  = newUrls[0] || null;
  }

  fs.writeFileSync(JSON_PATH, JSON.stringify(posts, null, 2), 'utf8');
  console.log('Done. Run your local server to verify.');
}

main().catch(e => { console.error(e); process.exit(1); });
