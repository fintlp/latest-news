'use strict';

/**
 * Pre-renders static sections of index.html from JSON data files so that
 * crawlers that don't execute JavaScript (e.g. Bingbot) can read the content.
 *
 * Sections rendered: hero, pillars, as-seen-in, media, publications, speaking,
 *                    library, LinkedIn posts, latest coverage, executive bio,
 *                    contact, footer, VideoObject schema.
 * Sections left dynamic: video thumbnails.
 *
 * app.js overwrites these sections at runtime for real users — no behaviour change.
 * Run via: node scripts/prerender.js  (or npm run prerender)
 */

const fs   = require('fs');
const path = require('path');

// Must match NEWS_STATE.pageSize / LI_STATE.pageSize in app.js, so the static
// markup renders exactly the same first page that app.js paints on hydration.
const NEWS_PAGE_SIZE = 12;
const LI_PAGE_SIZE   = 12;

// ─── Helpers (mirrors app.js) ─────────────────────────────────────────────────

function escHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])
  );
}

// Strips tags and decodes the entities that arrive in RSS titles/snippets.
function cleanText(s = '') {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch { return String(iso); }
}

function fmtYear(iso) {
  if (!iso) return '';
  try { return String(new Date(iso).getFullYear()); }
  catch { return String(iso); }
}

function isPlaceholder(url) {
  return !url || url.startsWith('#');
}

// ─── HTML injection ───────────────────────────────────────────────────────────
// Replaces the inner content of the element with the given id.
// Uses a depth counter so it correctly handles nested tags of the same type.

function setInner(html, id, newContent) {
  const start = html.indexOf(`id="${id}"`);
  if (start === -1) { console.warn(`  ⚠ id="${id}" not found — skipping`); return html; }

  const tagOpen  = html.indexOf('>', start) + 1;
  const tagStart = html.lastIndexOf('<', start);
  const nameMatch = html.slice(tagStart).match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
  const tagName   = nameMatch ? nameMatch[1].toLowerCase() : 'div';

  const openTag  = `<${tagName}`;
  const closeTag = `</${tagName}`;

  let depth = 1;
  let pos   = tagOpen;

  while (depth > 0 && pos < html.length) {
    const nextOpen  = html.indexOf(openTag,  pos);
    const nextClose = html.indexOf(closeTag, pos);

    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 1;
    } else {
      depth--;
      if (depth === 0) {
        return html.slice(0, tagOpen) + newContent + html.slice(nextClose);
      }
      pos = nextClose + 1;
    }
  }

  console.warn(`  ⚠ Could not find closing tag for id="${id}"`);
  return html;
}

