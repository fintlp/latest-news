'use strict';

/**
 * download-linkedin-videos.js
 *
 * Downloads LinkedIn post videos to assets/linkedin-videos/ and extracts
 * a thumbnail frame (using ffmpeg if available).
 * Updates data/linkedin-posts.json with local paths.
 *
 * Prerequisites:
 *   git lfs install                (once per machine)
 *   git lfs track "assets/linkedin-videos/*.mp4"
 *   — OR just run this script; it will print the commands if LFS isn't set up.
 *
 * Usage:  node scripts/download-linkedin-videos.js
 * Idempotent — already-downloaded files are skipped.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const url   = require('url');
const { execSync, spawnSync } = require('child_process');

const JSON_PATH  = path.join(__dirname, '..', 'data', 'linkedin-posts.json');
const VID_DIR    = path.join(__dirname, '..', 'assets', 'linkedin-videos');
const LOCAL_BASE = 'assets/linkedin-videos';
const ATTRS_PATH = path.join(__dirname, '..', '.gitattributes');

const CONCURRENCY = 2;   // videos are large — keep low
const DELAY_MS    = 500;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                'Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.linkedin.com/',
};

// ─── Git LFS check ────────────────────────────────────────────────────────────

function ensureLfs() {
  const haslfs = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8' });
  if (haslfs.status !== 0) {
    console.error('⚠️  Git LFS is not installed.');
    console.error('   Install it first:  brew install git-lfs && git lfs install');
    process.exit(1);
  }

  // Ensure .gitattributes tracks mp4
  const attrLine = 'assets/linkedin-videos/*.mp4 filter=lfs diff=lfs merge=lfs -text';
  const existing = fs.existsSync(ATTRS_PATH) ? fs.readFileSync(ATTRS_PATH, 'utf8') : '';
  if (!existing.includes('linkedin-videos/*.mp4')) {
    fs.appendFileSync(ATTRS_PATH, (existing.endsWith('\n') ? '' : '\n') + attrLine + '\n');
    console.log('✓ Added LFS tracking to .gitattributes');
    // Register with git lfs
    spawnSync('git', ['lfs', 'track', 'assets/linkedin-videos/*.mp4'],
      { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  }
}

// ─── Download helper ──────────────────────────────────────────────────────────

function download(srcUrl, destPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(srcUrl); } catch { return reject(new Error(`Bad URL: ${srcUrl}`)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(srcUrl, { headers: HEADERS }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, srcUrl).href;
        return download(next, destPath, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const size = parseInt(res.headers['content-length'] || '0', 10);
      if (size) process.stdout.write(`   size ~${(size / 1024 / 1024).toFixed(1)} MB  `);

      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destPath)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Thumbnail extraction ─────────────────────────────────────────────────────

function extractThumbnail(videoPath, thumbPath) {
  // Requires ffmpeg: brew install ffmpeg
  const result = spawnSync('ffmpeg', [
    '-y', '-ss', '0', '-i', videoPath,
    '-vframes', '1', '-q:v', '3',
    '-vf', 'scale=1280:-1',
    thumbPath
  ], { stdio: 'pipe' });
  return result.status === 0 && fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0;
}

function hasffmpeg() {
  return spawnSync('which', ['ffmpeg'], { encoding: 'utf8' }).status === 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  ensureLfs();
  fs.mkdirSync(VID_DIR, { recursive: true });

  const posts = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const targets = posts.filter(p =>
    p.videoUrl && !p.videoUrl.startsWith('assets/')
  );

  console.log(`Videos to download: ${targets.length}`);
  const ffmpeg = hasffmpeg();
  if (!ffmpeg) console.log('  ℹ️  ffmpeg not found — thumbnails will be skipped (brew install ffmpeg)');

  const results = { ok: 0, skip: 0, error: 0, thumbOk: 0 };

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async post => {
      const vidPath   = path.join(VID_DIR, `${post.id}.mp4`);
      const thumbPath = path.join(VID_DIR, `${post.id}-thumb.jpg`);

      // ── Skip if already downloaded ──
      if (fs.existsSync(vidPath)) {
        post.videoUrl     = `${LOCAL_BASE}/${post.id}.mp4`;
        if (fs.existsSync(thumbPath) && !post.imageUrl) {
          post.imageUrl  = `${LOCAL_BASE}/${post.id}-thumb.jpg`;
          post.imageUrls = [`${LOCAL_BASE}/${post.id}-thumb.jpg`];
        }
        results.skip++;
        return;
      }

      // ── Download video ──
      process.stdout.write(`  ↓ ${post.id}  `);
      try {
        await download(post.videoUrl, vidPath);
        post.videoUrl = `${LOCAL_BASE}/${post.id}.mp4`;
        results.ok++;
        process.stdout.write('✓\n');
      } catch (e) {
        fs.existsSync(vidPath) && fs.unlinkSync(vidPath); // clean partial file
        console.log(`✗  ${e.message}`);
        results.error++;
        return;
      }

      // ── Extract thumbnail ──
      if (ffmpeg && !fs.existsSync(thumbPath)) {
        const ok = extractThumbnail(vidPath, thumbPath);
        if (ok) {
          results.thumbOk++;
          // Use as card image if no other image exists
          if (!post.imageUrl) {
            post.imageUrl  = `${LOCAL_BASE}/${post.id}-thumb.jpg`;
            post.imageUrls = [`${LOCAL_BASE}/${post.id}-thumb.jpg`];
          }
        }
      }
    }));

    if (i + CONCURRENCY < targets.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // ── Thumbnail pass for already-local videos ──────────────────────────────
  if (ffmpeg) {
    const needsThumb = posts.filter(p => {
      const vidPath   = path.join(VID_DIR, `${p.id}.mp4`);
      const thumbPath = path.join(VID_DIR, `${p.id}-thumb.jpg`);
      return fs.existsSync(vidPath) && !fs.existsSync(thumbPath);
    });
    if (needsThumb.length) {
      console.log(`\nGenerating thumbnails for ${needsThumb.length} videos...`);
      for (const post of needsThumb) {
        const vidPath   = path.join(VID_DIR, `${post.id}.mp4`);
        const thumbPath = path.join(VID_DIR, `${post.id}-thumb.jpg`);
        process.stdout.write(`  thumb ${post.id}  `);
        const ok = extractThumbnail(vidPath, thumbPath);
        if (ok) {
          results.thumbOk++;
          if (!post.imageUrl) {
            post.imageUrl  = `${LOCAL_BASE}/${post.id}-thumb.jpg`;
            post.imageUrls = [`${LOCAL_BASE}/${post.id}-thumb.jpg`];
          }
          console.log('✓');
        } else {
          console.log('✗');
        }
      }
    }
  }

  console.log(`\nDownloaded: ${results.ok}  Skipped: ${results.skip}  Thumbs: ${results.thumbOk}  Errors: ${results.error}`);

  fs.writeFileSync(JSON_PATH, JSON.stringify(posts, null, 2), 'utf8');
  console.log('data/linkedin-posts.json updated.');

  if (results.ok > 0) {
    console.log('\nNext steps:');
    console.log('  git add .gitattributes assets/linkedin-videos/ data/linkedin-posts.json');
    console.log('  git commit -m "feat: download LinkedIn videos to LFS"');
    console.log('  git push');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
