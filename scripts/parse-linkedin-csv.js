'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CSV parser (handles multiline quoted fields) ─────────────────────────────
function parseCSV(raw) {
  // Strip BOM
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  const rows = [];
  let i = 0;
  const len = raw.length;

  function parseField() {
    if (i < len && raw[i] === '"') {
      i++; // skip opening quote
      let val = '';
      while (i < len) {
        if (raw[i] === '"') {
          if (i + 1 < len && raw[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          val += raw[i++];
        }
      }
      return val;
    } else {
      let val = '';
      while (i < len && raw[i] !== ',' && raw[i] !== '\n' && raw[i] !== '\r') {
        val += raw[i++];
      }
      return val;
    }
  }

  function parseRow() {
    const fields = [];
    while (i < len) {
      fields.push(parseField());
      if (i < len && raw[i] === ',') {
        i++;
      } else {
        // end of row
        if (i < len && raw[i] === '\r') i++;
        if (i < len && raw[i] === '\n') i++;
        break;
      }
    }
    return fields;
  }

  // Parse header
  const header = parseRow();
  // Parse data rows
  while (i < len) {
    const row = parseRow();
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = row[idx] || ''; });
      rows.push(obj);
    }
  }
  return rows;
}

// ─── Topic classification ─────────────────────────────────────────────────────
const TOPIC_RULES = [
  {
    label: 'China & EV',
    patterns: ['china', 'chinese', 'byd', 'xpeng', 'nio', 'geely', 'saic', 'nev', 'beijing', 'shanghai', 'caam']
  },
  {
    label: 'ADAS & Autonomous',
    patterns: ['adas', 'autonomous', 'self-driv', 'lidar', 'radar', ' l2 ', ' l3 ', ' l4 ', 'waymo', 'mobileye', 'robotaxi']
  },
  {
    label: 'SDV & Software',
    patterns: ['software-defined', 'sdv', 'e/e', 'cariad', 'autosar', 'eclipse', 'ota', 'over-the-air']
  },
  {
    label: 'Semiconductors',
    patterns: ['semiconductor', 'chip', 'tsmc', 'intel', 'nvidia', 'qualcomm', 'asml', 'foundry', 'fab', 'wafer', 'dram', 'memory chip']
  },
  {
    label: 'Physical AI & Robotics',
    patterns: ['robot', 'humanoid', 'physical ai', 'embodied', 'manipulat', 'gripper', 'optimus']
  },
  {
    label: 'Events & Speaking',
    patterns: ['hannover', 'embedded world', 'ces ', 'mwc', 'auto china', 'iaa', 'car it', 'trade show', 'booth', /hall \d/, /stand \d/]
  },
  {
    label: 'Industry & Manufacturing',
    patterns: ['manufactur', 'industri', 'shopfloor', 'factory', 'production', 'supply chain', 'capgemini']
  }
];

function classifyTopics(text) {
  const lower = text.toLowerCase();
  const matched = [];
  for (const rule of TOPIC_RULES) {
    for (const p of rule.patterns) {
      const hit = p instanceof RegExp ? p.test(lower) : lower.includes(p);
      if (hit) { matched.push(rule.label); break; }
    }
  }
  return matched.length > 0 ? matched : ['Industry & Manufacturing'];
}

// ─── Extract activity ID from permalink ───────────────────────────────────────
function extractId(permalink, index) {
  const m = String(permalink).match(/activity-(\d+)/);
  return m ? m[1] : String(index);
}

// ─── Strip leading emoji characters from a string ─────────────────────────────
// NOT \p{Emoji}: that property matches ASCII digits and "#" (they are keycap
// sequence components), so a post opening with "#5g, #6g and #IoT" had its
// "#5" eaten and became "g, #6g and #IoT". \p{Extended_Pictographic} covers the
// actual pictographs; skin-tone modifiers, VS16 and ZWJ are added for sequences.
function stripLeadingEmojis(s) {
  return s.replace(
    /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}️‍]|\s)+/u,
    ''
  ).trim();
}

// ─── Card headline ────────────────────────────────────────────────────────────
// The old rule — first line, hard-sliced to 120 chars — cut words in half
// ("…I do not believe that fatal") and the same opening then repeated verbatim
// in the card body underneath. Take whole sentences instead, and only ellipsise
// when a single sentence genuinely runs past the limit.
const TITLE_MAX = 110;
const TITLE_MIN = 40;   // below this, absorb the next sentence too

// Split on . ! ? followed by whitespace or end. Requiring the whitespace keeps
// decimals and prices intact ("$1.7 billion" is not a sentence boundary).
function splitSentences(s) {
  return s.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g) || [s];
}

