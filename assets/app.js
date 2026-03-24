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
    results.innerHTML = `<p style="opacity:.8; grid-column: 1/-1; text-align: center;">Could not load news. Please try again later.</p>`;
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
      (i.title && i.title.toLowerCase().includes(q)) ||
      (i.source && i.source.toLowerCase().includes(q)) ||
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

function render() {
  if (!STATE.filtered.length) {
    results.innerHTML = `<p style="opacity:.8; grid-column: 1/-1; text-align: center;">No results match your filters yet.</p>`;
    return;
  }
  results.innerHTML = STATE.filtered.map((item, index) => {
    const date = new Date(item.publishedAt);
    const dt = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const source = item.source ? escapeHtml(item.source) : 'News Outlet';
    const url = item.url;
    
    let snip = escapeHtml(item.snippet || '');
    if (snip.length > 250) snip = snip.substring(0, 247) + '...';

    // Generate a consistent pseudo-random gradient for missing images
    const hue = (source.charCodeAt(0) * 15 + index * 30) % 360;
    const gradient = `background: linear-gradient(135deg, hsl(${hue}, 40%, 30%), hsl(${(hue + 40) % 360}, 60%, 15%));`;
    
    // Initial letter for pattern
    const initial = source.charAt(0).toUpperCase();

    const imgTag = item.imageUrl 
        ? `<img class="thumb" src="${escapeAttr(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : `<div class="thumb-fallback" style="${gradient}"><span>${initial}</span></div>`;

    return `
      <a href="${url}" target="_blank" rel="noopener" class="card">
        <div class="thumb-wrap">
          ${imgTag}
        </div>
        <div class="card-content">
          <div class="source-badge">
            ${item.faviconUrl ? `<img class="favicon" src="${escapeAttr(item.faviconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
            ${source} • ${dt}
          </div>
          <h3>${escapeHtml(item.title)}</h3>
          ${snip ? `<p class="snippet">${snip}</p>` : ''}
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
if (sortOrder) sortOrder.addEventListener('change', (e) => { STATE.sortOrder = e.target.value; applyFilters(); });
if (searchBox) searchBox.addEventListener('input', (e) => { STATE.query = e.target.value; applyFilters(); });

if (results) loadData();
