const STATE = {
  items: [],
  filtered: [],
  sortOrder: 'desc',
  days: '365',
  query: ''
};

const el = (sel) => document.querySelector(sel);
const results = el('#results');
const timeRange = el('#timeRange');
const sortOrder = el('#sortOrder');
const searchBox = el('#searchBox');

async function loadData() {
  try {
    const res = await fetch('data/archive.json', { cache: 'no-store' });
    const data = await res.json();
    STATE.items = Array.isArray(data) ? data : [];
    applyFilters();
  } catch (e) {
    results.innerHTML = `<p class="empty-state">Could not load news data. Please try again later.</p>`;
    console.error(e);
  }
}

function applyFilters() {
  const q = STATE.query.trim().toLowerCase();
  const now = new Date();
  let items = STATE.items.slice();

  if (STATE.days !== 'all') {
    const maxAgeMs = Number(STATE.days) * 24 * 60 * 60 * 1000;
    items = items.filter(i => (now - new Date(i.publishedAt)) <= maxAgeMs);
  }

  if (q) {
    items = items.filter(i =>
      (i.title   && i.title.toLowerCase().includes(q)) ||
      (i.source  && i.source.toLowerCase().includes(q)) ||
      (i.snippet && i.snippet.toLowerCase().includes(q))
    );
  }

  items.sort((a, b) => {
    const ad = new Date(a.publishedAt).getTime();
    const bd = new Date(b.publishedAt).getTime();
    return STATE.sortOrder === 'asc' ? ad - bd : bd - ad;
  });

  STATE.filtered = items;
  render();
}

// Decode HTML entities and strip any residual HTML tags from snippets
function cleanText(s = '') {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function render() {
  if (!STATE.filtered.length) {
    const windowLabel = STATE.days === 'all' ? 'all time' : `the last ${STATE.days} day${STATE.days === '1' ? '' : 's'}`;
    results.innerHTML = `<p class="empty-state">No articles found for ${windowLabel}${STATE.query ? ` matching "<strong>${escapeHtml(STATE.query)}</strong>"` : ''}.<br><small>Try widening the time window or clearing the search.</small></p>`;
    return;
  }

  results.innerHTML = STATE.filtered.map((item, index) => {
    const date = new Date(item.publishedAt);
    const dt = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const source = item.source ? escapeHtml(item.source) : 'News Outlet';
    const url = item.url;

    // Clean and truncate snippet
    let snip = cleanText(item.snippet || '');
    if (snip.length > 220) snip = snip.substring(0, 217) + '…';

    // Consistent gradient fallback keyed to source
    const hue = (source.charCodeAt(0) * 15 + index * 30) % 360;
    const gradient = `background: linear-gradient(135deg, hsl(${hue}, 40%, 30%), hsl(${(hue + 40) % 360}, 60%, 15%));`;
    const initial = source.charAt(0).toUpperCase();

    const imgTag = item.imageUrl
      ? `<img class="thumb" src="${escapeAttr(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.parentNode.querySelector('.thumb-fallback').style.display='flex'" /><div class="thumb-fallback" style="${gradient};display:none"><span>${initial}</span></div>`
      : `<div class="thumb-fallback" style="${gradient}"><span>${initial}</span></div>`;

    const manualBadge = item.manually_added
      ? `<span class="manual-badge" title="Manually added">📌 Added</span>`
      : '';

    return `
      <a href="${url}" target="_blank" rel="noopener" class="card">
        <div class="thumb-wrap">
          ${imgTag}
        </div>
        <div class="card-content">
          <div class="source-badge">
            ${item.faviconUrl ? `<img class="favicon" src="${escapeAttr(item.faviconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
            <span>${source}</span>
            <span class="sep">•</span>
            <span>${dt}</span>
            ${manualBadge}
          </div>
          <h3>${escapeHtml(cleanText(item.title))}</h3>
          ${snip ? `<p class="snippet">${escapeHtml(snip)}</p>` : ''}
          <div class="read-more">Read article &rarr;</div>
        </div>
      </a>
    `;
  }).join('');
}

function escapeAttr(s = '') { return escapeHtml(s); }
function escapeHtml(s = '') {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c] || c);
}

if (timeRange) timeRange.addEventListener('change', (e) => { STATE.days = e.target.value; applyFilters(); });
if (sortOrder)  sortOrder.addEventListener('change',  (e) => { STATE.sortOrder = e.target.value; applyFilters(); });
if (searchBox)  searchBox.addEventListener('input',    (e) => { STATE.query = e.target.value; applyFilters(); });

if (results) loadData();
