
# Peter Fintl — Executive Media Hub

A polished executive media hub hosted on **GitHub Pages**, showing selected media commentary, video highlights, publications, speaking engagements, and a dynamically-updated news feed — all driven by static JSON files and a daily GitHub Actions pipeline.

---

## Site structure

```
/
├── index.html          ← main page (11 sections)
├── styles.css          ← design system (executive palette, responsive)
├── app.js              ← renders curated sections + news feed
│
├── data/
│   ├── site.json               ← hero, bio, contact, nav content
│   ├── featured-media.json     ← media & commentary cards
│   ├── videos.json             ← video highlight cards
│   ├── publications.json       ← articles & publications list
│   ├── speaking.json           ← speaking engagements
│   ├── latest-news-config.json ← news section title, ranges, fallback URL
│   ├── as-seen-in.json         ← "as seen in" logo strip
│   │
│   ├── archive.json            ← auto-updated by GitHub Actions (do not edit)
│   ├── news.json               ← latest single-run results (do not edit)
│   └── manual-overrides.json   ← pinned articles that survive refreshes
│
├── assets/
│   ├── logos/          ← outlet logo PNGs (e.g. dw.png, handelsblatt.png)
│   │                     Drop files here; no code changes needed.
│   ├── og-image.jpg    ← Open Graph / social share image
│   ├── app.js          ← legacy news-only frontend (not used by main page)
│   └── styles.css      ← legacy styles (not used by main page)
│
└── scripts/
    └── fetch-news.js   ← Node script that populates data/archive.json
```

---

## How the news feed works

1. **GitHub Actions** runs `scripts/fetch-news.js` daily at 09:11 Vienna time.
2. The script queries **Google News RSS** (13 locales) for `"Peter Fintl"` and optionally **Brave Search** for topic queries.
3. Results are normalised, deduped, and merged into `data/archive.json` (rolling 1-year window).
4. On page load, `app.js` fetches `data/archive.json` and renders the **Latest Coverage** section with filter controls.

The pipeline is configured in `.github/workflows/fetch-news.yml` and requires no changes.

### Data sources

| Source | What it covers |
|---|---|
| Google News RSS — 13 locales | en-US, en-GB, en-AU, de-AT, de-DE, de-CH, zh-TW, zh-CN, ja, ko, fr-FR, it-IT, nl-NL |
| Brave Search News API | Optional topic queries (configured in `BRAVE_TOPIC_QUERIES`); requires `BRAVE_API_KEY` secret |

### Image pipeline

Each news card tries the following in order until an image is found:

| Priority | Source | Notes |
|---|---|---|
| 1 | `og:image` / `og:image:secure_url` / `twitter:image` scraped from article page | Skipped for Google News redirect URLs |
| 2 | RSS `<media:content>`, `<media:thumbnail>`, `<enclosure>` tags | Rarely populated by Google News |
| 3 | Outlet logo lookup | Domain or source-name matched against `data/as-seen-in.json` (supports `aliases` array) |
| 4 | `EXTRA_SOURCE_DOMAINS` map | Hardcoded in `fetch-news.js` for frequent outlets not in `as-seen-in.json` (e.g. Table.Briefings → `table.media`) |
| 5 | Domain extracted from source name | Handles plain domains (`schwarzwaelder-bote.de`) and second-level ccTLDs (`autoelectronics.co.kr`) |
| 6 | `google.com/s2/favicons?domain={host}&sz=256` | Final fallback; always resolves |

All outlet logos use `google.com/s2/favicons` (Clearbit was shut down). Cards whose `imageUrl` is a favicon URL get `object-fit: contain` with padding in CSS so small icons aren't stretched.

---

## Deploying to GitHub Pages

1. Push `main` branch to GitHub.
2. Go to **Settings → Pages → Deploy from branch → `main` → `/` (root)**.
3. The site is live at `https://fintlp.github.io/latest-news/`.

The GitHub Actions workflow commits data changes automatically with `[skip ci]`.

---

## Customising content

All curated content lives in JSON files in `/data/`. Edit them directly — no build step required.

| File | What to edit |
|---|---|
| `data/site.json` | Name, tagline, roles, hero intro, buttons, bio, contact info, footer |
| `data/featured-media.json` | Media & interview cards (replace `#replace-with-final-link` URLs) |
| `data/videos.json` | Video cards (YouTube thumbnails are auto-extracted) |
| `data/publications.json` | Articles and publications |
| `data/speaking.json` | Speaking engagements |
| `data/as-seen-in.json` | Outlet logos in the "as seen in" strip |
| `data/latest-news-config.json` | News section title, intro, time ranges |
| `data/manual-overrides.json` | Articles pinned permanently in the news feed |

### Adding outlet logos

Outlet logos are resolved automatically via Google's favicon service using the domain in `data/as-seen-in.json`. To add a new outlet, add an entry with its URL and optionally an `aliases` array for the source-name variants that Google News RSS uses:

```json
{
  "name": "Outlet Name",
  "aliases": ["shortname", "shortname.com"],
  "logo": "assets/logos/unused.png",
  "url": "https://www.outlet.com/"
}
```

For outlets that appear frequently but are not in `as-seen-in.json`, add them to `EXTRA_SOURCE_DOMAINS` in `scripts/fetch-news.js`:

```js
const EXTRA_SOURCE_DOMAINS = {
  'tablebriefings': 'table.media',
  'zonebourse':     'zonebourse.com',
  // add more here: normalizeSourceKey(sourceName) → domain
};
```

The `logo` field in `as-seen-in.json` is currently unused — logos are served from Google's favicon CDN, not local files.

### Adding an OG image

Place a 1200×630px image at `assets/og-image.jpg` for social sharing previews.

### Updating placeholder links

Media, publication, and speaking entries with `"url": "#replace-with-final-link"` render as non-clickable cards. Replace the URL with the real link when available.

---

## Sections

| # | Section | ID | Data source |
|---|---|---|---|
| 1 | Sticky navigation | `#home` | — |
| 2 | Hero | `#hero` | `data/site.json` |
| — | As seen in | `#as-seen-in` | `data/as-seen-in.json` |
| 3 | Why this matters | `#why` | `data/site.json` → `whyThisMatters` |
| 4 | Selected media | `#media` | `data/featured-media.json` |
| 5 | Video highlights | `#videos` | `data/videos.json` |
| 6 | Publications | `#publications` | `data/publications.json` |
| 7 | Speaking | `#speaking` | `data/speaking.json` |
| 8 | Latest coverage | `#latest-coverage` | `data/archive.json` (auto) |
| 9 | Executive profile | `#executive-profile` | `data/site.json` → `executiveBio` |
| 10 | Connect | `#contact` | `data/site.json` → contact fields |
| 11 | Footer | — | `data/site.json` → `footerText` |

Sections with empty or failed data are automatically hidden.

---

## News feed configuration

Edit `data/latest-news-config.json`:

```json
{
  "sectionTitle": "Latest Coverage",
  "sectionIntro": "Recent media references...",
  "defaultRange": "90d",
  "availableRanges": ["7d", "30d", "90d", "1y", "all"],
  "fallbackUrl": "https://news.google.com/search?q=Peter%20Fintl",
  "externalSiteUrl": "https://fintlp.github.io/latest-news/"
}
```

Supported range values: `7d`, `30d`, `90d`, `1y`, `all`

---

## Local preview

```bash
npx serve .
# or use VS Code Live Server
```

Open `http://localhost:3000` — all sections should load including the news feed from `data/archive.json`.

---

## License

MIT
