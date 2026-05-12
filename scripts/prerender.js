'use strict';

/**
 * Pre-renders static sections of index.html from JSON data files so that
 * crawlers that don't execute JavaScript (e.g. Bingbot) can read the content.
 *
 * Sections rendered: hero, pillars, as-seen-in, media, publications,
 *                    speaking, executive bio, contact, footer.
 * Sections left dynamic: LinkedIn posts, latest news feed, video thumbnails.
 *
 * app.js overwrites these sections at runtime for real users — no behaviour change.
 * Run via: node scripts/prerender.js  (or npm run prerender)
 */

const fs   = require('fs');
const path = require('path');

// ─── Helpers (mirrors app.js) ─────────────────────────────────────────────────

function escHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])
  );
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

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  const site         = loadJson('data/site.json')          || {};
  const asSeenIn     = loadJson('data/as-seen-in.json')    || [];
  const media        = loadJson('data/featured-media.json') || [];
  const publications = loadJson('data/publications.json')   || [];
  const speaking     = loadJson('data/speaking.json')       || [];

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

