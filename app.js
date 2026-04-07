'use strict';

// ─── Shared news feed state ───────────────────────────────────────────────────
const NEWS_STATE = {
  items:     [],
  days:      90,    // overridden by data/latest-news-config.json defaultRange
  sortOrder: 'desc',
  query:     ''
};

// ─── DOM utilities ────────────────────────────────────────────────────────────
const qs  = (sel, ctx = document) => ctx.querySelector(sel);
const qsa = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function escHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])
  );
}

// Adapted from assets/app.js — strips HTML tags and decodes common entities
function cleanText(s = '') {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch { return String(iso || ''); }
}

function fmtYear(iso) {
  try { return new Date(iso).getFullYear(); }
  catch { return String(iso || ''); }
}

async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} loading ${path}`);
  return res.json();
}

// Returns true for placeholder URLs that should not be rendered as hyperlinks
function isPlaceholder(url) {
  return !url || url.startsWith('#');
}

// Extracts a YouTube video ID and returns the corresponding thumbnail URL, or null
function getYoutubeThumbnail(url) {
  const m = String(url || '').match(
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|watch\?v=))([A-Za-z0-9_-]{11})/
  );
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : null;
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function initNav() {
  const toggle = qs('.nav-toggle');
  const menu   = qs('.nav-links');

  toggle?.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    menu?.classList.toggle('is-open', !open);
  });

  // Close mobile menu when a link is clicked
  qsa('.nav-links a').forEach(a => a.addEventListener('click', () => {
    toggle?.setAttribute('aria-expanded', 'false');
    menu?.classList.remove('is-open');
  }));

  // Scroll-spy: highlight the active nav link as sections enter the viewport
  const sections   = qsa('section[id], header[id]');
  const navAnchors = qsa('.nav-links a[href^="#"]');

  if (sections.length && navAnchors.length) {
    const spy = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          const id = e.target.id;
          navAnchors.forEach(a =>
            a.classList.toggle('active', a.getAttribute('href') === `#${id}`)
          );
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });

    sections.forEach(s => spy.observe(s));
  }
}

// ─── renderSite ───────────────────────────────────────────────────────────────
// Populates hero, why-this-matters pillars, executive bio, contact, and footer
// from data/site.json
function renderSite(site) {
  if (!site) return;

  // Hero
  const eyebrow = qs('#hero-eyebrow');
  if (eyebrow && site.roles?.length) {
    eyebrow.innerHTML = site.roles.map(escHtml).join('<br>');
  }

  const heroName = qs('#hero-name');
  if (heroName) heroName.textContent = site.name || '';

  const tagline = qs('#hero-tagline');
  if (tagline) tagline.textContent = site.tagline || '';

  const heroIntro = qs('#hero-intro');
  if (heroIntro) heroIntro.textContent = site.heroIntro || '';

  const heroPhoto = qs('#hero-photo');
  if (heroPhoto && site.photo) {
    heroPhoto.innerHTML = `<img src="${escHtml(site.photo)}" alt="Portrait of ${escHtml(site.name || '')}" />`;
  }

  const actions = qs('#hero-actions');
  if (actions && site.heroButtons?.length) {
    actions.innerHTML = site.heroButtons.map(btn => {
      const cls    = btn.type === 'external' ? 'btn btn--outline' : 'btn btn--primary';
      const target = btn.type === 'external' ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${escHtml(btn.target)}" class="${cls}"${target}>${escHtml(btn.label)}</a>`;
    }).join('');
  }

  // Why this matters — pillars
  const pillars = qs('#pillars');
  if (pillars && site.whyThisMatters?.length) {
    pillars.innerHTML = site.whyThisMatters.map(p => `
      <div class="pillar-card">
        <h3 class="pillar-title">${escHtml(p.title)}</h3>
        <p class="pillar-text">${escHtml(p.text)}</p>
      </div>
    `).join('');
  }

  // Executive bio — two-column layout when site.photo is set, single-column otherwise
  const bioLayout = qs('#bio-layout');
  if (bioLayout) {
    const bioContent = `
      ${site.executiveBio ? `<p>${escHtml(site.executiveBio)}</p>` : ''}
      ${site.roles?.length
        ? `<ul class="bio-roles">${site.roles.map(r => `<li>${escHtml(r)}</li>`).join('')}</ul>`
        : ''}
    `;
    bioLayout.innerHTML = site.photo
      ? `<div class="bio-photo">
           <img src="${escHtml(site.photo)}" alt="Portrait of ${escHtml(site.name || '')}" />
         </div>
         <div class="bio-content">${bioContent}</div>`
      : `<div class="bio-content">${bioContent}</div>`;
  }

  // Contact
  const contactIntro = qs('#contact-intro');
  if (contactIntro) contactIntro.textContent = site.contactIntro || '';

  const contactActions = qs('#contact-actions');
  if (contactActions) {
    const links = [];
    if (site.linkedinUrl) {
      links.push(`<a href="${escHtml(site.linkedinUrl)}" class="btn btn--primary" target="_blank" rel="noopener">LinkedIn Profile</a>`);
    }
    if (site.email) {
      links.push(`<a href="mailto:${escHtml(site.email)}" class="btn btn--outline">Send Email</a>`);
    }
    contactActions.innerHTML = links.join('');
  }

  const companyLinks = qs('#company-links');
  if (companyLinks && site.companyLinks?.length) {
    companyLinks.innerHTML = site.companyLinks.map(l =>
      `<a href="${escHtml(l.url)}" class="company-link" target="_blank" rel="noopener">${escHtml(l.label)}</a>`
    ).join('');
  }

  // Footer
  const footerName = qs('#footer-name');
  if (footerName) footerName.textContent = site.name || '';
  const footerText = qs('#footer-text');
  if (footerText) footerText.textContent = site.footerText || '';
  const footerYear = qs('#footer-year');
  if (footerYear) footerYear.textContent = new Date().getFullYear();
}

