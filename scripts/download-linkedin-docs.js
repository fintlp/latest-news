'use strict';

/**
 * download-linkedin-docs.js
 *
 * Downloads LinkedIn post PDFs to assets/linkedin-docs/ and extracts
 * the first page as a JPEG thumbnail.  Updates data/linkedin-posts.json
 * with local paths and sets the thumbnail as the card image.
 *
 * Usage:  node scripts/download-linkedin-docs.js
 *
 * Thumbnail extraction tries (in order):
 *   1. sips       — always available on macOS
 *   2. qlmanage   — always available on macOS
 *   3. pdftoppm   — poppler (brew install poppler)
 *   4. gs         — ghostscript (brew install ghostscript)
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const url   = require('url');
const { execSync } = require('child_process');

const JSON_PATH  = path.join(__dirname, '..', 'data', 'linkedin-posts.json');
const DOC_DIR    = path.join(__dirname, '..', 'assets', 'linkedin-docs');
const LOCAL_BASE = 'assets/linkedin-docs';

// ─── Download helper ──────────────────────────────────────────────────────────

function download(srcUrl, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(srcUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(srcUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                      'Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.linkedin.com/'
      }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return download(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destPath)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Thumbnail extraction ─────────────────────────────────────────────────────

function cmd(command) {
  try { execSync(command, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function hasBin(bin) {
  try { execSync(`which ${bin}`, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function extractThumbnail(pdfPath, thumbPath) {
  // 1. sips (macOS built-in) — extracts first page
  if (hasBin('sips')) {
    if (cmd(`sips -s format jpeg --out "${thumbPath}" "${pdfPath}"`)) {
      if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) return true;
    }
  }

  // 2. qlmanage (macOS built-in) — generates thumbnail PNG, then convert to JPG
  if (hasBin('qlmanage')) {
    const tmpDir = path.dirname(thumbPath);
    const pngOut = pdfPath + '.png'; // qlmanage names it this way
    if (cmd(`qlmanage -t -s 1200 -o "${tmpDir}" "${pdfPath}" 2>/dev/null`)) {
      const generated = path.join(tmpDir, path.basename(pdfPath) + '.png');
      if (fs.existsSync(generated)) {
        fs.renameSync(generated, thumbPath.replace(/\.jpg$/, '.png'));
        return thumbPath.replace(/\.jpg$/, '.png');
      }
    }
  }

  // 3. pdftoppm (poppler)
  if (hasBin('pdftoppm')) {
    const base = thumbPath.replace(/\.jpg$/, '');
    if (cmd(`pdftoppm -jpeg -r 150 -f 1 -l 1 "${pdfPath}" "${base}"`)) {
      // pdftoppm creates base-1.jpg or base-01.jpg
      for (const candidate of [`${base}-1.jpg`, `${base}-01.jpg`]) {
        if (fs.existsSync(candidate)) {
          fs.renameSync(candidate, thumbPath);
          return true;
        }
      }
    }
  }

  // 4. ghostscript
  if (hasBin('gs')) {
    if (cmd(
      `gs -dNOPAUSE -dBATCH -dFirstPage=1 -dLastPage=1 ` +
      `-sDEVICE=jpeg -r150 -dJPEGQ=85 -sOutputFile="${thumbPath}" "${pdfPath}" 2>/dev/null`
    )) {
      if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) return true;
    }
  }

  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DOC_DIR, { recursive: true });

  const posts   = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const docPosts = posts.filter(p => p.documentUrl && !p.documentUrl.startsWith('assets/'));

  console.log(`Posts with remote documentUrl: ${docPosts.length}`);
  if (!docPosts.length) { console.log('Nothing to do.'); return; }

  let downloaded = 0, thumbOk = 0, errors = 0;

  for (const post of docPosts) {
    const pdfPath   = path.join(DOC_DIR, `${post.id}.pdf`);
    const thumbPath = path.join(DOC_DIR, `${post.id}-thumb.jpg`);

    // ── Download PDF ──
    if (!fs.existsSync(pdfPath)) {
      try {
        await download(post.documentUrl, pdfPath);
        downloaded++;
        console.log(`  ✓ PDF  ${post.id}`);
      } catch (e) {
        console.warn(`  ✗ PDF  ${post.id}  ${e.message}`);
        errors++;
        continue;
      }
    } else {
      console.log(`  – skip ${post.id} (already on disk)`);
    }

    // ── Extract thumbnail ──
    const existingThumb = ['.jpg', '.png'].map(e =>
      path.join(DOC_DIR, `${post.id}-thumb${e}`)
    ).find(fs.existsSync);

    let thumbLocalPath = null;

    if (!existingThumb) {
      const result = extractThumbnail(pdfPath, thumbPath);
      if (result) {
        thumbLocalPath = typeof result === 'string' ? result : thumbPath;
        thumbOk++;
        console.log(`  ✓ thumb ${path.basename(thumbLocalPath)}`);
      } else {
        console.warn(`  ✗ thumb ${post.id} — no extraction tool worked`);
      }
    } else {
      thumbLocalPath = existingThumb;
      console.log(`  – thumb ${path.basename(existingThumb)} (already exists)`);
      thumbOk++;
    }

    // ── Rewrite post fields ──
    post.documentUrl   = `${LOCAL_BASE}/${post.id}.pdf`;
    post.documentThumb = thumbLocalPath
      ? `${LOCAL_BASE}/${path.basename(thumbLocalPath)}`
      : null;

    // Use thumbnail as card image if the post has no other images
    if (post.documentThumb && !post.imageUrl) {
      post.imageUrl  = post.documentThumb;
      post.imageUrls = [post.documentThumb];
    }
  }

  console.log(`\nDownloaded: ${downloaded}  Thumbnails: ${thumbOk}  Errors: ${errors}`);

  fs.writeFileSync(JSON_PATH, JSON.stringify(posts, null, 2), 'utf8');
  console.log('data/linkedin-posts.json updated.');
}

main().catch(e => { console.error(e); process.exit(1); });
