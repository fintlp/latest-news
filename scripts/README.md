
# scripts/fetch-news.js

Node.js script that fetches news mentioning Peter Fintl, normalises the results, and writes `data/news.json` and `data/archive.json`. Run daily by GitHub Actions.

## Data sources

### 1. Google News RSS (primary)
Queries `"Peter Fintl"` across 13 locale/region combinations:

| Locale | Region |
|---|---|
| en-US | US |
| en-GB | GB |
| en-AU | AU |
| de | AT, DE, CH |
| zh-TW | TW |
| zh-CN | CN |
| ja | JP |
| ko | KR |
| fr-FR | FR |
| it-IT | IT |
| nl-NL | NL |

Google News returns redirect URLs (`news.google.com/rss/articles/…`) — page meta scraping is skipped for these to avoid bot blocks.

### 2. Brave Search News API (optional)
Topic-specific queries defined in `BRAVE_TOPIC_QUERIES`. Requires `BRAVE_API_KEY` environment variable (or local `secrets/brave_search.json`). Results are filtered to include "fintl" unless the query is in the `TOPIC_ONLY` list.

## Image pipeline

For each item, `normalizeItem()` resolves an `imageUrl` using this priority chain:

1. `og:image` / `og:image:secure_url` / `twitter:image` scraped from the article page (Brave results only)
2. RSS `<media:content>`, `<media:thumbnail>`, `<enclosure>` tags
3. Outlet logo: domain or normalised source name matched against `data/as-seen-in.json` (supports `aliases` array) → `google.com/s2/favicons?domain={host}&sz=256`
4. `EXTRA_SOURCE_DOMAINS` map: hardcoded source-name → domain for frequent outlets not in `as-seen-in.json`
5. Domain extracted from source name via `extractSourceDomain()` — handles plain TLDs and second-level ccTLDs (`.co.kr`, `.org.tw`)
6. Final fallback: `google.com/s2/favicons?domain={url.hostname}&sz=256`

Every item will have a non-null `imageUrl`. Cards with a favicon URL get `object-fit: contain` styling in the frontend.

## Output files

| File | Description |
|---|---|
| `data/news.json` | Results from the latest single run |
| `data/archive.json` | Rolling 1-year merged archive (latest run + previous archive + manual overrides) |

## Configuration

| Constant | Default | Description |
|---|---|---|
| `RETAIN_DAYS` | 365 | How many days to keep items in the archive |
| `RSS_LOCALES` | 13 entries | Google News locale/region pairs |
| `BRAVE_TOPIC_QUERIES` | 4 queries | Topic searches run via Brave API |
| `BLOCKED_DOMAINS` | see code | Domains always excluded from results |
| `EXTRA_SOURCE_DOMAINS` | see code | Source-name → domain overrides for favicon lookup |

## Running locally

```bash
npm install
node scripts/fetch-news.js
```

Brave API key is optional — Google News RSS runs without it.
