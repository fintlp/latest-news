
/* Renders archive (1-year rolling) and supports filtering + sorting */
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
    results.innerHTML = `<p style="opacity:.8">Could not load news. Please try again later.</p>`;
    console.error(e);
  }
}

function applyFilters() {
  const q = STATE.query.trim().toLowerCase();
  const now = new Date();
  let items = STATE.items.slice();

  // timeframe filter
  if (STATE.days !== 'all') {
    const maxAgeMs = Number(STATE.days) * 24 * 60 * 60 * 1000;
    items = items.filter(i => (now - new Date(i.publishedAt)) <= maxAgeMs);
  }

  // text filter
  if (q) {
    items = items.filter(i =>
      (i.title && i.title.toLowerCase().includes(q)) ||
      (i.source && i.source.toLowerCase().includes(q)) ||
      (i.snippet && i.snippet.toLowerCase().includes(q))
    );
  }

  // sort by date
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
    results.innerHTML = `<p style="opacity:.8">No results match your filters yet.</p>`;
    return;
  }
  results.innerHTML = STATE.filtered.map(item => {
    const date = new Date(item.publishedAt);
    const dt = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const source = item.source ? `• ${escapeHtml(item.source)}` : '';
    const url = item.url;
    return `
      <article class="card">
        <h3><a href="${url}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>
        <div class="meta"><span>${dt}</span><span>${source}</span></div>
        ${item.snippet ? `<p class="snippet">${escapeHtml(item.snippet)}</p>` : ''}
        <div><a href="${url}" target="_blank" rel="noopener">Read article →</a></div>
      </article>
    `;
  }).join('');
}

function escapeHtml(s='') {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','"':'&quot;',''':'&#039;'}[c]));
}

// Wire up controls
timeRange.addEventListener('change', e => { STATE.days = e.target.value; applyFilters(); });
sortOrder.addEventListener('change', e => { STATE.sortOrder = e.target.value; applyFilters(); });
searchBox.addEventListener('input', e => { STATE.query = e.target.value; applyFilters(); });

loadData();