// A quotation that runs across two sentences leaves the headline holding a lone
// opening mark — '"On the path to an Open Source Vehicle OS.' — and truncation
// can orphan a closing mark the same way. Drop the orphan rather than show it.
//
// All double-quote glyphs count as one class. These posts mix conventions
// freely — English "…" alongside German „…“ — so counting straight and curly
// marks separately reads a perfectly balanced `"…industry“` as broken and
// strips its opening mark, which is worse than leaving it alone.
const DOUBLE_QUOTE = /["“”„»«]/;

function balanceQuotes(s) {
  const marks = s.match(/["“”„»«]/g) || [];
  if (marks.length % 2 === 0) return s.trim();
  if (DOUBLE_QUOTE.test(s[0]))            return s.slice(1).trim();
  if (DOUBLE_QUOTE.test(s[s.length - 1])) return s.slice(0, -1).trim();
  return s.trim();   // orphan sits mid-string; nothing safe to remove
}

function truncateOnWord(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp  = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.!?-]+$/, '') + '…';
}

// ─── Display text for the card ────────────────────────────────────────────────
// Drops the bare share URLs LinkedIn appends ("https://lnkd.in/…") and the
// trailing hashtag block. Inline hashtags keep their word and lose only the
// "#", because "#RISCV is arriving in automotive" must not become
// " is arriving in automotive".
//
// `text` itself is left untouched — the modal shows the authentic post, and
// search still matches against the original including hashtags.
function cleanForDisplay(text) {
  return stripLeadingEmojis(text)
    .replace(/https?:\/\/\S+/g, '')                  // bare URLs incl. lnkd.in
    .replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, '')     // trailing hashtag block
    .replace(/#([\p{L}\p{N}_]+)/gu, '$1')            // inline: keep word, drop #
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Headline + body are derived together so the body can start exactly where the
// headline stopped — that is what keeps the card from printing its own opening
// twice, which is what the old first-120-characters rule did.
function makeTitleAndPreview(text) {
  const clean = cleanForDisplay(text);
  if (!clean) return { title: truncateOnWord(text.trim(), TITLE_MAX), preview: '' };

  const firstLine = clean.split('\n').find(l => l.trim()) || clean;
  const sentences = splitSentences(firstLine);

  let title = '', consumed = 0;
  for (const s of sentences) {
    const next = (title + s).trim();
    if (title && next.length > TITLE_MAX) break;
    title = next;
    consumed += s.length;
    if (title.length >= TITLE_MIN) break;
  }
  if (!title) { title = firstLine; consumed = firstLine.length; }

  // A headline cut mid-sentence consumes that whole sentence anyway, so the
  // body opens on the *next* one. Otherwise the card body would begin on a
  // fragment — "vehicles\n\nFor years, the public discourse…".
  title = balanceQuotes(truncateOnWord(title, TITLE_MAX));

  const preview = clean
    .slice(consumed)
    .replace(/^[\s.,;:!?–—-]+/, '')
    .trim();

  return { title, preview };
}

// ─── Anchor LinkedIn's relative dates to absolute ones ────────────────────────
// The CSV only carries relative strings ("5d", "3mo", "4yr") that were true at
// *export* time. Left as-is they silently rot: "5d" still says "5 days ago" a
// year after the export. So we resolve them once, against the CSV's own mtime,
// and store the result.
//
// Precision is recorded alongside, because the source is not uniformly precise:
// "5d" pins a day, "3w" only pins a month, "4yr" only pins a year. The renderers
// display no more precision than this field allows — a post exported as "4yr"
// must never be shown as though we knew the day.
function derivePublishDate(rel, baselineMs) {
  const s = String(rel || '').toLowerCase().trim();
  if (!s) return { iso: null, precision: null };

  const d = new Date(baselineMs);
  const ymd = () => d.toISOString().slice(0, 10);

  if (s === 'just now') return { iso: ymd(), precision: 'day' };

  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return { iso: null, precision: null };

  // Order matters: 'mo' must be tested before 'm', 'yr' before 'r'.
  if (s.includes('yr')) { d.setFullYear(d.getFullYear() - n); return { iso: ymd(), precision: 'year'  }; }
  if (s.includes('mo')) { d.setMonth(d.getMonth() - n);       return { iso: ymd(), precision: 'month' }; }
  if (s.includes('w'))  { d.setDate(d.getDate() - n * 7);     return { iso: ymd(), precision: 'month' }; }
  if (s.includes('d'))  { d.setDate(d.getDate() - n);         return { iso: ymd(), precision: 'day'   }; }
  if (s.includes('h') || s.includes('m')) return { iso: ymd(), precision: 'day' };

  return { iso: null, precision: null };
}

// ─── Transform a CSV row into a post object ───────────────────────────────────
function transformRow(row, index, baselineMs) {
  const text = (row.text || '').trim();
  if (!text) return null;

  // Images — may be newline-separated
  const rawImages = (row.images || '').trim();
  const imageUrls = rawImages
    ? rawImages.split('\n').map(u => u.trim()).filter(Boolean)
    : [];
  const imageUrl = imageUrls[0] || null;

  const videoUrl    = (row.videoUrl    || '').trim() || null;
  const documentUrl = (row.documentUrl || '').trim() || null;

  const likes    = parseInt(row.likes    || '0', 10) || 0;
  const comments = parseInt(row.comments || '0', 10) || 0;
  const shares   = parseInt(row.shares   || '0', 10) || 0;
  const engagement = likes + comments * 3 + shares * 5;

  const { title, preview } = makeTitleAndPreview(text);

  const topics = classifyTopics(text);
  const permalink = (row.permalink || '').trim();
  const id = extractId(permalink, index);

  const publishDate = (row.publishDate || '').trim();
  const resolved    = derivePublishDate(publishDate, baselineMs);

  return {
    id,
    permalink,
    title,
    text,
    preview,
    topics,
    imageUrl,
    imageUrls,
    videoUrl,
    documentUrl,
    likes,
    comments,
    shares,
    engagement,
    publishDate,
    publishDateISO:   resolved.iso,
    publishPrecision: resolved.precision,
    source: 'LinkedIn',
    author: 'Peter Fintl'
  };
}

// ─── Preserve locally-downloaded images ───────────────────────────────────────
// After running download-linkedin-images.js, imageUrl/imageUrls point to
// assets/linkedin-images/. On re-parse we keep those local paths instead of
// overwriting with fresh (but expiring) CDN URLs.
function mergeLocalImages(posts) {
  const imgDir     = path.join(__dirname, '..', 'assets', 'linkedin-images');
  const localBase  = 'assets/linkedin-images';
  const extensions = ['.jpg', '.png', '.gif', '.webp'];

  for (const post of posts) {
    const newUrls = (post.imageUrls || []).map((u, i) => {
      // Already a local path — keep it
      if (u.startsWith('assets/') || u.startsWith('/assets/')) return u;
      // Check if a downloaded file exists for this slot
      for (const ext of extensions) {
        const local = path.join(imgDir, `${post.id}-${i}${ext}`);
        if (fs.existsSync(local)) return `${localBase}/${post.id}-${i}${ext}`;
      }
      return u; // no local file — keep CDN URL
    });
    post.imageUrls = newUrls;
    post.imageUrl  = newUrls[0] || null;
  }
  return posts;
}

// ─── Preserve locally-downloaded videos ──────────────────────────────────────
// After running download-linkedin-videos.js, videoUrl points to
// assets/linkedin-videos/. On re-parse we keep local paths and restore
// the video thumbnail as imageUrl if no other image exists.
function mergeLocalVideos(posts) {
  const vidDir    = path.join(__dirname, '..', 'assets', 'linkedin-videos');
  const localBase = 'assets/linkedin-videos';

  for (const post of posts) {
    const mp4 = path.join(vidDir, `${post.id}.mp4`);
    if (!fs.existsSync(mp4)) continue;
    post.videoUrl = `${localBase}/${post.id}.mp4`;

    if (!post.imageUrl) {
      for (const ext of ['.jpg', '.png']) {
        const thumb = path.join(vidDir, `${post.id}-thumb${ext}`);
        if (fs.existsSync(thumb)) {
          post.imageUrl  = `${localBase}/${post.id}-thumb${ext}`;
          post.imageUrls = [post.imageUrl];
          break;
        }
      }
    }
  }
  return posts;
}

// ─── Preserve locally-downloaded article OG images ───────────────────────────
// After running download-linkedin-article-images.js, posts that promoted
// external articles have imageUrl pointing to assets/linkedin-articles/.
// On re-parse we restore those local images.
function mergeLocalArticleImages(posts) {
  const artDir    = path.join(__dirname, '..', 'assets', 'linkedin-articles');
  const localBase = 'assets/linkedin-articles';
  const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  // Load articleUrl index from current JSON if it exists (preserve manually set URLs)
  let articleUrlIndex = {};
  const outPath = path.join(__dirname, '..', 'data', 'linkedin-posts.json');
  if (fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      existing.forEach(p => { if (p.articleUrl) articleUrlIndex[p.id] = p.articleUrl; });
    } catch { /* ignore */ }
  }

  for (const post of posts) {
    // Restore articleUrl from previous run
    if (articleUrlIndex[post.id]) post.articleUrl = articleUrlIndex[post.id];

    // Only apply image to posts that still have no media from the CSV
    if (post.imageUrl || post.videoUrl || post.documentUrl) continue;
    for (const ext of extensions) {
      const local = path.join(artDir, `${post.id}-article${ext}`);
      if (fs.existsSync(local)) {
        const localPath = `${localBase}/${post.id}-article${ext}`;
        post.imageUrl  = localPath;
        post.imageUrls = [localPath];
        break;
      }
    }
  }
  return posts;
}

// ─── Preserve locally-downloaded PDFs ────────────────────────────────────────
// After running download-linkedin-docs.js, documentUrl points to
// assets/linkedin-docs/. On re-parse we keep local paths and restore
// documentThumb + imageUrl if the thumbnail exists.
function mergeLocalDocs(posts) {
  const docDir    = path.join(__dirname, '..', 'assets', 'linkedin-docs');
  const localBase = 'assets/linkedin-docs';

  for (const post of posts) {
    const pdfLocal = path.join(docDir, `${post.id}.pdf`);
    if (!fs.existsSync(pdfLocal)) continue;

    post.documentUrl = `${localBase}/${post.id}.pdf`;

    // Find thumbnail (any extension)
    for (const ext of ['.jpg', '.png']) {
      const thumbLocal = path.join(docDir, `${post.id}-thumb${ext}`);
      if (fs.existsSync(thumbLocal)) {
        post.documentThumb = `${localBase}/${post.id}-thumb${ext}`;
        // Use thumbnail as card image if no other image
        if (!post.imageUrl || post.imageUrl === post.documentThumb) {
          post.imageUrl  = post.documentThumb;
          post.imageUrls = [post.documentThumb];
        }
        break;
      }
    }
  }
  return posts;
}

// ─── Preserve the first resolution of each post's date ───────────────────────
// A post exported as "3mo" resolves to a month; the same post in next year's
// export reads "1yr" and would resolve only to a year. The earlier reading is
// always the more precise one, so once a post has an anchored date we keep it.
function mergeResolvedDates(posts) {
  const outPath = path.join(__dirname, '..', 'data', 'linkedin-posts.json');
  if (!fs.existsSync(outPath)) return posts;

  let prior = {};
  try {
    JSON.parse(fs.readFileSync(outPath, 'utf8')).forEach(p => {
      if (p.publishDateISO) prior[p.id] = p;
    });
  } catch { return posts; }

  let kept = 0;
  for (const post of posts) {
    const was = prior[post.id];
    if (!was) continue;
    post.publishDateISO   = was.publishDateISO;
    post.publishPrecision = was.publishPrecision;
    kept++;
  }
  if (kept) console.log(`Kept previously anchored dates for ${kept} posts`);
  return posts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const csvPath  = path.join(__dirname, '..', 'LI_POSTS_fintlp_568.csv');
  const outPath  = path.join(__dirname, '..', 'data', 'linkedin-posts.json');

  const raw  = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(raw);

  // Relative dates in the CSV were true when the file was exported, not now.
  const baselineMs = fs.statSync(csvPath).mtimeMs;
  console.log(`Parsed ${rows.length} CSV rows (dates anchored to ${new Date(baselineMs).toISOString().slice(0, 10)})`);

  let posts = rows
    .map((r, i) => transformRow(r, i, baselineMs))
    .filter(Boolean);

  posts = mergeResolvedDates(posts);
  posts = mergeLocalImages(posts);
  posts = mergeLocalDocs(posts);
  posts = mergeLocalArticleImages(posts);
  posts = mergeLocalVideos(posts);
  const localCount = posts.filter(p => p.imageUrl?.startsWith('assets/')).length;
  if (localCount) console.log(`Using local images for ${localCount} posts`);

  console.log(`Valid posts: ${posts.length}`);

  // Sort by engagement descending
  posts.sort((a, b) => b.engagement - a.engagement);

  // Topic distribution stats
  const topicCounts = {};
  posts.forEach(p => p.topics.forEach(t => { topicCounts[t] = (topicCounts[t] || 0) + 1; }));
  console.log('Topic distribution:', topicCounts);

  fs.writeFileSync(outPath, JSON.stringify(posts, null, 2), 'utf8');
  console.log(`Written ${posts.length} posts to ${outPath}`);
}

main();