// ─── renderAsSeenIn ───────────────────────────────────────────────────────────
// Populates the "As seen in" logo strip from data/as-seen-in.json
// Logo images fall back to outlet name text if the image file is not found
function renderAsSeenIn(items) {
  const section = qs('#as-seen-in');
  const strip   = qs('#logo-strip');
  if (!strip || !items?.length) { section?.remove(); return; }

  strip.innerHTML = items.map(o => `
    <a href="${escHtml(o.url)}" class="logo-item" target="_blank" rel="noopener" title="${escHtml(o.name)}">
      <img src="${escHtml(o.logo)}" alt="${escHtml(o.name)}"
           onerror="this.style.display='none';this.nextElementSibling.style.display='block'" />
      <span class="logo-text" style="display:none">${escHtml(o.name)}</span>
    </a>
  `).join('');
}

// ─── renderMedia ──────────────────────────────────────────────────────────────
// Renders featured media cards from data/featured-media.json
// Cards with placeholder URLs (#replace-with-final-link) render as <div>, not <a>
function renderMedia(items) {
  const section = qs('#media');
  const grid    = qs('#media-grid');
  if (!grid || !items?.length) { section?.remove(); return; }

  const visible = items.filter(i => i.featured !== false);
  if (!visible.length) { section?.remove(); return; }

  grid.innerHTML = visible.map(item => {
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

// ─── renderVideos ─────────────────────────────────────────────────────────────
// Renders video highlight cards from data/videos.json
// YouTube URLs automatically get a real thumbnail via img.youtube.com
function renderVideos(items) {
  const section = qs('#videos');
  const grid    = qs('#video-grid');
  if (!grid || !items?.length) { section?.remove(); return; }

  grid.innerHTML = items.map(item => {
    // Prefer auto-extracted YouTube thumbnail over placeholder asset paths
    const ytThumb  = getYoutubeThumbnail(item.url);
    const thumbSrc = ytThumb || item.thumbnail || null;

    const thumbImg = thumbSrc
      ? `<img src="${escHtml(thumbSrc)}" alt="" loading="lazy" class="video-thumb__img"
              onerror="this.style.display='none'" />`
      : '';

    return `
      <a href="${escHtml(item.url)}" class="video-card" target="_blank" rel="noopener">
        <div class="video-thumb">
          ${thumbImg}
          <div class="video-thumb__overlay">
            <span class="video-play-icon" aria-hidden="true">&#9654;</span>
          </div>
          <span class="platform-badge">${escHtml(item.platform)}</span>
        </div>
        <div class="video-card__content">
          <p class="video-card__source">${escHtml(item.source)} &middot; ${escHtml(item.duration)}</p>
          <h3 class="video-card__title">${escHtml(item.title)}</h3>
          <p class="video-card__summary">${escHtml(item.summary)}</p>
        </div>
      </a>
    `;
  }).join('');
}

// ─── renderPublications ───────────────────────────────────────────────────────
// Renders publications list from data/publications.json
function renderPublications(items) {
  const section = qs('#publications');
  const list    = qs('#pub-list');
  if (!list || !items?.length) { section?.remove(); return; }

  list.innerHTML = items.map(item => {
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

// ─── renderSpeaking ───────────────────────────────────────────────────────────
// Renders speaking engagement cards from data/speaking.json
function renderSpeaking(items) {
  const section = qs('#speaking');
  const list    = qs('#speaking-list');
  if (!list || !items?.length) { section?.remove(); return; }

  list.innerHTML = items.map(item => {
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

// ─── Dynamic news feed integration ─────────────────────────────────────────────
//
// This section connects the existing daily news pipeline to the executive hub.
//
// Data source : data/archive.json
//   Written automatically each day by scripts/fetch-news.js
//   via .github/workflows/fetch-news.yml (GitHub Actions)
//   Contains Google News RSS + Brave Search results for "Peter Fintl"
//
// Configuration : data/latest-news-config.json
//   Controls section title, intro text, available time ranges, and fallback URL
//
// Entry points:
//   initNewsFeed(config)  — wires up controls, sets titles from config
//   loadNewsFeed(config)  — fetches data/archive.json → NEWS_STATE → renders
//   applyNewsFilters()    — filter/sort NEWS_STATE.items → renderNewsCards()
// ──────────────────────────────────────────────────────────────────────────────

// Parse a range string ("90d", "1y", "all") into a number of days or "all"
function parseRange(r) {
  if (!r || r === 'all') return 'all';
  if (r.endsWith('y'))   return parseInt(r, 10) * 365;
  return parseInt(r, 10);
}

function initNewsFeed(config) {
  const cfg = config || {};
  const rangeLabels = {
    '7d':  'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
    '1y':  'Last year',
    'all': 'All time'
  };

  // Section title & intro from config
  const titleEl = qs('#news-title');
  if (titleEl) titleEl.textContent = cfg.sectionTitle || 'Latest Coverage';
  const introEl = qs('#news-intro');
  if (introEl) {
    if (cfg.sectionIntro) {
      introEl.textContent = cfg.sectionIntro;
    } else {
      introEl.style.display = 'none';
    }
  }

  // Default range from config.defaultRange (e.g. "90d")
  NEWS_STATE.days = parseRange(cfg.defaultRange || '90d');

  // Build time range <select> from config.availableRanges
  const timeRange = qs('#timeRange');
  if (timeRange && cfg.availableRanges?.length) {
    timeRange.innerHTML = cfg.availableRanges.map(r => {
      const val      = parseRange(r);
      const label    = rangeLabels[r] || r;
      const selected = String(val) === String(NEWS_STATE.days);
      return `<option value="${escHtml(String(val))}"${selected ? ' selected' : ''}>${escHtml(label)}</option>`;
    }).join('');
  }

  // External link to standalone news site
  const footer = qs('#news-footer');
  if (footer && cfg.externalSiteUrl) {
    footer.innerHTML = `<a href="${escHtml(cfg.externalSiteUrl)}" class="news-external-link" target="_blank" rel="noopener">View full coverage site &rarr;</a>`;
  }

  // Wire up filter controls → re-run filters on any change
  timeRange?.addEventListener('change', e => {
    NEWS_STATE.days = e.target.value === 'all' ? 'all' : Number(e.target.value);
    applyNewsFilters();
  });
  qs('#sortOrder')?.addEventListener('change', e => {
    NEWS_STATE.sortOrder = e.target.value;
    applyNewsFilters();
  });
  qs('#searchBox')?.addEventListener('input', e => {
    NEWS_STATE.query = e.target.value;
    applyNewsFilters();
  });
}

async function loadNewsFeed(config) {
  const resultsEl = qs('#news-results');
  if (!resultsEl) return;

  try {
    // Load the rolling 1-year archive written by scripts/fetch-news.js
    const data = await loadJSON('data/archive.json');
    NEWS_STATE.items = Array.isArray(data) ? data : [];
    applyNewsFilters();
  } catch (e) {
    const fallback = config?.fallbackUrl || 'https://news.google.com/search?q=Peter%20Fintl';
    resultsEl.innerHTML = `
      <p class="news-empty">
        Could not load the latest feed.
        <a href="${escHtml(fallback)}" target="_blank" rel="noopener">Search on Google News &rarr;</a>
      </p>`;
    console.warn('News feed unavailable:', e);
  }
}

// Domains filtered out on the frontend (profile/contact sites that slip past the pipeline)
const FRONTEND_BLOCKED_HOSTS = new Set(['researchgate.net']);

function isFrontendBlocked(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return [...FRONTEND_BLOCKED_HOSTS].some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

// Filter and sort logic adapted from assets/app.js applyFilters()
function applyNewsFilters() {
  const { items, days, sortOrder, query } = NEWS_STATE;
  const q   = query.trim().toLowerCase();
  const now = Date.now();

  let filtered = items.slice();

  // Remove blocked domains (e.g. ResearchGate profile pages)
  filtered = filtered.filter(i => !isFrontendBlocked(i.url));

  if (days !== 'all') {
    const cutoff = now - Number(days) * 86400000;
    filtered = filtered.filter(i => new Date(i.publishedAt).getTime() >= cutoff);
  }

  if (q) {
    filtered = filtered.filter(i =>
      i.title?.toLowerCase().includes(q)   ||
      i.source?.toLowerCase().includes(q)  ||
      i.snippet?.toLowerCase().includes(q)
    );
  }

  filtered.sort((a, b) => {
    const diff = new Date(a.publishedAt) - new Date(b.publishedAt);
    return sortOrder === 'asc' ? diff : -diff;
  });

  // Deduplicate by normalised title — catches duplicate archive entries
  // that accumulated across multiple fetch runs with slightly different URLs
  const seenTitles = new Set();
  filtered = filtered.filter(item => {
    const key = cleanText(item.title).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (!key || seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  renderNewsCards(filtered);
}

// Card render adapted from assets/app.js render() — reuses cleanText() and escHtml()
function renderNewsCards(items) {
  const el = qs('#news-results');
  if (!el) return;

  if (!items.length) {
    el.innerHTML = `<p class="news-empty">No articles found for the selected period. Try widening the time window or clearing the search.</p>`;
    return;
  }

  el.innerHTML = items.map((item, index) => {
    const source = item.source || 'News';
    let snip = cleanText(item.snippet || '');
    if (snip.length > 200) snip = snip.slice(0, 197) + '…';

    // Gradient fallback keyed to source name (adapted from assets/app.js)
    const hue      = (source.charCodeAt(0) * 17 + index * 31) % 360;
    const gradient = `linear-gradient(135deg,hsl(${hue},30%,22%),hsl(${(hue + 45) % 360},45%,12%))`;
    const initial  = source.charAt(0).toUpperCase();

    const thumbHtml = item.imageUrl
      ? `<img class="news-card__thumb" src="${escHtml(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"
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
      </a>
    `;
  }).join('');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  initNav();

  // Load all curated data files in parallel
  const [site, asSeenIn, media, videos, publications, speaking, newsConfig] =
    await Promise.allSettled([
      loadJSON('data/site.json'),
      loadJSON('data/as-seen-in.json'),
      loadJSON('data/featured-media.json'),
      loadJSON('data/videos.json'),
      loadJSON('data/publications.json'),
      loadJSON('data/speaking.json'),
      loadJSON('data/latest-news-config.json')
    ]);

  // Render each section; each renderer removes its section from the DOM if data is absent
  if (site.status         === 'fulfilled') renderSite(site.value);
  if (asSeenIn.status     === 'fulfilled') renderAsSeenIn(asSeenIn.value);
  if (media.status        === 'fulfilled') renderMedia(media.value);
  if (videos.status       === 'fulfilled') renderVideos(videos.value);
  if (publications.status === 'fulfilled') renderPublications(publications.value);
  if (speaking.status     === 'fulfilled') renderSpeaking(speaking.value);

  // Initialize and load the dynamic news feed (data/archive.json)
  const cfg = newsConfig.status === 'fulfilled' ? newsConfig.value : null;
  initNewsFeed(cfg);
  await loadNewsFeed(cfg);
}

document.addEventListener('DOMContentLoaded', init);