function loadJson(relPath) {
  const absPath = path.join(__dirname, '..', relPath);
  if (!fs.existsSync(absPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (e) {
    console.warn(`  ⚠ Could not parse ${relPath}: ${e.message}`);
    return null;
  }
}

// ─── Section renderers ────────────────────────────────────────────────────────

function renderHeroEyebrow(site) {
  return (site.roles || []).map(escHtml).join('<br>');
}

function renderHeroPhoto(site) {
  if (!site.photo) return '';
  return `<img src="${escHtml(site.photo)}" alt="Portrait of ${escHtml(site.name || '')}" width="600" height="600" />`;
}

function renderHeroActions(site) {
  return (site.heroButtons || []).map(btn => {
    const cls    = btn.type === 'external' ? 'btn btn--outline' : 'btn btn--primary';
    const target = btn.type === 'external' ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${escHtml(btn.target)}" class="${cls}"${target}>${escHtml(btn.label)}</a>`;
  }).join('');
}

function renderPillars(site) {
  return (site.whyThisMatters || []).map(p => `
    <div class="pillar-card">
      <h3 class="pillar-title">${escHtml(p.title)}</h3>
      <p class="pillar-text">${escHtml(p.text)}</p>
    </div>`).join('');
}

function renderLogoStrip(items) {
  return (items || []).map(o => `
    <a href="${escHtml(o.url)}" class="logo-item" target="_blank" rel="noopener" title="${escHtml(o.name)}">
      <img src="${escHtml(o.logo)}" alt="${escHtml(o.name)}" loading="lazy"
           onerror="this.style.display='none';this.nextElementSibling.style.display='block'" />
      <span class="logo-text" style="display:none">${escHtml(o.name)}</span>
    </a>`).join('');
}

function renderMediaGrid(items) {
  return (items || [])
    .filter(i => i.featured !== false)
    .map(item => {
      const linked = !isPlaceholder(item.url);
      const open   = linked
        ? `<a href="${escHtml(item.url)}" class="media-card" target="_blank" rel="noopener">`
        : `<div class="media-card">`;
      const close  = linked ? '</a>' : '</div>';
      return `${open}
        <div class="media-card__meta">
          <span class="badge badge--type">${escHtml(item.type)}</span>
          <span class="media-card__date">${fmtDate(item.date)}</span>
        </div>
        <p class="media-card__outlet">${escHtml(item.outlet)}</p>
        <h3 class="media-card__title">${escHtml(item.title)}</h3>
        <p class="media-card__summary">${escHtml(item.summary)}</p>
        ${linked ? '<span class="card-link-label">Read more &rarr;</span>' : ''}
      ${close}`;
    }).join('');
}

function renderPubList(items) {
  return (items || []).map(item => {
    const linked = !isPlaceholder(item.url);
    const open   = linked
      ? `<a href="${escHtml(item.url)}" class="pub-item" target="_blank" rel="noopener">`
      : `<div class="pub-item">`;
    const close  = linked ? '</a>' : '</div>';
    return `${open}
      <span class="badge badge--category">${escHtml(item.category)}</span>
      <h3 class="pub-title">${escHtml(item.title)}</h3>
      <p class="pub-meta">${escHtml(item.publication)} &middot; ${fmtYear(item.date)}</p>
      <p class="pub-summary">${escHtml(item.summary)}</p>
      ${linked ? '<span class="card-link-label">Read &rarr;</span>' : ''}
    ${close}`;
  }).join('');
}

function renderSpeakingList(items) {
  return (items || []).map(item => {
    const linked = !isPlaceholder(item.url);
    const open   = linked
      ? `<a href="${escHtml(item.url)}" class="speaking-item" target="_blank" rel="noopener">`
      : `<div class="speaking-item">`;
    const close  = linked ? '</a>' : '</div>';
    return `${open}
      <p class="speaking-item__year">${escHtml(item.year)}</p>
      <h3 class="speaking-item__event">${escHtml(item.event)}</h3>
      <p class="speaking-item__role">${escHtml(item.role)}</p>
      <p class="speaking-item__topic">${escHtml(item.topic)}</p>
      <p class="speaking-item__location">${escHtml(item.location)}</p>
    ${close}`;
  }).join('');
}

function renderLibraryGrid(items) {
  const pageSize = 8;
  const slice = (items || []).slice(0, pageSize);
  
  return slice.map(item => {
    const mediaHtml = item.imageUrl
      ? `<div class="lib-card-image-wrap">
           <img class="lib-card-image" src="${escHtml(item.imageUrl)}" alt="Cover of ${escHtml(item.title)}" loading="lazy" />
         </div>`
      : '';

    return `
      <article class="lib-card" data-lib-id="${escHtml(item.id)}">
        ${mediaHtml}
        <div class="lib-card-body">
          <div class="lib-card-category">${escHtml(item.category)}</div>
          <h3 class="lib-card-title">${escHtml(item.title)}</h3>
          <p class="lib-card-author">by ${escHtml(item.author)}</p>
          <div class="lib-card-comment-wrap">
            <p class="lib-card-comment">${escHtml(item.comment)}</p>
          </div>
          <button class="lib-card-expand">Read more</button>
          <div class="lib-card-footer">
             <span class="card-link-label">Details &rarr;</span>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderBioLayout(site) {
  const bioContent = `
    ${site.executiveBio ? `<p>${escHtml(site.executiveBio)}</p>` : ''}
    ${(site.roles || []).length
      ? `<ul class="bio-roles">${site.roles.map(r => `<li>${escHtml(r)}</li>`).join('')}</ul>`
      : ''}`;
  return site.photo
    ? `<div class="bio-photo">
         <img src="${escHtml(site.photo)}" alt="Portrait of ${escHtml(site.name || '')}" width="400" height="400" loading="lazy" />
       </div>
       <div class="bio-content">${bioContent}</div>`
    : `<div class="bio-content">${bioContent}</div>`;
}

function renderContactActions(site) {
  const links = [];
  if (site.linkedinUrl) {
    links.push(`<a href="${escHtml(site.linkedinUrl)}" class="btn btn--primary" target="_blank" rel="noopener">LinkedIn Profile</a>`);
  }
  if (site.email) {
    links.push(`<a href="mailto:${escHtml(site.email)}" class="btn btn--outline">Send Email</a>`);
  }
  return links.join('');
}

function renderCompanyLinks(site) {
  return (site.companyLinks || []).map(l =>
    `<a href="${escHtml(l.url)}" class="company-link" target="_blank" rel="noopener">${escHtml(l.label)}</a>`
  ).join('');
}

// ─── Latest coverage + LinkedIn posts ─────────────────────────────────────────
// These two sections were previously left to app.js, which meant the bulk of the
// site's text was invisible to any crawler that doesn't run JavaScript.
//
// Each renderer below mirrors its app.js counterpart *at that section's default
// state* — same filter, same sort order, same pageSize. Matching the default
// matters: app.js overwrites these containers on hydration, so if the static
// markup disagreed the user would see the cards visibly reshuffle on load.

// "90d" → 90, "1y" → 365, "all" → 'all'   (mirrors app.js parseRange)
function parseRange(r) {
  if (!r || r === 'all') return 'all';
  if (r.endsWith('y'))   return parseInt(r, 10) * 365;
  return parseInt(r, 10);
}

// Mirrors app.js FRONTEND_BLOCKED_HOSTS — profile pages that slip past the pipeline.
const BLOCKED_HOSTS = ['researchgate.net'];

function isBlockedHost(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return BLOCKED_HOSTS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

function renderNewsCards(archive, cfg) {
  const days = parseRange(cfg.defaultRange || '90d');
  let items = (archive || []).filter(i => i.url && !isBlockedHost(i.url));

  if (days !== 'all') {
    const cutoff = Date.now() - Number(days) * 86400000;
    items = items.filter(i => new Date(i.publishedAt).getTime() >= cutoff);
  }

  items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Dedupe on a normalised title, as app.js does — the archive accumulates
  // near-duplicates across fetch runs with slightly different URLs.
  const seen = new Set();
  items = items.filter(i => {
    const key = cleanText(i.title).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return items.slice(0, NEWS_PAGE_SIZE).map((item, index) => {
    const source = item.source || 'News';
    let snip = cleanText(item.snippet || '');
    if (snip.length > 200) snip = snip.slice(0, 197) + '…';

    const hue      = (source.charCodeAt(0) * 17 + index * 31) % 360;
    const gradient = `linear-gradient(135deg,hsl(${hue},30%,22%),hsl(${(hue + 45) % 360},45%,12%))`;
    const initial  = source.charAt(0).toUpperCase();

    const isFavicon  = item.imageUrl && item.imageUrl.includes('google.com/s2/favicons');
    const thumbClass = `news-card__thumb${isFavicon ? ' news-card__thumb--favicon' : ''}`;
    const thumbHtml  = item.imageUrl
      ? `<img class="${thumbClass}" src="${escHtml(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
         <div class="news-card__thumb-fallback" style="background:${gradient};display:none">${escHtml(initial)}</div>`
      : `<div class="news-card__thumb-fallback" style="background:${gradient}">${escHtml(initial)}</div>`;

    return `
      <a href="${escHtml(item.url)}" class="news-card" target="_blank" rel="noopener">
        <div class="news-card__image">${thumbHtml}</div>
        <div class="news-card__body">
          <div class="news-card__meta">
            ${item.faviconUrl ? `<img class="news-card__favicon" src="${escHtml(item.faviconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
            <span class="news-card__source">${escHtml(source)}</span>
            <span class="news-card__sep" aria-hidden="true">&middot;</span>
            <span class="news-card__date">${fmtDate(item.publishedAt)}</span>
          </div>
          <h3 class="news-card__title">${escHtml(cleanText(item.title))}</h3>
          ${snip ? `<p class="news-card__snippet">${escHtml(snip)}</p>` : ''}
        </div>
      </a>`;
  }).join('');
}

// Mirrors app.js TOPIC_COLOURS
const TOPIC_COLOURS = {
  'China & EV':              { bg: '#fff0e0', text: '#8b4a00' },
  'ADAS & Autonomous':       { bg: '#e8f0fe', text: '#1a56a0' },
  'SDV & Software':          { bg: '#e6f4ea', text: '#1a6b35' },
  'Semiconductors':          { bg: '#f3e8fd', text: '#6b1fa0' },
  'Physical AI & Robotics':  { bg: '#fce8ec', text: '#9b1930' },
  'Events & Speaking':       { bg: '#fff8e0', text: '#7a5500' },
  'Industry & Manufacturing':{ bg: '#e9eef4', text: '#2c4a6b' }
};

function liTopicPill(topic) {
  const c = TOPIC_COLOURS[topic] || { bg: '#eee', text: '#333' };
  return `<span class="li-topic-pill" style="background:${c.bg};color:${c.text}">${escHtml(topic)}</span>`;
}

function renderLiCards(posts) {
  // app.js defaults to sort: 'engagement', topic: 'all', no query.
  const list = (posts || [])
    .slice()
    .sort((a, b) => (b.engagement || 0) - (a.engagement || 0))
    .slice(0, LI_PAGE_SIZE);

  return list.map(post => {
    const mediaHtml = (() => {
      if (post.imageUrl) {
        const badge = post.documentUrl
          ? `<span class="li-card-pdf-badge" aria-label="PDF attachment">&#128196; PDF</span>`
          : post.videoUrl
            ? `<span class="li-card-play-badge" aria-label="Video">&#9654;</span>`
            : '';
        return `<div class="li-card-image-wrap">
        <img class="li-card-image" src="${escHtml(post.imageUrl)}" alt=""
             loading="lazy"
             onerror="this.closest('.li-card-image-wrap').style.display='none'" />
        ${badge}
      </div>`;
      }
      if (post.documentUrl) {
        return `<div class="li-card-image-wrap li-card-video-placeholder">
        <span class="li-play-icon" aria-hidden="true">&#128196;</span>
      </div>`;
      }
      if (post.videoUrl) {
        return `<div class="li-card-image-wrap li-card-video-placeholder">
        <span class="li-play-icon" aria-hidden="true">&#9654;</span>
      </div>`;
      }
      return `<div class="li-card-image-wrap li-card-text-placeholder" aria-hidden="true">
      <span class="li-card-text-placeholder__in">in</span>
    </div>`;
    })();

    const topicPills = (post.topics || []).map(liTopicPill).join('');

    return `
    <article class="li-card" data-post-id="${escHtml(post.id)}">
      ${mediaHtml}
      <div class="li-card-body">
        <div class="li-card-topics">${topicPills}</div>
        <h3 class="li-card-title">${escHtml(post.title)}</h3>
        <div class="li-card-text-wrap">
          <p class="li-card-text">${escHtml(post.text)}</p>
        </div>
        <button class="li-card-expand" aria-label="Read full post">Read more</button>
        <div class="li-card-footer">
          <div class="li-card-stats">
            <span title="Likes">&#128077; ${post.likes}</span>
            <span title="Comments">&#128172; ${post.comments}</span>
            <span title="Shares">&#128257; ${post.shares}</span>
          </div>
          <a href="${escHtml(post.permalink)}" class="li-card-link"
             target="_blank" rel="noopener">View on LinkedIn &rarr;</a>
        </div>
      </div>
    </article>`;
  }).join('');
}

// ─── VideoObject schema ───────────────────────────────────────────────────────
// Makes the embedded interviews eligible for video rich results. Only videos
// actually playable on the page (i.e. with an `embed` URL) are marked up —
// a thumbnail that merely links out to another platform is not a video on this
// page, and claiming otherwise is a structured-data mismatch.
//
// Google requires name, description, thumbnailUrl and uploadDate; entries
// missing any of those are skipped rather than emitted as invalid markup.

// "26:51" → "PT26M51S", "1:02:03" → "PT1H2M3S"
function isoDuration(display) {
  const parts = String(display || '').split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  if (s === undefined) return null;
  return `PT${h ? `${h}H` : ''}${m}M${s}S`;
}

function renderVideoSchema(videos) {
  const items = (videos || [])
    .filter(v => v.embed && v.title && v.summary && v.thumbnail && v.date)
    .map(v => {
      const node = {
        '@context':    'https://schema.org',
        '@type':       'VideoObject',
        name:          v.title,
        description:   v.summary,
        thumbnailUrl:  v.thumbnail,
        uploadDate:    v.date,
        embedUrl:      v.embed,
      };
      const dur = isoDuration(v.duration);
      if (dur) node.duration = dur;
      if (v.source) node.publisher = { '@type': 'Organization', name: v.source };
      return node;
    });

  if (!items.length) return '';
  // Escape < so a value can never terminate the surrounding <script> block.
  return JSON.stringify(items, null, 2).replace(/</g, '\\u003c');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  const site         = loadJson('data/site.json')          || {};
  const asSeenIn     = loadJson('data/as-seen-in.json')    || [];
  const media        = loadJson('data/featured-media.json') || [];
  const publications = loadJson('data/publications.json')   || [];
  const speaking     = loadJson('data/speaking.json')       || [];
  const library      = loadJson('data/library.json')        || [];
  const videos       = loadJson('data/videos.json')         || [];
  const liPosts      = loadJson('data/linkedin-posts.json')  || [];
  const archive      = loadJson('data/archive.json')         || [];
  const newsCfg      = loadJson('data/latest-news-config.json') || {};

  // Structured data
  html = setInner(html, 'video-schema', renderVideoSchema(videos));

  // Hero
  html = setInner(html, 'hero-eyebrow', renderHeroEyebrow(site));
  html = setInner(html, 'hero-name',    escHtml(site.name || ''));
  html = setInner(html, 'hero-tagline', escHtml(site.tagline || ''));
  html = setInner(html, 'hero-intro',   escHtml(site.heroIntro || ''));
  html = setInner(html, 'hero-photo',   renderHeroPhoto(site));
  html = setInner(html, 'hero-actions', renderHeroActions(site));

  // Why this matters
  html = setInner(html, 'pillars', renderPillars(site));

  // As seen in
  if (asSeenIn.length) {
    html = setInner(html, 'logo-strip', renderLogoStrip(asSeenIn));
  }

  // Media, publications, speaking
  html = setInner(html, 'media-grid',    renderMediaGrid(media));
  html = setInner(html, 'pub-list',      renderPubList(publications));
  html = setInner(html, 'speaking-list', renderSpeakingList(speaking));

  // LinkedIn posts & latest coverage
  html = setInner(html, 'li-grid',      renderLiCards(liPosts));
  html = setInner(html, 'news-results', renderNewsCards(archive, newsCfg));

  // Library
  html = setInner(html, 'lib-grid', renderLibraryGrid(library));
  const libBtnStyle = (library || []).length > 6 ? '' : 'display:none';
  html = html.replace(/id="lib-load-more"(\s+style="[^"]*")?/, `id="lib-load-more" style="${libBtnStyle}"`);

  // Executive bio & contact
  html = setInner(html, 'bio-layout',      renderBioLayout(site));
  html = setInner(html, 'contact-intro',   escHtml(site.contactIntro || ''));
  html = setInner(html, 'contact-actions', renderContactActions(site));
  html = setInner(html, 'company-links',   renderCompanyLinks(site));

  // Footer
  html = setInner(html, 'footer-name', escHtml(site.name || ''));
  html = setInner(html, 'footer-text', escHtml(site.footerText || ''));
  html = setInner(html, 'footer-year', String(new Date().getFullYear()));

  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('✓ Pre-render complete — index.html updated');

  updateSitemap();
}

function updateSitemap() {
  const sitemapPath = path.join(__dirname, '..', 'sitemap.xml');
  if (!fs.existsSync(sitemapPath)) return;

  const today = new Date().toISOString().split('T')[0];
  let content = fs.readFileSync(sitemapPath, 'utf8');
  const updated = content.replace(/<lastmod>[^<]+<\/lastmod>/, `<lastmod>${today}</lastmod>`);

  fs.writeFileSync(sitemapPath, updated, 'utf8');
  console.log(`✓ Sitemap updated — lastmod: ${today}`);
}

main();

